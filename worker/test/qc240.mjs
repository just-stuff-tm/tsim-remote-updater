// Quick local checks: 4 hours is still a valid choice (T-SIM 1.8.2 max; 1.8.3 adds longer). Run: node test/qc240.mjs
import { validateTcfg, tcfgCmd, dashboardPage } from "../src/index.js";
import assert from "node:assert";

assert.equal(validateTcfg({}, { qc: 240 }).qc, 240);
assert.equal(validateTcfg({}, { qc: 360 }).qc, 360, "6 hours is a valid choice; older firmware is refused at POST");
assert.match(tcfgCmd(validateTcfg({}, { qc: 240 })), /\bqc=240\b/);

const html = dashboardPage({ id: "tsim-1", name: "x" });
assert.ok(html.includes('option value="240"'), 'dashboard HTML contains option value="240"');
assert.ok(html.includes('<option value="240">4 hours</option>'));
assert.ok(html.includes("qcLabel"), "qc minutes map to labels including 4 hours");
assert.ok(html.includes("keepSel(f.qc,"), "saved qc not in the list still shows");

console.log("qc240 worker tests OK (quick checks 4 hours still valid)");
