// v1.7.8: pure wake decisions (no Arduino). Shared by main.cpp and firmware/test/host_test.cpp.
#pragma once
#include <stdint.h>
#include <string.h>
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

// v1.7.10: on a text (RI/ext0) wake the +CMTI for the text that rang the pin can land after the
// first inbox pass (especially with eDRX). Keep the modem up until SMS_LATE_WINDOW_MS after boot
// (millis() since reset), watching UART for "+CMTI". Extra wait added is capped at
// SMS_LATE_MAX_WAIT_MS (~20 s) and is 0 if this wake already ran past the window.
// Awake-time cost: up to ~20 s extra on a short text wake; 0 s on a STATUS/CMD/UPDATE that
// already passed ~22 s; GPIO6 and watchdog wakes do not wait.
// At most SMS_LATE_MAX_PASSES extra processSmsInbox(true) calls if +CMTI arrives, then one
// final unread pass (the v1.7.9 one-shot catch-up). No loop: the pass counter is the cap.
#define SMS_LATE_WINDOW_MS    22000u
#define SMS_LATE_MAX_WAIT_MS  20000u
#define SMS_LATE_MAX_PASSES   3u

static inline uint32_t smsLateRemainMs(uint32_t now_ms) {
  if (now_ms >= SMS_LATE_WINDOW_MS) return 0;
  uint32_t left = SMS_LATE_WINDOW_MS - now_ms;
  if (left > SMS_LATE_MAX_WAIT_MS) left = SMS_LATE_MAX_WAIT_MS;
  return left;
}

// Text wake only, modem already answering, not during TLS or an update.
static inline bool smsLateWaitOk(bool sms_wake, bool modem_ready, bool tcp_busy, bool busy_update) {
  return sms_wake && modem_ready && !tcp_busy && !busy_update;
}

static inline bool smsLateShouldRecheck(bool saw_cmti, unsigned extra_done, unsigned max_passes) {
  return saw_cmti && extra_done < max_passes;
}

static inline bool smsLateLineIsCmti(const char *line) {
  return line && strstr(line, "+CMTI") != nullptr;
}

// v1.8.1: on an RI wake the text that rang the pin is often stored a few seconds
// after the first CMGL, and +CMTI is routinely lost because modemAT() flushes the
// UART. Poll the store on a timer instead of waiting for that URC. The 22 s
// window stays for a wake that already ran a new text. Only an RI wake that has
// not executed one yet may stay up to SMS_LATE_EXT_WINDOW_MS (30 s from boot).
#define SMS_LATE_POLL_MS       2500u
#define SMS_LATE_EXT_WINDOW_MS 30000u

static inline uint32_t smsLateRemainFor(uint32_t now_ms, bool extend) {
  if (!extend) return smsLateRemainMs(now_ms);
  if (now_ms >= SMS_LATE_EXT_WINDOW_MS) return 0;
  return SMS_LATE_EXT_WINDOW_MS - now_ms;
}
