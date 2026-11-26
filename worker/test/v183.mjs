// v1.8.3: quick local checks up to 2 days, fw-gated. Run: node test/v183.mjs
import worker, {
  validateTcfg, tcfgCmd, tcfgFromLegacy, dashboardPage, costEstimate, validatePower,
  powerIntMaxH, QC48_FW, TCFG_QC_CHOICES, TCFG_QC_MAX, TCFG_QC_LEGACY_MAX, tcfgQcOk, clampQc,
} from "../src/index.js";
import assert from "node:assert";

assert.equal(QC48_FW, "1.8.3");
assert.deepEqual(TCFG_QC_CHOICES, [0, 15, 30, 60, 120, 240, 360, 720, 1440, 2880]);
assert.equal(TCFG_QC_MAX, 2880);
assert.equal(TCFG_QC_LEGACY_MAX, 240);

assert.equal(validateTcfg({}, { qc: 2880 }).qc, 2880);
assert.match(tcfgCmd(validateTcfg({}, { qc: 2880 })), /\bqc=2880\b/);
assert.throws(() => validateTcfg({}, { qc: 2881 }));
assert.throws(() => validateTcfg({}, { qc: 241 }));
assert.equal(tcfgQcOk(2880), true);
assert.equal(tcfgQcOk(2881), false);
assert.equal(clampQc(4000), 2880);
assert.equal(clampQc(4000, 240), 240);

assert.equal(tcfgFromLegacy({ power: { lb_en: true, lb_int: 2880 }, wdcfg: { upoll: 0 } }).qc, 240, "legacy clamp stays 4 h for older devices");
assert.equal(tcfgFromLegacy({ power: { lb_en: true, lb_int: 2880 }, wdcfg: { upoll: 0 } }, { maxQc: 2880 }).qc, 2880);
assert.equal(tcfgFromLegacy({ wdcfg: { upoll: 1440 } }).qc, 240);
assert.equal(tcfgFromLegacy({ wdcfg: { upoll: 1440 } }, { maxQc: 2880 }).qc, 1440);

const c = costEstimate({ ci: 0, do: "", qc: 2880, q: "b" });
assert.equal(c.quick_wakes_day, 0.5, "qc 2880 is half a quick wake a day");
assert.equal(costEstimate({ ci: 360, do: "hc", qc: 30, q: "u" }).quick_wakes_day, 48);

assert.equal(powerIntMaxH("tsim-updater 1.8.3"), 48);
assert.equal(powerIntMaxH("tsim-updater 1.8.2"), 4);
assert.equal(powerIntMaxH("tsim-updater 1.8.0"), 4);
assert.equal(powerIntMaxH("tsim-updater 1.7.11"), 24);
assert.equal(powerIntMaxH(null), 24);
assert.equal(validatePower({}, { lb_int_h: 48 }, 3.9, "tsim-updater 1.8.3").lb_int, 2880);
assert.throws(() => validatePower({}, { lb_int_h: 49 }, 3.9, "tsim-updater 1.8.3"), /0\.25 and 48 hours/);
assert.equal(validatePower({}, { lb_int_h: 4 }, 3.9, "tsim-updater 1.8.2").lb_int, 240);
assert.throws(() => validatePower({}, { lb_int_h: 5 }, 3.9, "tsim-updater 1.8.2"), /0\.25 and 4 hours/);
assert.equal(validatePower({}, { lb_int_h: 24 }, 3.9, "tsim-updater 1.7.11").lb_int, 1440);
assert.throws(() => validatePower({}, { lb_int_h: 25 }, 3.9, "tsim-updater 1.7.11"), /0\.25 and 24 hours/);
assert.throws(() => validatePower({}, { lb_int: 2880 }, 3.9), /0\.25 and 24 hours/, "no fw -> 24 h");

const html = dashboardPage({ id: "tsim-1", name: "x" });
for (const [v, lab] of [["360", "6 hours"], ["720", "12 hours"], ["1440", "1 day"], ["2880", "2 days"]]) {
  assert.ok(html.includes(`option value="${v}"`), "dashboard has qc option " + v);
  assert.ok(html.includes(`${lab} (needs T-SIM 1.8.3)`), "disabled label for " + lab);
}
assert.ok(html.includes("360:\"6 hours\"") || html.includes('360:"6 hours"'), "qcLabel 6 hours");
assert.ok(html.includes("720:\"12 hours\"") || html.includes('720:"12 hours"'));
assert.ok(html.includes("1440:\"1 day\"") || html.includes('1440:"1 day"'));
assert.ok(html.includes("2880:\"2 days\"") || html.includes('2880:"2 days"'));
assert.ok(html.includes("o.disabled=!qc48"), "longer options disabled unless qc48");
assert.ok(html.includes("T-SIM 1.8.3 accepts up to 2 days (older T-SIM up to 4 hours)"));
assert.ok(html.includes("LBMAXH"), "battery interval max follows firmware");

const kv = new Map();
const STATE = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
const env = { STATE, HOLOGRAM_API_KEY: "k", ADMIN_TOKEN: "admintok", SESSION_SECRET: "sess-secret-for-tests" };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("hologram")) return new Response(JSON.stringify({ success: true }));
  if (url.includes("api.github.com")) return new Response(JSON.stringify({ tag_name: "v1.8.3", assets: [] }));
  throw new Error("unexpected fetch " + url);
};
const B = "https://w";
const call = (path, init = {}) => worker.fetch(new Request(B + path, init), env);
const admin = (path, method = "GET", body) => call(path, { method, headers: { Authorization: "Bearer admintok", "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
const J = (o) => JSON.parse(kv.get(o) || "null");

{
  let r = await admin("/admin/devices", "POST", { id: "v183-1", name: "QC48", hologram_device_id: "7654321", heltec_fw: "base" });
  assert.equal(r.status, 201); const dv = await r.json();
  const ingest = (o) => call("/ingest/v183-1", { method: "POST", headers: { "X-Device-Key": dv.ingest_key, "Content-Type": "application/json" }, body: JSON.stringify(o) });
  r = await call("/login", { method: "POST", headers: { "CF-Connecting-IP": "8.8.8.8", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ device: "v183-1", password: dv.password }) });
  const ck = r.headers.get("Set-Cookie").split(";")[0];
  const P = (a, body) => call("/api/d/v183-1/" + a, { method: "POST", headers: { Cookie: ck, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const TEL = async () => (await call("/api/d/v183-1/telemetry", { headers: { Cookie: ck } })).json();

  await ingest({ type: "status", fw: "tsim-updater 1.8.2", battery_v: 3.9, tcfg: { v: 1, ci: 360, do: "hc", cs: 0, qc: 30, q: "u", usol: 2000, gto: 180, safety: 1440 } });
  let tl = await TEL();
  assert.equal(tl.checkins.qc48, false);
  assert.equal(tl.checkins.v18, true);

  r = await P("checkin-settings", { qc: 360, q: "u" });
  let j = await r.json();
  assert.equal(r.status, 409, JSON.stringify(j));
  assert.match(j.error, /Quick checks longer than 4 hours need T-SIM firmware 1\.8\.3 or newer/);

  r = await P("checkin-settings", { qc: 2880, q: "b" });
  j = await r.json();
  assert.equal(r.status, 409);

  r = await P("power", { lb_int_h: 5, lb_en: true, lb_lo: 3.4, lb_hi: 3.75 });
  j = await r.json();
  assert.equal(r.status, 400, JSON.stringify(j));
  assert.match(j.error, /0\.25 and 4 hours/);

  r = await P("power", { lb_int_h: 4, lb_en: true, lb_lo: 3.4, lb_hi: 3.75 });
  assert.equal(r.status, 200, await r.text().then((t) => t.slice(0, 200)));

  await ingest({ type: "status", fw: "tsim-updater 1.8.3", battery_v: 3.9, tcfg: { v: 1, ci: 360, do: "hc", cs: 0, qc: 30, q: "u", usol: 2000, gto: 180, safety: 1440 } });
  tl = await TEL();
  assert.equal(tl.checkins.qc48, true);

  r = await P("checkin-settings", { ci: 0, do: "", qc: 2880, q: "bu", cs: 0, usol: 2000, gto: 180 });
  j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.settings.qc, 2880);
  assert.equal(j.cost.quick_wakes_day, 0.5);
  assert.match(j.queued[0].cmd, /\bqc=2880\b/);

  r = await P("power", { lb_int_h: 48, lb_en: true, lb_lo: 3.4, lb_hi: 3.75 });
  j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.power.lb_int, 2880);
}

console.log("v1.8.3 worker tests OK (qc 2880, fw-gated options, battery interval, cost 0.5/day)");
