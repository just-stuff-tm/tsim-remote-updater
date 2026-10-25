// T-SIM remote updater — Cloudflare Worker
// Multi-repeater mesh dashboard: per-device or fleet (account) password login, telemetry,
// MeshCore mesh snapshot, optional repeater console, manual SMS actions via Hologram.
// The only automatic sends are OPTIONAL per-device scheduled checks (off by default) run by the cron.
//
// Bindings: KV STATE; secrets HOLOGRAM_API_KEY, ADMIN_TOKEN, SESSION_SECRET; optional GITHUB_TOKEN.

// Backward compatibility only: releases before 2026-10-18 were named vX.Y.Z-powersaving-serial (files
// Heltec_v3_repeater-vX.Y.Z-powersaving-serial-<commit>.bin). The default pattern still matches them and a source saved with that old default pattern is migrated once.
export const OLD_PS_NAME = "powersaving-serial";
// Default Heltec update source: MeshCore + power saving, with serial.ondemand and headless builds as features
// (just-stuff-tm/MeshCore, releases vX.Y.Z-powersaving; the older release names above still match).
// The app-only Heltec_v3_repeater image keeps the Heltec's identity and settings; "-merged" and "_headless" are skipped.
const DEFAULT_SOURCE = { enabled: true, repo: "just-stuff-tm/MeshCore", asset_pattern: "Heltec_v3_repeater-v*-powersaving-*.bin", tag_prefix: "", direct_url: "" };
// Saved sources carry v: SOURCE_VERSION. Sources saved before the current version that are exactly an old default
// (nothing customized) move to the new default once; anything else the user set is kept as it is.
export const SOURCE_VERSION = 3;
export const LEGACY_DEFAULT_SOURCE = { enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", tag_prefix: "", direct_url: "" };
// v2 default (the older release names, see OLD_PS_NAME)
export const V2_DEFAULT_SOURCE = { enabled: true, repo: "just-stuff-tm/MeshCore", asset_pattern: `Heltec_v3_repeater-v*-${OLD_PS_NAME}-*.bin`, tag_prefix: "", direct_url: "" };
const isExactly = (stored, def) => Object.keys(def).every((k) => (stored[k] ?? def[k]) === def[k]);
export function migrateSource(stored) {
  if (!stored || typeof stored !== "object") return { src: { ...DEFAULT_SOURCE }, migrated: false, stale: false };
  if (stored.v >= SOURCE_VERSION) return { src: { ...DEFAULT_SOURCE, ...stored }, migrated: false, stale: false };
  if (!(stored.v >= 2) && isExactly(stored, LEGACY_DEFAULT_SOURCE))
    return { src: { ...DEFAULT_SOURCE, v: SOURCE_VERSION, migrated_from: LEGACY_DEFAULT_SOURCE.repo }, migrated: true, stale: true };
  // the old default pattern (repo + pattern unchanged): only the pattern moves; enabled/prefix/URL choices stay
  if (stored.repo === V2_DEFAULT_SOURCE.repo && stored.asset_pattern === V2_DEFAULT_SOURCE.asset_pattern) {
    const { migrated_from, ...rest } = stored;
    return { src: { ...DEFAULT_SOURCE, ...rest, asset_pattern: DEFAULT_SOURCE.asset_pattern, v: SOURCE_VERSION, migrated_from: V2_DEFAULT_SOURCE.asset_pattern }, migrated: true, stale: true };
  }
  return { src: { ...DEFAULT_SOURCE, ...stored, v: SOURCE_VERSION }, migrated: false, stale: true };
}
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export function globToRegex(g) {
  return new RegExp("^" + String(g).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
}
export function validateSource(b) {
  const o = { ...DEFAULT_SOURCE, v: SOURCE_VERSION };
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
  if (b.upload !== undefined && b.upload !== null && b.upload !== "") { if (!/^[0-9a-f]{32}$/.test(String(b.upload))) throw new Error("unknown uploaded file"); o.upload = String(b.upload); }
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

const getSource = async (env, id) => {
  const stored = await kvJson(env, `source:${id}`);
  const { src, migrated, stale } = migrateSource(stored);
  if (stale) {
    await putJson(env, `source:${id}`, src);
    if (migrated) {
      await env.STATE.delete(`release:${id}`);
      await logActivity(env, id, { type: "action", msg: src.migrated_from === LEGACY_DEFAULT_SOURCE.repo
        ? `Update source moved to the new default: ${src.repo} ${src.asset_pattern} (was the old default ${LEGACY_DEFAULT_SOURCE.repo}; pick EasySkyMesh under Firmware preset to go back)`
        : `Update source pattern updated for the renamed releases: ${src.asset_pattern} (was ${src.migrated_from}; matches both the new -powersaving- and the older -${OLD_PS_NAME}- files)` });
    }
  }
  return src;
};
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
const CMD_MAX_PENDING = 10, CMD_HISTORY = 80, CFG_MAX_QUEUE = 40, CMD_MAX_LEN = 120, CMD_OUT_MAX = 2000;
// Console commands that can wipe or detach a repeater: need an explicit confirm (force).
export const RISKY_CMD_RE = /^(erase|start ota|password|set (freq|radio|bw|sf|cr|tx|af)|set prv\.key|set serial\.ondemand\s+off|neighbor\.remove|clear)/i;
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
  "Referrer-Policy": "strict-origin-when-cross-origin",   // OSM tile policy needs a Referer (origin only is sent cross-site)
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline' https://unpkg.com; style-src 'unsafe-inline' https://unpkg.com; img-src https://tile.openstreetmap.org https://unpkg.com data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { ...SEC_HEADERS, ...headers } });
const redirect = (loc, headers = {}) => new Response(null, { status: 303, headers: { Location: loc, ...headers } });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- GitHub / Hologram ----------
// Fallback when the GitHub API rate-limits shared Worker IPs (403/429): read the public release page.
// Asset choice: matches the pattern; "-merged" full-flash images and "_headless" builds are skipped unless the pattern asks for them.
export function pickAsset(names, pattern) {
  const re = globToRegex(pattern), wantMerged = /merged/i.test(pattern), wantHeadless = /headless/i.test(pattern);
  return names.find((n) => re.test(n) && (wantMerged || !/-merged\.bin$/i.test(n)) && (wantHeadless || !/_headless\b/i.test(n)));
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
  return { tag, asset_id: `${tag}/${name}`, asset_name: name, url: `https://github.com/${REPO}/releases/download/${tag}/${name}`, published_at: null, via: "html",
    notes: "", html_url: safeRelUrl(null, REPO, tag) };
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
  return { tag: rel.tag_name, asset_id: asset.id, asset_name: asset.name, url: asset.browser_download_url, published_at: rel.published_at, digest: asset.digest || null,
    notes: relNotes(rel.body), html_url: safeRelUrl(rel.html_url, REPO, rel.tag_name) };
}
// Release notes cached with the release check: plain text, control chars stripped, capped (rendered escaped in the dashboard).
export function relNotes(body) { const t = String(body || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim(); return t ? t.slice(0, 4000) : ""; }
export function safeRelUrl(u, repo, tag) {
  const s = String(u || "");
  if (/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/tag\/[^\s"'<>]+$/.test(s)) return s;
  return repo && tag ? `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}` : null;
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
    const ti = kind === "tsim" ? (fwIdent(sent.tag) || fwIdent(sent.asset_name)) : relIdent(sent);
    const inst = kind === "tsim" ? st.tsim_fw : (st.radio_ver_at && Date.parse(st.radio_ver_at) >= startAt ? st.radio_ver : null);
    const iv = verOf(inst);
    if (ti && iv && fwReached(inst, ti)) {
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
  meshcore_serial: { label: "MeshCore + power saving (default, just-stuff-tm/MeshCore)", enabled: true, repo: DEFAULT_SOURCE.repo, tag_prefix: "", asset_pattern: DEFAULT_SOURCE.asset_pattern, direct_url: "", default: true, note: "Default. MeshCore with EasySkyMesh power saving; features: serial.ondemand (the console keeps working while power saving) and headless Heltec V3 builds. Releases vX.Y.Z-powersaving (older release names also match) from the powersaving branch. Uses the Heltec_v3_repeater app-only image (keeps identity and settings), never the -merged or _headless file. Fresh installs default to powersaving on; an update keeps your current setting." },
  easyskymesh: { label: "EasySkyMesh PowerSaving (upgrade)", enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", tag_prefix: "", direct_url: "" },
  meshcore: { label: "Stock MeshCore repeater (latest repeater-* release)", enabled: true, repo: "meshcore-dev/MeshCore", tag_prefix: "repeater-", asset_pattern: "Heltec_v3_repeater-v*.bin", direct_url: "" },
};

// Resolve what "latest" means for this device's update source.
export async function resolveTarget(env, id) {
  const src = await getSource(env, id);
  if (src.upload) {
    const it = ((await kvJson(env, `fwup:${id}`)) || []).find((x) => x.token === src.upload);
    if (!it) return { src, rel: { skipped: "The uploaded firmware file was deleted. Upload it again or pick another update source." } };
    return { src, rel: { tag: "upload", asset_id: it.token, asset_name: it.name, url: it.url, published_at: it.uploaded_at, via: "upload", sha256: it.sha256, md5: it.md5 || null, size: it.size, merged: !!it.merged, kind: it.kind } };
  }
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
  const tlf = tlFields(t.tl);
  if (Object.keys(tlf).length) {  // v1.7.0: every post refreshes the T-SIM card
    const prev0 = (await kvJson(env, `telem:${id}:latest`)) || {};
    await putJson(env, `telem:${id}:latest`, { ...prev0, ...tlf, tl_at: entry.received_at, received_at: entry.received_at });
  }
  if (t.type === "cfgsnap") {
    const items = Array.isArray(t.items) ? t.items.slice(0, 60) : [];
    const cv = (await kvJson(env, `rptcfg:${id}`)) || {}, L = (await kvJson(env, `rptlist:${id}`)) || {};
    let n = 0;
    for (const it of items) {
      if (!Array.isArray(it) || typeof it[0] !== "string") continue;
      const cmd = it[0].slice(0, 120), out = String(it[1] ?? "").slice(0, CMD_OUT_MAX), li = CACHE_LISTS[cmd.toLowerCase()];
      if (li) { const txt = cleanCli(out); L[li] = { raw: txt.slice(0, 1500), at: entry.received_at, error: !txt ? "No reply from the repeater" : (/^(error|err\b|\?\?)|unsupported|unknown command/i.test(txt) ? txt.slice(0, 120) : null), src: "cache" }; n++; continue; }
      const rs = parseSettingReply(cmd, out);
      if (!rs || rs.op !== "get") continue;
      if (rs.value != null) cv[rs.key] = { value: rs.value, at: entry.received_at, src: "cache" };
      else if (rs.unsupported) cv[rs.key] = { unsupported: true, value: null, at: entry.received_at, src: "cache" };
      else continue;  // a missing reply keeps the last good value
      n++;
    }
    await putJson(env, `rptcfg:${id}`, cv); await putJson(env, `rptlist:${id}`, L); await syncOnDemand(env, id, cv);
    const meta = (await kvJson(env, `rptcache:${id}`)) || {};
    meta.last_part_at = entry.received_at; meta.parts = (t.part === 0 ? 0 : meta.parts || 0) + 1; meta.items = (t.part === 0 ? 0 : meta.items || 0) + n;
    if (t.final) { meta.at = entry.received_at; meta.count = typeof t.count === "number" ? t.count : meta.items; meta.error = t.error ? String(t.error).slice(0, 80) : null; }
    await putJson(env, `rptcache:${id}`, meta);
    const prev = (await kvJson(env, `telem:${id}:latest`)) || {};
    await putJson(env, `telem:${id}:latest`, { ...prev, received_at: entry.received_at });
    if (t.final) await logActivity(env, id, { type: "event", msg: `Repeater settings cached by the T-SIM: ${meta.items} value(s)${meta.error ? " (" + meta.error + ")" : ""}` });
    return json({ ok: true });
  }
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
  if (t.type === "heartbeat") {  // v1.7.1 watchdog check-in
    const hb = parseHeartbeat(t, entry.received_at), prevWd = (await kvJson(env, `wd:${id}`)) || {};
    await putJson(env, `wd:${id}`, { ...hb, last_recovery: hb.stage === "soft" || hb.stage === "hard" ? { at: entry.received_at, stage: hb.stage } : prevWd.last_recovery || null });
    const prev = (await kvJson(env, `telem:${id}:latest`)) || {};
    await putJson(env, `telem:${id}:latest`, { ...prev, received_at: entry.received_at, ...(t.fw ? { fw: String(t.fw).slice(0, 60) } : {}) });
    if (hb.stage !== "ok" || (prevWd.fails > 0) || hb.reason) {  // routine OK check-ins stay out of the activity log
      const ev = hb.events.filter((e) => e.stage !== "check" || e.result !== "ok").slice(0, 3).map((e) => `${e.stage} ${e.result}${e.at ? " " + e.at.slice(11, 16) + " UTC" : ""}`).join(", ");
      await logActivity(env, id, { type: "event", msg: `${hb.reason === "heltec-reboot" ? "Heltec reboot detected → " : ""}Watchdog: ${hb.stage === "soft" ? "modem recovered (AT+CFUN reset)" : hb.stage === "hard" ? "modem recovered (power-cycle)" : hb.stage === "lowbat" ? "low battery, recovery skipped" : "check OK after earlier failures"}${ev ? " · recent: " + ev : ""}${hb.sms_waiting > 0 ? ` · ${hb.sms_waiting} text(s) stored on the modem` : ""}` });
    }
    return json({ ok: true });
  }
  if (t.type === "gps") {
    const g = parseGps(t, (await kvJson(env, `gps:${id}`)) || {}, entry.received_at);
    await putJson(env, `gps:${id}`, g);
    const prev = (await kvJson(env, `telem:${id}:latest`)) || {};
    await putJson(env, `telem:${id}:latest`, { ...prev, received_at: entry.received_at, ...(t.fw ? { fw: String(t.fw).slice(0, 60) } : {}) });
    await logActivity(env, id, { type: "event", msg: g.attempt.fix ? `Location fix (${g.attempt.trigger === "auto" ? "on check-in" : "requested"}): ${g.fix.sats ?? "?"} satellites` : `Location: no fix (${g.attempt.msg.slice(0, 100)})` });
    return json({ ok: true });
  }
  if (entry.type === "cmd") {
    const cmdId = String(t.cmd_id || "").slice(0, 16);
    let out = String(t.output ?? "").slice(0, CMD_OUT_MAX);
    // MeshCore prints some replies raw (e.g. "get acl", "log") without the "-> " marker; older T-SIM firmware then
    // flags "no reply" even though the output is there. Real output means the repeater answered.
    if (t.error && /no reply/i.test(String(t.error)) && cleanCli(out) && !/^\s*$/.test(out)) { const o1 = cleanCli(out), cmd1 = String(t.cmd || "").trim(); if (o1 !== cmd1) delete t.error; }
    const list = (await kvJson(env, `cmds:${id}`)) || [];
    const c = list.find((x) => x.id === cmdId);
    { // private key: stored for backups only, never left in command history or the activity log
      const ranCmd = c ? c.cmd : String(t.cmd || "");
      if (isPrvGet(ranCmd)) { const k = parsePrvKey(out); if (k) { await putJson(env, `prvkey:${id}`, { key: k, at: entry.received_at }); out = "OK: private key read and stored for backups (hidden here)"; } else out = out.replace(PRV_RE_G, "••••"); }
      if (isPrvSet(ranCmd)) { if (c) c.cmd = redactCmd(c.cmd); out = out.replace(PRV_RE_G, "••••"); }
      if (isPrvSet(t.cmd)) t.cmd = redactCmd(t.cmd);
    }
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
    if (/^wdcfg /.test(ran) && c) {
      const w = (await kvJson(env, `wdcfg:${id}`)) || {};
      if (c.cmd === wdCfgCmd({ ...DEFAULT_WD, ...w })) { w.applied_at = entry.received_at; w.applied_output = out.slice(0, 200); await putJson(env, `wdcfg:${id}`, w); }
    }
    const adc = c ? parseAdcReply(c.cmd, out) : null;
    if (adc) {
      const a = (await kvJson(env, `adc:${id}`)) || {};
      if (adc.supported !== undefined) a.supported = adc.supported;
      if (adc.supported === false) a.mult = null;
      if (adc.mult !== undefined && (adc.mult !== null || adc.set === 0)) a.mult = adc.mult;
      if (adc.set !== undefined) { a.set = adc.set; a.set_at = entry.received_at; }
      a.error = adc.error || null; a.at = entry.received_at;
      await putJson(env, `adc:${id}`, a);
    }
    if (c && c.op) {
      const L = (await kvJson(env, `rptlist:${id}`)) || {}, txt = cleanCli(out);
      if (c.list) L[c.list] = { raw: txt.slice(0, 1500), at: entry.received_at, error: t.error ? String(t.error).slice(0, 120) : (/^(error|err\b|\?\?)|unsupported|unknown command/i.test(txt) ? txt.slice(0, 120) : null) };
      else { L.ops = [{ cmd: redactCmd(c.cmd).replace("{{now}}", "(now)"), reply: (txt || t.error || "no reply").slice(0, 200), at: entry.received_at, error: !!t.error || /^(error|err\b|\?\?)/i.test(txt) }, ...(L.ops || [])].slice(0, 10); }
      await putJson(env, `rptlist:${id}`, L);
    }
    const rs = c && c.cfg && !c.op ? parseSettingReply(c.cmd, t.error && !out ? "" : out) : null;
    if (rs) {
      const cv = (await kvJson(env, `rptcfg:${id}`)) || {}, prevV = cv[rs.key] || {};
      if (rs.op === "get") cv[rs.key] = rs.value != null ? { value: rs.value, at: entry.received_at, ...(rs.detail ? { detail: rs.detail } : {}) } : { ...prevV, unsupported: !!rs.unsupported, error: rs.error || null, at: entry.received_at, value: rs.unsupported ? null : prevV.value };
      else if (rs.ok) cv[rs.key] = { value: c.val ?? prevV.value ?? null, at: entry.received_at, set: true, msg: rs.key.includes("password") ? "" : rs.msg };
      else cv[rs.key] = { ...prevV, unsupported: !!rs.unsupported, error: rs.unsupported ? null : rs.error, at: entry.received_at };
      if (rs.key === "password") { delete cv.password.value; c.cmd = "password ••••••"; c.output = rs.ok ? "OK (password hidden)" : c.output; await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY)); }
      await putJson(env, `rptcfg:${id}`, cv); await syncOnDemand(env, id, cv);
    }
    if (/^tsimupdate /.test(ran)) { /* T-SIM system command: says nothing about the Heltec CLI */ }
    else if (t.heltec_cli === "asleep" || /no reply/i.test(String(t.error || ""))) await setPowersaving(env, id, true, "console: no CLI reply");
    else if (!t.error && ran === "powersaving on" && /^on\b/i.test(reply)) await setPowersaving(env, id, true, "console: powersaving on");
    else if (!t.error && ran === "powersaving" && /^on\b/i.test(reply)) await setPowersaving(env, id, true, "console: powersaving reads on");
    else if (!t.error && reply && (ran === "powersaving off" || ran === "powersaving" || ((await kvJson(env, `state:${id}`)) || {}).serial_ondemand !== true))
      await setPowersaving(env, id, false, ran === "powersaving off" ? "console: powersaving off" : ran === "powersaving" ? "console: powersaving reads off" : "console: CLI answered");
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
    if (/^UPDATE start/.test(entry.msg)) {  // v1.7.2: the update is running, drop the watchdog backup copy
      const list = (await kvJson(env, `cmds:${id}`)) || [];
      if (cancelWdOnlyOnTextStart(list)) await putJson(env, `cmds:${id}`, list);
    }
    const st = (await kvJson(env, `state:${id}`)) || {};
    st.last_update_result = { at: entry.received_at, msg: entry.msg };
    const m = entry.msg.match(/^SUCCESS:\s*(\S+)/);
    if (m) { let file = flashFile(entry.msg);
      if (/^[0-9a-f]{32}$/.test(file || "")) { const it = ((await kvJson(env, `fwup:${id}`)) || []).find((x) => x.token === file); file = it ? it.name : "uploaded firmware"; }
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
// Power saving blocks the console unless the repeater firmware has serial.ondemand on.
export const psBlocks = (st) => !!st && st.heltec_powersaving === true && st.serial_ondemand !== true;
async function syncOnDemand(env, id, cv) {
  const v = cv && cv["serial.ondemand"];
  const on = v && v.value != null ? /^on\b/i.test(String(v.value)) : v && v.unsupported ? false : undefined;
  if (on === undefined) return;
  const st = (await kvJson(env, `state:${id}`)) || {};
  if (st.serial_ondemand === on) return;
  st.serial_ondemand = on; await putJson(env, `state:${id}`, st);
  await logActivity(env, id, { type: "event", msg: `Repeater serial on demand ${on ? "ON: console keeps working during power saving" : "off/not supported: power saving pauses the console"}` });
}
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

// ---------- repeater settings (MeshCore CLI get/set, https://docs.meshcore.io/cli_commands/) ----------
// Radio presets: official MeshCore list from the app config API https://api.meshcore.nz/api/v1/config (fetched 2026-10-16).
export const RADIO_PRESETS = [
  ["Americas", [["USA", 910.525, 62.5, 7, 5], ["USA - Southern California", 927.875, 62.5, 7, 5, 3], ["Canada", 910.525, 62.5, 7, 5, 3], ["Costa Rica", 910.525, 125, 11, 5], ["Brazil", 923.125, 62.5, 8, 8]]],
  ["Europe 868 MHz", [["EU/UK (Narrow)", 869.618, 62.5, 8, 8], ["EU/UK (Deprecated)", 869.525, 250, 11, 5], ["Czech Republic (Narrow)", 869.432, 62.5, 7, 5, 2], ["Hungary", 869.618, 62.5, 7, 5, 2], ["Netherlands", 869.618, 62.5, 7, 5], ["Netherlands (Limburg)", 869.618, 62.5, 8, 8, 2], ["Portugal 868", 869.618, 62.5, 7, 6], ["Slovakia", 869.618, 62.5, 7, 5, 2], ["Switzerland", 869.618, 62.5, 8, 8]]],
  ["Europe 433 MHz", [["EU 433MHz (Long Range)", 433.65, 250, 11, 5], ["EU 433MHz (Narrow)", 433.65, 62.5, 8, 8], ["Portugal 433", 433.375, 62.5, 9, 6]]],
  ["Australia & New Zealand", [["Australia", 915.8, 250, 10, 5], ["Australia (Narrow)", 916.575, 62.5, 7, 7], ["Australia (Mid)", 915.075, 125, 9, 5], ["Australia: SA, WA", 923.125, 62.5, 8, 8], ["Australia: QLD", 923.125, 62.5, 8, 5], ["New Zealand (Narrow)", 917.375, 62.5, 7, 5, 2], ["New Zealand (Gisborne)", 917.375, 250, 11, 5, 1]]],
  ["Asia", [["Vietnam (Narrow)", 920.25, 62.5, 8, 5], ["Vietnam (Deprecated)", 920.25, 250, 11, 5]]],
];
const ONOFF = [["on", "On"], ["off", "Off"]];
// radio.rxps (power-saving firmware, src/helpers/radiolib/RXPowerSavingCLI.cpp): off | level 1-10 (on/conservative = 3, balanced = 6, max = 8 = highest datasheet-guarded level, overdrive = 9, riskyWorkingMax = 10)
const RXPS_NAMES = { 3: "conservative (= on)", 6: "balanced", 8: "max (highest guarded)", 9: "overdrive ⚠", 10: "riskyWorkingMax ⚠" };
export const RXPS_OPTS = [["off", "Off (continuous RX)"], ...Array.from({ length: 10 }, (_, i) => [`level ${i + 1}`, `Level ${i + 1}${RXPS_NAMES[i + 1] ? " – " + RXPS_NAMES[i + 1] : ""}`])];
// risky only for some values (e.g. serial.ondemand off)
export const settingRisky = (s, v) => !!(s && (s.risk || (s.riskVals && s.riskVals.includes(String(v ?? "").trim().toLowerCase()))));
// type: text | num | sel | radio | secret ; ro = read-only ; risk = strong warning ; typed = typed confirmation word
export const RPT_SETTINGS = [
  { cat: "Identity", items: [
    { k: "name", label: "Node name", type: "text", max: 31, help: "Shown in adverts. Up to 23 bytes when location is shared, 31 otherwise." },
    { k: "owner.info", label: "Owner info", type: "text", max: 90, help: "Free text; | becomes a new line. Firmware 1.12+." },
    { k: "role", label: "Role", ro: true }, { k: "board", label: "Hardware", ro: true, get: "board" }, { k: "ver", label: "Firmware", ro: true, get: "ver" }, { k: "public.key", label: "Public key", ro: true, mono: true } ] },
  { cat: "Location", note: "Coordinates in adverts are public. The Repeater location card can copy the T-SIM's GPS position here.", items: [
    { k: "lat", label: "Latitude", type: "num", min: -90, max: 90, step: 0.000001, unit: "°" },
    { k: "lon", label: "Longitude", type: "num", min: -180, max: 180, step: 0.000001, unit: "°" } ] },
  { cat: "Radio", risk: true, note: "Wrong radio settings take the repeater off your mesh, and you may then only be able to fix it here or over USB. Radio changes apply after the radio restarts (Reboot radio at the top of this tab).", items: [
    { k: "radio", label: "Frequency / bandwidth / SF / CR", type: "radio", risk: true },
    { k: "tx", label: "Transmit power", type: "num", min: 1, max: 22, step: 1, unit: "dBm", risk: true, help: "LoRa chip power only; boards with an amplifier transmit more. Stay within your local legal limit." },
    { k: "radio.rxgain", label: "RX boosted gain", type: "sel", opts: ONOFF, help: "SX12xx/LR1110, firmware 1.14.1+." },
    { k: "radio.fem.rxgain", label: "Front-end RX gain (LNA)", type: "sel", opts: ONOFF, help: "Only on boards with an external front end." },
    { k: "radio.fem.txgain", label: "Front-end TX gain", type: "sel", opts: ONOFF, risk: true, help: "Only on boards with an external front end (e.g. Station G3)." } ] },
  { cat: "Repeating & routing", items: [
    { k: "repeat", label: "Repeat packets", type: "sel", opts: ONOFF, risk: true, help: "Off = the node stops relaying for the mesh." },
    { k: "path.hash.mode", label: "Advert path hash size", type: "sel", opts: [["0", "1 byte (max 64 hops)"], ["1", "2 bytes (max 32 hops)"], ["2", "3 bytes (max 21 hops)"]], risk: true, help: "Firmware 1.14+. Nodes on 1.13 or older drop 2-3 byte paths." },
    { k: "loop.detect", label: "Loop detection", type: "sel", opts: [["off", "Off"], ["minimal", "Minimal"], ["moderate", "Moderate"], ["strict", "Strict"]] },
    { k: "flood.max", label: "Max flood hops", type: "num", min: 0, max: 64, step: 1, unit: "hops" },
    { k: "flood.max.unscoped", label: "Max hops, unscoped floods", type: "num", min: 0, max: 64, step: 1, unit: "hops" },
    { k: "flood.max.advert", label: "Max hops, advert floods", type: "num", min: 0, max: 64, step: 1, unit: "hops" },
    { k: "multi.acks", label: "Multi-acks", type: "sel", opts: [["1", "On"], ["0", "Off"]] } ] },
  { cat: "Timing & airtime", items: [
    { k: "txdelay", label: "Flood retransmit delay factor", type: "num", min: 0, max: 2, step: 0.1, unit: "×" },
    { k: "direct.txdelay", label: "Direct retransmit delay factor", type: "num", min: 0, max: 2, step: 0.1, unit: "×" },
    { k: "rxdelay", label: "Receive delay base (experimental)", type: "num", min: 0, max: 20, step: 0.1 },
    { k: "dutycycle", label: "Duty cycle limit", type: "num", min: 1, max: 100, step: 1, unit: "%", help: "Firmware 1.15+. EU 868: usually 10% or less." },
    { k: "int.thresh", label: "Interference threshold", type: "num", min: 0, max: 100, step: 1 },
    { k: "cad", label: "Channel activity detection", type: "sel", opts: ONOFF },
    { k: "agc.reset.interval", label: "AGC reset interval", type: "num", min: 0, max: 1020, step: 4, unit: "s", help: "0 = off; rounded down to a multiple of 4." } ] },
  { cat: "Adverts", items: [
    { k: "flood.advert.interval", label: "Flood advert every", type: "num", min: 3, max: 168, step: 1, unit: "h" },
    { k: "advert.interval", label: "Zero-hop advert every", type: "num", min: 0, max: 240, step: 2, unit: "min", help: "60–240, or 0 for off." } ] },
  { cat: "Power & battery", items: [
    { k: "powersaving", label: "Power saving", type: "sel", opts: ONOFF, risk: true, get: "powersaving", set: "powersaving ", help: "On = the repeater sleeps between transmissions (ESP32: after about 2 minutes). Stock firmware then stops answering this dashboard's console; firmware with Serial on demand keeps answering. Not available on bridge builds." },
    { k: "serial.ondemand", label: "Serial on demand", type: "sel", opts: ONOFF, riskVals: ["off"], warn: "Serial on demand OFF: with power saving on, the T-SIM may no longer reach the Heltec's CLI (console, settings and serial reads stop until power saving is turned off over the mesh or USB)", help: "Keeps the Heltec's serial port reachable during power saving so the T-SIM can still send commands; off = stock power saving. Requires MeshCore + power saving + serial firmware (just-stuff-tm/MeshCore)." },
    { k: "radio.rxps", label: "RX duty cycle (RXPS)", type: "sel", opts: RXPS_OPTS, riskVals: ["level 9", "level 10"], warn: "RX duty cycle overdrive / riskyWorkingMax runs outside the radio datasheet timing and can miss packets", help: "Receiver sleeps between preamble checks to save power. Higher level = more saving, shorter preamble margin. on = level 3. Custom rx/sleep timings can only be set in the console (set radio.rxps <rx_us> <sleep_us>). Power-saving firmware (EasySkyMesh or just-stuff-tm/MeshCore)." },
    { k: "reboot.interval", label: "Scheduled reboot every", type: "num", min: 0, max: 255, step: 1, unit: "h", help: "0 = off. Power-saving firmware (EasySkyMesh or just-stuff-tm/MeshCore)." },
    { k: "adc.multiplier", label: "Battery multiplier", ro: true, help: "Calibrate it from a multimeter reading in Repeater battery calibration." } ] },
  { cat: "GPS", note: "Only on repeaters built with GPS support; others answer \"not supported\".", items: [
    { k: "gps", label: "GPS receiver", type: "sel", opts: ONOFF, get: "gps", set: "gps ", first: true },
    { k: "gps.advert", label: "Location in adverts", type: "sel", opts: [["none", "Don't share"], ["share", "Live GPS position"], ["prefs", "Saved lat/lon"]], get: "gps advert", set: "gps advert " } ] },
  { cat: "Bridge", dep: "bridge.type", note: "Only on repeaters built with a bridge (RS-232 or ESP-NOW). Hidden when the repeater doesn't report one.", items: [
    { k: "bridge.type", label: "Bridge type", ro: true },
    { k: "bridge.enabled", label: "Bridge enabled", type: "sel", opts: ONOFF, dep: "bridge.type" },
    { k: "bridge.delay", label: "Bridge delay", type: "num", min: 0, max: 10000, step: 10, unit: "ms", dep: "bridge.type" },
    { k: "bridge.source", label: "Bridge packets", type: "sel", opts: [["logTx", "Transmitted (logTx)"], ["logRx", "Received (logRx)"]], dep: "bridge.type" },
    { k: "bridge.baud", label: "RS-232 speed", type: "sel", opts: ["9600", "19200", "38400", "57600", "115200"].map((x) => [x, x + " baud"]), dep: "bridge.type" },
    { k: "bridge.channel", label: "ESP-NOW channel", type: "num", min: 1, max: 14, step: 1, dep: "bridge.type" },
    { k: "bridge.secret", label: "ESP-NOW secret", type: "secret", max: 15, risk: true, dep: "bridge.type" } ] },
  { cat: "Diagnostics", noAll: true, note: "Read-only. Power-management values exist only on nRF52 boards; others answer \"not supported\".", items: [
    { k: "pwrmgt.support", label: "Power management", ro: true }, { k: "pwrmgt.source", label: "Power source", ro: true },
    { k: "pwrmgt.bootreason", label: "Boot / shutdown reason", ro: true }, { k: "pwrmgt.bootmv", label: "Boot voltage", ro: true },
    { k: "bootloader.ver", label: "Bootloader", ro: true }, { k: "powerlog", label: "Reset reason (powerlog)", ro: true, get: "powerlog", help: "Power-saving firmware only." }, { k: "eth.status", label: "Ethernet", ro: true, get: "eth.status" } ] },
  { cat: "Passwords", risk: true, note: "Anyone who knows these can log in to the repeater over the mesh. Passwords are sent over SMS/LTE to the T-SIM and stored in this dashboard's command history.", items: [
    { k: "guest.password", label: "Guest password", type: "secret", max: 60, risk: true },
    { k: "password", label: "Admin password (change only)", type: "secret", max: 60, wo: true, risk: true, typed: "CHANGE", help: "Can't be read back. Default on new nodes: password." } ] },
];
export const RPT_INDEX = Object.fromEntries(RPT_SETTINGS.flatMap((c) => c.items.map((i) => [i.k, { ...i, cat: c.cat, noAll: !!c.noAll }])));
export const rptGetCmd = (k) => (RPT_INDEX[k] && RPT_INDEX[k].get) || (k === "powersaving" ? "powersaving" : "get " + k);
const rptSetPrefix = (i) => i.set || (i.k === "powersaving" ? "powersaving " : i.k === "password" ? "password " : "set " + i.k + " ");
export const RPT_READ_KEYS = Object.values(RPT_INDEX).filter((i) => !i.wo).map((i) => i.k);
// "Read all": everything except diagnostics, and bridge settings only once the repeater reported a bridge type.
export const rptReadAllKeys = (vals = {}) => Object.values(RPT_INDEX).filter((i) => !i.wo && !i.noAll && (!i.dep || depOk(vals[i.dep]))).map((i) => i.k);
export function depOk(v) { return !!(v && v.value != null && !/^(none|no|off|-|n\/a)?$/i.test(String(v.value).trim())); }
const RPT_GETMAP = Object.fromEntries(Object.values(RPT_INDEX).filter((i) => !i.wo).map((i) => [rptGetCmd(i.k).toLowerCase(), i.k]));
const RPT_SETS = Object.values(RPT_INDEX).filter((i) => !i.ro).map((i) => [rptSetPrefix(i).toLowerCase(), i.k]).sort((a, b) => b[0].length - a[0].length);
// Parse a reply to a settings get/set command: { key, op, value?, unsupported?, error? } or null.
export function parseSettingReply(cmd, out) {
  const c = String(cmd || "").trim(), lc = c.toLowerCase(); let key, op;
  if (RPT_GETMAP[lc]) { key = RPT_GETMAP[lc]; op = "get"; }
  else { const hit = RPT_SETS.find(([pre]) => lc.startsWith(pre)); if (!hit) return null; key = hit[1]; op = "set"; }
  const r = cleanCli(out);
  if (!r) return { key, op, error: "No reply from the repeater" };
  if (/unsupported|unknown (config|command)|^\?\?|not supported/i.test(r)) return { key, op, unsupported: true };
  if (/^(error|err\b|err -)/i.test(r) || /\berror\b/i.test(r) && !/^ok/i.test(r)) return { key, op, error: r.slice(0, 120) };
  if (op === "set") return { key, op, ok: true, msg: key === "password" ? "Admin password changed" : r.slice(0, 120) };
  let v = r.replace(/^>\s*/, "").trim();
  if (key === "powersaving" || key === "serial.ondemand") { const p = v.match(/\b(on|off)\b/i); v = p ? p[1].toLowerCase() : v; }
  if (key === "reboot.interval" && /^disabled\b/i.test(v)) v = "0";
  if (key === "radio.rxps") {  // "> desired=on,effective=armed,supported=yes,err=0,fail=0,level=6,catch=10.0,preamble=0,rx=..,sleep=.."
    const de = (v.match(/desired=(on|off)/i) || [])[1], lv = +((v.match(/level=(\d+)/) || [])[1] || 0);
    return { key, op, value: !de ? v.slice(0, 200) : de.toLowerCase() === "off" ? "off" : lv >= 1 && lv <= 10 ? `level ${lv}` : "custom", detail: v.slice(0, 200) };
  }
  if (RPT_INDEX[key].first) v = v.split(/[\s,]+/)[0].toLowerCase();
  return { key, op, value: v.slice(0, 200) };
}
const fmtNum = (n) => String(+(+n).toFixed(6));
// Validate one change and build its CLI command. Throws Error(plain text).
export function buildSettingCmd(k, v) {
  const s = RPT_INDEX[k]; if (!s || s.ro) throw new Error(`"${k}" can't be changed here`);
  const label = s.label;
  if (s.type === "radio") {
    const p = String(v).split(",").map((x) => +x);
    if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) throw new Error("Radio needs frequency, bandwidth, SF and CR");
    const [f, bw, sf, cr] = p;
    if (!(f >= 300 && f <= 2500)) throw new Error("Frequency must be 300–2500 MHz");
    if (!(bw >= 7.8 && bw <= 500)) throw new Error("Bandwidth must be 7.8–500 kHz");
    if (!(Number.isInteger(sf) && sf >= 5 && sf <= 12)) throw new Error("Spreading factor must be 5–12");
    if (!(Number.isInteger(cr) && cr >= 5 && cr <= 8)) throw new Error("Coding rate must be 5–8");
    return `set radio ${fmtNum(f)},${fmtNum(bw)},${sf},${cr}`;
  }
  if (s.type === "num") {
    const n = Number(v); if (v === "" || v == null || !Number.isFinite(n) || n < s.min || n > s.max) throw new Error(`${label} must be ${s.min}–${s.max}${s.unit ? " " + s.unit : ""}`);
    if (k === "advert.interval" && n > 0 && n < 60) throw new Error("Zero-hop advert interval must be 60–240 min, or 0 for off");
    return `set ${k} ${fmtNum(n)}`;
  }
  if (s.type === "sel") {
    const x = String(v); if (!s.opts.some((o) => o[0] === x)) throw new Error(`Pick a value for ${label}`);
    return rptSetPrefix(s) + x;
  }
  const t = String(v ?? "");
  if (!/^[\x20-\x7e]*$/.test(t)) throw new Error(`${label}: use plain letters, numbers and symbols (no emoji or accents)`);
  if (t.length > s.max) throw new Error(`${label} is too long (max ${s.max})`);
  if (k === "password") { if (t.length < 4 || /\s/.test(t)) throw new Error("Admin password: at least 4 characters, no spaces"); return `password ${t}`; }
  if (k === "name" && !t.trim()) throw new Error("Node name can't be empty");
  if (s.type === "secret" && !t) throw new Error(`${label} can't be empty`);
  return (rptSetPrefix(s) + t).trimEnd();
}
// Lists and one-off operations (regions, ACL, sensors, logging, clock, maintenance). Returns [{cmd, list?, risk?}].
const RGN = /^(\*|[#A-Za-z0-9_.\-]{1,30})$/, HEX = /^[0-9A-Fa-f]{2,64}$/;
export const RPT_LIST_READS = { regions: [["region", "regions"], ["region home", "home"], ["region default", "default"]], acl: [["get acl", "acl"]], sensors: [["sensor list", "sensors"]], log: [["log", "log"]] };
export function buildRptOp(o) {
  const op = String(o && o.op || ""), need = (re, v, what) => { v = String(v ?? "").trim(); if (!re.test(v)) throw new Error(`Invalid ${what}`); return v; };
  const rg = (v) => need(RGN, v, "region name (letters, numbers, # . _ - ; max 30)");
  const refresh = [["region", "regions"], ["region home", "home"], ["region default", "default"]].map(([cmd, list]) => ({ cmd, list }));
  switch (op) {
    case "read": { const r = RPT_LIST_READS[o.what]; if (!r) throw new Error("Unknown list"); return r.map(([cmd, list]) => ({ cmd, list })); }
    case "region.put": { const n = rg(o.name), par = o.parent ? rg(o.parent) : ""; return [{ cmd: `region put ${n}${par ? " " + par : ""}` }, { cmd: `region ${o.flood === false ? "denyf" : "allowf"} ${n}` }, { cmd: "region save" }, ...refresh]; }
    case "region.remove": return [{ cmd: `region remove ${rg(o.name)}`, risk: true }, { cmd: "region save" }, ...refresh];
    case "region.flood": return [{ cmd: `region ${o.allow ? "allowf" : "denyf"} ${rg(o.name)}`, risk: o.name === "*" }, { cmd: "region save" }, ...refresh];
    case "region.home": return [{ cmd: `region home ${rg(o.name)}` }, { cmd: "region save" }, ...refresh];
    case "region.default": return [{ cmd: `region default ${o.name ? rg(o.name) : "<null>"}` }, { cmd: "region save" }, ...refresh];
    case "acl.set": { const pk = need(HEX, o.pubkey, "public key (hex)"), pm = Number(o.perm); if (![0, 1, 2, 3].includes(pm)) throw new Error("Pick a permission"); return [{ cmd: `setperm ${pk} ${pm}`, risk: pm === 3 }, { cmd: "get acl", list: "acl" }]; }
    case "acl.remove": return [{ cmd: `setperm ${need(HEX, o.pubkey, "public key (hex)")} 0`, risk: true }, { cmd: "get acl", list: "acl" }];  // MeshCore 1.18 needs a value; 0 = removed
    case "sensor.get": { const k = need(/^[A-Za-z0-9_.]{1,32}$/, o.key, "sensor setting name"); return [{ cmd: `sensor get ${k}`, list: "sensor:" + k }]; }
    case "sensor.set": { const k = need(/^[A-Za-z0-9_.]{1,32}$/, o.key, "sensor setting name"), v = need(/^[\x21-\x7e][\x20-\x7e]{0,59}$/, o.value, "value"); return [{ cmd: `sensor set ${k} ${v}` }, { cmd: "sensor list", list: "sensors" }]; }
    case "log.start": return [{ cmd: "log start" }]; case "log.stop": return [{ cmd: "log stop" }];
    case "log.erase": return [{ cmd: "log erase", risk: true }];
    case "clock.sync": return [{ cmd: "time {{now}}" }, { cmd: "clock" }];
    case "gps.sync": return [{ cmd: "gps sync" }]; case "gps.setloc": return [{ cmd: "gps setloc" }];
    case "advert": return [{ cmd: "advert" }]; case "advert.zerohop": return [{ cmd: "advert.zerohop" }];
    case "discover.neighbors": return [{ cmd: "discover.neighbors" }]; case "clear.stats": return [{ cmd: "clear stats", risk: true }];
    case "neighbor.remove": return [{ cmd: `neighbor.remove ${need(HEX, o.prefix, "node ID prefix (hex)")}`, risk: true }];
    case "tempradio": { const r = buildSettingCmd("radio", [o.f, o.bw, o.sf, o.cr].join(",")).slice(10), m = Number(o.mins); if (!(Number.isInteger(m) && m >= 1 && m <= 1440)) throw new Error("Minutes must be 1–1440"); return [{ cmd: `tempradio ${r},${m}`, risk: true }]; }
    default: throw new Error("Unknown action");
  }
}
export const RPT_ACTIONS = { advert: "Send a flood advert", "advert.zerohop": "Send a zero-hop advert" };
// Firmware runs at most this many queued commands per wake (CMD_MAX_RUN in firmware/src/main.cpp).
export const CMDS_PER_WAKE = 10;
// 1.6.9 runs up to 40 per wake with a 6 KB fetch buffer.
export const BATCH_FW = "1.6.9", CMDS_PER_WAKE_169 = 40, CMD_FETCH_BYTES = 6000;
export const cmdsPerWake = (fw) => (fwAtLeast(fw, BATCH_FW) ? CMDS_PER_WAKE_169 : CMDS_PER_WAKE);

// ---------- Heltec (repeater) battery calibration via MeshCore "adc.multiplier" ----------
export const ADC_UNSUPPORTED = "This repeater's firmware/board doesn't support battery calibration (it answered \"Error: unsupported\"). Stock MeshCore for the Heltec V3 doesn't implement it yet; the reading can only be corrected in firmware.";
// Parse a reply to "get adc.multiplier" / "set adc.multiplier X". Returns null if it isn't recognisable.
export function parseAdcReply(cmd, out) {
  const c = String(cmd || "").trim().toLowerCase(), r = cleanCli(out);
  if (!/^(get|set) adc\.multiplier\b/.test(c)) return null;
  if (/error/i.test(r)) return /unsupported/i.test(r) ? { supported: false } : { error: r.slice(0, 120) };
  if (c.startsWith("get")) { const m = r.match(/(-?\d+(?:\.\d+)?)/); return m ? { supported: true, mult: +m[1] } : null; }
  if (/default/i.test(r)) return { supported: true, set: 0, mult: null };
  const m = r.match(/set to\s*(\d+(?:\.\d+)?)/i); return m ? { supported: true, set: +m[1], mult: +m[1] } : (/^ok/i.test(r) ? { supported: true } : null);
}
export const clampAdc = (v) => Math.round(Math.min(10, Math.max(0, Number(v) || 0)) * 1000) / 1000;
export function calcAdcMultiplier(cur, meterV, reportedV) {
  cur = Number(cur); meterV = Number(meterV); reportedV = Number(reportedV);
  if (!(cur > 0)) throw new Error("The current multiplier isn't known yet. Press \"Read current value\" first.");
  if (!(meterV >= 2.5 && meterV <= 5)) throw new Error("Enter the multimeter reading in volts (2.5–5 V).");
  if (!(reportedV >= 1)) throw new Error("No battery reading from the repeater yet. Press Request status first.");
  const v = clampAdc(cur * meterV / reportedV);
  if (!(v > 0)) throw new Error("That works out to 0, which would mean \"board default\". Check the readings.");
  return v;
}
export const isSysCmd = (cmd) => /^(tsimupdate|pwrcfg|cfgsnap|wdcfg)\s/i.test(String(cmd || "").trim()) || /^gps(fix|cfg)\b/i.test(String(cmd || "").trim());
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
// ---------- GPS / location (T-SIM firmware 1.6.7+) ----------
export const GPS_FW = "1.6.7";
// ---------- v1.7.0: T-SIM settings cache + telemetry on every post ----------
export const CACHE_FW = "1.7.0", DEFAULT_CACHE = { en: false, int_h: 24 };
export const CACHE_LISTS = { "region": "regions", "region home": "home", "region default": "default", "get acl": "acl" };
// The T-SIM runs at most CFG_MAX_CMDS of these per snapshot: lists first (regions/ACL matter most for backups), then settings.
export const CFG_MAX_CMDS = 48;
export const cfgListCmds = (vals = {}) => [...Object.keys(CACHE_LISTS), ...rptReadAllKeys(vals).map(rptGetCmd)].slice(0, CFG_MAX_CMDS);
// v1.7.1 modem watchdog: the T-SIM wakes on a timer, checks the modem (AT, SIM, registration, packet attach), recovers it
// (AT+CFUN, then a modem power-cycle) and posts a heartbeat. Settings reach the T-SIM as the WDCFG system command.
// v1.7.2: watchdog wakes also fetch queued commands ("?wd=1"). A Heltec update is texted as usual AND queued as a
// watchdog-only backup (wdonly): served only on watchdog fetches, cancelled when the text path starts it, expires after 24 h.
export const WDCMD_FW = "1.7.2", WDONLY_TTL_MS = 24 * 3600 * 1000;
export function queueWdUpdate(list, url, nowIso = new Date().toISOString(), idFn = () => randomHex(4)) {
  for (const c of list) if (c.wdonly && c.status === "queued") { c.status = "cancelled"; c.error = "replaced by a newer update"; }
  const e = { id: idFn(), cmd: `UPDATE ${url}`, sys: true, wdonly: true, status: "queued", queued_at: nowIso };
  list.unshift(e); return e;
}
export function expireWdOnly(list, nowMs = Date.now()) {
  let n = 0;
  for (const c of list) if (c.wdonly && c.status === "queued" && nowMs - Date.parse(c.queued_at || 0) > WDONLY_TTL_MS) { c.status = "cancelled"; c.error = "expired (not picked up by a watchdog check-in within 24 h)"; n++; }
  return n;
}
export function cancelWdOnlyOnTextStart(list) {
  let n = 0;
  for (const c of list) if (c.wdonly && c.status === "queued") { c.status = "cancelled"; c.error = "the update text started it"; n++; }
  return n;
}
export const wdOnlyOk = (c, wd, fw) => !c.wdonly || (wd && fwAtLeast(fw, WDCMD_FW));
export const WD_FW = "1.7.1", DEFAULT_WD = { int_min: 180, hb: true, sms: false };
export const WD_CHOICES = [0, 30, 60, 120, 180, 360, 720, 1440];
// v1.7.3: hwake (Heltec-reboot wake on GPIO6) is only added once set, so 1.7.1/1.7.2 commands stay byte-identical.
export const HWAKE_FW = "1.7.3";
export const wdCfgCmd = (w) => `WDCFG int=${w.int_min} hb=${w.hb ? 1 : 0} sms=${w.sms ? 1 : 0}${w.hwake === undefined ? "" : " hwake=" + (w.hwake ? 1 : 0)}`;
export function validateWd(cur, b) {
  const w = { ...DEFAULT_WD, ...(cur || {}) };
  if (b.int_min !== undefined) { const m = Number(b.int_min); if (!WD_CHOICES.includes(m)) throw new Error("Pick a watchdog interval (off, or 30 min to 24 h)."); w.int_min = m; }
  if (b.hb !== undefined) w.hb = b.hb === true;
  if (b.sms !== undefined) w.sms = b.sms === true;
  if (b.hwake !== undefined) w.hwake = b.hwake === true;
  return { int_min: w.int_min, hb: w.hb, sms: w.sms, ...(w.hwake !== undefined ? { hwake: w.hwake } : {}) };
}
// Heartbeat body {"type":"heartbeat","stage":..,"sms_waiting":n,"wd":{int,hb,sms,chk,ok,soft,hard,fail,fails,next,ev:[[ago_s,stage,result,secs],...]}}
export function parseHeartbeat(t, receivedAt = new Date().toISOString()) {
  const w = t && typeof t.wd === "object" && t.wd ? t.wd : {};
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const S = (v) => String(v ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 12);
  const rt = Date.parse(receivedAt);
  const events = (Array.isArray(w.ev) ? w.ev : []).slice(0, 6).filter((e) => Array.isArray(e) && e.length >= 4).map((e) => ({
    at: n(e[0]) != null && e[0] >= 0 ? new Date(rt - e[0] * 1000).toISOString() : null, stage: S(e[1]), result: S(e[2]), secs: n(e[3]) }));
  return { at: receivedAt, stage: S(t && t.stage) || "ok", sms_waiting: n(t && t.sms_waiting), int_min: n(w.int), hb: w.hb === 1 || w.hb === true, sms: w.sms === 1 || w.sms === true,
    checks: n(w.chk), ok: n(w.ok), soft: n(w.soft), hard: n(w.hard), fail: n(w.fail), fails: n(w.fails),
    cmd: w.cmd === undefined ? null : w.cmd === 1 || w.cmd === true, cmd_fetches: n(w.cmdn), restarts: n(w.rst), deadline_resets: n(w.dlx),
    hwake: n(w.hwk), hw_wakes: n(w.hwn), hw_ignored: n(w.hwi), hw_skipped: n(w.hws), reason: String((t && t.reason) ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 24) || null,
    next_at: n(w.next) != null && w.next >= 0 ? new Date(rt + w.next * 1000).toISOString() : null, events };
}
// Expected check-in interval and offline state. Uses what the T-SIM reports it runs (tl.wdi / heartbeat), not just the
// saved settings, so a T-SIM that never got 1.7.1 isn't flagged. Offline = 2 missed check-ins + 15 min grace.
export function checkinInfo(latest = {}, wd = null, wdcfg = null, scheduleHours = 0, now = Date.now()) {
  const L = latest || {}, last = L.received_at || null;
  const devInt = typeof L.wd_int === "number" ? L.wd_int : wd && typeof wd.int_min === "number" ? wd.int_min : null;
  const hb = wd ? wd.hb : wdcfg ? wdcfg.hb !== false : DEFAULT_WD.hb;
  let expected = null, by = null;
  if (devInt > 0 && hb) { expected = devInt * 60; by = "watchdog"; }
  if (scheduleHours > 0 && (expected == null || scheduleHours * 3600 < expected)) { expected = scheduleHours * 3600; by = "schedule"; }
  const age = last ? Math.max(0, Math.round((now - Date.parse(last)) / 1000)) : null;
  const offline = expected != null && age != null && age > 2 * expected + 900;
  const missed = expected != null && age != null ? Math.max(0, Math.floor(age / expected) - (age % expected < 900 ? 1 : 0)) : 0;
  return { last_seen: last, age_s: age, expected_s: expected, by, offline, missed: offline ? Math.max(2, missed) : missed };
}
export const cacheCmd = (c, now) => `CFGSNAP en=${c.en ? 1 : 0} int=${c.int_h}${now ? " now=1" : ""}`;
// "tl" telemetry block on every post -> fields of the latest T-SIM report
export function tlFields(tl) {
  if (!tl || typeof tl !== "object") return {};
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined), o = {};
  const map = { bv: "battery_v", bp: "battery_pct", bl: "battery_load_v", sv: "solar_v", up: "uptime", wake: "wake", heap: "heap", tc: "chip_temp_c", lb: "lb_state",
    wdi: "wd_int", wdc: "wd_checks", wds: "wd_soft", wdh: "wd_hard", wdf: "wd_fail" };
  for (const [k, f] of Object.entries(map)) if (n(tl[k]) !== undefined) o[f] = tl[k];
  if (n(tl.csq) !== undefined && tl.csq >= 0 && tl.csq !== 99) o.csq = tl.csq;
  if (n(tl.rsrp) !== undefined && tl.rsrp !== 0) o.rsrp = tl.rsrp;
  if (o.battery_v !== undefined && o.battery_v < 0.5) { delete o.battery_v; delete o.battery_pct; }  // USB power: no reading
  if (typeof tl.fw === "string") o.fw = tl.fw.slice(0, 60);
  if (n(tl.glat) !== undefined && n(tl.glon) !== undefined) o.gps_cached = { lat: tl.glat, lon: tl.glon, sats: n(tl.gsats) ?? null, at: n(tl.gat) > 1e9 ? new Date(tl.gat * 1000).toISOString() : null };
  return o;
}
export const DEFAULT_GPS = { auto: false, timeout_s: 180 };
const isGpsCmd = (cmd) => /^gps(fix|cfg)\b/i.test(String(cmd || "").trim());
export const gpsCfgCmd = (g) => `GPSCFG auto=${g.auto ? 1 : 0} to=${g.timeout_s}`;
export function validateGps(cur, b) {
  const o = { ...DEFAULT_GPS, ...cur };
  if (b.auto !== undefined) o.auto = b.auto === true;
  if (b.timeout_s !== undefined) {
    const s = Math.round(Number(b.timeout_s));
    if (!(s >= 30 && s <= 600)) throw new Error("Fix timeout must be between 30 and 600 seconds.");
    o.timeout_s = s;
  }
  return { auto: o.auto, timeout_s: o.timeout_s };
}
const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
// Ingest {"type":"gps"} -> stored record. Keeps the last good fix when an attempt finds none.
export function parseGps(t, prev = {}, receivedAt = new Date().toISOString()) {
  const lat = num(t.lat, -90, 90), lon = num(t.lon, -180, 180);
  const fix = t.fix === true && lat != null && lon != null && !(lat === 0 && lon === 0);
  const attempt = { at: receivedAt, fix, sats: num(t.sats, 0, 200), secs: num(t.secs, 0, 3600), trigger: t.trigger === "auto" ? "auto" : "cmd",
    src: String(t.src || "").slice(0, 12), msg: String(t.msg || "").slice(0, 200) };
  const d = t.diag && typeof t.diag === "object" ? t.diag : null;   // v1.6.8 modem diagnostics
  if (d) {
    const st = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n);
    attempt.diag = { ready_ms: num(d.ready_ms, -1, 600000), warm: d.warm === true, pwr: st(d.pwr, 60), ant: st(d.ant, 80), mode: st(d.mode, 60),
      first: st(d.first, 180), last: st(d.last, 180), sats: num(d.sats, 0, 200), timeout: num(d.timeout, 0, 3600) };
  }
  const out = { attempt, fix: prev.fix || null };
  if (fix) out.fix = { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, alt: num(t.alt, -1000, 20000), sats: attempt.sats,
    hdop: num(t.hdop, 0, 99), utc: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(t.utc || "")) ? t.utc : null, received_at: receivedAt, trigger: attempt.trigger };
  return out;
}
// Neighbor nicknames: MeshCore repeater 1.18 "neighbors" only exposes 4-byte pubkey prefixes (no names), so names are user-set.
export function setNick(map, hash, name) {
  const h = String(hash || "").trim().toUpperCase();
  if (!/^[0-9A-F]{2,16}$/.test(h)) throw new Error("Node ID must be hex (from the neighbors list).");
  const n = String(name == null ? "" : name).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 32);
  const o = { ...(map || {}) };
  if (n) o[h] = n; else delete o[h];
  if (Object.keys(o).length > 200) throw new Error("Too many nicknames (max 200).");
  return o;
}
// Dashboard-side: the local "just pressed" placeholder ends once the server shows this request (or a newer result).
// pend: ISO time the request was queued (server time); p: gps.progress; a: gps.attempt.
export function gpsPendResolved(pend, p, a, now = Date.now()) {
  if (!pend) return true;
  const t = Date.parse(pend) - 5000;   // small clock-skew allowance
  if (p && p.started_at && Date.parse(p.started_at) >= t) return true;
  if (a && a.at && Date.parse(a.at) >= t) return true;
  return now - Date.parse(pend) > 15 * 60e3;
}
// Units (dashboard toggle, default metric). Distances in metres in, display string out.
export function fmtDist(m, imperial) {
  if (m == null || !isFinite(m)) return null;
  if (imperial) { const ft = m * 3.28084; return Math.abs(ft) >= 5280 ? (ft / 5280).toFixed(1) + " mi" : Math.round(ft) + " ft"; }
  return Math.abs(m) >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
}
export function fmtTemp(c, imperial) { return c == null || !isFinite(c) ? null : imperial ? Math.round(c * 9 / 5 + 32) + " °F" : Math.round(c) + " °C"; }
export const GPS_STEPS = ["Waiting for T-SIM to wake", "Searching for satellites", "Done"];
// req: {id, at, timeout_s}; cmds: command list; gps: stored record.
export function gpsProgress(req, cmds = [], gps = {}, now = Date.now()) {
  if (!req || !req.id) return { state: "idle" };
  const c = (cmds || []).find((x) => x.id === req.id);
  const at = Date.parse(req.at), a = gps && gps.attempt;
  const base = { started_at: req.at, steps: GPS_STEPS, times: { 0: req.at } };
  if (a && Date.parse(a.at) >= at) {
    const p = { ...base, step: 2, pct: 100, finished_at: a.at, fix: a.fix, times: { ...base.times, ...(c && c.sent_at ? { 1: c.sent_at } : {}), 2: a.at } };
    return a.fix ? { ...p, state: "done" } : { ...p, state: "failed", reason: a.msg || "No fix" };
  }
  if (c && c.status === "cancelled") return { ...base, state: "cancelled", step: 0, pct: 0, finished_at: req.cancelled_at || req.at, reason: "Cancelled before the T-SIM picked it up." };
  if (c && c.status === "error") return { ...base, state: "failed", step: 1, pct: 50, finished_at: c.done_at, reason: c.error || c.output || "Failed" };
  if (c && c.status === "done") return { ...base, state: "failed", step: 1, pct: 50, finished_at: c.done_at, reason: c.output || "The T-SIM finished without reporting a location." };
  if (c && c.status === "sent") {
    const lim = ((req.timeout_s || 180) + 270) * 1000;   // + wake, GNSS READY wait and upload
    const p = { ...base, step: 1, pct: 50, times: { ...base.times, 1: c.sent_at } };
    return now - Date.parse(c.sent_at) > lim ? { ...p, state: "timeout", reason: "The T-SIM took the request but no location came back." } : { ...p, state: "running" };
  }
  if (now - at > PROGRESS_TIMEOUT_MS) return { ...base, state: "timeout", step: 0, pct: 0, reason: "The T-SIM didn't wake to pick up the request." };
  return { ...base, state: "running", step: 0, pct: 10 };
}
// "set lat"/"set lon" pair sent to the repeater CLI.
export function locProgress(req, cmds = []) {
  if (!req || !req.ids) return { state: "idle" };
  const cs = req.ids.map((i) => (cmds || []).find((x) => x.id === i)).filter(Boolean);
  const res = { lat: req.lat, lon: req.lon, at: req.at, outputs: cs.map((c) => ({ cmd: c.cmd, status: c.status, output: cleanCli(c.output || c.error || "") })) };
  if (cs.some((c) => c.status === "cancelled")) return { ...res, state: "cancelled" };
  if (cs.length === req.ids.length && cs.every((c) => c.status === "done" || c.status === "error")) {
    const ok = cs.every((c) => c.status === "done" && /\bok\b/i.test(c.output || ""));
    return { ...res, state: ok ? "done" : "failed", finished_at: cs.map((c) => c.done_at).sort().pop() };
  }
  return { ...res, state: cs.some((c) => c.status === "sent") ? "sending" : "queued" };
}
// Console history shows only what the user typed (system commands still drive state, they're just hidden).
export const userCommands = (list) => (list || []).filter((c) => !c.sys && !c.cfg && !c.unsolicited && !isSysCmd(c.cmd)).map((c) => (isPrvSet(c.cmd) ? { ...c, cmd: redactCmd(c.cmd) } : c));
// T-SIM pulls queued console commands (text/plain, one "<id>\t<command>" per line). Marks them sent.
async function handleDeviceCommands(request, env, id) {
  const dev = await getDevice(env, id);
  const key = request.headers.get("X-Device-Key") || "";
  if (!dev || !dev.ingest_key || !safeEq(key, dev.ingest_key)) return json({ error: "unauthorized" }, 401);
  const settings = await getSettings(env, id);
  const list = (await kvJson(env, `cmds:${id}`)) || [];
  const now = new Date().toISOString();
  const sp = new URL(request.url).searchParams;
  const sysOnly = sp.get("sys") === "1";  // STATUS/REBOOT wakes: system commands only
  const wdWake = sp.get("wd") === "1";    // v1.7.2 watchdog wake: everything, plus a watchdog-only Heltec UPDATE
  const lat = (await kvJson(env, `telem:${id}:latest`)) || {};
  const expired = expireWdOnly(list);
  const pwrOk = fwAtLeast(lat.fw, "1.6.5");  // older firmware would pass PWRCFG to the repeater CLI
  const gpsOk = fwAtLeast(lat.fw, GPS_FW);   // older firmware would pass GPSFIX/GPSCFG to the repeater CLI
  const pending = list.filter((c) => c.status === "queued" && (c.sys || (!sysOnly && settings.console_enabled)) && (pwrOk || !/^pwrcfg\s/i.test(c.cmd || "")) && (gpsOk || !isGpsCmd(c.cmd)) && (fwAtLeast(lat.fw, CACHE_FW) || !/^cfgsnap\s/i.test(c.cmd || "")) && (fwAtLeast(lat.fw, WD_FW) || !/^wdcfg\s/i.test(c.cmd || "")) && wdOnlyOk(c, wdWake, lat.fw)).reverse().slice(0, cmdsPerWake(lat.fw));
  // never let the reply overflow the T-SIM's fetch buffer (a cut line would run a truncated command)
  let bytes = 0; const fits = []; for (const c of pending) { bytes += `${c.id}\t${c.cmd}\n`.length; if (bytes > (fwAtLeast(lat.fw, BATCH_FW) ? CMD_FETCH_BYTES : 1700)) break; fits.push(c); }
  pending.length = 0; pending.push(...fits);
  for (const c of pending) { c.status = "sent"; c.sent_at = now; }
  if (pending.length || expired) await putJson(env, `cmds:${id}`, list);
  const nowS = Math.floor(Date.now() / 1000) + 2;
  return new Response(pending.map((c) => `${c.id}\t${c.cmd.replace("{{now}}", String(nowS))}\n`).join(""), { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

// v1.7.0: list of read-only commands the T-SIM caches (text/plain, one per line).
async function handleCfgList(request, env, id) {
  const dev = await getDevice(env, id);
  const key = request.headers.get("X-Device-Key") || "";
  if (!dev || !dev.ingest_key || !safeEq(key, dev.ingest_key)) return json({ error: "unauthorized" }, 401);
  const vals = (await kvJson(env, `rptcfg:${id}`)) || {};
  return new Response(cfgListCmds(vals).join("\n") + "\n", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
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
    for (const k of [`device:${id}`, `state:${id}`, `source:${id}`, `release:${id}`, `telem:${id}:latest`, `telem:${id}:history`, `mesh:${id}`, `settings:${id}`, `cmds:${id}`, `tsimsrc:${id}`, `tsimrel:${id}`, `nicks:${id}`]) await env.STATE.delete(k);
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

// ---------- uploaded Heltec firmware (stored in KV, served to the T-SIM at /fw/<token>) ----------
// Heltec V3 = ESP32-S3, 8 MB flash, default_8MB.csv: app partition 0x330000 at 0x10000.
export const FW_APP_SLOT = 0x330000, FW_UPLOAD_MAX = 4 * 1024 * 1024, FW_UPLOADS_PER_DEVICE = 3, FW_CHIP_ID = 9;
export const FW_TOKEN_RE = /^[0-9a-f]{32}$/;
export const MERGED_NAME_RE = /-merged|freshinstall|factory/i;
const CHIP_NAMES = { 0: "ESP32", 2: "ESP32-S2", 5: "ESP32-C3", 9: "ESP32-S3", 12: "ESP32-C2", 13: "ESP32-C6", 16: "ESP32-H2" };
export const MERGED_WARN = "This is a full-erase (merged / fresh-install) image. Flashing it wipes the Heltec completely: its identity (private key), node name, all settings and passwords, the access list (ACL) and regions. Back up first, tick the acknowledgement and type ERASE to allow it.";
const kib = (n) => (n / 1024).toFixed(0) + " KB";
export const safeFwName = (n) => String(n || "").split(/[\\/]/).pop().replace(/[^A-Za-z0-9.+-]+/g, "_").replace(/^[._]+/, "").slice(0, 100) || "firmware.bin";
// Same rules as imageKind() in the T-SIM firmware (it picks the flash address from the contents, never the name).
export function analyzeFirmware(buf, name = "") {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), size = b.length;
  if (size < 4096) throw new Error("That file is too small to be Heltec firmware.");
  if (size > FW_UPLOAD_MAX) throw new Error(`That file is ${(size / 1048576).toFixed(2)} MB; the limit is ${FW_UPLOAD_MAX / 1048576} MB.`);
  const two = (o) => [b[o], b[o + 1]];
  const [h0, h1] = two(0), [p0, p1] = size > 0x8002 ? two(0x8000) : [0, 0], [a0, a1] = size > 0x10010 ? two(0x10000) : [0, 0], [q0, q1] = size > 0x7002 ? two(0x7000) : [0, 0];
  const app0 = h0 === 0xE9 && h1 >= 1 && h1 <= 16, ptMagic = p0 === 0xAA && p1 === 0x50, gapErased = p0 === 0xFF && p1 === 0xFF;
  const app10k = a0 === 0xE9 && a1 >= 1 && a1 <= 16, pt7 = q0 === 0xAA && q1 === 0x50;
  let kind, appOff;
  if (ptMagic || (app10k && gapErased)) { kind = "merged"; appOff = 0x10000; }
  else if (pt7 && app0) { kind = "merged-0x1000"; appOff = 0xF000; }
  else if (app0) { kind = "app"; appOff = 0; }
  else throw new Error("Not an ESP32 firmware image: it doesn't start with the ESP32 image byte 0xE9 and has no partition table. Pick the Heltec .bin file (not a .zip, .uf2 or .hex).");
  const ho = b[appOff] === 0xE9 ? appOff : 0, chipId = b[ho + 12] | (b[ho + 13] << 8), chip = CHIP_NAMES[chipId] || `unknown chip (id ${chipId})`;
  if (chipId !== FW_CHIP_ID) throw new Error(`This image is built for ${chip}, but the Heltec V3 is an ESP32-S3. Flashing it would leave the radio unbootable.`);
  const appSize = size - appOff;
  if (appSize > FW_APP_SLOT) throw new Error(`Too big for the Heltec's app partition: ${kib(appSize)} of app code, the partition holds ${kib(FW_APP_SLOT)}.`);
  const nameMerged = MERGED_NAME_RE.test(name), warnings = [];
  if (kind === "app" && nameMerged) warnings.push("The file name says merged / fresh install but the contents are an app-only image (the T-SIM writes it at 0x10000). It is still treated as a full erase to be safe; check you picked the right file.");
  if (kind !== "app" && !nameMerged) warnings.push("The file name doesn't say merged, but the contents are a merged (full flash) image with a bootloader and partition table.");
  return { kind, merged: kind !== "app" || nameMerged, chip, size, app_size: appSize, warnings };
}
const fwList = async (env, id) => (await kvJson(env, `fwup:${id}`)) || [];
export function targetMerged(src, rel, list = []) {
  if (src && src.upload) { const it = list.find((x) => x.token === src.upload); return !!(it && it.merged); }
  const name = (rel && rel.asset_name) || "";
  return MERGED_NAME_RE.test(name) || (!!src && src.enabled && /merged/i.test(src.asset_pattern || "")) || (!!src && !src.enabled && MERGED_NAME_RE.test(src.direct_url || ""));
}
async function handleFwUpload(request, env, dev) {
  const id = dev.id;
  if ((+request.headers.get("Content-Length") || 0) > FW_UPLOAD_MAX) return json({ error: `That file is too large (limit ${FW_UPLOAD_MAX / 1048576} MB).` }, 413);
  const list = await fwList(env, id);
  if (list.length >= FW_UPLOADS_PER_DEVICE) return json({ error: `You already have ${list.length} uploaded files (max ${FW_UPLOADS_PER_DEVICE}). Delete one first.` }, 409);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > FW_UPLOAD_MAX) return json({ error: `That file is too large (limit ${FW_UPLOAD_MAX / 1048576} MB).` }, 413);
  let raw = request.headers.get("X-File-Name") || ""; try { raw = decodeURIComponent(raw); } catch {}
  const name = safeFwName(raw);
  let info; try { info = analyzeFirmware(buf, name); } catch (e) { return json({ error: e.message }, 400); }
  const sha256 = hex(await crypto.subtle.digest("SHA-256", buf));
  let md5 = null; try { md5 = hex(await crypto.subtle.digest("MD5", buf)); } catch {}
  const dup = list.find((x) => x.sha256 === sha256);
  if (dup) return json({ uploaded: false, duplicate: true, item: dup, note: `This file is already uploaded as ${dup.name}.` });
  const token = randomHex(16);
  const item = { token, name, url: `${new URL(request.url).origin}/fw/${token}`, sha256, md5, ...info, uploaded_at: new Date().toISOString() };
  await env.STATE.put(`fwblob:${token}`, buf, { metadata: { id, size: info.size, sha256 } });
  list.unshift(item); await putJson(env, `fwup:${id}`, list);
  await logActivity(env, id, { type: "action", msg: `Firmware uploaded: ${name} (${info.size} bytes, ${info.merged ? "FULL-ERASE merged image" : "app-only"}, sha256 ${sha256.slice(0, 12)}…)` });
  return json({ uploaded: true, item }, 201);
}
async function handleFwDelete(request, env, dev) {
  const id = dev.id;
  let b = {}; try { b = await request.json(); } catch {}
  const list = await fwList(env, id), it = list.find((x) => x.token === b.token);
  if (!it) return json({ error: "No such uploaded file." }, 404);
  const st = await loadState(env, id), p = computeProgress("heltec", (await kvJson(env, `telem:${id}:history`)) || [], st);
  if ((p.state === "running") && st.last_update_sent && st.last_update_sent.url === it.url) return json({ error: "An update using this file is in progress. Wait for it to finish (or cancel it) before deleting the file." }, 409);
  await env.STATE.delete(`fwblob:${it.token}`);
  await putJson(env, `fwup:${id}`, list.filter((x) => x !== it));
  const src = await getSource(env, id);
  if (src.upload === it.token) { delete src.upload; await putJson(env, `source:${id}`, src); await env.STATE.delete(`release:${id}`); }
  await logActivity(env, id, { type: "action", msg: `Uploaded firmware deleted: ${it.name}` });
  return json({ deleted: true, source: src });
}
// Public download for the T-SIM: unguessable 128-bit token, no underscores, exact Content-Length, single Range supported.
async function handleFwDownload(request, env, token) {
  const nf = () => new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!FW_TOKEN_RE.test(token)) return nf();
  const value = await env.STATE.get(`fwblob:${token}`, { type: "arrayBuffer" });
  if (!value) return nf();
  const total = value.byteLength;
  const h = { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Content-Disposition": 'attachment; filename="firmware.bin"' };
  let status = 200, body = value;
  const m = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get("Range") || "").trim());
  if (m && (m[1] || m[2])) {
    let s, e;
    if (m[1]) { s = +m[1]; e = m[2] ? Math.min(+m[2], total - 1) : total - 1; } else { s = Math.max(0, total - +m[2]); e = total - 1; }
    if (s >= total || s > e) return new Response(null, { status: 416, headers: { ...h, "Content-Range": `bytes */${total}` } });
    body = value.slice(s, e + 1); status = 206; h["Content-Range"] = `bytes ${s}-${e}/${total}`;
  }
  h["Content-Length"] = String(body.byteLength);
  return new Response(request.method === "HEAD" ? null : body, { status, headers: h });
}
export function uploadImageRisk(rel, tsimFw) {
  if (fwAtLeast(tsimFw, "1.6.2") || rel.merged || !(rel.size > 1024 * 1024)) return null;
  return `Blocked for safety: ${rel.asset_name} is an app-only image of ${(rel.size / 1048576).toFixed(2)} MB. The current T-SIM firmware would write it at address 0x0 (over the Heltec's bootloader) and brick it. Update the T-SIM firmware to 1.6.2 or newer first (Update T-SIM firmware), then try again.`;
}

// ---------- repeater backup / restore ----------
export const BACKUP_FORMAT = "tsim-repeater-backup", BACKUP_VERSION = 1, BACKUPS_PER_DEVICE = 5, BACKUP_MAX_BYTES = 256 * 1024;
const PRV_RE = /\b([0-9a-fA-F]{128}|[0-9a-fA-F]{64})\b/, PRV_RE_G = /[0-9a-fA-F]{64,128}/g;
export const isPrvGet = (cmd) => /^get prv\.key\s*$/i.test(String(cmd || "").trim());
export const isPrvSet = (cmd) => /^set prv\.key\s/i.test(String(cmd || "").trim());
export const redactCmd = (cmd) => (isPrvSet(cmd) ? "set prv.key ••••••" : cmd);
export function parsePrvKey(out) { const r = cleanCli(out); if (!r || /error|unsupported|unknown/i.test(r)) return null; const m = r.match(PRV_RE); return m ? m[1].toLowerCase() : null; }
// Same parsers as the dashboard's region / ACL tables.
export function rgParse(raw) {
  const out = [], st = [];
  String(raw || "").split("\n").forEach((l) => {
    if (!l.trim() || /^(err|error|\?\?)/i.test(l.trim())) return;
    const ind = l.replace(/^\s*->\s?/, "").match(/^\s*/)[0].length, tok = l.trim().replace(/^->\s*/, "").split(/\s+/), home = /\^$/.test(tok[0]), name = tok[0].replace(/\^$/, "");
    if (!name || !/^(\*|[#A-Za-z0-9_.\-]+)$/.test(name)) return;
    while (st.length && st[st.length - 1].ind >= ind) st.pop();
    const parent = st.length ? st[st.length - 1].name : ""; st.push({ ind, name });
    out.push({ name, home, flood: /\bF\b/.test(tok.slice(1).join(" ")), parent, depth: st.length - 1 });
  });
  return out;
}
export function aclParse(raw) {
  const r = [];
  String(raw || "").split("\n").forEach((l) => {
    l = l.trim(); let m = l.match(/^([0-9A-Fa-f]{2})\s+([0-9A-Fa-f]{16,64})$/);
    if (m) return r.push({ pk: m[2].toUpperCase(), perm: parseInt(m[1], 16) & 3 });
    m = l.match(/([0-9A-Fa-f]{16,64})\W+([0-3])\b/); if (m) r.push({ pk: m[1].toUpperCase(), perm: +m[2] });
  });
  return r;
}
const cleanHome = (raw) => String(raw || "").replace(/^>\s*/, "").replace(/^home is\s*/i, "").trim();
const cleanDefault = (raw) => String(raw || "").replace(/^>\s*/, "").replace(/^default scope is\s*/i, "").replace("<null>", "").trim();
const SRC_FIELDS = ["enabled", "repo", "asset_pattern", "tag_prefix", "direct_url"];
export async function buildBackup(env, id, dev, includeKey) {
  const g = (k) => kvJson(env, k);
  const [cv, L, src, tsrc, settings, power, gcfg, cache, nicks, prv, mesh] = await Promise.all([g(`rptcfg:${id}`), g(`rptlist:${id}`), getSource(env, id), getTsimSource(env, id), getSettings(env, id), g(`power:${id}`), g(`gpscfg:${id}`), g(`cachecfg:${id}`), g(`nicks:${id}`), g(`prvkey:${id}`), g(`mesh:${id}`)]);
  const vals = cv || {}, lists = {}, settingsOut = {};
  for (const [k, v] of Object.entries(vals)) if (RPT_INDEX[k] && !RPT_INDEX[k].wo && v && v.value != null && v.value !== "") settingsOut[k] = { value: String(v.value), at: v.at || null };
  for (const k of ["regions", "home", "default", "acl", "sensors"]) { const x = (L || {})[k]; if (x && !x.error && x.raw) lists[k] = { raw: x.raw, at: x.at || null }; }
  const key = includeKey && prv && prv.key ? prv.key : null;
  const pw = ["guest.password", "bridge.secret"].filter((k) => settingsOut[k]);
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, created_at: new Date().toISOString(), device: { id, name: dev.name || id },
    sensitive: { private_key: !!key, passwords: pw, note: key || pw.length ? "SENSITIVE: anyone with this file can " + (key ? "impersonate this repeater (private key)" : "") + (key && pw.length ? " and " : "") + (pw.length ? "log in with its passwords" : "") + ". Keep it private." : "No private key or passwords." },
    repeater: { node_name: (mesh && mesh.node_name) || (vals.name && vals.name.value) || null, firmware: (mesh && mesh.heltec_fw) || null, settings: settingsOut, lists,
      regions: rgParse(lists.regions && lists.regions.raw), home: lists.home ? cleanHome(lists.home.raw) : null, default_scope: lists.default ? cleanDefault(lists.default.raw) : null, acl: aclParse(lists.acl && lists.acl.raw) },
    identity: { public_key: (vals["public.key"] && vals["public.key"].value) || null, private_key: key, private_key_read_at: key ? prv.at : null },
    dashboard: { update_source: Object.fromEntries(SRC_FIELDS.map((k) => [k, src[k]])), tsim_source: tsrc, settings: { console_enabled: !!settings.console_enabled, schedule_hours: settings.schedule_hours || 0 },
      power: power || null, gps: gcfg || null, settings_cache: cache || null, nicknames: nicks || {} },
  };
}
export function validateBackup(bk) {
  if (!bk || typeof bk !== "object" || bk.format !== BACKUP_FORMAT) throw new Error("That isn't a T-SIM repeater backup file.");
  if (bk.version !== BACKUP_VERSION) throw new Error(`Backup version ${bk.version} isn't supported (expected ${BACKUP_VERSION}).`);
  return bk;
}
const RESTORE_CMD_MAX = 160;
// Plan a restore: what differs between the backup and what the dashboard currently knows. cur = {vals, lists, src, tsrc, settings, nicks}.
export function restorePlan(bk, cur) {
  validateBackup(bk);
  const R = bk.repeater || {}, vals = cur.vals || {}, L = cur.lists || {}, skipped = [], plan = { dashboard: [], settings: [], regions: [], acl: [], identity: null, skipped };
  const D = bk.dashboard || {};
  if (D.update_source) for (const k of SRC_FIELDS) if (D.update_source[k] !== undefined && D.update_source[k] !== cur.src[k]) plan.dashboard.push({ field: "update_source." + k, label: "Update source: " + k, current: cur.src[k] ?? "", backup: D.update_source[k] });
  if (D.tsim_source) for (const k of ["mode", "repo", "asset", "url", "checksum"]) if (D.tsim_source[k] !== undefined && D.tsim_source[k] !== cur.tsrc[k]) plan.dashboard.push({ field: "tsim_source." + k, label: "T-SIM firmware source: " + k, current: cur.tsrc[k] ?? "", backup: D.tsim_source[k] });
  if (D.settings) for (const k of ["console_enabled", "schedule_hours"]) if (D.settings[k] !== undefined && D.settings[k] !== cur.settings[k]) plan.dashboard.push({ field: "settings." + k, label: k === "console_enabled" ? "Allow console commands" : "Scheduled check (hours)", current: cur.settings[k], backup: D.settings[k] });
  if (D.nicknames && JSON.stringify(D.nicknames) !== JSON.stringify(cur.nicks || {})) plan.dashboard.push({ field: "nicknames", label: "Neighbor nicknames", current: Object.keys(cur.nicks || {}).length + " saved", backup: Object.keys(D.nicknames).length + " saved" });
  let ps = null;
  for (const [k, v] of Object.entries(R.settings || {})) {
    const s = RPT_INDEX[k]; if (!s || s.ro || s.wo) continue;
    const val = String(v && typeof v === "object" ? v.value : v), now = vals[k] && vals[k].value != null ? String(vals[k].value) : null;
    if (now === val) continue;
    if (k === "radio.rxps" && val === "custom") { skipped.push({ what: s.label, why: "custom rx/sleep timing: set it in the console (set radio.rxps <rx_us> <sleep_us>)" }); continue; }
    let cmd; try { cmd = buildSettingCmd(k, val); } catch (e) { skipped.push({ what: s.label, why: e.message }); continue; }
    if (cmd.length > CMD_MAX_LEN) { skipped.push({ what: s.label, why: "value too long" }); continue; }
    const row = { key: k, label: s.label, current: s.type === "secret" && now ? "••••" : now, backup: s.type === "secret" ? "••••" : val, cmd, val, risk: settingRisky(s, val), ...(s.warn && settingRisky(s, val) ? { warn: s.warn } : {}) };
    if (k === "powersaving") ps = row; else plan.settings.push(row);
  }
  if (ps) plan.settings.push(ps);  // power saving last, so the rest still runs
  const bR = R.lists && R.lists.regions ? rgParse(R.lists.regions.raw) : (R.regions || []), cR = rgParse(L.regions && !L.regions.error ? L.regions.raw : ""), cMap = Object.fromEntries(cR.map((r) => [r.name, r]));
  const RG = /^(\*|[#A-Za-z0-9_.\-]{1,30})$/;
  for (const r of bR) {
    if (!RG.test(r.name)) { skipped.push({ what: "Region " + r.name, why: "invalid name" }); continue; }
    const c = cMap[r.name];
    if (!c && r.name !== "*") plan.regions.push({ cmd: `region put ${r.name}${r.parent && r.parent !== "*" ? " " + r.parent : ""}`, desc: `Add region ${r.name}${r.parent && r.parent !== "*" ? " under " + r.parent : ""}` });
    if (!c || c.flood !== r.flood) plan.regions.push({ cmd: `region ${r.flood ? "allowf" : "denyf"} ${r.name}`, desc: `${r.flood ? "Allow" : "Block"} flooding in ${r.name}`, risk: r.name === "*" });
  }
  const bHome = R.lists && R.lists.home ? cleanHome(R.lists.home.raw) : R.home, cHome = L.home && !L.home.error ? cleanHome(L.home.raw) : null;
  if (bHome && RG.test(bHome) && bHome !== cHome) plan.regions.push({ cmd: `region home ${bHome}`, desc: `Home region ${bHome}` });
  const bDef = R.lists && R.lists.default ? cleanDefault(R.lists.default.raw) : R.default_scope, cDef = L.default && !L.default.error ? cleanDefault(L.default.raw) : null;
  if (bDef != null && (bDef === "" || RG.test(bDef)) && bDef !== cDef && (R.lists && R.lists.default || R.default_scope != null)) plan.regions.push({ cmd: `region default ${bDef || "<null>"}`, desc: `Default scope ${bDef || "none"}` });
  if (plan.regions.length) { plan.regions.push({ cmd: "region save", desc: "Save regions" }); for (const [cmd, list] of [["region", "regions"], ["region home", "home"], ["region default", "default"]]) plan.regions.push({ cmd, list, desc: "Read back " + list }); }
  const bA = R.lists && R.lists.acl ? aclParse(R.lists.acl.raw) : (R.acl || []), cA = Object.fromEntries(aclParse(L.acl && !L.acl.error ? L.acl.raw : "").map((a) => [a.pk, a.perm]));
  for (const a of bA) {
    if (!/^[0-9A-F]{16,64}$/.test(a.pk) || ![1, 2, 3].includes(a.perm)) continue;
    if (cA[a.pk] !== a.perm) plan.acl.push({ cmd: `setperm ${a.pk} ${a.perm}`, desc: `${a.pk.slice(0, 8)}… → ${["none", "guest", "read/write", "admin"][a.perm]}`, risk: a.perm === 3 });
  }
  if (plan.acl.length) plan.acl.push({ cmd: "get acl", list: "acl", desc: "Read back the access list" });
  const I = bk.identity || {}, pk = String(I.private_key || "").trim().toLowerCase();
  if (pk) {
    if (!/^[0-9a-f]{64}([0-9a-f]{64})?$/.test(pk)) skipped.push({ what: "Private key", why: "not 64 or 128 hex characters" });
    else plan.identity = { public_key: I.public_key || null, current_public_key: (vals["public.key"] && vals["public.key"].value) || null,
      same: !!(I.public_key && vals["public.key"] && String(vals["public.key"].value).toUpperCase() === String(I.public_key).toUpperCase()),
      cmds: [{ cmd: `set prv.key ${pk}`, prv: true, risk: true, desc: "Restore the private key (identity)" }, { cmd: "reboot", desc: "Reboot the repeater so the identity takes effect" }] };
  }
  return plan;
}
// Public view of a plan (no private key, no command text for secrets).
export const planView = (p) => ({ dashboard: p.dashboard, settings: p.settings.map(({ val, ...r }) => ({ ...r, cmd: RPT_INDEX[r.key] && RPT_INDEX[r.key].type === "secret" ? r.cmd.replace(/\S+$/, "••••") : r.cmd })),
  regions: p.regions, acl: p.acl, identity: p.identity ? { public_key: p.identity.public_key, current_public_key: p.identity.current_public_key, same: p.identity.same, commands: ["set prv.key ••••••", "reboot"] } : null, skipped: p.skipped });
// Order repeater commands for the relay: settings (power saving last but before the reboot), regions, ACL, identity, reboot.
export function restoreCommands(plan, groups) {
  const out = [], set = groups.settings ? plan.settings : [], ps = set.filter((r) => r.key === "powersaving"), rest = set.filter((r) => r.key !== "powersaving");
  for (const r of rest) out.push({ cmd: r.cmd, val: r.val, risk: r.risk });
  if (groups.regions) for (const r of plan.regions) out.push({ cmd: r.cmd, op: true, ...(r.list ? { list: r.list } : {}), risk: !!r.risk });
  if (groups.acl) for (const r of plan.acl) out.push({ cmd: r.cmd, op: true, ...(r.list ? { list: r.list } : {}), risk: !!r.risk });
  const id = groups.identity && plan.identity ? plan.identity.cmds : [];
  if (id.length) out.push({ cmd: id[0].cmd, op: true, prv: true, risk: true });
  for (const r of ps) out.push({ cmd: r.cmd, val: r.val, risk: r.risk });
  if (id.length) out.push({ cmd: "reboot", op: true });
  return out.filter((c) => c.cmd.length <= RESTORE_CMD_MAX);
}
// Next relay part: at most one wake's worth (per-wake command count and the 6000-byte fetch limit) and the queue room.
export function nextRestorePart(cmds, room, perWake) {
  const take = []; let bytes = 0;
  for (const c of cmds) { if (take.length >= Math.min(room, perWake)) break; const n = `xxxxxxxx\t${c.cmd}\n`.length; if (bytes + n > CMD_FETCH_BYTES) break; bytes += n; take.push(c); }
  return take;
}
export const restorePartsLeft = (cmds, perWake) => { let n = 0, rest = cmds.slice(); while (rest.length) { const p = nextRestorePart(rest, CFG_MAX_QUEUE, perWake); if (!p.length) break; rest = rest.slice(p.length); n++; } return n; };
const backupIndex = async (env, id) => (await kvJson(env, `backups:${id}`)) || [];
const backupFileName = (id, bk) => `${id}-repeater-backup-${bk.created_at.slice(0, 19).replace(/[:T]/g, "-")}${bk.identity && bk.identity.private_key ? "-PRIVATE-KEY" : ""}.json`;
async function applyDashboardRestore(env, id, bk, cur) {
  const D = bk.dashboard || {}, done = [];
  if (D.update_source) { const src = validateSource({ ...cur.src, ...Object.fromEntries(SRC_FIELDS.filter((k) => D.update_source[k] !== undefined).map((k) => [k, D.update_source[k]])), upload: "" }); delete src.upload; await putJson(env, `source:${id}`, src); await env.STATE.delete(`release:${id}`); done.push("update source"); }
  if (D.tsim_source) { const t = validateTsimSource({ ...cur.tsrc, ...D.tsim_source }); await putJson(env, `tsimsrc:${id}`, t); await env.STATE.delete(`tsimrel:${id}`); done.push("T-SIM firmware source"); }
  if (D.settings) {
    const s = { ...cur.settings };
    if (typeof D.settings.console_enabled === "boolean") s.console_enabled = D.settings.console_enabled;
    if (SCHEDULE_CHOICES.includes(Number(D.settings.schedule_hours)) && Number(D.settings.schedule_hours) !== s.schedule_hours) { s.schedule_hours = Number(D.settings.schedule_hours); const st = (await kvJson(env, `state:${id}`)) || {}; st.last_sched_ts = Date.now(); await putJson(env, `state:${id}`, st); }
    await putJson(env, `settings:${id}`, s); done.push("console / schedule");
  }
  if (D.nicknames && typeof D.nicknames === "object") { let n = {}; for (const [h, v] of Object.entries(D.nicknames).slice(0, 200)) { try { n = setNick(n, h, v); } catch {} } await putJson(env, `nicks:${id}`, n); done.push("nicknames"); }
  return done;
}
async function backupApi(request, env, dev, action) {
  const id = dev.id;
  if (action === "backup-get" && request.method === "GET") {
    const bid = new URL(request.url).searchParams.get("bid") || "";
    if (!/^[0-9a-f]{8}$/.test(bid)) return json({ error: "bad id" }, 400);
    const bk = await kvJson(env, `backup:${id}:${bid}`); if (!bk) return json({ error: "No such backup." }, 404);
    return new Response(JSON.stringify(bk, null, 2), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${backupFileName(id, bk)}"` } });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!sameOrigin(request)) return json({ error: "bad origin" }, 403);
  let b = {}; try { b = await request.json(); } catch {}
  if (action === "backup-create") {
    const bk = await buildBackup(env, id, dev, b.include_key === true);
    const bid = randomHex(4), txt = JSON.stringify(bk);
    await env.STATE.put(`backup:${id}:${bid}`, txt);
    let idx = await backupIndex(env, id);
    idx.unshift({ bid, created_at: bk.created_at, private_key: !!bk.identity.private_key, passwords: bk.sensitive.passwords.length > 0, settings: Object.keys(bk.repeater.settings).length, bytes: txt.length, file: backupFileName(id, bk) });
    for (const old of idx.slice(BACKUPS_PER_DEVICE)) await env.STATE.delete(`backup:${id}:${old.bid}`);
    idx = idx.slice(0, BACKUPS_PER_DEVICE); await putJson(env, `backups:${id}`, idx);
    await logActivity(env, id, { type: "action", msg: `Backup created (${Object.keys(bk.repeater.settings).length} settings${bk.identity.private_key ? ", WITH private key" : ""})` });
    return json({ created: true, item: idx[0], backup: bk });
  }
  if (action === "backup-delete") {
    const idx = await backupIndex(env, id), it = idx.find((x) => x.bid === b.bid);
    if (!it) return json({ error: "No such backup." }, 404);
    await env.STATE.delete(`backup:${id}:${it.bid}`); await putJson(env, `backups:${id}`, idx.filter((x) => x !== it));
    return json({ deleted: true });
  }
  if (action === "prvkey-forget") { await env.STATE.delete(`prvkey:${id}`); await logActivity(env, id, { type: "action", msg: "Stored private key (for backups) deleted from the dashboard" }); return json({ deleted: true }); }
  const cur = async () => { const [vals, lists, src, tsrc, settings, nicks] = await Promise.all([kvJson(env, `rptcfg:${id}`), kvJson(env, `rptlist:${id}`), getSource(env, id), getTsimSource(env, id), getSettings(env, id), kvJson(env, `nicks:${id}`)]); return { vals: vals || {}, lists: lists || {}, src, tsrc, settings, nicks: nicks || {} }; };
  if (action === "backup-preview" || action === "restore-prepare") {
    if (JSON.stringify(b.backup || null).length > BACKUP_MAX_BYTES) return json({ error: "Backup file too large." }, 413);
    const c = await cur();
    let plan; try { plan = restorePlan(b.backup, c); } catch (e) { return json({ error: e.message }, 400); }
    const lat = (await kvJson(env, `telem:${id}:latest`)) || {}, per = cmdsPerWake(lat.fw);
    if (action === "backup-preview") return json({ plan: planView(plan), device: b.backup.device || null, created_at: b.backup.created_at || null, per_wake: per });
    const g = b.groups || {}, groups = { dashboard: g.dashboard === true, settings: g.settings === true, regions: g.regions === true, acl: g.acl === true, identity: g.identity === true };
    const cmds = restoreCommands(plan, groups);
    if (!groups.dashboard && !cmds.length) return json({ error: "Nothing selected to restore (or nothing differs)." }, 400);
    if (cmds.some((x) => x.risk) && b.risk_ok !== true) return json({ error: "This restore includes risky changes and needs confirmation.", risky: true }, 409);
    if (groups.identity && plan.identity && String(b.typed || "").trim().toUpperCase() !== "IDENTITY") return json({ error: "Type IDENTITY to confirm restoring the private key.", typed: "IDENTITY" }, 409);
    let done = [];
    if (groups.dashboard && plan.dashboard.length) { try { done = await applyDashboardRestore(env, id, b.backup, c); } catch (e) { return json({ error: "Dashboard config: " + e.message }, 400); } await logActivity(env, id, { type: "action", msg: `Restore: dashboard config applied (${done.join(", ") || "nothing"})` }); }
    let job = null;
    if (cmds.length) {
      job = { at: new Date().toISOString(), total: cmds.length, sent: 0, parts_sent: 0, groups: Object.keys(groups).filter((k) => groups[k] && k !== "dashboard"), cmds };
      await putJson(env, `restore:${id}`, job);
      await logActivity(env, id, { type: "action", msg: `Restore staged: ${cmds.length} repeater command(s) (${job.groups.join(", ")}); nothing sent until Send is pressed` });
    }
    return json({ applied: done, job: job ? restoreView(job, per) : null });
  }
  if (action === "restore-cancel") {
    await env.STATE.delete(`restore:${id}`);
    const list = (await kvJson(env, `cmds:${id}`)) || []; let n = 0;
    for (const x of list) if (x.restore && x.status === "queued") { x.status = "cancelled"; x.cmd = redactCmd(x.cmd); n++; }
    if (n) await putJson(env, `cmds:${id}`, list);
    return json({ cancelled: true, dequeued: n });
  }
  const settings = await getSettings(env, id);
  if (!settings.console_enabled) return json({ error: "The repeater console is off. Turn on \"Allow console commands\" in Repeater console first; this uses it." }, 403);
  if (psBlocks(await kvJson(env, `state:${id}`))) return json({ error: PS_NOTE + ". Turn power saving off first.", powersaving: true }, 409);
  const list = (await kvJson(env, `cmds:${id}`)) || [], lat = (await kvJson(env, `telem:${id}:latest`)) || {}, per = cmdsPerWake(lat.fw), now = new Date().toISOString();
  if (action === "prvkey-read") {
    if (b.confirm !== true) return json({ error: "confirm required" }, 400);
    if (list.some((x) => x.prv && isPrvGet(x.cmd) && (x.status === "queued" || x.status === "sent"))) return json({ error: "A private-key read is already waiting for the T-SIM." }, 409);
    list.unshift({ id: randomHex(4), cmd: "get prv.key", status: "queued", queued_at: now, cfg: true, op: true, prv: true });
    await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
    await logActivity(env, id, { type: "action", msg: "Reading the repeater private key for backup (serial console)" });
    const [o, c] = await manualSend(env, dev, "CMD", "CMD (read private key for backup)");
    return json({ queued: true, wake: { ...o, status: c } });
  }
  if (action === "restore-send") {
    const job = await kvJson(env, `restore:${id}`);
    if (!job || !job.cmds.length) return json({ error: "No restore is staged." }, 404);
    const room = CFG_MAX_QUEUE - list.filter((x) => x.status === "queued").length;
    const part = nextRestorePart(job.cmds, room, per);
    if (!part.length) return json({ error: `The command queue is full (max ${CFG_MAX_QUEUE}). Wait for the current commands to run, or cancel them in Repeater console.` }, 429);
    for (const a of part) list.unshift({ id: randomHex(4), cmd: a.cmd, status: "queued", queued_at: now, cfg: true, restore: true, ...(a.op ? { op: true } : {}), ...(a.list ? { list: a.list } : {}), ...(a.val !== undefined ? { val: a.val } : {}), ...(a.prv ? { prv: true } : {}) });
    await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
    job.cmds = job.cmds.slice(part.length); job.sent += part.length; job.parts_sent++;
    if (job.cmds.length) await putJson(env, `restore:${id}`, job); else await env.STATE.delete(`restore:${id}`);
    const label = `CMD (restore part ${job.parts_sent}${job.cmds.length ? " of " + (job.parts_sent + restorePartsLeft(job.cmds, per)) : ", last"})`;
    await logActivity(env, id, { type: "action", msg: `Restore: queued ${part.length} command(s): ${part.map((a) => redactCmd(a.cmd).replace(/(guest\.password|bridge\.secret) .*/, "$1 ••••")).join("; ").slice(0, 200)}` });
    const [o, c] = await manualSend(env, dev, "CMD", label);
    return json({ queued: part.length, remaining: job.cmds.length, job: job.cmds.length ? restoreView(job, per) : null, wake: { ...o, status: c } });
  }
  return json({ error: "not found" }, 404);
}
export const restoreView = (job, per) => job ? { at: job.at, total: job.total, sent: job.sent, remaining: job.cmds.length, parts_sent: job.parts_sent, parts_left: restorePartsLeft(job.cmds, per), next: nextRestorePart(job.cmds, CFG_MAX_QUEUE, per).length, groups: job.groups } : null;
export const BACKUP_ACTIONS = ["backup-get", "backup-create", "backup-delete", "backup-preview", "restore-prepare", "restore-send", "restore-cancel", "prvkey-read", "prvkey-forget"];

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
    const [gps, gcfg, greq, lreq, nicks, adcSt] = await Promise.all([kvJson(env, `gps:${id}`), kvJson(env, `gpscfg:${id}`), kvJson(env, `gpsreq:${id}`), kvJson(env, `locreq:${id}`), kvJson(env, `nicks:${id}`), kvJson(env, `adc:${id}`)]);
    const rptq = {}; for (const c of cmds || []) if (c.cfg && !c.op && (c.status === "queued" || c.status === "sent")) { const ps = parseSettingReply(c.cmd, "x"); if (ps && !rptq[ps.key]) rptq[ps.key] = c.status; }
    const rptVals = (await kvJson(env, `rptcfg:${id}`)) || {}, rptLists = (await kvJson(env, `rptlist:${id}`)) || {};
    const rptOpsL = (cmds || []).filter((c) => c.op && !c.restore && !c.prv && (c.status === "queued" || c.status === "sent")), rptOpsQ = rptOpsL.length;
    const [fwl, bkIdx, prvK, rjob] = await Promise.all([fwList(env, id), backupIndex(env, id), kvJson(env, `prvkey:${id}`), kvJson(env, `restore:${id}`)]);
    const perW = cmdsPerWake(latest && latest.fw);
    const fwup = { items: fwl, selected: source.upload || "", target_merged: targetMerged(source, rel, fwl), slot: FW_APP_SLOT, max: FW_UPLOAD_MAX, per_device: FW_UPLOADS_PER_DEVICE };
    const rq = (cmds || []).filter((c) => c.restore && (c.status === "queued" || c.status === "sent")).length;
    const backup = { items: bkIdx, per_device: BACKUPS_PER_DEVICE, prvkey: prvK ? { at: prvK.at, hint: prvK.key.slice(0, 4) + "…" + prvK.key.slice(-4) } : null,
      prv_pending: (cmds || []).some((c) => c.prv && isPrvGet(c.cmd) && (c.status === "queued" || c.status === "sent")), restore: restoreView(rjob, perW), restore_inflight: rq,
      settings_known: Object.keys(rptVals).filter((k) => RPT_INDEX[k] && rptVals[k] && rptVals[k].value != null).length };
    const adcq = (cmds || []).filter((c) => /^(get|set) adc\.multiplier\b/i.test(c.cmd || "") && (c.status === "queued" || c.status === "sent"));
    const gq = (cmds || []).find((c) => /^gpscfg\s/i.test(c.cmd || "") && (c.status === "queued" || c.status === "sent"));
    const gpsInfo = { fix: (gps && gps.fix) || null, attempt: (gps && gps.attempt) || null, settings: { ...DEFAULT_GPS, ...(gcfg || {}) }, settings_pending: gq ? gq.status : null,
      supported: fwAtLeast(latest && latest.fw, GPS_FW), progress: gpsProgress(greq, cmds, gps || {}), location: locProgress(lreq, cmds) };
    const [wdLast, wdCfgS] = await Promise.all([kvJson(env, `wd:${id}`), kvJson(env, `wdcfg:${id}`)]);
    const wdq = (cmds || []).find((c) => /^wdcfg\s/i.test(c.cmd || "") && (c.status === "queued" || c.status === "sent"));
    const watchdog = { settings: { ...DEFAULT_WD, ...(wdCfgS || {}) }, last: wdLast || null, pending: wdq ? wdq.status : null, supported: fwAtLeast(latest && latest.fw, WD_FW), hwake_supported: fwAtLeast(latest && latest.fw, HWAKE_FW),
      checkin: checkinInfo(latest || {}, wdLast, wdCfgS, settings.schedule_hours || 0) };
    return json({ watchdog, cache: { settings: { ...DEFAULT_CACHE, ...((await kvJson(env, `cachecfg:${id}`)) || {}) }, last: (await kvJson(env, `rptcache:${id}`)) || null, supported: fwAtLeast(latest && latest.fw, CACHE_FW), pending: (cmds || []).some((c) => /^cfgsnap\s/i.test(c.cmd || "") && (c.status === "queued" || c.status === "sent")) }, rpt: { vals: rptVals, queued: rptq, lists: rptLists, ops_pending: rptOpsQ, ops_q: rptOpsL.map((c) => redactCmd(c.cmd)), per_wake: cmdsPerWake(latest && latest.fw) }, adc: { ...(adcSt || {}), pending: adcq.length ? adcq[0].status : null }, nicks: nicks || {}, gps: gpsInfo, device: { id, name: dev.name }, source, latest, mesh, settings, schedule, commands: userCommands(cmds),
      power: { settings: pwr, pending: pq ? pq.status : null, wake: pwr.wake || null, event: (st && st.power_event) || null, ratio: LB_RATIO }, history: history || [], updates: {
      heltec_fw: s.heltec_fw || null, latest_available: rel, last_update_result: s.last_update_result || null,
      last_update_sent: s.last_update_sent || null, last_action: s.last_action || null },
      powersaving: { on: s.heltec_powersaving === true, ondemand: s.serial_ondemand === true, blocks: psBlocks(s), unknown: s.heltec_powersaving === null, at: s.powersaving_at || null, source: s.powersaving_source || null },
      tsim: { fw: (latest && latest.fw) || null, source: tsimSrc, latest_available: tsimRel, last_ota: s.tsim_last_ota || null, last_sent: s.tsim_update_sent || null },
      progress: { heltec: computeProgress("heltec", history || [], s), tsim: computeProgress("tsim", history || [], s) }, presets: FW_PRESETS,
      update_status: statuses(latest, mesh, s, history, rel, tsimRel), fwup, backup });
  }
  if (action === "source" && request.method === "GET") return json(await getSource(env, id));
  if (BACKUP_ACTIONS.includes(action)) return backupApi(request, env, dev, action);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!sameOrigin(request)) return json({ error: "bad origin" }, 403);
  if (action === "fw-upload") return handleFwUpload(request, env, dev);
  if (action === "fw-delete") return handleFwDelete(request, env, dev);
  if (action === "source") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const cur0 = await getSource(env, id); delete cur0.upload;
    let src; try { src = validateSource({ ...cur0, ...b }); } catch (e) { return json({ error: e.message }, 400); }
    let up = null;
    if (src.upload) {
      up = (await fwList(env, id)).find((x) => x.token === src.upload);
      if (!up) return json({ error: "That uploaded file no longer exists." }, 404);
      if (up.merged && b.merged_ack !== true) return json({ error: MERGED_WARN, merged: true }, 409);
    }
    await putJson(env, `source:${id}`, src);
    await env.STATE.delete(`release:${id}`);
    await logActivity(env, id, { type: "action", msg: up ? `Update source changed: uploaded file ${up.name}${up.merged ? " (FULL-ERASE merged image)" : ""}` : `Update source changed: ${src.enabled ? src.repo + " " + (src.tag_prefix ? src.tag_prefix + "* " : "") + src.asset_pattern : "disabled"}${src.direct_url ? " (direct URL set)" : ""}` });
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
    if (psBlocks(pst)) return json({ error: PS_NOTE, powersaving: true }, 409);
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
  if (action === "rpt-read" || action === "rpt-save" || action === "rpt-action" || action === "rpt-ops") {
    const settings = await getSettings(env, id);
    if (!settings.console_enabled) return json({ error: "The repeater console is off. Turn on \"Allow console commands\" in Repeater console first; repeater settings use it." }, 403);
    if (psBlocks(await kvJson(env, `state:${id}`))) return json({ error: PS_NOTE + ". Turn power saving off first.", powersaving: true }, 409);
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const list = (await kvJson(env, `cmds:${id}`)) || [];
    const queuedCmds = new Set(list.filter((c) => c.status === "queued").map((c) => c.cmd));
    let add = [];
    if (action === "rpt-read") {
      const keys = Array.isArray(b.keys) && b.keys.length ? b.keys.map(String) : rptReadAllKeys((await kvJson(env, `rptcfg:${id}`)) || {});
      for (const k of keys) { if (!RPT_READ_KEYS.includes(k)) return json({ error: `Unknown setting "${k}"` }, 400); const cmd = rptGetCmd(k); if (!queuedCmds.has(cmd)) add.push({ cmd }); }
      if (!add.length) return json({ queued: 0, note: "already queued" });
    } else if (action === "rpt-save") {
      const ch = b.changes && typeof b.changes === "object" ? Object.entries(b.changes) : [];
      if (!ch.length) return json({ error: "Nothing to change" }, 400);
      if (ch.length > CFG_MAX_QUEUE) return json({ error: "Too many changes at once" }, 400);
      const errs = [];
      for (const [k, v] of ch) {
        let cmd; try { cmd = buildSettingCmd(k, v); } catch (e) { errs.push(e.message); continue; }
        if (cmd.length > CMD_MAX_LEN) { errs.push(`${RPT_INDEX[k].label} is too long`); continue; }
        const s = RPT_INDEX[k];
        if (settingRisky(s, v) && b.risk_ok !== true) return json({ error: `${s.label}: ${s.warn && !s.risk ? s.warn : "risky change"}. Needs confirmation.`, risky: true }, 409);
        if (s.typed && String(b.typed || "").trim().toUpperCase() !== s.typed) return json({ error: `Type ${s.typed} to confirm the ${s.label.toLowerCase()}`, typed: s.typed }, 409);
        add.push({ cmd, val: s.wo ? undefined : (s.type === "sel" ? String(v) : s.type === "num" ? String(+v) : String(v)) });
      }
      if (errs.length) return json({ error: errs.join(". ") }, 400);
      add.sort((x, y) => (/^powersaving on/.test(x.cmd) ? 1 : 0) - (/^powersaving on/.test(y.cmd) ? 1 : 0));  // power saving last, so the rest still runs
    } else {
      const ops = action === "rpt-action" ? [{ op: b.act }] : Array.isArray(b.ops) ? b.ops.slice(0, 10) : [];
      if (!ops.length) return json({ error: "Nothing to do" }, 400);
      try { for (const o of ops) add.push(...buildRptOp(o)); } catch (e) { return json({ error: e.message }, 400); }
      if (add.some((a) => a.risk) && b.risk_ok !== true) return json({ error: "This change needs confirmation", risky: true }, 409);
      if (add.some((a) => a.cmd.length > CMD_MAX_LEN)) return json({ error: "Command too long" }, 400);
      const seen = new Set(); add = add.filter((a) => (a.list ? (seen.has(a.cmd) ? false : seen.add(a.cmd)) : true));
      add = add.map((a) => ({ ...a, op: true }));
    }
    if (list.filter((c) => c.status === "queued").length + add.length > CFG_MAX_QUEUE) return json({ error: `Too many queued commands (max ${CFG_MAX_QUEUE}). Wait for the current ones or cancel them in Repeater console.` }, 429);
    const now = new Date().toISOString();
    for (const a of add) list.unshift({ id: randomHex(4), cmd: a.cmd, status: "queued", queued_at: now, cfg: true, ...(a.op ? { op: true } : {}), ...(a.list ? { list: a.list } : {}), ...(a.val !== undefined ? { val: a.val } : {}) });
    await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
    await logActivity(env, id, { type: "action", msg: action === "rpt-read" ? `Repeater settings: reading ${add.length} value(s)` : action === "rpt-save" ? `Repeater settings: ${add.map((a) => a.cmd.startsWith("password") || a.cmd.includes("guest.password") ? a.cmd.split(" ").slice(0, 2).join(" ") + " ••••" : a.cmd).join("; ").slice(0, 200)}` : `Repeater: ${add.map((a) => a.cmd.replace("{{now}}", "(now)")).join("; ").slice(0, 200)}` });
    const [o, c] = await manualSend(env, dev, "CMD", "CMD (repeater settings)");
    return json({ queued: add.length, wakes_needed: Math.ceil((list.filter((x) => x.status === "queued").length) / cmdsPerWake(((await kvJson(env, `telem:${id}:latest`)) || {}).fw)), wake: { ...o, status: c } });
  }
  if (action === "adc-cal") {
    const settings = await getSettings(env, id);
    if (!settings.console_enabled) return json({ error: "The repeater console is off. Turn on \"Allow console commands\" in Repeater console first; calibration uses it." }, 403);
    if (psBlocks(await kvJson(env, `state:${id}`))) return json({ error: PS_NOTE + ". Calibration needs the console, so turn power saving off first.", powersaving: true }, 409);
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const a = (await kvJson(env, `adc:${id}`)) || {}, mesh = (await kvJson(env, `mesh:${id}`)) || {};
    let cmds;
    if (b.op === "read") cmds = ["get adc.multiplier"];
    else if (b.op === "reset") cmds = ["set adc.multiplier 0", "get adc.multiplier"];
    else if (b.op === "set" || b.op === "preview") {
      if (a.supported === false) return json({ error: ADC_UNSUPPORTED, unsupported: true }, 409);
      const mv = mesh.core && mesh.core.battery_mv;
      if (a.set_at && mesh.received_at && mesh.received_at < a.set_at) return json({ error: "The repeater's battery reading is older than the last calibration change. Press Request status for a fresh reading, then try again." }, 409);
      let v; try { v = calcAdcMultiplier(a.mult, b.meter_v, mv / 1000); } catch (e) { return json({ error: e.message }, 400); }
      const info = { current: a.mult, reported_v: mv / 1000, meter_v: Number(b.meter_v), new_mult: v, reading_at: mesh.received_at || null };
      if (b.op === "preview") return json({ preview: info });
      cmds = ["set adc.multiplier " + v.toFixed(3), "get adc.multiplier"];
      b.info = info;
    } else return json({ error: "unknown op" }, 400);
    const list = (await kvJson(env, `cmds:${id}`)) || [];
    if (list.filter((c) => c.status === "queued").length + cmds.length > CMD_MAX_PENDING) return json({ error: `Too many queued console commands (max ${CMD_MAX_PENDING}). Cancel some first.` }, 429);
    const now = new Date().toISOString();
    for (const cmd of cmds) list.unshift({ id: randomHex(4), cmd, status: "queued", queued_at: now });
    await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
    await logActivity(env, id, { type: "action", msg: b.op === "read" ? "Repeater battery calibration: reading multiplier" : b.op === "reset" ? "Repeater battery calibration: reset to board default" : `Repeater battery calibration: multimeter ${b.info.meter_v} V vs reported ${b.info.reported_v.toFixed(2)} V → multiplier ${b.info.new_mult}` });
    const [o, c] = await manualSend(env, dev, "CMD", "CMD (battery calibration)");
    return json({ queued: cmds, preview: b.info || null, wake: { ...o, status: c } });
  }
  if (action === "wake-cmd") {
    const settings = await getSettings(env, id);
    if (!settings.console_enabled) return json({ error: "Repeater console is off for this device." }, 403);
    if (psBlocks(await kvJson(env, `state:${id}`))) return json({ error: PS_NOTE, powersaving: true }, 409);
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
  if (action === "gps-fix" || action === "gps-cancel") {
    const [cmds, gps, greq, gcfg, lat] = await Promise.all([kvJson(env, `cmds:${id}`), kvJson(env, `gps:${id}`), kvJson(env, `gpsreq:${id}`), kvJson(env, `gpscfg:${id}`), kvJson(env, `telem:${id}:latest`)]);
    const list = cmds || [];
    const p = gpsProgress(greq, list, gps || {});
    if (action === "gps-cancel") {
      if (p.state !== "running" && p.state !== "timeout") return json({ cancelled: false, error: "No location request is in progress." }, 409);
      const c = list.find((x) => x.id === greq.id);
      if (c && c.status === "queued") { c.status = "cancelled"; await putJson(env, `cmds:${id}`, list); await putJson(env, `gpsreq:${id}`, { ...greq, cancelled_at: new Date().toISOString() }); return json({ cancelled: true, note: "Cancelled. Nothing was sent to the T-SIM." }); }
      await putJson(env, `gpsreq:${id}`, {});  // already picked up: stop tracking it
      return json({ cancelled: true, note: "Stopped waiting. The T-SIM had already started, so a location may still arrive." });
    }
    if (!fwAtLeast(lat && lat.fw, GPS_FW)) return json({ sent: false, error: `Location needs T-SIM firmware ${GPS_FW} or newer. Update the T-SIM firmware first.` }, 409);
    const retry = await bodyRetry(request);
    if (p.state === "running") return json({ sent: false, duplicate: true, error: `A location request is already ${p.step ? "running" : "waiting for the T-SIM to wake"}. No new text was sent. Use Cancel first if you want to stop it.` }, 409);
    const entry = { id: randomHex(4), cmd: "GPSFIX", sys: true, status: "queued", queued_at: new Date().toISOString() };
    const [o, code] = await manualSend(env, dev, "CMD", retry ? "Get location retry" : "Get location");
    if (o.sent) {
      for (const c of list) if (c.status === "queued" && /^gpsfix\b/i.test(c.cmd || "")) c.status = "cancelled";
      list.unshift(entry); await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
      await putJson(env, `gpsreq:${id}`, { id: entry.id, at: entry.queued_at, timeout_s: { ...DEFAULT_GPS, ...(gcfg || {}) }.timeout_s, retry });
    }
    return json({ ...o, queued: o.sent ? entry : null }, code);
  }
  if (action === "nick") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    let o; try { o = setNick(await kvJson(env, `nicks:${id}`), b.hash, b.name); } catch (e) { return json({ error: e.message }, 400); }
    await putJson(env, `nicks:${id}`, o);
    return json({ saved: true, nicks: o });
  }
  if (action === "cache-settings") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const cur = { ...DEFAULT_CACHE, ...((await kvJson(env, `cachecfg:${id}`)) || {}) };
    const c = { en: b.en !== undefined ? b.en === true : cur.en, int_h: b.int_h !== undefined ? Number(b.int_h) : cur.int_h };
    if (![1, 3, 6, 12, 24, 48, 168].includes(c.int_h)) return json({ error: "Pick an interval" }, 400);
    const lat = (await kvJson(env, `telem:${id}:latest`)) || {};
    if (!fwAtLeast(lat.fw, CACHE_FW)) return json({ error: `Needs T-SIM firmware ${CACHE_FW} or newer. Update the T-SIM firmware first.` }, 409);
    await putJson(env, `cachecfg:${id}`, c);
    const list = (await kvJson(env, `cmds:${id}`)) || [];
    for (const x of list) if (x.status === "queued" && /^cfgsnap\s/i.test(x.cmd || "")) x.status = "cancelled";
    const entry = { id: randomHex(4), cmd: cacheCmd(c, b.now === true), sys: true, status: "queued", queued_at: new Date().toISOString() };
    list.unshift(entry); await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
    let wake = null;
    if (b.now === true) { const [o, cc] = await manualSend(env, dev, "CMD", "CMD (settings cache refresh)"); wake = { ...o, status: cc }; }
    await logActivity(env, id, { type: "action", msg: `Settings cache: ${c.en ? "ON every " + c.int_h + " h" : "off"}${b.now ? ", refresh now" : " (applied at next wake)"}` });
    return json({ saved: true, settings: c, queued: entry, wake });
  }
  if (action === "watchdog-settings") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const cur = (await kvJson(env, `wdcfg:${id}`)) || {};
    let w; try { w = validateWd(cur, b); } catch (e) { return json({ error: e.message }, 400); }
    const lat = (await kvJson(env, `telem:${id}:latest`)) || {};
    if (!fwAtLeast(lat.fw, WD_FW)) return json({ error: `Needs T-SIM firmware ${WD_FW} or newer. Update the T-SIM firmware first.` }, 409);
    if (b.hwake !== undefined && !fwAtLeast(lat.fw, HWAKE_FW)) return json({ error: `The Heltec reboot wake needs T-SIM firmware ${HWAKE_FW} or newer.` }, 409);
    const cmd = wdCfgCmd(w);
    if (cur.applied_at && cmd === wdCfgCmd({ ...DEFAULT_WD, ...cur })) return json({ saved: true, unchanged: true, settings: { ...w, applied_at: cur.applied_at }, queued: null, wake: null });
    const list = (await kvJson(env, `cmds:${id}`)) || [];
    for (const x of list) if (x.status === "queued" && /^wdcfg\s/i.test(x.cmd || "")) x.status = "cancelled";  // newest settings win
    const entry = { id: randomHex(4), cmd, sys: true, status: "queued", queued_at: new Date().toISOString() };
    list.unshift(entry); await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
    await putJson(env, `wdcfg:${id}`, { ...w, updated_at: entry.queued_at, applied_at: null });
    let wake = null;
    if (b.send === true) { const [o, cc] = await manualSend(env, dev, "STATUS", "Deliver watchdog settings (STATUS)"); wake = { ...o, status: cc }; }
    await logActivity(env, id, { type: "action", msg: `Watchdog: ${w.int_min ? "check every " + (w.int_min >= 60 ? w.int_min / 60 + " h" : w.int_min + " min") : "off"}, heartbeat ${w.hb ? "every check" : "after recoveries only"}, stored texts on timer wakes ${w.sms ? "run" : "left for the next text"}${w.hwake !== undefined ? `, Heltec reboot wake ${w.hwake ? "on" : "off"}` : ""}${b.send ? "" : " (applied at next wake)"}` });
    return json({ saved: true, settings: w, queued: entry, wake });
  }
  if (action === "gps-settings") {
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const cur = { ...DEFAULT_GPS, ...((await kvJson(env, `gpscfg:${id}`)) || {}) };
    let g; try { g = validateGps(cur, b); } catch (e) { return json({ error: e.message }, 400); }
    await putJson(env, `gpscfg:${id}`, g);
    const list = (await kvJson(env, `cmds:${id}`)) || [];
    for (const c of list) if (c.status === "queued" && /^gpscfg\s/i.test(c.cmd || "")) c.status = "cancelled";  // newest settings win
    const entry = { id: randomHex(4), cmd: gpsCfgCmd(g), sys: true, status: "queued", queued_at: new Date().toISOString() };
    list.unshift(entry); await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
    await logActivity(env, id, { type: "action", msg: `Location settings: auto on check-in ${g.auto ? "ON" : "off"}, timeout ${g.timeout_s}s (applied at next wake)` });
    return json({ saved: true, settings: g, queued: entry });
  }
  if (action === "set-location") {
    let b = {}; try { b = await request.json(); } catch {}
    if (b.confirm !== true) return json({ error: "confirm required" }, 400);
    const [gps, cmds, lreq, pst] = await Promise.all([kvJson(env, `gps:${id}`), kvJson(env, `cmds:${id}`), kvJson(env, `locreq:${id}`), loadState(env, id)]);
    const f = gps && gps.fix;
    if (!f) return json({ error: "No GPS location yet. Press Get location on the T-SIM tab first." }, 409);
    if (psBlocks(pst)) return json({ error: PS_NOTE, powersaving: true }, 409);
    const list = cmds || [];
    const lp = locProgress(lreq, list);
    if (lp.state === "queued" || lp.state === "sending") return json({ error: "The repeater location is already being set. Wait for the result." }, 409);
    const now = new Date().toISOString();
    const a = { id: randomHex(4), cmd: `set lat ${f.lat.toFixed(6)}`, sys: true, loc: true, status: "queued", queued_at: now };
    const o2 = { id: randomHex(4), cmd: `set lon ${f.lon.toFixed(6)}`, sys: true, loc: true, status: "queued", queued_at: now };
    const [o, code] = await manualSend(env, dev, "CMD", "Set repeater location");
    if (o.sent) {
      list.unshift(a); list.unshift(o2); await putJson(env, `cmds:${id}`, list.slice(0, CMD_HISTORY));
      await putJson(env, `locreq:${id}`, { ids: [a.id, o2.id], at: now, lat: f.lat, lon: f.lon });
    }
    return json({ ...o, queued: o.sent ? [a, o2] : null }, code);
  }
  if (action === "status") { const [o, c] = await manualSend(env, dev, "STATUS", "STATUS"); return json(o, c); }
  if (action === "reboot") { const [o, c] = await manualSend(env, dev, "REBOOT", "REBOOT"); return json(o, c); }
  if (action === "update-latest") {
    let rel;
    const retry = await bodyRetry(request);
    const d = await dupeCheck(env, id, "heltec", retry); if (d) return json({ sent: false, error: d, duplicate: true }, 409);
    const prevSent = ((await kvJson(env, `state:${id}`)) || {}).last_update_sent;
    if (retry && prevSent && prevSent.url) rel = { url: prevSent.url, asset_name: prevSent.asset_name, tag: prevSent.tag, merged: !!prevSent.merged, size: prevSent.size, via: prevSent.via };
    else try { ({ rel } = await resolveTarget(env, id)); } catch (e) { return json({ sent: false, error: e.message }, 502); }
    if (rel.skipped) return json({ sent: false, error: rel.skipped }, 404);
    const merged = rel.merged === true || MERGED_NAME_RE.test(rel.asset_name || "");
    if (merged) {
      let ub = {}; try { ub = await request.clone().json(); } catch {}
      if (ub.erase_ok !== true || String(ub.typed || "").trim().toUpperCase() !== "ERASE") return json({ sent: false, merged: true, needs_erase_confirm: true, error: MERGED_WARN }, 409);
    }
    const tfw = ((await kvJson(env, `telem:${id}:latest`)) || {}).fw;
    const risk = rel.via === "upload" ? uploadImageRisk(rel, tfw) : await heltecImageRisk(rel.url, tfw);
    if (risk) { await logActivity(env, id, { type: "action", msg: risk }); return json({ sent: false, error: risk, blocked: true }, 409); }
    if (!(retry && prevSent && prevSent.url)) await putJson(env, `release:${id}`, { ...rel, checked_at: new Date().toISOString() });
    const [o, c] = await manualSend(env, dev, buildUpdateBody(rel.url), `UPDATE ${retry ? "retry " : ""}${merged ? "FULL ERASE " : ""}${rel.via === "upload" ? "uploaded " : ""}${rel.asset_name}`, async (st) => {
      st.last_update_sent = { at: new Date().toISOString(), asset_name: rel.asset_name, tag: rel.tag, url: rel.url, retry, ...(merged ? { merged: true } : {}), ...(rel.via === "upload" ? { via: "upload", size: rel.size, sha256: rel.sha256, md5: rel.md5 } : {}) };
    });
    // v1.7.2 backup: also queue it for the next watchdog check-in, in case the text never reaches the T-SIM.
    let wdq = null;
    if (c !== 429 && c !== 400 && fwAtLeast(tfw, WDCMD_FW)) {
      const list = (await kvJson(env, `cmds:${id}`)) || [];
      wdq = queueWdUpdate(list, rel.url); await putJson(env, `cmds:${id}`, list);
    }
    return json({ ...o, release: rel, ...(wdq ? { wd_backup: wdq.id } : {}) }, c);
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
      powersaving: psBlocks(st), console_enabled: settings.console_enabled, schedule_hours: settings.schedule_hours,
      update_status: statuses(L, mesh, st || {}, hist, rel, trel),
      progress: { heltec: { state: ph.state, step: ph.step, pct: ph.pct, finished_at: ph.finished_at }, tsim: { state: pt.state, step: pt.step, pct: pt.pct, finished_at: pt.finished_at } } });
  }
  return json({ account: { kind: acc.kind, id: acc.id, name: acc.name }, devices: out });
}

// ---------- update status (installed vs last check) ----------
export function verOf(x) { const m = String(x || "").match(/v?(\d+)\.(\d+)(?:\.(\d+))?/); return m ? [+m[1], +m[2], +(m[3] || 0)] : null; }
const vcmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const vstr = (v) => "v" + v.join(".");
// Firmware identity, so different firmware families are never compared by raw numbers (EasySkyMesh "PowerSaving17.1.6" is
// MeshCore 1.17.1 + their revision 6, not version 17). family + MeshCore base version + build commit when present.
// vX.Y.Z-powersaving and the older release names (OLD_PS_NAME) are the same firmware line (serial.ondemand is a feature).
export const FW_FAMILY_NAMES = { easyskymesh: "EasySkyMesh PowerSaving", "meshcore-serial": "MeshCore + serial", "meshcore-powersaving": "MeshCore + power saving", meshcore: "stock MeshCore" };
export function fwIdent(x) {
  const s = String(x || ""); if (!s) return null;
  const cm = s.match(/(?:^|[-_ ])((?=[0-9]*[a-f])[0-9a-f]{7,40})(?=$|[-_. (])/i), commit = cm ? cm[1].toLowerCase() : null;
  const e = s.match(/powersaving[\s_.-]?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (e) return { family: "easyskymesh", base: [1, +e[1], +e[2]], ver: [+e[1], +e[2], +(e[3] || 0)], commit };
  const v = verOf(s); if (!v) return null;
  const family = /-powersaving\b/i.test(s) ? "meshcore-powersaving" : /-serial\b/i.test(s) ? "meshcore-serial" : "meshcore";
  return { family, base: v, ver: v, commit };
}
const relIdent = (rel) => (rel ? fwIdent(rel.asset_name) || fwIdent(rel.tag) : null);
const sameCommit = (a, b) => !a.commit || !b.commit || a.commit.startsWith(b.commit) || b.commit.startsWith(a.commit);
// true when the installed firmware is the same family and at least the target version (and the same build when both carry a commit)
export function fwReached(installed, target) {
  const ii = fwIdent(installed), ti = target; if (!ii || !ti) return false;
  if (ii.family !== ti.family) return false;
  const c = vcmp(ii.ver, ti.ver); return c > 0 || (c === 0 && sameCommit(ii, ti));
}
// installed: version string reported by the device (or null); flashed: {tag, asset_name} last successfully installed (fallback)
export function updateStatus(installed, rel, flashed = null) {
  if (!rel || rel.skipped) return { state: "unchecked", text: "Not checked yet", checked_at: null };
  const at = rel.checked_at || null, li = relIdent(rel);  // asset names are usually more specific (tag PowerSaving17.1 vs asset ...17.1.6)
  const latest = li ? vstr(li.ver) : rel.asset_name;
  const ii = fwIdent(installed) || (flashed ? fwIdent(flashed.tag) || fwIdent(flashed.asset_name) : null);
  if (li && ii) {
    const avail = (text, reason) => ({ state: "available", text, reason, latest, installed: vstr(ii.ver), checked_at: at, notes: rel.notes || "", release_url: rel.html_url || null, tag: rel.tag || null });
    if (li.family !== ii.family)
      return { ...avail(`Update available (different firmware source): ${latest} ${FW_FAMILY_NAMES[li.family]}; the repeater runs ${FW_FAMILY_NAMES[ii.family]} ${vstr(ii.ver)}`, "Different firmware source"), family: li.family, installed_family: ii.family };
    const c = vcmp(li.ver, ii.ver);
    if (c > 0) return avail(`New update available: ${latest} (installed ${vstr(ii.ver)})`, "Newer version");
    if (c === 0 && !sameCommit(li, ii)) return avail(`Update available: ${latest} build ${li.commit} (the repeater runs build ${ii.commit})`, "Different build");
    return { state: "current", text: `Up to date (${vstr(ii.ver)})`, latest, installed: vstr(ii.ver), checked_at: at };
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
    const fi = fwIdent(lf.file), ri = fwIdent(mesh.heltec_fw), fv = fi && fi.ver, rv = ri && ri.ver;
    const u = updateStatus(mesh.heltec_fw, rel, null);
    if (fi && ri && (fi.family !== ri.family || vcmp(fv, rv) !== 0))
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
      if (src.enabled && !src.upload && !(cur && cur.checked_at && cur.notes !== undefined && now - Date.parse(cur.checked_at) < REFRESH_MS)) {
        const rel = await get(src);
        if (!rel.skipped) { await putJson(env, `release:${id}`, { ...rel, checked_at: new Date(now).toISOString(), auto: true }); out.push(id + ":radio"); }
      }
      const ts = await getTsimSource(env, id), tcur = await kvJson(env, `tsimrel:${id}`);
      if (ts.mode !== "url" && !(tcur && tcur.checked_at && tcur.notes !== undefined && now - Date.parse(tcur.checked_at) < REFRESH_MS)) {
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
.map{height:220px;border-radius:8px;margin-top:10px;border:1px solid var(--line)}.acts{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:12px 0}
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
.term{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0d1117;color:#c9d1d9;border-radius:8px;padding:10px 12px;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word}.term .pr{color:#3fb950}.term .ts{color:#8b949e;font-size:11px}.term .to{color:#e6edf3;margin:0 0 6px 14px}.term .te{color:#ff7b72;margin:0 0 6px 14px}
.term-in{background:#0d1117;border-radius:8px;padding:4px 8px;align-items:center}.term-in .pr{color:#3fb950;font-family:ui-monospace,monospace}.term-in input{background:transparent;color:#e6edf3;border:0;flex:1}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.rscat{margin-top:10px}.rssec{margin:0}.rsr{padding:1px 8px;font-size:11px;margin-left:6px;vertical-align:middle}.nowrap{white-space:nowrap}.rscat.risky{border-left:3px solid var(--warn)}.rsrow{padding:6px 0;border-top:1px solid var(--line)}.rsrow.dirty{background:#1f6feb14;box-shadow:inset 3px 0 var(--acc)}.rsl{font-weight:600;font-size:14px}.rsi select,.rsi input{max-width:100%}.rsnum{display:flex;gap:6px;align-items:center}.rsradio{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:6px}.rsro{word-break:break-all}.warn{color:var(--warn)}.warnb{background:#b547081f;color:var(--warn)}
.danger{background:#d1242f1f;border:2px solid var(--bad);padding:10px 12px;border-radius:8px;margin:10px 0}.danger b.h{color:var(--bad)}.danger input:not([type]){display:block;margin-top:4px}
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
const SENS_K="tsim_show_sensitive",UNIT_K="tsim_units";
const fmtDist=${fmtDist.toString().replace(/^function \w+/, "function")},fmtTemp=${fmtTemp.toString().replace(/^function \w+/, "function")};
const imp=()=>{try{return localStorage.getItem(UNIT_K)==="imperial"}catch{return false}};
const dist=m=>fmtDist(m,imp());
function unitsToggle(){try{localStorage.setItem(UNIT_K,imp()?"metric":"imperial")}catch{}unitsBtn();if(typeof load==="function")load()}
function unitsBtn(){const b=document.getElementById("unitsbtn");if(b){b.textContent=imp()?"ft · °F":"m · °C";b.title="Units: "+(imp()?"imperial":"metric")+" (click to switch)"}}
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
function mdl(x){return e(x).split("\\n").map(l=>{let h=l.replace(/\\*\\*([^*]+)\\*\\*/g,"<b>$1</b>").replace(/\\x60([^\\x60]+)\\x60/g,"<code>$1</code>").replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g,"$1");
 if(/^#{1,6}\\s/.test(l))return"<b>"+h.replace(/^#{1,6}\\s+/,"")+"</b>";if(/^\\s*[-*]\\s/.test(l))return"&nbsp;• "+h.replace(/^\\s*[-*]\\s+/,"");return h}).join("<br>")}
function relnotes(u){if(!u||u.state!=="available")return"";const ok=u.release_url&&/^https:\\/\\/github\\.com\\//.test(u.release_url);
 return '<details class="small" style="margin-top:8px"><summary>What’s new in '+e(u.latest||u.tag||"this release")+'</summary><div style="margin-top:6px;line-height:1.45">'+(u.notes?mdl(u.notes):'<span class="mut">No release notes were published for this release.</span>')+'</div>'+(ok?'<p style="margin:6px 0 0"><a href="'+e(u.release_url)+'" target="_blank" rel="noopener noreferrer">View the release on GitHub</a></p>':'')+'</details>'}
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
<body><header><div class="t">${acc.kind === "a" ? '<a href="/fleet" class="back">‹ All</a>' : ""}<b>${esc(dev.name)}</b><span class="mut small">${esc(dev.id)}</span><span id="seen" class="badge">…</span><button type="button" id="unitsbtn" class="g sm" onclick="unitsToggle()" style="margin-left:6px">m · °C</button></div>
<form method="post" action="/logout"><button class="g sm">Log out</button></form></header>
<nav class="tabs" id="tabs"><button type="button" data-t="ov">Overview</button><button type="button" data-t="radio">LoRa radio</button><button type="button" data-t="tsim">T-SIM</button><button type="button" data-t="act">Activity</button></nav>
<main>
<p class="psnote" id="offwarn" hidden style="margin:0 0 12px"></p>
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
<section><h2>Firmware</h2><div id="mwarn" class="danger" hidden><b class="h">⚠ Full-erase (merged / fresh-install) firmware selected</b>
<p class="small">Flashing it <b>erases the Heltec completely</b>: its identity (private key, so the mesh sees a brand-new repeater), node name, all settings and passwords, the access list (ACL) and regions. Only use it for a fresh install or to recover a broken radio.</p>
<p class="small"><b>Take a backup first:</b> <a href="#" data-bk="1">Create &amp; download a backup now ›</a> (read the private key in Backup &amp; restore first if you want to keep the identity).</p>
<label class="tog"><input type="checkbox" id="mwack"> I understand this erases the identity, name, settings, ACL and regions</label>
<label>Type ERASE to allow the update<input id="mwtyped" autocomplete="off" autocapitalize="characters" spellcheck="false"></label></div><div class="card"><div id="c-upd"></div><div id="p-heltec"></div></div>
<details class="card" id="upbox"><summary><b>Upload firmware file</b> <small id="upsum" class="mut"></small></summary><div class="in">
<p class="small mut">Pick a Heltec V3 <code>.bin</code> on this computer or phone and upload it. The T-SIM downloads it over LTE when you press <b>Update radio firmware</b>; nothing is sent before that. Use the app-only file (keeps identity and settings). Merged / fresh-install files are accepted with extra warnings. Limits: 3 files, app code up to 3.19 MB (the Heltec app partition).</p>
<input type="file" id="upfile" accept=".bin,application/octet-stream"><div id="upcheck" class="small"></div>
<div class="acts"><button type="button" id="upbtn">Upload</button><span id="upmsg" class="msg"></span></div>
<div class="bar" id="upbar" hidden><i style="width:0%"></i></div><div id="uplist"></div></div></details></section>
<section><h2>Mesh <small class="mut small" id="meshat"></small></h2>
<p class="psnote" id="meshps" hidden>Mesh polling is paused: the repeater is in power saving and its serial CLI isn't answering. Showing the last snapshot taken while it was awake. It resumes automatically when a status check gets a CLI reply. ${PS_HTML}</p>
<div class="grid" id="meshgrid">
<div class="card"><h3>Repeater</h3><div id="m-node"></div></div>
<div class="card"><h3>Radio</h3><div id="m-radio"></div></div>
<div class="card"><h3>Packets</h3><div id="m-pkt"></div></div>
</div>
<div class="card tw" style="margin-top:12px"><h3>Neighbors</h3><p class="small mut" style="margin:0 0 6px">The repeater only reports short node IDs. Press ✎ to give a node a name (saved on this dashboard).</p><table id="nbt"><thead><tr><th>Node</th><th>SNR</th><th>Last heard</th></tr></thead><tbody id="nb"></tbody></table></div></section>
<section><h2>Repeater settings</h2><div class="card">
<p class="small mut" style="margin-top:0">View and change the repeater's MeshCore settings. Values are read and changed through the repeater console (one text wakes the T-SIM; it runs up to 10 commands per wake, or 40 with T-SIM firmware 1.6.9+). Changed fields are highlighted; only changed values are sent. Prefer typing commands? Use Repeater console below.</p>
<p class="psnote" id="rsps" hidden>Not available while the repeater is in power saving: its command line isn't answering. ${PS_HTML}</p>
<p class="psnote" id="rscon" hidden>Turn on "Allow console commands" under Repeater console below to use repeater settings.</p>
<div class="acts" style="margin-top:0"><button type="button" id="rsreadall">Read all</button><button type="button" id="rssave" class="w" disabled>Save changes</button>
<button type="button" class="g" data-rsact="advert">Send flood advert</button><button type="button" class="g" data-rsact="advert.zerohop">Send zero-hop advert</button></div>
<details class="small" id="cachebox" style="margin:6px 0"><summary><b>Settings cache on the T-SIM</b> <small id="cachesum" class="mut"></small></summary>
<p class="small mut">With this on, the T-SIM re-reads these settings (plus regions and the access list) by itself on a wake it already makes, at most every N hours, so values here stay current without extra texts. Reads take about 30 s of serial time; skipped while battery protection has the repeater off or the repeater doesn't answer (power saving). Needs T-SIM firmware 1.7.0+.</p>
<label class="tog"><input type="checkbox" id="cacheon"> Keep repeater settings cached</label>
<label>Refresh at most every<select id="cacheint"><option value="6">6 hours</option><option value="12">12 hours</option><option value="24">24 hours</option><option value="48">2 days</option><option value="168">1 week</option></select></label>
<button type="button" class="g sm" id="cachesave">Save</button> <button type="button" class="g sm" id="cachenow">Refresh cache now (1 text)</button> <span id="cachemsg" class="msg"></span></details>
<div id="rsq" class="small"></div><span id="rsmsg" class="msg"></span>
<div id="rsgrid"></div>
<div id="rtools">
<details class="card rscat"><summary><b>Regions &amp; scopes</b> <small id="rgst"></small></summary><div class="in">
<p class="small mut">Regions decide which scoped floods this repeater forwards. Changes are saved on the repeater (<code>region save</code>) automatically. Hop limit for unscoped floods: Repeating &amp; routing › Max hops, unscoped floods.</p>
<button type="button" class="g sm" data-rd="regions">Read regions</button> <button type="button" class="g sm" data-t="rgclear">Clear default scope</button>
<div id="rglist"></div>
<form id="rgadd" class="row small"><input name="n" placeholder="#Region" maxlength="30" style="flex:1"><select name="p" id="rgparent"></select><label class="tog"><input type="checkbox" name="fl" checked> allow flooding</label><button type="submit" class="g sm">Add region</button></form>
<details class="small"><summary>Repeater's reply</summary><pre class="o" id="rgraw"></pre></details></div></details>
<details class="card rscat risky"><summary><b>Access list (ACL)</b> <span class="badge warnb">careful</span> <small id="aclst"></small></summary><div class="in">
<p class="small warn">Permissions for companions that log in to this repeater. Admin can change everything, including passwords and radio.</p>
<button type="button" class="g sm" data-rd="acl">Read access list</button><div id="acllist"></div>
<form id="acladd" class="row small"><input name="pk" class="mono" placeholder="companion public key (hex)" maxlength="64" style="flex:1"><select name="pm"><option value="0">Guest</option><option value="1">Read-only</option><option value="2">Read-write</option><option value="3">Admin</option></select><button type="submit" class="g sm">Add / update</button></form>
<details class="small"><summary>Repeater's reply</summary><pre class="o" id="aclraw"></pre></details></div></details>
<details class="card rscat"><summary><b>Sensors</b> <small id="snst"></small></summary><div class="in">
<p class="small mut">Only on repeaters built with sensor support.</p><button type="button" class="g sm" data-rd="sensors">Read sensors</button><div id="snlist"></div></div></details>
<details class="card rscat"><summary><b>Clock, GPS &amp; logging</b> <small id="logst"></small></summary><div class="in">
<div class="acts" style="margin-top:0"><button type="button" class="g sm" data-t="clocksync">Set clock to now</button><button type="button" class="g sm" data-t="gpssync">Sync clock from GPS</button><button type="button" class="g sm" data-t="gpssetloc">Set location from GPS</button></div>
<p class="small mut">Receive log (stored on the repeater):</p><div class="acts" style="margin-top:0"><button type="button" class="g sm" data-t="logstart">Start log</button><button type="button" class="g sm" data-t="logstop">Stop log</button><button type="button" class="g sm" data-rd="log">Show log</button><button type="button" class="g sm" data-t="logerase">Erase log</button></div>
<pre class="o" id="lograw"></pre></div></details>
<details class="card rscat risky"><summary><b>Maintenance</b></summary><div class="in">
<div class="acts" style="margin-top:0"><button type="button" class="g sm" data-t="disc">Discover neighbors</button><button type="button" class="g sm" data-t="clrstats">Clear stats</button></div>
<form id="nbrm" class="row small"><input name="p" class="mono" placeholder="neighbor ID prefix (hex)" maxlength="64" style="flex:1"><button type="submit" class="g sm">Remove neighbor</button></form>
<p class="small warn">Temporary radio settings (not saved; the repeater leaves your mesh until the time runs out or it reboots):</p>
<form id="tmpr" class="rsradio small"><label>MHz<input name="f" type="number" step="0.001" min="300" max="2500" required></label><label>kHz<input name="bw" type="number" step="0.1" min="7.8" max="500" required></label><label>SF<input name="sf" type="number" min="5" max="12" required></label><label>CR<input name="cr" type="number" min="5" max="8" required></label><label>Minutes<input name="m" type="number" min="1" max="1440" value="10" required></label><button type="submit" class="w sm">Apply temporarily</button></form>
<p class="small mut">Console-only on purpose: factory reset (erase), OTA, private key, power off.</p></div></details>
<div id="opsres" class="small"></div><span id="rtmsg" class="msg"></span></div>
<p class="small mut">Battery multiplier: use <a href="#" onclick="document.getElementById('adcbox').open=true;document.getElementById('adcbox').scrollIntoView();return false">Repeater battery calibration</a>. Console-only on purpose: factory reset (erase), private key, OTA and power off.</p>
</div></section>
<section><h2>Settings</h2>
<details class="card" id="bkbox"><summary><b>Repeater backup &amp; restore</b> <small id="bksum" class="mut"></small></summary><div class="in">
<p class="small mut">A backup is a JSON file with the repeater settings this dashboard has read (Read all, or the T-SIM settings cache), regions, the access list, and this dashboard's per-device config (update source, schedule, power / GPS settings, nicknames). It never contains the dashboard passwords, the Hologram key or other Worker secrets. The last 5 backups are also kept here.</p>
<p class="small" id="bkknown"></p><div id="bkkey" class="small"></div>
<div class="acts"><button type="button" class="g sm" id="prvread">Read private key for backup</button><button type="button" class="g sm" id="prvforget" hidden>Forget stored key</button></div>
<label class="tog"><input type="checkbox" id="bkinc"> Include the private key (the file becomes SENSITIVE)</label>
<div class="acts"><button type="button" id="bkmake">Create backup &amp; download</button><span id="bkmsg" class="msg"></span></div>
<div id="bklist"></div>
<h3>Restore</h3><p class="small mut">Pick a backup file to compare it with the current values, then choose what to restore.</p>
<input type="file" id="bkfile" accept=".json,application/json"><div id="bkprev"></div><div id="bkjob"></div></div></details>
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
<details class="card" id="locbox"><summary><b>Repeater location</b><small id="locsum" class="mut"></small></summary><div class="in">
<p class="small mut">Copies the T-SIM's GPS position to the repeater with the MeshCore commands <code>set lat</code> and <code>set lon</code>, so its adverts show where it is. This is never done automatically. Anyone on the mesh can then see the position.</p>
<div id="locinfo"></div>
<button type="button" id="locbtn" class="w">Set repeater location</button> <span id="locmsg" class="msg"></span>
<div id="locres" class="small"></div></div></details>
<details class="card" id="adcbox"><summary><b>Repeater battery calibration</b><small id="adcsum" class="mut"></small></summary><div class="in">
<p class="small mut">Corrects the battery voltage the repeater reports, using MeshCore's <code>adc.multiplier</code> setting. Measure the battery with a multimeter, enter it, check the preview, then save: the new value is sent straight away (one text wakes the T-SIM, which passes it to the repeater's command line). Uses the repeater console, so "Allow console commands" must be on and the repeater must not be in power saving. Some boards (including stock MeshCore on the Heltec V3) don't support it and answer "unsupported".</p>
<p class="psnote" id="adcps" hidden>Not available while the repeater is in power saving: its command line isn't answering. Turn power saving off (or wait for a status check that gets a reply), then calibrate.</p>
<p class="psnote" id="adccon" hidden>Turn on "Allow console commands" under Repeater console below to use calibration.</p>
<div id="adcinfo"></div>
<div id="adcui"><button type="button" class="g" id="adcread">Read current value</button>
<form id="adcf"><label>Multimeter battery voltage (V)<input name="mv" type="number" step="0.01" min="2.5" max="5" placeholder="4.07"></label>
<div id="adcprev" class="small"></div>
<button type="submit">Calibrate &amp; send now</button> <button type="button" class="g" id="adcreset">Reset to board default</button></form></div>
<span id="adcmsg" class="msg"></span></div></details>
<details class="card" id="conbox"><summary><b>Repeater console</b><small id="consum" class="mut"></small></summary><div class="in">
<label class="tog"><input type="checkbox" id="conon"> Allow console commands for this repeater</label>
<p class="small mut">Commands run on the repeater's MeshCore command line the next time the T-SIM wakes. "Queue &amp; wake" texts the T-SIM so they run within a few minutes. Examples: <code>ver</code> <code>neighbors</code> <code>stats-packets</code> <code>get name</code> <code>clock</code></p>
<p class="psnote" id="conps" hidden>The console is unavailable while the repeater is in power saving. It comes back after <code>powersaving off</code> or any successful reply, e.g. after Request status. ${PS_HTML}</p>
<div id="conui"><div class="row" style="margin-bottom:6px"><select id="clipick" class="mono"><option value="">Insert a command…</option><option value="ver">ver</option><option value="board">board</option><option value="clock">clock</option><option value="clock sync">clock sync</option><option value="neighbors">neighbors</option><option value="discover.neighbors">discover.neighbors</option><option value="stats-core">stats-core</option><option value="stats-radio">stats-radio</option><option value="stats-packets">stats-packets</option><option value="clear stats">clear stats</option><option value="advert">advert</option><option value="advert.zerohop">advert.zerohop</option><option value="powersaving">powersaving</option><option value="powersaving on">powersaving on</option><option value="powersaving off">powersaving off</option><option value="get serial.ondemand">get serial.ondemand</option><option value="set serial.ondemand on">set serial.ondemand on</option><option value="set serial.ondemand off">set serial.ondemand off</option><option value="get radio.rxps">get radio.rxps</option><option value="set radio.rxps off">set radio.rxps off</option><option value="set radio.rxps on">set radio.rxps on</option><option value="set radio.rxps balanced">set radio.rxps balanced</option><option value="set radio.rxps max">set radio.rxps max</option><option value="set radio.rxps level ">set radio.rxps level</option><option value="get reboot.interval">get reboot.interval</option><option value="set reboot.interval ">set reboot.interval</option><option value="powerlog">powerlog</option><option value="get name">get name</option><option value="get owner.info">get owner.info</option><option value="get role">get role</option><option value="get public.key">get public.key</option><option value="get lat">get lat</option><option value="get lon">get lon</option><option value="get radio">get radio</option><option value="get tx">get tx</option><option value="get radio.rxgain">get radio.rxgain</option><option value="get radio.fem.rxgain">get radio.fem.rxgain</option><option value="get radio.fem.txgain">get radio.fem.txgain</option><option value="get repeat">get repeat</option><option value="get path.hash.mode">get path.hash.mode</option><option value="get loop.detect">get loop.detect</option><option value="get txdelay">get txdelay</option><option value="get direct.txdelay">get direct.txdelay</option><option value="get rxdelay">get rxdelay</option><option value="get dutycycle">get dutycycle</option><option value="get int.thresh">get int.thresh</option><option value="get cad">get cad</option><option value="get agc.reset.interval">get agc.reset.interval</option><option value="get multi.acks">get multi.acks</option><option value="get flood.max">get flood.max</option><option value="get flood.max.unscoped">get flood.max.unscoped</option><option value="get flood.max.advert">get flood.max.advert</option><option value="get flood.advert.interval">get flood.advert.interval</option><option value="get advert.interval">get advert.interval</option><option value="get guest.password">get guest.password</option><option value="get adc.multiplier">get adc.multiplier</option><option value="get acl">get acl</option><option value="get bridge.type">get bridge.type</option><option value="get pwrmgt.support">get pwrmgt.support</option><option value="get pwrmgt.source">get pwrmgt.source</option><option value="get pwrmgt.bootreason">get pwrmgt.bootreason</option><option value="get pwrmgt.bootmv">get pwrmgt.bootmv</option><option value="get bootloader.ver">get bootloader.ver</option><option value="set name ">set name</option><option value="set owner.info ">set owner.info</option><option value="set lat ">set lat</option><option value="set lon ">set lon</option><option value="set tx ">set tx</option><option value="set repeat on">set repeat on</option><option value="set repeat off">set repeat off</option><option value="set txdelay ">set txdelay</option><option value="set dutycycle ">set dutycycle</option><option value="set flood.max ">set flood.max</option><option value="set flood.advert.interval ">set flood.advert.interval</option><option value="set advert.interval ">set advert.interval</option><option value="set radio ">set radio</option><option value="tempradio ">tempradio</option><option value="setperm ">setperm</option><option value="region">region</option><option value="region list allowed">region list allowed</option><option value="region list denied">region list denied</option><option value="region get *">region get *</option><option value="region home">region home</option><option value="region default">region default</option><option value="region save">region save</option><option value="log start">log start</option><option value="log stop">log stop</option><option value="log erase">log erase</option><option value="gps">gps</option><option value="gps advert">gps advert</option><option value="sensor list">sensor list</option><option value="eth.status">eth.status</option><option value="time ">time</option></select><small class="mut">↑/↓ recalls your previous commands</small></div><form id="conf" class="row term-in"><span class="pr">$</span><input id="cmd" class="mono" maxlength="120" placeholder="MeshCore CLI command" autocapitalize="none" autocomplete="off" spellcheck="false">
<button type="submit" class="g">Queue</button><button type="button" id="qwake">Queue &amp; wake</button></form>
<div class="row small" style="margin:8px 0"><span id="conmsg" class="msg"></span><span><button type="button" id="wake" class="g sm">Wake to run queued</button> <button type="button" id="cancel" class="g sm">Cancel queued</button></span></div>
<div class="term" id="cmds"></div></div></div></details>
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
<section><h2>Modem watchdog <small class="mut small" id="wdsum"></small></h2><div class="card">
<p class="small mut" style="margin-top:0">Self-recovery (T-SIM firmware 1.7.1+). The T-SIM normally sleeps until a text rings its modem. If the modem drops off the network while it sleeps, texts can't reach it, so the watchdog also wakes it on a timer. It checks the modem (answers AT, SIM ready, registered, data attached). If that fails it resets the modem's radio (<code>AT+CFUN=0/1</code>), then power-cycles the modem, and goes back to sleep with text wake-up re-armed. A healthy check takes a few seconds. A heartbeat to this dashboard adds about 10–20 s of LTE (a few KB). It never sends texts and never fetches queued console commands.</p>
<div id="wdinfo"></div><div id="wdev" class="small"></div><div id="wddel" class="small"></div>
<p class="small mut" id="wdnote" hidden>Needs T-SIM firmware 1.7.1 or newer. Update the T-SIM firmware first. Until then the T-SIM has no timer wake and can't recover by itself.</p>
<form id="wdf" style="margin-top:8px"><label>Check the modem every<select name="int"><option value="0">Off (1.7.2+: every 24 h, it can't be turned off)</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="120">2 hours</option><option value="180">3 hours (default)</option><option value="360">6 hours</option><option value="720">12 hours</option><option value="1440">24 hours</option></select></label>
<label class="tog"><input type="checkbox" name="hb"> Check in with this dashboard after every check (needed for the offline warning; otherwise only after a recovery)</label>
<label class="tog"><input type="checkbox" name="sms"> On watchdog wakes, also run texts already waiting on the modem (off: they run at the next text or wake)</label>
<label class="tog"><input type="checkbox" name="hwake"> Heltec reboot wake (T-SIM 1.7.3+, needs the optional GPIO6 wire): when the Heltec reboots, wake the T-SIM and reset its modem. Turns itself off after repeated false wakes; tick again to re-enable</label>
<button type="submit" class="g">Save (applied at next wake)</button> <button type="button" id="wdsend">Save &amp; send now (1 text)</button> <span id="wdmsg" class="msg"></span></form></div></section>
<section><h2>Location <small class="mut small" id="gpsat"></small></h2><div class="card">
<div class="acts" style="margin-top:0"><button type="button" id="gpsbtn" data-mode="get">Get location</button></div>
<p class="small mut" id="gpsnote" hidden>Location needs T-SIM firmware 1.6.7 or newer. Update the T-SIM firmware first.</p>
<div id="c-gps"></div><div id="gpsmapw" hidden><div id="gpsmap" class="map sens"></div><p class="small mut" style="margin:4px 0 0">Map © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</p></div><div id="p-gps"></div>
<details class="small" style="margin-top:10px"><summary>Location settings</summary>
<form id="gpsf" style="margin-top:8px"><label class="tog"><input type="checkbox" name="auto"> Auto-update location on every check-in (uses extra battery: GPS runs up to the timeout each check-in)</label>
<label>Fix timeout (seconds, 30–600)<input name="to" type="number" min="30" max="600" step="5"></label>
<button type="submit" class="g">Save</button> <span id="gpsmsg" class="msg"></span>
<p class="small mut">Settings are applied at the T-SIM's next wake (no text is sent).</p></form></details>
<p class="small mut">Uses the modem's built-in GPS. Needs a GNSS antenna on the T-SIM's GPS/GNSS u.FL connector (not the LTE one) with a view of the sky. The first fix can take up to 5 min (180 s or more timeout recommended). GPS stays on about 5 min after a try, so a retry soon after is faster. Coordinates are hidden until you press the eye.</p>
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
async function load(){unitsBtn();
 const r=await fetch(API+"telemetry",{credentials:"same-origin"});
 if(r.status===401){location.href="/";return}
 const d=await r.json(),L=d.latest||{},U=d.updates||{},M=d.mesh||{},S=d.settings||{},PG=d.progress||{};if(d.source)showSource(d.source);if(d.fwup)showFwup(d);if(d.backup)showBackup(d);if(d.power)showPower(d);if(d.watchdog)showWd(d);if(d.gps)showGps(d);if(d.presets&&!Object.keys(PRE).length)setPresets(d.presets);
 const seen=L.received_at?new Date(L.received_at):null,stale=!seen||Date.now()-seen>STALE_MS;
 const CI=(d.watchdog&&d.watchdog.checkin)||{},off=!!CI.offline;
 $("seen").textContent=seen?(off?"Offline · last seen ":stale?"Stale · ":"Online · ")+ago(L.received_at):"Never seen";$("seen").className="badge"+(stale||off?" stale":"");
 const ow=$("offwarn");ow.hidden=!off;if(off)ow.textContent="⚠ The T-SIM has missed "+CI.missed+" expected check-ins (expected every "+hrs(CI.expected_s/60)+" by its "+(CI.by==="schedule"?"scheduled check":"watchdog")+"; last seen "+ago(L.received_at)+", "+t(L.received_at)+" ET). Its modem may be off the network: texts won't reach it until it reconnects. The watchdog retries on its own; if it stays silent, power-cycle it on site.";
 $("c-tsim").innerHTML=kv([["Firmware",L.fw],["Last seen",L.received_at?{h:(off?'<span class="err">':"<span>")+e(ago(L.received_at))+"</span>"}:null],["Last report",t(L.received_at)],["Expected check-in",CI.expected_s?"every "+hrs(CI.expected_s/60)+" ("+(CI.by==="schedule"?"scheduled check":"watchdog")+")":"none (wakes only when texted)"],["Chip temperature",L.chip_temp_c==null?null:(imp()?(L.chip_temp_c*9/5+32).toFixed(0)+" °F":L.chip_temp_c.toFixed(0)+" °C")],["Woke by",L.wake==null?null:(WAKE[L.wake]||L.wake)],["Uptime",L.uptime==null?null:up(L.uptime)]]);
 $("c-power").innerHTML=kv([["Battery (idle)",L.battery_v==null?null:L.battery_v.toFixed(2)+" V ("+L.battery_pct+"%)"],["Battery (LTE on)",L.battery_load_v==null?null:L.battery_load_v.toFixed(2)+" V"],["Solar",L.solar_v==null?null:L.solar_v.toFixed(2)+" V"],["Battery protection",L.lb_state==null?null:(L.lb_state?"Repeat OFF (low battery)":"normal")],["Free memory",L.heap==null?null:Math.round(L.heap/1024)+" KB"],["Storage free",L.fs_free==null?null:Math.round(L.fs_free/1024)+" KB"]]);
 $("c-cell").innerHTML=kv([["Signal",sig(L.csq)],["RSRP / RSRQ",L.rsrp==null?null:L.rsrp+" / "+L.rsrq],["Network",L.operator],["IP",sens(L.ip)],...(L.iccid?[["ICCID",sens(L.iccid)]]:[]),...(L.imei?[["IMEI",sens(L.imei)]]:[])]);sensApply();
 const la=U.latest_available,TS=d.tsim||{},tla=TS.latest_available;
 const US=d.update_status||{};
 $("c-upd").innerHTML=kv([["Status",utext(US.radio)],["Running",M.heltec_fw||U.heltec_fw],["Latest available",la?la.asset_name:"press Check for updates"],["Checked",la&&t(la.checked_at)],["Last flashed",US.radio&&US.radio.flashed?US.radio.flashed.file+" · "+t(US.radio.flashed.at):null]])+(US.radio&&US.radio.flashed?finfo(US.radio.flashed.flash):"")+relnotes(US.radio);
 $("c-tsimfw").innerHTML=kv([["Status",utext(US.tsim)],["Running",TS.fw||L.fw],["Latest available",tla?tla.asset_name+(tla.tag&&tla.tag!=="url"?" ("+tla.tag+")":""):"press Check for updates"]])+relnotes(US.tsim);
 for(const k of ["heltec","tsim"]){const p=PG[k];if(pending[k]&&p&&p.started_at&&new Date(p.started_at)>=pending[k]-5000)delete pending[k];if(pending[k]&&Date.now()-pending[k]>15*60e3)delete pending[k];}
 $("p-heltec").innerHTML=prog(PG.heltec,"Heltec",pending.heltec);$("p-tsim").innerHTML=prog(PG.tsim,"T-SIM",pending.tsim);
 const busy=["heltec","tsim"].some(k=>pending[k]||(PG[k]||{}).state==="running");
 setUpd("update-latest","heltec",PG.heltec,pending.heltec);setUpd("tsim-update","tsim",PG.tsim,pending.tsim);
 const C=M.core||{},R=M.radio||{},P=M.packets||{};
 $("meshat").textContent=M.received_at?"· snapshot "+ago(M.received_at)+(M.test?" · TEST DATA":""):"· no snapshot yet (press Request status)";
 $("m-node").innerHTML=kv([["Name",M.node_name],["Firmware",M.heltec_fw],["Clock",M.clock],["Battery",C.battery_mv==null?null:(C.battery_mv/1000).toFixed(2)+" V"],["Uptime",up(C.uptime_secs)],["Queue / errors",C.queue_len==null?null:C.queue_len+" / "+C.errors]]);
 $("m-radio").innerHTML=kv([["Noise floor",R.noise_floor==null?null:R.noise_floor+" dBm"],["Last RSSI",R.last_rssi==null?null:R.last_rssi+" dBm"],["Last SNR",R.last_snr==null?null:R.last_snr+" dB"],["TX airtime",up(R.tx_air_secs)],["RX airtime",up(R.rx_air_secs)]]);
 $("m-pkt").innerHTML=kv([["Received",P.recv],["Sent",P.sent],["Flood tx / rx",P.flood_tx==null?null:P.flood_tx+" / "+P.flood_rx],["Direct tx / rx",P.direct_tx==null?null:P.direct_tx+" / "+P.direct_rx],["RX errors",P.recv_errors]]);
 const N=M.neighbors,NK=d.nicks||{};NICKS=NK;$("nb").innerHTML=N==null?'<tr><td colspan=3 class="mut">No data yet</td></tr>':(N.length?N.map(n=>{const k=String(n.id||"").toUpperCase(),nm=NK[k];return '<tr><td>'+(nm?'<b>'+e(nm)+'</b> <code class="mut small">'+e(n.id)+'</code>':'<code>'+e(n.id)+'</code>')+' <button type="button" class="g sm" data-nick="'+e(k)+'" title="Name this node">✎</button></td><td>'+e(n.snr)+' dB</td><td>'+e(ago(n.heard_at))+'</td></tr>'}).join(""):'<tr><td colspan=3 class="mut">No neighbors heard</td></tr>');
 if(M.error)$("nb").innerHTML+='<tr><td colspan=3 class="err">'+e(M.error)+'</td></tr>';
 const sc=d.schedule||{};const HL={6:"every 6 hours",12:"every 12 hours",24:"once a day",168:"once a week"},lr=sc.last_run;
 $("schsum").textContent=S.schedule_hours?"On · "+(HL[S.schedule_hours]||"every "+S.schedule_hours+" h")+" · next "+t(sc.next_run)+" ET":"Off";
 $("schinfo").innerHTML=kv([["Status",S.schedule_hours?"On: wakes the T-SIM "+(HL[S.schedule_hours]||"every "+S.schedule_hours+" h"):"Off: the T-SIM only wakes when you press a button"],["Next check",S.schedule_hours?t(sc.next_run)+" ET":null],["Last automatic check",lr?t(lr.at)+" ET"+(lr.sent?" (text sent)":" (not sent: "+(lr.error||"error")+")"):"none yet"]]);
 $("consum").textContent=S.console_enabled?"on":"off";
 if(first){$("schon").checked=!!S.schedule_hours;$("sch").value=String(S.schedule_hours||24);$("sch").disabled=!S.schedule_hours;$("conon").checked=!!S.console_enabled;first=false}
 const PSON=!!(d.powersaving&&d.powersaving.on),PS=PSON&&!d.powersaving.ondemand;
 $("ov-prog").innerHTML=pbadge(PG.heltec,"Radio update")+pbadge(PG.tsim,"T-SIM update")+ubadge(US.radio,"Radio fw")+ubadge(US.tsim,"T-SIM fw")+(PSON?'<span class="badge mut">Power saving'+(PS?'':' · serial on demand')+'</span>':(d.powersaving&&d.powersaving.unknown?'<span class="badge mut" title="'+e(d.powersaving.source||"")+'">Power saving: unknown</span>':''));
 $("ov-radio").innerHTML=kv([["Node",M.node_name],["Firmware",M.heltec_fw||U.heltec_fw],["Updates",utext(US.radio)],["Neighbors",M.neighbors==null?null:M.neighbors.length],["Mesh snapshot",M.received_at?ago(M.received_at):"none yet"]]);
 $("ov-tsim").innerHTML=kv([["Firmware",TS.fw||L.fw],["Updates",utext(US.tsim)],["Last report",ago(L.received_at)],["Battery",L.battery_v==null?null:L.battery_v.toFixed(2)+" V ("+L.battery_pct+"%)"],["Signal",sig(L.csq)]]);
 $("meshps").hidden=!PS;$("meshgrid").classList.toggle("dim",PS);$("nbt").classList.toggle("dim",PS);
 $("conps").hidden=!(PS&&S.console_enabled);$("conui").hidden=!S.console_enabled||PS;
 if(PS)$("consum").textContent="paused (power saving)";
 showAdc(d);showRpt(d);
 const CM=(d.commands||[]).filter(c=>!c.sys&&!c.unsolicited);const tm=$("cmds"),atB=tm.scrollHeight-tm.scrollTop-tm.clientHeight<30;tm.innerHTML=CM.length?CM.slice().reverse().map(c=>'<div class="tl"><span class="pr">$</span> '+e(c.cmd)+' <span class="ts">'+e(c.status==="done"?t(c.done_at):c.status==="queued"?"queued":c.status==="sent"?"sent, waiting…":c.status)+'</span></div>'+(c.output||c.error?'<div class="'+(c.error?"te":"to")+'">'+e(c.output||c.error)+'</div>':'')).join(""):'<div class="ts">No commands yet. Type one below, or pick from "Insert a command…".</div>';if(atB)tm.scrollTop=tm.scrollHeight;
 $("log").innerHTML=(d.history||[]).map(h=>'<tr><td>'+e(t(h.received_at))+'</td><td>'+e(h.type)+(h.test?' <b class="err">TEST</b>':'')+'</td><td>'+e(h.msg||(h.type==="status"?"Status report":""))+'</td></tr>').join("")||'<tr><td colspan=3 class="mut">No activity yet</td></tr>';
 clearTimeout(window._t);window._t=setTimeout(load,busy?5000:30000);
}
function setPresets(p){PRE=p;const s=$("preset");for(const[k,v]of Object.entries(p)){const o=document.createElement("option");o.value=k;o.textContent=v.label;s.appendChild(o)}}
$("preset").onchange=ev=>{const v=PRE[ev.target.value],f=$("srcf");if(!v){$("presetnote").textContent="";return}
 f.enabled.checked=v.enabled;f.repo.value=v.repo;f.asset_pattern.value=v.asset_pattern;f.tag_prefix.value=v.tag_prefix||"";f.direct_url.value=v.direct_url;
 $("presetnote").textContent=v.note?v.note+" Press Save to use it.":ev.target.value==="meshcore"?"Stock MeshCore from meshcore-dev/MeshCore (app-only image, keeps identity and settings). It follows the newest release tagged repeater-* (MeshCore also publishes companion and room-server releases). Press Save to use it.":"Press Save to use it."};
let tsimLoaded=false;
function showTsim(s){const f=$("tsimf");$("tsimsum").textContent=s.mode==="url"?"direct link":s.repo+" · "+s.asset;
 if(!tsimLoaded){f.mode.value=s.mode;f.repo.value=s.repo||"";f.asset.value=s.asset||"";f.url.value=s.url||"";f.checksum.value=s.checksum||"";tsimLoaded=true}}
$("tsimf").onsubmit=async ev=>{ev.preventDefault();const f=ev.target;
 const r=await post("tsim-source",{mode:f.mode.value,repo:f.repo.value,asset:f.asset.value,url:f.url.value,checksum:f.checksum.value});
 const j=await rj(r);say("tsimmsg",r.ok,r.ok?"Saved":friendly(j,r.status));if(r.ok){tsimLoaded=false;showTsim(j.source);load();}};
let srcLoaded=false;
function showSource(s){const f=$("srcf");$("srcsum").textContent=s.enabled?s.repo+" · "+(s.tag_prefix?s.tag_prefix+"* · ":"")+s.asset_pattern:(s.direct_url?"direct link":"not set");
 const off=!s.enabled&&!s.direct_url&&!s.upload;document.querySelectorAll('button[data-a="update-latest"]').forEach(b=>{b.disabled=off;b.title=off?"Set an update source first":""});
 if(!srcLoaded){f.enabled.checked=!!s.enabled;f.repo.value=s.repo||"";f.asset_pattern.value=s.asset_pattern||"";f.tag_prefix.value=s.tag_prefix||"";f.direct_url.value=s.direct_url||"";srcLoaded=true;}}
$("srcf").onsubmit=async ev=>{ev.preventDefault();const f=ev.target;
 const r=await post("source",{upload:"",enabled:f.enabled.checked,repo:f.repo.value,asset_pattern:f.asset_pattern.value,tag_prefix:f.tag_prefix.value,direct_url:f.direct_url.value});
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
let wdLoaded=false;
const WDST={ok:"OK",soft:"Recovered (AT+CFUN reset)",hard:"Recovered (modem power-cycle)",lowbat:"Low battery: recovery skipped",fail:"Failed"};
function showWd(d){const W=d.watchdog||{},S=W.settings||{},X=W.last,L=d.latest||{};
 $("wdnote").hidden=!!W.supported;["wdsend"].forEach(x=>$(x).disabled=!W.supported);$("wdf").querySelectorAll("select,input,button").forEach(x=>x.disabled=!W.supported);$("wdf").hwake.disabled=!W.supported||!W.hwake_supported;
 const dev=L.wd_int;
 $("wdsum").textContent=!W.supported?"· needs T-SIM 1.7.1":"· "+(dev==null?"not reported yet":dev?"every "+hrs(dev):"off on the T-SIM")+(X?" · last check "+ago(X.at):"")+(W.pending?" · change waiting for the T-SIM":"");
 const ok=X&&X.stage==="ok";
 $("wdinfo").innerHTML=kv([["Running on T-SIM",dev==null?null:dev?"every "+hrs(dev):"off"],["Last check-in",X?{h:'<span class="'+(ok?"ok":X.stage==="lowbat"?"":"err")+'">'+e(WDST[X.stage]||X.stage)+"</span> · "+e(ago(X.at))}:"none yet"],["Next check (about)",X&&X.next_at?t(X.next_at)+" ET":null],
  ["Checks · OK · soft · hard · failed",L.wd_checks==null&&!X?null:[L.wd_checks??X.checks,X?X.ok:"?",L.wd_soft??X.soft,L.wd_hard??X.hard,L.wd_fail??X.fail].map(v=>v??"?").join(" · ")],
  ["Heltec reboot wake",X&&X.hwake!=null?["off","on","auto-off (false wakes; tick the box to re-enable)"][X.hwake]+" · detected "+(X.hw_wakes??"?")+" · ignored "+(X.hw_ignored??"?")+" · not armed "+(X.hw_skipped??"?"):null],
  ["Restarts · hang resets · command fetches",X&&(X.restarts!=null||X.deadline_resets!=null)?[X.restarts,X.deadline_resets,X.cmd_fetches].map(v=>v??"?").join(" · ")+(X.cmd===false?" (fetch off)":""):null],
  ["Last recovery",X&&X.last_recovery?(X.last_recovery.stage==="hard"?"power-cycle":"AT+CFUN reset")+" · "+t(X.last_recovery.at)+" ET":"none"],["Texts waiting on the modem",X&&X.sms_waiting!=null&&X.sms_waiting>=0?X.sms_waiting:null]]);
 const EV=(X&&X.events)||[];$("wdev").innerHTML=EV.length?"<b>Recent recovery attempts</b><ul style='margin:4px 0'>"+EV.map(v=>"<li>"+e(v.stage)+": "+e(v.result)+(v.secs!=null?" ("+e(v.secs)+" s)":"")+(v.at?" · "+e(t(v.at))+" ET":"")+"</li>").join("")+"</ul>":"";
 $("wddel").innerHTML=S.applied_at?'<span class="ok">✓ Applied on T-SIM at '+e(t(S.applied_at))+' ET</span>':W.pending?"⏳ Saved; waiting for the T-SIM's next wake":"";
 if(!wdLoaded){const f=$("wdf");f.int.value=String(S.int_min);f.hb.checked=!!S.hb;f.sms.checked=!!S.sms;f.hwake.checked=X&&X.hwake!=null?X.hwake===1:S.hwake!==false;wdLoaded=true}}
async function saveWd(send){const f=$("wdf"),b={int_min:+f.int.value,hb:f.hb.checked,sms:f.sms.checked,send};if(!f.hwake.disabled)b.hwake=f.hwake.checked;
 if(send&&!confirm("Save and send ONE text now so the T-SIM wakes and applies the watchdog settings?"))return;
 const r=await post("watchdog-settings",b);const j=await rj(r);
 say("wdmsg",r.ok&&!(j.wake&&!j.wake.sent),!r.ok?(j.error||friendly(j,r.status)):j.unchanged?"No change: the T-SIM already uses these settings.":j.wake?(j.wake.sent?"Saved and sent; waiting for the T-SIM to wake.":"Saved; text not sent: "+friendly(j.wake,j.wake.status)):"Saved. Applied at the T-SIM's next wake (no text sent).");if(r.ok){wdLoaded=false;load()}}
$("wdf").onsubmit=ev=>{ev.preventDefault();saveWd(false)};$("wdsend").onclick=()=>saveWd(true);
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
async function queue(wake,force){const c=$("cmd").value.trim();if(!c)return;cliRemember(c);
 if(wake&&!confirm("Queue '"+c+"' and text the T-SIM to run it now?"))return;
 const r=await post("commands",{cmd:c,wake,force:!!force});const j=await rj(r);
 if(r.status===409&&j.risky){if(confirm("'"+c+"' can change or wipe the repeater's settings. Queue it anyway?"))return queue(wake,true);return}
 say("conmsg",r.ok&&(!j.wake||j.wake.sent),r.ok?("Queued"+(j.wake?(j.wake.sent?". Text sent, the reply will appear here within a few minutes.":". The wake text wasn't sent: "+friendly(j.wake,j.wake.status)):". It runs the next time the T-SIM wakes.")):friendly(j,r.status));
 if(r.ok)$("cmd").value="";load();}
let ADC={},ADCM={};
function showAdc(d){const A=d.adc||{},M=d.mesh||{},C=M.core||{},S=d.settings||{},PS=!!(d.powersaving&&d.powersaving.blocks);ADC=A;ADCM=M;
 const rep=C.battery_mv==null?null:C.battery_mv/1000,stale=A.set_at&&M.received_at&&M.received_at<A.set_at;
 $("adcsum").textContent=A.supported===false?"not supported":A.pending?"sent, waiting for reply":A.mult!=null?"x"+A.mult.toFixed(3)+(A.set===0?" (board default)":""):"not read yet";
 $("adcps").hidden=!PS;$("adccon").hidden=!!S.console_enabled||PS;$("adcui").hidden=PS||!S.console_enabled;
 $("adcinfo").innerHTML=kv([["Repeater reports",rep==null?"no reading yet (press Request status)":rep.toFixed(2)+" V · "+t(M.received_at)+(stale?" (before the last change: press Request status)":"")],
  ["Current multiplier",A.supported===false?{h:'<span class="err">Not supported by this repeater</span>'}:A.mult!=null?A.mult.toFixed(3)+(A.set===0?" (board default)":""):A.set===0?"board default (press Read current value)":"unknown (press Read current value)"],
  ["Last reply",A.at?t(A.at)+(A.error?" · "+A.error:""):null],["Status",A.pending?"⏳ Sent to the T-SIM, waiting for the repeater's reply":null]]);
 if(A.supported===false)$("adcprev").innerHTML='<span class="err">'+e(${JSON.stringify(ADC_UNSUPPORTED)})+'</span>';else adcPrev()}
function adcPrev(){const mv=+$("adcf").mv.value,C=ADCM.core||{},rep=C.battery_mv/1000,cur=ADC.mult;if(ADC.supported===false)return;
 if(!mv){$("adcprev").textContent="";return}
 if(!(mv>=2.5&&mv<=5)){$("adcprev").innerHTML='<span class="err">Enter 2.5–5 V.</span>';return}
 if(!(cur>0)){$("adcprev").textContent='Press "Read current value" first so the new multiplier can be worked out.';return}
 if(!(rep>=1)){$("adcprev").textContent="No battery reading from the repeater yet. Press Request status first.";return}
 const n=Math.round(Math.min(10,Math.max(0,cur*mv/rep))*1000)/1000;$("adcprev").innerHTML="Preview: repeater says "+rep.toFixed(2)+" V, meter says "+mv.toFixed(2)+" V → multiplier <b>"+cur.toFixed(3)+" → "+n.toFixed(3)+"</b>"+(n>=10||n<=0?' <span class="err">(limited to 0–10)</span>':"")}
$("adcf").oninput=adcPrev;
async function adcPost(b,q){if(q&&!confirm(q))return;const r=await post("adc-cal",b);const j=await rj(r);
 say("adcmsg",r.ok&&!(j.wake&&!j.wake.sent),r.ok?(j.wake&&j.wake.sent?"Sent. The repeater's reply appears here within a few minutes.":"Queued, but the wake text wasn't sent: "+friendly(j.wake||{},(j.wake||{}).status)+" It runs at the next wake."):(j.error||friendly(j,r.status)));load()}
$("adcread").onclick=()=>adcPost({op:"read"},"Text the T-SIM to read the repeater's battery multiplier?");
$("adcf").onsubmit=async ev=>{ev.preventDefault();const mv=+ev.target.mv.value;const r=await post("adc-cal",{op:"preview",meter_v:mv});const j=await rj(r);
 if(!r.ok)return say("adcmsg",false,j.error||friendly(j,r.status));const p=j.preview;
 adcPost({op:"set",meter_v:mv},"Set the repeater's battery multiplier from "+p.current.toFixed(3)+" to "+p.new_mult.toFixed(3)+" (repeater "+p.reported_v.toFixed(2)+" V, meter "+p.meter_v.toFixed(2)+" V)? One text is sent now.")};
$("adcreset").onclick=()=>adcPost({op:"reset"},"Reset the repeater's battery multiplier to the board default? One text is sent now.");
const RS=${JSON.stringify(RPT_SETTINGS)},RP=${JSON.stringify(RADIO_PRESETS)},PERWAKE0=${CMDS_PER_WAKE};let PERWAKE=PERWAKE0;
let RV={},RQ={},RLOAD=false;const TYPED=new Set();
const depOkC=v=>!!(v&&v.value!=null&&!/^(none|no|off|-|n\\/a)?$/i.test(String(v.value).trim()));
const rsId=k=>"rs-"+k;
function rsInput(i){const id=rsId(i.k);
 if(i.ro)return '<div class="rsro'+(i.mono?' mono':'')+'" id="'+id+'">—</div>';
 if(i.type==="sel")return '<select id="'+id+'" data-k="'+i.k+'"><option value="">—</option>'+i.opts.map(o=>'<option value="'+e(o[0])+'">'+e(o[1])+'</option>').join("")+'</select>';
 if(i.type==="num")return '<span class="rsnum"><input id="'+id+'" data-k="'+i.k+'" type="number" min="'+i.min+'" max="'+i.max+'" step="'+i.step+'">'+(i.unit?'<small class="mut">'+e(i.unit)+'</small>':'')+'</span>';
 if(i.type==="radio")return '<select id="rs-preset" data-k="radio"><option value="">Preset… (or enter values below)</option>'+RP.map(g=>'<optgroup label="'+e(g[0])+'">'+g[1].map(p=>'<option value="'+p.slice(1,5).join(",")+'" data-ph="'+(p[5]||"")+'">'+e(p[0])+' · '+p[1]+' MHz / '+p[2]+' kHz / SF'+p[3]+' / CR'+p[4]+'</option>').join("")+'</optgroup>').join("")+'</select>'+
  '<div class="rsradio"><label>Freq (MHz)<input id="rs-radio-f" data-k="radio" type="number" min="300" max="2500" step="0.001"></label><label>BW (kHz)<select id="rs-radio-bw" data-k="radio"><option value=""></option>'+["7.8","10.4","15.6","20.8","31.25","41.7","62.5","125","250","500"].map(x=>'<option>'+x+'</option>').join("")+'</select></label><label>SF<select id="rs-radio-sf" data-k="radio"><option value=""></option>'+[5,6,7,8,9,10,11,12].map(x=>'<option>'+x+'</option>').join("")+'</select></label><label>CR<select id="rs-radio-cr" data-k="radio"><option value=""></option>'+[5,6,7,8].map(x=>'<option>'+x+'</option>').join("")+'</select></label></div><div id="rs-phnote" class="small mut"></div>';
 if(i.type==="secret")return '<form class="rssec" autocomplete="off" onsubmit="return false"><input id="'+id+'" data-k="'+i.k+'" name="rs_secret_'+i.k.replace(/\\W/g,"_")+'" type="password" maxlength="'+i.max+'" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" readonly onfocus="this.removeAttribute(\\'readonly\\')" autocapitalize="none" spellcheck="false" placeholder="'+(i.wo?"new password":"unchanged")+'"></form>';
 return '<input id="'+id+'" data-k="'+i.k+'" name="rs_'+i.k.replace(/\\W/g,"_")+'" type="text" maxlength="'+i.max+'" autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" autocapitalize="none">'}
function rsBuild(){$("rsgrid").innerHTML=RS.map((c,ci)=>'<details id="rscat'+ci+'" class="card rscat'+(c.risk?' risky':'')+'"><summary><b>'+e(c.cat)+'</b>'+(c.risk?' <span class="badge warnb">careful</span>':'')+' <small class="mut" id="rssum'+ci+'"></small></summary><div class="in">'+(c.note?'<p class="small '+(c.risk?'warn':'mut')+'">'+e(c.note)+'</p>':'')+
 c.items.map(i=>'<div class="rsrow"><div class="rsl">'+e(i.label)+(i.risk?' <span class="warn" title="Risky change">⚠</span>':i.riskVals?' <span class="warn" title="'+e("Risky when set to "+i.riskVals.join(" / "))+'">⚠</span>':'')+(i.wo?'':' <button type="button" class="g sm rsr" data-rs1="'+e(i.k)+'" title="Read just this setting">Read</button>')+'</div><div class="rsi">'+rsInput(i)+'</div><div class="small" id="rsst-'+i.k+'"></div>'+(i.help?'<div class="small mut">'+e(i.help)+'</div>':'')+'</div>').join("")+
 '<button type="button" class="g sm" data-rsread="'+ci+'">Read this group</button></div></details>').join("");
 const markTyped=ev=>{const k=ev.target.dataset&&ev.target.dataset.k;if(k&&ev.isTrusted)TYPED.add(k)};
 ["keydown","paste","drop","cut"].forEach(t=>$("rsgrid").addEventListener(t,markTyped,true));
 $("rsgrid").addEventListener("change",ev=>{if(ev.target.tagName==="SELECT")markTyped(ev)},true);
 $("rsgrid").addEventListener("pointerdown",ev=>{if(ev.target.type==="number")markTyped(ev)},true);
 $("rsgrid").addEventListener("input",ev=>{const k=ev.target.dataset&&ev.target.dataset.k;if(!k)return;if(ev.target.tagName==="SELECT"&&ev.isTrusted)TYPED.add(k);
  if(ev.target.id==="rs-preset"){const v=ev.target.value;if(v){const p=v.split(",");["f","bw","sf","cr"].forEach((x,j)=>$("rs-radio-"+x).value=x==="bw"?String(+p[j]):p[j]);const ph=ev.target.selectedOptions[0].dataset.ph;
   $("rs-phnote").textContent=ph?"This mesh also uses a "+ph+"-byte path hash (Repeating & routing › Advert path hash size = "+(ph-1)+"). Change it separately if you want to match.":""}}
  else if(k==="radio")$("rs-preset").value="";rsDirty()});
 $("rsgrid").addEventListener("click",ev=>{const b1=ev.target.closest("[data-rs1]");if(b1){const k=b1.dataset.rs1,it=RS.flatMap(c=>c.items).find(i=>i.k===k);return rsRead([k],"just "+it.label)}
  const b=ev.target.closest("[data-rsread]");if(b)rsRead(RS[+b.dataset.rsread].items.filter(i=>!i.wo).map(i=>i.k),RS[+b.dataset.rsread].cat)})}
function rsCur(i){if(i.type==="radio"){const p=["f","bw","sf","cr"].map(x=>$("rs-radio-"+x).value.trim());return p.every(x=>x!=="")?p.join(","):""}const el=$(rsId(i.k));return el?el.value.trim():""}
function rsNorm(i,v){v=String(v??"").trim();if(v==="")return"";if(i.type==="num"){const n=parseFloat(v);return isFinite(n)?String(n):v}if(i.type==="radio")return v.split(",").map(x=>String(+x)).join(",");if(i.type==="sel")return v.toLowerCase();return v}
function rsChanges(){const ch=[];for(const c of RS)for(const i of c.items){if(i.ro)continue;const cur=rsCur(i),rv=RV[i.k]&&RV[i.k].value;
 if(cur==="")continue;if(!TYPED.has(i.k))continue;if(i.type==="secret"||rsNorm(i,cur)!==rsNorm(i,rv))ch.push(i)}return ch}
function rsScrub(){for(const c of RS)for(const i of c.items){if(TYPED.has(i.k))continue;const el=$(rsId(i.k));if(!el)continue;
 if(i.type==="secret"){if(el.value)el.value=""}else if(i.type==="text"){const rv=RV[i.k]&&RV[i.k].value;if(el.value&&el.value!==(rv??""))el.value=rv??""}}}
function rsDirty(){rsScrub();const n=rsChanges().length;$("rssave").disabled=!n;$("rssave").textContent=n?"Save "+n+" change"+(n>1?"s":"")+" & send":"Save changes";
 document.querySelectorAll(".rsrow").forEach(r=>r.classList.remove("dirty"));rsChanges().forEach(i=>{const el=$(i.type==="radio"?"rs-preset":rsId(i.k));el&&el.closest(".rsrow").classList.add("dirty")})}
function showRpt(d){const R=d.rpt||{},S=d.settings||{},PS=!!(d.powersaving&&d.powersaving.blocks);RV=R.vals||{};RQ=R.queued||{};PERWAKE=R.per_wake||PERWAKE0;
 if(!RLOAD){rsBuild();RLOAD=true}
 $("rsps").hidden=!PS;$("rscon").hidden=!!S.console_enabled||PS;const off=PS||!S.console_enabled;
 ["rsreadall","rssave"].forEach(x=>$(x).disabled=off||(x==="rssave"&&!rsChanges().length));
 for(const c of RS)for(const i of c.items){const v=RV[i.k]||{},st=$("rsst-"+i.k),q=RQ[i.k];
  if(v.value!=null&&!(document.activeElement&&document.activeElement.dataset&&document.activeElement.dataset.k===i.k)){
   if(i.ro){const el=$(rsId(i.k));el.textContent=v.value}
   else if(i.type==="radio"){if(!document.querySelector(".rsrow.dirty #rs-preset")){const p=String(v.value).split(",");if(p.length===4){$("rs-radio-f").value=String(+p[0]);$("rs-radio-bw").value=String(+p[1]);$("rs-radio-sf").value=String(+p[2]);$("rs-radio-cr").value=String(+p[3]);
     const m=[].find.call($("rs-preset").options,o=>o.value&&o.value.split(",").map(Number).join()===p.map(Number).join());$("rs-preset").value=m?m.value:""}}}
   else if(!i.wo){const el=$(rsId(i.k));if(el&&!el.closest(".rsrow").classList.contains("dirty"))el.value=i.type==="sel"?String(v.value).toLowerCase():i.type==="num"?String(parseFloat(v.value)):i.type==="secret"?"":v.value}}
  st.innerHTML=q?'<span class="mut">⏳ '+(q==="sent"?"sent to the T-SIM, waiting for the reply":"queued for the next wake")+'</span>':v.unsupported?'<span class="mut">Not supported by this firmware'+(v.at?" · "+e(t(v.at)):"")+'</span>':v.error?'<span class="err">'+e(v.error)+(v.at?" · "+e(t(v.at)):"")+'</span>':v.at?'<span class="mut">'+(v.set?"Changed "+e(t(v.at))+(v.msg?" · "+e(v.msg):""):(v.src==="cache"?"Cached by T-SIM ":"Read ")+e(t(v.at)))+(v.detail?'<br><code class="small">'+e(v.detail)+'</code>':'')+'</span>':i.wo?"":'<span class="mut">Not read yet</span>'}
 rsScrub();showCache(d);
 RS.forEach((c,ci)=>{if(c.dep)$("rscat"+ci).hidden=!depOkC(RV[c.dep])});showTools(d);
 RS.forEach((c,ci)=>{const ks=c.items.filter(i=>!i.wo).map(i=>i.k),ats=ks.map(k=>RV[k]&&RV[k].at).filter(Boolean).sort();$("rssum"+ci).textContent=ats.length?"read "+ago(ats[ats.length-1]):"not read"});
 const nq=Object.values(RQ).filter(x=>x==="queued").length,ns=Object.values(RQ).filter(x=>x==="sent").length;
 $("rsq").innerHTML=nq||ns?(ns?"⏳ "+ns+" sent, waiting for replies. ":"")+(nq?nq+" queued"+(ns?"":' <button type="button" class="g sm" id="rscont">Send next batch (1 text)</button>'):""):"";
 const cb=$("rscont");if(cb)cb.onclick=async()=>{if(!confirm("Text the T-SIM to run the next "+Math.min(nq,PERWAKE)+" queued settings commands?"))return;const r=await post("wake-cmd");const j=await rj(r);say("rsmsg",!!j.sent,j.sent?"Text sent. Replies appear within a few minutes.":friendly(j,r.status));load()};
 rsDirty()}
async function rsRead(keys,what){const w=Math.ceil(keys.length/PERWAKE);
 if(!confirm("Read "+(what||"all repeater settings")+"? This queues "+keys.length+" commands and sends one text now."+(w>1?"\\n\\nThe T-SIM runs "+PERWAKE+" commands per wake, so this needs "+w+" wakes: after the first batch, press \\"Send next batch\\" for the rest.":"")))return;
 const r=await post("rpt-read",{keys});const j=await rj(r);say("rsmsg",r.ok&&!(j.wake&&!j.wake.sent),r.ok?(j.queued?"Queued "+j.queued+" reads. "+(j.wake&&j.wake.sent?"Text sent; values appear within a few minutes.":"Wake text not sent: "+friendly(j.wake||{},(j.wake||{}).status)):"Already queued."):(j.error||friendly(j,r.status)));load()}
let cacheLoaded=false;
function showCache(d){const C=d.cache||{},S=C.settings||{},X=C.last;
 $("cachesum").textContent=!C.supported?"needs T-SIM 1.7.0":(S.en?"on · every "+(S.int_h>=48?S.int_h/24+" days":S.int_h+" h"):"off")+(X&&X.at?" · last "+ago(X.at)+(X.error?" ("+X.error+")":""):"")+(C.pending?" · change waiting for the T-SIM":"");
 ["cacheon","cacheint","cachesave","cachenow"].forEach(x=>$(x).disabled=!C.supported);
 if(!cacheLoaded){$("cacheon").checked=!!S.en;$("cacheint").value=String(S.int_h||24);cacheLoaded=true}}
async function cachePost(now){const b={en:$("cacheon").checked,int_h:+$("cacheint").value,now};
 if(now&&!confirm("Text the T-SIM so it reads and caches all repeater settings now?"))return;
 const r=await post("cache-settings",b);const j=await rj(r);say("cachemsg",r.ok&&!(j.wake&&!j.wake.sent),r.ok?(now?(j.wake&&j.wake.sent?"Text sent; values update within a few minutes.":"Saved; wake text not sent: "+friendly(j.wake||{},(j.wake||{}).status)):"Saved. Applied at the T-SIM's next wake."):(j.error||friendly(j,r.status)));cacheLoaded=false;load()}
$("cachesave").onclick=()=>cachePost(false);$("cachenow").onclick=()=>cachePost(true);
$("rsreadall").onclick=()=>rsRead(RS.filter(c=>!c.noAll).flatMap(c=>c.items.filter(i=>!i.wo&&(!i.dep||depOkC(RV[i.dep]))).map(i=>i.k)));
$("rssave").onclick=async()=>{const ch=rsChanges();if(!ch.length)return;const changes={};ch.forEach(i=>changes[i.k]=rsCur(i));
 const isR=i=>i.risk||(i.riskVals||[]).includes(String(changes[i.k]).toLowerCase()),risky=ch.filter(isR),lines=ch.map(i=>"• "+i.label+": "+(i.type==="secret"?"(hidden)":i.type==="radio"?changes[i.k].replace(/,/g," / ")+"  (MHz / kHz / SF / CR)":changes[i.k])+(isR(i)?"  ⚠":""));
 let msg="Send these changes to the repeater now (one text)?\\n\\n"+lines.join("\\n");
 if(risky.length)msg+="\\n\\n⚠ WARNING: "+risky.map(i=>i.k==="radio"||i.k==="tx"||i.k==="radio.fem.txgain"?"radio changes can drop the repeater off your mesh (applied after a radio restart)":i.k==="powersaving"?"power saving ON stops this dashboard reaching the repeater's console":i.k==="repeat"?"repeat off stops relaying":i.k==="path.hash.mode"?"older nodes drop multi-byte paths":i.warn?i.warn:"passwords control who can administer the repeater").filter((x,ix,a)=>a.indexOf(x)===ix).join("; ")+".";
 if(!confirm(msg))return;
 let typed="";if(ch.some(i=>i.typed)){typed=prompt("Changing the admin password. Anyone with the old password loses admin access, and the new password is stored in this dashboard's history until it runs.\\n\\nType CHANGE to confirm.")||"";if(typed.trim().toUpperCase()!=="CHANGE")return say("rsmsg",false,"Not sent: admin password change not confirmed.")}
 const r=await post("rpt-save",{changes,risk_ok:risky.length>0,typed});const j=await rj(r);
 if(r.ok){ch.forEach(i=>{TYPED.delete(i.k);if(i.type==="secret"){$(rsId(i.k)).value=""}document.querySelectorAll(".rsrow.dirty").forEach(x=>x.classList.remove("dirty"))})}
 say("rsmsg",r.ok&&!(j.wake&&!j.wake.sent),r.ok?"Queued "+j.queued+" change"+(j.queued>1?"s":"")+". "+(j.wake&&j.wake.sent?"Text sent; results appear within a few minutes.":"Wake text not sent: "+friendly(j.wake||{},(j.wake||{}).status))+(changes.radio?" Radio changes apply after Reboot radio.":""):(j.error||friendly(j,r.status)));load()};
document.querySelectorAll("[data-rsact]").forEach(b=>b.onclick=async()=>{const a=b.dataset.rsact;if(!confirm(b.textContent+" now? This sends one text."))return;const r=await post("rpt-action",{act:a});const j=await rj(r);say("rsmsg",r.ok,r.ok?(j.wake&&j.wake.sent?"Text sent.":"Queued; wake text not sent."):(j.error||friendly(j,r.status)));load()});
// terminal console: history + up/down recall
const CH=()=>{try{return JSON.parse(localStorage.getItem("clihist")||"[]")}catch(x){return[]}};let chi=-1;
$("cmd").addEventListener("keydown",ev=>{const h=CH();if(ev.key==="ArrowUp"&&h.length){chi=Math.min(chi+1,h.length-1);$("cmd").value=h[chi];ev.preventDefault()}else if(ev.key==="ArrowDown"){chi=Math.max(chi-1,-1);$("cmd").value=chi<0?"":h[chi];ev.preventDefault()}});
function cliRemember(c){const h=CH().filter(x=>x!==c);h.unshift(c);localStorage.setItem("clihist",JSON.stringify(h.slice(0,50)));chi=-1}
$("clipick").onchange=ev=>{const v=ev.target.value;if(!v)return;$("cmd").value=v;$("cmd").focus();ev.target.value=""};

function rgParse(raw){const out=[];const st=[];String(raw||"").split("\\n").forEach(l=>{if(!l.trim()||/^(err|error|\\?\\?)/i.test(l.trim()))return;const ind=l.replace(/^\\s*->\\s?/,"").match(/^\\s*/)[0].length,tok=l.trim().replace(/^->\\s*/,"").split(/\\s+/),home=/\\^$/.test(tok[0]),name=tok[0].replace(/\\^$/,"");if(!name||!/^(\\*|[#A-Za-z0-9_.\\-]+)$/.test(name))return;
 st.length=ind;const parent=ind?st[ind-1]:"";st[ind]=name;out.push({name,home,flood:/\\bF\\b/.test(tok.slice(1).join(" ")),parent,depth:ind})});return out}
function aclParse(raw){const r=[];String(raw||"").split("\\n").forEach(l=>{l=l.trim();let m=l.match(/^([0-9A-Fa-f]{2})\\s+([0-9A-Fa-f]{16,64})$/);if(m)return r.push({pk:m[2],perm:parseInt(m[1],16)&3,raw:parseInt(m[1],16)});m=l.match(/([0-9A-Fa-f]{16,64})\\W+([0-3])\\b/);if(m)r.push({pk:m[1],perm:+m[2]})});return r}
function snParse(raw){const r=[];String(raw||"").split("\\n").forEach(l=>{const m=l.trim().match(/^([A-Za-z0-9_.]+)=(.*)$/);if(m)r.push({k:m[1],v:m[2]})});return r}
function snVal(L,x){const g=L["sensor:"+x.k],base=L.sensors;if(g&&(!base||g.at>base.at))return g.error?{v:x.v,st:'<span class="err">'+e(/unsupported|unknown|\\?\\?/i.test(g.error)?"Not supported":g.error)+'</span>'}:{v:g.raw.replace(/^>\\s*/,"").replace(/^[A-Za-z0-9_.]+=/,""),st:'<span class="mut">Read '+e(t(g.at))+'</span>'};return{v:x.v,st:base?'<span class="mut">Read '+e(t(base.at))+'</span>':""}}
const PERM=["Guest","Read-only","Read-write","Admin"];
function lstat(L,k){const x=L[k];return x?(x.error&&!(x.raw&&/no reply/i.test(x.error))?'<span class="err">'+e(/unsupported|unknown|\\?\\?/i.test(x.error)?"Not supported by this firmware":x.error)+'</span> · '+e(t(x.at)):'<span class="mut">'+(x.src==="cache"?"Cached by T-SIM ":"Read ")+e(t(x.at))+'</span>'):'<span class="mut">Not read yet</span>'}
function showTools(d){const R=d.rpt||{},L=R.lists||{},S=d.settings||{},PS=!!(d.powersaving&&d.powersaving.blocks);$("rtools").classList.toggle("dim",PS||!S.console_enabled);
 const rg=rgParse(L.regions&&!L.regions.error?L.regions.raw:"");
 $("rgst").innerHTML=lstat(L,"regions")+(L.home&&!L.home.error?' · home: <b>'+e(L.home.raw.replace(/^>\\s*/,"").replace(/^home is\\s*/i,"")||"none")+'</b>':"")+(L.default&&!L.default.error?' · default scope: <b>'+e(L.default.raw.replace(/^>\\s*/,"").replace(/^default scope is\\s*/i,"").replace("<null>","none")||"none")+'</b>':"");
 $("rglist").innerHTML=rg.length?'<table class="small"><thead><tr><th>Region</th><th>Flooding</th><th></th></tr></thead><tbody>'+rg.map(r=>'<tr><td style="padding-left:'+(r.depth*14)+'px">'+e(r.name)+(r.home?' <span class="badge">home</span>':'')+'</td><td>'+(r.flood?'<span class="ok">allowed</span>':'<span class="mut">blocked</span>')+'</td><td class="nowrap"><button type="button" class="g sm" data-rg="flood" data-n="'+e(r.name)+'" data-a="'+(r.flood?0:1)+'">'+(r.flood?"Block":"Allow")+'</button> <button type="button" class="g sm" data-rg="home" data-n="'+e(r.name)+'">Home</button> <button type="button" class="g sm" data-rg="default" data-n="'+e(r.name)+'">Default</button>'+(r.name==="*"?"":' <button type="button" class="g sm" data-rg="remove" data-n="'+e(r.name)+'">✕</button>')+'</td></tr>').join("")+'</tbody></table>':'<p class="small mut">'+(L.regions?"No regions defined.":"Press Read regions.")+'</p>';
 $("rgparent").innerHTML='<option value="">(top level, *)</option>'+rg.map(r=>'<option>'+e(r.name)+'</option>').join("");
 $("rgraw").textContent=L.regions?L.regions.raw:"";
 const acl=aclParse(L.acl?L.acl.raw:"");$("aclst").innerHTML=lstat(L,"acl");
 $("acllist").innerHTML=acl.length?'<table class="small"><tbody>'+acl.map(a=>'<tr><td class="mono">'+e(a.pk.slice(0,16))+(a.pk.length>16?"…":"")+'</td><td>'+PERM[a.perm]+'</td><td><button type="button" class="g sm" data-acl="'+e(a.pk)+'">Remove</button></td></tr>').join("")+'</tbody></table>':'<p class="small mut">'+(L.acl&&!L.acl.error?"No entries.":"")+'</p>';$("aclraw").textContent=L.acl?L.acl.raw:"";
 const sn=snParse(L.sensors&&!L.sensors.error?L.sensors.raw:"");$("snst").innerHTML=lstat(L,"sensors");
 $("snlist").innerHTML=sn.length?sn.map(x=>{const sv=snVal(L,x),q=(R.ops_q||[]).includes("sensor get "+x.k);return '<div class="row small"><code>'+e(x.k)+'</code><input data-snk="'+e(x.k)+'" value="'+e(sv.v)+'" maxlength="60" style="flex:1"><button type="button" class="g sm" data-sng="'+e(x.k)+'">Read</button><button type="button" class="g sm" data-sns="'+e(x.k)+'">Set</button> '+(q?'<span class="mut">⏳ waiting</span>':sv.st)+'</div>'}).join(""):'<p class="small mut">'+(L.sensors&&!L.sensors.error?"No sensors.":"")+'</p>';
 $("logst").innerHTML=lstat(L,"log");$("lograw").textContent=L.log?L.log.raw:"";
 const O=L.ops||[];$("opsres").innerHTML=(R.ops_pending?'<div class="mut">⏳ '+R.ops_pending+' tool command(s) waiting to run</div>':'')+O.map(o=>'<div><code>'+e(o.cmd)+'</code> → <span class="'+(o.error?"err":"")+'">'+e(o.reply)+'</span> <span class="mut">'+e(t(o.at))+'</span></div>').join("")}
async function rop(ops,q,risk){if(q&&!confirm(q))return;const r=await post("rpt-ops",{ops,risk_ok:!!risk});const j=await rj(r);
 say("rtmsg",r.ok&&!(j.wake&&!j.wake.sent),r.ok?"Queued "+j.queued+" command"+(j.queued>1?"s":"")+". "+(j.wake&&j.wake.sent?"Text sent; results appear within a few minutes.":"Wake text not sent: "+friendly(j.wake||{},(j.wake||{}).status)):(j.error||friendly(j,r.status)));load()}
$("rtools").addEventListener("click",ev=>{const b=ev.target.closest("button");if(!b)return;const n=b.dataset.n;
 if(b.dataset.rd)return rop([{op:"read",what:b.dataset.rd}],"Read "+b.textContent.replace(/^Read /,"").toLowerCase()+" from the repeater? One text is sent now.");
 if(b.dataset.rg==="flood")return rop([{op:"region.flood",name:n,allow:b.dataset.a==="1"}],(b.dataset.a==="1"?"Allow":"Block")+" flooding for region "+n+" and save?"+(n==="*"?"\\n\\n⚠ The * wildcard controls packets with no region: blocking it drops all unscoped traffic.":""),n==="*");
 if(b.dataset.rg==="home")return rop([{op:"region.home",name:n}],"Make "+n+" this repeater's home region and save?");
 if(b.dataset.rg==="default")return rop([{op:"region.default",name:n}],"Make "+n+" the default scope and save?");
 if(b.dataset.rg==="remove")return rop([{op:"region.remove",name:n}],"⚠ Remove region "+n+" and save? Child regions must be removed first.",true);
 if(b.dataset.acl)return rop([{op:"acl.remove",pubkey:b.dataset.acl}],"⚠ Remove "+b.dataset.acl.slice(0,16)+"… from the access list? It loses its permissions on this repeater.",true);
 if(b.dataset.sng)return rop([{op:"sensor.get",key:b.dataset.sng}],"Read sensor "+b.dataset.sng+"? One text is sent now.");
 if(b.dataset.sns){const v=document.querySelector('[data-snk="'+b.dataset.sns+'"]').value;return rop([{op:"sensor.set",key:b.dataset.sns,value:v}],"Set sensor "+b.dataset.sns+" to "+v+"?")}
 const A={logstart:["log.start","Start capturing the receive log on the repeater?"],logstop:["log.stop","Stop capturing the receive log?"],logerase:["log.erase","⚠ Erase the captured log on the repeater? This can't be undone.",1],
  clocksync:["clock.sync","Set the repeater's clock to the current time? (The time is filled in when the T-SIM collects the command.)"],gpssync:["gps.sync","Sync the repeater clock from its GPS?"],gpssetloc:["gps.setloc","Set the repeater's saved location from its GPS?"],
  disc:["discover.neighbors","Ask nearby repeaters to identify themselves (zero-hop discovery)?"],clrstats:["clear.stats","⚠ Reset the repeater's packet and radio statistics to zero?",1],rgclear:["region.default","Clear the default scope region and save?"]}[b.dataset.t];
 if(A)return rop([{op:A[0],name:""}],A[1],!!A[2])});
$("rgadd").onsubmit=ev=>{ev.preventDefault();const f=ev.target,n=f.n.value.trim();if(!n)return;rop([{op:"region.put",name:n,parent:f.p.value,flood:f.fl.checked}],"Add region "+n+(f.p.value?" under "+f.p.value:"")+" ("+(f.fl.checked?"flooding allowed":"flooding blocked")+") and save?").then(()=>f.n.value="")};
$("acladd").onsubmit=ev=>{ev.preventDefault();const f=ev.target,pk=f.pk.value.trim(),pm=+f.pm.value;rop([{op:"acl.set",pubkey:pk,perm:pm}],(pm===3?"⚠ ":"")+"Give "+pk.slice(0,16)+(pk.length>16?"…":"")+" "+PERM[pm]+" permission on this repeater?"+(pm===3?"\\n\\nAdmin can change every setting, including passwords and radio.":""),pm===3).then(()=>f.pk.value="")};
$("nbrm").onsubmit=ev=>{ev.preventDefault();const p=ev.target.p.value.trim();rop([{op:"neighbor.remove",prefix:p}],"⚠ Remove every neighbor whose ID starts with "+p+" from the repeater's neighbor list?",true)};
$("tmpr").onsubmit=ev=>{ev.preventDefault();const f=ev.target;const o={op:"tempradio",f:f.f.value,bw:f.bw.value,sf:f.sf.value,cr:f.cr.value,mins:+f.m.value};
 if(!confirm("⚠ Switch the radio to "+o.f+" MHz / "+o.bw+" kHz / SF"+o.sf+" / CR"+o.cr+" for "+o.mins+" min?\\n\\nThe repeater leaves your mesh for that time (until it reverts or reboots). Not saved."))return;rop([o],null,true)};

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
 if(mode==="retry"){let xb={retry:true};if(a==="update-latest"&&TGTM){const z=eraseBody();if(!z||!confirm(MCONF))return null;Object.assign(xb,z)}else if(!confirm("Retry the same update? This sends one text to wake the T-SIM."))return null;
  const r=await post(a,xb);const j=await rj(r);if(j.sent){pending[kind]=new Date();toast("Retry sent. "+OKMSG[a],"ok")}else toast(friendly(j,r.status),"bad");return true}
 return false}
document.querySelectorAll("button[data-a]").forEach(b=>b.onclick=async()=>{
 const a=b.dataset.a;if(b.dataset.busy)return;
 if(UKIND[a]&&b.dataset.mode&&b.dataset.mode!=="update"){b.dataset.busy=1;b.disabled=true;const old=b.textContent;b.textContent="Working…";
  try{await updClick(b,a)}catch(x){toast("Couldn't reach the dashboard. Check your internet connection and try again.","bad")}
  delete b.dataset.busy;b.textContent=old;b.disabled=false;load();return}
 let xb;if(a==="update-latest"&&TGTM){xb=eraseBody();if(!xb||!confirm(MCONF))return}else if(b.dataset.c&&!confirm(b.dataset.c))return;b.dataset.busy=1;
 b.disabled=true;const old=b.textContent;b.textContent="Working…";
 try{
  if(a==="check"){const[r1,r2]=await Promise.all([post("check"),post("tsim-check")]);const[j1,j2]=await Promise.all([rj(r1),rj(r2)]);
   const parts=[r1.ok?"Heltec: "+j1.latest_available.asset_name:"Heltec: "+friendly(j1,r1.status),r2.ok?"T-SIM: "+j2.latest_available.asset_name+(j2.latest_available.tag&&j2.latest_available.tag!=="url"?" ("+j2.latest_available.tag+")":""):"T-SIM: "+friendly(j2,r2.status)];
   toast("Latest available. "+parts.join(" · "),r1.ok&&r2.ok?"ok":"bad");}
  else{const r=await post(a,xb);const j=await rj(r);if(r.status===401){location.href="/";return}
   if(j.sent){toast(OKMSG[a],"ok");if(a==="update-latest")pending.heltec=new Date();if(a==="tsim-update")pending.tsim=new Date();}
   else toast(friendly(j,r.status),"bad");}
 }catch(x){toast("Couldn't reach the dashboard. Check your internet connection and try again.","bad")}
 delete b.dataset.busy;b.textContent=old;b.disabled=false;load();
});
/* ---- firmware upload ---- */
let FWU={items:[],selected:"",max:4194304,per_device:3},TGTM=false;
const kb=n=>n>=1048576?(n/1048576).toFixed(2)+" MB":Math.round(n/1024)+" KB";
function fwKind(u8,name){const L=u8.length,g=o=>[u8[o],u8[o+1]],h=g(0),p=L>0x8002?g(0x8000):[0,0],a=L>0x10010?g(0x10000):[0,0],q=L>0x7002?g(0x7000):[0,0];
 const app0=h[0]===0xE9&&h[1]>=1&&h[1]<=16,pt=p[0]===0xAA&&p[1]===0x50,gap=p[0]===0xFF&&p[1]===0xFF,app10=a[0]===0xE9&&a[1]>=1&&a[1]<=16,pt7=q[0]===0xAA&&q[1]===0x50,nm=/-merged|freshinstall|factory/i.test(name);
 if(pt||(app10&&gap)||(pt7&&app0))return{ok:true,merged:true};if(app0)return{ok:true,merged:nm,nameOnly:nm};return{ok:false}}
function showFwup(d){const F=d.fwup||{items:[]};FWU=F;TGTM=!!F.target_merged;
 const sel=F.items.find(x=>x.token===F.selected);
 if(sel){$("srcsum").textContent="Uploaded file: "+sel.name;document.querySelectorAll('button[data-a="update-latest"]').forEach(b=>{b.disabled=false;b.title=""})}
 $("upsum").textContent=F.items.length?F.items.length+" file(s)"+(sel?" · Update uses "+sel.name:""):"none";
 $("mwarn").hidden=!TGTM;
 const fl=((d.progress||{}).heltec||{}).flash;
 $("uplist").innerHTML=F.items.length?F.items.map(x=>'<div class="rsrow"><div class="rsl">'+e(x.name)+(x.merged?' <span class="badge failed">FULL ERASE</span>':' <span class="badge">app-only</span>')+(x.token===F.selected?' <span class="badge run">used by Update</span>':'')+'</div>'+
  '<div class="small mono rsro">'+e(kb(x.size))+' ('+x.size+' bytes) · '+e(x.chip)+'<br>sha256 '+e(x.sha256)+(x.md5?'<br>md5 '+e(x.md5):'')+'</div>'+
  (x.warnings&&x.warnings.length?'<div class="small warn">'+x.warnings.map(e).join("<br>")+'</div>':'')+
  (x.md5&&fl&&fl.md5&&x.token===F.selected&&fl.md5===x.md5?'<div class="small ok">✓ The last flash MD5 matches this file</div>':'')+
  '<div class="small mut">Uploaded '+e(t(x.uploaded_at))+'</div><div class="acts" style="margin-top:4px">'+(x.token===F.selected?'<button type="button" class="g sm" data-fw="unuse">Use the GitHub release instead</button>':'<button type="button" class="sm" data-fw="use" data-tk="'+e(x.token)+'">Use for Update</button>')+'<button type="button" class="g sm" data-fw="del" data-tk="'+e(x.token)+'">Delete</button></div></div>').join(""):'<p class="small mut">No uploaded files.</p>';
 $("upbtn").disabled=F.items.length>=(F.per_device||3);$("upbtn").title=$("upbtn").disabled?"Delete a file first":""}
$("upfile").onchange=async()=>{const f=$("upfile").files[0];$("upcheck").innerHTML="";$("upmsg").textContent="";if(!f)return;
 let k={ok:false};try{k=fwKind(new Uint8Array(await f.slice(0,0x10020).arrayBuffer()),f.name)}catch(x){}
 let h='<b>'+e(f.name)+'</b> · '+e(kb(f.size));
 if(!k.ok)h+='<div class="err">Not an ESP32 firmware image (no 0xE9 header). Pick the Heltec .bin file.</div>';
 else if(k.merged)h+='<div class="danger"><b class="h">⚠ Full-erase (merged / fresh-install) image'+(k.nameOnly?' (by its file name)':'')+'</b><br>Flashing it erases the Heltec&#39;s identity (private key), name, settings, ACL and regions. You can upload it, but Update will need extra confirmation. <a href="#" data-bk="1">Back up first ›</a></div>';
 else h+='<div class="ok">App-only image (keeps identity and settings).</div>';
 if(f.size>(FWU.max||4194304))h+='<div class="err">Too large: the limit is '+e(kb(FWU.max||4194304))+'.</div>';
 $("upcheck").innerHTML=h};
$("upbtn").onclick=()=>{const f=$("upfile").files[0];if(!f){say("upmsg",false,"Pick a .bin file first");return}
 if(f.size>(FWU.max||4194304)){say("upmsg",false,"That file is too large");return}
 const x=new XMLHttpRequest(),bar=$("upbar");bar.hidden=false;bar.firstChild.style.width="0%";$("upbtn").disabled=true;say("upmsg",true,"Uploading…");
 x.open("POST",API+"fw-upload");x.withCredentials=true;x.setRequestHeader("Content-Type","application/octet-stream");x.setRequestHeader("X-File-Name",encodeURIComponent(f.name));
 x.upload.onprogress=ev=>{if(ev.lengthComputable)bar.firstChild.style.width=Math.round(ev.loaded*100/ev.total)+"%"};
 x.onload=()=>{let j={};try{j=JSON.parse(x.responseText)}catch(z){}$("upbtn").disabled=false;bar.hidden=true;
  if(x.status===401){location.href="/";return}
  if(x.status<300&&j.item){const it=j.item;say("upmsg",true,(j.duplicate?j.note+" ":"Uploaded: ")+it.size+" bytes · sha256 "+it.sha256);$("upfile").value="";$("upcheck").innerHTML="";toast((j.duplicate?"Already uploaded: ":"Uploaded ")+it.name+" ("+it.size+" bytes). Press Use for Update to flash it.","ok");load()}
  else say("upmsg",false,friendly(j,x.status))};
 x.onerror=()=>{$("upbtn").disabled=false;bar.hidden=true;say("upmsg",false,"Upload failed. Check your connection and try again.")};
 x.send(f)};
document.addEventListener("click",async ev=>{const b=ev.target.closest("[data-fw],[data-bk]");if(!b)return;
 if(b.dataset.bk){ev.preventDefault();bkQuick();return}
 const k=b.dataset.fw,tk=b.dataset.tk;
 if(k==="del"){if(!confirm("Delete this uploaded firmware file from the dashboard?"))return;const r=await post("fw-delete",{token:tk});const j=await rj(r);r.ok?toast("Deleted","ok"):toast(friendly(j,r.status),"bad");srcLoaded=false;load();return}
 if(k==="unuse"){const r=await post("source",{upload:""});const j=await rj(r);r.ok?toast("Update uses the GitHub release / direct link again","ok"):toast(friendly(j,r.status),"bad");srcLoaded=false;load();return}
 if(k==="use"){const it=FWU.items.find(x=>x.token===tk);if(!it)return;
  if(it.merged&&!confirm("⚠ "+it.name+" is a FULL-ERASE image. Flashing it wipes the Heltec's identity (private key), name, settings, ACL and regions. Use it for the next Update anyway? (Update will still ask you to tick the box and type ERASE.)"))return;
  const r=await post("source",{upload:tk,merged_ack:!!it.merged});const j=await rj(r);r.ok?toast("Update radio firmware will now flash "+it.name+". Nothing is sent until you press it.","ok"):toast(friendly(j,r.status),"bad");srcLoaded=false;load()}});
function eraseBody(){if(!$("mwack").checked||$("mwtyped").value.trim().toUpperCase()!=="ERASE"){$("mwarn").hidden=false;$("mwarn").scrollIntoView({behavior:"smooth",block:"center"});toast("This is a full-erase image: tick the box and type ERASE in the red box first.","bad");return null}
 return{erase_ok:true,typed:"ERASE"}}
const MCONF="⚠ FULL ERASE: flash a merged / fresh-install image? The Heltec loses its identity (private key), name, settings, passwords, ACL and regions. This sends one text to the T-SIM.";
/* ---- backup / restore ---- */
let BK={},BKFILE=null,BKPLAN=null;
function dl(name,txt){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([txt],{type:"application/json"}));a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)}
function showBackup(d){const B=d.backup||{};BK=B;const I=B.items||[];
 $("bksum").textContent=I.length?I.length+" saved · last "+t(I[0].created_at):"no backups yet";
 $("bkkey").innerHTML=B.prvkey?'<span class="warn">🔑 Private key stored for backups ('+e(B.prvkey.hint)+', read '+e(t(B.prvkey.at))+')</span>':B.prv_pending?"⏳ Private-key read queued, waiting for the T-SIM…":'<span class="mut">No private key stored. Backups then hold settings only (restoring them keeps the current identity).</span>';
 $("bkinc").disabled=!B.prvkey;if(!B.prvkey)$("bkinc").checked=false;$("prvforget").hidden=!B.prvkey;
 $("bkknown").textContent=(B.settings_known||0)+" repeater settings known"+(B.settings_known?"":": press Read all in Repeater settings (or turn on the T-SIM settings cache) first");
 $("bklist").innerHTML=I.map(x=>'<div class="rsrow small"><b>'+e(t(x.created_at))+'</b> · '+x.settings+' settings · '+e(kb(x.bytes))+(x.private_key?' <span class="badge failed">SENSITIVE: private key</span>':'')+(x.passwords?' <span class="badge mut">passwords</span>':'')+' <a href="'+API+'backup-get?bid='+e(x.bid)+'" download>Download</a> <button type="button" class="g sm" data-bkdel="'+e(x.bid)+'">Delete</button></div>').join("")||'<p class="small mut">No saved backups.</p>';
 showJob(B.restore,B.restore_inflight)}
async function bkMake(){const inc=$("bkinc").checked;if(inc&&!confirm("Include the private key? Anyone with the file can impersonate this repeater. Keep it somewhere private."))return false;
 const r=await post("backup-create",{include_key:inc});const j=await rj(r);if(!r.ok){say("bkmsg",false,friendly(j,r.status));return false}
 dl(j.item.file,JSON.stringify(j.backup,null,2));say("bkmsg",true,"Backup saved and downloaded"+(j.backup.identity.private_key?" (SENSITIVE: contains the private key)":""));load();return true}
$("bkmake").onclick=bkMake;
function bkQuick(){const bx=$("bkbox");bx.open=true;bx.scrollIntoView({behavior:"smooth"});bkMake()}
$("prvread").onclick=async()=>{if(!confirm("Read the repeater's private key over the serial console so it can go into backups? This sends one text to wake the T-SIM. The key is then stored on this dashboard (hidden in the history) until you press Forget."))return;
 const r=await post("prvkey-read",{confirm:true});const j=await rj(r);r.ok?toast("Queued. The T-SIM reads it on its next wake ("+(j.wake&&j.wake.sent?"text sent":"text not sent: "+friendly(j.wake||{},0))+").","ok"):toast(friendly(j,r.status),"bad");load()};
$("prvforget").onclick=async()=>{if(!confirm("Delete the stored private key from the dashboard? Saved backups that include it keep their copy."))return;const r=await post("prvkey-forget",{});r.ok?toast("Deleted","ok"):toast("Failed","bad");load()};
$("bkfile").onchange=async()=>{const f=$("bkfile").files[0];$("bkprev").innerHTML="";BKFILE=null;if(!f)return;
 let bk;try{bk=JSON.parse(await f.text())}catch(x){$("bkprev").innerHTML='<p class="err small">Not a JSON file.</p>';return}
 const r=await post("backup-preview",{backup:bk});const j=await rj(r);if(!r.ok){$("bkprev").innerHTML='<p class="err small">'+e(friendly(j,r.status))+'</p>';return}
 BKFILE=bk;BKPLAN=j.plan;renderPlan(j)}
function renderPlan(j){const p=j.plan,row=(a,b,c)=>'<tr><td>'+e(a)+'</td><td class="mono">'+e(b==null||b===""?"(unknown)":String(b))+'</td><td class="mono">'+e(String(c))+'</td></tr>';
 const grp=(k,title,n,body,extra)=>'<div class="rsrow"><label class="tog"><input type="checkbox" data-g="'+k+'"'+(n?'':' disabled')+'> <b>'+e(title)+'</b> ('+n+')</label>'+(extra||"")+(n?'<details class="small"><summary>Show changes</summary>'+body+'</details>':'')+'</div>';
 const tb=rows=>'<div class="tw"><table class="small"><thead><tr><th>Item</th><th>Now</th><th>Backup</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
 const cl=a=>'<ul>'+a.map(x=>'<li class="mono">'+e(x.desc||x.cmd)+(x.risk?" ⚠":"")+'</li>').join("")+'</ul>';
 const sens=BKFILE.identity&&BKFILE.identity.private_key,I=p.identity;
 let h='<p class="small">Backup of <b>'+e((j.device||{}).name||"?")+'</b> from '+e(t(j.created_at))+(sens?' <span class="badge failed">SENSITIVE: contains the private key</span>':'')+'. Only differences are listed; (unknown) = not read on this dashboard yet.</p>';
 h+=grp("dashboard","Dashboard config (applied here right away, nothing sent)",p.dashboard.length,tb(p.dashboard.map(x=>row(x.label,x.current,x.backup)).join("")));
 h+=grp("settings","Repeater settings",p.settings.length,tb(p.settings.map(x=>row(x.label+(x.risk?" ⚠":""),x.current,x.backup)).join("")));
 h+=grp("regions","Regions (adds and flood rules; regions not in the backup are kept)",p.regions.filter(x=>!x.list).length,cl(p.regions));
 h+=grp("acl","Access list (adds and permission changes; extra entries are kept)",p.acl.filter(x=>!x.list).length,cl(p.acl));
 h+=grp("identity","Identity (private key), then reboot",I?1:0,I?'<p>Backup public key: <span class="mono">'+e(I.public_key||"?")+'</span><br>Current: <span class="mono">'+e(I.current_public_key||"(unknown)")+'</span>'+(I.same?'<br><span class="ok">Same identity as now; no need to restore it.</span>':'')+'</p>':'',I?'<div class="small warn">Restores the private key with set prv.key, then reboots the repeater. You will type IDENTITY to confirm.</div>':'');
 if(p.skipped.length)h+='<p class="small warn">Skipped: '+p.skipped.map(s=>e(s.what+" ("+s.why+")")).join("; ")+'</p>';
 h+='<div class="acts"><button type="button" id="bkapply">Restore selected</button><span id="bkamsg" class="msg"></span></div><p class="small mut">Repeater changes are staged first; nothing reaches the T-SIM until you press Send below. Up to '+j.per_wake+' commands run per T-SIM wake.</p>';
 $("bkprev").innerHTML=h;$("bkapply").onclick=bkApply}
async function bkApply(){const g={};document.querySelectorAll("#bkprev input[data-g]").forEach(c=>g[c.dataset.g]=c.checked);
 if(!Object.values(g).some(Boolean)){say("bkamsg",false,"Tick at least one group");return}
 const p=BKPLAN,risky=!!((g.settings&&p.settings.some(x=>x.risk))||(g.regions&&p.regions.some(x=>x.risk))||(g.acl&&p.acl.some(x=>x.risk))||(g.identity&&p.identity));
 let typed="";if(risky&&!confirm("⚠ This restore includes risky changes (radio, passwords, admin access or identity). A wrong backup can take the repeater off your mesh or lock you out. Continue?"))return;
 if(g.identity&&p.identity){typed=prompt("Restoring the private key replaces this repeater's identity and reboots it. Type IDENTITY to confirm.")||"";if(typed.trim().toUpperCase()!=="IDENTITY"){say("bkamsg",false,"Not confirmed");return}}
 const r=await post("restore-prepare",{backup:BKFILE,groups:g,risk_ok:risky,typed});const j=await rj(r);
 if(!r.ok){say("bkamsg",false,friendly(j,r.status));return}
 say("bkamsg",true,(j.applied&&j.applied.length?"Dashboard config applied ("+j.applied.join(", ")+"). ":"")+(j.job?"Repeater restore staged: press Send below.":""));srcLoaded=false;tsimLoaded=false;load()}
function showJob(J,inflight){const el=$("bkjob");if(!J){el.innerHTML=inflight?'<p class="small">⏳ '+inflight+' restore command(s) waiting for or running on the T-SIM.</p>':"";return}
 el.innerHTML='<div class="psnote" style="border-left-color:var(--acc);background:#1f6feb14"><b>Restore staged</b> ('+e(J.groups.join(", "))+'): '+J.sent+' of '+J.total+' commands sent, '+J.remaining+' left in '+J.parts_left+' part(s).'+(inflight?' '+inflight+' still waiting on the T-SIM.':'')+'<div class="acts" style="margin-top:6px"><button type="button" class="w sm" id="bksend">Send part '+(J.parts_sent+1)+' ('+J.next+' commands)</button><button type="button" class="g sm" id="bkcancel">Cancel restore</button></div></div>';
 $("bksend").onclick=async()=>{if(!confirm("Send one text to wake the T-SIM and run "+J.next+" restore command(s) on the repeater?"))return;const r=await post("restore-send",{});const j=await rj(r);
  r.ok?toast("Queued "+j.queued+" command(s)"+(j.remaining?", "+j.remaining+" left":", that was the last part")+". "+(j.wake&&j.wake.sent?"Text sent.":"Text not sent: "+friendly(j.wake||{},0)+" (they run at the next wake)."),"ok"):toast(friendly(j,r.status),"bad");load()};
 $("bkcancel").onclick=async()=>{if(!confirm("Cancel the staged restore? Commands already sent to the T-SIM can't be recalled."))return;await post("restore-cancel",{});load()}}
document.addEventListener("click",async ev=>{const b=ev.target.closest("[data-bkdel]");if(!b)return;if(!confirm("Delete this saved backup?"))return;const r=await post("backup-delete",{bid:b.dataset.bkdel});r.ok?toast("Deleted","ok"):toast("Failed","bad");load()});
/* ---- location (GPS) ---- */
let GPS={},gpsLoaded=false,LMAP=null,LMK=null,gpsPend=null;
const gpsPendResolved=${gpsPendResolved.toString().replace(/^function \w+/, "function")};
const GSTEP=["Waiting for T-SIM to wake","Searching for satellites","Done"];
function llTxt(f){return f.lat.toFixed(6)+", "+f.lon.toFixed(6)}
function acc(h){if(h==null||h<0)return null;const q=h<=1?"excellent":h<=2?"good":h<=5?"fair":"poor";return "HDOP "+h.toFixed(1)+" ("+q+", about ±"+dist(Math.max(3,Math.round(h*5)))+")"}
function copyLL(){const f=GPS.fix;if(!f)return;const s=llTxt(f);(navigator.clipboard?navigator.clipboard.writeText(s):Promise.reject()).then(()=>toast("Coordinates copied","ok"),()=>toast(s,"ok"))}
function loadLeaflet(){if(window.L)return Promise.resolve();if(loadLeaflet.p)return loadLeaflet.p;
 const c=document.createElement("link");c.rel="stylesheet";c.href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";c.integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=";c.crossOrigin="";document.head.appendChild(c);
 return loadLeaflet.p=new Promise((ok,bad)=>{const s=document.createElement("script");s.src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";s.integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";s.crossOrigin="";s.onload=ok;s.onerror=bad;document.head.appendChild(s)})}
function showMap(f){$("gpsmapw").hidden=false;loadLeaflet().then(()=>{const ll=[f.lat,f.lon];
 if(!LMAP){LMAP=L.map("gpsmap",{scrollWheelZoom:false,attributionControl:false}).setView(ll,15);L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,referrerPolicy:"strict-origin-when-cross-origin"}).addTo(LMAP);LMK=L.marker(ll).addTo(LMAP)}
 else if(showMap.k!==ll.join()){LMK.setLatLng(ll);LMAP.setView(ll,LMAP.getZoom())}showMap.k=ll.join();setTimeout(()=>LMAP.invalidateSize(),50)}).catch(()=>{$("gpsmap").innerHTML='<p class="small mut" style="padding:10px">Map couldn’t load (no internet?). Coordinates above still work.</p>'})}
function gprog(p){if(gpsPend&&!gpsPendResolved(gpsPend.toISOString(),p,GPS.attempt))p={state:"running",step:0,pct:10,times:{0:gpsPend.toISOString()}};
 if(!p||p.state==="idle")return "";
 if(p.state==="cancelled")return '<p class="small mut">Location request cancelled '+e(t(p.finished_at))+'.</p>';
 const fail=p.state==="failed"||p.state==="timeout";
 const head=p.state==="done"?"Location updated "+t(p.finished_at):p.state==="running"?"Getting location…":p.state==="timeout"?"Location request stalled":"No GPS fix "+t(p.finished_at);
 const rows=GSTEP.map((s,i)=>{const c=p.state==="done"||i<p.step?"ok":i===p.step?(fail?"bad":"cur"):"";return '<li class="'+c+'"><span>'+e(s)+'</span><span>'+(p.times&&p.times[i]?e(t(p.times[i])):"")+'</span></li>'}).join("");
 return '<div style="margin-top:10px"><div class="row"><b class="small">'+e(head)+'</b><span class="badge '+(p.state==="done"?"":fail?"failed":"run")+'">'+(p.state==="done"?"Done":p.state==="timeout"?"Stalled":fail?"No fix":p.pct+"%")+'</span></div>'+
  '<div class="bar '+(p.state==="done"?"done":fail?"failed":"")+'"><i style="width:'+(fail?Math.max(p.pct,8):p.pct)+'%"></i></div>'+(p.reason?'<p class="small err">'+e(p.reason)+'</p>':'')+
  (p.state==="running"||p.state==="timeout"?'<ol class="steps">'+rows+'</ol>':'<details class="small"><summary>Show steps</summary><ol class="steps">'+rows+'</ol></details>')+'</div>'}
function gdiag(A){const D=A&&A.diag;if(!D)return"";
 const rd=D.warm?"already on (warm)":D.ready_ms==null||D.ready_ms<0?"no READY! seen within 30 s":(D.ready_ms/1000).toFixed(1)+" s";
 return '<details class="small" style="margin-top:8px"><summary>GPS diagnostics (last attempt '+e(t(A.at))+')</summary>'+kv([["GNSS ready",rd],["Power check",D.pwr?{h:"<code>"+e(D.pwr)+"</code>"}:"(no reply)"],["Antenna power",D.ant||null],["GNSS mode",D.mode?{h:"<code>"+e(D.mode)+"</code>"}:null],["Satellites parsed",D.sats],["Searched",A.secs!=null?A.secs+" s of "+(D.timeout||"?")+" s":null],["First reply",D.first?{h:'<code class="sens">'+e(D.first)+"</code>"}:"(none)"],["Last reply",D.last?{h:'<code class="sens">'+e(D.last)+"</code>"}:"(none)"]])+'<p class="small mut">Replies with only commas mean the GPS is on but has no satellites yet.</p></details>'}
function gpsMode(p){const s=gpsPend&&!gpsPendResolved(gpsPend.toISOString(),p,GPS.attempt)?"running":(p&&p.state)||"idle";return s==="running"?"cancel":(s==="failed"||s==="timeout"||s==="cancelled")?"retry":"get"}
function showGps(d){const G=d.gps||{};GPS=G;const F=G.fix,A=G.attempt,P=G.progress;
 if(gpsPend&&gpsPendResolved(gpsPend.toISOString(),P,A))gpsPend=null;
 $("gpsnote").hidden=G.supported!==false;
 $("gpsat").textContent=F?"fix "+t(F.utc||F.received_at):"";
 const cp=F?{h:'<span class="sens">'+e(llTxt(F))+'</span> <button type="button" class="eye" onclick="sensToggle()" title="Show">👁</button> <button type="button" class="g sm" onclick="copyLL()">Copy</button>'}:null;
 $("c-gps").innerHTML=F?kv([["Coordinates",cp],["Fix time",t(F.utc||F.received_at)+(F.trigger==="auto"?" (on check-in)":"")],["Satellites",F.sats],["Accuracy",acc(F.hdop)],["Altitude",dist(F.alt)],
  ...(A&&!A.fix&&new Date(A.at)>new Date(F.received_at)?[["Last attempt","No fix "+t(A.at)+(A.sats!=null?" · "+A.sats+" satellites seen":"")]]:[])])
  :'<p class="small mut">'+(A?"No fix yet. Last attempt "+e(t(A.at))+(A.sats!=null?" saw "+A.sats+" satellites":"")+". Check the GNSS antenna and that it can see the sky.":"No location yet. Press Get location.")+'</p>';
 if(F)showMap(F);else $("gpsmapw").hidden=true;
 $("p-gps").innerHTML=gprog(P)+gdiag(A);
 const b=$("gpsbtn");if(!b.dataset.busy){const m=gpsMode(P);b.dataset.mode=m;b.textContent=m==="cancel"?"Cancel location request":m==="retry"?"Retry location":"Get location";b.className=m==="cancel"?"g":"";b.disabled=G.supported===false&&m!=="cancel"}
 if(!gpsLoaded&&G.settings){const f=$("gpsf");f.auto.checked=!!G.settings.auto;f.to.value=G.settings.timeout_s;gpsLoaded=true}
 $("gpsmsg").textContent=G.settings_pending?"Waiting for the T-SIM's next wake to apply.":$("gpsmsg").textContent;
 // LoRa tab: repeater location
 const LP=G.location||{};$("locsum").textContent=LP.state==="done"?"set "+t(LP.finished_at):LP.state==="queued"||LP.state==="sending"?"sending…":"";
 $("locinfo").innerHTML=kv([["GPS position",F?{h:'<span class="sens">'+e(llTxt(F))+'</span> <button type="button" class="eye" onclick="sensToggle()" title="Show">👁</button>'}:"No GPS fix yet (T-SIM tab › Get location)"],["Fix time",F?t(F.utc||F.received_at):null]]);
 const lb=$("locbtn");if(!lb.dataset.busy)lb.disabled=!F||LP.state==="queued"||LP.state==="sending";
 $("locres").innerHTML=LP.state&&LP.state!=="idle"?'<p class="'+(LP.state==="done"?"ok":LP.state==="failed"?"err":"mut")+'" style="margin:8px 0 4px"><b>'+e(LP.state==="done"?"Repeater location set "+t(LP.finished_at):LP.state==="failed"?"Repeater didn’t confirm the location":LP.state==="cancelled"?"Cancelled":"Waiting for the T-SIM to wake and send it…")+'</b></p>'+
  (LP.outputs||[]).map(o=>'<div><code>'+e(o.cmd)+'</code> → '+e(o.status==="done"||o.status==="error"?(o.output||"(no reply)"):o.status)+'</div>').join(""):"";
 sensApply()}
let NICKS={};
$("nb").onclick=async(ev)=>{const b=ev.target.closest("[data-nick]");if(!b)return;const k=b.dataset.nick;
 const n=prompt("Name for node "+k+" (shown on this dashboard only; leave empty to remove):",NICKS[k]||"");if(n===null)return;
 const r=await post("nick",{hash:k,name:n});const j=await rj(r);if(r.status===401){location.href="/";return}
 if(r.ok){toast(n.trim()?"Saved name for "+k:"Name removed","ok");load()}else toast(friendly(j,r.status),"bad")};
$("gpsbtn").onclick=async()=>{const b=$("gpsbtn");if(b.dataset.busy)return;const m=b.dataset.mode||"get";
 if(m==="cancel"){if(!confirm("Cancel the location request? No text is sent."))return}
 else if(!confirm((m==="retry"?"Try again? ":"")+"Text the T-SIM to wake and read its GPS position? It searches for up to "+(GPS.settings?GPS.settings.timeout_s:180)+" s (first fix can take up to 5 min), then the location appears here."))return;
 b.dataset.busy=1;b.disabled=true;const old=b.textContent;b.textContent="Working…";
 try{const r=await post(m==="cancel"?"gps-cancel":"gps-fix",m==="retry"?{retry:true}:undefined);const j=await rj(r);if(r.status===401){location.href="/";return}
  if(m==="cancel"){if(r.ok){gpsPend=null;toast(j.note,"ok")}else toast(friendly(j,r.status),"bad")}
  else if(j.sent){gpsPend=j.queued&&j.queued.queued_at?new Date(j.queued.queued_at):new Date(Date.now()-10000);toast("Text sent. The T-SIM will wake and look for satellites; the location appears here in a few minutes.","ok")}
  else toast(friendly(j,r.status),"bad")}
 catch(x){toast("Couldn't reach the dashboard. Check your internet connection and try again.","bad")}
 delete b.dataset.busy;b.textContent=old;b.disabled=false;load()};
$("gpsf").onsubmit=async ev=>{ev.preventDefault();const f=ev.target,to=+f.to.value;
 if(!(to>=30&&to<=600))return say("gpsmsg",false,"Fix timeout must be between 30 and 600 seconds.");
 if(f.auto.checked&&!GPS.settings?.auto&&!confirm("Read GPS on every check-in? Each check-in then runs GPS for up to "+to+" s, which uses more battery."))return;
 const r=await post("gps-settings",{auto:f.auto.checked,timeout_s:to});const j=await rj(r);say("gpsmsg",r.ok,r.ok?"Saved. Applied at the T-SIM's next wake.":friendly(j,r.status));if(r.ok){gpsLoaded=false;load()}};
$("locbtn").onclick=async()=>{const b=$("locbtn"),F=GPS.fix;if(!F||b.dataset.busy)return;
 if(!confirm("Set the repeater's advertised location to "+llTxt(F)+"? This texts the T-SIM once and sends 'set lat' and 'set lon' to the repeater. Everyone on the mesh can then see this position."))return;
 b.dataset.busy=1;b.disabled=true;const old=b.textContent;b.textContent="Working…";
 try{const r=await post("set-location",{confirm:true});const j=await rj(r);say("locmsg",!!j.sent,j.sent?"Text sent. The result appears here within a few minutes.":friendly(j,r.status))}
 catch(x){say("locmsg",false,"Couldn't reach the dashboard. Check your internet connection and try again.")}
 delete b.dataset.busy;b.textContent=old;load()};
function tab(){const k=(location.hash||"#ov").slice(1),v=["ov","radio","tsim","act"].includes(k)?k:"ov";
 document.querySelectorAll(".pane").forEach(p=>p.hidden=p.id!=="t-"+v);if(v==="tsim"&&LMAP)setTimeout(()=>LMAP.invalidateSize(),50);document.querySelectorAll("#tabs button").forEach(b=>b.classList.toggle("on",b.dataset.t===v))}
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
      if (parts[0] === "fw" && parts.length === 2 && (m === "GET" || m === "HEAD")) return await handleFwDownload(request, env, parts[1]);
      if (parts[0] === "ingest" && parts.length === 2 && m === "POST") return await handleIngest(request, env, parts[1]);
      if (parts[0] === "api" && parts[1] === "dev" && parts.length === 4 && parts[3] === "commands" && m === "GET") return await handleDeviceCommands(request, env, parts[2]);
      if (parts[0] === "api" && parts[1] === "dev" && parts.length === 4 && parts[3] === "cfglist" && m === "GET") return await handleCfgList(request, env, parts[2]);
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
