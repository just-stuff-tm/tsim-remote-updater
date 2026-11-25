// Host test for firmware/src/hw_guard.h (v1.7.6). Run: g++ -std=c++17 -Wall -I../src host_test.cpp -o /tmp/ht && /tmp/ht
#include "hw_guard.h"
#include "lp_power.h"
#include "tsim_frame.h"
#include "wake_path.h"
#include "sms_diag.h"
#include "sms_queue.h"
#include "tcfg.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#define HW_DEBOUNCE_S 60

int main() {
  // 1) Last night's sequence: REBOOT (heltecReboot) at t, boot banner + Repeater ID 0.3-2 s later, serviced ~6 s later.
  HmState st = {false, 0, {false, 0}};
  uint32_t t = 146000;                      // uptime 146 s
  selfResetMark(st.self, t);
  assert(hmClassify(st, t + 300) == HM_SELF);   // "ESP-ROM:esp32s3..." -> the T-SIM's own reset
  assert(hmClassify(st, t + 350) == HM_SAME);   // "rst:0x1 (POWERON),boot:..."
  assert(hmClassify(st, t + 2000) == HM_SAME);  // "Repeater ID: ..."
  assert(!selfResetActive(st.self, t + 6000));  // consumed: no flag left for hwAwakeService
  // 2) ...independent of the RTC: even if the RTC stepped back by hours, the millis guard holds
  HmState st2 = {false, 0, {false, 0}};
  selfResetMark(st2.self, 5000);
  assert(hmClassify(st2, 5400) == HM_SELF);
  // 3) A real (unexpected) reboot later in the same wake is still detected
  assert(hmClassify(st, t + 60000) == HM_NEW);
  // 4) Banner read late from the UART buffer (T-SIM busy 2 min): still the own reset (window 5 min)
  HmState st3 = {true, 1000, {false, 0}};
  selfResetMark(st3.self, 30000);
  assert(hmClassify(st3, 30000 + 120000) == HM_SELF);
  // 5) No banner ever seen: the pending flag expires after SELF_RESET_MS, then reboots count again
  HmState st4 = {false, 0, {false, 0}};
  selfResetMark(st4.self, 1000);
  assert(selfResetActive(st4.self, 1000 + SELF_RESET_MS - 1));
  assert(!selfResetActive(st4.self, 1000 + SELF_RESET_MS));
  assert(hmClassify(st4, 1000 + SELF_RESET_MS + 5) == HM_NEW);
  // 6) millis() wrap
  HmState st5 = {false, 0, {false, 0}};
  selfResetMark(st5.self, 0xFFFFF000u);
  assert(hmClassify(st5, 0x00000800u) == HM_SELF);
  // 7) RTC window: normal, stepped back (old code failed here), stale, unset
  assert(rtcOwnWindow(2000000000LL, 2000000006LL, HW_DEBOUNCE_S));
  assert(rtcOwnWindow(2000000000LL, 1999999000LL, HW_DEBOUNCE_S));      // clock went back 1000 s -> still own
  { long long own = 2000000000LL, now = 1999999000LL; bool old = own > 0 && now >= own && now - own < HW_DEBOUNCE_S; assert(!old); }
  assert(!rtcOwnWindow(2000000000LL, 2000000061LL, HW_DEBOUNCE_S));
  assert(!rtcOwnWindow(2000000000LL, 1999000000LL, HW_DEBOUNCE_S));     // > 1 h back: not trusted as own
  assert(!rtcOwnWindow(0, 5, HW_DEBOUNCE_S));
  // 8) SMS merge: 4 STATUS + REBOOT + 2 CMD + UPDATE in one pass -> STATUS once, CMD once, REBOOT and UPDATE run
  const char *in[] = {"STATUS", "STATUS", "status", "REBOOT", "STATUS", "CMD", "CMD", "UPDATE https://x/y.bin", "REBOOT"};
  const char *seen[10]; int ns = 0, ran = 0, merged = 0, reboots = 0;
  for (const char *n : in) {
    if (smsIsDup(seen, ns, n)) { merged++; continue; }
    if (smsMergeable(n)) seen[ns++] = n;
    ran++; if (!strcasecmp(n, "REBOOT")) reboots++;
  }
  assert(merged == 4); assert(ran == 5); assert(reboots == 2);   // REBOOT is never merged
  assert(!smsMergeable("UPDATE https://x")); assert(!smsMergeable("")); assert(!smsMergeable(nullptr));
  // 9) tsim wake frames
  TsimFrame fr;
  assert(tsimParseLine("@TSIM STATUS 4711", &fr) == TF_CMD);
  assert(fr.seq == 4711 && !strcmp(fr.cmd, "STATUS"));
  assert(tsimParseLine("  @TSIM status 12", &fr) == TF_CMD);
  assert(fr.seq == 12 && !strcmp(fr.cmd, "STATUS"));
  assert(tsimParseLine("@TSIM MODEM_RESET 9", &fr) == TF_CMD);
  assert(!strcmp(fr.cmd, "MODEM_RESET") && fr.seq == 9);
  assert(tsimParseLine("@TSIM wake 1", &fr) == TF_CMD && !strcmp(fr.cmd, "WAKE"));
  assert(tsimParseLine("@TSIM ACK 4711", &fr) == TF_IGNORE);
  assert(tsimParseLine("@TSIM ACK", &fr) == TF_IGNORE);
  assert(tsimParseLine("@TSIM NOPE 3", &fr) == TF_REJECT);
  assert(tsimParseLine("@TSIM WAKE", &fr) == TF_REJECT);
  assert(tsimParseLine("@TSIM WAKE 0", &fr) == TF_REJECT);
  assert(tsimParseLine("@TSIM TOOLONGCOMMANDNAME 4", &fr) == TF_REJECT);
  assert(tsimParseLine("Repeater ID: ab", &fr) == TF_NONE);
  assert(tsimParseLine(nullptr, &fr) == TF_NONE);
  // 10) v1.7.8: SMS ring (ext0, cause 2) uses the light wake. Power-on, GPIO6/ext1 and timer do not.
  assert(smsWakeUsesLight(2));
  assert(!smsWakeUsesLight(0));
  assert(!smsWakeUsesLight(3));
  assert(!smsWakeUsesLight(4));
  assert(SMS_LIGHT_AT_TRIES >= 3 && SMS_LIGHT_AT_TRIES <= 8);
  assert(SMS_LIGHT_REG_MS >= 5000u && SMS_LIGHT_REG_MS <= 20000u);
  // Light wake stands only when AT answered and the modem is still registered. Else full reset.
  assert(smsLightOk(true, true));
  assert(!smsLightOk(true, false));
  assert(!smsLightOk(false, true));
  assert(!smsLightOk(false, false));
  // STATUS keeps mesh snapshot, AT diagnostics and ?sys=1. CMD skips the first two.
  // ?sys=1 only when a system command is still pending.
  { WakeExtras st = wakeExtras(true, false); assert(st.mesh && st.diag && st.sys); }
  { WakeExtras st = wakeExtras(true, true); assert(st.mesh && st.diag && st.sys); }
  { WakeExtras cmd = wakeExtras(false, false); assert(!cmd.mesh && !cmd.diag && !cmd.sys); }
  { WakeExtras cmd = wakeExtras(false, true); assert(!cmd.mesh && !cmd.diag && cmd.sys); }
  printf("v1.7.8 host tests OK (self-reset guard, RTC step-back, SMS merge, tsim wake frames, light SMS wake, CMD vs STATUS)\n");

  // 11) v1.7.9: eDRX/PSM command strings, timer encoding, WDCFG tokens, read-back classification.
  char enc[9];
  assert(lpTimerEncode(1, 1, enc) && !strcmp(enc, "00100001"));
  assert(lpTimerEncode(1, 2, enc) && !strcmp(enc, "00100010"));
  assert(!strcmp(LP_PSM_TAU, "00100001") && !strcmp(LP_PSM_ACT, "00100010"));
  assert(!lpTimerEncode(8, 1, enc) && !lpTimerEncode(1, 32, enc));
  char cmd[64];
  assert(lpCedrxsCmd(cmd, sizeof(cmd), 1, "0010") > 0 && !strcmp(cmd, "AT+CEDRXS=1,4,\"0010\""));
  assert(lpCedrxsCmd(cmd, sizeof(cmd), 0, "0010") > 0 && !strcmp(cmd, "AT+CEDRXS=0"));
  assert(lpCedrxsCmd(cmd, sizeof(cmd), 1, "0110") < 0);   // past 81.92 s: rejected
  assert(lpCedrxsCmd(cmd, sizeof(cmd), 1, "0010") > 0 && !strstr(cmd, "=2") && !strstr(cmd, "=3"));
  assert(lpCpsmsCmd(cmd, sizeof(cmd), 1) > 0 && !strcmp(cmd, "AT+CPSMS=1,,,\"00100001\",\"00100010\""));
  assert(lpCpsmsCmd(cmd, sizeof(cmd), 0) > 0 && !strcmp(cmd, "AT+CPSMS=0"));
  assert(!strstr(cmd, "=2"));
  LpCfg cfg; lpCfgInit(&cfg);
  assert(cfg.edrx == 0 && cfg.psm == 0 && !strcmp(cfg.edrxv, "0010"));
  assert(lpCfgToken(&cfg, "edrx", "1") == 1 && cfg.edrx == 1);
  assert(lpCfgToken(&cfg, "edrx", "2") < 0);
  assert(lpCfgToken(&cfg, "edrxv", "0101") == 1 && !strcmp(cfg.edrxv, "0101"));
  assert(lpCfgToken(&cfg, "edrxv", "0110") < 0 && !strcmp(cfg.edrxv, "0101"));
  assert(lpCfgToken(&cfg, "edrxv", "001") < 0);
  assert(lpCfgToken(&cfg, "psm", "0") == 1 && cfg.psm == 0);
  assert(lpCfgToken(&cfg, "psm", "1") == 1 && cfg.psm == 1);
  assert(lpCfgToken(&cfg, "int", "180") == 0 && cfg.psm == 1);   // not a low-power key
  char frag[40];
  assert(lpAppliedFragment(frag, sizeof(frag), 1, "0101", 0) > 0 && !strcmp(frag, "edrx=1 edrxv=0101 psm=0"));
  assert(lpAppliedFragment(frag, sizeof(frag), 0, "0110", 1) > 0 && !strcmp(frag, "edrx=0 edrxv=0010 psm=1"));
  LpEdrxRd er;
  assert(lpParseCedrxrdp("+CEDRXRDP: 4,\"0010\",\"0010\",\"0001\"\r\nOK\r\n", &er) && er.act == 4 && !strcmp(er.req, "0010") && !strcmp(er.nw, "0010"));
  assert(lpParseCedrxrdp("+CEDRXRDP: 0\r\nOK\r\n", &er) && er.act == 0 && !er.nw[0]);
  assert(lpParseCedrxrdp("+CEDRXRDP: 4,\"\",\"\",\"\"\r\nOK\r\n", &er) && er.act == 4 && !er.nw[0]);
  assert(!lpParseCedrxrdp("ERROR\r\n", &er));
  LpPsmRd pr;
  assert(lpParseCpsms("+CPSMS: 1,,,\"00100001\",\"00100010\"\r\nOK\r\n", &pr) && pr.mode == 1 && !strcmp(pr.tau, "00100001") && !strcmp(pr.actt, "00100010") && pr.grant_known == 0);
  assert(lpParseCpsms("+CPSMS: 0\r\nOK\r\n", &pr) && pr.mode == 0 && !pr.tau[0]);
  assert(!lpParseCpsms("ERROR\r\n", &pr));
  LpTel tel;
  strcpy(er.req, "0010"); strcpy(er.nw, "0100"); er.act = 4;
  strcpy(pr.tau, "00100001"); strcpy(pr.actt, "00100010");
  lpClassify(1, "0010", &er, 1, 1, &pr, 1, &tel);
  assert(!strcmp(tel.edrx_req, "0010") && !strcmp(tel.edrx_nw, "0100"));
  assert(!strcmp(tel.psm_tau, "00100001") && !strcmp(tel.psm_act, "00100010") && tel.psm_grant_known == 0);
  er.act = 0; er.nw[0] = 0;
  lpClassify(1, "0010", &er, 1, 1, &pr, 0, &tel);
  assert(!strcmp(tel.edrx_nw, "rej") && !strcmp(tel.psm_tau, "rej") && !strcmp(tel.psm_act, "rej"));
  assert(!strcmp(tel.edrx_req, "0010"));
  lpClassify(0, "0010", &er, 0, 0, &pr, 0, &tel);
  assert(!strcmp(tel.edrx_nw, "none") && !strcmp(tel.edrx_req, "0010"));
  er.act = 4; er.nw[0] = 0; er.req[0] = 0; pr.tau[0] = 0; pr.actt[0] = 0;
  lpClassify(0, "0010", &er, 1, 0, &pr, 1, &tel);
  assert(!strcmp(tel.edrx_nw, "none") && !strcmp(tel.psm_tau, "none") && !strcmp(tel.psm_act, "none"));
  assert(!strcmp(lpJsonTok("00100001", "none"), "00100001"));
  assert(!strcmp(lpJsonTok("<script>", "none"), "none"));
  assert(!strcmp(lpJsonTok("001000011", "none"), "none"));
  // STATUS that already posted its report skips the second AT pass. CMD still skips. wakeExtras is unchanged.
  assert(!wakeRunPostDiag(true, true));
  assert(wakeRunPostDiag(true, false));
  assert(!wakeRunPostDiag(false, false));
  assert(!wakeRunPostDiag(false, true));
  { WakeExtras st = wakeExtras(true, false); assert(st.mesh && st.diag && st.sys); }
  assert(smsCatchupBeforeSleep(true, false, false));
  assert(!smsCatchupBeforeSleep(false, false, false));
  assert(!smsCatchupBeforeSleep(true, true, false));
  assert(!smsCatchupBeforeSleep(true, false, true));
  printf("v1.7.9 host tests OK (eDRX/PSM commands, WDCFG tokens, CEDRXRDP/CPSMS parse, awake-path)\n");

  // 12) v1.7.9: scheduled mesh skip, CFGSNAP upload policy, STATUS AUTO merge.
  assert(statusIsScheduled("STATUS AUTO") && statusIsScheduled("status auto"));
  assert(!statusIsScheduled("STATUS") && !statusIsScheduled("STATUS AUTO ACK") && !statusIsScheduled(nullptr));
  assert(statusFetchesMesh(false, 0) && statusFetchesMesh(false, 1));
  assert(statusFetchesMesh(true, 1) && statusFetchesMesh(true, 2));
  assert(!statusFetchesMesh(true, 0));
  assert(cfgsnapShouldUpload(true, false, false));
  assert(cfgsnapShouldUpload(false, true, false));
  assert(cfgsnapShouldUpload(false, false, true));
  assert(!cfgsnapShouldUpload(false, false, false));
  assert(cfgsnapShouldCollect(true, false, true, false, false));
  assert(!cfgsnapShouldCollect(false, false, false, true, true));
  assert(!cfgsnapShouldCollect(false, true, true, true, false));
  assert(cfgsnapShouldCollect(false, true, false, true, false));
  assert(cfgsnapShouldCollect(false, true, false, false, true));
  assert(!cfgsnapShouldCollect(false, true, false, false, false));
  const uint32_t h0 = 2166136261u;
  assert(cfgsnapHash(cfgsnapHash(h0, "ab"), "c") != cfgsnapHash(cfgsnapHash(h0, "a"), "bc"));
  assert(cfgsnapHash(cfgsnapHash(h0, "get name"), "-> x") == cfgsnapHash(cfgsnapHash(h0, "get name"), "-> x"));
  assert(cfgsnapHash(cfgsnapHash(h0, "get name"), "-> x") != cfgsnapHash(cfgsnapHash(h0, "get name"), "-> y"));
  uint32_t o1 = cfgsnapHash(cfgsnapHash(h0, "get a"), "1");
  o1 = cfgsnapHash(cfgsnapHash(o1, "get b"), "2");
  uint32_t o2 = cfgsnapHash(cfgsnapHash(h0, "get b"), "2");
  o2 = cfgsnapHash(cfgsnapHash(o2, "get a"), "1");
  assert(o1 != o2);
  assert(smsMergeable("STATUS AUTO") && smsMergeable("status auto"));
  const char *seenSt[] = {"STATUS"};
  assert(!smsIsDup(seenSt, 1, "STATUS AUTO"));
  const char *seenAu[] = {"STATUS AUTO"};
  assert(smsIsDup(seenAu, 1, "status auto"));
  assert(!smsIsDup(seenAu, 1, "STATUS"));
  printf("v1.7.9 host tests OK (smesh, cfgsnap hash, STATUS AUTO)\n");

  // 13) v1.7.10: SMS late window. Extra wait is capped at 20 s and is 0 once past 22 s.
  assert(SMS_LATE_WINDOW_MS == 22000u);
  assert(SMS_LATE_MAX_WAIT_MS == 20000u);
  assert(SMS_LATE_MAX_PASSES == 3u);
  assert(smsLateRemainMs(0) == 20000u);          // 22 s left, extra wait capped at 20 s
  assert(smsLateRemainMs(1000) == 20000u);       // 21 s left, still capped
  assert(smsLateRemainMs(2000) == 20000u);
  assert(smsLateRemainMs(3000) == 19000u);
  assert(smsLateRemainMs(12000) == 10000u);
  assert(smsLateRemainMs(21999) == 1u);
  assert(smsLateRemainMs(22000) == 0);
  assert(smsLateRemainMs(30000) == 0);
  assert(smsLateWaitOk(true, true, false, false));
  assert(!smsLateWaitOk(false, true, false, false));  // GPIO6 / timer / power-on: no wait
  assert(!smsLateWaitOk(true, false, false, false));
  assert(!smsLateWaitOk(true, true, true, false));    // TLS
  assert(!smsLateWaitOk(true, true, false, true));    // UPDATE
  assert(smsLateShouldRecheck(true, 0, SMS_LATE_MAX_PASSES));
  assert(smsLateShouldRecheck(true, 2, SMS_LATE_MAX_PASSES));
  assert(!smsLateShouldRecheck(true, 3, SMS_LATE_MAX_PASSES));  // cap: no infinite inbox loop
  assert(!smsLateShouldRecheck(false, 0, SMS_LATE_MAX_PASSES));
  assert(smsLateLineIsCmti("+CMTI: \"SM\",1"));
  assert(smsLateLineIsCmti("+CMTI: \"ME\",3"));
  assert(smsLateLineIsCmti("prefix +CMTI: \"SM\",2"));
  assert(!smsLateLineIsCmti("+CMT: \"SM\",1"));
  assert(!smsLateLineIsCmti("+CEREG: 1,1"));
  assert(!smsLateLineIsCmti(""));
  assert(!smsLateLineIsCmti(nullptr));
  // v1.7.9 catch-up still one-shot and still skipped during TLS/update
  assert(smsCatchupBeforeSleep(true, false, false));
  assert(!smsCatchupBeforeSleep(true, true, false));
  assert(!smsCatchupBeforeSleep(true, false, true));
  printf("v1.7.10 host tests OK (SMS late window, +CMTI recheck cap)\n");

  // 14) v1.7.11: text-timing diagnostic + SMS UPDATE allow/skip decision.
  assert(smsDiagParseCpms("+CPMS: \"SM\",3,50,\"SM\",3,50,\"SM\",3,50") == 3);
  assert(smsDiagParseCpms("+CPMS: \"ME\",1,10,\"SM\",4,50") == 4);  // SM inbox, not ME
  assert(smsDiagParseCpms("OK") == -1);
  assert(smsDiagParseCpms(nullptr) == -1);
  assert(smsDiagParseCpms("+CPMS: \"SM\",used,50") == -1);
  SmsDiag d;
  smsDiagBegin(&d, 2);
  for (int i = 0; i < 5; i++) smsDiagAddStore(&d, i == 0 ? -1 : 10 + i);
  assert(d.npass == 4);
  for (int i = 0; i < 5; i++) smsDiagAddText(&d, i + 1, "26/11/15,13:45:10-20", 1000u * (uint32_t)i);
  assert(d.ntx == 4);
  assert(strcmp(d.tx[0].scts, "26/11/15,13:45:10-20") == 0);
  smsDiagAddText(&d, 9, "bad <script>", 1);  // cap already full; also the whitelist drops other chars
  for (int i = 0; i < 5; i++) smsDiagAddCmti(&d, 100u * (uint32_t)i);
  assert(d.ncmti == 4);
  char js[512];
  size_t jn = smsDiagJson(&d, js, sizeof(js));
  assert(jn > 0);
  assert(strstr(js, ",\"sd\":{"));
  assert(strstr(js, "\"w\":2"));
  assert(strstr(js, "\"st\":["));
  assert(strstr(js, "\"tx\":["));
  assert(strstr(js, "\"cm\":["));
  assert(!strstr(js, "-1"));  // unparsed store count is omitted
  SmsDiag empty;
  smsDiagBegin(&empty, 2);
  assert(smsDiagJson(&empty, js, sizeof(js)) == 0);
  char qenc[64];
  assert(urlQueryEncode("https://w/fw/abc", qenc, sizeof(qenc)) > 0);
  assert(strcmp(qenc, "https%3A%2F%2Fw%2Ffw%2Fabc") == 0);
  assert(urlQueryEncode("x y", qenc, 4) == 0 && qenc[0] == 0);  // "x%20" needs 5 with NUL
  char why[80];
  assert(updokShouldRun(-1, "", why, sizeof(why)));
  assert(updokShouldRun(404, "not found", why, sizeof(why)));
  assert(updokShouldRun(200, "{\"ok\":true}", why, sizeof(why)));
  assert(updokShouldRun(200, "garbage", why, sizeof(why)));
  assert(updokShouldRun(200, "", why, sizeof(why)));
  assert(!updokShouldRun(200, "{\"ok\":false,\"reason\":\"uploaded file was deleted\"}", why, sizeof(why)));
  assert(strcmp(why, "uploaded file was deleted") == 0);
  assert(!updokShouldRun(200, "{\"ok\": false}", why, sizeof(why)));
  assert(strcmp(why, "cancelled") == 0);
  printf("v1.7.11 host tests OK (sms diag, updok fail-open)\n");

  // 15) v1.8.0: TCFG parse/validate/canonicalize/format, legacy mapping, seed, scheduler, dedupe.
  {
    Tcfg t; tcfgInit(&t);
    assert(t.ci == 360 && !strcmp(t.do_, "hc") && t.cs == 0 && t.qc == 30 && !strcmp(t.q_, "u"));
    assert(t.usol == 2000 && t.gto == 180);
    bool rej = false;
    int n = tcfgApply(&t, "ci=180 do=hcmsgt cs=24 qc=15 q=bu usol=0 gto=30", &rej);
    assert(n == 7 && !rej);
    assert(t.ci == 180 && !strcmp(t.do_, "hcmsgt") && t.cs == 24 && t.qc == 15 && !strcmp(t.q_, "bu"));
    assert(t.usol == 0 && t.gto == 30);
    char buf[240];
    tcfgFormatApplied(buf, sizeof(buf), n, false, &t);
    assert(!strcmp(buf, "TCFG applied 7: ci=180 do=hcmsgt cs=24 qc=15 q=bu usol=0 gto=30"));
    // omitted keys keep current; unknown keys/letters ignored
    n = tcfgApply(&t, "do=hxcz q=bz foo=1", &rej);
    assert(n == 2 && !rej && !strcmp(t.do_, "hc") && !strcmp(t.q_, "b") && t.ci == 180);
    n = tcfgApply(&t, "do=- q=", &rej);
    assert(n == 2 && !t.do_[0] && !t.q_[0]);
    tcfgFormatApplied(buf, sizeof(buf), n, false, &t);
    assert(strstr(buf, "do=-") && strstr(buf, " q=- "));
    // canonical order
    tcfgCanonDo("tgschm", t.do_); assert(!strcmp(t.do_, "hcmsgt"));
    tcfgCanonDo("HHCC", t.do_); assert(!strcmp(t.do_, "hc"));
    tcfgCanonQ("ub", t.q_); assert(!strcmp(t.q_, "bu"));
    // rejects: out of range, not stored
    uint32_t old_ci = t.ci;
    n = tcfgApply(&t, "ci=10 cs=6 qc=14 usol=20001 gto=29", &rej);
    assert(n == 0 && rej && t.ci == old_ci && t.cs == 24);
    tcfgFormatApplied(buf, sizeof(buf), 0, true, &t);
    assert(strstr(buf, "TCFG applied 0 (a value was REJECTED: ci 0 or 30-1440, cs 0|1|24|168, qc 0 or 15-240, usol 0-20000, gto 30-600):"));
    n = tcfgApply(&t, "ci=0", &rej);
    assert(n == 1 && !rej && t.ci == 0);
    n = tcfgApply(&t, "ci=29", &rej); assert(n == 0 && rej && t.ci == 0);
    n = tcfgApply(&t, "ci=1441", &rej); assert(n == 0 && rej);
    n = tcfgApply(&t, "ci=30 cs=0 qc=240 gto=600", &rej);
    assert(n == 4 && !rej && t.ci == 30 && t.cs == 0 && t.qc == 240 && t.gto == 600);
    n = tcfgApply(&t, "cs=1", &rej); assert(n == 1 && t.cs == 1);
    n = tcfgApply(&t, "cs=168", &rej); assert(n == 1 && t.cs == 168);
    n = tcfgApply(&t, "cs=24", &rej); assert(n == 1 && t.cs == 24);
    n = tcfgApply(&t, "qc=0", &rej); assert(n == 1 && t.qc == 0);
    n = tcfgApply(&t, "ci=abc", &rej); assert(n == 0 && rej);
    char js[200];
    tcfgJson(&t, js, sizeof(js));
    assert(strstr(js, "\"tcfg\":{\"v\":1,"));
    assert(strstr(js, "\"safety\":1440"));
    assert(strstr(js, "\"do\":\"hc\"") || strstr(js, "\"do\":\"-\"") || strstr(js, "\"do\":\""));
  }
  {
    // seed from 1.7.11 defaults
    TcfgLegacy L = {180, 1, 1, 0, 1, 60, 2000, 0, 30, 0, 24, 0, 180};
    Tcfg t; tcfgSeedFromLegacy(&t, &L);
    assert(t.ci == 180 && !strcmp(t.do_, "hcm") && t.cs == 24 && t.qc == 60 && !strcmp(t.q_, "u"));
    assert(t.usol == 2000 && t.gto == 180);
    // 1440 stays 1440 (ambiguous off vs 24 h)
    L.wd_int = 1440; tcfgSeedFromLegacy(&t, &L); assert(t.ci == 1440);
    L.wd_int = 0; tcfgSeedFromLegacy(&t, &L); assert(t.ci == 1440);
    // battery + uptime: qc = min, both letters
    L.wd_int = 180; L.lb_en = 1; L.lb_int = 30; L.upm = 60;
    tcfgSeedFromLegacy(&t, &L);
    assert(t.qc == 30 && !strcmp(t.q_, "bu"));
    // only battery; clamp 5 -> 15, 1440 -> 240
    L.lb_en = 1; L.lb_int = 5; L.upm = 0;
    tcfgSeedFromLegacy(&t, &L);
    assert(t.qc == 15 && !strcmp(t.q_, "b"));
    L.lb_int = 1440; tcfgSeedFromLegacy(&t, &L); assert(t.qc == 240);
    // neither
    L.lb_en = 0; L.upm = 0; tcfgSeedFromLegacy(&t, &L);
    assert(t.qc == 0 && !t.q_[0]);
    // letters: sms, cs, gps
    L.hb = 1; L.cmd = 1; L.sms = 1; L.smesh = 0; L.cs_en = 1; L.gps_auto = 1;
    tcfgSeedFromLegacy(&t, &L);
    assert(!strcmp(t.do_, "hcsgt"));
    // cs snap
    assert(tcfgSnapCs(0) == 0 && tcfgSnapCs(1) == 1 && tcfgSnapCs(24) == 24 && tcfgSnapCs(168) == 168);
    assert(tcfgSnapCs(6) == 1 && tcfgSnapCs(12) == 1 && tcfgSnapCs(48) == 24 && tcfgSnapCs(100) == 168);
  }
  {
    Tcfg t; tcfgInit(&t);
    // WDCFG int=0 -> ci=0 silent Off; else clamp 30..1440
    assert(tcfgMapWdIntToCi(0) == 0);
    assert(tcfgMapWdIntToCi(180) == 180);
    assert(tcfgMapWdIntToCi(10) == 30);
    assert(tcfgMapWdIntToCi(2000) == 1440);
    assert(tcfgLegacyIntFromCi(0) == 1440);
    assert(tcfgLegacyIntFromCi(360) == 360);
    t.ci = tcfgMapWdIntToCi(0); assert(t.ci == 0);
    tcfgMapWdHb(&t, 0); tcfgMapWdCmd(&t, 0); tcfgMapWdSms(&t, 1); tcfgMapWdSmesh(&t, 1);
    assert(tcfgDoHas(&t, 't') && tcfgDoHas(&t, 'm') && !tcfgDoHas(&t, 'h') && !tcfgDoHas(&t, 'c'));
    // upoll=0 clears u; upoll=N sets u and min with existing qc if b
    tcfgInit(&t); t.qc = 30; tcfgSetLetter(t.q_, 4, TCFG_Q_ORDER, 'b', true);
    tcfgMapUpoll(&t, 60);
    assert(tcfgQHas(&t, 'u') && tcfgQHas(&t, 'b') && t.qc == 30);  // min(30, 60)
    tcfgMapUpoll(&t, 0);
    assert(!tcfgQHas(&t, 'u') && tcfgQHas(&t, 'b') && t.qc == 30);
    tcfgMapUpoll(&t, 0);  // still b, qc stays
    Tcfg t2; tcfgInit(&t2); t2.qc = 0; t2.q_[0] = 0;
    tcfgMapUpoll(&t2, 60); assert(t2.qc == 60 && tcfgQHas(&t2, 'u'));
    tcfgMapUpoll(&t2, 0); assert(!t2.q_[0] && t2.qc == 0);
    // PWRCFG
    Tcfg t3; tcfgInit(&t3); t3.qc = 0; t3.q_[0] = 0;
    tcfgMapPwr(&t3, true, 1, true, 30);
    assert(tcfgQHas(&t3, 'b') && t3.qc == 30);
    tcfgMapPwr(&t3, true, 0, false, 0);
    assert(!tcfgQHas(&t3, 'b') && t3.qc == 0);  // no u either
    tcfgMapPwr(&t3, true, 1, false, 0);
    assert(tcfgQHas(&t3, 'b') && t3.qc == 30);  // qc was 0, default 30
    tcfgMapPwr(&t3, false, 0, true, 5);
    assert(t3.qc == 15);  // clamped
    tcfgMapPwr(&t3, false, 0, true, 1440);
    assert(t3.qc == 240);
    tcfgMapCsEn(&t3, 1); assert(tcfgDoHas(&t3, 's'));
    t3.cs = tcfgSnapCs(6); assert(t3.cs == 1);
    tcfgMapGpsAuto(&t3, 1); assert(tcfgDoHas(&t3, 'g'));
    t3.gto = 90; assert(t3.gto == 90);
  }
  {
    assert(tcfgCiSchedMin(0) == 1440 && tcfgCiSchedMin(360) == 360);
    assert(tcfgTolSecs(180) == 1080 && tcfgTolSecs(5) == 60 && tcfgTolSecs(1440) == 8640);
    int64_t now = 1000000;
    assert(tcfgIsDue(now, 0, 180));
    assert(tcfgIsDue(now, now, 180));
    assert(tcfgIsDue(now, now + 1080, 180));          // exactly 10% early
    assert(!tcfgIsDue(now, now + 1081, 180));
    assert(tcfgIsDue(now + 10, now, 180));
    // silent Off uses 1440 for tolerance
    assert(tcfgIsDue(now, now + 8640, 1440));
    assert(!tcfgIsDue(now, now + 8641, 1440));
    // backoff 30/60/120.. capped at interval
    assert(tcfgBackoffSecs(0, 180) == 180 * 60);
    assert(tcfgBackoffSecs(1, 180) == 1800);
    assert(tcfgBackoffSecs(2, 180) == 3600);
    assert(tcfgBackoffSecs(3, 180) == 7200);
    assert(tcfgBackoffSecs(1, 30) == 1800);          // 30 min interval, first fail = 30 min
    assert(tcfgBackoffSecs(5, 180) == 180 * 60);     // 480 min would exceed 180
    assert(tcfgBackoffSecs(1, 0) == 1800);           // ci=0: cap 1440 min, 30 min backoff
    assert(tcfgBackoffSecs(0, 0) == 1440 * 60);
    // sleep timer: 24 h cap, floor 5, ext0 60, never 0
    assert(tcfgSleepTimerSecs(true, now, now + 100, 180, false, 0, 0, false, 0) == 60);
    int64_t s = tcfgSleepTimerSecs(false, now, now + 360 * 60, 360, true, now + 30 * 60, 30, false, 0);
    assert(s == 30 * 60);
    s = tcfgSleepTimerSecs(false, now, now + 360 * 60, 360, false, 0, 0, false, 0);
    assert(s == 360 * 60);
    s = tcfgSleepTimerSecs(false, now, now + 20000 * 60, 20000, false, 0, 0, false, 0);
    assert(s == 1440 * 60);  // 24 h cap
    s = tcfgSleepTimerSecs(false, now, now - 100, 180, false, 0, 0, false, 0);
    assert(s == 5);          // past due, floor
    s = tcfgSleepTimerSecs(false, now, now + 300, 180, false, 0, 0, true, now + 120);
    assert(s == 120);        // GNSS warm window
    s = tcfgSleepTimerSecs(false, now, 0, 180, false, 0, 0, false, 0);
    assert(s == 180 * 60);   // unscheduled ci -> interval from now
    // silent Off still schedules 24 h
    s = tcfgSleepTimerSecs(false, now, now + 1440 * 60, 1440, false, 0, 0, false, 0);
    assert(s == 1440 * 60);
    assert(tcfgQcEnabled(nullptr) == false);
    Tcfg t; tcfgInit(&t); assert(tcfgQcEnabled(&t));
    t.qc = 0; assert(!tcfgQcEnabled(&t));
    t.qc = 30; t.q_[0] = 0; assert(!tcfgQcEnabled(&t));
    // silent Off data
    t.ci = 0; tcfgCanonDo("hc", t.do_);
    assert(!tcfgCiWantsData(&t, false, false));
    assert(tcfgCiWantsData(&t, true, false));
    assert(tcfgCiWantsData(&t, false, true));
    t.ci = 360;
    assert(tcfgCiWantsData(&t, false, false));  // do=hc
    t.do_[0] = 0;
    assert(!tcfgCiWantsData(&t, false, false));
    assert(tcfgCiWantsData(&t, false, true));
  }
  {
    TcfgIdRing r; tcfgIdClear(&r);
    assert(!tcfgIdSeen(&r, "a"));
    tcfgIdPush(&r, "id1"); assert(tcfgIdSeen(&r, "id1"));
    assert(!tcfgIdSeen(&r, "id2"));
    for (int i = 2; i <= 16; i++) {
      char id[8]; snprintf(id, sizeof(id), "id%d", i);
      tcfgIdPush(&r, id);
    }
    assert(r.n == 16);
    assert(tcfgIdSeen(&r, "id1"));
    tcfgIdPush(&r, "id17");
    assert(!tcfgIdSeen(&r, "id1"));  // evicted
    assert(tcfgIdSeen(&r, "id17") && tcfgIdSeen(&r, "id2"));
    tcfgIdPush(&r, ""); assert(tcfgIdSeen(&r, "id17"));  // empty ignored
    assert(tcfgCmdKind("TCFG ci=1") == TCFG_KIND_TCFG);
    assert(tcfgCmdKind("tcfg") == TCFG_KIND_TCFG);
    assert(tcfgCmdKind("WDCFG int=0") == TCFG_KIND_WDCFG);
    assert(tcfgCmdKind("PWRCFG en=1") == TCFG_KIND_PWRCFG);
    assert(tcfgCmdKind("CFGSNAP en=0") == TCFG_KIND_CFGSNAP);
    assert(tcfgCmdKind("GPSCFG auto=1") == TCFG_KIND_GPSCFG);
    assert(tcfgCmdKind("GPSFIX") == TCFG_KIND_NONE);
    assert(tcfgCmdKind("get name") == TCFG_KIND_NONE);
    assert(tcfgIsSysCmd("TCFG ci=360") && tcfgIsSysCmd("TCFG") && tcfgIsSysCmd("WDCFG int=1"));
    assert(tcfgIsSysCmd("GPSFIX") && tcfgIsSysCmd("GPSCFG auto=0"));
    assert(!tcfgIsSysCmd("get name"));
    int kinds[6] = { TCFG_KIND_TCFG, TCFG_KIND_WDCFG, TCFG_KIND_TCFG, TCFG_KIND_PWRCFG, TCFG_KIND_GPSCFG, TCFG_KIND_NONE };
    bool super[6];
    tcfgMarkSuperseded(kinds, 6, super);
    assert(super[0] && !super[1] && !super[2] && !super[3] && !super[4] && !super[5]);
    int k2[3] = { TCFG_KIND_WDCFG, TCFG_KIND_WDCFG, TCFG_KIND_WDCFG };
    bool s2[3];
    tcfgMarkSuperseded(k2, 3, s2);
    assert(s2[0] && s2[1] && !s2[2]);
    assert(!strcmp(tcfgKindName(TCFG_KIND_TCFG), "TCFG"));
    assert(!strcmp(tcfgKindName(TCFG_KIND_CFGSNAP), "CFGSNAP"));
  }
  printf("v1.8.0 host tests OK (TCFG parse, legacy map, seed, scheduler, silent Off, dedupe, supersede)\n");

  // 16) v1.8.1: SMS hash ring, oldest-first order, poll / late-window decisions.
  assert(smsLateRemainFor(0, false) == smsLateRemainMs(0));
  assert(smsLateRemainFor(3000, false) == smsLateRemainMs(3000));
  assert(smsLateRemainFor(22000, false) == 0);
  assert(smsLateRemainFor(0, true) == 30000u);
  assert(smsLateRemainFor(22000, true) == 8000u);
  assert(smsLateRemainFor(30000, true) == 0);
  assert(SMS_LATE_POLL_MS == 2500u);
  assert(smsPollDue(2500, 0, SMS_LATE_POLL_MS));
  assert(!smsPollDue(2499, 0, SMS_LATE_POLL_MS));
  assert(smsPollDue(100, 0xFFFFFFF0u, 32));  // millis wrap
  assert(smsShouldList(0, false) == false);
  assert(smsShouldList(1, false));
  assert(smsShouldList(0, true));
  assert(smsShouldList(-1, false));
  assert(smsTriggerFound(1) && !smsTriggerFound(0));
  assert(smsSleepExtraPass(true, false));
  assert(smsSleepExtraPass(false, true));
  assert(!smsSleepExtraPass(false, false));
  assert(!smsCmtiAfterPass(0, 0));
  assert(!smsCmtiAfterPass(5000, 5000));
  assert(smsCmtiAfterPass(6000, 5000));
  assert(!smsCmtiAfterPass(100, 5000));
  assert(smsCmtiAfterPass(10, 0xFFFFFFF0u));  // wrap: 10 is after 0xFFFFFFF0
  uint32_t h1 = smsTextHash("26/11/24,18:21:04+04", "+15551212", "UPDATE https://x");
  uint32_t h2 = smsTextHash("26/11/24,18:21:04+04", "+15551212", "UPDATE https://x");
  uint32_t h3 = smsTextHash("26/11/24,23:20:42+04", "+15551212", "UPDATE https://x");
  assert(h1 == h2);
  assert(h1 != h3);  // a Retry is a new timestamp
  assert(smsTextHash("ab", "c", "") != smsTextHash("a", "bc", ""));
  SmsRing ring; smsRingClear(&ring);
  assert(!smsRingHas(&ring, 0));
  smsRingPush(&ring, 0);
  assert(smsRingHas(&ring, 0));  // hash 0 is a real entry
  for (uint32_t i = 1; i <= 16; i++) smsRingPush(&ring, i);
  assert(ring.n == 16);
  assert(!smsRingHas(&ring, 0));  // evicted
  assert(smsRingHas(&ring, 1) && smsRingHas(&ring, 16));
  uint32_t keys[4] = { 100, 0, 50, 50 };
  int idx[4] = { 0, 1, 2, 3 };
  smsOrderOldest(idx, 4, keys);
  assert(idx[0] == 1 && idx[1] == 2 && idx[2] == 3 && idx[3] == 0);  // 0, then the two 50s in order, then 100
  assert(smsTsKey("nope") == 0);
  assert(smsTsKey("26/11/24,18:21:04+04") < smsTsKey("26/11/24,23:20:42+04"));
  // 2026-11-24 22:20:53 UTC. Modem stamp is UTC+1 ("+04" quarters).
  const int64_t nowu = 1795558853LL;  // 2026-11-24 22:20:53 UTC
  assert(smsTsRecent("26/11/24,23:20:42+04", nowu, 180));       // 22:20:42 UTC, 11 s earlier
  assert(!smsTsRecent("26/11/24,18:21:04+04", nowu, 180));      // 17:21:04 UTC, hours earlier
  assert(!smsTsRecent("26/11/24,23:20:42", nowu, 180));         // no timezone: not recent
  assert(!smsTsRecent("26/11/24,23:20:42+04", 1000, 180));      // clock not set
  SmsDiag sd; smsDiagBegin(&sd, 2);
  for (int i = 0; i < 5; i++) smsDiagAddStore(&sd, 1);
  assert(sd.npass == 4);
  assert(sd.passes == 5);
  smsDiagSetFound(&sd);
  char js181[512];
  assert(smsDiagJson(&sd, js181, sizeof(js181)) > 0);
  assert(strstr(js181, "\"np\":5"));
  assert(strstr(js181, "\"tf\":1"));
  printf("v1.8.1 host tests OK (SMS ring, order, poll, recent text)\n");
  return 0;
}
