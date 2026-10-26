// v1.7.6: pure helpers (no Arduino) shared by main.cpp and the host test (firmware/test/host_test.cpp).
#pragma once
#include <stdint.h>
#include <string.h>
#include <strings.h>

// A reset the T-SIM did itself (heltecReboot: REBOOT text/USB, after a Heltec flash). Kept in RAM and timed with
// millis(), so it never depends on the RTC/gettimeofday clock (never set on this board; it read 2033). It stays
// pending until the first boot marker of that boot is consumed, or SELF_RESET_MS passes with none seen.
#define SELF_RESET_MS   300000UL
#define HM_SAME_BOOT_MS 20000UL   // further markers within 20 s belong to the same boot
struct SelfReset { bool pending; uint32_t at_ms; };
static inline void selfResetMark(SelfReset &s, uint32_t now_ms) { s.pending = true; s.at_ms = now_ms; }
static inline bool selfResetActive(const SelfReset &s, uint32_t now_ms) {
  return s.pending && (uint32_t)(now_ms - s.at_ms) < SELF_RESET_MS;
}
// RTC-based window kept for the cross-deep-sleep case (GPIO6 wake right after a self-reset). A clock that stepped
// back since the reset (now < own, by less than an hour) also counts as own, instead of silently failing the guard.
static inline bool rtcOwnWindow(int64_t own, int64_t now, int64_t win_s) {
  if (own <= 0) return false;
  if (now < own) return own - now < 3600;
  return now - own < win_s;
}

// Boot-marker classifier for the awake UART monitor.
enum { HM_SAME = 0, HM_SELF = 1, HM_NEW = 2 };
struct HmState { bool hit_any; uint32_t hit_ms; SelfReset self; };
static inline int hmClassify(HmState &st, uint32_t now_ms) {
  if (st.hit_any && (uint32_t)(now_ms - st.hit_ms) < HM_SAME_BOOT_MS) { st.hit_ms = now_ms; return HM_SAME; }
  st.hit_any = true; st.hit_ms = now_ms;
  if (selfResetActive(st.self, now_ms)) { st.self.pending = false; return HM_SELF; }
  return HM_NEW;
}

// SMS merge (one inbox pass): identical STATUS or CMD texts run once. body = normalized text (no " ACK").
static inline bool smsMergeable(const char *n) { return n && (!strcasecmp(n, "STATUS") || !strcasecmp(n, "CMD")); }
// true when n is mergeable and already in seen[0..nseen-1]
static inline bool smsIsDup(const char *const *seen, int nseen, const char *n) {
  if (!smsMergeable(n)) return false;
  for (int i = 0; i < nseen; i++) if (seen[i] && !strcasecmp(seen[i], n)) return true;
  return false;
}
