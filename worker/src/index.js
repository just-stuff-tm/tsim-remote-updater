// T-SIM remote updater — Cloudflare Worker
// Multi-repeater mesh dashboard: per-device or fleet (account) password login, telemetry,
// MeshCore mesh snapshot, optional repeater console, manual SMS actions via Hologram.
// The only automatic sends are OPTIONAL per-device scheduled checks (off by default) run by the cron.
//
// Bindings: KV STATE; secrets HOLOGRAM_API_KEY, ADMIN_TOKEN, SESSION_SECRET; optional GITHUB_TOKEN.

const DEFAULT_SOURCE = { enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", tag_prefix: "", direct_url: "" };
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
  if (b.tag_prefix !== undefined) {
    o.tag_prefix = String(b.tag_prefix).trim();
    if (!/^[A-Za-z0-9._-]{0,40}$/.test(o.tag_prefix)) throw new Error("tag prefix: up to 40 letters, digits, . _ -");
  }
  if (b.direct_url !== undefined) {
    o.direct_url = String(b.direct_url).trim();
    if (o.direct_url && (!/^https:\/\/\S+$/.test(o.direct_url) || o.direct_url.length > 300)) throw new Error("direct URL must start with https:// (max 300 chars)");
  }
  return o;
}
// T-SIM's own firmware (OTA self-update, firmware >= 1.6.0)
const DEFAULT_TSIM_SOURCE = { mode: "github", repo: "just-stuff-tm/tsim-remote-updater", asset: "firmware.bin", url: "", checksum: "" };
export function normChecksum(c) {
  c = String(c || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!c) return "";
  if (/^sha256:[0-9a-f]{64}$/.test(c) || /^md5:[0-9a-f]{32}$/.test(c)) return c;
  if (/^[0-9a-f]{64}$/.test(c)) return "sha256:" + c;
  if (/^[0-9a-f]{32}$/.test(c)) return "md5:" + c;
  throw new Error("checksum must be a SHA-256 (64 hex) or MD5 (32 hex), optionally prefixed sha256: / md5:");
}
export function validateTsimSource(b) {
  const o = { ...DEFAULT_TSIM_SOURCE };
  if (b.mode !== undefined) { if (!["github", "url"].includes(b.mode)) throw new Error("mode must be github or url"); o.mode = b.mode; }
  if (b.repo !== undefined) { o.repo = String(b.repo).trim(); if (!REPO_RE.test(o.repo)) throw new Error("repo must look like owner/name"); }
  if (b.asset !== undefined) { o.asset = String(b.asset).trim(); if (!o.asset || o.asset.length > 120 || /[\s/]/.test(o.asset)) throw new Error("asset: 1-120 chars, no spaces or slashes"); }
  if (b.url !== undefined) { o.url = String(b.url).trim(); if (o.url && (!/^https:\/\/\S+$/.test(o.url) || o.url.length > 300)) throw new Error("URL must start with https:// (max 300 chars)"); }
  if (b.checksum !== undefined) o.checksum = normChecksum(b.checksum);
  if (o.mode === "url" && !o.url) throw new Error("set a firmware URL or switch to GitHub releases");
  return o;
}
const getTsimSource = async (env, id) => ({ ...DEFAULT_TSIM_SOURCE, ...((await kvJson(env, `tsimsrc:${id}`)) || {}) });
export async function resolveTsimTarget(env, id) {
  const src = await getTsimSource(env, id);
  if (src.mode === "url") {
    const name = decodeURIComponent(src.url.split(/[?#]/)[0].split("/").pop() || "firmware.bin");
    return { src, rel: { tag: "url", asset_name: name, url: src.url, checksum: src.checksum || "", via: "url" } };
  }
  const rel = await latestRelease(env, { repo: src.repo, asset_pattern: src.asset });
  if (rel.skipped) return { src, rel };
  let checksum = src.checksum || "";
  if (!checksum && rel.digest) { try { checksum = normChecksum(rel.digest); } catch {} }
  return { src, rel: { ...rel, checksum } };
}
export const buildTsimCommand = (url, checksum) => `TSIMUPDATE ${url}${checksum ? " " + checksum : ""}`;

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
// Asset choice: matches the pattern; "-merged" full-flash images are skipped unless the pattern asks for them.
export function pickAsset(names, pattern) {
  const re = globToRegex(pattern), wantMerged = /merged/i.test(pattern);
  return names.find((n) => re.test(n) && (wantMerged || !/-merged\.bin$/i.test(n)));
}
async function latestReleaseHtml(REPO, ASSET_RE, prefix = "", pattern = "") {
  let tag = "";
  if (prefix) {  // releases list page, newest first
    const r = await fetch(`https://github.com/${REPO}/releases`, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`GitHub releases page ${r.status}`);
    const tags = [...(await r.text()).matchAll(/\/releases\/tag\/([^"/?#]+)"/g)].map((m) => decodeURIComponent(m[1]));
    tag = tags.find((t) => t.startsWith(prefix)) || "";
    if (!tag) return { skipped: `no release tagged ${prefix}* on the first releases page` };
  } else {
  const r = await fetch(`https://github.com/${REPO}/releases/latest`, { headers: { "User-Agent": UA }, redirect: "manual" });
  const loc = r.headers.get("Location") || "";
  tag = decodeURIComponent((loc.match(/\/releases\/tag\/([^/?#]+)/) || [])[1] || "");
  }
  if (!tag) throw new Error(`GitHub releases/latest ${r.status}`);
  const a = await fetch(`https://github.com/${REPO}/releases/expanded_assets/${encodeURIComponent(tag)}`, { headers: { "User-Agent": UA } });
  if (!a.ok) throw new Error(`GitHub assets ${a.status}`);
  const page = await a.text();
  const names = [...page.matchAll(/\/releases\/download\/[^"]+?\/([^"/]+)"/g)].map((m) => decodeURIComponent(m[1]));
  const name = pattern ? pickAsset(names, pattern) : names.find((n) => ASSET_RE.test(n));
  if (!name) return { skipped: `no upgrade asset in ${tag}` };
  return { tag, asset_id: `${tag}/${name}`, asset_name: name, url: `https://github.com/${REPO}/releases/download/${tag}/${name}`, published_at: null, via: "html" };
}

export async function latestRelease(env = {}, src = DEFAULT_SOURCE) {
  const REPO = src.repo, ASSET_RE = globToRegex(src.asset_pattern);
  const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const prefix = src.tag_prefix || "";
  // Repos that tag per role (MeshCore: repeater-/companion-/room-server-) need the newest release with the prefix,
  // not /releases/latest (which may be another role).
  const r = await fetch(prefix ? `https://api.github.com/repos/${REPO}/releases?per_page=30` : `https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  if (r.status === 403 || r.status === 429) return latestReleaseHtml(REPO, ASSET_RE, prefix, src.asset_pattern);
  if (r.status === 404) throw new Error(`GitHub repo ${REPO} not found or has no releases`);
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  let rel = await r.json();
  if (prefix) {
    rel = (Array.isArray(rel) ? rel : []).filter((x) => !x.draft && !x.prerelease && String(x.tag_name || "").startsWith(prefix))
      .sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0))[0];
    if (!rel) return { skipped: `no release tagged ${prefix}* in the newest 30` };
  }
  if (rel.draft || rel.prerelease) return { skipped: `draft/prerelease ${rel.tag_name}` };
  const an = pickAsset((rel.assets || []).map((a) => a.name), src.asset_pattern);
  const asset = (rel.assets || []).find((a) => a.name === an);
  if (!asset) return { skipped: `no upgrade asset in ${rel.tag_name}` };
  return { tag: rel.tag_name, asset_id: asset.id, asset_name: asset.name, url: asset.browser_download_url, published_at: rel.published_at, digest: asset.digest || null };
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

// Send records live in their own key (written only by manualSend) so a concurrent device ingest that
// read a stale state: copy (KV is eventually consistent) can no longer erase an update/retry send.
const SENT_FIELDS = ["last_update_sent", "tsim_update_sent", "last_action"];
export function overlaySent(st, sent) {
  const o = { ...(st || {}) };
  if (!sent) return o;
  for (const f of SENT_FIELDS) if (sent[f] && (!o[f] || String(sent[f].at || "") > String(o[f].at || ""))) o[f] = sent[f];
  return o;
}
export function mergeSendLog(history, sent) {
  const h = history || [], log = (sent && sent.log) || [];
  const have = new Set(h.map((e) => (e.received_at || "") + "|" + (e.msg || "")));
  const add = log.filter((e) => !have.has((e.received_at || "") + "|" + (e.msg || "")));
  if (!add.length) return h;
  return [...h, ...add].sort((a, b) => String(b.received_at || "").localeCompare(String(a.received_at || ""))).slice(0, HISTORY_MAX);
}
async function loadState(env, id) {
  const [st, sent] = await Promise.all([kvJson(env, `state:${id}`), kvJson(env, `sent:${id}`)]);
  return overlaySent(st, sent);
}
async function recordSend(env, id, st, label, ok, err) {
  const sent = (await kvJson(env, `sent:${id}`)) || {};
  for (const f of SENT_FIELDS) if (st[f]) sent[f] = st[f];
  sent.last_send_ts = st.last_send_ts;
  const msg = ok ? `${label} text sent` : `${label} text FAILED: ${err}`;
  sent.log = [{ received_at: new Date().toISOString(), type: "action", msg }, ...(sent.log || [])].slice(0, 30);
  await putJson(env, `sent:${id}`, sent);
}

async function manualSend(env, dev, body, label, onSuccess) {
  const stKey = `state:${dev.id}`;
  const st = await loadState(env, dev.id);
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
    await recordSend(env, dev.id, st, label, true);
    await logActivity(env, dev.id, { type: "action", msg: `${label} text sent` });
    return [{ sent: true, body, hologram_response_summary: { success: true } }, 200];
  } catch (e) {
    st.last_action = { at: new Date().toISOString(), label, sent: false, error: e.message };
    await putJson(env, stKey, st);
    await recordSend(env, dev.id, st, label, false, e.message);
    await logActivity(env, dev.id, { type: "action", msg: `${label} text FAILED: ${e.message}` });
    return [{ sent: false, body, hologram_response_summary: { success: false, error: e.message } }, 502];
  }
}

// ---------- update progress (built from the telemetry events the firmware already posts) ----------
export const STEPS = ["Waiting for T-SIM to wake", "Downloading", "Verifying", "Writing / flashing", "Rebooting", "Done"];
const PROGRESS_TIMEOUT_MS = 15 * 60e3;
const STALL_MS = 10 * 60e3;        // no progress / check-in for this long after start = stalled
const DEDUPE_MS = 5 * 60e3;        // a second Update press within this window is refused (no extra text)
export function friendlyFail(msg) {
  const m = String(msg || "");
  const R = [[/no network|PDP down/i, "The T-SIM couldn't get an LTE data connection."], [/download/i, "The firmware file couldn't be downloaded."],
    [/checksum|mismatch|MD5/i, "The downloaded file didn't match its checksum (corrupted or wrong file)."], [/not an ESP32 app/i, "That file isn't a valid firmware image."],
    [/slot|too large|>/i, "The firmware file is too big for the T-SIM's update slot."], [/no OTA partition/i, "This T-SIM needs one USB flash of v1.6.0+ before it can update itself."],
    [/bad url/i, "The firmware link isn't valid."], [/write|verify|flash/i, "Writing the firmware failed. The old firmware is still in place."]];
  for (const [re, s] of R) if (re.test(m)) return s;
  return m ? "The update failed: " + m.replace(/^.*FAIL:\s*/, "") : "The update failed.";
}
// v1.6.4+ firmware appends flash details: "chip=ESP32-S3 image=app-only addr=0x10000 size=N written=N verify=OK md5=..."
export function parseFlashInfo(msg) {
  const out = {}; const re = /\b(chip|image|addr|size|written|verify|md5)=(\S+)/g; let m;
  while ((m = re.exec(String(msg || "")))) out[m[1]] = m[2];
  for (const k of ["size", "written"]) if (out[k] != null) out[k] = +out[k];
  return Object.keys(out).length ? out : null;
}
export function flashFile(msg) {
  const m = String(msg || "").match(/^SUCCESS:\s*(\S+)/); return m ? decodeURIComponent(m[1].split(/[?#]/)[0].split("/").pop()) : null;
}
// kind "heltec" | "tsim". history is newest-first.
export function computeProgress(kind, history = [], st = {}, now = Date.now()) {
  const sent = kind === "tsim" ? st.tsim_update_sent : st.last_update_sent;
  const isK = (h) => h.type === "update" && h.msg && (kind === "tsim" ? /^TSIM OTA/.test(h.msg) : !/^TSIM OTA/.test(h.msg) && !/^TESTDL/.test(h.msg)) ||
    (kind === "tsim" && /booted new firmware after OTA/.test(h.msg || ""));
  // Activity history is capped, so the outcome can scroll out of it; the last result is also kept in state.
  const last = kind === "tsim" ? st.tsim_last_ota : st.last_update_result;
  const hist2 = last && last.msg && !history.some((h) => h.msg === last.msg && h.received_at === last.at)
    ? [{ type: "update", msg: last.msg, received_at: last.at }, ...history] : history;
  const evs = hist2.filter(isK).slice().sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));  // oldest first
  let startAt = sent ? Date.parse(sent.at) : null;
  if (startAt == null) { const s = evs.filter((h) => /start/i.test(h.msg)).pop(); if (s) startAt = Date.parse(s.received_at); }
  if (startAt == null || now - startAt > 7 * 864e5) return { state: "idle" };
  const mine = evs.filter((h) => Date.parse(h.received_at) >= startAt - 5000);
  const target = sent ? (sent.asset_name || "") + (sent.tag && !["url", "direct"].includes(sent.tag) ? " (" + sent.tag + ")" : "") : null;
  const times = { 0: new Date(startAt).toISOString() };
  let step = 0, state = "running", reason = null, finished = null, flash = null;
  for (const h of mine) {
    const m = h.msg;
    if (kind === "tsim") {
      if (/OTA start/.test(m)) { step = Math.max(step, 1); times[1] = h.received_at; }
      else if (/OTA: downloaded/.test(m)) { step = Math.max(step, 3); times[1] ||= h.received_at; times[2] = times[3] = h.received_at; }
      else if (/OTA: written/.test(m)) { step = Math.max(step, 4); times[4] = h.received_at; }
      else if (/booted new firmware/.test(m)) { step = Math.max(step, 4); }
      else if (/OTA OK/.test(m)) { step = 5; times[5] = h.received_at; state = "done"; finished = h.received_at; }
      else if (/OTA FAIL/.test(m)) { state = "failed"; reason = friendlyFail(m); finished = h.received_at; }
    } else {
      if (/^(UPDATE )?start/i.test(m) || /^UPDATE start/.test(m)) { step = Math.max(step, 1); times[1] = h.received_at; }
      else if (/^Download done/.test(m)) { step = Math.max(step, 3); times[1] ||= h.received_at; times[2] = times[3] = h.received_at; }
      else if (/^Flashing:/.test(m)) { step = Math.max(step, 3); flash = { ...flash, ...parseFlashInfo(m) }; }
      else if (/^SUCCESS/.test(m)) { flash = { ...flash, ...parseFlashInfo(m) }; step = 5; times[4] = times[5] = h.received_at; state = "done"; finished = h.received_at; }
      else if (/FAIL/.test(m)) { const fi = parseFlashInfo(m); if (fi) flash = { ...flash, ...fi }; state = "failed"; reason = friendlyFail(m.split(" | ")[0]); finished = h.received_at; }
    }
  }
  const cancel = kind === "tsim" ? st.tsim_cancel : st.heltec_cancel;
  if (state === "running" && cancel && Date.parse(cancel.at) >= startAt)
    return { state: "cancelled", step, steps: STEPS, times, target, started_at: times[0], finished_at: cancel.at, pct: 0,
      reason: cancel.note || "Cancel requested." };
  // Version check: if the device already runs the target (or newer), the update is done, whatever the log says.
  if (state !== "done" && sent) {
    const tv = verOf(sent.tag) || verOf(sent.asset_name);
    const inst = kind === "tsim" ? st.tsim_fw : (st.radio_ver_at && Date.parse(st.radio_ver_at) >= startAt ? st.radio_ver : null);
    const iv = verOf(inst);
    if (tv && iv && vcmp(iv, tv) >= 0) {
      const at = (kind === "tsim" ? st.tsim_fw_at : st.radio_ver_at) || null;
      return { state: "done", step: 5, steps: STEPS, times: { ...times, 5: at }, target, started_at: times[0], finished_at: at, reason: null, pct: 100,
        resolved: `${kind === "tsim" ? "T-SIM" : "Repeater"} reports ${vstr(iv)}`, ...(flash ? { flash } : {}) };
    }
  }
  const lastAt = Math.max(startAt, ...mine.map((h) => Date.parse(h.received_at) || 0), st.last_checkin_ts || 0);
  if (state === "running" && now - lastAt > STALL_MS) { state = "timeout";
    reason = step === 0 ? "The T-SIM never woke up to start the update. It may be out of power or have lost its cell connection. Press Retry to text it again." :
      step === 4 && kind === "tsim" ? "The T-SIM didn't check in after rebooting. It has probably rolled back to its previous firmware. Press Retry to try again." :
      "The update started but stopped reporting for 10 minutes, most likely a lost cell connection mid-download. Press Retry to start it again."; }
  const out = { state, step, steps: STEPS, times, target, started_at: times[0], finished_at: finished, reason, pct: Math.round((step / 5) * 100) };
  if (flash) out.flash = flash;
  return out;
}

// Safety check before texting a Heltec UPDATE: T-SIM firmware older than 1.6.2 treats any 0xE9 image over 1 MiB
// as a merged image and writes it at 0x0 (over the bootloader). App-only images that big would brick the Heltec.
// 1.6.2+ picks the address from the image contents (partition table at 0x8000), so the guard is skipped there.
export function fwAtLeast(fw, want) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(fw || "")); if (!m) return false;
  const a = m.slice(1).map(Number), b = want.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
export async function heltecImageRisk(url, tsimFw) {
  if (fwAtLeast(tsimFw, "1.6.2")) return null;
  const name = decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "");
  if (/merged|factory|freshInstall/.test(name)) return null;
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0", "User-Agent": UA } });
    const size = parseInt(((r.headers.get("Content-Range") || "").split("/")[1]) || r.headers.get("Content-Length") || "0", 10);
    const b = new Uint8Array(await r.arrayBuffer());
    if (r.status === 206 && b[0] === 0xE9 && size > 1024 * 1024)
      return `Blocked for safety: ${name} is an app-only image of ${(size / 1048576).toFixed(2)} MB. The current T-SIM firmware would write it at address 0x0 (over the Heltec's bootloader) and brick it. Update the T-SIM firmware to 1.6.2 or newer first (Update T-SIM firmware), then try again.`;
  } catch {}
  return null;
}
export const FW_PRESETS = {
  easyskymesh: { label: "EasySkyMesh PowerSaving (upgrade)", enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", tag_prefix: "", direct_url: "" },
  meshcore: { label: "Stock MeshCore repeater (latest repeater-* release)", enabled: true, repo: "meshcore-dev/MeshCore", tag_prefix: "repeater-", asset_pattern: "Heltec_v3_repeater-v*.bin", direct_url: "" },
};

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
const NUM = ["uptime", "wake", "battery_v", "battery_pct", "solar_v", "battery_load_v", "battery_raw_v", "cal_scale", "cal_off", "lb_state", "lb_lo", "lb_hi", "lb_int", "csq", "rsrp", "rsrq", "reg", "heap", "fs_free"];
const STR = ["fw", "operator", "ip", "modem_fw", "last_update", "msg", "ts"];
const MESH_RAW = ["heltec_cli", "ver", "name", "clock", "stats_core", "stats_radio", "stats_packets", "neighbors", "error"];
export function sanitizeTelemetry(t) {
  const o = { type: ["status", "update", "reboot", "event", "mesh", "cmd"].includes(t.type) ? t.type : "event" };
  for (const k of NUM) if (typeof t[k] === "number" && Number.isFinite(t[k])) o[k] = t[k];
  for (const k of STR) if (t[k] != null) o[k] = String(t[k]).slice(0, 300);
  for (const k of ["lb_en", "lb_imm"]) if (typeof t[k] === "boolean") o[k] = t[k];
  if (t.type === "power") o.type = "power";
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
    if (mesh.heltec_fw) { const s3 = (await kvJson(env, `state:${id}`)) || {}; s3.radio_ver = mesh.heltec_fw; s3.radio_ver_at = entry.received_at; await putJson(env, `state:${id}`, s3); }
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
    // System (non-user) commands: T-SIM self-update, firmware-tagged sys, or anything the user never queued.
    const sys = t.sys === true || (c && c.sys) || !c || isSysCmd(c ? c.cmd : t.cmd);
    if (c) { if (sys) c.sys = true; c.status = t.error ? "error" : "done"; c.output = out; c.done_at = entry.received_at; if (t.error) c.error = String(t.error).slice(0, 120); }
    else list.unshift({ id: cmdId || randomHex(4), cmd: String(t.cmd || "?").slice(0, CMD_MAX_LEN), status: "done", output: out, done_at: entry.received_at, unsolicited: true, sys: true });
    await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
    const ran = (c ? c.cmd : String(t.cmd || "")).trim().toLowerCase();
    const reply = cleanCli(out);
    if (/^pwrcfg /.test(ran)) {
      const p = (await kvJson(env, `power:${id}`)) || {};
      if (c && c.cmd === (p.last_cmd || pwrCfgCmd({ ...DEFAULT_POWER, ...p }))) { p.applied_at = entry.received_at; p.applied_output = out.slice(0, 300); p.wake = null; await putJson(env, `power:${id}`, p); }
    }
    else if (/^tsimupdate /.test(ran)) { /* T-SIM system command: says nothing about the Heltec CLI */ }
    else if (t.heltec_cli === "asleep" || /no reply/i.test(String(t.error || ""))) await setPowersaving(env, id, true, "console: no CLI reply");
    else if (!t.error && ran === "powersaving on" && /^on\b/i.test(reply)) await setPowersaving(env, id, true, "console: powersaving on");
    else if (!t.error && reply) await setPowersaving(env, id, false, ran === "powersaving off" ? "console: powersaving off" : "console: CLI answered");
    const prev = (await kvJson(env, `telem:${id}:latest`)) || {};
    await putJson(env, `telem:${id}:latest`, { ...prev, received_at: entry.received_at });
    await logActivity(env, id, { type: "cmd", msg: `${sys ? "System" : "Console"}: ${(c ? c.cmd : String(t.cmd || "?")).slice(0, 60)} → ${out.split("\n")[0].slice(0, 80)}` });
    return json({ ok: true });
  }
  const prev = (await kvJson(env, `telem:${id}:latest`)) || {};
  await putJson(env, `telem:${id}:latest`, { ...prev, ...entry, last_type: entry.type });
  if (entry.type === "update") { const s2 = (await kvJson(env, `state:${id}`)) || {}; s2.last_checkin_ts = Date.now(); await putJson(env, `state:${id}`, s2); }
  await logActivity(env, id, entry);
  if (entry.fw || (entry.type === "mesh" && t.ver)) {
    const st = (await kvJson(env, `state:${id}`)) || {}; let ch = false;
    if (entry.fw && st.tsim_fw !== entry.fw) { st.tsim_fw = entry.fw; st.tsim_fw_at = entry.received_at; ch = true; }
    if (entry.fw && st.tsim_update_sent) {
      const tv = verOf(st.tsim_update_sent.tag) || verOf(st.tsim_update_sent.asset_name), iv = verOf(entry.fw);
      if (tv && iv && vcmp(iv, tv) >= 0) {  // target reached: never reinstall
        const list = (await kvJson(env, `cmds:${id}`)) || []; let n = 0;
        for (const c of list) if (c.status === "queued" && isTsimUpd(c)) { c.status = "cancelled"; c.error = "already running " + entry.fw; n++; }
        if (n) await putJson(env, `cmds:${id}`, list);
      }
    }
    if (ch) await putJson(env, `state:${id}`, st);
  }
  if (entry.type === "power" && entry.msg) {
    const st = (await kvJson(env, `state:${id}`)) || {};
    st.power_event = { at: entry.received_at, msg: entry.msg }; await putJson(env, `state:${id}`, st);
  }
  if (entry.type === "update" && entry.msg && /^TSIM OTA/.test(entry.msg)) {
    const st = (await kvJson(env, `state:${id}`)) || {};
    st.tsim_last_ota = { at: entry.received_at, msg: entry.msg };
    await putJson(env, `state:${id}`, st);
  } else if (entry.type === "update" && entry.msg) {
    const st = (await kvJson(env, `state:${id}`)) || {};
    st.last_update_result = { at: entry.received_at, msg: entry.msg };
    const m = entry.msg.match(/^SUCCESS:\s*(\S+)/);
    if (m) { const file = flashFile(entry.msg);
      st.heltec_fw = file.replace(/\.bin$/, "");
      st.radio_flashed = { at: entry.received_at, file, flash: parseFlashInfo(entry.msg) };
      // new firmware: whatever we knew about power saving is stale
      st.heltec_powersaving = null; st.powersaving_at = entry.received_at; st.powersaving_source = "radio firmware flashed; unknown until the next CLI/mesh reply"; }
    await putJson(env, `state:${id}`, st);
  }
  return json({ ok: true });
}

// on: true | false | null (unknown). After a radio flash the state is unknown until fresh evidence.
// A bare "no reply" only asserts power saving if this firmware has answered the CLI since the last flash;
// otherwise it stays unknown (the new firmware may simply not have been polled successfully yet).
export function psDecision(st, on, source, nowIso = new Date().toISOString()) {
  const lf = st.radio_flashed && st.radio_flashed.at;
  if (on === true && /no (CLI )?reply/i.test(source) && lf && !(st.cli_ok_at && st.cli_ok_at >= lf)) return null;
  return on;
}
async function setPowersaving(env, id, on, source) {
  const st = (await kvJson(env, `state:${id}`)) || {};
  on = psDecision(st, on, source);
  if (on === false) { st.cli_ok_at = new Date().toISOString(); if (st.heltec_powersaving === false) { await putJson(env, `state:${id}`, st); return; } }
  if (st.heltec_powersaving === on) return;
  st.heltec_powersaving = on; st.powersaving_at = new Date().toISOString(); st.powersaving_source = source;
  await putJson(env, `state:${id}`, st);
  await logActivity(env, id, { type: "event", msg: `Heltec power saving ${on === null ? "unknown (no CLI reply since the firmware change)" : on ? "ON: console and mesh polling paused" : "off: console and mesh polling available"} (${source})` });
}

export const isSysCmd = (cmd) => /^(tsimupdate|pwrcfg)\s/i.test(String(cmd || "").trim());
const isTsimUpd = (c) => /^tsimupdate\s/i.test(String(c.cmd || ""));
// ---------- power: T-SIM battery calibration + low-battery repeat protection ----------
export const LB_RATIO = 1.10;
export const DEFAULT_POWER = { cal_scale: 1, cal_off: 0, lb_en: false, lb_lo: 3.40, lb_hi: 3.75, lb_int: 30, lb_imm: false };
export const batPct = (v) => v == null ? null : v >= 4.15 ? 100 : v <= 3.30 ? 0 : Math.round((v - 3.30) * 100 / 0.85);  // same curve as the firmware
const r4 = (x) => Math.round(x * 1e4) / 1e4;
// b: {measured_v} | {cal_scale, cal_off} | {reset_cal:true} | {lb_en, lb_lo, lb_hi, lb_int, lb_imm}. rawIdle = latest idle raw ADC volts.
export function validatePower(cur, b, rawIdle) {
  const o = { ...DEFAULT_POWER, ...cur };
  if (b.reset_cal) { o.cal_scale = 1; o.cal_off = 0; }
  if (b.measured_v !== undefined) {
    const m = Number(b.measured_v);
    if (!(m >= 2.8 && m <= 4.5)) throw new Error("Measured voltage must be between 2.8 and 4.5 V.");
    if (!(rawIdle >= 2.5)) throw new Error("No idle battery reading from the T-SIM yet (needs firmware 1.6.5+, and not on USB). Press Request status first.");
    o.cal_scale = r4(m / rawIdle); o.cal_off = 0;
    if (!(o.cal_scale > 0.5 && o.cal_scale < 1.5)) throw new Error(`That gives a scale of ${o.cal_scale}, which is out of range (0.5-1.5). Check the measurement.`);
  }
  if (b.cal_scale !== undefined) { const f = Number(b.cal_scale); if (!(f > 0.5 && f < 1.5)) throw new Error("Scale factor must be between 0.5 and 1.5."); o.cal_scale = r4(f); }
  if (b.cal_off !== undefined) { const f = Number(b.cal_off); if (!(f > -0.5 && f < 0.5)) throw new Error("Offset must be between -0.5 and +0.5 V."); o.cal_off = Math.round(f * 1000) / 1000; }
  if (b.lb_en !== undefined) o.lb_en = b.lb_en === true;
  if (b.lb_imm !== undefined) o.lb_imm = b.lb_imm === true;
  if (b.lb_lo !== undefined) o.lb_lo = Math.round(Number(b.lb_lo) * 100) / 100;
  if (b.lb_hi !== undefined) o.lb_hi = Math.round(Number(b.lb_hi) * 100) / 100;
  if (b.lb_int !== undefined) o.lb_int = Math.round(Number(b.lb_int));
  if (b.lb_int_h !== undefined) {
    const h = Number(b.lb_int_h);
    if (!(h >= 0.25 && h <= 24)) throw new Error("Check interval must be between 0.25 and 24 hours.");
    o.lb_int = Math.round(h * 60);
  }
  if (!(o.lb_lo >= 3.0 && o.lb_lo <= 4.0)) throw new Error("'Turn repeat OFF below' must be between 3.00 and 4.00 V.");
  if (!(o.lb_hi <= 4.3)) throw new Error("'Turn repeat ON at/above' must be 4.30 V or lower.");
  if (!(o.lb_hi >= o.lb_lo * LB_RATIO - 0.005))
    throw new Error(`'Turn repeat ON at/above' must be at least 10% higher than 'OFF below': with OFF at ${o.lb_lo.toFixed(2)} V, ON must be ${(Math.ceil(o.lb_lo * LB_RATIO * 100) / 100).toFixed(2)} V or more.`);
  if (!(o.lb_int >= 15 && o.lb_int <= 1440)) throw new Error("Check interval must be between 0.25 and 24 hours.");
  return o;
}
export const pwrCfgCmd = (p) => `PWRCFG scale=${p.cal_scale} off=${p.cal_off} en=${p.lb_en ? 1 : 0} lo=${p.lb_lo.toFixed(2)} hi=${p.lb_hi.toFixed(2)} int=${p.lb_int} imm=${p.lb_imm ? 1 : 0}`;
// Console history shows only what the user typed (system commands still drive state, they're just hidden).
export const userCommands = (list) => (list || []).filter((c) => !c.sys && !c.unsolicited && !isSysCmd(c.cmd));
// T-SIM pulls queued console commands (text/plain, one "<id>\t<command>" per line). Marks them sent.
async function handleDeviceCommands(request, env, id) {
  const dev = await getDevice(env, id);
  const key = request.headers.get("X-Device-Key") || "";
  if (!dev || !dev.ingest_key || !safeEq(key, dev.ingest_key)) return json({ error: "unauthorized" }, 401);
  const settings = await getSettings(env, id);
  const list = (await kvJson(env, `cmds:${id}`)) || [];
  const now = new Date().toISOString();
  const sysOnly = new URL(request.url).searchParams.get("sys") === "1";  // STATUS/REBOOT wakes: system commands only
  const lat = (await kvJson(env, `telem:${id}:latest`)) || {};
  const pwrOk = fwAtLeast(lat.fw, "1.6.5");  // older firmware would pass PWRCFG to the repeater CLI
  const pending = list.filter((c) => c.status === "queued" && (c.sys || (!sysOnly && settings.console_enabled)) && (pwrOk || !/^pwrcfg\s/i.test(c.cmd || ""))).reverse().slice(0, CMD_MAX_PENDING);
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
    for (const k of [`device:${id}`, `state:${id}`, `source:${id}`, `release:${id}`, `telem:${id}:latest`, `telem:${id}:history`, `mesh:${id}`, `settings:${id}`, `cmds:${id}`, `tsimsrc:${id}`, `tsimrel:${id}`]) await env.STATE.delete(k);
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

// ---------- update dedupe / retry ----------
async function bodyRetry(request) { try { const b = await request.clone().json(); return b && b.retry === true; } catch { return false; } }
// Returns a friendly refusal if an update of this kind is already queued/running (so a double press never sends a 2nd text).
export async function dupeCheck(env, id, kind, retry, now = Date.now()) {
  const st = await loadState(env, id);
  const p = computeProgress(kind, (await kvJson(env, `telem:${id}:history`)) || [], st, now);
  const who = kind === "tsim" ? "T-SIM" : "radio";
  if (p.state === "running") {
    const mins = Math.max(1, Math.round((now - Date.parse(p.started_at)) / 60e3));
    if (now - Date.parse(p.started_at) < DEDUPE_MS || p.step > 0 || !retry)
      return `A ${who} update was already requested ${mins} min ago and is ${p.step ? "in progress" : "waiting for the T-SIM to wake"}. No new text was sent. Use Cancel first if you want to stop it.`;
  }
  if (retry && !["timeout", "failed", "cancelled"].includes(p.state)) return null;
  return null;
}

// ---------- device API ----------
async function deviceApi(request, env, dev, action) {
  const id = dev.id;
  if (action === "telemetry" && request.method === "GET") {
    const pwr = { ...DEFAULT_POWER, ...((await kvJson(env, `power:${id}`)) || {}) };
    const [latest, history, st, rel, mesh, settings, cmds, tsimSrc, tsimRel] = await Promise.all([
      kvJson(env, `telem:${id}:latest`), kvJson(env, `telem:${id}:history`), kvJson(env, `state:${id}`), kvJson(env, `release:${id}`),
      kvJson(env, `mesh:${id}`), getSettings(env, id), kvJson(env, `cmds:${id}`), getTsimSource(env, id), kvJson(env, `tsimrel:${id}`),
      kvJson(env, `sent:${id}`),
    ]).then((r) => { r[2] = overlaySent(r[2], r[9]); r[1] = mergeSendLog(r[1], r[9]); return r; });
    const s = st || {};
    const source = await getSource(env, id);
    const schedule = scheduleInfo(settings.schedule_hours, s);
    const pq = (cmds || []).find((c) => /^pwrcfg\s/i.test(c.cmd || "") && (c.status === "queued" || c.status === "sent"));
    return json({ device: { id, name: dev.name }, source, latest, mesh, settings, schedule, commands: userCommands(cmds),
      power: { settings: pwr, pending: pq ? pq.status : null, wake: pwr.wake || null, event: (st && st.power_event) || null, ratio: LB_RATIO }, history: history || [], updates: {
      heltec_fw: s.heltec_fw || null, latest_available: rel, last_update_result: s.last_update_result || null,
      last_update_sent: s.last_update_sent || null, last_action: s.last_action || null },
      powersaving: { on: s.heltec_powersaving === true, unknown: s.heltec_powersaving === null, at: s.powersaving_at || null, source: s.powersaving_source || null },
      tsim: { fw: (latest && latest.fw) || null, source: tsimSrc, latest_available: tsimRel, last_ota: s.tsim_last_ota || null, last_sent: s.tsim_update_sent || null },
      progress: { heltec: computeProgress("heltec", history || [], s), tsim: computeProgress("tsim", history || [], s) }, presets: FW_PRESETS,
      update_status: statuses(latest, mesh, s, history, rel, tsimRel) });
  }
  if (action === "source" && request.method === "GET") return json(await getSource(env, id));
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!sameOrigin(request)) return json({ error: "bad origin" }, 403);
  if (action === "source") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    let src; try { src = validateSource({ ...(await getSource(env, id)), ...b }); } catch (e) { return json({ error: e.message }, 400); }
    await putJson(env, `source:${id}`, src);
    await env.STATE.delete(`release:${id}`);
    await logActivity(env, id, { type: "action", msg: `Update source changed: ${src.enabled ? src.repo + " " + (src.tag_prefix ? src.tag_prefix + "* " : "") + src.asset_pattern : "disabled"}${src.direct_url ? " (direct URL set)" : ""}` });
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
  if (action === "power") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const cur = (await kvJson(env, `power:${id}`)) || {};
    const L = (await kvJson(env, `telem:${id}:latest`)) || {};
    let p; try { p = validatePower(cur, b, L.battery_raw_v); } catch (e) { return json({ error: e.message }, 400); }
    const cmd = pwrCfgCmd(p);
    const list = (await kvJson(env, `cmds:${id}`)) || [];
    const unchanged = cur.applied_at && cur.last_cmd === cmd;  // same as what the T-SIM already runs: nothing to deliver
    const now = new Date().toISOString();
    let entry = null;
    if (!unchanged) {
      p.updated_at = now; p.applied_at = null; p.applied_output = null; p.last_cmd = cmd;  // keep p.wake: a recent wake text still delivers the newest settings
      if (b.measured_v !== undefined) p.cal_from = { measured_v: Number(b.measured_v), raw_v: L.battery_raw_v, at: L.received_at || null };
      const q = list.find((c) => c.status === "queued" && c.cmd === cmd);
      for (const c of list) if (c !== q && c.status === "queued" && /^pwrcfg\s/i.test(c.cmd || "")) c.status = "cancelled";  // newest settings win
      entry = q || { id: randomHex(4), cmd, sys: true, status: "queued", queued_at: now };
      if (!q) list.unshift(entry);
      await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
      await putJson(env, `power:${id}`, p);
      await logActivity(env, id, { type: "action", msg: `Power settings saved: ${cmd.slice(7)}` });
    }
    let wake = null;
    if (b.send === true && !unchanged) {
      if (!fwAtLeast(L.fw, "1.6.5")) wake = { sent: false, error: "The T-SIM needs firmware 1.6.5 or newer for these settings. Update the T-SIM first." };
      else if (p.wake && p.wake.sent && Date.now() - Date.parse(p.wake.at) < 15 * 60e3) wake = { sent: false, already: true, error: "A wake text was already sent " + Math.round((Date.now() - Date.parse(p.wake.at)) / 60e3) + " min ago; the settings will be picked up when the T-SIM wakes. No new text sent." };
      else {
        const [o] = await manualSend(env, dev, "STATUS", "Deliver power settings (STATUS)");
        wake = { sent: !!o.sent, at: new Date().toISOString(), error: o.error || (o.hologram_response_summary && o.hologram_response_summary.error) || null };
        const p2 = (await kvJson(env, `power:${id}`)) || p; p2.wake = wake; await putJson(env, `power:${id}`, p2); p = p2;
      }
    }
    return json({ saved: true, unchanged: !!unchanged, power: p, queued: entry, wake });
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
      let n = 0; for (const c of list) if (c.status === "queued" && !c.sys) { c.status = "cancelled"; n++; }
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
  if (action === "tsim-source") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    let src; try { src = validateTsimSource({ ...(await getTsimSource(env, id)), ...b }); } catch (e) { return json({ error: e.message }, 400); }
    await putJson(env, `tsimsrc:${id}`, src);
    await env.STATE.delete(`tsimrel:${id}`);
    await logActivity(env, id, { type: "action", msg: `T-SIM firmware source: ${src.mode === "url" ? "URL" : src.repo + " " + src.asset}${src.checksum ? " (checksum set)" : ""}` });
    return json({ saved: true, source: src });
  }
  if (action === "update-cancel") {
    let b = {}; try { b = await request.json(); } catch {}
    const kind = b.kind === "tsim" ? "tsim" : b.kind === "heltec" ? "heltec" : null;
    if (!kind) return json({ error: "kind must be tsim or heltec" }, 400);
    const st = await loadState(env, id);
    const hist = (await kvJson(env, `telem:${id}:history`)) || [];
    const p = computeProgress(kind, hist, st);
    if (p.state !== "running" && p.state !== "timeout") return json({ cancelled: false, error: "No update is in progress." }, 409);
    let cleared = 0;
    if (kind === "tsim") {
      const list = (await kvJson(env, `cmds:${id}`)) || [];
      for (const c of list) if (c.status === "queued" && c.sys && isTsimUpd(c)) { c.status = "cancelled"; cleared++; }
      if (cleared) await putJson(env, `cmds:${id}`, list);
    }
    const note = kind === "tsim"
      ? (cleared ? "Cancelled before the T-SIM picked it up. Nothing will be installed." : "Cancel requested. The T-SIM had already started, so it may finish the current step.")
      : (p.step === 0 ? "Cancel requested. The update text was already delivered, so the T-SIM may still run it when it wakes." : "Cancel requested. The device may finish the current step.");
    st[kind === "tsim" ? "tsim_cancel" : "heltec_cancel"] = { at: new Date().toISOString(), cleared, note };
    await putJson(env, `state:${id}`, st);
    await logActivity(env, id, { type: "action", msg: `${kind === "tsim" ? "T-SIM" : "Radio"} update cancelled by user (${cleared ? "queued command removed" : "device may finish current step"})` });
    return json({ cancelled: true, cleared, note });
  }
  if (action === "tsim-check" || action === "tsim-update") {
    let rel;
    const retry = action === "tsim-update" ? await bodyRetry(request) : false;
    if (action === "tsim-update") { const d = await dupeCheck(env, id, "tsim", retry); if (d) return json({ sent: false, error: d, duplicate: true }, 409); }
    const prevSent = ((await kvJson(env, `state:${id}`)) || {}).tsim_update_sent;
    if (retry && prevSent && prevSent.url) rel = { url: prevSent.url, checksum: prevSent.checksum, asset_name: prevSent.asset_name, tag: prevSent.tag };
    else try { ({ rel } = await resolveTsimTarget(env, id)); } catch (e) { return json({ sent: false, error: e.message }, 502); }
    if (rel.skipped) return json({ sent: false, error: rel.skipped }, 404);
    const rec = { ...rel, checked_at: new Date().toISOString() };
    if (!(retry && prevSent && prevSent.url)) await putJson(env, `tsimrel:${id}`, rec);
    if (action === "tsim-check") return json({ sent: false, latest_available: rec });
    const cmd = buildTsimCommand(rel.url, rel.checksum);
    if (cmd.length > 450) return json({ sent: false, error: "firmware URL too long" }, 400);
    const list = (await kvJson(env, `cmds:${id}`)) || [];
    for (const c of list) if (c.status === "queued" && c.sys && isTsimUpd(c)) c.status = "cancelled";  // only one pending self-update
    const entry = { id: randomHex(4), cmd, sys: true, status: "queued", queued_at: new Date().toISOString() };
    const [o, code] = await manualSend(env, dev, "CMD", `T-SIM firmware ${retry ? "update retry" : "update"} (${rel.asset_name}${rel.tag && rel.tag !== "url" ? " " + rel.tag : ""})`, async (st) => {
      st.tsim_update_sent = { at: new Date().toISOString(), asset_name: rel.asset_name, tag: rel.tag, checksum: rel.checksum || null, url: rel.url, retry };
    });
    if (o.sent) { list.unshift(entry); await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY)); }
    return json({ ...o, release: rec, queued: o.sent ? entry : null }, code);
  }
  if (action === "status") { const [o, c] = await manualSend(env, dev, "STATUS", "STATUS"); return json(o, c); }
  if (action === "reboot") { const [o, c] = await manualSend(env, dev, "REBOOT", "REBOOT"); return json(o, c); }
  if (action === "update-latest") {
    let rel;
    const retry = await bodyRetry(request);
    const d = await dupeCheck(env, id, "heltec", retry); if (d) return json({ sent: false, error: d, duplicate: true }, 409);
    const prevSent = ((await kvJson(env, `state:${id}`)) || {}).last_update_sent;
    if (retry && prevSent && prevSent.url) rel = { url: prevSent.url, asset_name: prevSent.asset_name, tag: prevSent.tag };
    else try { ({ rel } = await resolveTarget(env, id)); } catch (e) { return json({ sent: false, error: e.message }, 502); }
    if (rel.skipped) return json({ sent: false, error: rel.skipped }, 404);
    const risk = await heltecImageRisk(rel.url, ((await kvJson(env, `telem:${id}:latest`)) || {}).fw);
    if (risk) { await logActivity(env, id, { type: "action", msg: risk }); return json({ sent: false, error: risk, blocked: true }, 409); }
    if (!(retry && prevSent && prevSent.url)) await putJson(env, `release:${id}`, { ...rel, checked_at: new Date().toISOString() });
    const [o, c] = await manualSend(env, dev, buildUpdateBody(rel.url), `UPDATE ${retry ? "retry " : ""}${rel.asset_name}`, async (st) => {
      st.last_update_sent = { at: new Date().toISOString(), asset_name: rel.asset_name, tag: rel.tag, url: rel.url, retry };
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
    const [L, mesh, st, settings, hist, rel, trel] = await Promise.all([kvJson(env, `telem:${id}:latest`), kvJson(env, `mesh:${id}`), loadState(env, id), getSettings(env, id), kvJson(env, `telem:${id}:history`), kvJson(env, `release:${id}`), kvJson(env, `tsimrel:${id}`)]);
    const ph = computeProgress("heltec", hist || [], st || {}), pt = computeProgress("tsim", hist || [], st || {});
    const l = L || {}, m = mesh || {};
    out.push({ id, name: dev.name, last_seen: l.received_at || null, fw: l.fw || null, battery_v: l.battery_v ?? null, battery_pct: l.battery_pct ?? null,
      solar_v: l.solar_v ?? null, csq: l.csq ?? null, rsrp: l.rsrp ?? null,
      heltec_fw: m.heltec_fw || (st && st.heltec_fw) || null, node_name: m.node_name || null,
      neighbors: m.neighbors ? m.neighbors.length : null, packets: m.packets || null, radio: m.radio || null, mesh_at: m.received_at || null, mesh_test: !!m.test,
      powersaving: !!(st && st.heltec_powersaving), console_enabled: settings.console_enabled, schedule_hours: settings.schedule_hours,
      update_status: statuses(L, mesh, st || {}, hist, rel, trel),
      progress: { heltec: { state: ph.state, step: ph.step, pct: ph.pct, finished_at: ph.finished_at }, tsim: { state: pt.state, step: pt.step, pct: pt.pct, finished_at: pt.finished_at } } });
  }
  return json({ account: { kind: acc.kind, id: acc.id, name: acc.name }, devices: out });
}

// ---------- update status (installed vs last check) ----------
export function verOf(x) { const m = String(x || "").match(/v?(\d+)\.(\d+)(?:\.(\d+))?/); return m ? [+m[1], +m[2], +(m[3] || 0)] : null; }
const vcmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const vstr = (v) => "v" + v.join(".");
// installed: version string reported by the device (or null); flashed: {tag, asset_name} last successfully installed (fallback)
export function updateStatus(installed, rel, flashed = null) {
  if (!rel || rel.skipped) return { state: "unchecked", text: "Not checked yet", checked_at: null };
  const at = rel.checked_at || null, lv = verOf(rel.asset_name) || verOf(rel.tag);  // asset names are usually more specific (tag PowerSaving17.1 vs asset ...17.1.6)
  const latest = lv ? vstr(lv) : rel.asset_name;
  const iv = verOf(installed) || (flashed && (verOf(flashed.tag) || verOf(flashed.asset_name)));
  if (lv && iv) {
    const c = vcmp(lv, iv);
    return c > 0 ? { state: "available", text: `New update available: ${latest} (installed ${vstr(iv)})`, latest, installed: vstr(iv), checked_at: at }
      : { state: "current", text: `Up to date (${vstr(iv)})`, latest, installed: vstr(iv), checked_at: at };
  }
  if (flashed && flashed.asset_name && flashed.asset_name === rel.asset_name && (!flashed.tag || flashed.tag === rel.tag))
    return { state: "current", text: `Up to date (${flashed.asset_name})`, latest, installed: flashed.asset_name, checked_at: at };
  return { state: "unknown", text: `Latest: ${latest} (installed version unknown)`, latest, installed: null, checked_at: at };
}
function radioFlashed(s, hist) {
  const p = computeProgress("heltec", hist || [], s || {});
  return p.state === "done" && s && s.last_update_sent ? s.last_update_sent : null;
}
// After a flash SUCCESS the radio is "last flashed" until a mesh/CLI poll newer than the flash reports a version.
export function radioStatus(mesh, s, rel, flashedFallback = null) {
  const lf = s && s.radio_flashed;
  const meshNew = mesh && mesh.heltec_fw && mesh.received_at && lf && Date.parse(mesh.received_at) > Date.parse(lf.at);
  if (lf && !meshNew) {
    const base = updateStatus(null, rel, null);
    return { ...base, state: "flashed", text: `Last flashed: ${lf.file} (awaiting repeater confirmation)`, flashed: lf };
  }
  if (lf && meshNew) {
    const fv = verOf(lf.file), rv = verOf(mesh.heltec_fw);
    const u = updateStatus(mesh.heltec_fw, rel, null);
    if (fv && rv && vcmp(fv, rv) !== 0)
      return { ...u, state: "mismatch", text: `Version mismatch: flashed ${lf.file} but the repeater reports ${vstr(rv)}`, flashed: lf, confirmed: false };
    if (u.state === "current") return { ...u, text: `Up to date (${rv ? vstr(rv) : mesh.heltec_fw}, confirmed)`, confirmed: true, flashed: lf };
    if (u.state === "unchecked" && rv) return { ...u, state: "current", text: `Running ${vstr(rv)} (confirmed)`, confirmed: true, flashed: lf };
    return { ...u, confirmed: !!rv, flashed: lf };
  }
  const radioInst = (mesh && mesh.heltec_fw) || (s && s.heltec_fw) || null;
  return updateStatus(radioInst, rel, flashedFallback);
}
function statuses(latest, mesh, s, hist, rel, tsimRel) {
  return { tsim: updateStatus(latest && latest.fw, tsimRel), radio: radioStatus(mesh, s, rel, radioFlashed(s, hist)) };
}
// Cron: refresh release checks for GitHub sources (server-side GitHub API only; never texts a device).
const REFRESH_MS = 6 * 3600e3;
export async function refreshReleases(env, now = Date.now()) {
  const cache = new Map(), out = [];
  const get = async (src) => { const k = src.repo + "|" + src.asset_pattern + "|" + (src.tag_prefix || ""); if (!cache.has(k)) cache.set(k, latestRelease(env, src).catch((e) => ({ skipped: "error: " + e.message }))); return cache.get(k); };
  for (const id of await listDeviceIds(env)) {
    try {
      const src = await getSource(env, id), cur = await kvJson(env, `release:${id}`);
      if (src.enabled && !(cur && cur.checked_at && now - Date.parse(cur.checked_at) < REFRESH_MS)) {
        const rel = await get(src);
        if (!rel.skipped) { await putJson(env, `release:${id}`, { ...rel, checked_at: new Date(now).toISOString(), auto: true }); out.push(id + ":radio"); }
      }
      const ts = await getTsimSource(env, id), tcur = await kvJson(env, `tsimrel:${id}`);
      if (ts.mode !== "url" && !(tcur && tcur.checked_at && now - Date.parse(tcur.checked_at) < REFRESH_MS)) {
        const r = await get({ repo: ts.repo, asset_pattern: ts.asset });
        if (!r.skipped) {
          let checksum = ts.checksum || ""; if (!checksum && r.digest) { try { checksum = normChecksum(r.digest); } catch {} }
          await putJson(env, `tsimrel:${id}`, { ...r, checksum, checked_at: new Date(now).toISOString(), auto: true }); out.push(id + ":tsim");
        }
      }
    } catch (e) { out.push(id + ":error"); }
  }
  return out;
}

// Scheduled check summary for the dashboard. The cron runs at the top of every hour and sends when an
// interval (minus 10 min slack) has passed since the anchor (last run, or when the schedule was set).
export function scheduleInfo(hours, st = {}, now = Date.now()) {
  const lr = st.last_sched_run || null;
  if (!hours) return { hours: 0, last_run: lr, next_run: null };
  const due = (st.last_sched_ts || now) + hours * 3600e3 - 10 * 60e3;
  const next = Math.max(Math.ceil(due / 3600e3), Math.ceil((now + 1) / 3600e3)) * 3600e3;
  return { hours, last_run: lr, next_run: new Date(next).toISOString() };
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
    { const s2 = (await kvJson(env, `state:${id}`)) || {}; s2.last_sched_run = { at: new Date(now).toISOString(), sent: !!o.sent, error: o.error || null }; await putJson(env, `state:${id}`, s2); }
    sent.push({ id, sent: o.sent, error: o.error || null });
  }
  return sent;
}

// ---------- pages ----------
const CSS = `:root{color-scheme:light dark;--bg:#f3f5f8;--card:#fff;--fg:#1b1f24;--mut:#667085;--line:#e4e7ec;--acc:#1f6feb;--bad:#d1242f;--ok:#1a7f37;--warn:#b54708;--r:12px}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--mut:#8b949e;--line:#30363d}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 16px;background:var(--card);border-bottom:1px solid var(--line)}
header .t{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}header b{font-size:17px}
main{max-width:1040px;margin:auto;padding:14px}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:14px}.card h3{margin:0 0 8px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut)}
.kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dashed var(--line)}.kv:last-child{border:0}.kv span:first-child{color:var(--mut)}.kv span:last-child{text-align:right;word-break:break-word}
button,.btn{border:0;border-radius:10px;padding:11px 14px;font-size:15px;font-weight:500;background:var(--acc);color:#fff;cursor:pointer}button:disabled{opacity:.5;cursor:default}
button.w{background:var(--bad)}button.g{background:#57606a}button.sm{padding:6px 12px;font-size:13px}
.acts{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:12px 0}
section{margin:22px 0}h2{font-size:17px;margin:0 0 10px;display:flex;align-items:center;gap:8px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--mut);font-weight:500}
.tw{overflow-x:auto}.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:var(--ok)}
.badge.stale,.badge.failed{background:var(--bad)}.badge.run{background:var(--acc)}.badge.mut{background:#8b949e}
input,select{width:100%;padding:10px;margin:4px 0 12px;border-radius:8px;border:1px solid var(--line);font-size:16px;background:var(--card);color:var(--fg)}
label{font-size:13px;color:var(--mut)}.login{max-width:380px;margin:10vh auto}.err{color:var(--bad)}span.ok{color:var(--ok)}.mut{color:var(--mut)}.small{font-size:13px}
a{color:var(--acc)}a.dev{color:inherit;text-decoration:none;display:block}a.dev:hover{border-color:var(--acc)}a.back{text-decoration:none}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}.row input{flex:1;min-width:160px;margin:0}
details.card{margin:10px 0;padding:0}details.card>summary{cursor:pointer;padding:14px;list-style:none;display:flex;justify-content:space-between;gap:8px}
details.card>summary::after{content:"▸";color:var(--mut)}details[open].card>summary::after{content:"▾"}details.card>.in{padding:0 14px 14px}
.sens{filter:blur(5px);user-select:none;transition:filter .15s}.showsens .sens{filter:none;user-select:auto}.eye{border:0;background:none;padding:0 2px;cursor:pointer;font-size:13px;width:auto;min-width:0}
.psnote{background:#d1242f1a;border-left:3px solid var(--bad);padding:8px 10px;border-radius:6px;font-size:13px}.dim{opacity:.45}
.tog{display:flex;gap:8px;align-items:center;margin:8px 0;color:var(--fg);font-size:15px}.tog input{width:auto;margin:0}
pre.o{margin:0;max-height:160px;overflow:auto;white-space:pre-wrap;font-size:12px}code{font-size:12px}
.bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:var(--acc);transition:width .4s}
.bar.done i{background:var(--ok)}.bar.failed i{background:var(--bad)}
ol.steps{list-style:none;margin:8px 0 0;padding:0;font-size:13px}ol.steps li{display:flex;justify-content:space-between;gap:8px;padding:3px 0;color:var(--mut)}
ol.steps li.ok{color:var(--fg)}ol.steps li.ok:before{content:"✓ ";color:var(--ok)}ol.steps li.cur{color:var(--acc);font-weight:600}ol.steps li.cur:before{content:"● "}
ol.steps li.bad{color:var(--bad);font-weight:600}ol.steps li.bad:before{content:"✕ "}ol.steps li:not(.ok):not(.cur):not(.bad):before{content:"○ "}
#toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:min(560px,92vw);padding:12px 16px;border-radius:10px;color:#fff;background:#1f2328;box-shadow:0 6px 24px #0005;z-index:9;font-size:14px}
#toast.ok{background:var(--ok)}#toast.bad{background:var(--bad)}.msg{font-size:13px;margin-left:6px}.msg.bad{color:var(--bad)}.msg.ok{color:var(--ok)}
.fc .row b{font-size:16px}.mini{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.tabs{position:sticky;top:53px;z-index:4;display:flex;gap:4px;overflow-x:auto;padding:0 12px;background:var(--card);border-bottom:1px solid var(--line)}
.tabs button{background:none;color:var(--mut);border-radius:0;padding:12px 14px;border-bottom:2px solid transparent;white-space:nowrap}.tabs button.on{color:var(--acc);border-bottom-color:var(--acc)}
.pane>section:first-of-type{margin-top:14px}
@media(max-width:600px){main{padding:10px}header{padding:8px 10px}.acts{grid-template-columns:1fr 1fr}td,th{padding:6px 5px}}`;

const HEAD = (title) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>`;
const COMMON_JS = `const $=s=>document.getElementById(s);
const e=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const t=s=>s?new Date(s).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"—";
const ago=s=>{if(!s)return "never";const d=(Date.now()-new Date(s))/1000;return d<90?Math.round(d)+"s ago":d<5400?Math.round(d/60)+" min ago":d<172800?Math.round(d/3600)+" h ago":Math.round(d/86400)+" d ago"};
const kv=rows=>rows.map(([k,v])=>'<div class="kv"><span>'+e(k)+'</span><span>'+(v&&v.h!=null?v.h:e(v??"—"))+'</span></div>').join("");
const SENS_K="tsim_show_sensitive";
const sensOn=()=>{try{return localStorage.getItem(SENS_K)==="1"}catch{return false}};
function sensApply(){document.documentElement.classList.toggle("showsens",sensOn());document.querySelectorAll(".eye").forEach(b=>{b.textContent=sensOn()?"🙈":"👁";b.title=sensOn()?"Hide":"Show";b.setAttribute("aria-pressed",String(sensOn()))})}
function sensToggle(){try{localStorage.setItem(SENS_K,sensOn()?"0":"1")}catch{}sensApply()}
/* IP / ICCID / IMEI: blurred until the eye is pressed; choice remembered in localStorage */
const sens=v=>v==null||v===""?null:{h:'<span class="sens">'+e(v)+'</span> <button type="button" class="eye" onclick="sensToggle()" title="'+(sensOn()?"Hide":"Show")+'">'+(sensOn()?"🙈":"👁")+'</button>'};
document.addEventListener("DOMContentLoaded",sensApply);
const STALE_MS=26*3600e3;
const sig=c=>c==null||c<0||c==99?null:(c>=20?"Excellent":c>=15?"Good":c>=10?"OK":"Weak")+" ("+c+")";
const PSTATE={running:["Updating…","run"],done:["Updated","ok"],failed:["Update failed","failed"],timeout:["Stalled","failed"],cancelled:["Cancelled","mut"]};
function ubadge(u,label){if(!u)return"";const c=u.state==="available"||u.state==="flashed"?"run":u.state==="current"?"":u.state==="mismatch"?"failed":"mut";const w=u.state==="available"?"update available":u.state==="current"?"up to date":u.state==="flashed"?"awaiting confirmation":u.state==="mismatch"?"version mismatch":u.state==="unknown"?"version unknown":"not checked";return '<span class="badge '+c+'" title="'+e(u.text)+'">'+e(label+": "+w)+'</span>'}
function utext(u){if(!u)return null;return u.state==="available"?"⬆ "+u.text:u.state==="current"?"✓ "+u.text:u.state==="mismatch"?"⚠ "+u.text:u.state==="flashed"?"⏳ "+u.text:u.text}
function finfo(f){if(!f)return"";const r=[["Chip",f.chip],["Image",f.image],["Flash address",f.addr],["Bytes written",f.written==null?null:f.written.toLocaleString()+(f.size?" / "+f.size.toLocaleString():"")],["Verify (MD5)",f.verify?(f.verify==="OK"?"✓ OK":"✗ "+f.verify)+(f.md5?" · "+f.md5.slice(0,12)+"…":""):null]].filter(x=>x[1]!=null);return r.length?'<div class="small" style="margin-top:6px">'+r.map(x=>'<div><span class="mut">'+e(x[0])+':</span> '+e(String(x[1]))+'</div>').join("")+'</div>':""}
function pbadge(p,label){if(!p||p.state==="idle")return"";if(p.state==="done"&&p.finished_at&&Date.now()-new Date(p.finished_at)>36e5)return"";const s=PSTATE[p.state]||[p.state,"mut"];return '<span class="badge '+(s[1]==="ok"?"":s[1])+'">'+e(label+": "+s[0]+(p.state==="running"?" "+p.pct+"%":""))+'</span>'}
let toastT;function toast(msg,kind){let el=$("toast");if(!el){el=document.createElement("div");el.id="toast";document.body.appendChild(el)}el.className=kind||"";el.textContent=msg;el.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>el.hidden=true,kind==="bad"?9000:6000)}
function friendly(j,status){const x=String((j&&(j.error||(j.hologram_response_summary||{}).error))||"");
 if(status===401)return"Your login has expired. Please log in again.";
 if(/rate limited/.test(x))return"Please wait a minute between texts to the same T-SIM ("+(x.match(/\\d+s/)||["a few s"])[0]+" left).";
 if(/^Blocked for safety/.test(x))return x;
 if(/Hologram|HOLOGRAM/.test(x))return"The text couldn't be sent: the SMS service (Hologram) rejected it. Check the Hologram API key and the SIM's status.";
 if(/hologram_device_id/.test(x))return"This T-SIM has no SIM device id set up, so it can't be texted.";
 if(/GitHub|no upgrade asset|not found/.test(x))return"Couldn't find a firmware file at the update source. Check the repo and file name in Settings.";
 if(/disabled/.test(x))return"No update source is set. Choose one under LoRa radio › Settings › Firmware update source.";
 if(/bad origin/.test(x))return"Security check failed. Reload the page and try again.";
 if(/power saving/.test(x))return"The repeater is in power saving, so its console isn't available right now.";
 if(status>=500||!x)return"Something went wrong. Please try again in a minute.";return x}`;

export function loginPage(id = "", err = "") {
  return `${HEAD("Mesh dashboard login")}
<body><main class="login card"><h2>Mesh repeater dashboard</h2>${err ? `<p class="err">${esc(err)}</p>` : ""}
<form method="post" action="/login"><label>Device id or fleet login<input name="device" value="${esc(id)}" autocomplete="username" required autocapitalize="none"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label><button style="width:100%">Log in</button></form></main></body></html>`;
}

export function fleetPage(acc) {
  return `${HEAD("Repeaters")}
<body><header><div class="t"><b>Repeaters</b> <span class="mut small">${esc(acc.name || acc.id)}</span></div>
<form method="post" action="/logout"><button class="g sm">Log out</button></form></header>
<main><p class="mut" id="sum">Loading…</p><div class="grid" id="fleet"></div>
<p class="mut small">Readings update when a T-SIM wakes (Request status, a console command, or an optional scheduled check). "Stale" means nothing was heard for 26 hours.</p></main>
<script>${COMMON_JS}
let busy=false;
async function load(){
 const r=await fetch("/api/fleet",{credentials:"same-origin"});if(r.status===401){location.href="/";return}
 const d=await r.json(),L=d.devices||[];let on=0;busy=false;
 $("fleet").innerHTML=L.map(x=>{const fresh=x.last_seen&&Date.now()-new Date(x.last_seen)<STALE_MS;if(fresh)on++;
  const P=x.progress||{};if((P.heltec||{}).state==="running"||(P.tsim||{}).state==="running")busy=true;
  return '<a class="card dev fc" href="/d/'+encodeURIComponent(x.id)+'"><div class="row"><b>'+e(x.name)+'</b><span class="badge'+(fresh?'':' stale')+'">'+(fresh?'Online':'Stale')+'</span></div>'+
  '<div class="small mut">'+e(x.id)+(x.node_name?' · '+e(x.node_name):'')+'</div>'+
  '<div class="mini">'+pbadge(P.heltec,"Heltec")+pbadge(P.tsim,"T-SIM")+ubadge((x.update_status||{}).radio,"Radio fw")+ubadge((x.update_status||{}).tsim,"T-SIM fw")+(x.powersaving?'<span class="badge mut">Power saving</span>':'')+'</div>'+
  kv([["Last seen",ago(x.last_seen)],["Battery",x.battery_v==null?null:x.battery_v.toFixed(2)+" V ("+x.battery_pct+"%)"],["Signal",sig(x.csq)],
   ["Heltec firmware",x.heltec_fw],["Neighbors",x.neighbors]])+
  (x.mesh_test?'<small class="err">Mesh data is test data</small>':'')+'</a>'}).join("")||'<p>No repeaters on this login.</p>';
 $("sum").textContent=L.length+" repeater"+(L.length==1?"":"s")+" · "+on+" heard in the last 26 h";
 clearTimeout(window._t);window._t=setTimeout(load,busy?5000:30000);
}
load();
</script></body></html>`;
}

const PS_HTML = `Repeater stats can still be retrieved over the mesh using MeshCore remote admin (e.g. from the MeshCore app). T-SIM stats (signal, battery, solar, modem) are still available here via Request status.`;

export function dashboardPage(dev, acc = { kind: "d" }) {
  return `${HEAD(dev.name)}
<body><header><div class="t">${acc.kind === "a" ? '<a href="/fleet" class="back">‹ All</a>' : ""}<b>${esc(dev.name)}</b><span class="mut small">${esc(dev.id)}</span><span id="seen" class="badge">…</span></div>
<form method="post" action="/logout"><button class="g sm">Log out</button></form></header>
<nav class="tabs" id="tabs"><button type="button" data-t="ov">Overview</button><button type="button" data-t="radio">LoRa radio</button><button type="button" data-t="tsim">T-SIM</button><button type="button" data-t="act">Activity</button></nav>
<main>
<div class="pane" id="t-ov">
<div class="acts">
<button data-a="status" data-c="Text the T-SIM to wake it? It reads the repeater and reports here within about 2 minutes.">Request status</button>
<button data-a="check" data-c="" class="g">Check for updates</button>
</div>
<div class="mini" id="ov-prog"></div>
<div class="grid" style="margin-top:12px">
<div class="card"><h3>LoRa radio</h3><div id="ov-radio"></div><p class="small"><a href="#radio">Open LoRa radio ›</a></p></div>
<div class="card"><h3>T-SIM</h3><div id="ov-tsim"></div><p class="small"><a href="#tsim">Open T-SIM ›</a></p></div>
</div>
<p class="small mut">One text per minute per T-SIM. After a text, the T-SIM wakes and reports here within a few minutes.</p>
</div>

<div class="pane" id="t-radio" hidden>
<div class="acts">
<button data-a="update-latest" class="w" data-c="Update the LoRa radio (repeater) to the latest firmware? It will be reflashed and restart.">Update radio firmware</button>
<button data-a="reboot" class="g" data-c="Restart the LoRa radio (repeater)?">Reboot radio</button>
<button data-a="check" data-c="" class="g">Check for updates</button>
</div>
<section><h2>Firmware</h2><div class="card"><div id="c-upd"></div><div id="p-heltec"></div></div></section>
<section><h2>Mesh <small class="mut small" id="meshat"></small></h2>
<p class="psnote" id="meshps" hidden>Mesh polling is paused: the repeater is in power saving and its serial CLI isn't answering. Showing the last snapshot taken while it was awake. It resumes automatically when a status check gets a CLI reply. ${PS_HTML}</p>
<div class="grid" id="meshgrid">
<div class="card"><h3>Repeater</h3><div id="m-node"></div></div>
<div class="card"><h3>Radio</h3><div id="m-radio"></div></div>
<div class="card"><h3>Packets</h3><div id="m-pkt"></div></div>
</div>
<div class="card tw" style="margin-top:12px"><h3>Neighbors</h3><table id="nbt"><thead><tr><th>Node</th><th>SNR</th><th>Last heard</th></tr></thead><tbody id="nb"></tbody></table></div></section>
<section><h2>Settings</h2>
<details class="card" id="srcbox"><summary><b>Firmware update source</b><small id="srcsum" class="mut"></small></summary><div class="in">
<label>Firmware preset<select id="preset"><option value="">Custom…</option></select></label>
<p class="small mut" id="presetnote"></p>
<form id="srcf">
<label class="tog"><input type="checkbox" name="enabled"> Use the latest GitHub release</label>
<label>GitHub repo (owner/name)<input name="repo" placeholder="IoTThinks/EasySkyMesh"></label>
<label>Release tag starts with (optional, e.g. repeater-)<input name="tag_prefix" placeholder="repeater-"></label>
<label>File name pattern (* = anything; -merged files skipped unless named)<input name="asset_pattern" placeholder="Heltec_v3_repeater-*-upgrade.bin"></label>
<label>Direct link (optional override, used when GitHub is off)<input name="direct_url" placeholder="https://..."></label>
<button type="submit">Save</button><span id="srcmsg" class="msg"></span></form></div></details>
<details class="card" id="lbbox"><summary><b>Low-battery protection</b><small id="lbsum" class="mut"></small></summary><div class="in">
<p class="small mut">The T-SIM checks its (calibrated, idle) battery on a timer without starting LTE. Below the OFF level it sends <code>set repeat off</code> to the repeater; when the battery recovers to the ON level it sends <code>set repeat on</code>. The ON level must be at least 10% higher than OFF. Settings reach the T-SIM at its next wake and are kept on the T-SIM, so it works offline. Needs T-SIM firmware 1.6.5+ and repeater firmware with the MeshCore CLI (no power saving).</p>
<div id="lbinfo"></div><div id="lbdel" class="small"></div>
<form id="lbf"><label class="tog"><input type="checkbox" name="en"> Enable low-battery protection</label>
<label>Turn repeat OFF below (V) <small class="mut" id="lbopct"></small><input name="lo" type="number" step="0.01" min="3" max="4"></label>
<label>Turn repeat ON at/above (V) <small class="mut" id="lbhpct"></small><input name="hi" type="number" step="0.01" min="3.3" max="4.3"></label>
<label>Check the battery every (hours) <small class="mut" id="lbih"></small><input name="inth" type="number" step="0.25" min="0.25" max="24"></label>
<label class="tog"><input type="checkbox" name="imm"> Report changes immediately (starts LTE; uses more power)</label>
<button type="submit">Save &amp; send now</button> <button type="button" class="g" id="lbsave2">Save without sending</button><span id="lbmsg" class="msg"></span>
<p class="small mut">"Save &amp; send now" texts the T-SIM once so it wakes and applies the settings within a few minutes. "Save without sending" waits for its next wake (useful to batch several changes).</p></form></div></details>
<details class="card" id="conbox"><summary><b>Repeater console</b><small id="consum" class="mut"></small></summary><div class="in">
<label class="tog"><input type="checkbox" id="conon"> Allow console commands for this repeater</label>
<p class="small mut">Commands run on the repeater's MeshCore command line the next time the T-SIM wakes. "Queue &amp; wake" texts the T-SIM so they run within a few minutes. Examples: <code>ver</code> <code>neighbors</code> <code>stats-packets</code> <code>get name</code> <code>clock</code></p>
<p class="psnote" id="conps" hidden>The console is unavailable while the repeater is in power saving. It comes back after <code>powersaving off</code> or any successful reply, e.g. after Request status. ${PS_HTML}</p>
<div id="conui"><form id="conf" class="row"><input id="cmd" maxlength="120" placeholder="MeshCore CLI command" autocapitalize="none" autocomplete="off">
<button type="submit" class="g">Queue</button><button type="button" id="qwake">Queue &amp; wake</button></form>
<div class="row small" style="margin:8px 0"><span id="conmsg" class="msg"></span><span><button type="button" id="wake" class="g sm">Wake to run queued</button> <button type="button" id="cancel" class="g sm">Cancel queued</button></span></div>
<div class="tw"><table><thead><tr><th>Command</th><th>Status</th><th>Reply</th></tr></thead><tbody id="cmds"></tbody></table></div></div></div></details>
</section>
</div>

<div class="pane" id="t-tsim" hidden>
<div class="acts">
<button data-a="status" data-c="Text the T-SIM to wake it? It reads the repeater and reports here within about 2 minutes.">Request status</button>
<button data-a="tsim-update" class="w" data-c="Update the T-SIM's own firmware? It downloads, installs and restarts. If the new firmware can't check in, it rolls back automatically.">Update T-SIM firmware</button>
<button data-a="check" data-c="" class="g">Check for updates</button>
</div>
<section><h2>Firmware</h2><div class="card"><div id="c-tsimfw"></div><div id="p-tsim"></div></div></section>
<section><h2>Telemetry</h2><div class="grid">
<div class="card"><h3>Device</h3><div id="c-tsim"></div></div>
<div class="card"><h3>Power</h3><div id="c-power"></div></div>
<div class="card"><h3>Cellular</h3><div id="c-cell"></div></div>
</div></section>
<section><h2>Settings</h2>
<details class="card" id="calbox"><summary><b>Battery calibration</b><small id="calsum" class="mut"></small></summary><div class="in">
<p class="small mut">The T-SIM reads the battery at the start of each wake, before the modem is used (idle). Measure the battery with a multimeter while the T-SIM is idle and enter the value; the factor is worked out from the latest idle reading. Settings reach the T-SIM at its next wake (no extra text). The Heltec's own reading is not changed.</p>
<div id="calinfo"></div>
<form id="calf"><label>Measured battery voltage (V)<input name="mv" type="number" step="0.01" min="2.8" max="4.5" placeholder="4.07"></label>
<button type="submit">Calibrate &amp; send now</button> <button type="button" class="g" id="calsave2">Calibrate without sending</button></form>
<form id="calm"><label>Scale factor<input name="scale" type="number" step="0.0001" min="0.5" max="1.5"></label><label>Offset (V)<input name="off" type="number" step="0.001" min="-0.5" max="0.5"></label>
<button type="submit" class="g">Save manual values &amp; send</button> <button type="button" class="g" id="calreset">Reset calibration</button></form>
<span id="calmsg" class="msg"></span><div id="caldel" class="small"></div></div></details>
<details class="card" id="tsimbox"><summary><b>T-SIM firmware source</b><small id="tsimsum" class="mut"></small></summary><div class="in">
<p class="small mut">Needs T-SIM firmware 1.6.0 or newer. The T-SIM downloads the file, checks it, installs it in its spare slot and restarts. If the new firmware can't check in, it rolls back on its own.</p>
<form id="tsimf">
<label>Source<select name="mode"><option value="github">Latest GitHub release</option><option value="url">Direct link</option></select></label>
<label>GitHub repo (owner/name)<input name="repo" placeholder="just-stuff-tm/tsim-remote-updater"></label>
<label>Release file name<input name="asset" placeholder="firmware.bin"></label>
<label>Direct link<input name="url" placeholder="https://.../firmware.bin"></label>
<label>Checksum (optional; GitHub's own checksum is used if empty)<input name="checksum" placeholder="sha256:..."></label>
<button type="submit">Save</button><span id="tsimmsg" class="msg"></span></form></div></details>
<details class="card" id="schbox"><summary><b>Automatic status check</b><small id="schsum" class="mut"></small></summary><div class="in">
<p class="small">When this is on, the dashboard automatically wakes the T-SIM every few hours, so the battery, signal and mesh stats here stay fresh without you pressing <b>Request status</b>.</p>
<p class="small mut">Cost: each check sends <b>one text</b> to the T-SIM (counts toward your SIM plan) and keeps it awake for a minute or two with LTE on (uses some battery). Nothing is sent while this is off.</p>
<div id="schinfo"></div>
<label class="tog"><input type="checkbox" id="schon"> Check automatically</label>
<label>How often<select id="sch"><option value="6">Every 6 hours</option><option value="12">Every 12 hours</option><option value="24">Once a day</option><option value="168">Once a week</option></select></label>
<button id="schsave">Save</button><span id="schmsg" class="msg"></span></div></details>
<details class="card"><summary><b>Login &amp; password</b><small class="mut">dashboard access</small></summary><div class="in">
<p class="small mut">Each T-SIM has its own dashboard password; fleet logins open several. Passwords are changed by the owner with the admin API (<code>/admin/devices/&lt;id&gt;/reset-password</code>), see docs/SETUP.md. The T-SIM's upload key is separate and never shown here.</p></div></details>
</section>
</div>

<div class="pane" id="t-act" hidden>
<div class="card tw"><table><thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead><tbody id="log"></tbody></table></div>
</div>
</main><div id="toast" hidden></div>
<script>${COMMON_JS}
const ID=${JSON.stringify(dev.id)},API="/api/d/"+encodeURIComponent(ID)+"/";
const WAKE={0:"Power-on / reset",2:"Text message",4:"Timer",7:"USB / other"};
const up=s=>s==null?null:(s>=86400?Math.floor(s/86400)+"d ":"")+(s>=3600?Math.floor(s%86400/3600)+"h ":"")+Math.floor(s%3600/60)+"m";
const post=(a,b)=>fetch(API+a,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:b===undefined?undefined:JSON.stringify(b)});
const rj=async r=>{try{return await r.json()}catch{return{}}};
const say=(id,ok,msg)=>{const el=$(id);el.className="msg "+(ok?"ok":"bad");el.textContent=msg};
let first=true,pending={},PRE={};
function prog(p,label,pend){
 if(pend&&(!p||p.state==="idle"||(p.started_at&&new Date(p.started_at)<pend)))p={state:"running",step:0,pct:0,steps:["Waiting for T-SIM to wake","Downloading","Verifying","Writing / flashing","Rebooting","Done"],times:{0:pend.toISOString()}};
 if(!p||p.state==="idle")return '<p class="small mut">No update in progress.</p>';
 if(p.state==="cancelled")return '<div style="margin-top:10px"><div class="row"><b class="small">Update cancelled '+e(t(p.finished_at)||"")+'</b><span class="badge mut">Cancelled</span></div><p class="small mut">'+e(p.reason||"")+'</p></div>';
 const fail=p.state==="failed"||p.state==="timeout",cls=p.state==="done"?"done":fail?"failed":"";
 const head=p.state==="done"?"Update finished "+t(p.finished_at):p.state==="running"?"Update in progress":p.state==="timeout"?"Update stalled":"Update failed "+t(p.finished_at);
 const rows=p.steps.map((s,i)=>{let c="";if(p.state==="done"||i<p.step)c="ok";else if(i===p.step)c=fail?"bad":"cur";
  if(i===5&&fail)return '<li class="bad"><span>Failed</span><span>'+e(t(p.finished_at)||"")+'</span></li>';
  return '<li class="'+c+'"><span>'+e(s)+'</span><span>'+(p.times&&p.times[i]?e(t(p.times[i])):"")+'</span></li>'}).join("");
 return '<div style="margin-top:10px"><div class="row"><b class="small">'+e(head)+'</b><span class="badge '+(cls==="done"?"":cls==="failed"?"failed":"run")+'">'+(p.state==="done"?"Done":p.state==="timeout"?"Stalled":fail?"Failed":p.pct+"%")+'</span></div>'+
  '<div class="bar '+cls+'"><i style="width:'+(fail?Math.max(p.pct,8):p.pct)+'%"></i></div>'+(p.target?'<div class="small mut">File: '+e(p.target)+'</div>':'')+(p.resolved?'<div class="small mut">Confirmed: '+e(p.resolved)+'</div>':'')+finfo(p.flash)+
  (p.reason?'<p class="small err">'+e(p.reason)+'</p>':'')+(p.state==="running"||p.state==="timeout"?'<ol class="steps">'+rows+'</ol>':'<details class="small" data-k="'+e(label)+'" ontoggle="DS[this.dataset.k]=this.open"'+(DS[label]?' open':'')+'><summary>Show steps</summary><ol class="steps">'+rows+'</ol></details>')+'</div>'}
var DS={};
async function load(){
 const r=await fetch(API+"telemetry",{credentials:"same-origin"});
 if(r.status===401){location.href="/";return}
 const d=await r.json(),L=d.latest||{},U=d.updates||{},M=d.mesh||{},S=d.settings||{},PG=d.progress||{};if(d.source)showSource(d.source);if(d.power)showPower(d);if(d.presets&&!Object.keys(PRE).length)setPresets(d.presets);
 const seen=L.received_at?new Date(L.received_at):null,stale=!seen||Date.now()-seen>STALE_MS;
 $("seen").textContent=seen?(stale?"Stale · ":"Online · ")+ago(L.received_at):"Never seen";$("seen").className="badge"+(stale?" stale":"");
 $("c-tsim").innerHTML=kv([["Firmware",L.fw],["Last report",t(L.received_at)],["Woke by",L.wake==null?null:(WAKE[L.wake]||L.wake)],["Uptime",L.uptime==null?null:up(L.uptime)]]);
 $("c-power").innerHTML=kv([["Battery (idle)",L.battery_v==null?null:L.battery_v.toFixed(2)+" V ("+L.battery_pct+"%)"],["Battery (LTE on)",L.battery_load_v==null?null:L.battery_load_v.toFixed(2)+" V"],["Solar",L.solar_v==null?null:L.solar_v.toFixed(2)+" V"],["Free memory",L.heap==null?null:Math.round(L.heap/1024)+" KB"],["Storage free",L.fs_free==null?null:Math.round(L.fs_free/1024)+" KB"]]);
 $("c-cell").innerHTML=kv([["Signal",sig(L.csq)],["RSRP / RSRQ",L.rsrp==null?null:L.rsrp+" / "+L.rsrq],["Network",L.operator],["IP",sens(L.ip)],...(L.iccid?[["ICCID",sens(L.iccid)]]:[]),...(L.imei?[["IMEI",sens(L.imei)]]:[])]);sensApply();
 const la=U.latest_available,TS=d.tsim||{},tla=TS.latest_available;
 const US=d.update_status||{};
 $("c-upd").innerHTML=kv([["Status",utext(US.radio)],["Running",M.heltec_fw||U.heltec_fw],["Latest available",la?la.asset_name:"press Check for updates"],["Checked",la&&t(la.checked_at)],["Last flashed",US.radio&&US.radio.flashed?US.radio.flashed.file+" · "+t(US.radio.flashed.at):null]])+(US.radio&&US.radio.flashed?finfo(US.radio.flashed.flash):"");
 $("c-tsimfw").innerHTML=kv([["Status",utext(US.tsim)],["Running",TS.fw||L.fw],["Latest available",tla?tla.asset_name+(tla.tag&&tla.tag!=="url"?" ("+tla.tag+")":""):"press Check for updates"]]);
 for(const k of ["heltec","tsim"]){const p=PG[k];if(pending[k]&&p&&p.started_at&&new Date(p.started_at)>=pending[k]-5000)delete pending[k];if(pending[k]&&Date.now()-pending[k]>15*60e3)delete pending[k];}
 $("p-heltec").innerHTML=prog(PG.heltec,"Heltec",pending.heltec);$("p-tsim").innerHTML=prog(PG.tsim,"T-SIM",pending.tsim);
 const busy=["heltec","tsim"].some(k=>pending[k]||(PG[k]||{}).state==="running");
 setUpd("update-latest","heltec",PG.heltec,pending.heltec);setUpd("tsim-update","tsim",PG.tsim,pending.tsim);
 const C=M.core||{},R=M.radio||{},P=M.packets||{};
 $("meshat").textContent=M.received_at?"· snapshot "+ago(M.received_at)+(M.test?" · TEST DATA":""):"· no snapshot yet (press Request status)";
 $("m-node").innerHTML=kv([["Name",M.node_name],["Firmware",M.heltec_fw],["Clock",M.clock],["Battery",C.battery_mv==null?null:(C.battery_mv/1000).toFixed(2)+" V"],["Uptime",up(C.uptime_secs)],["Queue / errors",C.queue_len==null?null:C.queue_len+" / "+C.errors]]);
 $("m-radio").innerHTML=kv([["Noise floor",R.noise_floor==null?null:R.noise_floor+" dBm"],["Last RSSI",R.last_rssi==null?null:R.last_rssi+" dBm"],["Last SNR",R.last_snr==null?null:R.last_snr+" dB"],["TX airtime",up(R.tx_air_secs)],["RX airtime",up(R.rx_air_secs)]]);
 $("m-pkt").innerHTML=kv([["Received",P.recv],["Sent",P.sent],["Flood tx / rx",P.flood_tx==null?null:P.flood_tx+" / "+P.flood_rx],["Direct tx / rx",P.direct_tx==null?null:P.direct_tx+" / "+P.direct_rx],["RX errors",P.recv_errors]]);
 const N=M.neighbors;$("nb").innerHTML=N==null?'<tr><td colspan=3 class="mut">No data yet</td></tr>':(N.length?N.map(n=>'<tr><td><code>'+e(n.id)+'</code></td><td>'+e(n.snr)+' dB</td><td>'+e(ago(n.heard_at))+'</td></tr>').join(""):'<tr><td colspan=3 class="mut">No neighbors heard</td></tr>');
 if(M.error)$("nb").innerHTML+='<tr><td colspan=3 class="err">'+e(M.error)+'</td></tr>';
 const sc=d.schedule||{};const HL={6:"every 6 hours",12:"every 12 hours",24:"once a day",168:"once a week"},lr=sc.last_run;
 $("schsum").textContent=S.schedule_hours?"On · "+(HL[S.schedule_hours]||"every "+S.schedule_hours+" h")+" · next "+t(sc.next_run)+" ET":"Off";
 $("schinfo").innerHTML=kv([["Status",S.schedule_hours?"On: wakes the T-SIM "+(HL[S.schedule_hours]||"every "+S.schedule_hours+" h"):"Off: the T-SIM only wakes when you press a button"],["Next check",S.schedule_hours?t(sc.next_run)+" ET":null],["Last automatic check",lr?t(lr.at)+" ET"+(lr.sent?" (text sent)":" (not sent: "+(lr.error||"error")+")"):"none yet"]]);
 $("consum").textContent=S.console_enabled?"on":"off";
 if(first){$("schon").checked=!!S.schedule_hours;$("sch").value=String(S.schedule_hours||24);$("sch").disabled=!S.schedule_hours;$("conon").checked=!!S.console_enabled;first=false}
 const PS=!!(d.powersaving&&d.powersaving.on);
 $("ov-prog").innerHTML=pbadge(PG.heltec,"Radio update")+pbadge(PG.tsim,"T-SIM update")+ubadge(US.radio,"Radio fw")+ubadge(US.tsim,"T-SIM fw")+(PS?'<span class="badge mut">Power saving</span>':(d.powersaving&&d.powersaving.unknown?'<span class="badge mut" title="'+e(d.powersaving.source||"")+'">Power saving: unknown</span>':''));
 $("ov-radio").innerHTML=kv([["Node",M.node_name],["Firmware",M.heltec_fw||U.heltec_fw],["Updates",utext(US.radio)],["Neighbors",M.neighbors==null?null:M.neighbors.length],["Mesh snapshot",M.received_at?ago(M.received_at):"none yet"]]);
 $("ov-tsim").innerHTML=kv([["Firmware",TS.fw||L.fw],["Updates",utext(US.tsim)],["Last report",ago(L.received_at)],["Battery",L.battery_v==null?null:L.battery_v.toFixed(2)+" V ("+L.battery_pct+"%)"],["Signal",sig(L.csq)]]);
 $("meshps").hidden=!PS;$("meshgrid").classList.toggle("dim",PS);$("nbt").classList.toggle("dim",PS);
 $("conps").hidden=!(PS&&S.console_enabled);$("conui").hidden=!S.console_enabled||PS;
 if(PS)$("consum").textContent="paused (power saving)";
 const CM=(d.commands||[]).filter(c=>!c.sys&&!c.unsolicited);$("cmds").innerHTML=CM.length?CM.map(c=>'<tr><td><code>'+e(c.sys?"T-SIM update":c.cmd)+'</code><br><small class="mut">'+e(t(c.done_at||c.sent_at||c.queued_at))+'</small></td><td>'+e(c.status)+'</td><td><pre class="o">'+e(c.output||c.error||"")+'</pre></td></tr>').join(""):'<tr><td colspan=3 class="mut">No commands yet</td></tr>';
 $("log").innerHTML=(d.history||[]).map(h=>'<tr><td>'+e(t(h.received_at))+'</td><td>'+e(h.type)+(h.test?' <b class="err">TEST</b>':'')+'</td><td>'+e(h.msg||(h.type==="status"?"Status report":""))+'</td></tr>').join("")||'<tr><td colspan=3 class="mut">No activity yet</td></tr>';
 clearTimeout(window._t);window._t=setTimeout(load,busy?5000:30000);
}
function setPresets(p){PRE=p;const s=$("preset");for(const[k,v]of Object.entries(p)){const o=document.createElement("option");o.value=k;o.textContent=v.label;s.appendChild(o)}}
$("preset").onchange=ev=>{const v=PRE[ev.target.value],f=$("srcf");if(!v){$("presetnote").textContent="";return}
 f.enabled.checked=v.enabled;f.repo.value=v.repo;f.asset_pattern.value=v.asset_pattern;f.tag_prefix.value=v.tag_prefix||"";f.direct_url.value=v.direct_url;
 $("presetnote").textContent=ev.target.value==="meshcore"?"Stock MeshCore from meshcore-dev/MeshCore (app-only image, keeps identity and settings). It follows the newest release tagged repeater-* (MeshCore also publishes companion and room-server releases). Press Save to use it.":"Press Save to use it."};
let tsimLoaded=false;
function showTsim(s){const f=$("tsimf");$("tsimsum").textContent=s.mode==="url"?"direct link":s.repo+" · "+s.asset;
 if(!tsimLoaded){f.mode.value=s.mode;f.repo.value=s.repo||"";f.asset.value=s.asset||"";f.url.value=s.url||"";f.checksum.value=s.checksum||"";tsimLoaded=true}}
$("tsimf").onsubmit=async ev=>{ev.preventDefault();const f=ev.target;
 const r=await post("tsim-source",{mode:f.mode.value,repo:f.repo.value,asset:f.asset.value,url:f.url.value,checksum:f.checksum.value});
 const j=await rj(r);say("tsimmsg",r.ok,r.ok?"Saved":friendly(j,r.status));if(r.ok){tsimLoaded=false;showTsim(j.source);load();}};
let srcLoaded=false;
function showSource(s){const f=$("srcf");$("srcsum").textContent=s.enabled?s.repo+" · "+(s.tag_prefix?s.tag_prefix+"* · ":"")+s.asset_pattern:(s.direct_url?"direct link":"not set");
 const off=!s.enabled&&!s.direct_url;document.querySelectorAll('button[data-a="update-latest"]').forEach(b=>{b.disabled=off;b.title=off?"Set an update source first":""});
 if(!srcLoaded){f.enabled.checked=!!s.enabled;f.repo.value=s.repo||"";f.asset_pattern.value=s.asset_pattern||"";f.tag_prefix.value=s.tag_prefix||"";f.direct_url.value=s.direct_url||"";srcLoaded=true;}}
$("srcf").onsubmit=async ev=>{ev.preventDefault();const f=ev.target;
 const r=await post("source",{enabled:f.enabled.checked,repo:f.repo.value,asset_pattern:f.asset_pattern.value,tag_prefix:f.tag_prefix.value,direct_url:f.direct_url.value});
 const j=await rj(r);say("srcmsg",r.ok,r.ok?"Saved":friendly(j,r.status));if(r.ok){srcLoaded=false;showSource(j.source);load();}};
function bpct(v){v=+v;if(!isFinite(v)||!v)return"";return "≈"+(v>=4.15?100:v<=3.3?0:Math.round((v-3.3)*100/0.85))+"%"}
let pwrLoaded=false,PWR={};
function showPower(d){const P=d.power||{},S=P.settings||{},L=d.latest||{},E=P.event;PWR=S;
 const W=P.wake,del=S.applied_at?'<span class="ok">✓ Applied on T-SIM at '+e(t(S.applied_at))+' ET</span>':P.pending?(W&&W.sent?"⏳ Sent "+e(t(W.at))+" ET — waiting for the T-SIM to wake and apply it":W&&W.error?'<span class="err">Not sent: '+e(W.error)+'</span> Saved; it will be applied at the next wake.':"Saved — will be applied at the T-SIM's next wake (no text sent)"):"";
 $("caldel").innerHTML=del;$("lbdel").innerHTML=del;
 const pend=P.pending?(W&&W.sent?" · sent, waiting for T-SIM":" · waiting for next wake"):"";
 $("calsum").textContent=(S.cal_scale!==1||S.cal_off?"x"+S.cal_scale+(S.cal_off?" "+(S.cal_off>0?"+":"")+S.cal_off+" V":""):"not calibrated")+pend;
 $("calinfo").innerHTML=kv([["Idle raw reading",L.battery_raw_v==null?"none yet (needs 1.6.5)":L.battery_raw_v.toFixed(3)+" V · "+t(L.received_at)],["T-SIM is using",L.cal_scale==null?null:"x"+L.cal_scale+" "+(L.cal_off>=0?"+":"")+L.cal_off+" V"],["Saved here",S.applied_at?"applied "+t(S.applied_at):S.updated_at?"saved "+t(S.updated_at)+", not applied yet":"defaults"]]);
 const st=L.lb_state==null?null:(L.lb_state?"Repeat OFF (battery protection)":"Repeat ON (normal)");
 $("lbsum").textContent=(S.lb_en?"on · OFF<"+S.lb_lo.toFixed(2)+" V, ON≥"+S.lb_hi.toFixed(2)+" V · checks battery every "+hrs(S.lb_int):"off")+pend;
 $("lbinfo").innerHTML=kv([["State on T-SIM",st?st+(L.lb_en===false?" · protection disabled on T-SIM":""):"not reported yet"],["Battery (idle)",L.battery_v==null?null:L.battery_v.toFixed(2)+" V "+bpct(L.battery_v)],["Last action",E?E.msg+" · "+t(E.at):"none"],["T-SIM thresholds",L.lb_lo==null?null:"OFF<"+L.lb_lo.toFixed(2)+" / ON≥"+L.lb_hi.toFixed(2)+" V · checks battery every "+hrs(L.lb_int)]]);
 if(!pwrLoaded){const f=$("lbf");f.en.checked=!!S.lb_en;f.lo.value=S.lb_lo.toFixed(2);f.hi.value=S.lb_hi.toFixed(2);f.inth.value=+(S.lb_int/60).toFixed(2);f.imm.checked=!!S.lb_imm;
  const m=$("calm");m.scale.value=S.cal_scale;m.off.value=S.cal_off;lbPct();pwrLoaded=true}}
function hrs(m){const h=m/60;return (h===1?"1 hour":(+h.toFixed(2))+" h")+(m<60?" ("+m+" min)":"")}
function lbPct(){const f=$("lbf");$("lbopct").textContent=bpct(f.lo.value);$("lbhpct").textContent=bpct(f.hi.value);const h=+f.inth.value;$("lbih").textContent=h>=0.25&&h<=24?"Checks battery every "+hrs(Math.round(h*60)):"0.25–24 h"}
$("lbf").oninput=lbPct;
async function savePwr(b,msg,send){if(send&&!confirm("Save and send ONE text now so the T-SIM wakes and applies these settings?"))return;
 const r=await post("power",{...b,send:!!send});const j=await rj(r);
 const m=!r.ok?(j.error||friendly(j,r.status)):j.unchanged?"No change: the T-SIM already uses these settings.":j.wake?(j.wake.sent?"Saved and sent — waiting for the T-SIM to wake.":"Saved. "+(j.wake.error||"Text not sent.")):"Saved. It will be applied at the T-SIM's next wake (no text sent).";
 say(msg,r.ok&&!(j.wake&&!j.wake.sent&&!j.wake.already),m);if(r.ok){pwrLoaded=false;load()}}
function lbBody(){const f=$("lbf"),lo=+f.lo.value,hi=+f.hi.value,h=+f.inth.value;
 if(!(hi>=lo*1.1-0.005)){say("lbmsg",false,"ON must be at least 10% higher than OFF: with OFF at "+lo.toFixed(2)+" V, ON must be "+(Math.ceil(lo*110)/100).toFixed(2)+" V or more.");return null}
 if(!(h>=0.25&&h<=24)){say("lbmsg",false,"Check interval must be between 0.25 and 24 hours.");return null}
 return {lb_en:f.en.checked,lb_lo:lo,lb_hi:hi,lb_int_h:h,lb_imm:f.imm.checked}}
$("lbf").onsubmit=ev=>{ev.preventDefault();const b=lbBody();if(b)savePwr(b,"lbmsg",true)};
$("lbsave2").onclick=()=>{const b=lbBody();if(b)savePwr(b,"lbmsg",false)};
$("calf").onsubmit=ev=>{ev.preventDefault();savePwr({measured_v:+ev.target.mv.value},"calmsg",true)};
$("calsave2").onclick=()=>savePwr({measured_v:+$("calf").mv.value},"calmsg",false);
$("calm").onsubmit=ev=>{ev.preventDefault();savePwr({cal_scale:+ev.target.scale.value,cal_off:+ev.target.off.value},"calmsg",true)};
$("calreset").onclick=()=>{if(confirm("Reset the T-SIM battery calibration to factory (x1, +0 V)? This also sends one text so it applies now."))savePwr({reset_cal:true},"calmsg",true)};
$("schon").onchange=()=>{$("sch").disabled=!$("schon").checked};
$("schsave").onclick=async()=>{const h=$("schon").checked?+$("sch").value:0;
 if(h&&!confirm("Wake the T-SIM automatically "+$("sch").selectedOptions[0].textContent.toLowerCase()+"? Each check sends one text and uses some battery."))return;
 const r=await post("settings",{schedule_hours:h});const j=await rj(r);say("schmsg",r.ok,r.ok?"Saved":friendly(j,r.status));load();};
$("conon").onchange=async ev=>{const on=ev.target.checked;
 if(on&&!confirm("Allow console commands for this repeater? Anyone with this login can then run MeshCore CLI commands on it."))return void(ev.target.checked=false);
 const r=await post("settings",{console_enabled:on});if(!r.ok){ev.target.checked=!on;toast(friendly(await rj(r),r.status),"bad")}else toast("Console "+(on?"on":"off"),"ok");load();};
async function queue(wake,force){const c=$("cmd").value.trim();if(!c)return;
 if(wake&&!confirm("Queue '"+c+"' and text the T-SIM to run it now?"))return;
 const r=await post("commands",{cmd:c,wake,force:!!force});const j=await rj(r);
 if(r.status===409&&j.risky){if(confirm("'"+c+"' can change or wipe the repeater's settings. Queue it anyway?"))return queue(wake,true);return}
 say("conmsg",r.ok&&(!j.wake||j.wake.sent),r.ok?("Queued"+(j.wake?(j.wake.sent?". Text sent, the reply will appear here within a few minutes.":". The wake text wasn't sent: "+friendly(j.wake,j.wake.status)):". It runs the next time the T-SIM wakes.")):friendly(j,r.status));
 if(r.ok)$("cmd").value="";load();}
$("conf").onsubmit=ev=>{ev.preventDefault();queue(false)};$("qwake").onclick=()=>queue(true);
$("wake").onclick=async()=>{if(!confirm("Text the T-SIM to run the queued commands?"))return;const r=await post("wake-cmd");const j=await rj(r);say("conmsg",!!j.sent,j.sent?"Text sent. Replies appear within a few minutes.":friendly(j,r.status));load();};
$("cancel").onclick=async()=>{const r=await post("commands",{cancel:true});const j=await rj(r);say("conmsg",r.ok,r.ok?"Cancelled "+j.cancelled+" queued command"+(j.cancelled==1?"":"s"):friendly(j,r.status));load();};
const OKMSG={status:"Text sent. The T-SIM will wake and report within ~2 minutes.",reboot:"Text sent. The Heltec will restart when the T-SIM wakes (~2 minutes).",
 "update-latest":"Text sent. The Heltec update starts when the T-SIM wakes. Follow it on the LoRa radio tab.","tsim-update":"Text sent. The T-SIM update starts when it wakes. Follow it on the T-SIM tab."};
const ULBL={"update-latest":"Update radio firmware","tsim-update":"Update T-SIM firmware"},UKIND={"update-latest":"heltec","tsim-update":"tsim"};
// Dynamic update buttons: Update (idle/done) -> Cancel (queued/running) -> Retry (failed/stalled/cancelled)
function setUpd(a,kind,p,pend){const s=pend&&(!p||p.state==="idle"||p.state==="done")?"running":(p&&p.state)||"idle";
 const mode=s==="running"?"cancel":(s==="failed"||s==="timeout"||s==="cancelled")?"retry":"update";
 document.querySelectorAll('button[data-a="'+a+'"]').forEach(b=>{if(b.dataset.busy)return;b.dataset.mode=mode;
  b.textContent=mode==="cancel"?"Cancel "+(kind==="tsim"?"T-SIM":"radio")+" update":mode==="retry"?"Retry "+(kind==="tsim"?"T-SIM":"radio")+" update":ULBL[a];
  b.className=mode==="cancel"?"g":"w"})}
async function updClick(b,a){const kind=UKIND[a],mode=b.dataset.mode||"update";
 if(mode==="cancel"){if(!confirm("Cancel this update? No text is sent. If the device already started it may finish the current step."))return null;
  const r=await post("update-cancel",{kind});const j=await rj(r);if(r.ok){delete pending[kind];toast(j.note,"ok")}else toast(friendly(j,r.status),"bad");return true}
 if(mode==="retry"){if(!confirm("Retry the same update? This sends one text to wake the T-SIM."))return null;
  const r=await post(a,{retry:true});const j=await rj(r);if(j.sent){pending[kind]=new Date();toast("Retry sent. "+OKMSG[a],"ok")}else toast(friendly(j,r.status),"bad");return true}
 return false}
document.querySelectorAll("button[data-a]").forEach(b=>b.onclick=async()=>{
 const a=b.dataset.a;if(b.dataset.busy)return;
 if(UKIND[a]&&b.dataset.mode&&b.dataset.mode!=="update"){b.dataset.busy=1;b.disabled=true;const old=b.textContent;b.textContent="Working…";
  try{await updClick(b,a)}catch(x){toast("Couldn't reach the dashboard. Check your internet connection and try again.","bad")}
  delete b.dataset.busy;b.textContent=old;b.disabled=false;load();return}
 if(b.dataset.c&&!confirm(b.dataset.c))return;b.dataset.busy=1;
 b.disabled=true;const old=b.textContent;b.textContent="Working…";
 try{
  if(a==="check"){const[r1,r2]=await Promise.all([post("check"),post("tsim-check")]);const[j1,j2]=await Promise.all([rj(r1),rj(r2)]);
   const parts=[r1.ok?"Heltec: "+j1.latest_available.asset_name:"Heltec: "+friendly(j1,r1.status),r2.ok?"T-SIM: "+j2.latest_available.asset_name+(j2.latest_available.tag&&j2.latest_available.tag!=="url"?" ("+j2.latest_available.tag+")":""):"T-SIM: "+friendly(j2,r2.status)];
   toast("Latest available. "+parts.join(" · "),r1.ok&&r2.ok?"ok":"bad");}
  else{const r=await post(a);const j=await rj(r);if(r.status===401){location.href="/";return}
   if(j.sent){toast(OKMSG[a],"ok");if(a==="update-latest")pending.heltec=new Date();if(a==="tsim-update")pending.tsim=new Date();}
   else toast(friendly(j,r.status),"bad");}
 }catch(x){toast("Couldn't reach the dashboard. Check your internet connection and try again.","bad")}
 delete b.dataset.busy;b.textContent=old;b.disabled=false;load();
});
function tab(){const k=(location.hash||"#ov").slice(1),v=["ov","radio","tsim","act"].includes(k)?k:"ov";
 document.querySelectorAll(".pane").forEach(p=>p.hidden=p.id!=="t-"+v);document.querySelectorAll("#tabs button").forEach(b=>b.classList.toggle("on",b.dataset.t===v))}
document.querySelectorAll("#tabs button").forEach(b=>b.onclick=()=>{history.replaceState(null,"","#"+b.dataset.t);tab();scrollTo(0,0)});
addEventListener("hashchange",tab);tab();
load();
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
    ctx.waitUntil(refreshReleases(env).then((r) => console.log("release refresh", JSON.stringify(r))).catch((e) => console.log("release refresh failed", e.message)));
  },
};
