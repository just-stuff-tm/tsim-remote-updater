// Host test for firmware/src/hw_guard.h (v1.7.6). Run: g++ -std=c++17 -Wall -I../src host_test.cpp -o /tmp/ht && /tmp/ht
#include "hw_guard.h"
#include "lp_power.h"
#include "tsim_frame.h"
#include "wake_path.h"
#include "sms_diag.h"
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
  return 0;
}
