// Local test harness: mocks KV and fetch (GitHub, Hologram). Run: node test/harness.mjs
import worker, { pickAsset, FW_PRESETS, psBlocks, tlFields, cfgListCmds, depOk, buildRptOp, rptReadAllKeys, cmdsPerWake, parseSettingReply, buildSettingCmd, RPT_READ_KEYS, RADIO_PRESETS, CMDS_PER_WAKE, parseAdcReply, calcAdcMultiplier, clampAdc, computeProgress, friendlyFail, heltecImageRisk, fwAtLeast, normChecksum, buildTsimCommand, hashPassword, verifyPassword, buildUpdateBody, parseMesh, runSchedules, updateStatus, refreshReleases } from "../src/index.js";
import assert from "node:assert";

const kv = new Map();
const STATE = {
  get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
};
const env = { STATE, HOLOGRAM_API_KEY: "k", ADMIN_TOKEN: "admintok", SESSION_SECRET: "sess-secret-for-tests" };
let holo = 0, holoOk = true, ghList = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("api.github.com") && url.includes("tsim-remote-updater")) return new Response(JSON.stringify({ tag_name: "v1.6.0", assets: [
    { id: 9, name: "firmware.bin", digest: "sha256:" + "ab".repeat(32), browser_download_url: "https://github.com/just-stuff-tm/tsim-remote-updater/releases/download/v1.6.0/firmware.bin" }] }));
  if (url.includes("api.github.com/repos/meshcore-dev/MeshCore/releases?")) { ghList++; const A = (v, h) => [{ id: 1, name: `Heltec_v3_repeater-v${v}-${h}-merged.bin`, browser_download_url: `https://g/m/${v}-merged.bin` }, { id: 2, name: `Heltec_v3_repeater-v${v}-${h}.bin`, browser_download_url: `https://github.com/meshcore-dev/MeshCore/releases/download/repeater-v${v}/Heltec_v3_repeater-v${v}-${h}.bin` }];
    return new Response(JSON.stringify([{ tag_name: "companion-v1.18.0", published_at: "2026-10-15T10:20:19Z", assets: [] }, { tag_name: "repeater-v1.18.0", published_at: "2026-10-15T10:03:13Z", assets: A("1.18.0", "81dbae5") },
      { tag_name: "room-server-v1.18.0", published_at: "2026-10-15T10:01:34Z", assets: [] }, { tag_name: "repeater-v1.19.0-rc1", prerelease: true, published_at: "2026-10-16T00:00:00Z", assets: A("1.19.0", "x") }, { tag_name: "repeater-v1.17.1", published_at: "2026-08-14T13:32:04Z", assets: A("1.17.1", "d929643") }])); }
  if (url.includes("api.github.com/repos/just-stuff-tm/MeshCore/releases/latest")) { const T = "v1.18.0-powersaving-serial", H = "8ba35c2d", D = `https://github.com/just-stuff-tm/MeshCore/releases/download/${T}/`;
    const names = [`Heltec_v3_repeater-${T}-${H}-merged.bin`, `Heltec_v3_repeater_headless-${T}-${H}.bin`, `Heltec_v3_room_server-${T}-${H}.bin`, `Heltec_v3_repeater-${T}-${H}.bin`, "SHA256SUMS.txt"];
    return new Response(JSON.stringify({ tag_name: T, published_at: "2026-10-18T20:30:00Z", body: "MeshCore v1.18.0 + power saving", assets: names.map((n, i) => ({ id: 100 + i, name: n, browser_download_url: D + n })) })); }
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
// the update-flow tests below use an explicitly chosen EasySkyMesh source (saved by the user after v2, so never migrated)
kv.set("source:tsim-1", JSON.stringify({ enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", tag_prefix: "", direct_url: "", v: 2 }));
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
  assert.equal(tel.commands.length, 0, "system TSIMUPDATE hidden from console"); assert.equal(JSON.parse(kv.get("cmds:ota-1"))[0].status, "done");
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
  globalThis.fetch = async (u) => { if (/hologram/i.test(String(u))) sms++; n++; return new Response(JSON.stringify({ tag_name: "v9.9.9", assets: [{ id: 1, name: "firmware.bin", browser_download_url: "https://g/f.bin" }, { id: 2, name: "Heltec_v3_repeater-x-upgrade.bin", browser_download_url: "https://g/h.bin" }, { id: 3, name: "Heltec_v3_repeater-v9.9.9-powersaving-serial-abc.bin", browser_download_url: "https://g/p.bin" }] }), { status: 200 }); };
  const r1 = await refreshReleases(env); const n1 = n; await refreshReleases(env);
  assert.equal(sms, 0); assert.equal(n, n1, "second run uses cache"); assert(r1.length >= 1);
  globalThis.fetch = of;
  console.log("update status tests ok");
}
assert.equal(updateStatus("Heltec_v3_repeater-PowerSaving17.1.6", { tag: "PowerSaving17.1", asset_name: "Heltec_v3_repeater-PowerSaving17.1.6-upgrade.bin" }).text, "Up to date (v17.1.6)");
console.log("tag/asset version ok");

// v1.6.4 flash details + radio confirmation status
{
  const { parseFlashInfo, radioStatus } = await import("../src/index.js");
  const fi = parseFlashInfo("SUCCESS: https://g/x/Heltec_v3_repeater-v1.17.1-d929643.bin | chip=ESP32-S3 image=app-only addr=0x10000 size=1000 written=1000 verify=OK md5=abc");
  assert.deepEqual(fi, { chip: "ESP32-S3", image: "app-only", addr: "0x10000", size: 1000, written: 1000, verify: "OK", md5: "abc" });
  const now = Date.now(), T = (m) => new Date(now - 60e3 * (10 - m)).toISOString();
  const st = { last_update_sent: { at: T(0), asset_name: "Heltec_v3_repeater-v1.17.1-d929643.bin", tag: "direct" } };
  const H = [{ type: "update", msg: "SUCCESS: https://g/x/Heltec_v3_repeater-v1.17.1-d929643.bin | chip=ESP32-S3 image=app-only addr=0x10000 size=1000 written=1000 verify=OK md5=abc", received_at: T(3) },
    { type: "update", msg: "Flashing: chip=ESP32-S3 image=app-only addr=0x10000 size=1000", received_at: T(2) },
    { type: "update", msg: "Download done: 1000 bytes, flashing", received_at: T(1.5) }];
  const p = computeProgress("heltec", H, st, now);
  assert.equal(p.state, "done"); assert.equal(p.flash.chip, "ESP32-S3"); assert.equal(p.flash.verify, "OK"); assert.equal(p.flash.addr, "0x10000");
  const pf = computeProgress("heltec", [{ type: "update", msg: "FAIL: flash https://g/a.bin | chip=ESP32-S3 image=merged addr=0x0 size=9 written=9 verify=FAIL md5=d", received_at: T(3) }, H[1]], st, now);
  assert.equal(pf.state, "failed"); assert.equal(pf.flash.verify, "FAIL"); assert.equal(pf.flash.image, "merged");
  const rel = { tag: "direct", asset_name: "Heltec_v3_repeater-v1.17.1-d929643.bin", checked_at: T(0) };
  const s2 = { radio_flashed: { at: T(3), file: "Heltec_v3_repeater-v1.17.1-d929643.bin", flash: fi } };
  let u = radioStatus({ heltec_fw: "PowerSaving 17.1.6", received_at: T(1) }, s2, rel);
  assert.equal(u.state, "flashed"); assert.equal(u.text, "Last flashed: Heltec_v3_repeater-v1.17.1-d929643.bin (awaiting repeater confirmation)");
  u = radioStatus({ heltec_fw: "v1.17.1-d929643 (Build: 1-Oct-2026)", received_at: T(5) }, s2, rel);
  assert.equal(u.state, "current"); assert.equal(u.text, "Up to date (v1.17.1, confirmed)");
  u = radioStatus({ heltec_fw: "v1.16.0", received_at: T(5) }, s2, rel);
  assert.equal(u.state, "mismatch"); assert(/flashed Heltec_v3_repeater-v1.17.1-d929643.bin but the repeater reports v1.16.0/.test(u.text));
  u = radioStatus({ heltec_fw: "v1.17.1", received_at: T(5) }, s2, null); assert.equal(u.text, "Running v1.17.1 (confirmed)");
  assert.equal(radioStatus({ heltec_fw: "v1.17.1" }, {}, rel).state, "current");  // no flash record: old behaviour
  // ingest stores radio_flashed
  const dev = JSON.parse(kv.get("device:tsim-1"));
  r = await call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": dev.ingest_key }, body: JSON.stringify({ type: "update", fw: "tsim-updater 1.6.4", msg: H[0].msg }) });
  assert.equal(r.status, 200);
  const sst = JSON.parse(kv.get("state:tsim-1"));
  assert.equal(sst.radio_flashed.file, "Heltec_v3_repeater-v1.17.1-d929643.bin"); assert.equal(sst.radio_flashed.flash.chip, "ESP32-S3");
  assert.equal(sst.heltec_fw, "Heltec_v3_repeater-v1.17.1-d929643");
  console.log("v1.6.4 flash-info tests OK");
}

// system commands hidden from console history
{
  const { userCommands, isSysCmd } = await import("../src/index.js");
  assert(isSysCmd("TSIMUPDATE https://x abc")); assert(!isSysCmd("ver"));
  const L = [{ id: "a", cmd: "ver", status: "done" }, { id: "b", cmd: "TSIMUPDATE https://x", sys: true }, { id: "c", cmd: "stats-core", unsolicited: true, sys: true }, { id: "d", cmd: "TSIMUPDATE y" }];
  assert.deepEqual(userCommands(L).map((c) => c.id), ["a"]);
  const dev = JSON.parse(kv.get("device:tsim-1"));
  kv.set("cmds:tsim-1", JSON.stringify([{ id: "u1", cmd: "neighbors", status: "sent" }, { id: "s1", cmd: "TSIMUPDATE https://x", sys: true, status: "sent" }]));
  const post = (b) => call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": dev.ingest_key }, body: JSON.stringify(b) });
  assert.equal((await post({ type: "cmd", cmd_id: "u1", cmd: "neighbors", output: "none" })).status, 200);
  assert.equal((await post({ type: "cmd", cmd_id: "s1", cmd: "TSIMUPDATE https://x", sys: true, output: "T-SIM OTA starting" })).status, 200);
  assert.equal((await post({ type: "cmd", cmd_id: "zz", cmd: "ver", output: "v1.17.1" })).status, 200);  // unsolicited = system
  const all = JSON.parse(kv.get("cmds:tsim-1"));
  assert.equal(all.length, 3); assert.equal(all.find((c) => c.id === "zz").sys, true);
  assert.deepEqual(userCommands(all).map((c) => c.id), ["u1"]);
  console.log("system-command console filter OK");
}

// power saving: unknown after a flash, cleared by replies
{
  const { psDecision } = await import("../src/index.js");
  const st = { radio_flashed: { at: "2026-10-15T00:07:02.178Z" } };
  assert.equal(psDecision(st, true, "mesh poll: no CLI reply"), null);
  assert.equal(psDecision({ ...st, cli_ok_at: "2026-10-15T00:13:00.000Z" }, true, "mesh poll: no CLI reply"), true);
  assert.equal(psDecision(st, true, "console: powersaving on"), true);
  assert.equal(psDecision({}, true, "mesh poll: no CLI reply"), true);
  assert.equal(psDecision(st, false, "mesh poll: CLI answered"), false);
  const dev = JSON.parse(kv.get("device:tsim-1"));
  const post = (b) => call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": dev.ingest_key }, body: JSON.stringify(b) });
  const s0 = JSON.parse(kv.get("state:tsim-1")); s0.heltec_powersaving = true; delete s0.cli_ok_at; kv.set("state:tsim-1", JSON.stringify(s0));
  await post({ type: "update", msg: "SUCCESS: https://g/x/Heltec_v3_repeater-v1.17.1-d929643.bin | chip=ESP32-S3" });
  assert.equal(JSON.parse(kv.get("state:tsim-1")).heltec_powersaving, null, "flash resets to unknown");
  await post({ type: "mesh", heltec_cli: "asleep" });
  assert.equal(JSON.parse(kv.get("state:tsim-1")).heltec_powersaving, null, "no reply after flash stays unknown");
  await post({ type: "mesh", ver: "v1.17.1-d929643" });
  const s1 = JSON.parse(kv.get("state:tsim-1")); assert.equal(s1.heltec_powersaving, false); assert(s1.cli_ok_at);
  await post({ type: "mesh", heltec_cli: "asleep" });
  assert.equal(JSON.parse(kv.get("state:tsim-1")).heltec_powersaving, true, "fresh no-reply after a confirmed answer asserts it");
  console.log("power-saving state tests OK");
}

// IP blur
{
  const { dashboardPage } = await import("../src/index.js");
  const h = dashboardPage({ id: "tsim-1", name: "x" });
  assert(/\.sens\{filter:blur/.test(h) && /tsim_show_sensitive/.test(h) && /\["IP",sens\(L\.ip\)\]/.test(h));
  console.log("IP blur OK");
}

// MeshCore role-tagged releases: newest repeater-*, app-only asset
{
  const { latestRelease, pickAsset, FW_PRESETS, radioStatus } = await import("../src/index.js");
  assert.equal(pickAsset(["Heltec_v3_repeater-v1.18.0-81dbae5-merged.bin", "Heltec_v3_repeater-v1.18.0-81dbae5.bin"], "Heltec_v3_repeater-v*.bin"), "Heltec_v3_repeater-v1.18.0-81dbae5.bin");
  assert.equal(pickAsset(["a-merged.bin"], "a-merged.bin"), "a-merged.bin");
  const P = FW_PRESETS.meshcore; assert(P.enabled && P.tag_prefix === "repeater-" && !P.direct_url);
  const rel = await latestRelease(env, P);
  assert.equal(rel.tag, "repeater-v1.18.0"); assert.equal(rel.asset_name, "Heltec_v3_repeater-v1.18.0-81dbae5.bin");
  const u = radioStatus({ heltec_fw: "v1.17.1-d929643 (Build: 14-Aug-2026)" }, {}, { ...rel, checked_at: "x" });
  assert.equal(u.state, "available"); assert.equal(u.text, "New update available: v1.18.0 (installed v1.17.1)");
  assert.equal(radioStatus({ heltec_fw: "v1.18.0-81dbae5" }, {}, rel).state, "current");
  // source save keeps tag_prefix; Check uses it; cron dedupes GitHub calls
  const sv = await admin("/admin/devices", "GET"); assert.equal(sv.status, 200);
  kv.set("source:tsim-1", JSON.stringify({ enabled: true, repo: P.repo, asset_pattern: P.asset_pattern, tag_prefix: "repeater-", direct_url: "" }));
  kv.delete("release:tsim-1"); const g0 = ghList;
  await refreshReleases(env, Date.now());
  assert.equal(JSON.parse(kv.get("release:tsim-1")).tag, "repeater-v1.18.0"); assert.equal(ghList, g0 + 1);
  await refreshReleases(env, Date.now()); assert.equal(ghList, g0 + 1, "6h cache: no second GitHub call");
  console.log("MeshCore repeater-* release tracking OK");
}

// v1.6.5 power: calibration + low-battery protection (no SMS)
{
  const { validatePower, pwrCfgCmd, DEFAULT_POWER, batPct, isSysCmd, userCommands } = await import("../src/index.js");
  assert.equal(DEFAULT_POWER.lb_hi >= DEFAULT_POWER.lb_lo * 1.1, true);
  assert.throws(() => validatePower({}, { lb_lo: 3.4, lb_hi: 3.7 }, 3.9), /at least 10% higher.*3\.74 V or more/);
  assert.equal(validatePower({}, { lb_lo: 3.4, lb_hi: 3.74 }, 3.9).lb_hi, 3.74);
  assert.throws(() => validatePower({}, { lb_int: 2 }, 3.9), /0.25 and 24 hours/); assert.equal(validatePower({}, { lb_int_h: 0.5 }, 3.9).lb_int, 30); assert.equal(validatePower({}, { lb_int_h: 1.5 }, 3.9).lb_int, 90); assert.throws(() => validatePower({}, { lb_int_h: 0.1 }, 3.9), /0.25 and 24/); assert.throws(() => validatePower({}, { lb_int_h: 25 }, 3.9), /0.25 and 24/);
  assert.throws(() => validatePower({}, { measured_v: 4.07 }, 0), /No idle battery reading/);
  assert.equal(validatePower({}, { measured_v: 4.07 }, 3.95).cal_scale, 1.0304);
  assert.throws(() => validatePower({}, { cal_scale: 2 }, 3.9), /0\.5 and 1\.5/);
  assert.deepEqual([validatePower({ cal_scale: 1.1, cal_off: 0.1 }, { reset_cal: true }, 0).cal_scale, validatePower({ cal_scale: 1.1, cal_off: 0.1 }, { reset_cal: true }, 0).cal_off], [1, 0]);
  assert.equal(pwrCfgCmd(DEFAULT_POWER), "PWRCFG scale=1 off=0 en=0 lo=3.40 hi=3.75 int=30 imm=0");
  assert.equal(batPct(3.75), 53); assert(isSysCmd("PWRCFG scale=1"));
  // via API: login as device, save, queued sys cmd, no Hologram text
  const dev = JSON.parse(kv.get("device:tsim-1"));
  const post = (b) => call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": dev.ingest_key }, body: JSON.stringify(b) });
  await post({ type: "status", fw: "tsim-updater 1.6.5", battery_v: 3.95, battery_raw_v: 3.95, battery_load_v: 3.86, cal_scale: 1, cal_off: 0, lb_en: false, lb_state: 0, lb_lo: 3.4, lb_hi: 3.75, lb_int: 30, msg: "STATUS" });
  const L = JSON.parse(kv.get("telem:tsim-1:latest")); assert.equal(L.battery_raw_v, 3.95); assert.equal(L.lb_en, false); assert.equal(L.battery_load_v, 3.86);
  const pw = JSON.parse(kv.get("device:tsim-1")); void pw;
  kv.set("cmds:tsim-1", "[]");
  const h0 = holo;
  // call the device API handler directly through the router with a device session: reuse admin-free path via exported handler is not available, so simulate KV result
  const { default: W } = await import("../src/index.js");
  const sess = (await login("tsim-1", "device-one-password", "9.9.9.9")).headers.get("Set-Cookie");
  if (sess && /=/.test(sess)) {
    const c = sess.split(";")[0];
    const P = (b) => call("/api/d/tsim-1/power", { method: "POST", headers: { Cookie: c, "Content-Type": "application/json" }, body: JSON.stringify(b) });
    let rr = await P({ lb_en: true, lb_lo: 3.4, lb_hi: 3.6 }); assert.equal(rr.status, 400); assert(/10% higher/.test((await rr.json()).error));
    rr = await P({ measured_v: 4.07 }); assert.equal(rr.status, 200);
    rr = await P({ lb_en: true, lb_lo: 3.4, lb_hi: 3.75 }); assert.equal(rr.status, 200);
    const cl = JSON.parse(kv.get("cmds:tsim-1"));
    assert.equal(cl.filter((x) => x.status === "queued").length, 1, "newest PWRCFG replaces older");
    assert.equal(cl[0].cmd, "PWRCFG scale=1.0304 off=0 en=1 lo=3.40 hi=3.75 int=30 imm=0"); assert(cl[0].sys);
    const txt = await (await call("/api/dev/tsim-1/commands?sys=1", { headers: { "X-Device-Key": dev.ingest_key } })).text();
    assert(txt.includes("PWRCFG scale=1.0304"));
    await post({ type: "cmd", cmd_id: cl[0].id, cmd: cl[0].cmd, sys: true, output: "PWRCFG applied 6: scale=1.0304" });
    const tel = await (await call("/api/d/tsim-1/telemetry", { headers: { Cookie: c } })).json();
    assert(tel.power.settings.applied_at); assert.equal(tel.power.pending, null); assert.equal(userCommands(JSON.parse(kv.get("cmds:tsim-1"))).length, 0);
    await post({ type: "power", msg: "Battery protection: repeat OFF at 3.38V (below 3.40V, timer)", battery_v: 3.38 });
    const tel2 = await (await call("/api/d/tsim-1/telemetry", { headers: { Cookie: c } })).json();
    assert(/repeat OFF/.test(tel2.power.event.msg));
    console.log("power API tests OK (session)");
  } else throw new Error("power API login failed");
  assert.equal(holo, h0, "power settings never text the T-SIM");
  console.log("v1.6.5 power tests OK");
}

// Save & send: one wake text, dedupe, unchanged, old-firmware guard, schedule info
{
  const { scheduleInfo } = await import("../src/index.js");
  const dev = JSON.parse(kv.get("device:tsim-1"));
  const c = (await login("tsim-1", "device-one-password", "9.9.9.8")).headers.get("Set-Cookie").split(";")[0];
  const P = (b) => call("/api/d/tsim-1/power", { method: "POST", headers: { Cookie: c, "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const ing = (b) => call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": dev.ingest_key }, body: JSON.stringify(b) });
  // old firmware: no text, PWRCFG not handed out
  await ing({ type: "status", fw: "tsim-updater 1.6.4", battery_v: 3.9, msg: "STATUS" });
  const s0 = JSON.parse(kv.get("state:tsim-1")); delete s0.last_send_ts; kv.set("state:tsim-1", JSON.stringify(s0));
  let h0 = holo, j = await (await P({ lb_int_h: 1, send: true })).json();
  assert.equal(j.wake.sent, false); assert(/1\.6\.5/.test(j.wake.error)); assert.equal(holo, h0);
  assert(!(await (await call("/api/dev/tsim-1/commands?sys=1", { headers: { "X-Device-Key": dev.ingest_key } })).text()).includes("PWRCFG"));
  // 1.6.5: one text, second save within 15 min sends none
  await ing({ type: "status", fw: "tsim-updater 1.6.5", battery_v: 3.9, battery_raw_v: 3.9, msg: "STATUS" });
  j = await (await P({ lb_int_h: 2, send: true })).json();
  assert.equal(j.wake.sent, true); assert.equal(holo, h0 + 1);
  j = await (await P({ lb_int_h: 3, send: true })).json();
  assert.equal(j.wake.sent, false); assert(j.wake.already); assert.equal(holo, h0 + 1, "no second wake text");
  const q = JSON.parse(kv.get("cmds:tsim-1")).filter((x) => x.status === "queued" && /^PWRCFG/.test(x.cmd));
  assert.equal(q.length, 1); assert(/int=180/.test(q[0].cmd));
  let tel = await (await call("/api/d/tsim-1/telemetry", { headers: { Cookie: c } })).json();
  assert(tel.power.wake.sent && tel.power.pending === "queued");
  const txt = await (await call("/api/dev/tsim-1/commands?sys=1", { headers: { "X-Device-Key": dev.ingest_key } })).text();
  assert(txt.includes("int=180"));
  await ing({ type: "cmd", cmd_id: q[0].id, cmd: q[0].cmd, sys: true, output: "PWRCFG applied 7" });
  tel = await (await call("/api/d/tsim-1/telemetry", { headers: { Cookie: c } })).json();
  assert(tel.power.settings.applied_at); assert.equal(tel.power.pending, null);
  assert(/^System: PWRCFG/.test(tel.history.find((h) => h.type === "cmd").msg));
  // unchanged save: no queue, no text
  const s1 = JSON.parse(kv.get("state:tsim-1")); delete s1.last_send_ts; kv.set("state:tsim-1", JSON.stringify(s1));
  j = await (await P({ lb_int_h: 3, send: true })).json();
  assert.equal(j.unchanged, true); assert.equal(j.wake, null); assert.equal(holo, h0 + 1);
  // schedule: next run on an hour boundary
  const now = Date.parse("2026-10-15T23:46:00Z");
  const si = scheduleInfo(24, { last_sched_ts: Date.parse("2026-10-15T10:20:00Z") }, now);
  assert.equal(si.next_run, "2026-10-16T11:00:00.000Z");
  assert.equal(scheduleInfo(24, { last_sched_ts: Date.parse("2026-10-14T23:41:39Z") }, now).next_run, "2026-10-16T00:00:00.000Z");
  assert.equal(scheduleInfo(0, {}, now).next_run, null);
  console.log("save & send / schedule tests OK");
}

// Auto-resolve: never Stalled when the device runs the target version
{
  const now = Date.parse("2026-10-16T10:30:00Z");
  const sent = { at: "2026-10-15T23:28:29.192Z", asset_name: "firmware.bin", tag: "v1.6.5" };
  // outcome scrolled out of history, but state keeps tsim_last_ota
  let p = computeProgress("tsim", [], { tsim_update_sent: sent, tsim_last_ota: { at: "2026-10-15T23:31:34.685Z", msg: "TSIM OTA OK: tsim-updater 1.6.5 running (ingest accepted)" } }, now);
  assert.equal(p.state, "done");
  // no log at all, but device reports the version
  p = computeProgress("tsim", [], { tsim_update_sent: sent, tsim_fw: "tsim-updater 1.6.5", tsim_fw_at: "2026-10-15T23:31:40Z" }, now);
  assert.equal(p.state, "done"); assert(/reports v1.6.5/.test(p.resolved));
  p = computeProgress("tsim", [], { tsim_update_sent: sent, tsim_fw: "tsim-updater 1.6.4" }, now);
  assert.equal(p.state, "timeout");
  // radio: repeater confirms target after the start
  const rs = { last_update_sent: { at: "2026-10-15T10:43:00Z", asset_name: "Heltec_v3_repeater-v1.18.0-81dbae5.bin", tag: "repeater-v1.18.0" } };
  p = computeProgress("heltec", [], { ...rs, radio_ver: "v1.18.0-81dbae5 (Build: 15-Oct-2026)", radio_ver_at: "2026-10-15T10:49:35Z" }, now);
  assert.equal(p.state, "done");
  p = computeProgress("heltec", [], { ...rs, radio_ver: "v1.18.0", radio_ver_at: "2026-10-15T10:00:00Z" }, now);  // older report: not proof
  assert.equal(p.state, "timeout");
  p = computeProgress("heltec", [], { ...rs, last_update_result: { at: "2026-10-15T10:48:14Z", msg: "SUCCESS: https://g/x/Heltec_v3_repeater-v1.18.0-81dbae5.bin" } }, now);
  assert.equal(p.state, "done");
  // ingest: fw report cancels queued TSIMUPDATE
  const dev = JSON.parse(kv.get("device:tsim-1"));
  const s0 = JSON.parse(kv.get("state:tsim-1")); s0.tsim_update_sent = sent; kv.set("state:tsim-1", JSON.stringify(s0));
  kv.set("cmds:tsim-1", JSON.stringify([{ id: "q1", cmd: "TSIMUPDATE https://x/firmware.bin", sys: true, status: "queued" }]));
  await call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": dev.ingest_key }, body: JSON.stringify({ type: "status", fw: "tsim-updater 1.6.5", msg: "STATUS" }) });
  assert.equal(JSON.parse(kv.get("cmds:tsim-1"))[0].status, "cancelled");
  assert.equal(JSON.parse(kv.get("state:tsim-1")).tsim_fw, "tsim-updater 1.6.5");
  await call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": dev.ingest_key }, body: JSON.stringify({ type: "mesh", ver: "v1.18.0-81dbae5" }) });
  assert(JSON.parse(kv.get("state:tsim-1")).radio_ver.startsWith("v1.18.0"));
  console.log("auto-resolve tests OK");
}

// ---- sent:<id> overlay (send record survives a stale state: overwrite) ----
{
  const m = await import("../src/index.js");
  const st = { last_update_sent: { at: "2026-10-15T10:43:02Z", tag: "a" }, x: 1 };
  const sent = { last_update_sent: { at: "2026-10-16T01:26:00Z", tag: "a", retry: true }, log: [{ received_at: "2026-10-16T01:26:00Z", type: "action", msg: "UPDATE retry text sent" }] };
  const o = m.overlaySent(st, sent);
  if (!o.last_update_sent.retry || o.x !== 1) throw new Error("overlay newer failed");
  const o2 = m.overlaySent({ last_update_sent: { at: "2026-10-16T01:26:00Z", cancelled: true } }, sent);
  if (!o2.last_update_sent.cancelled) throw new Error("overlay must keep same-time state copy");
  const h = m.mergeSendLog([{ received_at: "2026-10-16T01:27:00Z", msg: "UPDATE start" }], sent);
  if (h.length !== 2 || h[1].msg !== "UPDATE retry text sent") throw new Error("merge log failed");
  console.log("sent overlay tests OK");
}

// ---- GPS / location (v1.6.7) ----
{
  const m = await import("../src/index.js");
  // pure helpers
  const g1 = m.parseGps({ type: "gps", fix: true, lat: 35.123456789, lon: -80.5, alt: 210.4, sats: 9, hdop: 0.9, utc: "2026-10-16T17:00:00Z", trigger: "cmd", msg: "GPS fix" }, {}, "2026-10-16T17:00:05Z");
  assert.equal(g1.fix.lat, 35.123457); assert.equal(g1.fix.sats, 9); assert.equal(g1.fix.utc, "2026-10-16T17:00:00Z");
  const g2 = m.parseGps({ type: "gps", fix: false, sats: 3, msg: "GPS no fix after 90s (sats seen 3)" }, g1, "2026-10-16T18:00:00Z");
  assert.equal(g2.fix.lat, 35.123457, "no-fix keeps last good fix"); assert.equal(g2.attempt.fix, false); assert.equal(g2.attempt.sats, 3);
  { const gd = m.parseGps({ fix: false, sats: 0, msg: "x", diag: { ready_ms: 4200, warm: false, pwr: "+CGNSSPWR: 1", ant: "CGDRT=4,1 OK; CGSETV=4,1 OK", mode: "+CGNSSMODE: 3", first: ",,,,,,,,", last: ",,,,", sats: 0, timeout: 180 } });
    assert.equal(gd.attempt.diag.ready_ms, 4200); assert.equal(gd.attempt.diag.pwr, "+CGNSSPWR: 1"); assert.equal(m.parseGps({ fix: false }).attempt.diag, undefined); }
  assert.equal(m.validateGps({}, { timeout_s: 600 }).timeout_s, 600); assert.throws(() => m.validateGps({}, { timeout_s: 601 }), /600/);
  assert.equal(m.parseGps({ fix: true, lat: 0, lon: 0 }).fix, null);
  assert.equal(m.fmtDist(301.4, false), "301 m"); assert.equal(m.fmtDist(301.4, true), "989 ft"); assert.equal(m.fmtDist(7, true), "23 ft");
  assert.equal(m.fmtDist(2500, false), "2.5 km"); assert.equal(m.fmtDist(2000, true), "1.2 mi"); assert.equal(m.fmtDist(null, true), null);
  assert.equal(m.fmtTemp(25, true), "77 °F"); assert.equal(m.fmtTemp(25, false), "25 °C");
  { const q = "2026-10-16T17:56:56.350Z", N = Date.parse(q) + 60e3;
    assert.equal(m.gpsPendResolved(q, { state: "done", started_at: q }, null, N), true, "server shows this request");
    assert.equal(m.gpsPendResolved("2026-10-16T17:56:57.900Z", { state: "done", started_at: q }, null, N), true, "client clock a bit later");
    assert.equal(m.gpsPendResolved(q, { state: "idle" }, { at: "2026-10-16T17:58:22Z", fix: true }, N), true, "newer fix arrived");
    assert.equal(m.gpsPendResolved(q, { state: "done", started_at: "2026-10-16T17:30:00Z" }, { at: "2026-10-16T17:31:00Z" }, N), false, "older result only");
    assert.equal(m.gpsPendResolved(q, null, null, Date.parse(q) + 16 * 60e3), true, "gives up after 15 min"); }
  { let o = m.setNick({}, "90e93ce2", " Hilltop <b> "); assert.deepEqual(o, { "90E93CE2": "Hilltop b" }); o = m.setNick(o, "90E93CE2", ""); assert.deepEqual(o, {});
    assert.throws(() => m.setNick({}, "zz", "x"), /hex/); }
  { const u = m.updateStatus("tsim-updater 1.6.7", { tag: "v1.6.8", asset_name: "firmware.bin", notes: m.relNotes("## New\r\n- GPS"), html_url: m.safeRelUrl("https://github.com/o/r/releases/tag/v1.6.8") });
    assert.equal(u.state, "available"); assert.equal(u.notes, "## New\n- GPS"); assert.equal(u.release_url, "https://github.com/o/r/releases/tag/v1.6.8");
    assert.equal(m.safeRelUrl("javascript:alert(1)", "o/r", "v1"), "https://github.com/o/r/releases/tag/v1"); assert.equal(m.updateStatus("1.6.8", { tag: "v1.6.8", notes: "x" }).notes, undefined); } assert.equal(m.parseGps({ fix: true, lat: 95, lon: 1 }).fix, null);
  assert.equal(m.gpsCfgCmd(m.DEFAULT_GPS), "GPSCFG auto=0 to=180");
  assert.throws(() => m.validateGps({}, { timeout_s: 10 }), /30 and 600/);
  assert(m.isSysCmd("GPSFIX") && m.isSysCmd("GPSCFG auto=1 to=90") && !m.isSysCmd("set lat 1"));
  const req = { id: "g1", at: "2026-10-16T17:00:00Z", timeout_s: 90 }, T = Date.parse("2026-10-16T17:01:00Z");
  assert.equal(m.gpsProgress(null).state, "idle");
  assert.equal(m.gpsProgress(req, [{ id: "g1", status: "queued" }], {}, T).state, "running");
  assert.equal(m.gpsProgress(req, [{ id: "g1", status: "queued" }], {}, T + 20 * 60e3).state, "timeout");
  assert.equal(m.gpsProgress(req, [{ id: "g1", status: "sent", sent_at: "2026-10-16T17:00:30Z" }], {}, T).step, 1);
  assert.equal(m.gpsProgress(req, [{ id: "g1", status: "sent", sent_at: "2026-10-16T17:00:30Z" }], {}, T + 10 * 60e3).state, "timeout");
  assert.equal(m.gpsProgress(req, [{ id: "g1", status: "done" }], { attempt: { at: "2026-10-16T17:02:00Z", fix: true } }, T).state, "done");
  assert.equal(m.gpsProgress(req, [{ id: "g1", status: "done" }], { attempt: { at: "2026-10-16T17:02:00Z", fix: false, msg: "no fix" } }, T).state, "failed");
  assert.equal(m.gpsProgress(req, [{ id: "g1", status: "done" }], { attempt: { at: "2026-10-16T16:00:00Z", fix: true } }, T).state, "failed", "older attempt is not this request's result");
  assert.equal(m.gpsProgress(req, [{ id: "g1", status: "cancelled" }], {}, T).state, "cancelled");
  assert.equal(m.locProgress({ ids: ["a", "b"] }, [{ id: "a", status: "done", output: "  -> OK" }, { id: "b", status: "done", output: "  -> OK" }]).state, "done");
  assert.equal(m.locProgress({ ids: ["a", "b"] }, [{ id: "a", status: "done", output: "  -> OK" }, { id: "b", status: "sent" }]).state, "sending");
  assert.equal(m.locProgress({ ids: ["a", "b"] }, [{ id: "a", status: "done", output: "  -> OK" }, { id: "b", status: "error", error: "no reply" }]).state, "failed");

  // API flow
  const dev = JSON.parse(kv.get("device:tsim-1"));
  const ingest = (b) => call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": dev.ingest_key }, body: JSON.stringify(b) });
  const c = (await login("tsim-1", "device-one-password", "5.5.5.5")).headers.get("Set-Cookie").split(";")[0];
  const P = (a, b) => call("/api/d/tsim-1/" + a, { method: "POST", headers: { Cookie: c, "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
  const TEL = async () => (await (await call("/api/d/tsim-1/telemetry", { headers: { Cookie: c } })).json());
  const unthrottle = () => { const s = JSON.parse(kv.get("state:tsim-1") || "{}"); delete s.last_send_ts; kv.set("state:tsim-1", JSON.stringify(s)); const x = JSON.parse(kv.get("sent:tsim-1") || "{}"); delete x.last_send_ts; kv.set("sent:tsim-1", JSON.stringify(x)); };
  kv.set("cmds:tsim-1", "[]"); kv.delete("gps:tsim-1"); kv.delete("gpsreq:tsim-1"); kv.delete("locreq:tsim-1");
  const st0 = JSON.parse(kv.get("state:tsim-1") || "{}"); st0.heltec_powersaving = false; kv.set("state:tsim-1", JSON.stringify(st0));
  await ingest({ type: "status", fw: "tsim-updater 1.6.6", msg: "STATUS" });
  unthrottle(); let h0 = holo;
  let r = await P("gps-fix"); assert.equal(r.status, 409); assert(/1\.6\.7/.test((await r.json()).error)); assert.equal(holo, h0, "old firmware: no text");
  // old firmware never receives GPS commands even if queued
  kv.set("cmds:tsim-1", JSON.stringify([{ id: "zz", cmd: "GPSFIX", sys: true, status: "queued" }]));
  assert(!(await (await call("/api/dev/tsim-1/commands?sys=1", { headers: { "X-Device-Key": dev.ingest_key } })).text()).includes("GPSFIX"));
  kv.set("cmds:tsim-1", "[]");
  await ingest({ type: "status", fw: "tsim-updater 1.6.7", msg: "STATUS" });
  let tel = await TEL(); assert.equal(tel.gps.supported, true); assert.equal(tel.gps.fix, null); assert.equal(tel.gps.progress.state, "idle"); assert.equal(tel.gps.settings.auto, false);
  unthrottle(); h0 = holo;
  r = await P("gps-fix"); let j = await r.json(); assert.equal(j.sent, true); assert.equal(holo, h0 + 1); assert.equal(j.queued.cmd, "GPSFIX");
  unthrottle();
  r = await P("gps-fix"); assert.equal(r.status, 409); assert((await r.json()).duplicate); assert.equal(holo, h0 + 1, "double press: no second text");
  tel = await TEL(); assert.equal(tel.gps.progress.state, "running"); assert.equal(tel.gps.progress.step, 0);
  assert.equal(m.userCommands(JSON.parse(kv.get("cmds:tsim-1"))).length, 0, "GPSFIX hidden from console");
  const txt = await (await call("/api/dev/tsim-1/commands?sys=1", { headers: { "X-Device-Key": dev.ingest_key } })).text();
  assert(txt.includes("\tGPSFIX"));
  tel = await TEL(); assert.equal(tel.gps.progress.step, 1);
  r = await P("gps-cancel"); j = await r.json(); assert(j.cancelled && /already started/.test(j.note));
  // result still lands and is stored
  await ingest({ type: "gps", fw: "tsim-updater 1.6.7", fix: true, lat: 35.1234567, lon: -80.7654321, alt: 200, sats: 8, hdop: 1.1, utc: "2026-10-16T17:00:00Z", secs: 40, src: "CGNSSINFO", trigger: "cmd", msg: "GPS fix" });
  await ingest({ type: "cmd", cmd_id: j.id || JSON.parse(kv.get("cmds:tsim-1"))[0].id, cmd: "GPSFIX", sys: true, output: "GPS fix 35.123457,-80.765432" });
  tel = await TEL(); assert.equal(tel.gps.fix.lat, 35.123457); assert.equal(tel.gps.fix.sats, 8);
  // fresh request -> done once the gps record arrives
  unthrottle(); r = await P("gps-fix"); j = await r.json(); assert.equal(j.sent, true);
  // cancel while still queued -> cancelled, never handed out
  r = await P("gps-cancel"); assert((await r.json()).cancelled); tel = await TEL(); assert.equal(tel.gps.progress.state, "cancelled");
  assert(!(await (await call("/api/dev/tsim-1/commands?sys=1", { headers: { "X-Device-Key": dev.ingest_key } })).text()).includes("GPSFIX"));
  // retry
  unthrottle(); r = await P("gps-fix", { retry: true }); j = await r.json(); assert.equal(j.sent, true);
  await call("/api/dev/tsim-1/commands?sys=1", { headers: { "X-Device-Key": dev.ingest_key } });
  await new Promise((ok) => setTimeout(ok, 5));
  await ingest({ type: "gps", fw: "tsim-updater 1.6.7", fix: false, sats: 2, secs: 90, src: "CGNSSINFO", trigger: "cmd", msg: "GPS no fix after 90s (sats seen 2)" });
  tel = await TEL(); assert.equal(tel.gps.progress.state, "failed"); assert.equal(tel.gps.fix.lat, 35.123457, "last good fix kept");
  // settings: queued GPSCFG, newest wins, no text
  h0 = holo;
  assert.equal((await P("gps-settings", { timeout_s: 5 })).status, 400);
  assert.equal((await P("gps-settings", { auto: true, timeout_s: 120 })).status, 200);
  assert.equal((await P("gps-settings", { auto: true, timeout_s: 60 })).status, 200);
  let cl = JSON.parse(kv.get("cmds:tsim-1")).filter((x) => /^GPSCFG/.test(x.cmd) && x.status === "queued");
  assert.equal(cl.length, 1); assert.equal(cl[0].cmd, "GPSCFG auto=1 to=60"); assert.equal(holo, h0);
  tel = await TEL(); assert.equal(tel.gps.settings.auto, true); assert.equal(tel.gps.settings_pending, "queued");
  // set repeater location: confirm required, queues set lat / set lon (sys, run even with console off)
  assert.equal((await P("set-location", {})).status, 400);
  await P("settings", { console_enabled: false });
  unthrottle(); h0 = holo;
  r = await P("set-location", { confirm: true }); j = await r.json(); assert.equal(j.sent, true); assert.equal(holo, h0 + 1);
  assert.deepEqual(j.queued.map((x) => x.cmd), ["set lat 35.123457", "set lon -80.765432"]);
  unthrottle(); assert.equal((await P("set-location", { confirm: true })).status, 409, "no double send");
  const out = await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text();
  assert(out.indexOf("set lat 35.123457") >= 0 && out.indexOf("set lat") < out.indexOf("set lon"), "lat then lon");
  for (const q of j.queued) await ingest({ type: "cmd", cmd_id: q.id, cmd: q.cmd, output: "  -> OK" });
  tel = await TEL(); assert.equal(tel.gps.location.state, "done"); assert.equal(tel.gps.location.outputs[0].output, "OK");
  assert.equal(tel.commands.length, 0, "location commands hidden from console history");
  // page has the new UI + CSP allows Leaflet/OSM only
  const pr = await call("/d/tsim-1", { headers: { Cookie: c } }); const html = await pr.text();
  assert(html.includes('id="gpsbtn"') && html.includes('id="locbtn"') && html.includes('id="gpsmap" class="map sens"') && html.includes("sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="));
  assert(/img-src https:\/\/tile\.openstreetmap\.org/.test(pr.headers.get("Content-Security-Policy")));
  console.log("GPS / location tests OK");
  // ---------- repeater battery calibration (adc.multiplier) ----------
  assert.deepEqual(parseAdcReply("get adc.multiplier", "  -> > 5.420"), { supported: true, mult: 5.42 });
  assert.deepEqual(parseAdcReply("get adc.multiplier", "  -> Error: unsupported"), { supported: false });
  assert.deepEqual(parseAdcReply("set adc.multiplier 5.1", "  -> OK - multiplier set to 5.100"), { supported: true, set: 5.1, mult: 5.1 });
  assert.deepEqual(parseAdcReply("set adc.multiplier 0", "OK - using default board multiplier"), { supported: true, set: 0, mult: null });
  assert.equal(parseAdcReply("ver", "x"), null);
  assert.equal(calcAdcMultiplier(5.42, 4.0, 4.2), 5.162); assert.equal(clampAdc(12), 10); assert.equal(clampAdc(-1), 0);
  assert.throws(() => calcAdcMultiplier(0, 4, 4.2)); assert.throws(() => calcAdcMultiplier(5, 9, 4.2)); assert.throws(() => calcAdcMultiplier(5, 4, null));
  assert.equal((await P("adc-cal", { op: "read" })).status, 403, "needs console");
  await P("settings", { console_enabled: true });
  await ingest({ type: "mesh", ver: "  -> v1.18.0", stats_core: '  -> {"battery_mv":4200,"uptime_secs":5}' });
  assert.equal((await P("adc-cal", { op: "preview", meter_v: 4.0 })).status, 400, "multiplier unknown yet");
  unthrottle(); h0 = holo;
  r = await P("adc-cal", { op: "read" }); j = await r.json(); assert.equal(r.status, 200); assert.equal(j.wake.sent, true); assert.equal(holo, h0 + 1);
  let tl = await TEL(); let gq = tl.commands.find((x) => x.cmd === "get adc.multiplier"); assert.equal(tl.adc.pending, "queued");
  await ingest({ type: "cmd", cmd_id: gq.id, cmd: gq.cmd, output: "  -> > 5.420" });
  tl = await TEL(); assert.equal(tl.adc.mult, 5.42); assert.equal(tl.adc.supported, true); assert.equal(tl.adc.pending, null);
  j = await (await P("adc-cal", { op: "preview", meter_v: 4.0 })).json(); assert.equal(j.preview.new_mult, 5.162);
  unthrottle(); h0 = holo;
  j = await (await P("adc-cal", { op: "set", meter_v: 4.0 })).json(); assert.deepEqual(j.queued, ["set adc.multiplier 5.162", "get adc.multiplier"]); assert.equal(holo, h0 + 1);
  tl = await TEL(); const sq = tl.commands.find((x) => x.cmd === "set adc.multiplier 5.162");
  await ingest({ type: "cmd", cmd_id: sq.id, cmd: sq.cmd, output: "  -> OK - multiplier set to 5.162" });
  tl = await TEL(); assert.equal(tl.adc.mult, 5.162);
  assert.equal((await P("adc-cal", { op: "preview", meter_v: 4.0 })).status, 409, "stale reading after change");
  unthrottle(); j = await (await P("adc-cal", { op: "reset" })).json(); assert.equal(j.queued[0], "set adc.multiplier 0");
  tl = await TEL(); const rq = tl.commands.find((x) => x.cmd === "set adc.multiplier 0"); const gq2 = tl.commands.find((x) => x.cmd === "get adc.multiplier" && x.status === "queued");
  await ingest({ type: "cmd", cmd_id: gq2.id, cmd: gq2.cmd, output: "  -> Error: unsupported" });
  await ingest({ type: "mesh", ver: "  -> v1.18.0", stats_core: '  -> {"battery_mv":4100}' });
  r = await P("adc-cal", { op: "set", meter_v: 4.0 }); assert.equal(r.status, 409); assert((await r.json()).unsupported);
  const ph = await (await call("/d/tsim-1", { headers: { Cookie: c } })).text();
  assert(ph.includes('id="adcbox"') && ph.includes('id="adcread"'));
  for (const m of ph.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);  // dashboard script parses
  console.log("repeater battery calibration tests OK");
  // ---------- repeater settings ----------
  assert.deepEqual(parseSettingReply("get name", "  -> > Hilltop"), { key: "name", op: "get", value: "Hilltop" });
  assert.deepEqual(parseSettingReply("get radio", "  -> > 910.525,62.5,7,5"), { key: "radio", op: "get", value: "910.525,62.5,7,5" });
  assert.equal(parseSettingReply("powersaving", "  -> on").value, "on");
  assert.equal(parseSettingReply("get radio.fem.rxgain", "  -> Error: unsupported").unsupported, true);
  assert.equal(parseSettingReply("get cad", "  -> ??: get cad").unsupported, true);
  assert.equal(parseSettingReply("set tx 30", "  -> Error, range is -9 to 30").error.startsWith("Error"), true);
  assert.equal(parseSettingReply("set tx 20", "  -> OK").ok, true);
  assert.equal(parseSettingReply("neighbors", "x"), null); assert.equal(parseSettingReply("get prv.key", "x"), null, "private key never parsed");
  assert.equal(buildSettingCmd("radio", "910.525,62.5,7,5"), "set radio 910.525,62.5,7,5");
  assert.throws(() => buildSettingCmd("radio", "910,62.5,13,5")); assert.throws(() => buildSettingCmd("tx", 23)); assert.throws(() => buildSettingCmd("advert.interval", 30));
  assert.equal(buildSettingCmd("advert.interval", 0), "set advert.interval 0"); assert.equal(buildSettingCmd("powersaving", "off"), "powersaving off");
  assert.equal(buildSettingCmd("multi.acks", "1"), "set multi.acks 1"); assert.throws(() => buildSettingCmd("role", "x")); assert.throws(() => buildSettingCmd("prv.key", "x"));
  assert.throws(() => buildSettingCmd("name", "café")); assert.equal(buildSettingCmd("password", "s3cret!"), "password s3cret!");
  const allP = RADIO_PRESETS.flatMap((g) => g[1]); assert.equal(allP.length, 26); assert(allP.some((x) => x[0] === "USA" && x[1] === 910.525 && x[2] === 62.5 && x[3] === 7 && x[4] === 5));
  await P("settings", { console_enabled: false });
  assert.equal((await P("rpt-read", {})).status, 403);
  await P("settings", { console_enabled: true });
  unthrottle(); h0 = holo;
  j = await (await P("rpt-read", {})).json(); assert.equal(j.queued, rptReadAllKeys({}).length); assert(j.queued > CMDS_PER_WAKE); assert.equal(holo, h0 + 1, "one text");
  assert.equal(j.wakes_needed, Math.ceil(rptReadAllKeys({}).length / CMDS_PER_WAKE));
  assert.equal((await (await P("rpt-read", {})).json()).queued, 0, "no duplicates");
  let batch = (await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text()).trim().split("\n").map((l) => l.split("\t"));
  assert.equal(batch.length, CMDS_PER_WAKE); assert.equal(batch[0][1], "get name");
  const reply = { "get name": "  -> > Hilltop", "get owner.info": "  -> > Just Stuff", "get role": "  -> > repeater", "get public.key": "  -> Error: unsupported", "ver": "  -> v1.18.0-abc (Build: 1-Oct-2026)", "board": "  -> Heltec V3", "get lat": "  -> > 40.89", "get lon": "  -> > -77.47", "get radio": "  -> > 910.525,62.5,7,5", "get tx": "  -> > 22", "get radio.rxgain": "  -> > on", "get radio.fem.rxgain": "  -> Error: unsupported" };
  for (const [bid, bc] of batch) await ingest({ type: "cmd", cmd_id: bid, cmd: bc, output: reply[bc] || "  -> > 1" });
  tl = await TEL();
  assert.equal(tl.rpt.vals.name.value, "Hilltop"); assert.equal(tl.rpt.vals.radio.value, "910.525,62.5,7,5"); assert.equal(tl.rpt.vals["public.key"].unsupported, true); assert.equal(tl.rpt.vals.board.value, "Heltec V3");
  assert(tl.rpt.queued.repeat === "queued"); assert(!tl.commands.some((x) => x.cmd === "get name"), "settings commands hidden from console history");
  // save: risky needs confirm, typed password, validation
  assert.equal((await P("rpt-save", { changes: { radio: "910.525,250,10,5" } })).status, 409);
  assert.equal((await P("rpt-save", { changes: { tx: 40 } })).status, 400);
  assert.equal((await P("rpt-save", { changes: { password: "newpass1" }, risk_ok: true })).status, 409, "typed confirmation");
  assert.equal((await P("rpt-save", { changes: { "prv.key": "00" }, risk_ok: true })).status, 400, "private key excluded");
  await P("commands", { cancel: true });
  unthrottle(); h0 = holo;
  r = await P("rpt-save", { changes: { powersaving: "on", name: "Hilltop 2", radio: "910.525,250,10,5", password: "newpass1" }, risk_ok: true, typed: "change" });
  j = await r.json(); assert.equal(r.status, 200); assert.equal(j.queued, 4); assert.equal(holo, h0 + 1);
  batch = (await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text()).trim().split("\n").map((l) => l.split("\t"));
  assert.equal(batch[batch.length - 1][1], "powersaving on", "power saving runs last");
  for (const [bid, bc] of batch) if (bc !== "powersaving on") await ingest({ type: "cmd", cmd_id: bid, cmd: bc, output: bc.startsWith("password") ? "  -> password now: newpass1" : "  -> OK" });
  tl = await TEL(); assert.equal(tl.rpt.vals.name.value, "Hilltop 2"); assert.equal(tl.rpt.vals.name.set, true); assert.equal(tl.rpt.vals.radio.value, "910.525,250,10,5");
  const raw = kv.get("cmds:tsim-1") + kv.get("rptcfg:tsim-1"); assert(!raw.includes("newpass1"), "admin password redacted after it runs");
  assert.equal((await P("rpt-action", { act: "erase" })).status, 400); unthrottle(); assert.equal((await P("rpt-action", { act: "advert" })).status, 200);
  const ph2 = await (await call("/d/tsim-1", { headers: { Cookie: c } })).text();
  assert(ph2.includes('id="rsreadall"') && ph2.includes('id="clipick"') && ph2.includes("Southern California") && !ph2.includes('value="erase"'));
  for (const m of ph2.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
  await P("commands", { cancel: true });
  console.log("repeater settings tests OK");
  // ---------- regions / ACL / tools ----------
  assert.equal(parseSettingReply("gps", "  -> on, active, fix, 8 sats").value, "on");
  assert.equal(parseSettingReply("gps advert", "  -> > prefs").value, "prefs"); assert.equal(parseSettingReply("gps advert share", "OK").key, "gps.advert");
  assert.equal(buildSettingCmd("gps.advert", "share"), "gps advert share"); assert.equal(buildSettingCmd("bridge.source", "logRx"), "set bridge.source logRx");
  assert(!rptReadAllKeys({}).includes("bridge.enabled") && rptReadAllKeys({}).includes("bridge.type") && !rptReadAllKeys({}).includes("pwrmgt.bootmv"));
  assert(rptReadAllKeys({ "bridge.type": { value: "rs232" } }).includes("bridge.enabled")); assert(rptReadAllKeys({}).length <= 40);
  assert.deepEqual(buildRptOp({ op: "region.put", name: "#PA", parent: "#USA", flood: true }).map((x) => x.cmd).slice(0, 3), ["region put #PA #USA", "region allowf #PA", "region save"]);
  assert.equal(buildRptOp({ op: "region.default", name: "" })[0].cmd, "region default <null>");
  assert.throws(() => buildRptOp({ op: "region.put", name: "bad name" })); assert.throws(() => buildRptOp({ op: "erase" })); assert.throws(() => buildRptOp({ op: "acl.set", pubkey: "zz", perm: 1 }));
  assert.equal(buildRptOp({ op: "acl.set", pubkey: "abcd1234", perm: 3 })[0].risk, true); assert.equal(buildRptOp({ op: "tempradio", f: 910.525, bw: 250, sf: 10, cr: 5, mins: 10 })[0].cmd, "tempradio 910.525,250,10,5,10");
  await P("commands", { cancel: true }); unthrottle();
  assert.equal((await P("rpt-ops", { ops: [{ op: "acl.set", pubkey: "abcd1234", perm: 3 }] })).status, 409, "admin perm needs confirm");
  assert.equal((await P("rpt-ops", { ops: [{ op: "poweroff" }] })).status, 400);
  r = await P("rpt-ops", { ops: [{ op: "region.put", name: "#PA", flood: false }, { op: "clock.sync" }] }); j = await r.json(); assert.equal(r.status, 200);
  let fl = (await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text()).trim().split("\n").map((l) => l.split("\t"));
  assert.deepEqual(fl.map((x) => x[1]).slice(0, 3), ["region put #PA", "region denyf #PA", "region save"]);
  const tl1 = fl.find((x) => x[1].startsWith("time ")); assert(/^time \d{10}$/.test(tl1[1]) && Math.abs(+tl1[1].slice(5) - Date.now() / 1000) < 10, "time filled at fetch");
  for (const [bid, bc] of fl) await ingest({ type: "cmd", cmd_id: bid, cmd: bc, output: bc === "region" ? "  -> *  F\n  #USA F\n    #PA" : bc === "region home" ? "  -> > #PA" : "  -> OK" });
  tl = await TEL(); assert(tl.rpt.lists.regions.raw.includes("#PA")); assert.equal(tl.rpt.lists.home.raw, "#PA"); assert(tl.rpt.lists.ops.some((o) => o.cmd === "time (now)"));
  assert.equal(tl.rpt.ops_pending, 0); assert(!tl.commands.some((x) => x.cmd.startsWith("region")), "tool commands hidden from console");
  unthrottle(); r = await P("rpt-ops", { ops: [{ op: "read", what: "acl" }] }); assert.equal(r.status, 200);
  fl = (await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text()).trim().split("\n").map((l) => l.split("\t"));
  await ingest({ type: "cmd", cmd_id: fl[0][0], cmd: fl[0][1], output: "  -> Error: unsupported" });
  tl = await TEL(); assert(tl.rpt.lists.acl.error);
  const ph3 = await (await call("/d/tsim-1", { headers: { Cookie: c } })).text();
  assert(ph3.includes('id="rgadd"') && ph3.includes('id="acladd"') && ph3.includes('id="tmpr"')); for (const m of ph3.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
  // per-setting read: one get, only that field changes
  unthrottle(); j = await (await P("rpt-read", { keys: ["tx"] })).json(); assert.equal(j.queued, 1);
  tl = await TEL(); assert.equal(tl.rpt.queued.tx, "queued"); assert.equal(Object.values(tl.rpt.queued).filter((x) => x === "queued").length, 1);
  fl = (await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text()).trim().split("\n").map((l) => l.split("\t"));
  assert.deepEqual(fl.map((x) => x[1]), ["get tx"]); const nameAt = tl.rpt.vals.name.at;
  await ingest({ type: "cmd", cmd_id: fl[0][0], cmd: "get tx", output: "  -> > 20" });
  tl = await TEL(); assert.equal(tl.rpt.vals.tx.value, "20"); assert.equal(tl.rpt.vals.name.at, nameAt, "other fields untouched");
  assert.equal((await P("rpt-read", { keys: ["password"] })).status, 400, "write-only can't be read");
  assert.equal(buildRptOp({ op: "sensor.get", key: "temp" })[0].cmd, "sensor get temp");
  assert(ph3.includes("data-rs1"));
  // bridge hidden when the repeater reports "none"; secret fields can't be autofilled
  assert.equal(depOk({ value: "none" }), false); assert.equal(depOk({ unsupported: true, value: null }), false); assert.equal(depOk({ value: "rs232" }), true);
  assert(!rptReadAllKeys({ "bridge.type": { value: "none" } }).includes("bridge.secret"));
  const sj = ph3.match(/<script>([\s\S]*?)<\/script>/g).join("");
  assert(sj.includes('autocomplete="new-password"') && sj.includes('data-1p-ignore') && sj.includes('data-lpignore') && sj.includes("rs_secret_") && sj.includes("TYPED.has(i.k)"));
  console.log("regions / ACL / tools tests OK");
  // 1.6.9: whole Read all batch in one wake
  assert.equal(cmdsPerWake("tsim-updater 1.6.8"), 10); assert.equal(cmdsPerWake("tsim-updater 1.6.9"), 40); assert.equal(cmdsPerWake(null), 10);
  await ingest({ type: "status", fw: "tsim-updater 1.6.9" });
  tl = await TEL(); assert.equal(tl.rpt.per_wake, 40);
  unthrottle(); j = await (await P("rpt-read", {})).json(); assert.equal(j.wakes_needed, 1);
  const big = (await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text()).trim().split("\n");
  assert.equal(big.length, rptReadAllKeys(JSON.parse(kv.get("rptcfg:tsim-1"))).length, "all reads in one fetch"); assert(big.join("\n").length < 6000);
  // byte cap: long commands never overflow the T-SIM buffer
  const lst = JSON.parse(kv.get("cmds:tsim-1")); for (let i = 0; i < 40; i++) lst.unshift({ id: "x" + i, cmd: "set owner.info " + "y".repeat(150), status: "queued", queued_at: new Date().toISOString(), cfg: true });
  kv.set("cmds:tsim-1", JSON.stringify(lst));
  const capd = await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text();
  assert(capd.length <= 6000 && capd.endsWith("\n") && capd.trim().split("\n").length < 40);
  await P("commands", { cancel: true });
  await ingest({ type: "status", fw: "tsim-updater 1.6.8" });
  console.log("1.6.9 batch tests OK");
  // ---------- v1.7.0 ----------
  const ACL = "ACL:\r\n03 FB38B387E417DCBDC97E8DF46BF8B8C2EC2A20C98B75D6D1A53E4B8A57030CEB\n03 72A1AC8A92A8ABBB986DD64B2EA673944FF1B5D9806ED1C864CA966FA6CA961D";
  assert.equal(buildRptOp({ op: "acl.remove", pubkey: "abcd1234" })[0].cmd, "setperm abcd1234 0", "MeshCore 1.18 needs a permission value");
  await P("settings", { console_enabled: true }); unthrottle();
  await P("rpt-ops", { ops: [{ op: "read", what: "acl" }] });
  fl = (await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text()).trim().split("\n").map((l) => l.split("\t"));
  const psBefore = JSON.parse(kv.get("state:tsim-1") || "{}").heltec_powersaving;
  await ingest({ type: "cmd", cmd_id: fl[0][0], cmd: "get acl", output: ACL, error: "no reply from Heltec" });
  tl = await TEL(); assert.equal(tl.rpt.lists.acl.error, null, "raw ACL printout is a reply"); assert(tl.rpt.lists.acl.raw.includes("FB38B387"));
  assert.notEqual(JSON.parse(kv.get("state:tsim-1") || "{}").heltec_powersaving === true && psBefore !== true, true, "raw printout must not flag power saving");
  // telemetry block on any post
  assert.deepEqual(tlFields({ bv: 3.95, bp: 78, sv: 5.1, csq: 99, tc: 41.5, fw: "tsim-updater 1.7.0" }), { battery_v: 3.95, battery_pct: 78, solar_v: 5.1, chip_temp_c: 41.5, fw: "tsim-updater 1.7.0" });
  assert.equal(tlFields({ bv: 0.1 }).battery_v, undefined, "USB power: no battery reading");
  await ingest({ type: "event", msg: "x", tl: { fw: "tsim-updater 1.7.0", bv: 3.91, bp: 75, bl: 3.8, sv: 6.2, csq: 17, rsrp: -98, up: 42, heap: 150000, tc: 38.2, lb: 0, glat: 40.1, glon: -77.2, gsats: 8, gat: 1792000000 } });
  tl = await TEL(); assert.equal(tl.latest.solar_v, 6.2); assert.equal(tl.latest.chip_temp_c, 38.2); assert.equal(tl.latest.csq, 17); assert.equal(tl.latest.gps_cached.sats, 8); assert.equal(tl.latest.fw, "tsim-updater 1.7.0");
  // settings cache
  assert.equal((await call("/api/dev/tsim-1/cfglist", { headers: { "X-Device-Key": "bad" } })).status, 401);
  const cl2 = await (await call("/api/dev/tsim-1/cfglist", { headers: { "X-Device-Key": dev.ingest_key } })).text();
  assert(cl2.includes("get name\n") && cl2.includes("get acl\n") && cl2.includes("region home\n") && !/^(set |password )/m.test(cl2));
  assert(cfgListCmds({}).length <= 48);
  r = await P("cache-settings", { en: true, int_h: 12 }); assert.equal(r.status, 200); j = await r.json(); assert.equal(j.queued.cmd, "CFGSNAP en=1 int=12"); assert.equal(j.wake, null, "no text unless refresh now");
  assert.equal((await P("cache-settings", { en: true, int_h: 5 })).status, 400);
  await ingest({ type: "cfgsnap", part: 0, items: [["get name", "  -> > Cached Name"], ["get radio.fem.rxgain", "  -> Error: unsupported"], ["get tx", ""], ["get acl", ACL], ["region home", "  -> home is *"]], final: true, count: 5 });
  tl = await TEL(); assert.equal(tl.rpt.vals.name.value, "Cached Name"); assert.equal(tl.rpt.vals.name.src, "cache"); assert.equal(tl.rpt.vals.tx.value, "20", "missing reply keeps last value");
  assert.equal(tl.rpt.lists.acl.src, "cache"); assert.equal(tl.cache.last.items, 4); assert.equal(tl.cache.settings.int_h, 12); assert.equal(tl.cache.pending, true);
  // older firmware never receives CFGSNAP (it would go to the repeater CLI)
  await ingest({ type: "status", fw: "tsim-updater 1.6.9" });
  let cl3 = await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text(); assert(!cl3.includes("CFGSNAP"));
  assert.equal((await P("cache-settings", { en: false })).status, 409);
  await ingest({ type: "status", fw: "tsim-updater 1.7.0" });
  cl3 = await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text(); assert(cl3.includes("CFGSNAP en=1 int=12"));
  const ph4 = await (await call("/d/tsim-1", { headers: { Cookie: c } })).text(); assert(ph4.includes('id="cacheon"')); for (const m of ph4.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
  await P("commands", { cancel: true }); await ingest({ type: "status", fw: "tsim-updater 1.6.8" });
  console.log("v1.7.0 cache / telemetry / ACL tests OK");
  // ---------- serial.ondemand ----------
  assert.deepEqual(parseSettingReply("get serial.ondemand", "  -> > on"), { key: "serial.ondemand", op: "get", value: "on" });
  assert.equal(parseSettingReply("get serial.ondemand", "  -> ??: serial.ondemand").unsupported, true, "stock get = not supported");
  assert.equal(parseSettingReply("set serial.ondemand on", "  -> unknown config: serial.ondemand on").unsupported, true, "stock set = not supported");
  assert.equal(parseSettingReply("set serial.ondemand off", "  -> OK - serial.ondemand off (stock powersaving)").ok, true);
  assert.equal(psBlocks({ heltec_powersaving: true }), true); assert.equal(psBlocks({ heltec_powersaving: true, serial_ondemand: true }), false); assert.equal(psBlocks({ heltec_powersaving: false }), false);
  { const sx = JSON.parse(kv.get("state:tsim-1")); sx.heltec_powersaving = true; kv.set("state:tsim-1", JSON.stringify(sx)); }
  tl = await TEL(); assert.equal(tl.powersaving.blocks, true);
  assert.equal((await P("rpt-ops", { ops: [{ op: "read", what: "acl" }] })).status, 409, "stock power saving blocks the console");
  await ingest({ type: "cfgsnap", part: 0, items: [["get serial.ondemand", "  -> > on"]], final: true, count: 1 });
  tl = await TEL(); assert.equal(tl.rpt.vals["serial.ondemand"].value, "on"); assert.equal(tl.powersaving.on, true); assert.equal(tl.powersaving.ondemand, true); assert.equal(tl.powersaving.blocks, false);
  r = await P("rpt-ops", { ops: [{ op: "read", what: "acl" }] }); assert.equal(r.status, 200, "serial on demand: console allowed during power saving");
  fl = (await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text()).trim().split("\n").map((l) => l.split("\t"));
  const aclRow = fl.find((x) => x[1] === "get acl"); assert(aclRow);
  await ingest({ type: "cmd", cmd_id: aclRow[0], cmd: "get acl", output: "ACL:\n03 " + "AB".repeat(32) });
  assert.equal(JSON.parse(kv.get("state:tsim-1")).heltec_powersaving, true, "a reply doesn't mean power saving is off when serial on demand is on");
  await ingest({ type: "cfgsnap", part: 0, items: [["get serial.ondemand", "  -> ??: serial.ondemand"]], final: true, count: 1 });
  tl = await TEL(); assert.equal(tl.rpt.vals["serial.ondemand"].unsupported, true); assert.equal(tl.powersaving.blocks, true, "stock firmware again: blocked");
  { const sx = JSON.parse(kv.get("state:tsim-1")); sx.heltec_powersaving = false; kv.set("state:tsim-1", JSON.stringify(sx)); }
  await P("commands", { cancel: true });
  const ph5 = await (await call("/d/tsim-1", { headers: { Cookie: c } })).text(); assert(ph5.includes("serial.ondemand")); for (const m of ph5.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
  assert.equal(pickAsset(["Heltec_v3_repeater-v1.18.0-serial-81dbae59-merged.bin", "Heltec_v3_repeater-v1.18.0-serial-81dbae59.bin", "Heltec_v3_room_server-v1.18.0-serial-81dbae59.bin"], FW_PRESETS.meshcore_serial.asset_pattern), undefined, "builds without power saving (vX.Y.Z-serial) are not picked by the default");
  assert.equal(pickAsset(["Heltec_v3_repeater_headless-v1.18.0-powersaving-serial-8ba35c2d.bin", "Heltec_v3_repeater-v1.18.0-powersaving-serial-8ba35c2d-merged.bin", "Heltec_v3_repeater-v1.18.0-powersaving-serial-8ba35c2d.bin"], FW_PRESETS.meshcore_serial.asset_pattern), "Heltec_v3_repeater-v1.18.0-powersaving-serial-8ba35c2d.bin", "powersaving-serial naming: app-only, not headless, not merged");
  // default source + migration of the old EasySkyMesh default
{
  const { migrateSource, latestRelease, FW_PRESETS: FP } = await import("../src/index.js");
  const NEW = { repo: "just-stuff-tm/MeshCore", asset_pattern: "Heltec_v3_repeater-v*-powersaving-serial-*.bin" };
  let m = migrateSource(null); assert.equal(m.src.repo, NEW.repo); assert.equal(m.src.asset_pattern, NEW.asset_pattern); assert(!m.migrated && !m.stale, "no stored source: new default, nothing written");
  m = migrateSource({ enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", tag_prefix: "", direct_url: "" });
  assert(m.migrated && m.src.repo === NEW.repo && m.src.v === 2, "untouched old default migrates");
  m = migrateSource({ enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin" });
  assert(m.migrated, "old default missing optional fields still counts as untouched");
  m = migrateSource({ enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-PowerSaving17*-upgrade.bin", tag_prefix: "", direct_url: "" });
  assert(!m.migrated && m.src.repo === "IoTThinks/EasySkyMesh" && m.src.asset_pattern.includes("PowerSaving17") && m.src.v === 2, "customized pattern kept");
  m = migrateSource({ enabled: false, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", tag_prefix: "", direct_url: "https://x/y.bin" });
  assert(!m.migrated && m.src.enabled === false && m.src.direct_url === "https://x/y.bin", "disabled / direct URL kept");
  m = migrateSource({ enabled: true, repo: "meshcore-dev/MeshCore", asset_pattern: "Heltec_v3_repeater-v*.bin", tag_prefix: "repeater-", direct_url: "" });
  assert(!m.migrated && m.src.repo === "meshcore-dev/MeshCore", "stock MeshCore choice kept");
  m = migrateSource({ enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", tag_prefix: "", direct_url: "", v: 2 });
  assert(!m.migrated && m.src.repo === "IoTThinks/EasySkyMesh", "EasySkyMesh picked again after the change is respected");
  // through the API: old default stored -> migrated once, logged, release cache cleared, persisted with v2
  kv.set("source:tsim-1", JSON.stringify({ enabled: true, repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin", tag_prefix: "", direct_url: "" }));
  kv.set("release:tsim-1", JSON.stringify({ tag: "PowerSaving17.2" }));
  let s = await (await call("/api/d/tsim-1/source", { headers: { Cookie: c } })).json();
  assert.equal(s.repo, NEW.repo); assert.equal(s.asset_pattern, NEW.asset_pattern);
  assert.equal(JSON.parse(kv.get("source:tsim-1")).v, 2); assert.equal(kv.get("release:tsim-1"), undefined);
  s = await (await call("/api/d/tsim-1/source", { headers: { Cookie: c } })).json(); assert.equal(s.repo, NEW.repo, "stable after migration");
  // saving EasySkyMesh again sticks
  let r2 = await P("source", { repo: "IoTThinks/EasySkyMesh", asset_pattern: "Heltec_v3_repeater-*-upgrade.bin" });
  assert.equal(r2.status, 200); s = await (await call("/api/d/tsim-1/source", { headers: { Cookie: c } })).json(); assert.equal(s.repo, "IoTThinks/EasySkyMesh", "explicit EasySkyMesh choice is kept");
  // default preset first, alternatives still offered
  assert.deepEqual(Object.keys(FP), ["meshcore_serial", "easyskymesh", "meshcore"]); assert(FP.meshcore_serial.default);
  assert.equal(FP.meshcore_serial.asset_pattern, NEW.asset_pattern);
  // new default resolves to the app-only repeater image, never merged or headless
  const rel = await latestRelease({}, { enabled: true, ...NEW, tag_prefix: "", direct_url: "" });
  assert.equal(rel.tag, "v1.18.0-powersaving-serial"); assert.equal(rel.asset_name, "Heltec_v3_repeater-v1.18.0-powersaving-serial-8ba35c2d.bin");
  assert(!/merged|headless/.test(rel.url));
  console.log("default source / migration tests OK");
}
console.log("serial.ondemand tests OK");
  await P("settings", { console_enabled: false });
}

// ---- firmware upload + backup / restore ----
{
  const m = await import("../src/index.js");
  const mkApp = (n = 8192, chip = 9) => { const b = new Uint8Array(n); b[0] = 0xE9; b[1] = 5; b[12] = chip; for (let i = 24; i < n; i++) b[i] = (i * 7) & 0xff; return b; };
  const mkMerged = () => { const b = new Uint8Array(0x20000).fill(0xFF); b[0] = 0xE9; b[1] = 3; b[12] = 9; b[0x8000] = 0xAA; b[0x8001] = 0x50; b.set(mkApp(0x10000), 0x10000); return b; };
  let a = m.analyzeFirmware(mkApp(), "Heltec_v3_repeater-v1.18.0.bin"); assert.equal(a.kind, "app"); assert.equal(a.merged, false); assert.equal(a.chip, "ESP32-S3");
  a = m.analyzeFirmware(mkMerged(), "x.bin"); assert.equal(a.kind, "merged"); assert(a.merged && a.warnings.length, "content-merged flagged even without -merged name");
  a = m.analyzeFirmware(mkApp(), "Heltec_v3_repeater-v1.18.0-merged.bin"); assert.equal(a.kind, "app"); assert(a.merged, "name says merged: treated as full erase");
  assert.throws(() => m.analyzeFirmware(new Uint8Array(8192), "a.bin"), /0xE9/);
  assert.throws(() => m.analyzeFirmware(mkApp(8192, 0), "a.bin"), /ESP32-S3/);
  assert.throws(() => m.analyzeFirmware(mkApp(100), "a.bin"), /too small/);
  assert.throws(() => m.analyzeFirmware(mkApp(m.FW_APP_SLOT + 16), "a.bin"), /app partition/);
  assert.doesNotThrow(() => m.analyzeFirmware(mkApp(m.FW_APP_SLOT), "a.bin"));
  assert.equal(m.safeFwName("C:\\fakepath\\Heltec v3 (1).bin"), "Heltec_v3_1_.bin");
  assert.notEqual(m.uploadImageRisk({ asset_name: "a.bin", size: 2e6 }, "tsim-updater 1.6.1"), null); assert.equal(m.uploadImageRisk({ asset_name: "a.bin", size: 2e6 }, "tsim-updater 1.7.0"), null);

  const dev = JSON.parse(kv.get("device:tsim-1"));
  const c = (await login("tsim-1", "device-one-password", "7.7.7.7")).headers.get("Set-Cookie").split(";")[0];
  const P = (a2, b) => call("/api/d/tsim-1/" + a2, { method: "POST", headers: { Cookie: c, "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
  const UP = (bytes, name) => call("/api/d/tsim-1/fw-upload", { method: "POST", headers: { Cookie: c, "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) }, body: bytes });
  const TEL = async () => (await (await call("/api/d/tsim-1/telemetry", { headers: { Cookie: c } })).json());
  const ingest = (b) => call("/ingest/tsim-1", { method: "POST", headers: { "X-Device-Key": dev.ingest_key }, body: JSON.stringify(b) });
  const unthrottle = () => { const s = JSON.parse(kv.get("state:tsim-1") || "{}"); delete s.last_send_ts; delete s.last_update_sent; kv.set("state:tsim-1", JSON.stringify(s)); const x = JSON.parse(kv.get("sent:tsim-1") || "{}"); delete x.last_send_ts; delete x.last_update_sent; kv.set("sent:tsim-1", JSON.stringify(x)); };
  await ingest({ type: "status", fw: "tsim-updater 1.7.0", msg: "STATUS" });
  const holo0 = holo;
  assert.equal((await call("/api/d/tsim-1/fw-upload", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: mkApp() })).status, 401, "upload needs login");
  assert.equal((await call("/api/d/tsim-1/fw-upload", { method: "POST", headers: { Cookie: c, Origin: "https://evil.example" }, body: mkApp() })).status, 403, "cross-origin upload refused");
  let r = await UP(new Uint8Array(8192), "bad.bin"); assert.equal(r.status, 400); assert.match((await r.json()).error, /0xE9/);
  const app = mkApp(20000);
  r = await UP(app, "Heltec_v3_repeater-v1.18.1-powersaving-serial-abc.bin"); assert.equal(r.status, 201); const it = (await r.json()).item;
  const want = [...new Uint8Array(await crypto.subtle.digest("SHA-256", app))].map((x) => x.toString(16).padStart(2, "0")).join("");
  assert.equal(it.sha256, want); assert.equal(it.size, 20000); assert.equal(it.kind, "app"); assert.match(it.url, /^https:\/\/w\/fw\/[0-9a-f]{32}$/); assert(!it.url.includes("_"));
  r = await UP(app, "again.bin"); assert.equal(r.status, 200); assert.equal((await r.json()).duplicate, true, "same file is not stored twice");
  r = await call(new URL(it.url).pathname); assert.equal(r.status, 200); assert.equal(r.headers.get("Content-Length"), "20000"); assert.equal(r.headers.get("Content-Type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), app);
  r = await call(new URL(it.url).pathname, { headers: { Range: "bytes=0-15" } }); assert.equal(r.status, 206); assert.equal(r.headers.get("Content-Range"), "bytes 0-15/20000"); assert.equal((await r.arrayBuffer()).byteLength, 16);
  r = await call(new URL(it.url).pathname, { headers: { Range: "bytes=-4" } }); assert.equal(r.status, 206); assert.equal(r.headers.get("Content-Range"), "bytes 19996-19999/20000");
  r = await call(new URL(it.url).pathname, { headers: { Range: "bytes=30000-" } }); assert.equal(r.status, 416);
  r = await call(new URL(it.url).pathname, { method: "HEAD" }); assert.equal(r.status, 200); assert.equal(r.headers.get("Content-Length"), "20000");
  assert.equal((await call("/fw/" + "0".repeat(32))).status, 404); assert.equal((await call("/fw/nope")).status, 404);
  let tl = await TEL(); assert.equal(tl.fwup.items.length, 1); assert.equal(tl.fwup.target_merged, false);
  r = await P("source", { upload: it.token }); assert.equal(r.status, 200); assert.equal(holo, holo0, "selecting a file sends nothing");
  tl = await TEL(); assert.equal(tl.fwup.selected, it.token); assert.equal(tl.source.upload, it.token);
  r = await P("check"); assert.equal(r.status, 200); assert.equal((await r.json()).latest_available.via, "upload");
  unthrottle(); kv.set("state:tsim-1", JSON.stringify({ ...JSON.parse(kv.get("state:tsim-1") || "{}"), heltec_powersaving: false }));
  r = await P("update-latest"); let j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(j.sent, true); assert.equal(holo, holo0 + 1);
  assert.equal(j.body, `UPDATE ${it.url} `); assert(j.body.length <= 160);
  assert.equal(JSON.parse(kv.get("sent:tsim-1")).last_update_sent.via, "upload");
  await ingest({ type: "update", msg: `SUCCESS: ${it.url} | chip=ESP32-S3 image=app-only addr=0x10000 size=20000 written=20000 verify=OK md5=x` });
  assert.equal(JSON.parse(kv.get("state:tsim-1")).radio_flashed.file, it.name);
  assert.equal((await P("fw-delete", { token: it.token })).status, 200);
  assert.equal(kv.get("fwblob:" + it.token), undefined); tl = await TEL(); assert.equal(tl.source.upload, undefined, "deleting the selected file falls back to the release source"); assert.equal(tl.fwup.items.length, 0);
  r = await UP(mkMerged(), "Heltec_v3_repeater-v1.18.0-merged.bin"); assert.equal(r.status, 201); const mg = (await r.json()).item; assert(mg.merged);
  assert.equal((await P("source", { upload: mg.token })).status, 409, "merged needs acknowledgement");
  assert.equal((await P("source", { upload: mg.token, merged_ack: true })).status, 200);
  tl = await TEL(); assert.equal(tl.fwup.target_merged, true);
  unthrottle(); const h1 = holo;
  r = await P("update-latest"); j = await r.json(); assert.equal(r.status, 409); assert(j.needs_erase_confirm); assert.equal(holo, h1, "no text without ERASE");
  r = await P("update-latest", { erase_ok: true, typed: "erase " }); j = await r.json(); assert.equal(j.sent, true); assert.match(JSON.parse(kv.get("sent:tsim-1")).log[0].msg, /FULL ERASE/);
  await P("fw-delete", { token: mg.token });
  for (let i = 0; i < 3; i++) assert.equal((await UP(mkApp(9000 + i), `f${i}.bin`)).status, 201);
  assert.equal((await UP(mkApp(9100), "f4.bin")).status, 409, "max 3 per device");
  for (const x of (await TEL()).fwup.items) await P("fw-delete", { token: x.token });
  await P("source", { upload: "" });
  const pg = await (await call("/d/tsim-1", { headers: { Cookie: c } })).text();
  assert(pg.includes('id="upfile"') && pg.includes('id="mwarn"') && pg.includes('id="bkbox"') && pg.includes("ERASE"));
  for (const mm of pg.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(mm[1]);
  console.log("firmware upload tests OK");

  // ---------- backup / restore ----------
  await P("settings", { console_enabled: true }); unthrottle();
  kv.set("cmds:tsim-1", "[]");
  const KEY = "ab".repeat(64), PUB = "CD".repeat(32);
  kv.set("rptcfg:tsim-1", JSON.stringify({ name: { value: "Hilltop" }, tx: { value: "22" }, radio: { value: "910.525,250,10,5" }, "guest.password": { value: "guestpw" }, "public.key": { value: PUB }, repeat: { value: "on" }, ver: { value: "v1.18.0" } }));
  kv.set("rptlist:tsim-1", JSON.stringify({ regions: { raw: "*  F\n#USA F\n  #PA^ F" }, home: { raw: "#PA" }, default: { raw: "<null>" }, acl: { raw: "03 " + "F".repeat(64) + "\n01 " + "E".repeat(64) } }));
  r = await P("backup-create", { include_key: true }); j = await r.json(); assert.equal(r.status, 200);
  assert.equal(j.backup.identity.private_key, null, "no key stored yet"); assert.equal(j.backup.repeater.settings.name.value, "Hilltop");
  const bs = JSON.stringify(j.backup); assert(!bs.includes(dev.ingest_key) && !bs.includes("admintok") && !bs.includes("pbkdf2") && !bs.includes("sess-secret") && !bs.includes("1234567"), "no secrets / device credentials in backups");
  assert.equal(j.backup.repeater.regions.length, 3); assert.equal(j.backup.repeater.acl.length, 2); assert(j.backup.sensitive.passwords.includes("guest.password"));
  assert.equal((await P("prvkey-read", {})).status, 400);
  const hk = holo; r = await P("prvkey-read", { confirm: true }); assert.equal(r.status, 200); assert.equal(holo, hk + 1);
  let fl = (await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text()).trim().split("\n").map((l) => l.split("\t"));
  assert.deepEqual(fl.map((x) => x[1]), ["get prv.key"]);
  await ingest({ type: "cmd", cmd_id: fl[0][0], cmd: "get prv.key", output: "  -> " + KEY });
  assert.equal(JSON.parse(kv.get("prvkey:tsim-1")).key, KEY);
  assert(!kv.get("cmds:tsim-1").includes(KEY) && !kv.get("telem:tsim-1:history").includes(KEY) && !(kv.get("rptlist:tsim-1") || "").includes(KEY), "key never left in history");
  tl = await TEL(); assert(!JSON.stringify(tl).includes(KEY), "telemetry never carries the key"); assert(tl.backup.prvkey.hint.startsWith("abab"));
  r = await P("backup-create", { include_key: true }); j = await r.json(); const full = j.backup; assert.equal(full.identity.private_key, KEY); assert(full.sensitive.private_key); assert.match(j.item.file, /PRIVATE-KEY\.json$/);
  r = await P("backup-create", { include_key: false }); assert.equal((await r.json()).backup.identity.private_key, null);
  tl = await TEL(); assert.equal(tl.backup.items.length, 3); assert(!JSON.stringify(tl).includes(KEY));
  r = await call("/api/d/tsim-1/backup-get?bid=" + tl.backup.items[1].bid, { headers: { Cookie: c } }); assert.equal(r.status, 200); assert.match(r.headers.get("Content-Disposition"), /attachment; filename=".*PRIVATE-KEY\.json"/);
  assert.equal((await r.json()).identity.private_key, KEY);
  for (let i = 0; i < 4; i++) await P("backup-create", {});
  tl = await TEL(); assert.equal(tl.backup.items.length, 5, "keeps the last 5"); assert.equal([...kv.keys()].filter((k) => k.startsWith("backup:tsim-1:")).length, 5);
  assert.equal((await P("backup-delete", { bid: tl.backup.items[4].bid })).status, 200);
  kv.set("rptcfg:tsim-1", JSON.stringify({ name: { value: "NewName" }, tx: { value: "22" }, radio: { value: "915,250,11,5" }, "public.key": { value: "AA".repeat(32) } }));
  kv.set("rptlist:tsim-1", JSON.stringify({ regions: { raw: "*  F" }, acl: { raw: "" } }));
  assert.equal((await P("backup-preview", { backup: { format: "x" } })).status, 400);
  r = await P("backup-preview", { backup: full }); j = await r.json(); assert.equal(r.status, 200);
  const keys = j.plan.settings.map((x) => x.key); assert(keys.includes("name") && keys.includes("radio") && keys.includes("guest.password") && !keys.includes("tx"), keys.join());
  assert(!JSON.stringify(j).includes(KEY) && !JSON.stringify(j).includes("guestpw"), "preview hides key and passwords");
  assert(j.plan.regions.some((x) => x.cmd === "region put #USA") && j.plan.regions.some((x) => x.cmd === "region put #PA #USA") && j.plan.regions.some((x) => x.cmd === "region home #PA"));
  assert(j.plan.acl.some((x) => x.cmd === "setperm " + "F".repeat(64) + " 3" && x.risk)); assert.equal(j.plan.identity.same, false);
  const hr = holo;
  assert.equal((await P("restore-prepare", { backup: full, groups: { settings: true } })).status, 409, "radio change needs risk_ok");
  assert.equal((await P("restore-prepare", { backup: full, groups: { identity: true }, risk_ok: true })).status, 409, "identity needs typed IDENTITY");
  r = await P("restore-prepare", { backup: full, groups: { dashboard: true, settings: true, regions: true, acl: true, identity: true }, risk_ok: true, typed: "identity" }); j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(holo, hr, "prepare sends nothing"); assert(j.job.total > 0);
  const job = JSON.parse(kv.get("restore:tsim-1")); const cmdsAll = job.cmds.map((x) => x.cmd);
  assert.equal(cmdsAll[cmdsAll.length - 1], "reboot"); assert.equal(cmdsAll[cmdsAll.length - 2], `set prv.key ${KEY}`);
  assert(cmdsAll.indexOf("region save") > cmdsAll.indexOf("set name Hilltop"));
  const parts = m.nextRestorePart(Array.from({ length: 100 }, (_, i) => ({ cmd: "set name " + "x".repeat(20) + i })), 40, 40); assert.equal(parts.length, 40);
  const bigp = m.nextRestorePart(Array.from({ length: 60 }, () => ({ cmd: "x".repeat(150) })), 40, 40); assert(bigp.length < 40 && bigp.reduce((n, x) => n + x.cmd.length + 10, 0) <= 6000);
  assert.equal(m.nextRestorePart([{ cmd: "a" }, { cmd: "b" }], 40, 10).length, 2); assert.equal(m.nextRestorePart([{ cmd: "a" }], 0, 40).length, 0);
  unthrottle(); r = await P("restore-send", {}); j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(holo, hr + 1, "Send texts once"); assert.equal(j.remaining, 0);
  assert.equal(kv.get("restore:tsim-1"), undefined);
  tl = await TEL(); assert(!JSON.stringify(tl).includes(KEY), "queued restore never shows the key"); assert(tl.backup.restore_inflight > 0);
  fl = (await (await call("/api/dev/tsim-1/commands", { headers: { "X-Device-Key": dev.ingest_key } })).text()).trim().split("\n").map((l) => l.split("\t"));
  const pk = fl.find((x) => x[1].startsWith("set prv.key")); assert(pk, "the T-SIM receives the real command"); assert.equal(pk[1], `set prv.key ${KEY}`);
  for (const [bid, bc] of fl) await ingest({ type: "cmd", cmd_id: bid, cmd: bc, output: "  -> OK" });
  assert(!kv.get("cmds:tsim-1").includes(KEY) && !kv.get("telem:tsim-1:history").includes(KEY) && !kv.get("rptlist:tsim-1").includes(KEY), "set prv.key redacted after it ran");
  assert.equal(JSON.parse(kv.get("rptcfg:tsim-1")).name.value, "Hilltop", "restored setting recorded");
  await P("prvkey-forget", {}); assert.equal(kv.get("prvkey:tsim-1"), undefined);
  assert.equal((await P("restore-send", {})).status, 404);
  await P("settings", { console_enabled: false });
  console.log("backup / restore tests OK");
}

// ---- version compare across firmware families ----
{
  const m = await import("../src/index.js");
  const PSS = { tag: "v1.18.0-powersaving-serial", asset_name: "Heltec_v3_repeater-v1.18.0-powersaving-serial-12c42054.bin", checked_at: "2026-10-18T20:00:00Z" };
  assert.deepEqual(m.fwIdent("PowerSaving17.1.6"), { family: "easyskymesh", base: [1, 17, 1], ver: [17, 1, 6], commit: null });
  assert.deepEqual(m.fwIdent(PSS.asset_name), { family: "meshcore-powersaving-serial", base: [1, 18, 0], ver: [1, 18, 0], commit: "12c42054" });
  assert.equal(m.fwIdent("v1.18.0-81dbae5 (Build: 15-Oct-2026)").commit, "81dbae5"); assert.equal(m.fwIdent("v1.18.0-81dbae5 (Build: 15-Oct-2026)").family, "meshcore");
  assert.equal(m.fwIdent("Heltec_v3_repeater-PowerSaving17.1.6-upgrade.bin").family, "easyskymesh"); assert.equal(m.fwIdent("Heltec_v3_repeater-PowerSaving17.1.6-upgrade.bin").commit, null);
  // the reported bug: EasySkyMesh 17.1.6 running, MeshCore 1.18.0 powersaving-serial selected
  let u = m.updateStatus("PowerSaving17.1.6", PSS);
  assert.equal(u.state, "available"); assert.equal(u.reason, "Different firmware source"); assert.match(u.text, /different firmware source/i); assert.match(u.text, /EasySkyMesh/);
  u = m.radioStatus({ heltec_fw: "PowerSaving17.1.6", received_at: "2026-10-18T20:10:00Z" }, {}, PSS); assert.equal(u.state, "available"); assert.equal(u.reason, "Different firmware source");
  // after a flash of the old ESM file, the confirmed path must not say "Up to date" either
  u = m.radioStatus({ heltec_fw: "PowerSaving17.1.6", received_at: "2026-10-18T20:10:00Z" }, { radio_flashed: { at: "2026-10-18T19:00:00Z", file: "Heltec_v3_repeater-PowerSaving17.1.6-upgrade.bin" } }, PSS);
  assert.equal(u.state, "available"); assert(!/Up to date/.test(u.text));
  // stock MeshCore of the same base version is still a different source
  assert.equal(m.updateStatus("v1.18.0-81dbae5", PSS).reason, "Different firmware source");
  // same family, same version, different commit -> different build
  u = m.updateStatus("v1.18.0-powersaving-serial-8ba35c2d", PSS); assert.equal(u.state, "available"); assert.equal(u.reason, "Different build");
  // same family + same commit -> current; newer installed -> current
  assert.equal(m.updateStatus("v1.18.0-powersaving-serial-12c42054", PSS).state, "current");
  assert.equal(m.updateStatus("v1.18.1-powersaving-serial-aaaa111", PSS).state, "current");
  assert.equal(m.updateStatus("v1.17.1-powersaving-serial-aaaa111", PSS).reason, "Newer version");
  // EasySkyMesh vs EasySkyMesh still compares their own numbers
  assert.equal(m.updateStatus("PowerSaving 17.1.5", { tag: "PowerSaving17.1", asset_name: "Heltec_v3_repeater-PowerSaving17.1.6-upgrade.bin" }).state, "available");
  // progress "already running the target" never crosses families
  const st = { last_update_sent: { at: "2026-10-18T20:00:00Z", asset_name: PSS.asset_name, tag: PSS.tag }, radio_ver: "PowerSaving17.1.6", radio_ver_at: "2026-10-18T20:05:00Z" };
  assert.notEqual(m.computeProgress("heltec", [], st, Date.parse("2026-10-18T20:06:00Z")).state, "done", "ESM 17.1.6 is not >= MeshCore 1.18.0");
  st.radio_ver = "v1.18.0-powersaving-serial-12c42054";
  assert.equal(m.computeProgress("heltec", [], st, Date.parse("2026-10-18T20:06:00Z")).state, "done");
  console.log("firmware family compare tests OK");
}
