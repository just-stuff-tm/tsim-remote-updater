// v1.8.0 tests: unified check-ins, device-vs-saved state, queue safeguards. Run: node test/v180.mjs
import worker, { DEFAULT_TCFG, tcfgFromLegacy, validateTcfg, tcfgCmd, tcfgLegacyCmds, parseTcfgApplied, parseLegacyApplied, tcfgEcho, deviceState, costEstimate,
  wakeSuppressed, cmdKind, queueGuard, queueFullMsg, expireQueued, serveDedupe, fwDupResult, computeProgress, TCFG_FW } from "../src/index.js";
import assert from "node:assert";

const kv = new Map();
const STATE = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
const env = { STATE, HOLOGRAM_API_KEY: "k", ADMIN_TOKEN: "admintok", SESSION_SECRET: "sess-secret-for-tests" };
let holo = 0, holoLast = "";
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("hologram")) { holo++; holoLast = JSON.parse(init.body).body; return new Response(JSON.stringify({ success: true })); }
  if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v1.8.0", assets: [] }));
  throw new Error("unexpected fetch " + url);
};
const B = "https://w";
const call = (path, init = {}) => worker.fetch(new Request(B + path, init), env);
const admin = (path, method = "GET", body) => call(path, { method, headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
const J = (o) => JSON.parse(kv.get(o) || "null");

// ---- pure: migration
assert.deepEqual(tcfgFromLegacy({}), DEFAULT_TCFG);
let m = tcfgFromLegacy({ wdcfg: { int_min: 0, hb: true, sms: false } });
assert.equal(m.ci, 0, "int_min 0 -> Off");
m = tcfgFromLegacy({ wdcfg: { int_min: 720, hb: false, sms: true, smesh: true, upoll: 60, usol: 1500 }, power: { lb_en: true, lb_int: 30 }, cachecfg: { en: true, int_h: 24 }, gpscfg: { auto: true, timeout_s: 240 }, settings: { schedule_hours: 12 } });
assert.deepEqual(m, { ci: 720, do: "cmsgt", cs: 24, qc: 30, q: "bu", usol: 1500, gto: 240, txt_h: 12 });
m = tcfgFromLegacy({ wdcfg: { int_min: 7 } }); assert.equal(m.ci, 180, "out-of-range interval falls back to the watchdog default");
m = tcfgFromLegacy({ power: { lb_en: false }, wdcfg: { upoll: 0 } }); assert.equal(m.q, ""); assert.equal(m.qc, 0);
// ---- pure: TCFG string per the shared spec
assert.equal(tcfgCmd({ ci: 360, do: "ch", cs: 0, qc: 30, q: "u", usol: 2000, gto: 180 }), "TCFG ci=360 do=hc cs=0 qc=30 q=u usol=2000 gto=180");
assert.equal(tcfgCmd({ ci: 0, do: "", cs: 0, qc: 0, q: "", usol: 0, gto: 180 }), "TCFG ci=0 do=- cs=0 qc=0 q=- usol=0 gto=180");
assert.throws(() => validateTcfg({}, { ci: 45 })); assert.throws(() => validateTcfg({}, { qc: 5 })); assert.throws(() => validateTcfg({}, { gto: 10 }));
assert.equal(validateTcfg({}, { q: "b", qc: 0 }).qc, 30, "quick checks picked but no cadence -> default cadence");
// ---- pure: legacy batching (fw < 1.8): only kinds that change, byte-identical to the per-feature commands
let L1 = tcfgLegacyCmds(tcfgFromLegacy({}), {});
const base = tcfgFromLegacy({ wdcfg: { int_min: 360, hb: true } });
L1 = tcfgLegacyCmds(base, { wdcfg: { int_min: 360, hb: true } });
assert.deepEqual(L1.cmds.map((c) => c.kind).filter((k) => k === "wdcfg"), [], "unchanged watchdog sends nothing");
let L2 = tcfgLegacyCmds({ ...base, ci: 720, do: base.do + "g", gto: 200 }, { wdcfg: { int_min: 360, hb: true } });
assert.deepEqual(L2.cmds.map((c) => c.kind).sort(), ["gpscfg", "wdcfg"]);
assert(L2.cmds.find((c) => c.kind === "wdcfg").cmd.startsWith("WDCFG int=720"));
assert(/^GPSCFG auto=1 to=200/.test(L2.cmds.find((c) => c.kind === "gpscfg").cmd));
// ---- pure: applied parsers and the 1.8 echo
assert.deepEqual(parseTcfgApplied("TCFG applied 7: ci=60 do=hcm cs=24 qc=15 q=b usol=0 gto=90"), { ci: 60, do: "hcm", cs: 24, qc: 15, q: "b", usol: 0, gto: 90 });
assert.deepEqual(parseTcfgApplied("TCFG applied 3 (REJECTED qc=5): ci=0 do=- cs=0 qc=0 q=- usol=2000 gto=180").do, "");
assert.equal(parseLegacyApplied("GPSCFG applied: auto=1 to=120").v.timeout_s, 120);
assert.equal(parseLegacyApplied("CFGSNAP applied: en=1 int=24h").kind, "cache");
assert.equal(tcfgEcho({ ci: 60, do: "ch", q: "ub" }).do, "hc"); assert.equal(tcfgEcho({}), null);
// ---- pure: device state (newest wins, same-wake grace, never shows saved as device)
const T0 = Date.parse("2026-11-18T12:00:00Z"), iso = (s) => new Date(T0 + s * 1000).toISOString();
let ds = deviceState("gps", { cmds: [], saved: { auto: true, timeout_s: 180 } });
assert.equal(ds.device, null); assert.equal(ds.waiting, true);
ds = deviceState("gps", { cmds: [{ cmd: "GPSCFG auto=1 to=180", status: "done", output: "GPSCFG applied: auto=1 to=180", done_at: iso(0) }], saved: { auto: true, timeout_s: 180 } });
assert.equal(ds.device.auto, true); assert.equal(ds.differs, false); assert.equal(ds.waiting, false); assert.equal(ds.device.source, "applied");
ds = deviceState("gps", { cmds: [{ cmd: "GPSCFG auto=0 to=90", status: "queued" }, { cmd: "GPSCFG auto=1 to=180", status: "done", output: "GPSCFG applied: auto=1 to=180", done_at: iso(0) }], saved: { auto: false, timeout_s: 90 } });
assert.equal(ds.device.auto, true, "device value stays what the T-SIM confirmed"); assert.equal(ds.pending, true); assert.equal(ds.differs, true);
const pwrDone = { cmd: "PWRCFG scale=1 off=0 en=1 lo=3.40 hi=3.60 int=60 imm=0", status: "done", output: "PWRCFG applied: scale=1 off=0 en=1 lo=3.40 hi=3.60 int=60 imm=0", done_at: iso(0) };
ds = deviceState("power", { cmds: [pwrDone], latest: { lb_en: false, lb_lo: 3.3, lb_hi: 3.5, lb_int: 120, pwr_at: iso(9), received_at: iso(9) } });
assert.equal(ds.device.lb_en, true, "stale report built before the change (same wake) loses to the applied line");
ds = deviceState("power", { cmds: [pwrDone], latest: { lb_en: false, lb_lo: 3.3, lb_hi: 3.5, lb_int: 120, pwr_at: iso(3600), received_at: iso(3600) } });
assert.equal(ds.device.lb_en, false, "a later report wins"); assert.equal(ds.device.source, "telemetry");
ds = deviceState("checkins", { latest: { tcfg: { ci: 120, do: "hc", cs: 0, qc: 30, q: "u", usol: 2000, gto: 180, at: iso(0) } }, saved: { ci: 360, do: "hc", cs: 0, qc: 30, q: "u", usol: 2000, gto: 180 } });
assert.equal(ds.device.ci, 120); assert.equal(ds.differs, true);
ds = deviceState("watchdog", { wd: { int_min: 1440, hb: true, sms: false, at: iso(0) }, saved: { int_min: 0, hb: true, sms: false } });
assert.equal(ds.differs, false, "1.7.x stores Off as every 24 h: not a difference");
// ---- pure: cost
let c = costEstimate({ ci: 360, do: "hc", qc: 30, q: "u" }); assert.equal(c.lte_wakes_day, 4); assert.equal(c.quick_wakes_day, 48); assert.equal(c.lte_secs_day, 80);
c = costEstimate({ ci: 0, do: "hc", qc: 0, q: "" }); assert.equal(c.lte_wakes_day, 0); assert.equal(c.quick_wakes_day, 0);
assert(costEstimate({ ci: 60, do: "hcg", gto: 180 }).lte_secs_day > costEstimate({ ci: 60, do: "hc" }).lte_secs_day);
// ---- pure: queue helpers
assert.equal(cmdKind("WDCFG int=60"), "wdcfg"); assert.equal(cmdKind("set name x"), "set:name"); assert.equal(cmdKind("ver"), null);
let Q = [{ id: "a", cmd: "ver", status: "queued" }, { id: "b", cmd: "TCFG ci=60 do=hc cs=0 qc=30 q=u usol=2000 gto=180", status: "queued" }];
assert.ok(queueGuard(Q, "ver").refuse);
assert.deepEqual(queueGuard(Q, "TCFG ci=120 do=hc cs=0 qc=30 q=u usol=2000 gto=180"), { superseded: 1 }); assert.equal(Q[1].status, "cancelled");
assert.deepEqual(queueGuard(Q, "neighbors"), { superseded: 0 });
assert(queueFullMsg(12).includes("12 waiting"));
Q = [{ id: "x", cmd: "ver", status: "queued", queued_at: new Date(Date.now() - 8 * 864e5).toISOString() }, { id: "y", cmd: "ver", status: "queued", queued_at: new Date().toISOString() }];
assert.equal(expireQueued(Q), 1); assert.equal(Q[0].status, "cancelled"); assert.equal(Q[1].status, "queued");
Q = [{ id: "1", cmd: "WDCFG int=60", status: "queued" }, { id: "2", cmd: "ver", status: "queued" }, { id: "2", cmd: "ver", status: "queued" }, { id: "3", cmd: "WDCFG int=120", status: "queued" }];
assert.deepEqual(serveDedupe(Q).map((x) => x.id), ["2", "3"]); assert.equal(Q[0].status, "cancelled");
assert.deepEqual(fwDupResult("duplicate id skipped"), { status: "done", note: "already ran" });
assert.equal(fwDupResult("superseded by a newer WDCFG in the same batch").status, "cancelled"); assert.equal(fwDupResult("no reply"), null);
// ---- pure: wake suppression window
const now = Date.now();
assert.equal(wakeSuppressed(new Date(now - 5 * 60e3).toISOString(), null, now).mins, 5);
assert.equal(wakeSuppressed(new Date(now - 5 * 60e3).toISOString(), new Date(now - 60e3).toISOString(), now), null, "answered");
assert.equal(wakeSuppressed(new Date(now - 20 * 60e3).toISOString(), null, now), null, "outside the window");
// ---- pure: the red "couldn't be downloaded" line clears after a later success
const sentH = { last_update_sent: { at: iso(0), asset_name: "x.bin", tag: "v1" } };
let pg = computeProgress("heltec", [{ type: "update", msg: "FAIL: download", received_at: iso(10) }], sentH, T0 + 200e3);
assert.equal(pg.state, "failed"); assert(pg.reason);
pg = computeProgress("heltec", [{ type: "update", msg: "SUCCESS", received_at: iso(100) }, { type: "update", msg: "FAIL: download", received_at: iso(10) }], sentH, T0 + 200e3);
assert.equal(pg.state, "done"); assert.equal(pg.reason, null, "a later success clears the red failure line");
pg = computeProgress("heltec", [{ type: "update", msg: "UPDATE start", received_at: iso(100) }, { type: "update", msg: "FAIL: download", received_at: iso(10) }], sentH, T0 + 200e3);
assert.equal(pg.state, "running"); assert.equal(pg.reason, null, "a new attempt after a failure clears it");
pg = computeProgress("tsim", [{ type: "update", msg: "TSIM OTA OK", received_at: iso(100) }, { type: "update", msg: "TSIM OTA FAIL: download", received_at: iso(10) }], { tsim_update_sent: { at: iso(0) } }, T0 + 200e3);
assert.equal(pg.reason, null);
console.log("v1.8.0 unit tests OK");

// ---- integration: a 1.7.11 device, then the same device after it reports 1.8.0
{
  let r = await admin("/admin/devices", "POST", { id: "uc-1", name: "UC", hologram_device_id: "1234567", heltec_fw: "base" });
  assert.equal(r.status, 201); const dv = await r.json();
  const ingest = (o) => call("/ingest/uc-1", { method: "POST", headers: { "X-Device-Key": dv.ingest_key, "Content-Type": "application/json" }, body: JSON.stringify(o) });
  const fetchCmds = async () => (await (await call("/api/dev/uc-1/commands", { headers: { "X-Device-Key": dv.ingest_key } })).text()).trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
  r = await call("/login", { method: "POST", headers: { "CF-Connecting-IP": "9.9.9.9", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ device: "uc-1", password: dv.password }) });
  const ck = r.headers.get("Set-Cookie").split(";")[0];
  const P = (a, body, h = {}) => call("/api/d/uc-1/" + a, { method: "POST", headers: { Cookie: ck, "Content-Type": "application/json", ...h }, body: JSON.stringify(body) });
  const TEL = async () => (await call("/api/d/uc-1/telemetry", { headers: { Cookie: ck } })).json();
  const unthrottle = () => { for (const k of ["state:uc-1", "sent:uc-1"]) { const s = J(k); if (s) { delete s.last_send_ts; delete s.last_sched_ts; kv.set(k, JSON.stringify(s)); } } };
  assert.equal((await ingest({ type: "status", fw: "1.7.11", battery_v: 3.9, csq: 18 })).status, 200);
  // migration: an existing watchdog record with interval 0 shows as Off
  kv.set("wdcfg:uc-1", JSON.stringify({ int_min: 0, hb: true, sms: false }));
  let tl = await TEL();
  assert.equal(tl.checkins.settings.ci, 0, "wdcfg int_min 0 -> Off"); assert.equal(tl.checkins.v18, false); assert.equal(tl.checkins.supported, true);
  assert(tl.device_state && tl.device_state.checkins && tl.device_state.power && tl.device_state.watchdog && tl.device_state.gps && tl.device_state.cache);
  assert.equal(tl.device_state.gps.device, null, "nothing confirmed yet is never shown as the device's value");
  // 1.7.x: one save -> the changed legacy lines, all queued for one wake, one text
  unthrottle(); let h0 = holo;
  r = await P("checkin-settings", { ci: 360, do: "hct", qc: 30, q: "bu", gto: 200, send: true }); let j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  const kinds = j.queued.map((q) => q.cmd.split(" ")[0]).sort();
  assert(kinds.includes("WDCFG") && kinds.includes("GPSCFG") && kinds.includes("PWRCFG") && !kinds.includes("TCFG"), kinds.join(","));
  assert.equal(holo, h0 + 1, "one text for the whole batch"); assert.equal(holoLast, "STATUS");
  // 1.8-only options are refused on 1.7.x
  assert.equal((await P("checkin-settings", { do: "hcgm" })).status, 409);
  // the same save again: identical config kinds are replaced, never piled up
  const ageSend = (ms) => { for (const k of ["state:uc-1", "sent:uc-1"]) { const s = J(k) || {}; s.last_send_ts = Date.now() - ms; kv.set(k, JSON.stringify(s)); } const L = J("telem:uc-1:latest"); L.received_at = new Date(Date.now() - ms - 60e3).toISOString(); kv.set("telem:uc-1:latest", JSON.stringify(L)); };
  ageSend(2 * 60e3); h0 = holo;
  r = await P("checkin-settings", { ci: 720, send: true }); j = await r.json(); assert.equal(r.status, 200);
  let list = J("cmds:uc-1"); assert.equal(list.filter((c) => c.status === "queued" && c.cmd.startsWith("WDCFG")).length, 1, "newer WDCFG supersedes the older one");
  assert(list.some((c) => c.status === "cancelled" && c.cmd.startsWith("WDCFG") && /replaced/.test(c.error)));
  // wake suppression: a text sent and not answered -> no second text, queued instead; force sends anyway
  assert.equal(j.wake.suppressed, true, JSON.stringify(j.wake)); assert.equal(holo, h0, "no second text while one is unanswered");
  ageSend(2 * 60e3); h0 = holo;
  r = await P("status", {}); j = await r.json(); assert.equal(r.status, 202); assert.equal(j.suppressed, true); assert.equal(holo, h0);
  ageSend(2 * 60e3);
  r = await P("status", {}, { "X-Force-Text": "1" }); j = await r.json(); assert.equal(holo, h0 + 1, "forced text goes out: " + JSON.stringify(j));
  // telemetry queue view and per-item remove
  tl = await TEL(); assert(tl.queue.length >= 3); assert(tl.queue.every((q) => q.status === "queued" || q.status === "sent"));
  const rm = tl.queue.find((q) => q.cmd.startsWith("GPSCFG"));
  r = await P("cmd-remove", { cmd_id: rm.id }); assert.equal(r.status, 200);
  assert.equal(J("cmds:uc-1").find((c) => c.id === rm.id).status, "cancelled");
  assert.equal((await P("cmd-remove", { cmd_id: rm.id })).status, 409, "only queued items can be removed");
  // device fetch: legacy lines only (no TCFG for 1.7.x), each kind once
  let got = await fetchCmds();
  assert(got.length >= 2 && !got.some(([, c]) => c.startsWith("TCFG"))); const kk = got.map(([, c]) => c.split(" ")[0]); assert.equal(new Set(kk).size, kk.length);
  // T-SIM confirms: applied lines become the device's value
  for (const [id, c] of got) {
    const out = c.startsWith("WDCFG") ? "WDCFG applied: int=720 hb=1 sms=0 cmd=1" : c.startsWith("PWRCFG") ? "PWRCFG applied: scale=1 off=0 en=1 lo=3.40 hi=3.60 int=30 imm=0" : "OK";
    assert.equal((await ingest({ type: "cmd", cmd_id: id, cmd: c, output: out, sys: true })).status, 200);
  }
  tl = await TEL(); assert.equal(tl.device_state.power.device.lb_en, true); assert.equal(tl.device_state.power.device.source, "applied");
  assert.equal(tl.device_state.watchdog.device.int_min, 720);
  // firmware dup / superseded replies
  list = J("cmds:uc-1"); list.unshift({ id: "dd01", cmd: "ver", status: "sent", queued_at: new Date().toISOString(), sent_at: new Date().toISOString() },
    { id: "dd02", cmd: "WDCFG int=60 hb=1 sms=0", sys: true, status: "sent", queued_at: new Date().toISOString(), sent_at: new Date().toISOString() }); kv.set("cmds:uc-1", JSON.stringify(list));
  await ingest({ type: "cmd", cmd_id: "dd01", cmd: "ver", output: "", error: "duplicate id skipped" });
  await ingest({ type: "cmd", cmd_id: "dd02", cmd: "WDCFG int=60 hb=1 sms=0", output: "", error: "superseded by a newer WDCFG in the same batch", sys: true });
  list = J("cmds:uc-1"); assert.equal(list.find((c) => c.id === "dd01").status, "done"); assert.equal(list.find((c) => c.id === "dd02").status, "cancelled");
  // idempotency: a replayed key returns the first answer without doing it twice; cap
  kv.set("settings:uc-1", JSON.stringify({ ...(J("settings:uc-1") || {}), console_enabled: true }));
  unthrottle(); const nBefore = J("cmds:uc-1").length;
  r = await P("commands", { cmd: "neighbors" }, { "Idempotency-Key": "idemkey-0001" }); assert.equal(r.status, 200);
  r = await P("commands", { cmd: "neighbors" }, { "Idempotency-Key": "idemkey-0001" }); assert.equal(r.status, 200); assert.equal(r.headers.get("Idempotent-Replay"), "1");
  assert.equal(J("cmds:uc-1").length, nBefore + 1, "replay did not queue a second copy");
  r = await P("commands", { cmd: "neighbors" }); assert.equal(r.status, 409, "identical command already waiting");
  kv.set("lock:uc-1:commands", JSON.stringify({ at: Date.now() }));
  r = await P("commands", { cmd: "clock" }, { "Idempotency-Key": "idemkey-0002" }); assert.equal(r.status, 429, "double submit lock");
  kv.delete("lock:uc-1:commands");
  let capHit = null;
  for (let i = 0; i < 60 && !capHit; i++) { const r2 = await P("commands", { cmd: "get name" + i }); if (r2.status !== 200) capHit = r2; }
  assert(capHit, "queue cap reached"); { const cj = await capHit.json(); assert(/queue is full/.test(cj.error), capHit.status + " " + JSON.stringify(cj)); }
  // expiry: an old queued item is cancelled at the next fetch
  list = J("cmds:uc-1"); for (const c of list) if (c.status === "queued") c.queued_at = new Date(Date.now() - 8 * 864e5).toISOString(); kv.set("cmds:uc-1", JSON.stringify(list));
  got = await fetchCmds(); assert.equal(got.length, 0, "expired items are not sent");
  assert(J("cmds:uc-1").some((c) => /expired/.test(c.error || "")));
  // repeater settings: "apply at next check-in" queues without a text
  unthrottle(); h0 = holo;
  r = await P("rpt-save", { changes: { name: "Hill" }, later: true }); j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(j.later, true); assert.equal(holo, h0);
  r = await P("rpt-save", { changes: { name: "Hill 2" }, later: true }); assert.equal(r.status, 200);
  assert.equal(J("cmds:uc-1").filter((c) => c.status === "queued" && /^set name /.test(c.cmd)).length, 1, "newer set name supersedes");
  // the page: new cards and labels, scripts parse
  const page = await (await call("/d/uc-1", { headers: { Cookie: ck } })).text();
  for (const s of ["Automatic check-ins", "Quick local checks", "needs T-SIM 1.8", "Apply at next check-in (no text)", 'id="qtray"', 'id="cids"', 'id="lbds"', "Battery: low-battery protection"])
    assert(page.includes(s), "page has " + s);
  for (const s of ["Waiting for T-SIM to confirm", "Saved here, not confirmed yet", "On T-SIM", "Apply changes ("]) assert(page.includes(s), "page script has " + s);
  for (const mm of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(mm[1]);

  // ---- upgrade: the T-SIM reports 1.8.0 with its full TCFG echo
  const cancelAll = () => { const l = J("cmds:uc-1"); for (const c of l) if (c.status === "queued") c.status = "cancelled"; kv.set("cmds:uc-1", JSON.stringify(l)); };
  cancelAll();
  await ingest({ type: "status", fw: TCFG_FW, battery_v: 3.9, tcfg: { v: 1, ci: 720, do: "hc", cs: 0, qc: 30, q: "bu", usol: 2000, gto: 180, safety: 1440 } });
  tl = await TEL(); assert.equal(tl.checkins.v18, true); assert.equal(tl.device_state.checkins.device.ci, 720); assert.equal(tl.device_state.checkins.device.source, "telemetry");
  unthrottle(); h0 = holo;
  r = await P("checkin-settings", { ci: 120, do: "hcmsg", cs: 24, send: false }); j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.queued.length, 1); assert.equal(j.queued[0].cmd, "TCFG ci=120 do=hcmsg cs=24 qc=30 q=bu usol=2000 gto=200"); assert.equal(holo, h0, "send:false -> no text");
  tl = await TEL(); assert.equal(tl.device_state.checkins.device.ci, 720, "still shows what the T-SIM confirmed"); assert.equal(tl.device_state.checkins.pending, true);
  got = await fetchCmds(); assert.equal(got.length, 1); assert(got[0][1].startsWith("TCFG "));
  await ingest({ type: "cmd", cmd_id: got[0][0], cmd: got[0][1], output: "TCFG applied 1: ci=120 do=hcmsg cs=24 qc=30 q=bu usol=2000 gto=200", sys: true });
  tl = await TEL(); assert.equal(tl.device_state.checkins.device.ci, 120); assert.equal(tl.device_state.checkins.differs, false); assert(J("tcfg:uc-1").applied_at);
  // TCFG is never served to 1.7.x
  await ingest({ type: "status", fw: "1.7.11", battery_v: 3.9 });
  list = J("cmds:uc-1"); list.unshift({ id: "tc77", cmd: "TCFG ci=60 do=hc cs=0 qc=30 q=u usol=2000 gto=180", sys: true, status: "queued", queued_at: new Date().toISOString() }); kv.set("cmds:uc-1", JSON.stringify(list));
  got = await fetchCmds(); assert(!got.some(([, c]) => c.startsWith("TCFG")), "TCFG held back for 1.7.x");
  cancelAll();
  // auto-sync: a 1.8 echo that differs from the explicitly saved settings queues them once
  const tc = J("tcfg:uc-1"); tc.sync_at = null; kv.set("tcfg:uc-1", JSON.stringify(tc));
  await ingest({ type: "status", fw: TCFG_FW, battery_v: 3.9, tcfg: { v: 1, ci: 360, do: "hc", cs: 0, qc: 30, q: "bu", usol: 2000, gto: 180, safety: 1440 } });
  let ql = J("cmds:uc-1").filter((c) => c.status === "queued" && c.cmd.startsWith("TCFG"));
  assert.equal(ql.length, 1); assert.equal(ql[0].cmd, "TCFG ci=120 do=hcmsg cs=24 qc=30 q=bu usol=2000 gto=200");
  await ingest({ type: "status", fw: TCFG_FW, battery_v: 3.9, tcfg: { v: 1, ci: 360, do: "hc", cs: 0, qc: 30, q: "bu", usol: 2000, gto: 180, safety: 1440 } });
  assert.equal(J("cmds:uc-1").filter((c) => c.status === "queued" && c.cmd.startsWith("TCFG")).length, 1, "not queued twice");
}
console.log("v1.8.0 integration tests OK");
