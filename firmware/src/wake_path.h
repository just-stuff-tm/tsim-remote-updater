// v1.7.8: pure wake decisions (no Arduino). Shared by main.cpp and firmware/test/host_test.cpp.
#pragma once
#include <stdint.h>

// ESP_SLEEP_WAKEUP_EXT0 is 2: the modem RI pin, an incoming text. Power-on (0),
// GPIO6/ext1 (3) and timer (4) stay on whatever path they already use.
static inline bool smsWakeUsesLight(int wake_cause) { return wake_cause == 2; }

// Light wake (DTR low, same idea as the watchdog) is enough only when AT answered
// and the modem is still registered. Otherwise the caller uses modemPowerOn.
#define SMS_LIGHT_AT_TRIES 5
#define SMS_LIGHT_REG_MS   12000u
static inline bool smsLightOk(bool at_ok, bool reg_ok) { return at_ok && reg_ok; }

// What to do after a text's command replies are posted.
// STATUS keeps the mesh snapshot, the extra AT diagnostics, and the ?sys=1 fetch.
// CMD skips the snapshot and the diagnostics. A follow-up ?sys=1 runs only when a
// system command is still pending; an empty queue must not fetch it.
struct WakeExtras { bool mesh; bool diag; bool sys; };
static inline WakeExtras wakeExtras(bool is_status, bool sys_pending) {
  if (is_status) return { true, true, true };
  return { false, false, sys_pending };
}
