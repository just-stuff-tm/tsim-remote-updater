// Local test harness: mocks KV and fetch (GitHub, Hologram). Run: node test/harness.mjs
import worker, { computeProgress, friendlyFail, heltecImageRisk, fwAtLeast, normChecksum, buildTsimCommand, hashPassword, verifyPassword, buildUpdateBody, parseMesh, runSchedules, updateStatus, refreshReleases } from "../src/index.js";
import assert from "node:assert";

const kv = new Map();
const STATE = {
  get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
};
const env = { STATE, HOLOGRAM_API_KEY: "k", ADMIN_TOKEN: "admintok", SESSION_SECRET: "sess-secret-for-tests" };
let holo = 0, holoOk = true;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("api.github.com") && url.includes("tsim-remote-updater")) return new Response(JSON.stringify({ tag_name: "v1.6.0", assets: [
    { id: 9, name: "firmware.bin", digest: "sha256:" + "ab".repeat(32), browser_download_url: "https://github.com/just-stuff-tm/tsim-remote-updater/releases/download/v1.6.0/firmware.bin" }] }));
  if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "PowerSaving17.2", assets: [
    { id: 5, name: "Heltec_v3_repeater-PowerSaving17.2.0-upgrade.bin", browser_download_url: "https://github.com/x/y/releases/download/t/Heltec_v3_repeater-PowerSaving17.2.0-upgrade.bin" }] }));
  if (url.includes("hologram")) { holo++; assert.equal(JSON.parse(init.body).deviceid, 1234567);
    return new Response(JSON.stringify({ success: holoOk }), { status: holoOk ? 200 : 400 }); }
  throw new Error("unexpected fetch " + url);
};
const B = "https://w";
const call = (path, init = {}) => worker.fetch(new Request(B + path, init), env);
const admin = (path, method = "GET", body) => call(path, { method, headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" }, body: body && JSON.stringify(body) });

// password hashing
const h = await hashPassword("correct horse");
assert(await verifyPassword("correct horse", h)); assert(!(await verifyPassword("nope", h)));
assert.equal(buildUpdateBody("https://a/b_c"), "UPDATE https://a/b%5Fc ");

// admin
assert.equal((await call("/admin/devices")).status, 401);
assert.equal((await call("/admin/devices", { headers: { Authorization: "Bearer wrong" } })).status, 401);
let r = await admin("/admin/devices", "POST", { id: "tsim-1", name: "Test", hologram_device_id: "1234567", heltec_fw: "base" });
assert.equal(r.status, 201); const created = await r.json(); assert(created.password && created.ingest_key);
assert.equal((await admin("/admin/devices", "POST", { id: "tsim-1", hologram_device_id: "1" })).status, 409);
assert.equal((await admin("/admin/devices", "POST", { id: "Bad Id", hologram_device_id: "1" })).status, 400);
const list = await (await admin("/admin/devices")).json();
assert.equal(list.devices.length, 1); assert(!JSON.stringify(list).includes("ingest_key") && !JSON.stringify(list).includes("password"));

// login
const login = (dev, pw, ip = "1.1.1.1") => call("/login", { method: "POST", headers: { "CF-Connecting-IP": ip, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ device: dev, password: pw }) });
assert.equal((await call("/")).status, 200);
assert.equal((await login("tsim-1", "wrong-password")).status, 401);
r = await login("tsim-1", created.password); assert.equal(r.status, 303);
const sc = r.headers.get("Set-Cookie"); assert(/HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Strict/.test(sc) && /Max-Age=604800/.test(sc));
const cookie = sc.split(";")[0];
const auth = (path, init = {}) => call(path, { ...init, headers: { ...(init.headers || {}), Cookie: cookie } });
assert.equal((await auth("/d/tsim-1")).status, 200);
assert((await (await auth("/d/tsim-1")).text()).includes("Update radio firmware") && (await (await auth("/d/tsim-1")).text()).includes(">LoRa radio<") && !(await (await auth("/d/tsim-1")).text()).includes('id="out"'));
assert.equal((await call("/d/tsim-1")).status, 303);
assert.equal((await call("/api/d/tsim-1/telemetry")).status, 401);
// forged / other-device cookie
assert.equal((await call("/api/d/tsim-1/telemetry", { headers: { Cookie: cookie.slice(0, -3) + "AAA" } })).status, 401);
await admin("/admin/devices", "POST", { id: "tsim-2", hologram_device_id: "1" });
assert.equal((await auth("/api/d/tsim-2/telemetry")).status, 401);

// login rate limit
for (let i = 0; i < 5; i++) await login("tsim-2", "bad-bad-bad", "9.9.9.9");
const t2 = await (await admin("/admin/devices/tsim-2/reset-password", "POST", {})).json();
assert.equal((await login("tsim-2", t2.password, "9.9.9.9")).status, 429);
assert.equal((await login("tsim-2", t2.password, "8.8.8.8")).status, 303);

// ingest
assert.equal((await call("/ingest/tsim-1", { method: "POST", body: "{}" })).status, 401);
assert.equal((await call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": "nope" }, body: "{}" })).status, 401);
const ing = (o) => call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": created.ingest_key, "Content-Type": "application/json" }, body: JSON.stringify(o) });
assert.equal((await ing({ type: "status", fw: "1.4.1", battery_v: 4.01, battery_pct: 83, csq: 20, rsrp: -95, evil: "x" })).status, 200);
assert.equal((await ing({ type: "update", msg: "SUCCESS: https://github.com/x/Heltec%5Fv3%5Frepeater-PowerSaving17.2.0-upgrade.bin" })).status, 200);
for (let i = 0; i < 60; i++) await ing({ type: "event", msg: "e" + i });
let tel = await (await auth("/api/d/tsim-1/telemetry")).json();
assert.equal(tel.latest.fw, "1.4.1"); assert.equal(tel.latest.battery_pct, 83); assert.equal(tel.latest.evil, undefined);
assert.equal(tel.history.length, 50); assert.equal(tel.history[0].msg, "e59");
assert.equal(tel.updates.heltec_fw, "Heltec_v3_repeater-PowerSaving17.2.0-upgrade");

// actions: CSRF, check (no sms), sends + rate limit
assert.equal((await auth("/api/d/tsim-1/reboot", { method: "POST", headers: { Origin: "https://evil" } })).status, 403);
assert.equal((await auth("/api/d/tsim-1/reboot")).status, 405);
let j = await (await auth("/api/d/tsim-1/check", { method: "POST" })).json();
assert.equal(j.sent, false); assert.equal(holo, 0); assert(j.latest_available.asset_name.includes("17.2.0"));
j = await (await auth("/api/d/tsim-1/reboot", { method: "POST" })).json(); assert(j.sent); assert.equal(j.body, "REBOOT"); assert.equal(holo, 1);
r = await auth("/api/d/tsim-1/status", { method: "POST" }); assert.equal(r.status, 429); assert.equal(holo, 1);
const st = JSON.parse(kv.get("state:tsim-1")); st.last_send_ts = 0; kv.set("state:tsim-1", JSON.stringify(st));
j = await (await auth("/api/d/tsim-1/update-latest", { method: "POST" })).json(); assert(j.sent); assert(j.body.includes("%5F") && !j.body.includes("_"));
assert.equal(JSON.parse(kv.get("state:tsim-1")).last_update_sent.tag, "PowerSaving17.2");

// update source settings
{
  const post = (b, h = {}) => auth("/api/d/tsim-1/source", { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) });
  let s = await (await auth("/api/d/tsim-1/source")).json();
  assert.equal(s.repo, "IoTThinks/EasySkyMesh"); assert.equal(s.enabled, true);
  assert.equal((await call("/api/d/tsim-1/source", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await post({ repo: "x" }, { Origin: "https://evil" })).status, 403);
  assert.equal((await post({ repo: "not a repo" })).status, 400);
  assert.equal((await post({ direct_url: "http://insecure/x.bin" })).status, 400);
  // pattern that matches nothing -> check reports no asset, no SMS
  const h0 = holo;
  assert.equal((await post({ asset_pattern: "Nothing-*.bin" })).status, 200);
  let r2 = await auth("/api/d/tsim-1/check", { method: "POST" }); assert.equal(r2.status, 404);
  assert.equal((await post({ asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", repo: "Other/Repo" })).status, 200);
  let j2 = await (await auth("/api/d/tsim-1/check", { method: "POST" })).json(); assert(j2.latest_available.asset_name.includes("17.2.0"));
  // disabled + no direct URL -> check/update refused
  assert.equal((await post({ enabled: false, direct_url: "" })).status, 200);
  assert.equal((await auth("/api/d/tsim-1/check", { method: "POST" })).status, 404);
  { const s0 = JSON.parse(kv.get("state:tsim-1")); delete s0.last_update_sent; kv.set("state:tsim-1", JSON.stringify(s0)); }  // previous update finished
  assert.equal((await auth("/api/d/tsim-1/update-latest", { method: "POST" })).status, 404);
  // disabled + direct URL -> used for check and update
  assert.equal((await post({ direct_url: "https://example.com/fw/My_fw-1.bin" })).status, 200);
  j2 = await (await auth("/api/d/tsim-1/check", { method: "POST" })).json(); assert.equal(j2.latest_available.via, "direct"); assert.equal(holo, h0);
  const st2 = JSON.parse(kv.get("state:tsim-1")); st2.last_send_ts = 0; kv.set("state:tsim-1", JSON.stringify(st2));
  j2 = await (await auth("/api/d/tsim-1/update-latest", { method: "POST" })).json();
  assert(j2.sent); assert.equal(j2.body, "UPDATE https://example.com/fw/My%5Ffw-1.bin "); assert.equal(holo, h0 + 1);
  const tel2 = await (await auth("/api/d/tsim-1/telemetry")).json(); assert.equal(tel2.source.enabled, false);
}

// password reset invalidates session; delete device
await admin("/admin/devices/tsim-1/reset-password", "POST", { password: "another-long-password" });
assert.equal((await auth("/api/d/tsim-1/telemetry")).status, 401);
assert.equal((await admin("/admin/devices/tsim-2", "DELETE")).status, 200);
assert.equal((await call("/logout", { method: "POST" })).headers.get("Set-Cookie").includes("Max-Age=0"), true);
assert.equal(typeof worker.scheduled, "function");

// ---------- mesh dashboard ----------
{
  await admin("/admin/devices/tsim-1/reset-password", "POST", { password: "device-one-password" });
  await admin("/admin/devices", "POST", { id: "rpt-b", name: "Hilltop", hologram_device_id: "1234567" });
  // mesh parsing (MeshCore serial CLI formats)
  const pm = parseMesh({ ver: "  -> v1.9.0 (Build: 1 Oct 2026)", name: "  -> > Hilltop", stats_core: '  -> {"battery_mv":4012,"uptime_secs":3600,"errors":0,"queue_len":1}',
    stats_packets: '  -> {"recv":10,"sent":4,"flood_tx":1,"direct_tx":3,"flood_rx":8,"direct_rx":2,"recv_errors":0}', neighbors: "  -> A1B2C3D4:60:22\nDEADBEEF:300:-8" }, 1e12);
  assert.equal(pm.heltec_fw, "v1.9.0 (Build: 1 Oct 2026)"); assert.equal(pm.node_name, "Hilltop"); assert.equal(pm.core.battery_mv, 4012);
  assert.equal(pm.neighbors.length, 2); assert.equal(pm.neighbors[0].snr, 5.5); assert.equal(pm.neighbors[1].snr, -2); assert.equal(pm.packets.recv, 10);
  assert.equal(parseMesh({ neighbors: "  -> -none-" }).neighbors.length, 0);

  // fleet account
  assert.equal((await admin("/admin/accounts", "POST", { id: "owner", devices: ["nope"] })).status, 400);
  assert.equal((await admin("/admin/accounts", "POST", { id: "tsim-1", devices: [] })).status, 409);
  let r = await admin("/admin/accounts", "POST", { id: "owner", name: "Owner", devices: ["tsim-1", "rpt-b"] });
  assert.equal(r.status, 201); const acct = await r.json();
  assert(!JSON.stringify(await (await admin("/admin/accounts")).json()).includes("password_hash"));
  r = await login("owner", acct.password, "5.5.5.5"); assert.equal(r.status, 303); assert.equal(r.headers.get("Location"), "/fleet");
  const ac = r.headers.get("Set-Cookie").split(";")[0];
  const A = (path, init = {}) => call(path, { ...init, headers: { ...(init.headers || {}), Cookie: ac } });
  assert.equal((await A("/")).headers.get("Location"), "/fleet");
  assert((await (await A("/fleet")).text()).includes("Repeaters"));
  assert.equal((await call("/api/fleet")).status, 401);
  // device ingest of mesh snapshot (rpt-b)
  const keyB = (JSON.parse(kv.get("device:rpt-b"))).ingest_key;
  const ingB = (o) => call("/ingest/rpt-b", { method: "POST", headers: { "X-Device-Key": keyB }, body: JSON.stringify(o) });
  assert.equal((await ingB({ type: "status", fw: "1.5.0", battery_v: 3.9, battery_pct: 70, csq: 18 })).status, 200);
  assert.equal((await ingB({ type: "mesh", ver: "  -> v1.9.0", neighbors: "  -> A1B2C3D4:60:22", stats_packets: '  -> {"recv":10,"sent":4}' })).status, 200);
  let f = await (await A("/api/fleet")).json();
  assert.equal(f.devices.length, 2); const b = f.devices.find((d) => d.id === "rpt-b");
  assert.equal(b.neighbors, 1); assert.equal(b.heltec_fw, "v1.9.0"); assert.equal(b.packets.recv, 10); assert.equal(b.battery_pct, 70);
  assert.equal((await A("/d/rpt-b")).status, 200); assert((await (await A("/d/rpt-b")).text()).includes("All"));
  assert.equal((await A("/api/d/rpt-b/telemetry")).status, 200);
  // device session can't see fleet devices it doesn't own
  r = await login("tsim-1", "device-one-password", "6.6.6.6"); const dc = r.headers.get("Set-Cookie").split(";")[0];
  assert.equal((await call("/api/d/rpt-b/telemetry", { headers: { Cookie: dc } })).status, 401);
  assert.equal((await (await call("/api/fleet", { headers: { Cookie: dc } })).json()).devices.length, 1);

  // console: off by default
  const P = (a, body, h = {}) => A("/api/d/rpt-b/" + a, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body) });
  assert.equal((await P("commands", { cmd: "ver" })).status, 403);
  assert.equal((await call("/api/dev/rpt-b/commands", { headers: { "X-Device-Key": keyB } })).status, 200);
  assert.equal((await P("settings", { console_enabled: true }, { Origin: "https://evil" })).status, 403);
  assert.equal((await P("settings", { console_enabled: true })).status, 200);
  assert.equal((await P("commands", { cmd: "bad\nline" })).status, 400);
  assert.equal((await P("commands", { cmd: "erase" })).status, 409);
  assert.equal((await P("commands", { cmd: "neighbors" })).status, 200);
  const h0 = holo;
  JSON.parse(kv.get("state:rpt-b") || "{}");
  let q = await (await P("commands", { cmd: "ver", wake: true })).json(); assert.equal(q.wake.sent, true); assert.equal(holo, h0 + 1);
  // device fetch: unauthorized then ok
  assert.equal((await call("/api/dev/rpt-b/commands", { headers: { "X-Device-Key": "x" } })).status, 401);
  let txt = await (await call("/api/dev/rpt-b/commands", { headers: { "X-Device-Key": keyB } })).text();
  const lines = txt.trim().split("\n"); assert.equal(lines.length, 2); assert(lines[0].endsWith("\tneighbors"));
  assert.equal((await (await call("/api/dev/rpt-b/commands", { headers: { "X-Device-Key": keyB } })).text()), "");
  const cid = lines[1].split("\t")[0];
  assert.equal((await ingB({ type: "cmd", cmd_id: cid, cmd: "ver", output: "  -> v1.9.0" })).status, 200);
  let tel = await (await A("/api/d/rpt-b/telemetry")).json();
  assert.equal(tel.commands.find((c) => c.id === cid).status, "done"); assert.equal(tel.mesh.neighbors.length, 1);
  // powersaving: console command turns it on -> console refused, mesh poll asleep keeps last snapshot
  await P("commands", { cmd: "powersaving on" });
  const pl = (await (await call("/api/dev/rpt-b/commands", { headers: { "X-Device-Key": keyB } })).text()).trim().split("\t")[0];
  await ingB({ type: "cmd", cmd_id: pl, cmd: "powersaving on", output: "  -> on" });
  tel = await (await A("/api/d/rpt-b/telemetry")).json(); assert.equal(tel.powersaving.on, true);
  let pr = await P("commands", { cmd: "ver" }); assert.equal(pr.status, 409); assert((await pr.json()).error.includes("power saving"));
  assert.equal((await P("wake-cmd", {})).status, 409);
  assert((await (await A("/d/rpt-b")).text()).includes("console is unavailable while the repeater is in power saving"));
  await ingB({ type: "mesh", ver: "", error: "no reply from Heltec CLI" });  // v1.5.x firmware format
  tel = await (await A("/api/d/rpt-b/telemetry")).json(); assert.equal(tel.mesh.neighbors.length, 1); assert(tel.mesh.cli_asleep_at);
  assert.equal((await (await A("/api/fleet")).json()).devices.find((d) => d.id === "rpt-b").powersaving, true);
  // CLI answers again -> powersaving off
  await ingB({ type: "mesh", ver: "  -> v1.9.0", neighbors: "  -> -none-" });
  tel = await (await A("/api/d/rpt-b/telemetry")).json(); assert.equal(tel.powersaving.on, false); assert.equal(tel.mesh.neighbors.length, 0);
  assert.equal((await P("commands", { cmd: "neighbors" })).status, 200);
  // console 'no reply' disables; stock firmware without powersaving cmd ("Unknown command") keeps it enabled
  const nl = (await (await call("/api/dev/rpt-b/commands", { headers: { "X-Device-Key": keyB } })).text()).trim().split("\t")[0];
  await ingB({ type: "cmd", cmd_id: nl, cmd: "neighbors", output: "", error: "no reply from Heltec" });
  assert.equal((await (await A("/api/d/rpt-b/telemetry")).json()).powersaving.on, true);
  await ingB({ type: "mesh", ver: "  -> v1.9.0" });
  await P("commands", { cmd: "powersaving on" });
  const ul = (await (await call("/api/dev/rpt-b/commands", { headers: { "X-Device-Key": keyB } })).text()).trim().split("\t")[0];
  await ingB({ type: "cmd", cmd_id: ul, cmd: "powersaving on", output: "  -> Unknown command" });
  assert.equal((await (await A("/api/d/rpt-b/telemetry")).json()).powersaving.on, false);
  // console off cancels queued
  await P("commands", { cmd: "clock" }); await P("settings", { console_enabled: false });
  tel = await (await A("/api/d/rpt-b/telemetry")).json(); assert.equal(tel.commands[0].status, "cancelled");

  // schedule: off by default; cron only texts due devices
  const hs = holo; assert.deepEqual(await runSchedules(env), []); assert.equal(holo, hs);
  assert.equal((await P("settings", { schedule_hours: 5 })).status, 400);
  assert.equal((await P("settings", { schedule_hours: 6 })).status, 200);
  assert.deepEqual(await runSchedules(env), []); // first run is one interval after enabling
  const st = JSON.parse(kv.get("state:rpt-b")); st.last_send_ts = 0; kv.set("state:rpt-b", JSON.stringify(st));
  let res = await runSchedules(env, Date.now() + 6 * 3600e3);
  assert.equal(res.length, 1); assert.equal(res[0].id, "rpt-b"); assert.equal(res[0].sent, true); assert.equal(holo, hs + 1);
  assert.equal((await runSchedules(env, Date.now() + 7 * 3600e3)).length, 0);
  // account password reset kills sessions
  await admin("/admin/accounts/owner/reset-password", "POST", {});
  assert.equal((await A("/api/fleet")).status, 401);
  assert.equal((await admin("/admin/accounts/owner", "DELETE")).status, 200);
}
// ---------- T-SIM OTA ----------
{
  assert.equal(normChecksum("AB".repeat(32)), "sha256:" + "ab".repeat(32)); assert.equal(normChecksum("md5:" + "0".repeat(32)), "md5:" + "0".repeat(32));
  assert.throws(() => normChecksum("xyz")); assert.equal(buildTsimCommand("https://a/b", ""), "TSIMUPDATE https://a/b");
  await admin("/admin/devices", "POST", { id: "ota-1", hologram_device_id: "1234567" });
  await admin("/admin/devices/ota-1/reset-password", "POST", { password: "ota-device-password" });
  const r = await login("ota-1", "ota-device-password", "4.4.4.4"); const oc = r.headers.get("Set-Cookie").split(";")[0];
  const O = (a, body, h = {}) => call("/api/d/ota-1/" + a, { method: "POST", headers: { Cookie: oc, "Content-Type": "application/json", ...h }, body: body && JSON.stringify(body) });
  const key = JSON.parse(kv.get("device:ota-1")).ingest_key;
  let tel = await (await call("/api/d/ota-1/telemetry", { headers: { Cookie: oc } })).json();
  assert.equal(tel.tsim.source.repo, "just-stuff-tm/tsim-remote-updater"); assert.equal(tel.tsim.source.asset, "firmware.bin");
  assert.equal((await O("tsim-update", null, { Origin: "https://evil" })).status, 403);
  const h0 = holo;
  let j = await (await O("tsim-check")).json(); assert.equal(j.sent, false); assert.equal(holo, h0);
  assert.equal(j.latest_available.tag, "v1.6.0"); assert.equal(j.latest_available.checksum, "sha256:" + "ab".repeat(32));
  // console is OFF, yet the system command is delivered
  j = await (await O("tsim-update")).json(); assert(j.sent); assert.equal(j.body, "CMD"); assert.equal(holo, h0 + 1);
  { const h1 = holo; const rd = await O("tsim-update"); assert.equal(rd.status, 409); const jd = await rd.json(); assert(jd.duplicate && /already requested/.test(jd.error)); assert.equal(holo, h1, "dedupe sends no text"); }
  const txt = await (await call("/api/dev/ota-1/commands", { headers: { "X-Device-Key": key } })).text();
  assert.equal(txt.split("\t")[1].trim(), "TSIMUPDATE https://github.com/just-stuff-tm/tsim-remote-updater/releases/download/v1.6.0/firmware.bin sha256:" + "ab".repeat(32));
  // OTA progress is tracked; system cmd output does not touch powersaving state
  const ing = (o) => call("/ingest/ota-1", { method: "POST", headers: { "X-Device-Key": key }, body: JSON.stringify(o) });
  await ing({ type: "cmd", cmd_id: txt.split("\t")[0], cmd: "TSIMUPDATE x", output: "T-SIM OTA starting" });
  await ing({ type: "update", msg: "TSIM OTA OK: tsim-updater 1.6.0 running (ingest accepted)", fw: "tsim-updater 1.6.0" });
  tel = await (await call("/api/d/ota-1/telemetry", { headers: { Cookie: oc } })).json();
  assert(tel.tsim.last_ota.msg.startsWith("TSIM OTA OK")); assert.equal(tel.tsim.fw, "tsim-updater 1.6.0"); assert.equal(tel.powersaving.on, false);
  assert.equal(tel.commands[0].status, "done");
  // source: URL mode + checksum validation
  assert.equal((await O("tsim-source", { mode: "url", url: "" })).status, 400);
  assert.equal((await O("tsim-source", { mode: "url", url: "https://example.com/t.bin", checksum: "nothex" })).status, 400);
  assert.equal((await O("tsim-source", { mode: "url", url: "https://example.com/t.bin", checksum: "c".repeat(32) })).status, 200);
  const st = JSON.parse(kv.get("state:ota-1")); st.last_send_ts = 0; kv.set("state:ota-1", JSON.stringify(st));
  j = await (await O("tsim-update")).json(); assert(j.sent);
  const t2 = await (await call("/api/dev/ota-1/commands", { headers: { "X-Device-Key": key } })).text();
  assert(t2.includes("TSIMUPDATE https://example.com/t.bin md5:" + "c".repeat(32)));
  assert.equal((await admin("/admin/devices/ota-1", "DELETE")).status, 200); assert.equal(kv.get("tsimsrc:ota-1"), undefined);
}
// dynamic update buttons: cancel / stall / retry
{
  await admin("/admin/devices", "POST", { id: "dyn-1", hologram_device_id: "1234567" });
  await admin("/admin/devices/dyn-1/reset-password", "POST", { password: "dyn-device-password" });
  const r = await login("dyn-1", "dyn-device-password", "5.5.5.5"); const dc = r.headers.get("Set-Cookie").split(";")[0];
  const D = (a, body) => call("/api/d/dyn-1/" + a, { method: "POST", headers: { Cookie: dc, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const tel = async () => (await call("/api/d/dyn-1/telemetry", { headers: { Cookie: dc } })).json();
  const key = JSON.parse(kv.get("device:dyn-1")).ingest_key;
  const resetGap = () => { const s = JSON.parse(kv.get("state:dyn-1")); s.last_send_ts = 0; kv.set("state:dyn-1", JSON.stringify(s)); };
  let h0 = holo;
  let j = await (await D("tsim-update")).json(); assert(j.sent); assert.equal(holo, h0 + 1);
  assert.equal((await tel()).progress.tsim.state, "running");
  // cancel before pickup: queued cmd cleared, device gets nothing, no SMS
  j = await (await D("update-cancel", { kind: "tsim" })).json(); assert(j.cancelled && j.cleared === 1); assert.equal(holo, h0 + 1);
  assert.equal((await call("/api/dev/dyn-1/commands", { headers: { "X-Device-Key": key } })).text().then ? await (await call("/api/dev/dyn-1/commands", { headers: { "X-Device-Key": key } })).text() : "", "");
  let t = await tel(); assert.equal(t.progress.tsim.state, "cancelled"); assert(/Nothing will be installed/.test(t.progress.tsim.reason));
  assert.equal((await D("update-cancel", { kind: "tsim" })).status, 409);
  // retry re-queues the SAME file with one text
  resetGap(); const url0 = JSON.parse(kv.get("state:dyn-1")).tsim_update_sent.url;
  j = await (await D("tsim-update", { retry: true })).json(); assert(j.sent); assert.equal(holo, h0 + 2);
  const txt = await (await call("/api/dev/dyn-1/commands", { headers: { "X-Device-Key": key } })).text(); assert(txt.includes(url0));
  // device started -> cancel just marks requested
  await call("/ingest/dyn-1", { method: "POST", headers: { "X-Device-Key": key }, body: JSON.stringify({ type: "update", msg: "TSIM OTA start: x" }) });
  j = await (await D("update-cancel", { kind: "tsim" })).json(); assert(j.cancelled && j.cleared === 0 && /may finish/.test(j.note));
  // stall detection: >10 min with no progress
  const st = JSON.parse(kv.get("state:dyn-1")); delete st.tsim_cancel; kv.set("state:dyn-1", JSON.stringify(st));
  const hist = JSON.parse(kv.get("telem:dyn-1:history"));
  const p = computeProgress("tsim", hist, { ...st, last_checkin_ts: 0 }, Date.now() + 11 * 60e3);
  assert.equal(p.state, "timeout"); assert(/cell connection/.test(p.reason));
  // radio: dedupe + cancel (no SMS) + retry same file
  resetGap(); h0 = holo;
  j = await (await D("update-latest")).json(); assert(j.sent); assert.equal(holo, h0 + 1);
  assert.equal((await D("update-latest")).status, 409); assert.equal(holo, h0 + 1);
  j = await (await D("update-cancel", { kind: "heltec" })).json(); assert(j.cancelled && /already delivered/.test(j.note)); assert.equal(holo, h0 + 1);
  resetGap(); j = await (await D("update-latest", { retry: true })).json(); assert(j.sent && j.body.startsWith("UPDATE ")); assert.equal(holo, h0 + 2);
  const page = await (await call("/d/dyn-1", { headers: { Cookie: dc } })).text(); assert(page.includes("setUpd(") && page.includes("update-cancel"));
  console.log("dynamic update button tests ok");
}
console.log("ALL TESTS PASSED");
// origin handling
{
  const r1 = await worker.fetch(new Request("https://w/login", { method: "POST", headers: { Origin: "null", "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "7.7.7.7" }, body: "device=x&password=y" }), env);
  assert.notEqual(r1.status, 403);
  console.log("ORIGIN TESTS PASSED");
}

// update progress
{
  const T = (m) => new Date(Date.parse("2026-10-14T20:00:00Z") + m * 60e3).toISOString();
  const now = Date.parse(T(3));
  const st = { tsim_update_sent: { at: T(0), asset_name: "firmware.bin", tag: "v1.6.1" }, last_update_sent: { at: T(0), asset_name: "x-upgrade.bin" } };
  let p = computeProgress("tsim", [], st, now); assert.equal(p.state, "running"); assert.equal(p.step, 0);
  const H = [{ type: "update", msg: "TSIM OTA: written 1 bytes to app1, rebooting", received_at: T(2) },
    { type: "update", msg: "TSIM OTA: downloaded 1 bytes (checksum OK), writing app1", received_at: T(1.5) },
    { type: "update", msg: "TSIM OTA start: https://x", received_at: T(1) }];
  p = computeProgress("tsim", H, st, now); assert.equal(p.step, 4); assert.equal(p.target, "firmware.bin (v1.6.1)");
  p = computeProgress("tsim", [{ type: "update", msg: "TSIM OTA OK: 1.6.1 running", received_at: T(3) }, ...H], st, now); assert.equal(p.state, "done"); assert.equal(p.pct, 100);
  p = computeProgress("tsim", H, st, now + 20 * 60e3); assert.equal(p.state, "timeout"); assert(/rolled back/.test(p.reason));
  p = computeProgress("heltec", [{ type: "update", msg: "FAIL: download", received_at: T(2) }, { type: "update", msg: "UPDATE start: https://x", received_at: T(1) }], st, now);
  assert.equal(p.state, "failed"); assert(/downloaded/.test(p.reason));
  p = computeProgress("heltec", [{ type: "update", msg: "SUCCESS: https://x", received_at: T(2) }, { type: "update", msg: "Download done: 9 bytes, flashing", received_at: T(1.5) }], st, now);
  assert.equal(p.state, "done");
  assert.equal(computeProgress("heltec", [], {}, now).state, "idle");
  assert(/checksum/.test(friendlyFail("TSIM OTA FAIL: sha256 mismatch")));
  const of = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([0xE9]), { status: 206, headers: { "Content-Range": "bytes 0-0/1171104" } });
  assert(/Blocked for safety/.test(await heltecImageRisk("https://h/Heltec_v3_repeater-v1.17.1-d929643.bin")));
  assert.equal(await heltecImageRisk("https://h/a-merged.bin"), null);
  assert(/Blocked/.test(await heltecImageRisk("https://h/x.bin", "tsim-updater 1.6.1")));
  assert.equal(await heltecImageRisk("https://h/x.bin", "tsim-updater 1.6.2"), null);
  assert.equal(await heltecImageRisk("https://h/x.bin", "tsim-updater 1.10.0"), null);
  assert(fwAtLeast("tsim-updater 2.0.0", "1.6.2") && !fwAtLeast("tsim-updater 1.5.9", "1.6.2") && !fwAtLeast(null, "1.6.2"));
  globalThis.fetch = async () => new Response(new Uint8Array([0xE9]), { status: 206, headers: { "Content-Range": "bytes 0-0/900000" } });
  assert.equal(await heltecImageRisk("https://h/small.bin"), null);
  globalThis.fetch = of;
  console.log("progress tests ok");
}
{
  const R = { tag: "v1.6.3", asset_name: "firmware.bin", checked_at: "x" };
  assert.equal(updateStatus("tsim-updater 1.6.2", R).text, "New update available: v1.6.3 (installed v1.6.2)");
  assert.equal(updateStatus("tsim-updater 1.6.3", R).text, "Up to date (v1.6.3)");
  assert.equal(updateStatus("x", null).text, "Not checked yet");
  assert.equal(updateStatus(null, R).state, "unknown");
  assert.equal(updateStatus(null, { tag: "direct", asset_name: "a.bin" }, { tag: "direct", asset_name: "a.bin" }).state, "current");
  assert.equal(updateStatus(null, { tag: "v1.10.0", asset_name: "Heltec_v3_repeater-v1.10.0.bin" }, { tag: "v1.9.1" }).state, "available");
  const of = globalThis.fetch; let n = 0, sms = 0;
  globalThis.fetch = async (u) => { if (/hologram/i.test(String(u))) sms++; n++; return new Response(JSON.stringify({ tag_name: "v9.9.9", assets: [{ id: 1, name: "firmware.bin", browser_download_url: "https://g/f.bin" }, { id: 2, name: "Heltec_v3_repeater-x-upgrade.bin", browser_download_url: "https://g/h.bin" }] }), { status: 200 }); };
  const r1 = await refreshReleases(env); const n1 = n; await refreshReleases(env);
  assert.equal(sms, 0); assert.equal(n, n1, "second run uses cache"); assert(r1.length >= 1);
  globalThis.fetch = of;
  console.log("update status tests ok");
}
assert.equal(updateStatus("Heltec_v3_repeater-PowerSaving17.1.6", { tag: "PowerSaving17.1", asset_name: "Heltec_v3_repeater-PowerSaving17.1.6-upgrade.bin" }).text, "Up to date (v17.1.6)");
console.log("tag/asset version ok");
