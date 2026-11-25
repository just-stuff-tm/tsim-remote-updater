// v1.7.11: text-timing diagnostic and the SMS UPDATE allow/skip decision.
// Pure helpers (no Arduino). Shared by main.cpp and firmware/test/host_test.cpp.
// The diagnostic records what this wake already did. It does not add a wait.
#pragma once
#include <ctype.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define SMS_DIAG_MAX_PASSES 4
#define SMS_DIAG_MAX_TEXTS  4
#define SMS_DIAG_MAX_CMTI   4

struct SmsDiagText {
  int idx;
  char scts[24];
  uint32_t read_ms;
};

struct SmsDiag {
  int wake;
  int store[SMS_DIAG_MAX_PASSES];  // -1 = this pass did not parse a count
  uint8_t npass;
  SmsDiagText tx[SMS_DIAG_MAX_TEXTS];
  uint8_t ntx;
  uint32_t cmti_ms[SMS_DIAG_MAX_CMTI];
  uint8_t ncmti;
  uint8_t passes;  // v1.8.1: total inbox passes this wake (not capped at 4)
  uint8_t tf;      // v1.8.2: 1 once a new (not deduped) text was executed this wake
  uint8_t on;
};

// One wake. Caps are the array sizes: extra passes, texts, and +CMTI times are dropped.
static inline void smsDiagBegin(SmsDiag *d, int wake) {
  if (!d) return;
  memset(d, 0, sizeof(*d));
  d->wake = wake;
  d->on = 1;
  for (int i = 0; i < SMS_DIAG_MAX_PASSES; i++) d->store[i] = -1;
}

// used = messages in the modem store (read + unread). -1 if this pass could not read it.
static inline void smsDiagAddStore(SmsDiag *d, int used) {
  if (!d) return;
  if (d->passes < 255) d->passes++;
  if (d->npass >= SMS_DIAG_MAX_PASSES) return;
  d->store[d->npass++] = used;
}

// One text we read this wake: modem index, SCTS (network timestamp), ms since wake.
static inline void smsDiagAddText(SmsDiag *d, int idx, const char *scts, uint32_t read_ms) {
  if (!d || d->ntx >= SMS_DIAG_MAX_TEXTS || idx < 0) return;
  SmsDiagText *t = &d->tx[d->ntx++];
  t->idx = idx;
  t->read_ms = read_ms;
  t->scts[0] = 0;
  if (!scts) return;
  size_t o = 0;
  for (const char *p = scts; *p && o + 1 < sizeof(t->scts); p++) {
    unsigned char c = (unsigned char)*p;
    if ((c >= '0' && c <= '9') || c == ':' || c == '/' || c == ',' || c == '+' || c == '-') t->scts[o++] = (char)c;
  }
  t->scts[o] = 0;
}

// ms since wake (millis() after deep sleep) when a +CMTI line was seen.
static inline void smsDiagAddCmti(SmsDiag *d, uint32_t ms) {
  if (!d || d->ncmti >= SMS_DIAG_MAX_CMTI) return;
  d->cmti_ms[d->ncmti++] = ms;
}

static inline void smsDiagSetFound(SmsDiag *d) {
  if (!d) return;
  d->tf = 1;
}

// v1.8.2: tf is for every text this wake will actually run. A ring duplicate
// (already executed) and a same-pass merge do not count. "Recent" network time
// does not matter: a stored UPDATE still counts. Call smsDiagSetFound before
// the command runs — UPDATE posts telemetry before it returns.
static inline bool smsCountsAsNewText(bool ring_dup, bool pass_dup) {
  return !ring_dup && !pass_dup;
}

// AT+CPMS? → used count. Prefers the "SM" store (the SMS inbox). -1 if unparseable.
// Typical: +CPMS: "SM",3,50,"SM",3,50,"SM",3,50
static inline int smsDiagParseCpms(const char *resp) {
  if (!resp) return -1;
  const char *p = strstr(resp, "+CPMS:");
  if (!p) return -1;
  const char *sm = strstr(p, "\"SM\"");
  const char *q = sm ? sm : p;
  const char *c = strchr(q, ',');
  if (!c) return -1;
  c++;
  while (*c == ' ') c++;
  if (*c < '0' || *c > '9') return -1;
  int v = 0;
  while (*c >= '0' && *c <= '9') { v = v * 10 + (*c - '0'); if (v > 999) return 999; c++; }
  return v;
}

// Compact telem fragment, leading comma: ,"sd":{"w":2,"st":[1,2],"tx":[[3,"13:45:10",2100]],"cm":[9800]}
// Empty (returns 0, writes nothing) when this wake recorded no pass, text, or +CMTI.
static inline size_t smsDiagJson(const SmsDiag *d, char *out, size_t cap) {
  if (!d || !d->on || !out || cap < 8) return 0;
  if (!d->npass && !d->ntx && !d->ncmti && !d->passes && !d->tf) return 0;
  char tmp[512];
  size_t o = 0;
  int n = snprintf(tmp, sizeof(tmp), ",\"sd\":{\"w\":%d,\"np\":%u,\"tf\":%u", d->wake, (unsigned)d->passes, (unsigned)d->tf);
  if (n < 0 || (size_t)n >= sizeof(tmp)) return 0;
  o = (size_t)n;
  int nstore = 0;
  for (uint8_t i = 0; i < d->npass; i++) if (d->store[i] >= 0) nstore++;
  if (nstore) {
    n = snprintf(tmp + o, sizeof(tmp) - o, ",\"st\":[");
    if (n < 0 || (size_t)n >= sizeof(tmp) - o) return 0;
    o += (size_t)n;
    bool first = true;
    for (uint8_t i = 0; i < d->npass; i++) {
      if (d->store[i] < 0) continue;
      n = snprintf(tmp + o, sizeof(tmp) - o, "%s%d", first ? "" : ",", d->store[i]);
      if (n < 0 || (size_t)n >= sizeof(tmp) - o) return 0;
      o += (size_t)n;
      first = false;
    }
    if (o + 1 >= sizeof(tmp)) return 0;
    tmp[o++] = ']';
    tmp[o] = 0;
  }
  if (d->ntx) {
    n = snprintf(tmp + o, sizeof(tmp) - o, ",\"tx\":[");
    if (n < 0 || (size_t)n >= sizeof(tmp) - o) return 0;
    o += (size_t)n;
    for (uint8_t i = 0; i < d->ntx; i++) {
      n = snprintf(tmp + o, sizeof(tmp) - o, "%s[%d,\"%s\",%lu]", i ? "," : "", d->tx[i].idx, d->tx[i].scts, (unsigned long)d->tx[i].read_ms);
      if (n < 0 || (size_t)n >= sizeof(tmp) - o) return 0;
      o += (size_t)n;
    }
    if (o + 1 >= sizeof(tmp)) return 0;
    tmp[o++] = ']';
    tmp[o] = 0;
  }
  if (d->ncmti) {
    n = snprintf(tmp + o, sizeof(tmp) - o, ",\"cm\":[");
    if (n < 0 || (size_t)n >= sizeof(tmp) - o) return 0;
    o += (size_t)n;
    for (uint8_t i = 0; i < d->ncmti; i++) {
      n = snprintf(tmp + o, sizeof(tmp) - o, "%s%lu", i ? "," : "", (unsigned long)d->cmti_ms[i]);
      if (n < 0 || (size_t)n >= sizeof(tmp) - o) return 0;
      o += (size_t)n;
    }
    if (o + 1 >= sizeof(tmp)) return 0;
    tmp[o++] = ']';
    tmp[o] = 0;
  }
  if (o + 1 >= sizeof(tmp)) return 0;
  tmp[o++] = '}';
  tmp[o] = 0;
  if (o >= cap) return 0;
  memcpy(out, tmp, o + 1);
  return o;
}

// RFC 3986 query encoding. Returns 0 (and out "") if the result does not fit.
static inline size_t urlQueryEncode(const char *in, char *out, size_t cap) {
  static const char *hexd = "0123456789ABCDEF";
  if (!out || !cap) return 0;
  size_t o = 0;
  if (!in) { out[0] = 0; return 0; }
  for (const unsigned char *p = (const unsigned char *)in; *p; p++) {
    unsigned char c = *p;
    bool plain = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~';
    size_t need = plain ? 1 : 3;
    if (o + need + 1 > cap) { out[0] = 0; return 0; }
    if (plain) out[o++] = (char)c;
    else { out[o++] = '%'; out[o++] = hexd[c >> 4]; out[o++] = hexd[c & 15]; }
  }
  out[o] = 0;
  return o;
}

// SMS UPDATE check. true = run the update. Non-200, timeout (-1), empty, or a body
// we cannot read as {"ok":...} fails open (an old dashboard or a dropped link must
// not block the update). Only a 200 body with "ok":false skips it.
// reason is filled only when returning false.
static inline bool updokShouldRun(int http_status, const char *body, char *reason, size_t reason_cap) {
  if (reason && reason_cap) reason[0] = 0;
  if (http_status != 200 || !body || !body[0]) return true;
  const char *p = strstr(body, "\"ok\"");
  if (!p) return true;
  p += 4;
  while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
  if (*p != ':') return true;
  p++;
  while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
  if (strncmp(p, "false", 5) != 0) return true;
  if (reason && reason_cap) {
    const char *r = strstr(body, "\"reason\"");
    if (r) {
      r = strchr(r + 8, ':');
      if (r) {
        r++;
        while (*r == ' ' || *r == '\t') r++;
        if (*r == '"') {
          r++;
          size_t i = 0;
          while (*r && *r != '"' && i + 1 < reason_cap) {
            if (*r == '\\' && r[1]) r++;
            char c = *r++;
            if ((unsigned char)c < 0x20) continue;
            reason[i++] = c;
          }
          reason[i] = 0;
        }
      }
    }
    if (!reason[0]) {
      strncpy(reason, "cancelled", reason_cap - 1);
      reason[reason_cap - 1] = 0;
    }
  }
  return false;
}
