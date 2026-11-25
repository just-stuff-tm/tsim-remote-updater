// v1.8.1 tests: flash step explanation and SMS diagnostic fields. Run: node test/v181.mjs
import { explainFlash, parseFlashInfo, computeProgress, friendlyFail, smsDiagLine, smsDiagKeep, sanitizeTelemetry } from "../src/index.js";
import assert from "node:assert";

const BASE = "chip=ESP32-S3 image=app-only addr=0x10000 size=1206944";
const FAIL_RETRY_OK = "FAIL: flash https://example.invalid/fw/heltec.bin | " + BASE +
  " step=flash_start err=2(TIMEOUT) baud=460800 at=0; retry baud=115200: OK written=1206944 verify=OK";
const FAIL_RETRY_WRITE = "FAIL: flash https://example.invalid/fw/heltec.bin | " + BASE +
  " step=flash_start err=2(TIMEOUT) baud=460800 at=0; retry baud=115200: step=write err=2(TIMEOUT) at=65536";
const FAIL_CONNECT = "FAIL: flash https://example.invalid/a.bin | step=connect err=2(TIMEOUT) baud=115200 at=0";
const FAIL_VERIFY = "FAIL: flash https://example.invalid/a.bin | " + BASE +
  " written=1206944 verify=FAIL md5=abc baud=460800 step=verify err=4(INVALID_MD5) at=0";
const FAIL_OLD = "FAIL: flash https://example.invalid/a.bin | chip=ESP32-S3 image=merged addr=0x0 size=9 written=9 verify=FAIL md5=d";
const OK_CLEAN = "SUCCESS: https://example.invalid/fw/heltec.bin | " + BASE +
  " written=1206944 verify=OK md5=0123456789abcdef0123456789abcdef baud=460800";
const OK_RETRY = "SUCCESS: https://example.invalid/fw/heltec.bin | " + BASE +
  " step=flash_start err=2(TIMEOUT) baud=460800 at=0; retry baud=115200: OK written=1206944 verify=OK";

const exOk = explainFlash(FAIL_RETRY_OK);
assert.equal(exOk.text, "Flash failed at: start (erase) — timeout talking to the radio at 460800 baud. Retried at 115200: OK. The serial link was unreliable. That is often a low battery or the wiring.");
assert.equal(exOk.raw, FAIL_RETRY_OK);

const exW = explainFlash(FAIL_RETRY_WRITE);
assert.equal(exW.text, "Flash failed at: start (erase) — timeout talking to the radio at 460800 baud. Retried at 115200: failed at write — timeout talking to the radio at 115200 baud (byte 65,536). The serial link was unreliable. That is often a low battery or the wiring.");

const exC = explainFlash(FAIL_CONNECT);
assert.match(exC.text, /Flash failed at: connect — the radio did not enter download mode\./);
assert.match(exC.text, /Check the BOOT and RST wiring and that it has power\./);

const exV = explainFlash(FAIL_VERIFY);
assert.match(exV.text, /Flash failed at: verify — the data written does not match the file\./);

assert.equal(explainFlash(FAIL_OLD), null);
assert.equal(explainFlash(OK_CLEAN), null);
assert.match(explainFlash("step=flash_start err=5 baud=460800 at=0").text, /invalid param/);

// Older messages keep the generic reason. New fields are not required.
const fi = parseFlashInfo(OK_CLEAN);
assert.equal(fi.chip, "ESP32-S3");
assert.equal(fi.written, 1206944);
assert.equal(fi.verify, "OK");
assert.equal(fi.baud, undefined);

const now = Date.now();
const T = (m) => new Date(now - 60e3 * (10 - m)).toISOString();
const sent = { last_update_sent: { at: T(0), asset_name: "heltec.bin", tag: "direct" } };
const oldP = computeProgress("heltec", [{ type: "update", msg: FAIL_OLD, received_at: T(3) }], sent, now);
assert.equal(oldP.state, "failed");
assert.equal(oldP.reason, friendlyFail("FAIL: flash https://example.invalid/a.bin"));
assert.equal(oldP.flash_explain, undefined);
assert.equal(oldP.flash.verify, "FAIL");

const newP = computeProgress("heltec", [{ type: "update", msg: FAIL_RETRY_OK, received_at: T(4) },
  { type: "update", msg: "Flash retry at 115200 after step=flash_start err=2(TIMEOUT)", received_at: T(3) },
  { type: "update", msg: "Flashing: " + BASE, received_at: T(2) }], sent, now);
assert.equal(newP.state, "failed");
assert.equal(newP.reason, exOk.text);
assert.equal(newP.flash_explain.text, exOk.text);
assert.equal(newP.flash.chip, "ESP32-S3");
assert.equal(newP.flash.written, 1206944);

const okP = computeProgress("heltec", [{ type: "update", msg: OK_RETRY, received_at: T(4) },
  { type: "update", msg: "Flash retry at 115200 after step=flash_start err=1(FAIL)", received_at: T(3) }], sent, now);
assert.equal(okP.state, "done");
assert.equal(okP.reason, null);
assert.match(okP.flash_explain.text, /Retried at 115200: OK/);

const cleanP = computeProgress("heltec", [{ type: "update", msg: OK_CLEAN, received_at: T(3) }], sent, now);
assert.equal(cleanP.state, "done");
assert.equal(cleanP.reason, null);
assert.equal(cleanP.flash_explain, undefined);

const bare = explainFlash("FAIL: flash https://x | step=write err=9 at=0");
assert.match(bare.text, /invalid response/i);

const LINE = "Texts: store 1→2, read #3 sent 13:45:10 at 2.1 s, +CMTI at 9.8 s, wake=text";
const raw = { w: 2, st: [1, 2], tx: [[3, "26/11/15,13:45:10-20", 2100]], cm: [9800] };
assert.equal(smsDiagLine(raw), LINE);
const withTf = { ...raw, np: 5, tf: 1 };
assert.equal(smsDiagLine(withTf), "Texts: store 1→2, read #3 sent 13:45:10 at 2.1 s, +CMTI at 9.8 s, 5 passes, new text found, wake=text");
assert.equal(smsDiagLine({ ...raw, np: 2, tf: 0 }), "Texts: store 1→2, read #3 sent 13:45:10 at 2.1 s, +CMTI at 9.8 s, 2 passes, no new text, wake=text");
const kept = smsDiagKeep(withTf);
assert.equal(kept.np, 5);
assert.equal(kept.tf, 1);
assert.equal(smsDiagLine(kept), smsDiagLine(withTf));
assert.equal(smsDiagKeep(raw).np, undefined);

const long = "x".repeat(400);
const san = sanitizeTelemetry({ type: "update", msg: long, fw: "y".repeat(400) });
assert.equal(san.msg.length, 400);
assert.equal(san.fw.length, 300);

console.log("v1.8.1 worker tests OK (flash explanation, sms diag np/tf)");
