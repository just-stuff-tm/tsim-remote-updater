// T-SIM remote updater — Cloudflare Worker
// Multi-repeater mesh dashboard: per-device or fleet (account) password login, telemetry,
// MeshCore mesh snapshot, optional repeater console, manual SMS actions via Hologram.
// The only automatic sends are OPTIONAL per-device scheduled checks (off by default) run by the cron.
//
// Bindings: KV STATE; secrets HOLOGRAM_API_KEY, ADMIN_TOKEN, SESSION_SECRET; optional GITHUB_TOKEN.

const DEFAULT_SOURCE = { enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", direct_url: "" };
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export function globToRegex(g) {
  return new RegExp("^" + String(g).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
}
export function validateSource(b) {
  const o = { ...DEFAULT_SOURCE };
  if (b.enabled !== undefined) o.enabled = b.enabled === true || b.enabled === "true" || b.enabled === "on";
  if (b.repo !== undefined) { o.repo = String(b.repo).trim(); if (!REPO_RE.test(o.repo)) throw new Error("repo must look like owner/name"); }
  if (b.asset_pattern !== undefined) {
    o.asset_pattern = String(b.asset_pattern).trim();
    if (!o.asset_pattern || o.asset_pattern.length > 120 || /[\s/]/.test(o.asset_pattern)) throw new Error("asset pattern: 1-120 chars, no spaces or slashes");
  }
  if (b.direct_url !== undefined) {
    o.direct_url = String(b.direct_url).trim();
    if (o.direct_url && (!/^https:\/\/\S+$/.test(o.direct_url) || o.direct_url.length > 300)) throw new Error("direct URL must start with https:// (max 300 chars)");
  }
  return o;
}
const getSource = async (env, id) => ({ ...DEFAULT_SOURCE, ...((await kvJson(env, `source:${id}`)) || {}) });
const UA = "tsim-remote-updater (+cloudflare-workers)";
const HOLOGRAM_SMS_URL = "https://dashboard.hologram.io/api/1/sms/incoming";
const PBKDF2_ITER = 100000; // Workers WebCrypto maximum
const SESSION_TTL = 7 * 24 * 3600;
const SEND_GAP_MS = 60_000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW = 15 * 60;
const HISTORY_MAX = 50;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COOKIE = "tsim_session";
const SCHEDULE_CHOICES = [0, 6, 12, 24, 168];
const CMD_MAX_PENDING = 10, CMD_HISTORY = 30, CMD_MAX_LEN = 120, CMD_OUT_MAX = 2000;
// Console commands that can wipe or detach a repeater: need an explicit confirm (force).
export const RISKY_CMD_RE = /^(erase|start ota|password|set (freq|radio|bw|sf|cr|tx|af)|set prv\.key|neighbor\.remove|clear)/i;
const PS_NOTE = "Console unavailable while the repeater is in power saving (its serial CLI is not answering)";
const DEFAULT_SETTINGS = { console_enabled: false, schedule_hours: 0 };
const getSettings = async (env, id) => ({ ...DEFAULT_SETTINGS, ...((await kvJson(env, `settings:${id}`)) || {}) });

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
export function randomPassword() {
  const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(20));
  return [...r].map((x) => a[x % a.length]).join("").replace(/(.{5})(?!$)/g, "$1-");
}
function safeEq(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

// ---------- passwords ----------
export async function hashPassword(pw, saltHex = randomHex(16), iter = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return `pbkdf2-sha256$${iter}$${saltHex}$${hex(bits)}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, iter, salt, h] = String(stored).split("$");
  if (alg !== "pbkdf2-sha256") return false;
  const again = await hashPassword(pw, salt, parseInt(iter, 10));
  return safeEq(again.split("$")[3], h);
}

// ---------- sessions ----------
async function hmac(env, data) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET not set");
  const k = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
async function makeSession(env, id, pwVersion, kind = "d") {
  const payload = b64u(enc.encode(JSON.stringify({ k: kind, d: id, v: pwVersion, exp: Math.floor(Date.now() / 1000) + SESSION_TTL })));
  return `${payload}.${await hmac(env, payload)}`;
}
async function readSession(request, env) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig || !safeEq(sig, await hmac(env, payload))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64u(payload)));
    if (!s.exp || s.exp < Date.now() / 1000) return null;
    return s;
  } catch { return null; }
}
const cookieHeader = (v, maxAge) => `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// ---------- KV helpers ----------
const kvJson = async (env, k) => { const v = await env.STATE.get(k); return v ? JSON.parse(v) : null; };
const putJson = (env, k, v, opts) => env.STATE.put(k, JSON.stringify(v), opts);
const getDevice = (env, id) => (ID_RE.test(id || "") ? kvJson(env, `device:${id}`) : null);
const getAccount = (env, id) => (ID_RE.test(id || "") ? kvJson(env, `account:${id}`) : null);
async function listDeviceIds(env) {
  const out = []; let cursor;
  do { const l = await env.STATE.list({ prefix: "device:", cursor }); out.push(...l.keys.map((k) => k.name.slice(7))); cursor = l.list_complete === false ? l.cursor : null; } while (cursor);
  return out;
}

// ---------- responses ----------
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const SEC_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { ...SEC_HEADERS, ...headers } });
const redirect = (loc, headers = {}) => new Response(null, { status: 303, headers: { Location: loc, ...headers } });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- GitHub / Hologram ----------
// Fallback when the GitHub API rate-limits shared Worker IPs (403/429): read the public release page.
async function latestReleaseHtml(REPO, ASSET_RE) {
  const r = await fetch(`https://github.com/${REPO}/releases/latest`, { headers: { "User-Agent": UA }, redirect: "manual" });
  const loc = r.headers.get("Location") || "";
  const tag = decodeURIComponent((loc.match(/\/releases\/tag\/([^/?#]+)/) || [])[1] || "");
  if (!tag) throw new Error(`GitHub releases/latest ${r.status}`);
  const a = await fetch(`https://github.com/${REPO}/releases/expanded_assets/${encodeURIComponent(tag)}`, { headers: { "User-Agent": UA } });
  if (!a.ok) throw new Error(`GitHub assets ${a.status}`);
  const page = await a.text();
  const names = [...page.matchAll(/\/releases\/download\/[^"]+?\/([^"/]+)"/g)].map((m) => decodeURIComponent(m[1]));
  const name = names.find((n) => ASSET_RE.test(n));
  if (!name) return { skipped: `no upgrade asset in ${tag}` };
  return { tag, asset_id: `${tag}/${name}`, asset_name: name, url: `https://github.com/${REPO}/releases/download/${tag}/${name}`, published_at: null, via: "html" };
}

export async function latestRelease(env = {}, src = DEFAULT_SOURCE) {
  const REPO = src.repo, ASSET_RE = globToRegex(src.asset_pattern);
  const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  if (r.status === 403 || r.status === 429) return latestReleaseHtml(REPO, ASSET_RE);
  if (r.status === 404) throw new Error(`GitHub repo ${REPO} not found or has no releases`);
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  const rel = await r.json();
  if (rel.draft || rel.prerelease) return { skipped: `draft/prerelease ${rel.tag_name}` };
  const asset = (rel.assets || []).find((a) => ASSET_RE.test(a.name));
  if (!asset) return { skipped: `no upgrade asset in ${rel.tag_name}` };
  return { tag: rel.tag_name, asset_id: asset.id, asset_name: asset.name, url: asset.browser_download_url, published_at: rel.published_at };
}
export const buildUpdateBody = (url) => `UPDATE ${url.replace(/_/g, "%5F")} `;

async function sendHologramSms(env, hologramDeviceId, body) {
  const deviceid = parseInt(hologramDeviceId, 10);
  if (!Number.isFinite(deviceid)) throw new Error("device has no numeric hologram_device_id");
  if (!env.HOLOGRAM_API_KEY) throw new Error("HOLOGRAM_API_KEY not set");
  const r = await fetch(HOLOGRAM_SMS_URL, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`apikey:${env.HOLOGRAM_API_KEY.trim()}`), "Content-Type": "application/json" },
    body: JSON.stringify({ deviceid, body }),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (!r.ok || !j || j.success !== true) throw new Error(`Hologram ${r.status}: ${text.slice(0, 200)}`);
  return j;
}

async function logActivity(env, id, entry) {
  const hist = (await kvJson(env, `telem:${id}:history`)) || [];
  hist.unshift({ received_at: new Date().toISOString(), ...entry });
  await putJson(env, `telem:${id}:history`, hist.slice(0, HISTORY_MAX));
}

async function manualSend(env, dev, body, label, onSuccess) {
  const stKey = `state:${dev.id}`;
  const st = (await kvJson(env, stKey)) || {};
  const now = Date.now();
  if (st.last_send_ts && now - st.last_send_ts < SEND_GAP_MS) {
    const wait = Math.ceil((SEND_GAP_MS - (now - st.last_send_ts)) / 1000);
    return [{ sent: false, body, hologram_response_summary: null, error: `rate limited, try again in ${wait}s` }, 429];
  }
  if (body.length > 160) return [{ sent: false, body, hologram_response_summary: null, error: `text is ${body.length} chars (max 160)` }, 400];
  st.last_send_ts = now;
  await putJson(env, stKey, st);
  try {
    const res = await sendHologramSms(env, dev.hologram_device_id, body);
    if (onSuccess) await onSuccess(st);
    st.last_action = { at: new Date().toISOString(), label, sent: true };
    await putJson(env, stKey, st);
    await logActivity(env, dev.id, { type: "action", msg: `${label} text sent` });
    return [{ sent: true, body, hologram_response_summary: { success: true } }, 200];
  } catch (e) {
    st.last_action = { at: new Date().toISOString(), label, sent: false, error: e.message };
    await putJson(env, stKey, st);
    await logActivity(env, dev.id, { type: "action", msg: `${label} text FAILED: ${e.message}` });
    return [{ sent: false, body, hologram_response_summary: { success: false, error: e.message } }, 502];
  }
}

// Resolve what "latest" means for this device's update source.
export async function resolveTarget(env, id) {
  const src = await getSource(env, id);
  if (src.enabled) return { src, rel: await latestRelease(env, src) };
  if (src.direct_url) {
    const name = decodeURIComponent(src.direct_url.split(/[?#]/)[0].split("/").pop() || "firmware.bin");
    return { src, rel: { tag: "direct", asset_id: src.direct_url, asset_name: name, url: src.direct_url, published_at: null, via: "direct" } };
  }
  return { src, rel: { skipped: "update source disabled and no direct URL set" } };
}

// ---------- ingest ----------
const NUM = ["uptime", "wake", "battery_v", "battery_pct", "solar_v", "csq", "rsrp", "rsrq", "reg", "heap", "fs_free"];
const STR = ["fw", "operator", "ip", "modem_fw", "last_update", "msg", "ts"];
const MESH_RAW = ["heltec_cli", "ver", "name", "clock", "stats_core", "stats_radio", "stats_packets", "neighbors", "error"];
export function sanitizeTelemetry(t) {
  const o = { type: ["status", "update", "reboot", "event", "mesh", "cmd"].includes(t.type) ? t.type : "event" };
  for (const k of NUM) if (typeof t[k] === "number" && Number.isFinite(t[k])) o[k] = t[k];
  for (const k of STR) if (t[k] != null) o[k] = String(t[k]).slice(0, 300);
  return o;
}
// MeshCore serial CLI replies look like "  -> <reply>" (multi-line for neighbors); "get x" replies "> value".
export function cleanCli(s) {
  return String(s ?? "").replace(/\r/g, "").replace(/^\s*->\s?/, "").replace(/^>\s?/, "").trim();
}
function jsonOrNull(s) {
  const m = String(s || "").match(/\{[^{}]*\}/);
  if (!m) return null;
  try { const o = JSON.parse(m[0]); for (const k of Object.keys(o)) if (typeof o[k] !== "number") delete o[k]; return o; } catch { return null; }
}
// neighbors: "<8 hex id>:<secs ago>:<snr*4>" per line, or "-none-"
export function parseNeighbors(s, receivedAt = Date.now()) {
  const out = [];
  for (const line of cleanCli(s).split("\n")) {
    const m = line.trim().replace(/^->\s?/, "").match(/^([0-9A-Fa-f]{2,16}):(\d+):(-?\d+)$/);
    if (m) out.push({ id: m[1].toUpperCase(), secs_ago: +m[2], snr: +m[3] / 4, heard_at: new Date(receivedAt - +m[2] * 1000).toISOString() });
  }
  return out;
}
export function parseMesh(t, receivedAt = Date.now()) {
  const raw = {};
  for (const k of MESH_RAW) if (t[k] != null) raw[k] = String(t[k]).slice(0, 700);
  const ver = cleanCli(raw.ver);
  return {
    raw,
    heltec_fw: ver || null,
    node_name: cleanCli(raw.name) || null,
    clock: cleanCli(raw.clock) || null,
    core: jsonOrNull(raw.stats_core),
    radio: jsonOrNull(raw.stats_radio),
    packets: jsonOrNull(raw.stats_packets),
    neighbors: raw.neighbors == null ? null : parseNeighbors(raw.neighbors, receivedAt),
    error: raw.error || null,
  };
}
async function handleIngest(request, env, id) {
  const dev = await getDevice(env, id);
  const key = request.headers.get("X-Device-Key") || "";
  if (!dev || !dev.ingest_key || !safeEq(key, dev.ingest_key)) return json({ error: "unauthorized" }, 401);
  const raw = await request.text();
  if (raw.length > 8192) return json({ error: "too large" }, 413);
  let t;
  try { t = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const entry = { ...sanitizeTelemetry(t), received_at: new Date().toISOString() };
  if (t.test === true) entry.test = true;
  if (entry.type === "mesh") {
    const mesh = { ...parseMesh(t), received_at: entry.received_at, ...(entry.test ? { test: true } : {}) };
    // Generic (any MeshCore-style firmware): a poll where the CLI gave no reply at all = power saving / asleep.
    const noReply = t.heltec_cli === "asleep" || (!t.ver && /no reply/i.test(String(t.error || "")));
    if (noReply) {  // keep the last good snapshot, just record that the CLI is asleep
      await setPowersaving(env, id, true, "mesh poll: no CLI reply");
      const prevMesh = (await kvJson(env, `mesh:${id}`)) || {};
      await putJson(env, `mesh:${id}`, { ...prevMesh, cli_asleep_at: entry.received_at });
      await logActivity(env, id, { type: "mesh", msg: "Mesh poll: no reply from repeater CLI (power saving?)" });
      return json({ ok: true });
    }
    if (mesh.heltec_fw) await setPowersaving(env, id, false, "mesh poll: CLI answered");  // any successful reply re-enables
    await putJson(env, `mesh:${id}`, mesh);
    const prev = (await kvJson(env, `telem:${id}:latest`)) || {};
    await putJson(env, `telem:${id}:latest`, { ...prev, received_at: entry.received_at });
    const n = mesh.neighbors ? mesh.neighbors.length : "?";
    await logActivity(env, id, { type: "mesh", msg: `Mesh snapshot: ${n} neighbors${mesh.error ? " (" + mesh.error.slice(0, 80) + ")" : ""}`, ...(entry.test ? { test: true } : {}) });
    return json({ ok: true });
  }
  if (entry.type === "cmd") {
    const cmdId = String(t.cmd_id || "").slice(0, 16);
    const out = String(t.output ?? "").slice(0, CMD_OUT_MAX);
    const list = (await kvJson(env, `cmds:${id}`)) || [];
    const c = list.find((x) => x.id === cmdId);
    if (c) { c.status = t.error ? "error" : "done"; c.output = out; c.done_at = entry.received_at; if (t.error) c.error = String(t.error).slice(0, 120); }
    else list.unshift({ id: cmdId || randomHex(4), cmd: String(t.cmd || "?").slice(0, CMD_MAX_LEN), status: "done", output: out, done_at: entry.received_at, unsolicited: true });
    await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
    const ran = (c ? c.cmd : String(t.cmd || "")).trim().toLowerCase();
    const reply = cleanCli(out);
    if (t.heltec_cli === "asleep" || /no reply/i.test(String(t.error || ""))) await setPowersaving(env, id, true, "console: no CLI reply");
    else if (!t.error && ran === "powersaving on" && /^on\b/i.test(reply)) await setPowersaving(env, id, true, "console: powersaving on");
    else if (!t.error && reply) await setPowersaving(env, id, false, ran === "powersaving off" ? "console: powersaving off" : "console: CLI answered");
    const prev = (await kvJson(env, `telem:${id}:latest`)) || {};
    await putJson(env, `telem:${id}:latest`, { ...prev, received_at: entry.received_at });
    await logActivity(env, id, { type: "cmd", msg: `Console: ${(c ? c.cmd : String(t.cmd || "?")).slice(0, 60)} → ${out.split("\n")[0].slice(0, 80)}` });
    return json({ ok: true });
  }
  const prev = (await kvJson(env, `telem:${id}:latest`)) || {};
  await putJson(env, `telem:${id}:latest`, { ...prev, ...entry, last_type: entry.type });
  await logActivity(env, id, entry);
  if (entry.type === "update" && entry.msg) {
    const st = (await kvJson(env, `state:${id}`)) || {};
    st.last_update_result = { at: entry.received_at, msg: entry.msg };
    const m = entry.msg.match(/^SUCCESS:\s*(\S+)/);
    if (m) st.heltec_fw = decodeURIComponent(m[1].split("/").pop()).replace(/\.bin$/, "");
    await putJson(env, `state:${id}`, st);
  }
  return json({ ok: true });
}

async function setPowersaving(env, id, on, source) {
  const st = (await kvJson(env, `state:${id}`)) || {};
  if (st.heltec_powersaving === on) return;
  st.heltec_powersaving = on; st.powersaving_at = new Date().toISOString(); st.powersaving_source = source;
  await putJson(env, `state:${id}`, st);
  await logActivity(env, id, { type: "event", msg: `Heltec power saving ${on ? "ON: console and mesh polling paused" : "off: console and mesh polling available"} (${source})` });
}

// T-SIM pulls queued console commands (text/plain, one "<id>\t<command>" per line). Marks them sent.
async function handleDeviceCommands(request, env, id) {
  const dev = await getDevice(env, id);
  const key = request.headers.get("X-Device-Key") || "";
  if (!dev || !dev.ingest_key || !safeEq(key, dev.ingest_key)) return json({ error: "unauthorized" }, 401);
  const settings = await getSettings(env, id);
  const list = (await kvJson(env, `cmds:${id}`)) || [];
  const now = new Date().toISOString();
  const pending = settings.console_enabled ? list.filter((c) => c.status === "queued").reverse().slice(0, CMD_MAX_PENDING) : [];
  for (const c of pending) { c.status = "sent"; c.sent_at = now; }
  if (pending.length) await putJson(env, `cmds:${id}`, list);
  return new Response(pending.map((c) => `${c.id}\t${c.cmd}\n`).join(""), { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

// ---------- admin ----------
async function handleAdmin(request, env, parts) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_TOKEN || !safeEq(auth, `Bearer ${env.ADMIN_TOKEN}`)) return json({ error: "unauthorized" }, 401);
  const m = request.method;
  if (parts[0] === "accounts") return handleAdminAccounts(request, env, parts);
  if (parts.length === 1 && m === "GET") {
    const list = await env.STATE.list({ prefix: "device:" });
    const out = [];
    for (const k of list.keys) {
      const d = await kvJson(env, k.name);
      if (d) out.push({ id: d.id, name: d.name, hologram_device_id: d.hologram_device_id, created_at: d.created_at });
    }
    return json({ devices: out });
  }
  if (parts.length === 2 && parts[1] === "hologram-check" && m === "GET") {
    // Read-only key check (no SMS). Never returns the key itself.
    const k = env.HOLOGRAM_API_KEY || "";
    const out = { key_set: !!k, key_length: k.length, key_has_whitespace: /\s/.test(k) };
    if (k) {
      const r = await fetch("https://dashboard.hologram.io/api/1/users/me", { headers: { Authorization: "Basic " + btoa(`apikey:${k.trim()}`) } });
      out.users_me_status = r.status;
    }
    return json(out);
  }
  if (parts.length === 1 && m === "POST") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!ID_RE.test(b.id || "")) return json({ error: "id must match " + ID_RE }, 400);
    if (!/^\d+$/.test(String(b.hologram_device_id || ""))) return json({ error: "hologram_device_id must be numeric" }, 400);
    if ((await getDevice(env, b.id)) || (await getAccount(env, b.id))) return json({ error: "id already used by a device or fleet login" }, 409);
    const password = b.password || randomPassword();
    if (password.length < 10) return json({ error: "password must be at least 10 chars" }, 400);
    const ingest_key = randomHex(24);
    const dev = { id: b.id, name: String(b.name || b.id).slice(0, 80), hologram_device_id: String(b.hologram_device_id),
      password_hash: await hashPassword(password), pw_version: 1, ingest_key, created_at: new Date().toISOString() };
    await putJson(env, `device:${dev.id}`, dev);
    if (b.heltec_fw) await putJson(env, `state:${dev.id}`, { heltec_fw: String(b.heltec_fw).slice(0, 120) });
    return json({ id: dev.id, name: dev.name, password, ingest_key, note: "Shown once. Store them now." }, 201);
  }
  const id = parts[1];
  const dev = await getDevice(env, id);
  if (!dev) return json({ error: "no such device" }, 404);
  if (parts.length === 2 && m === "DELETE") {
    for (const k of [`device:${id}`, `state:${id}`, `source:${id}`, `release:${id}`, `telem:${id}:latest`, `telem:${id}:history`, `mesh:${id}`, `settings:${id}`, `cmds:${id}`]) await env.STATE.delete(k);
    return json({ deleted: id });
  }
  if (parts.length === 3 && parts[2] === "reset-password" && m === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const password = b.password || randomPassword();
    if (password.length < 10) return json({ error: "password must be at least 10 chars" }, 400);
    dev.password_hash = await hashPassword(password);
    dev.pw_version = (dev.pw_version || 1) + 1; // invalidates existing sessions
    await putJson(env, `device:${id}`, dev);
    return json({ id, password, note: "Shown once." });
  }
  if (parts.length === 3 && parts[2] === "rotate-key" && m === "POST") {
    dev.ingest_key = randomHex(24);
    await putJson(env, `device:${id}`, dev);
    return json({ id, ingest_key: dev.ingest_key, note: "Shown once. Rebuild the T-SIM firmware with this DEVICE_KEY." });
  }
  return json({ error: "not found" }, 404);
}

// Fleet logins: one password that opens many repeaters.
//   POST   /admin/accounts                      {id, name?, devices:[...], password?}
//   GET    /admin/accounts
//   PUT    /admin/accounts/<id>                 {devices:[...], name?}
//   POST   /admin/accounts/<id>/reset-password  {password?}
//   DELETE /admin/accounts/<id>
async function handleAdminAccounts(request, env, parts) {
  const m = request.method;
  const cleanDevices = async (arr) => {
    if (!Array.isArray(arr) || arr.length > 200) throw new Error("devices must be an array of device ids");
    const ids = [...new Set(arr.map(String))];
    for (const d of ids) if (!(await getDevice(env, d))) throw new Error(`no such device: ${d}`);
    return ids;
  };
  if (parts.length === 1 && m === "GET") {
    const list = await env.STATE.list({ prefix: "account:" });
    const out = [];
    for (const k of list.keys) { const a = await kvJson(env, k.name); if (a) out.push({ id: a.id, name: a.name, devices: a.devices, created_at: a.created_at }); }
    return json({ accounts: out });
  }
  if (parts.length === 1 && m === "POST") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!ID_RE.test(b.id || "")) return json({ error: "id must match " + ID_RE }, 400);
    if ((await getAccount(env, b.id)) || (await getDevice(env, b.id))) return json({ error: "id already used by a device or fleet login" }, 409);
    let devices; try { devices = await cleanDevices(b.devices || []); } catch (e) { return json({ error: e.message }, 400); }
    const password = b.password || randomPassword();
    if (password.length < 10) return json({ error: "password must be at least 10 chars" }, 400);
    const acct = { id: b.id, name: String(b.name || b.id).slice(0, 80), devices, password_hash: await hashPassword(password), pw_version: 1, created_at: new Date().toISOString() };
    await putJson(env, `account:${acct.id}`, acct);
    return json({ id: acct.id, name: acct.name, devices, password, note: "Shown once. Store it now." }, 201);
  }
  const acct = await getAccount(env, parts[1]);
  if (!acct) return json({ error: "no such account" }, 404);
  if (parts.length === 2 && m === "DELETE") { await env.STATE.delete(`account:${acct.id}`); return json({ deleted: acct.id }); }
  if (parts.length === 2 && m === "PUT") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    try { if (b.devices) acct.devices = await cleanDevices(b.devices); } catch (e) { return json({ error: e.message }, 400); }
    if (b.name) acct.name = String(b.name).slice(0, 80);
    await putJson(env, `account:${acct.id}`, acct);
    return json({ id: acct.id, name: acct.name, devices: acct.devices });
  }
  if (parts.length === 3 && parts[2] === "reset-password" && m === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const password = b.password || randomPassword();
    if (password.length < 10) return json({ error: "password must be at least 10 chars" }, 400);
    acct.password_hash = await hashPassword(password);
    acct.pw_version = (acct.pw_version || 1) + 1;
    await putJson(env, `account:${acct.id}`, acct);
    return json({ id: acct.id, password, note: "Shown once." });
  }
  return json({ error: "not found" }, 404);
}

// ---------- login ----------
async function handleLogin(request, env) {
  const form = await request.formData();
  const id = String(form.get("device") || "").trim().toLowerCase();
  const pw = String(form.get("password") || "");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `loginfail:${ip}:${id.slice(0, 32)}`;
  const fails = parseInt((await env.STATE.get(rlKey)) || "0", 10);
  if (fails >= LOGIN_MAX_FAILS) return html(loginPage(id, "Too many failed attempts. Try again in 15 minutes."), 429);
  const dev = await getDevice(env, id);
  const acct = dev ? null : await getAccount(env, id);
  const rec = dev || acct;
  const ok = rec ? await verifyPassword(pw, rec.password_hash) : (await hashPassword(pw), false);
  if (!ok) {
    await env.STATE.put(rlKey, String(fails + 1), { expirationTtl: LOGIN_WINDOW });
    return html(loginPage(id, "Wrong login or password."), 401);
  }
  await env.STATE.delete(rlKey);
  const cookie = cookieHeader(await makeSession(env, id, rec.pw_version || 1, dev ? "d" : "a"), SESSION_TTL);
  return redirect(dev ? `/d/${id}` : "/fleet", { "Set-Cookie": cookie });
}

// What the current session may see: {kind, id, name, devices:[ids]} or null.
async function getAccess(request, env) {
  const s = await readSession(request, env);
  if (!s) return null;
  if (s.k === "a") {
    const a = await getAccount(env, s.d);
    if (!a || (a.pw_version || 1) !== s.v) return null;
    return { kind: "a", id: a.id, name: a.name, devices: a.devices || [] };
  }
  const dev = await getDevice(env, s.d);
  if (!dev || (dev.pw_version || 1) !== s.v) return null;
  return { kind: "d", id: dev.id, name: dev.name, devices: [dev.id] };
}
async function requireSession(request, env, id) {
  const acc = await getAccess(request, env);
  if (!acc || !acc.devices.includes(id)) return null;
  return getDevice(env, id);
}

function sameOrigin(request) {
  const o = request.headers.get("Origin");
  if (!o) return true;
  if (o === "null") return request.headers.get("Sec-Fetch-Site") === "same-origin";
  return o === new URL(request.url).origin;
}

// ---------- device API ----------
async function deviceApi(request, env, dev, action) {
  const id = dev.id;
  if (action === "telemetry" && request.method === "GET") {
    const [latest, history, st, rel, mesh, settings, cmds] = await Promise.all([
      kvJson(env, `telem:${id}:latest`), kvJson(env, `telem:${id}:history`), kvJson(env, `state:${id}`), kvJson(env, `release:${id}`),
      kvJson(env, `mesh:${id}`), getSettings(env, id), kvJson(env, `cmds:${id}`),
    ]);
    const s = st || {};
    const source = await getSource(env, id);
    const schedule = { hours: settings.schedule_hours, last_run: s.last_sched_ts ? new Date(s.last_sched_ts).toISOString() : null,
      next_due: settings.schedule_hours ? new Date((s.last_sched_ts || Date.now()) + settings.schedule_hours * 3600e3).toISOString() : null };
    return json({ device: { id, name: dev.name }, source, latest, mesh, settings, schedule, commands: cmds || [], history: history || [], updates: {
      heltec_fw: s.heltec_fw || null, latest_available: rel, last_update_result: s.last_update_result || null,
      last_update_sent: s.last_update_sent || null, last_action: s.last_action || null },
      powersaving: { on: s.heltec_powersaving === true, at: s.powersaving_at || null, source: s.powersaving_source || null } });
  }
  if (action === "source" && request.method === "GET") return json(await getSource(env, id));
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!sameOrigin(request)) return json({ error: "bad origin" }, 403);
  if (action === "source") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    let src; try { src = validateSource({ ...(await getSource(env, id)), ...b }); } catch (e) { return json({ error: e.message }, 400); }
    await putJson(env, `source:${id}`, src);
    await env.STATE.delete(`release:${id}`);
    await logActivity(env, id, { type: "action", msg: `Update source changed: ${src.enabled ? src.repo + " " + src.asset_pattern : "disabled"}${src.direct_url ? " (direct URL set)" : ""}` });
    return json({ saved: true, source: src });
  }
  if (action === "check") {
    try {
      const { rel } = await resolveTarget(env, id);
      if (rel.skipped) return json({ sent: false, error: rel.skipped }, 404);
      const rec = { ...rel, checked_at: new Date().toISOString() };
      await putJson(env, `release:${id}`, rec);
      return json({ sent: false, latest_available: rec });
    } catch (e) { return json({ sent: false, error: e.message }, 502); }
  }
  if (action === "settings") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const cur = await getSettings(env, id);
    if (b.console_enabled !== undefined) cur.console_enabled = b.console_enabled === true;
    if (b.schedule_hours !== undefined) {
      const h = Number(b.schedule_hours);
      if (!SCHEDULE_CHOICES.includes(h)) return json({ error: "schedule_hours must be one of " + SCHEDULE_CHOICES.join(", ") }, 400);
      if (h !== cur.schedule_hours) {  // first scheduled check is one interval from now
        const st = (await kvJson(env, `state:${id}`)) || {}; st.last_sched_ts = Date.now(); await putJson(env, `state:${id}`, st);
      }
      cur.schedule_hours = h;
    }
    await putJson(env, `settings:${id}`, cur);
    if (!cur.console_enabled) {  // turning the console off drops anything still queued
      const list = (await kvJson(env, `cmds:${id}`)) || [];
      let n = 0; for (const c of list) if (c.status === "queued") { c.status = "cancelled"; n++; }
      if (n) await putJson(env, `cmds:${id}`, list);
    }
    await logActivity(env, id, { type: "action", msg: `Settings: console ${cur.console_enabled ? "ON" : "off"}, scheduled check ${cur.schedule_hours ? "every " + cur.schedule_hours + "h" : "off"}` });
    return json({ saved: true, settings: cur });
  }
  if (action === "commands") {
    const settings = await getSettings(env, id);
    if (!settings.console_enabled) return json({ error: "Repeater console is off for this device. Turn it on first." }, 403);
    const pst = (await kvJson(env, `state:${id}`)) || {};
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const list = (await kvJson(env, `cmds:${id}`)) || [];
    if (b.cancel) {
      let n = 0; for (const c of list) if (c.status === "queued") { c.status = "cancelled"; n++; }
      await putJson(env, `cmds:${id}`, list);
      return json({ cancelled: n });
    }
    if (pst.heltec_powersaving === true) return json({ error: PS_NOTE, powersaving: true }, 409);
    const cmd = String(b.cmd || "").trim();
    if (!cmd || cmd.length > CMD_MAX_LEN || !/^[\x20-\x7e]+$/.test(cmd)) return json({ error: `command must be 1-${CMD_MAX_LEN} printable ASCII chars` }, 400);
    if (RISKY_CMD_RE.test(cmd) && b.force !== true) return json({ error: "risky command: confirm required", risky: true }, 409);
    if (list.filter((c) => c.status === "queued").length >= CMD_MAX_PENDING) return json({ error: `max ${CMD_MAX_PENDING} queued commands` }, 429);
    const entry = { id: randomHex(4), cmd, status: "queued", queued_at: new Date().toISOString() };
    list.unshift(entry);
    await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
    let wake = null;
    if (b.wake === true) { const [o, c] = await manualSend(env, dev, "CMD", "CMD (console)"); wake = { ...o, status: c }; }
    return json({ queued: entry, wake });
  }
  if (action === "wake-cmd") {
    const settings = await getSettings(env, id);
    if (!settings.console_enabled) return json({ error: "Repeater console is off for this device." }, 403);
    if (((await kvJson(env, `state:${id}`)) || {}).heltec_powersaving === true) return json({ error: PS_NOTE, powersaving: true }, 409);
    const [o, c] = await manualSend(env, dev, "CMD", "CMD (console)"); return json(o, c);
  }
  if (action === "status") { const [o, c] = await manualSend(env, dev, "STATUS", "STATUS"); return json(o, c); }
  if (action === "reboot") { const [o, c] = await manualSend(env, dev, "REBOOT", "REBOOT"); return json(o, c); }
  if (action === "update-latest") {
    let rel;
    try { ({ rel } = await resolveTarget(env, id)); } catch (e) { return json({ sent: false, error: e.message }, 502); }
    if (rel.skipped) return json({ sent: false, error: rel.skipped }, 404);
    await putJson(env, `release:${id}`, { ...rel, checked_at: new Date().toISOString() });
    const [o, c] = await manualSend(env, dev, buildUpdateBody(rel.url), `UPDATE ${rel.asset_name}`, async (st) => {
      st.last_update_sent = { at: new Date().toISOString(), asset_name: rel.asset_name, tag: rel.tag };
    });
    return json({ ...o, release: rel }, c);
  }
  return json({ error: "not found" }, 404);
}

// ---------- fleet ----------
async function fleetApi(env, acc) {
  const out = [];
  for (const id of acc.devices) {
    const dev = await getDevice(env, id);
    if (!dev) continue;
    const [L, mesh, st, settings] = await Promise.all([kvJson(env, `telem:${id}:latest`), kvJson(env, `mesh:${id}`), kvJson(env, `state:${id}`), getSettings(env, id)]);
    const l = L || {}, m = mesh || {};
    out.push({ id, name: dev.name, last_seen: l.received_at || null, fw: l.fw || null, battery_v: l.battery_v ?? null, battery_pct: l.battery_pct ?? null,
      solar_v: l.solar_v ?? null, csq: l.csq ?? null, rsrp: l.rsrp ?? null,
      heltec_fw: m.heltec_fw || (st && st.heltec_fw) || null, node_name: m.node_name || null,
      neighbors: m.neighbors ? m.neighbors.length : null, packets: m.packets || null, radio: m.radio || null, mesh_at: m.received_at || null, mesh_test: !!m.test,
      powersaving: !!(st && st.heltec_powersaving), console_enabled: settings.console_enabled, schedule_hours: settings.schedule_hours });
  }
  return json({ account: { kind: acc.kind, id: acc.id, name: acc.name }, devices: out });
}

// Cron (hourly): text STATUS only to devices whose optional scheduled check is due.
export async function runSchedules(env, now = Date.now()) {
  const sent = [];
  for (const id of await listDeviceIds(env)) {
    const settings = await getSettings(env, id);
    const h = settings.schedule_hours;
    if (!h) continue;
    const st = (await kvJson(env, `state:${id}`)) || {};
    if (st.last_sched_ts && now - st.last_sched_ts < h * 3600e3 - 10 * 60e3) continue;
    const dev = await getDevice(env, id);
    if (!dev) continue;
    st.last_sched_ts = now; await putJson(env, `state:${id}`, st);
    const [o] = await manualSend(env, dev, "STATUS", `Scheduled STATUS (${h}h)`);
    sent.push({ id, sent: o.sent, error: o.error || null });
  }
  return sent;
}

// ---------- pages ----------
const CSS = `:root{color-scheme:light dark;--bg:#f4f6f8;--card:#fff;--fg:#1b1f24;--mut:#667;--acc:#1f6feb;--bad:#d1242f;--ok:#1a7f37}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--mut:#8b949e}}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--card);border-bottom:1px solid #8883}
main{max-width:1000px;margin:auto;padding:12px}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.card{background:var(--card);border-radius:10px;padding:12px 14px;box-shadow:0 1px 2px #0002}.card h3{margin:0 0 6px;font-size:13px;text-transform:uppercase;color:var(--mut)}
.kv{display:flex;justify-content:space-between;gap:8px;padding:2px 0}.kv span:first-child{color:var(--mut)}.kv span:last-child{text-align:right;word-break:break-all}
button,.btn{border:0;border-radius:8px;padding:12px;font-size:15px;background:var(--acc);color:#fff;cursor:pointer}button.w{background:var(--bad)}button.g{background:#57606a}
.acts{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));margin:12px 0}
pre{background:var(--card);padding:10px;border-radius:8px;overflow:auto;max-height:240px;font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border-radius:10px;overflow:hidden;font-size:13px}td,th{padding:6px 8px;border-bottom:1px solid #8882;text-align:left;vertical-align:top}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;color:#fff;background:var(--ok)}.badge.stale{background:var(--bad)}
input{width:100%;padding:10px;margin:6px 0 12px;border-radius:8px;border:1px solid #8886;font-size:16px;background:var(--card);color:var(--fg)}
.login{max-width:360px;margin:10vh auto}.err{color:var(--bad)}.mut{color:var(--mut)}.small{font-size:13px}.sm{padding:6px 12px;font-size:13px}
a{color:var(--acc)}a.dev{color:inherit;text-decoration:none;display:block}a.dev:hover{outline:2px solid var(--acc)}a.back{text-decoration:none;margin-right:6px}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}.row input{flex:1;min-width:160px;margin:6px 0}
h2{font-size:18px;margin:20px 0 8px}h3.sec{margin:16px 0 6px}details.card{margin:12px 0}summary{cursor:pointer;padding:4px 0}
.psnote{background:#d1242f22;border-left:3px solid var(--bad);padding:8px 10px;border-radius:6px}.dim{opacity:.45}
.tog{display:flex;gap:8px;align-items:center;margin:8px 0}.tog input{width:auto;margin:0}select{padding:10px;border-radius:8px;font-size:15px;margin-right:6px}
pre.o{margin:0;padding:4px;max-height:160px;white-space:pre-wrap;background:transparent}code{font-size:12px}
@media(max-width:600px){main{padding:8px}td,th{padding:5px}}`;

const HEAD = (title) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>`;
const COMMON_JS = `const $=s=>document.getElementById(s);
const e=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const t=s=>s?new Date(s).toLocaleString():"—";
const ago=s=>{if(!s)return "never";const d=(Date.now()-new Date(s))/1000;return d<90?Math.round(d)+"s ago":d<5400?Math.round(d/60)+" min ago":d<172800?Math.round(d/3600)+" h ago":Math.round(d/86400)+" d ago"};
const kv=rows=>rows.map(([k,v])=>'<div class="kv"><span>'+e(k)+'</span><span>'+e(v??"—")+'</span></div>').join("");
const STALE_MS=26*3600e3;
const sig=c=>c==null||c<0||c==99?null:(c>=20?"excellent":c>=15?"good":c>=10?"ok":"weak")+" ("+c+")";`;

export function loginPage(id = "", err = "") {
  return `${HEAD("T-SIM login")}
<body><main class="login card"><h2>Mesh repeater dashboard</h2>${err ? `<p class="err">${esc(err)}</p>` : ""}
<form method="post" action="/login"><label>Device id or fleet login<input name="device" value="${esc(id)}" autocomplete="username" required autocapitalize="none"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label><button style="width:100%">Log in</button></form></main></body></html>`;
}

export function fleetPage(acc) {
  return `${HEAD("Repeaters")}
<body><header><div><b>Repeaters</b> <small class="mut">${esc(acc.name || acc.id)}</small></div>
<form method="post" action="/logout"><button class="g sm">Log out</button></form></header>
<main><p class="mut" id="sum">Loading…</p><div class="grid" id="fleet"></div>
<p class="mut small">Readings update only when a T-SIM wakes (Request status, a console command, or an optional scheduled check). "Stale" = nothing heard for 26 h.</p></main>
<script>${COMMON_JS}
async function load(){
 const r=await fetch("/api/fleet",{credentials:"same-origin"});if(r.status===401){location.href="/";return}
 const d=await r.json(),L=d.devices||[];let on=0;
 $("fleet").innerHTML=L.map(x=>{const fresh=x.last_seen&&Date.now()-new Date(x.last_seen)<STALE_MS;if(fresh)on++;
  const p=x.packets||{};
  return '<a class="card dev" href="/d/'+encodeURIComponent(x.id)+'"><div class="row"><b>'+e(x.name)+'</b><span class="badge'+(fresh?'':' stale')+'">'+(fresh?'online':'stale')+'</span></div>'+
  '<small class="mut">'+e(x.id)+(x.node_name?' · '+e(x.node_name):'')+'</small>'+
  kv([["Last seen",ago(x.last_seen)],["Battery",x.battery_v==null?null:x.battery_v.toFixed(2)+" V ("+x.battery_pct+"%)"],["Signal",sig(x.csq)],
   ["Heltec fw",x.heltec_fw],["Neighbors",x.neighbors],["Packets rx / tx",p.recv==null?null:p.recv+" / "+p.sent],
   ["Scheduled check",x.schedule_hours?"every "+x.schedule_hours+" h":"off"],["Console",x.powersaving?"paused (power saving)":(x.console_enabled?"on":"off")]])+
  (x.mesh_test?'<small class="err">mesh data is TEST data</small>':'')+'</a>'}).join("")||'<p>No repeaters on this login.</p>';
 $("sum").textContent=L.length+" repeater"+(L.length==1?"":"s")+" · "+on+" heard in the last 26 h";
}
load();setInterval(load,30000);
</script></body></html>`;
}

export function dashboardPage(dev, acc = { kind: "d" }) {
  return `${HEAD(dev.name)}
<body><header><div>${acc.kind === "a" ? '<a href="/fleet" class="back">‹ All</a> ' : ""}<b>${esc(dev.name)}</b> <small class="mut">${esc(dev.id)}</small> <span id="seen" class="badge">…</span></div>
<form method="post" action="/logout"><button class="g sm">Log out</button></form></header>
<main><div class="grid">
<div class="card"><h3>T-SIM</h3><div id="c-tsim"></div></div>
<div class="card"><h3>Power</h3><div id="c-power"></div></div>
<div class="card"><h3>Cellular</h3><div id="c-cell"></div></div>
<div class="card"><h3>Updates</h3><div id="c-upd"></div></div>
</div>
<div class="acts">
<button data-a="status" data-c="Text STATUS to the T-SIM? It wakes, reads the repeater and reports here.">Request status</button>
<button data-a="reboot" data-c="Text REBOOT to the T-SIM? The Heltec will restart.">Reboot Heltec</button>
<button data-a="check" data-c="">Check for update</button>
<button data-a="update-latest" class="w" data-c="Text UPDATE for the latest upgrade.bin? The Heltec will be reflashed.">Update to latest</button>
</div>
<pre id="out" hidden></pre>

<h2>Mesh <small class="mut" id="meshat"></small></h2>
<p class="psnote" id="meshps" hidden>Mesh polling paused: the repeater is in power saving and its serial CLI isn't answering. Showing the last snapshot taken while it was awake. It resumes automatically when a status check gets a CLI reply. Repeater stats can still be retrieved over the mesh using MeshCore remote admin (e.g. from the MeshCore app). T-SIM stats (signal, battery, solar, modem) are still available here via Request status.</p>
<div class="grid" id="meshgrid">
<div class="card"><h3>Repeater</h3><div id="m-node"></div></div>
<div class="card"><h3>Radio</h3><div id="m-radio"></div></div>
<div class="card"><h3>Packets</h3><div id="m-pkt"></div></div>
</div>
<h3 class="sec">Neighbors</h3>
<table><thead><tr><th>Node</th><th>SNR</th><th>Last heard</th></tr></thead><tbody id="nb"></tbody></table>

<details class="card" id="schbox"><summary><b>Scheduled check</b> <small id="schsum" class="mut"></small></summary>
<p class="small mut">Optional. The Worker texts STATUS on this interval so readings stay fresh. Each check costs one incoming text and wakes the T-SIM (about 1–2 minutes of modem battery).</p>
<select id="sch"><option value="0">Off</option><option value="6">Every 6 hours</option><option value="12">Every 12 hours</option><option value="24">Daily</option><option value="168">Weekly</option></select>
<button id="schsave">Save</button> <span id="schmsg"></span></details>

<details class="card" id="conbox"><summary><b>Repeater console</b> <small id="consum" class="mut"></small></summary>
<label class="tog"><input type="checkbox" id="conon"> Allow console commands for this repeater</label>
<p class="small mut">Commands run on the Heltec's MeshCore CLI the next time the T-SIM wakes. "Queue &amp; wake" texts CMD to the T-SIM (one incoming text); output appears below within a few minutes. Note: some firmware power-saving modes (e.g. EasySkyMesh <code>powersaving on</code>) block the serial CLI. Examples: <code>ver</code> <code>neighbors</code> <code>stats-packets</code> <code>get name</code> <code>clock</code> <code>advert</code></p>
<p class="psnote" id="conps" hidden>Console unavailable while the repeater is in power saving (last CLI attempt got no reply, or <code>powersaving on</code> succeeded). Some firmware power-saving modes block the serial CLI. It re-enables after <code>powersaving off</code> or any successful CLI reply, e.g. after Request status. Repeater stats can still be retrieved over the mesh using MeshCore remote admin (e.g. from the MeshCore app). T-SIM stats (signal, battery, solar, modem) are still available here via Request status.</p>
<div id="conui"><form id="conf" class="row"><input id="cmd" maxlength="120" placeholder="MeshCore CLI command" autocapitalize="none" autocomplete="off">
<button type="submit" name="q" class="g">Queue</button><button type="button" id="qwake">Queue &amp; wake</button></form>
<div class="row small"><span id="conmsg"></span><span><button type="button" id="wake" class="g sm">Wake to run queued</button> <button type="button" id="cancel" class="g sm">Cancel queued</button></span></div>
<table><thead><tr><th>Command</th><th>Status</th><th>Output</th></tr></thead><tbody id="cmds"></tbody></table></div></details>

<details class="card" id="srcbox"><summary><b>Update source</b> <small id="srcsum" class="mut"></small></summary>
<form id="srcf" style="margin-top:8px">
<label class="tog"><input type="checkbox" name="enabled"> Use GitHub releases</label>
<label>GitHub repo (owner/name)<input name="repo" placeholder="IoTThinks/EasySkyMesh"></label>
<label>Asset filename pattern (* = anything)<input name="asset_pattern" placeholder="Heltec_v3_repeater-*-upgrade.bin"></label>
<label>Direct URL override (used when GitHub is off)<input name="direct_url" placeholder="https://..."></label>
<button type="submit">Save source</button> <span id="srcmsg"></span></form></details>
<p class="small mut">One text per 60 s per T-SIM. The T-SIM wakes on the text, then reports here within a few minutes.</p>
<h3 class="sec">Recent activity</h3><table><thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead><tbody id="log"></tbody></table>
</main>
<script>${COMMON_JS}
const ID=${JSON.stringify(dev.id)},API="/api/d/"+encodeURIComponent(ID)+"/";
const WAKE={0:"cold boot / RST",2:"text (RI pin)",4:"timer",7:"USB/other"};
const up=s=>s==null?null:(s>=86400?Math.floor(s/86400)+"d ":"")+(s>=3600?Math.floor(s%86400/3600)+"h ":"")+Math.floor(s%3600/60)+"m";
const post=(a,b)=>fetch(API+a,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:b===undefined?undefined:JSON.stringify(b)});
let first=true;
async function load(){
 const r=await fetch(API+"telemetry",{credentials:"same-origin"});
 if(r.status===401){location.href="/";return}
 const d=await r.json(),L=d.latest||{},U=d.updates||{},M=d.mesh||{},S=d.settings||{};if(d.source)showSource(d.source);
 const seen=L.received_at?new Date(L.received_at):null,stale=!seen||Date.now()-seen>STALE_MS;
 $("seen").textContent=seen?(stale?"stale · ":"")+"seen "+ago(L.received_at):"never seen";$("seen").className="badge"+(stale?" stale":"");
 $("c-tsim").innerHTML=kv([["Firmware",L.fw],["Last seen",t(L.received_at)],["Wake cause",L.wake==null?null:(WAKE[L.wake]||L.wake)],["Uptime",L.uptime==null?null:L.uptime+" s"],["Last message",L.msg]]);
 $("c-power").innerHTML=kv([["Battery",L.battery_v==null?null:L.battery_v.toFixed(2)+" V ("+L.battery_pct+"%)"],["Solar",L.solar_v==null?null:L.solar_v.toFixed(2)+" V"],["Free heap",L.heap],["Flash free",L.fs_free]]);
 $("c-cell").innerHTML=kv([["Signal",sig(L.csq)],["RSRP / RSRQ",L.rsrp==null?null:L.rsrp+" / "+L.rsrq],["Operator",L.operator],["Registration",L.reg],["IP",L.ip],["Modem fw",L.modem_fw]]);
 const la=U.latest_available,lr=U.last_update_result;
 $("c-upd").innerHTML=kv([["Heltec firmware",M.heltec_fw||U.heltec_fw],["Latest available",la?la.asset_name+(la.via==="direct"?" (direct URL)":""):"press Check for update"],["Checked",la&&t(la.checked_at)],["Last update",lr?lr.msg:null],["Last text sent",U.last_action?U.last_action.label+" · "+t(U.last_action.at):null]]);
 // mesh
 const C=M.core||{},R=M.radio||{},P=M.packets||{};
 $("meshat").textContent=M.received_at?"· snapshot "+ago(M.received_at)+(M.test?" · TEST DATA":""):"· no snapshot yet (press Request status)";
 $("m-node").innerHTML=kv([["Name",M.node_name],["Firmware",M.heltec_fw],["Clock",M.clock],["Heltec battery",C.battery_mv==null?null:(C.battery_mv/1000).toFixed(2)+" V"],["Uptime",up(C.uptime_secs)],["Queue / errors",C.queue_len==null?null:C.queue_len+" / "+C.errors]]);
 $("m-radio").innerHTML=kv([["Noise floor",R.noise_floor==null?null:R.noise_floor+" dBm"],["Last RSSI",R.last_rssi==null?null:R.last_rssi+" dBm"],["Last SNR",R.last_snr==null?null:R.last_snr+" dB"],["TX airtime",up(R.tx_air_secs)],["RX airtime",up(R.rx_air_secs)]]);
 $("m-pkt").innerHTML=kv([["Received",P.recv],["Sent",P.sent],["Flood tx / rx",P.flood_tx==null?null:P.flood_tx+" / "+P.flood_rx],["Direct tx / rx",P.direct_tx==null?null:P.direct_tx+" / "+P.direct_rx],["RX errors",P.recv_errors]]);
 const N=M.neighbors;$("nb").innerHTML=N==null?'<tr><td colspan=3>No data yet</td></tr>':(N.length?N.map(n=>'<tr><td><code>'+e(n.id)+'</code></td><td>'+e(n.snr)+' dB</td><td>'+e(ago(n.heard_at))+'</td></tr>').join(""):'<tr><td colspan=3>No neighbors heard</td></tr>');
 if(M.error)$("nb").innerHTML+='<tr><td colspan=3 class="err">'+e(M.error)+'</td></tr>';
 // schedule + console
 const sc=d.schedule||{};$("schsum").textContent="· "+(S.schedule_hours?"every "+S.schedule_hours+" h, next ~"+t(sc.next_due):"off");
 $("consum").textContent="· "+(S.console_enabled?"on":"off");
 if(first){$("sch").value=String(S.schedule_hours||0);$("conon").checked=!!S.console_enabled;first=false}
 const PS=!!(d.powersaving&&d.powersaving.on);
 $("meshps").hidden=!PS;$("meshgrid").classList.toggle("dim",PS);$("nb").closest("table").classList.toggle("dim",PS);
 $("conps").hidden=!(PS&&S.console_enabled);$("conui").hidden=!S.console_enabled||PS;
 if(PS)$("consum").textContent="· unavailable (power saving)";
 const CM=d.commands||[];$("cmds").innerHTML=CM.length?CM.map(c=>'<tr><td><code>'+e(c.cmd)+'</code><br><small class="mut">'+e(t(c.done_at||c.sent_at||c.queued_at))+'</small></td><td>'+e(c.status)+'</td><td><pre class="o">'+e(c.output||c.error||"")+'</pre></td></tr>').join(""):'<tr><td colspan=3>No commands yet</td></tr>';
 $("log").innerHTML=(d.history||[]).map(h=>'<tr><td>'+e(t(h.received_at))+'</td><td>'+e(h.type)+(h.test?' <b class="err">TEST</b>':'')+'</td><td>'+e(h.msg||(h.type==="status"?"status report":""))+'</td></tr>').join("")||'<tr><td colspan=3>No activity yet</td></tr>';
}
let srcLoaded=false;
function showSource(s){const f=$("srcf");$("srcsum").textContent=s.enabled?"· "+s.repo+" · "+s.asset_pattern:(s.direct_url?"· direct URL":"· disabled");
 const off=!s.enabled&&!s.direct_url;document.querySelectorAll('button[data-a="check"],button[data-a="update-latest"]').forEach(b=>{b.disabled=off;b.title=off?"Set an update source first":""});
 if(!srcLoaded){f.enabled.checked=!!s.enabled;f.repo.value=s.repo||"";f.asset_pattern.value=s.asset_pattern||"";f.direct_url.value=s.direct_url||"";srcLoaded=true;}}
$("srcf").onsubmit=async ev=>{ev.preventDefault();const f=ev.target;
 const r=await post("source",{enabled:f.enabled.checked,repo:f.repo.value,asset_pattern:f.asset_pattern.value,direct_url:f.direct_url.value});
 const j=await r.json();$("srcmsg").textContent=r.ok?"Saved":("Error: "+(j.error||r.status));if(r.ok){srcLoaded=false;showSource(j.source);load();}};
$("schsave").onclick=async()=>{const h=+$("sch").value;
 if(h&&!confirm("Text STATUS to this T-SIM every "+h+" hours? Each check costs one incoming text and some battery."))return;
 const r=await post("settings",{schedule_hours:h});const j=await r.json();$("schmsg").textContent=r.ok?"Saved":"Error: "+(j.error||r.status);load();};
$("conon").onchange=async ev=>{const on=ev.target.checked;
 if(on&&!confirm("Allow console commands for this repeater? Anyone with this login can then run MeshCore CLI commands on it."))return void(ev.target.checked=false);
 const r=await post("settings",{console_enabled:on});if(!r.ok)ev.target.checked=!on;load();};
async function queue(wake,force){const c=$("cmd").value.trim();if(!c)return;
 if(wake&&!confirm("Queue '"+c+"' and text CMD to wake the T-SIM?"))return;
 const r=await post("commands",{cmd:c,wake,force:!!force});const j=await r.json();
 if(r.status===409&&j.risky){if(confirm("'"+c+"' can change or wipe the repeater's settings. Queue it anyway?"))return queue(wake,true);return}
 $("conmsg").textContent=r.ok?("Queued"+(j.wake?(j.wake.sent?" · wake text sent":" · wake not sent: "+(j.wake.error||(j.wake.hologram_response_summary||{}).error)):"")):"Error: "+(j.error||r.status);
 if(r.ok)$("cmd").value="";load();}
$("conf").onsubmit=ev=>{ev.preventDefault();queue(false)};$("qwake").onclick=()=>queue(true);
$("wake").onclick=async()=>{if(!confirm("Text CMD to wake the T-SIM and run the queued commands?"))return;const r=await post("wake-cmd");const j=await r.json();$("conmsg").textContent=j.sent?"Wake text sent":"Not sent: "+(j.error||(j.hologram_response_summary||{}).error||r.status);load();};
$("cancel").onclick=async()=>{const r=await post("commands",{cancel:true});const j=await r.json();$("conmsg").textContent=r.ok?"Cancelled "+j.cancelled:"Error: "+(j.error||r.status);load();};
document.querySelectorAll("button[data-a]").forEach(b=>b.onclick=async()=>{
 if(b.dataset.c&&!confirm(b.dataset.c))return;
 b.disabled=true;const o=$("out");o.hidden=false;o.textContent="…";
 try{const r=await post(b.dataset.a);o.textContent=r.status+"\\n"+JSON.stringify(await r.json(),null,2);if(r.status===401)location.href="/";}
 catch(x){o.textContent=String(x)}b.disabled=false;load();
});
load();setInterval(load,30000);
</script></body></html>`;
}

// ---------- router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const m = request.method;
    try {
      if (parts[0] === "ingest" && parts.length === 2 && m === "POST") return await handleIngest(request, env, parts[1]);
      if (parts[0] === "api" && parts[1] === "dev" && parts.length === 4 && parts[3] === "commands" && m === "GET") return await handleDeviceCommands(request, env, parts[2]);
      if (parts[0] === "admin" && (parts[1] === "devices" || parts[1] === "accounts")) return await handleAdmin(request, env, parts.slice(1));
      if (url.pathname === "/" && m === "GET") {
        const acc = await getAccess(request, env);
        if (acc) return redirect(acc.kind === "a" ? "/fleet" : `/d/${acc.id}`);
        return html(loginPage());
      }
      if (url.pathname === "/login" && m === "POST") {
        // login: no origin check (password is the gate; some browsers send Origin: null)
        return await handleLogin(request, env);
      }
      if (url.pathname === "/logout" && m === "POST") return redirect("/", { "Set-Cookie": cookieHeader("", 0) });
      if (url.pathname === "/fleet" && m === "GET") {
        const acc = await getAccess(request, env);
        return acc ? html(fleetPage(acc)) : redirect("/");
      }
      if (url.pathname === "/api/fleet" && m === "GET") {
        const acc = await getAccess(request, env);
        return acc ? await fleetApi(env, acc) : json({ error: "login required" }, 401);
      }
      if (parts[0] === "d" && parts.length === 2 && m === "GET") {
        const acc = await getAccess(request, env);
        const dev = acc && acc.devices.includes(parts[1]) ? await getDevice(env, parts[1]) : null;
        return dev ? html(dashboardPage(dev, acc)) : redirect("/");
      }
      if (parts[0] === "api" && parts[1] === "d" && parts.length === 4) {
        const dev = await requireSession(request, env, parts[2]);
        if (!dev) return json({ error: "login required" }, 401);
        return await deviceApi(request, env, dev, parts[3]);
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.log("error", e && e.stack);
      return json({ error: "internal error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedules(env).then((r) => console.log("schedules", JSON.stringify(r))));
  },
};
