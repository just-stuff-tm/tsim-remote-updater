// v1.7.8: pure wake decisions (no Arduino). Shared by main.cpp and firmware/test/host_test.cpp.
#pragma once
#include <stdint.h>
#include <strings.h>

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

// v1.7.9: the extra AT diagnostics are a USB log. After STATUS the same queries
// (CSQ, CPSI, COPS, CEREG, CGMR) were already posted, so a second pass only delays sleep.
// CMD never asks for them. did_status_report means this wake already posted that report.
static inline bool wakeRunPostDiag(bool is_status, bool did_status_report) {
  if (did_status_report) return false;
  return wakeExtras(is_status, false).diag;
}

// v1.7.9: before sleep, one unread-SMS pass. Not a timed wait, and not during an update or a TLS session.
static inline bool smsCatchupBeforeSleep(bool modem_ready, bool tcp_busy, bool busy_update) {
  return modem_ready && !tcp_busy && !busy_update;
}

// v1.7.9: the scheduled check texts "STATUS AUTO" (1.7.9+ only). A plain "STATUS" is manual.
static inline bool statusIsScheduled(const char *body) {
  return body && !strcasecmp(body, "STATUS AUTO");
}

// v1.7.9: smesh 0 skips the Heltec mesh snapshot on that scheduled STATUS only.
// Manual STATUS always fetches. Any value other than 0 fetches (default 1).
static inline bool statusFetchesMesh(bool scheduled, int smesh) {
  if (!scheduled) return true;
  return smesh != 0;
}

// v1.7.9: FNV-1a 32-bit over one CFGSNAP command or reply. The 0xFF mix is a separator,
// so hashing "ab" then "c" is not the same as "a" then "bc".
static inline uint32_t cfgsnapHash(uint32_t h, const char *s) {
  const uint32_t prime = 16777619u;
  if (!s) s = "";
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    h ^= *p;
    h *= prime;
  }
  h ^= 0xFFu;
  h *= prime;
  return h;
}

// v1.7.9: post the snapshot when the settings changed, the dashboard asked, or the interval elapsed.
// A clock step-back is not an interval: an unchanged hash skips that one post.
static inline bool cfgsnapShouldUpload(bool changed, bool refresh, bool interval_due) {
  if (refresh) return true;
  if (interval_due) return true;
  return changed;
}

// v1.7.9: refresh always collects (even when disabled or on low battery), matching the old gate.
// Otherwise collect on the interval, or once after the clock steps back, and never while low.
static inline bool cfgsnapShouldCollect(bool refresh, bool enabled, bool lowbat, bool interval_due, bool clock_back) {
  if (refresh) return true;
  if (!enabled || lowbat) return false;
  return interval_due || clock_back;
}
