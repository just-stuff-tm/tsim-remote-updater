// v1.8.2 tests: every flash attempt is explained. Run: node test/v182.mjs
import { explainFlash, parseFlashInfo, computeProgress } from "../src/index.js";
import assert from "node:assert";

const BASE = "chip=ESP32-S3 image=app-only addr=0x10000 size=1206944";
const MD5 = "0123456789abcdef0123456789abcdef";
const TWO_OK = "SUCCESS: https://example.invalid/fw/heltec.bin | " + BASE +
  " step=flash_start err=2(TIMEOUT) baud=115200 at=0; retry baud=115200: step=flash_start err=2(TIMEOUT) at=0; retry baud=115200: OK written=1206944 verify=OK md5=" + MD5;
const TWO_FAIL = "FAIL: flash https://example.invalid/fw/heltec.bin | " + BASE +
  " step=flash_start err=2(TIMEOUT) baud=460800 at=0; retry baud=115200: step=write err=2(TIMEOUT) at=65536; retry baud=115200: step=verify err=4(INVALID_MD5) at=0";
const CONNECT_THEN = "FAIL: flash https://example.invalid/a.bin | step=connect err=2(TIMEOUT) baud=115200 at=0; retry baud=115200: step=connect err=2(TIMEOUT) at=0; retry baud=115200: OK written=1206944 verify=OK md5=" + MD5;

const exOk = explainFlash(TWO_OK);
assert.match(exOk.text, /Flash failed at: start \(erase\) — timeout talking to the radio at 115200 baud\./);
assert.match(exOk.text, /Retry 1 at 115200: failed at start \(erase\)/);
assert.match(exOk.text, /Retry 2 at 115200: OK\./);
assert.match(exOk.text, /The serial link was unreliable/);
assert.equal(exOk.raw, TWO_OK);

const exFail = explainFlash(TWO_FAIL);
assert.match(exFail.text, /Flash failed at: start \(erase\) — timeout talking to the radio at 460800 baud\./);
assert.match(exFail.text, /Retry 1 at 115200: failed at write — timeout talking to the radio at 115200 baud \(byte 65,536\)\./);
assert.match(exFail.text, /Retry 2 at 115200: failed at verify — the data written does not match the file\./);
assert.match(exFail.text, /The data written does not match the file\./);
assert.doesNotMatch(exFail.text, /serial link was unreliable/);

const exC = explainFlash(CONNECT_THEN);
assert.match(exC.text, /Flash failed at: connect/);
assert.match(exC.text, /Retry 1 at 115200: failed at connect/);
assert.match(exC.text, /Retry 2 at 115200: OK\./);
assert.match(exC.text, /Check the BOOT and RST wiring/);

const fi = parseFlashInfo(TWO_OK);
assert.equal(fi.chip, "ESP32-S3");
assert.equal(fi.image, "app-only");
assert.equal(fi.addr, "0x10000");
assert.equal(fi.size, 1206944);
assert.equal(fi.written, 1206944);
assert.equal(fi.verify, "OK");
assert.equal(fi.md5, MD5);

const pre = parseFlashInfo("Flashing: image=app-only addr=0x10000 size=1206944");
assert.equal(pre.chip, undefined);
assert.equal(pre.image, "app-only");
assert.equal(pre.size, 1206944);

const now = Date.now();
const T = (m) => new Date(now - 60e3 * (10 - m)).toISOString();
const sent = { last_update_sent: { at: T(0), asset_name: "heltec.bin", tag: "direct" } };
const prog = computeProgress("heltec", [
  { type: "update", msg: TWO_FAIL, received_at: T(4) },
  { type: "update", msg: "Flashing: image=app-only addr=0x10000 size=1206944", received_at: T(2) },
  { type: "update", msg: "Download done: 1206944 bytes, flashing", received_at: T(1) },
], sent, now);
assert.equal(prog.state, "failed");
assert.equal(prog.reason, exFail.text);
assert.equal(prog.flash.chip, "ESP32-S3");
assert.equal(prog.flash.image, "app-only");

const done = computeProgress("heltec", [
  { type: "update", msg: TWO_OK, received_at: T(4) },
  { type: "update", msg: "Flashing: image=app-only addr=0x10000 size=1206944", received_at: T(2) },
], sent, now);
assert.equal(done.state, "done");
assert.equal(done.reason, null);
assert.match(done.flash_explain.text, /Retry 2 at 115200: OK/);

// The posted result (short url + three attempts) stays inside the stored message cap.
const posted = "FAIL: flash " + "https://example.invalid/fw/heltec.bin".padEnd(100, "x") + " | " + BASE +
  " step=connect_stub err=9(INVALID_RESPONSE) baud=460800 at=16777216" +
  "; retry baud=115200: step=connect_stub err=9(INVALID_RESPONSE) at=16777216" +
  "; retry baud=115200: OK written=16777216 verify=OK md5=" + MD5;
assert.ok(posted.length <= 512, "posted length " + posted.length);

console.log("v1.8.2 worker tests OK (multi-attempt flash explanation)");
