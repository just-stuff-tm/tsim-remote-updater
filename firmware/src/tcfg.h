// v1.8.0: unified check-in config (TCFG). Pure helpers (no Arduino).
// Shared by main.cpp and firmware/test/host_test.cpp.
#pragma once
#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <stdlib.h>

#define TCFG_SAFETY_MIN     1440u
#define TCFG_CI_MIN           30u
#define TCFG_CI_MAX         1440u
#define TCFG_QC_MIN           15u
#define TCFG_QC_MAX          240u
#define TCFG_GTO_MIN          30u
#define TCFG_GTO_MAX         600u
#define TCFG_USOL_MAX      20000u
#define TCFG_TOL_MIN_S        60
#define TCFG_SLEEP_FLOOR_S     5
#define TCFG_ID_RING          16
#define TCFG_ID_LEN           20
#define TCFG_DO_ORDER     "hcmsgt"
#define TCFG_Q_ORDER      "bu"
#define TCFG_REJ_MSG      " (a value was REJECTED: ci 0 or 30-1440, cs 0|1|24|168, qc 0 or 15-240, usol 0-20000, gto 30-600)"

#define TCFG_KIND_NONE     0
#define TCFG_KIND_TCFG     1
#define TCFG_KIND_WDCFG    2
#define TCFG_KIND_PWRCFG   3
#define TCFG_KIND_CFGSNAP  4
#define TCFG_KIND_GPSCFG   5

struct Tcfg {
  uint32_t ci;       // 0 = silent Off (24 h safety modem check), else 30..1440 min
  char do_[8];       // canonical subset of "hcmsgt" (empty = none)
  uint32_t cs;       // 0 | 1 | 24 | 168 hours
  uint32_t qc;       // 0 = off, else 15..240 min
  char q_[4];        // canonical subset of "bu" (empty = none)
  uint32_t usol;     // 0..20000 mV (0 = day and night)
  uint32_t gto;      // 30..600 s
  int64_t at;        // rtc epoch when last applied (0 = never)
};

struct TcfgLegacy {
  uint32_t wd_int;   // tsimwd/int (0 already stored as 1440 on 1.7.2+)
  int hb, cmd, sms, smesh;
  uint32_t upm, usol;
  int lb_en;
  uint32_t lb_int;
  int cs_en;
  uint32_t cs_int;
  int gps_auto;
  uint32_t gps_to;
};

struct TcfgIdRing {
  char id[TCFG_ID_RING][TCFG_ID_LEN];
  uint8_t n;
  uint8_t head;
};

static inline void tcfgInit(Tcfg *t) {
  if (!t) return;
  memset(t, 0, sizeof(*t));
  t->ci = 360;
  memcpy(t->do_, "hc", 3);
  t->cs = 0;
  t->qc = 30;
  memcpy(t->q_, "u", 2);
  t->usol = 2000;
  t->gto = 180;
}

static inline const char *tcfgPrintDo(const Tcfg *t) {
  return (t && t->do_[0]) ? t->do_ : "-";
}
static inline const char *tcfgPrintQ(const Tcfg *t) {
  return (t && t->q_[0]) ? t->q_ : "-";
}

static inline bool tcfgHas(const char *letters, char c) {
  return letters && strchr(letters, c) != nullptr;
}
static inline bool tcfgDoHas(const Tcfg *t, char c) { return t && tcfgHas(t->do_, c); }
static inline bool tcfgQHas(const Tcfg *t, char c) { return t && tcfgHas(t->q_, c); }

static inline uint32_t tcfgCiSchedMin(uint32_t ci) {
  return ci == 0 ? TCFG_SAFETY_MIN : ci;
}

static inline bool tcfgCiOk(uint32_t v) {
  return v == 0 || (v >= TCFG_CI_MIN && v <= TCFG_CI_MAX);
}
static inline bool tcfgCsOk(uint32_t v) {
  return v == 0 || v == 1 || v == 24 || v == 168;
}
static inline bool tcfgQcOk(uint32_t v) {
  return v == 0 || (v >= TCFG_QC_MIN && v <= TCFG_QC_MAX);
}
static inline bool tcfgUsolOk(uint32_t v) { return v <= TCFG_USOL_MAX; }
static inline bool tcfgGtoOk(uint32_t v) {
  return v >= TCFG_GTO_MIN && v <= TCFG_GTO_MAX;
}

static inline uint32_t tcfgClampQc(uint32_t m) {
  if (m == 0) return 0;
  if (m < TCFG_QC_MIN) return TCFG_QC_MIN;
  if (m > TCFG_QC_MAX) return TCFG_QC_MAX;
  return m;
}

// Nearest of {0,1,24,168}. 0 is only returned for 0.
static inline uint32_t tcfgSnapCs(uint32_t h) {
  if (h == 0) return 0;
  if (tcfgCsOk(h)) return h;
  uint32_t d1 = h > 1 ? h - 1 : 1 - h;
  uint32_t d24 = h > 24 ? h - 24 : 24 - h;
  uint32_t d168 = h > 168 ? h - 168 : 168 - h;
  if (d1 <= d24 && d1 <= d168) return 1;
  if (d24 <= d168) return 24;
  return 168;
}

static inline void tcfgCanonLetters(const char *in, const char *order, char *out, size_t cap) {
  if (!out || cap == 0) return;
  out[0] = 0;
  if (!in || !order) return;
  bool none = (in[0] == 0) || (in[0] == '-' && in[1] == 0);
  if (none) return;
  size_t n = 0;
  for (const char *o = order; *o && n + 1 < cap; o++) {
    for (const char *p = in; *p; p++) {
      char c = (char)tolower((unsigned char)*p);
      if (c == *o) { out[n++] = *o; break; }
    }
  }
  out[n] = 0;
}
static inline void tcfgCanonDo(const char *in, char *out) { tcfgCanonLetters(in, TCFG_DO_ORDER, out, 8); }
static inline void tcfgCanonQ(const char *in, char *out) { tcfgCanonLetters(in, TCFG_Q_ORDER, out, 4); }

static inline void tcfgSetLetter(char *canon, size_t cap, const char *order, char letter, bool on) {
  if (!canon || !order || cap == 0) return;
  char tmp[12];
  tcfgCanonLetters(canon, order, tmp, sizeof(tmp));
  char in[16];
  size_t n = 0;
  for (char *p = tmp; *p && n + 2 < sizeof(in); p++) {
    if (*p == letter) continue;
    in[n++] = *p;
  }
  if (on && n + 2 < sizeof(in)) in[n++] = letter;
  in[n] = 0;
  tcfgCanonLetters(in, order, canon, cap);
}

static inline bool tcfgParseU32(const char *v, uint32_t *out) {
  if (!v || !*v || *v == '-' || *v == '+') return false;
  char *e = nullptr;
  unsigned long x = strtoul(v, &e, 10);
  if (!e || e == v || *e) return false;
  if (x > 0xFFFFFFFFUL) return false;
  if (out) *out = (uint32_t)x;
  return true;
}

static inline int tcfgApply(Tcfg *t, const char *args, bool *rejected) {
  if (rejected) *rejected = false;
  if (!t) return 0;
  const char *p = args ? args : "";
  int n = 0;
  while (*p) {
    while (*p == ' ' || *p == '\t') p++;
    if (!*p) break;
    const char *start = p;
    while (*p && *p != ' ' && *p != '\t') p++;
    char tok[96];
    size_t L = (size_t)(p - start);
    if (L >= sizeof(tok)) L = sizeof(tok) - 1;
    memcpy(tok, start, L); tok[L] = 0;
    char *eq = strchr(tok, '=');
    if (!eq) continue;
    *eq = 0;
    const char *k = tok, *v = eq + 1;
    if (!strcmp(k, "ci")) {
      uint32_t m;
      if (!tcfgParseU32(v, &m) || !tcfgCiOk(m)) { if (rejected) *rejected = true; }
      else { t->ci = m; n++; }
    } else if (!strcmp(k, "do")) {
      tcfgCanonDo(v, t->do_);
      n++;
    } else if (!strcmp(k, "cs")) {
      uint32_t m;
      if (!tcfgParseU32(v, &m) || !tcfgCsOk(m)) { if (rejected) *rejected = true; }
      else { t->cs = m; n++; }
    } else if (!strcmp(k, "qc")) {
      uint32_t m;
      if (!tcfgParseU32(v, &m) || !tcfgQcOk(m)) { if (rejected) *rejected = true; }
      else { t->qc = m; n++; }
    } else if (!strcmp(k, "q")) {
      tcfgCanonQ(v, t->q_);
      n++;
    } else if (!strcmp(k, "usol")) {
      uint32_t m;
      if (!tcfgParseU32(v, &m) || !tcfgUsolOk(m)) { if (rejected) *rejected = true; }
      else { t->usol = m; n++; }
    } else if (!strcmp(k, "gto")) {
      uint32_t m;
      if (!tcfgParseU32(v, &m) || !tcfgGtoOk(m)) { if (rejected) *rejected = true; }
      else { t->gto = m; n++; }
    }
    // unknown keys ignored
  }
  return n;
}

static inline int tcfgFormatApplied(char *out, size_t cap, int n, bool rej, const Tcfg *t) {
  if (!out || !cap) return 0;
  if (!t) { out[0] = 0; return 0; }
  return snprintf(out, cap, "TCFG applied %d%s: ci=%u do=%s cs=%u qc=%u q=%s usol=%u gto=%u",
                  n, rej ? TCFG_REJ_MSG : "",
                  t->ci, tcfgPrintDo(t), t->cs, t->qc, tcfgPrintQ(t), t->usol, t->gto);
}

static inline int tcfgJson(const Tcfg *t, char *dst, size_t cap) {
  if (!dst || !cap) return 0;
  if (!t) { dst[0] = 0; return 0; }
  return snprintf(dst, cap,
    "\"tcfg\":{\"v\":1,\"ci\":%u,\"do\":\"%s\",\"cs\":%u,\"qc\":%u,\"q\":\"%s\",\"usol\":%u,\"gto\":%u,\"safety\":1440,\"at\":%lld}",
    t->ci, tcfgPrintDo(t), t->cs, t->qc, tcfgPrintQ(t), t->usol, t->gto, (long long)t->at);
}

// Seed tsimci from 1.7.x NVS. Legacy int 1440 (and 0) stay ci=1440: firmware cannot tell
// "off" from "24 h". The dashboard sends an explicit TCFG after upgrade.
static inline void tcfgSeedFromLegacy(Tcfg *t, const TcfgLegacy *L) {
  tcfgInit(t);
  if (!t || !L) return;
  uint32_t ci = L->wd_int == 0 ? TCFG_SAFETY_MIN : L->wd_int;
  if (ci < TCFG_CI_MIN || ci > TCFG_CI_MAX) ci = 180;
  t->ci = ci;
  char d[8]; int n = 0;
  if (L->hb) d[n++] = 'h';
  if (L->cmd) d[n++] = 'c';
  if (L->smesh) d[n++] = 'm';
  if (L->cs_en) d[n++] = 's';
  if (L->gps_auto) d[n++] = 'g';
  if (L->sms) d[n++] = 't';
  d[n] = 0;
  tcfgCanonDo(d, t->do_);
  t->cs = tcfgSnapCs(L->cs_int);
  bool b = L->lb_en != 0;
  bool u = L->upm != 0;
  t->q_[0] = 0;
  t->qc = 0;
  if (b || u) {
    char q[4]; int i = 0;
    if (b) q[i++] = 'b';
    if (u) q[i++] = 'u';
    q[i] = 0;
    tcfgCanonQ(q, t->q_);
    if (b && u) {
      uint32_t x = tcfgClampQc(L->lb_int ? L->lb_int : TCFG_QC_MIN);
      uint32_t y = tcfgClampQc(L->upm);
      t->qc = x < y ? x : y;
    } else if (b) t->qc = tcfgClampQc(L->lb_int ? L->lb_int : 30);
    else t->qc = tcfgClampQc(L->upm);
  }
  t->usol = L->usol <= TCFG_USOL_MAX ? L->usol : 2000;
  t->gto = tcfgGtoOk(L->gps_to) ? L->gps_to : 180;
  t->at = 0;
}

// WDCFG int (as sent): 0 -> ci=0 silent Off. Else clamp into 30..1440.
static inline uint32_t tcfgMapWdIntToCi(uint32_t sent) {
  if (sent == 0) return 0;
  if (sent < TCFG_CI_MIN) return TCFG_CI_MIN;
  if (sent > TCFG_CI_MAX) return TCFG_CI_MAX;
  return sent;
}
static inline uint32_t tcfgLegacyIntFromCi(uint32_t ci) {
  return ci == 0 ? TCFG_SAFETY_MIN : ci;
}

static inline void tcfgMapWdHb(Tcfg *t, int hb) { if (t) tcfgSetLetter(t->do_, 8, TCFG_DO_ORDER, 'h', hb != 0); }
static inline void tcfgMapWdCmd(Tcfg *t, int cmd) { if (t) tcfgSetLetter(t->do_, 8, TCFG_DO_ORDER, 'c', cmd != 0); }
static inline void tcfgMapWdSms(Tcfg *t, int sms) { if (t) tcfgSetLetter(t->do_, 8, TCFG_DO_ORDER, 't', sms != 0); }
static inline void tcfgMapWdSmesh(Tcfg *t, int smesh) { if (t) tcfgSetLetter(t->do_, 8, TCFG_DO_ORDER, 'm', smesh != 0); }
static inline void tcfgMapCsEn(Tcfg *t, int en) { if (t) tcfgSetLetter(t->do_, 8, TCFG_DO_ORDER, 's', en != 0); }
static inline void tcfgMapGpsAuto(Tcfg *t, int auto_on) { if (t) tcfgSetLetter(t->do_, 8, TCFG_DO_ORDER, 'g', auto_on != 0); }

// upoll=0 -> clear 'u' (qc=0 if q empty). upoll=N -> set 'u', qc=N (min with existing qc if 'b').
static inline void tcfgMapUpoll(Tcfg *t, uint32_t upoll) {
  if (!t) return;
  if (upoll == 0) {
    tcfgSetLetter(t->q_, 4, TCFG_Q_ORDER, 'u', false);
    if (!t->q_[0]) t->qc = 0;
    return;
  }
  uint32_t n = tcfgClampQc(upoll);
  tcfgSetLetter(t->q_, 4, TCFG_Q_ORDER, 'u', true);
  if (tcfgQHas(t, 'b') && t->qc != 0) t->qc = n < t->qc ? n : t->qc;
  else t->qc = n;
}

// PWRCFG en=1 -> set 'b' (qc = int if qc was 0). en=0 -> clear 'b'. int -> qc (clamped).
static inline void tcfgMapPwr(Tcfg *t, bool en_set, int en, bool int_set, uint32_t interval) {
  if (!t) return;
  if (en_set) {
    tcfgSetLetter(t->q_, 4, TCFG_Q_ORDER, 'b', en != 0);
    if (en && t->qc == 0) {
      uint32_t src = int_set ? interval : 30;
      t->qc = tcfgClampQc(src ? src : 30);
    }
    if (!en && !tcfgQHas(t, 'u')) t->qc = 0;
  }
  if (int_set) t->qc = tcfgClampQc(interval);
}

static inline bool tcfgQcEnabled(const Tcfg *t) {
  return t && t->qc > 0 && t->q_[0];
}

// Data on a timed check-in: any of h,c,m,s,g,t, or pending reports.
// Silent Off (ci=0): data only if recovery happened or a report is pending.
static inline bool tcfgCiWantsData(const Tcfg *t, bool recovered, bool pending) {
  if (!t) return pending || recovered;
  if (t->ci == 0) return recovered || pending;
  return t->do_[0] != 0 || pending || recovered;
}

static inline int64_t tcfgTolSecs(uint32_t interval_min) {
  uint32_t m = interval_min ? interval_min : TCFG_SAFETY_MIN;
  int64_t t = (int64_t)m * 6;   // 10% of the interval, in seconds
  if (t < TCFG_TOL_MIN_S) t = TCFG_TOL_MIN_S;
  return t;
}

static inline bool tcfgIsDue(int64_t now, int64_t due, uint32_t interval_min) {
  if (due <= 0) return true;
  return now >= due - tcfgTolSecs(interval_min);
}

// Failure backoff: 30, 60, 120, ... min, capped at the (safety) interval.
static inline int64_t tcfgBackoffSecs(uint8_t fails, uint32_t interval_min) {
  uint32_t iv = tcfgCiSchedMin(interval_min);
  int64_t secs = (int64_t)iv * 60;
  if (!fails) return secs;
  unsigned sh = fails > 1 ? (fails - 1 > 4 ? 4 : (unsigned)(fails - 1)) : 0;
  int64_t b = 1800LL << sh;
  if (b < secs) secs = b;
  return secs;
}

static inline void tcfgTakeSecs(int64_t *best, int64_t secs) {
  if (secs < TCFG_SLEEP_FLOOR_S) secs = TCFG_SLEEP_FLOOR_S;
  if (!best) return;
  if (*best < 0 || secs < *best) *best = secs;
}

// Next sleep: min(ci_due, qc_due, GNSS warm-window end). Always 5 s .. 24 h.
// ext0-failed path is 60 s. ci_due already includes failure backoff.
static inline int64_t tcfgSleepTimerSecs(bool ext0_failed, int64_t now,
                                         int64_t ci_due, uint32_t ci_sched_min,
                                         bool qc_on, int64_t qc_due, uint32_t qc_min,
                                         bool gnss_on, int64_t gnss_off_at) {
  if (ext0_failed) return 60;
  int64_t best = -1;
  int64_t ci_wait = ci_due > 0 ? ci_due - now : (int64_t)(ci_sched_min ? ci_sched_min : TCFG_SAFETY_MIN) * 60;
  tcfgTakeSecs(&best, ci_wait);
  if (qc_on) {
    int64_t q_wait = qc_due > 0 ? qc_due - now : (int64_t)(qc_min ? qc_min : TCFG_QC_MIN) * 60;
    tcfgTakeSecs(&best, q_wait);
  }
  if (gnss_on) tcfgTakeSecs(&best, gnss_off_at - now);
  if (best < 0 || best > (int64_t)TCFG_SAFETY_MIN * 60) best = (int64_t)TCFG_SAFETY_MIN * 60;
  return best;
}

static inline bool tcfgIdSeen(const TcfgIdRing *r, const char *id) {
  if (!r || !id || !id[0] || !r->n) return false;
  for (uint8_t i = 0; i < r->n; i++) {
    uint8_t idx = (uint8_t)((r->head + TCFG_ID_RING - 1 - i) % TCFG_ID_RING);
    if (!strcmp(r->id[idx], id)) return true;
  }
  return false;
}

static inline void tcfgIdPush(TcfgIdRing *r, const char *id) {
  if (!r || !id || !id[0]) return;
  size_t n = strlen(id);
  if (n >= TCFG_ID_LEN) n = TCFG_ID_LEN - 1;
  memcpy(r->id[r->head], id, n);
  r->id[r->head][n] = 0;
  r->head = (uint8_t)((r->head + 1) % TCFG_ID_RING);
  if (r->n < TCFG_ID_RING) r->n++;
}

static inline void tcfgIdClear(TcfgIdRing *r) {
  if (!r) return;
  memset(r, 0, sizeof(*r));
}

static inline int tcfgCmdKind(const char *cmd) {
  if (!cmd) return TCFG_KIND_NONE;
  while (*cmd == ' ' || *cmd == '\t') cmd++;
  if (!strncasecmp(cmd, "TCFG", 4) && (cmd[4] == 0 || cmd[4] == ' ')) return TCFG_KIND_TCFG;
  if (!strncasecmp(cmd, "WDCFG", 5) && (cmd[5] == 0 || cmd[5] == ' ')) return TCFG_KIND_WDCFG;
  if (!strncasecmp(cmd, "PWRCFG", 6) && (cmd[6] == 0 || cmd[6] == ' ')) return TCFG_KIND_PWRCFG;
  if (!strncasecmp(cmd, "CFGSNAP", 7) && (cmd[7] == 0 || cmd[7] == ' ')) return TCFG_KIND_CFGSNAP;
  if (!strncasecmp(cmd, "GPSCFG", 6) && (cmd[6] == 0 || cmd[6] == ' ')) return TCFG_KIND_GPSCFG;
  return TCFG_KIND_NONE;
}

static inline const char *tcfgKindName(int k) {
  switch (k) {
    case TCFG_KIND_TCFG: return "TCFG";
    case TCFG_KIND_WDCFG: return "WDCFG";
    case TCFG_KIND_PWRCFG: return "PWRCFG";
    case TCFG_KIND_CFGSNAP: return "CFGSNAP";
    case TCFG_KIND_GPSCFG: return "GPSCFG";
    default: return "";
  }
}

// Within one fetch, only the last of each config kind is applied.
static inline void tcfgMarkSuperseded(const int *kinds, int n, bool *superseded) {
  if (!kinds || !superseded || n <= 0) return;
  int last[6];
  for (int k = 0; k < 6; k++) last[k] = -1;
  for (int i = 0; i < n; i++) {
    superseded[i] = false;
    int k = kinds[i];
    if (k >= TCFG_KIND_TCFG && k <= TCFG_KIND_GPSCFG) last[k] = i;
  }
  for (int i = 0; i < n; i++) {
    int k = kinds[i];
    if (k >= TCFG_KIND_TCFG && k <= TCFG_KIND_GPSCFG && i != last[k]) superseded[i] = true;
  }
}

// System commands that must still run when the console budget is exhausted.
static inline bool tcfgIsSysCmd(const char *cmd) {
  if (!cmd) return false;
  while (*cmd == ' ' || *cmd == '\t') cmd++;
  if (!strncasecmp(cmd, "TSIMUPDATE ", 11)) return true;
  if (!strncasecmp(cmd, "PWRCFG ", 7)) return true;
  if (!strncasecmp(cmd, "CFGSNAP ", 8)) return true;
  if (!strncasecmp(cmd, "WDCFG ", 6)) return true;
  if (!strncasecmp(cmd, "UPDATE ", 7)) return true;
  if (!strncasecmp(cmd, "TCFG", 4) && (cmd[4] == 0 || cmd[4] == ' ')) return true;
  if (!strncasecmp(cmd, "GPS", 3)) return true;   // GPSFIX / GPSCFG (same prefix as 1.7.x)
  return false;
}
