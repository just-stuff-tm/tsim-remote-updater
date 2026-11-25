// v1.8.1: persisted SMS dedupe, ordering, and inbox-poll decisions.
// Pure helpers (no Arduino). Shared by main.cpp and firmware/test/host_test.cpp.
//
// Why a text wake used to run the previous text: the SMS that rang RI is often
// not in the modem store at the first CMGL (field: read at ~700 ms, +CMTI list
// empty). The v1.7.10 late window re-read only when modemPollCmti() saw +CMTI,
// but modemAT() discards pending UART bytes before every command, so that URC
// is routinely lost. The only unconditional re-read was one REC UNREAD pass at
// the end of the ~22 s window. The new SMS is stored after that pass — often a
// few seconds after the first CMGL, and commonly just after AT+CMGD (the modem
// then sends SMMA and the network delivers the message that paged RI). The
// device slept with the new text still unread, so the next wake executed it.
// REC READ was also treated as stale, which would drop a text forever if CMGL
// marked it read and the pass was interrupted. These traces still showed the
// text unread at the next wake, so the miss was "never listed this wake".
#pragma once
#include <stdint.h>
#include <string.h>

#define SMS_RING_CAP 16

struct SmsRing {
  uint32_t h[SMS_RING_CAP];
  uint8_t n;  // how many slots are valid (0..16)
  uint8_t i;  // next write index
};

static inline void smsRingClear(SmsRing *r) {
  if (!r) return;
  memset(r, 0, sizeof(*r));
}

// FNV-1a over timestamp, sender, and body. 0x1f separates the fields so
// "ab"+"c" is not "a"+"bc". A dashboard Retry is a new text with a new
// timestamp, so its hash is not in the ring and it still runs.
static inline uint32_t smsTextHash(const char *ts, const char *from, const char *body) {
  const uint32_t prime = 16777619u;
  uint32_t h = 2166136261u;
  const char *parts[3] = { ts ? ts : "", from ? from : "", body ? body : "" };
  for (int i = 0; i < 3; i++) {
    for (const unsigned char *p = (const unsigned char *)parts[i]; *p; p++) {
      h ^= *p;
      h *= prime;
    }
    h ^= 0x1fu;
    h *= prime;
  }
  return h;
}

static inline bool smsRingHas(const SmsRing *r, uint32_t hash) {
  if (!r) return false;
  uint8_t n = r->n;
  if (n > SMS_RING_CAP) n = SMS_RING_CAP;
  for (uint8_t i = 0; i < n; i++) if (r->h[i] == hash) return true;
  return false;
}

// Overwrites the oldest slot once the ring is full. Hash 0 is a real value.
static inline void smsRingPush(SmsRing *r, uint32_t hash) {
  if (!r) return;
  if (r->n > SMS_RING_CAP) r->n = SMS_RING_CAP;
  if (r->i >= SMS_RING_CAP) r->i = 0;
  r->h[r->i] = hash;
  r->i = (uint8_t)((r->i + 1) % SMS_RING_CAP);
  if (r->n < SMS_RING_CAP) r->n++;
}

// "yy/MM/dd,hh:mm:ss±zz" → seconds since 2000-01-01 (timezone ignored).
// Unparseable → 0, which sorts first and still runs. It is not dropped.
static inline uint32_t smsTsKey(const char *ts) {
  if (!ts || !ts[0]) return 0;
  const char *p = ts;
  int y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
  int *out[6] = { &y, &mo, &d, &h, &mi, &s };
  const int nd[6] = { 2, 2, 2, 2, 2, 2 };
  const char sep[5] = { '/', '/', ',', ':', ':' };
  for (int f = 0; f < 6; f++) {
    int v = 0;
    for (int i = 0; i < nd[f]; i++) {
      if (*p < '0' || *p > '9') return 0;
      v = v * 10 + (*p - '0');
      p++;
    }
    *out[f] = v;
    if (f < 5) {
      if (*p != sep[f]) return 0;
      p++;
    }
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return 0;
  static const int md[12] = { 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 };
  // Leap days before this year. Year 0 is 2000, which is a leap year.
  int leaps = y > 0 ? ((y - 1) / 4) + 1 : 0;
  int days = y * 365 + leaps + md[mo - 1] + (d - 1);
  if ((y % 4) == 0 && mo > 2) days++;
  return (uint32_t)(((days * 24 + h) * 60 + mi) * 60 + s);
}

// SCTS timezone is in quarters of an hour ("+04" = UTC+1). 0 if the stamp
// has no timezone or does not parse. Unix seconds, or 0 on failure.
static inline int64_t smsTsUnix(const char *ts) {
  uint32_t key = smsTsKey(ts);
  if (!key || !ts) return 0;
  const char *p = ts;
  for (int i = 0; i < 17 && *p; i++) p++;  // yy/MM/dd,hh:mm:ss
  if (*p != '+' && *p != '-') return 0;
  int sign = *p == '+' ? 1 : -1;
  p++;
  if (p[0] < '0' || p[0] > '9' || p[1] < '0' || p[1] > '9') return 0;
  int quarters = sign * ((p[0] - '0') * 10 + (p[1] - '0'));
  const int64_t unix2000 = 946684800LL;
  return unix2000 + (int64_t)key - (int64_t)quarters * 15 * 60;
}

// True when the text's network time is within slack_s of the device clock.
// An hours-old backlog text is not the one that just rang RI. A clock that
// is not set, or a stamp with no timezone, is not recent (caller keeps polling).
static inline bool smsTsRecent(const char *ts, int64_t now_unix, int slack_s) {
  if (now_unix < 1700000000LL || slack_s < 0) return false;
  int64_t sms = smsTsUnix(ts);
  if (sms <= 0) return false;
  int64_t d = now_unix - sms;
  if (d < 0) d = -d;
  return d <= (int64_t)slack_s;
}

// idx[] is a permutation of message indexes. Equal keys keep the earlier index.
static inline void smsOrderOldest(int *idx, int n, const uint32_t *keys) {
  if (!idx || !keys || n <= 1) return;
  for (int i = 1; i < n; i++) {
    int id = idx[i];
    uint32_t k = keys[id];
    int j = i;
    while (j > 0) {
      int prev = idx[j - 1];
      if (keys[prev] <= k) break;
      idx[j] = prev;
      j--;
    }
    idx[j] = id;
  }
}

// Cheap poll: CMGL only when the store count is non-zero, unparseable, or the
// caller is forcing one more pass (RI still low / +CMTI after the last pass).
static inline bool smsShouldList(int count, bool force) {
  if (force) return true;
  if (count < 0) return true;
  return count > 0;
}

static inline bool smsPollDue(uint32_t now_ms, uint32_t last_poll_ms, uint32_t interval_ms) {
  return (uint32_t)(now_ms - last_poll_ms) >= interval_ms;
}

static inline bool smsTriggerFound(int newly_executed) { return newly_executed > 0; }

// One more pass before sleep. RI is active-low (ext0 wakeup level 0).
static inline bool smsSleepExtraPass(bool ri_low, bool cmti_after_pass) {
  return ri_low || cmti_after_pass;
}

// True when cmti_ms is strictly after pass_done_ms, including millis() wrap.
static inline bool smsCmtiAfterPass(uint32_t cmti_ms, uint32_t pass_done_ms) {
  if (cmti_ms == 0 && pass_done_ms == 0) return false;
  if (cmti_ms == pass_done_ms) return false;
  return (uint32_t)(cmti_ms - pass_done_ms) < 0x80000000u;
}
