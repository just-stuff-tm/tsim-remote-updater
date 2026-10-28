// Host test for firmware/src/hw_guard.h (v1.7.6). Run: g++ -std=c++17 -Wall -I../src host_test.cpp -o /tmp/ht && /tmp/ht
#include "hw_guard.h"
#include "tsim_frame.h"
#include <cassert>
#include <cstdio>
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
  printf("v1.7.7 host tests OK (self-reset guard, RTC step-back, SMS merge, tsim wake frames)\n");
  return 0;
}
