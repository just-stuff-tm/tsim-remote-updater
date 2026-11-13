// v1.7.9: 3GPP eDRX / PSM decisions (no Arduino). Shared by main.cpp and firmware/test/host_test.cpp.
//
// A76XX AT+CEDRXS <mode> (manual v1.12 section 34.2.4) is NOT 3GPP 27.007:
//   manual: 0 disable, 1 enable, 2 disable+discard, 3 enable eDRX
//   27.007: 0 disable, 1 enable, 2 enable+URC, 3 disable+discard
// Modes 2 and 3 are ambiguous, so this firmware sends only mode 1 (enable) and mode 0 (disable).
// AcT 4 is E-UTRAN WB-S1 in 27.007. The modem test response is (1-5) and the read example is
// +CEDRXS: 4,"". The manual's AcT table (which calls 4 "GSM") is not used.
// Do not wait for the +CEDRXP URC. The network grant is AT+CEDRXRDP, once, no retry loop.
//
// AT+CPSMS (manual section 34.2.2): mode 0 disable, 1 enable, 2 disable+discard. Only 0 and 1 are sent.
// T3412-ext and T3324 are one byte, 3GPP TS 24.008: bits 8-6 unit, bits 5-1 value.
//   GPRS Timer 3 (T3412 extended, table 10.5.163a): unit 001 = 1 hour.  "00100001" = 1 hour.
//   GPRS Timer 2 (T3324, table 10.5.163):           unit 001 = 1 minute. "00100010" = 2 minutes.
// A76XX AT+CPSMS? echoes the REQUESTED timers, not the network grant. The grant is unknown.
// AT+MEDCR (hardware PSM, manual 34.2.3) is not used.
#pragma once
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LP_EDRX_ACT     4
#define LP_EDRX_DEFAULT "0010"       // 20.48 s (eDRX cycle 0010). Allowed cycles are 0000..0101 (5.12 s .. 81.92 s).
#define LP_PSM_TAU      "00100001"   // T3412-ext, 1 hour
#define LP_PSM_ACT      "00100010"   // T3324, 2 minutes

struct LpCfg {
  int edrx;        // 0 or 1
  char edrxv[5];   // 4-bit cycle, NUL terminated
  int psm;         // 0 or 1
};

struct LpEdrxRd {
  int act;         // -1 if the line was not parsed
  char req[8];
  char nw[8];
  char ptw[8];
  int ok;
};

struct LpPsmRd {
  int mode;        // -1 if the line was not parsed
  char tau[12];    // requested T3412, as echoed
  char actt[12];   // requested T3324, as echoed
  int ok;
  int grant_known; // always 0: A76XX does not report the network grant here
};

struct LpTel {
  char edrx_req[8];
  char edrx_nw[8];
  char psm_tau[12];
  char psm_act[12];
  int psm_grant_known;
};

static inline bool lpBits(const char *s, int n) {
  if (!s) return false;
  for (int i = 0; i < n; i++) {
    if (s[i] != '0' && s[i] != '1') return false;
  }
  return s[n] == 0;
}

// "0000".."0101" only, so a requested cycle cannot push MT SMS latency past 81.92 s.
static inline bool lpEdrxValueOk(const char *v) {
  if (!lpBits(v, 4) || v[0] != '0') return false;
  if (v[1] == '0') return true;
  return v[1] == '1' && v[2] == '0';
}

static inline int lpBit01(const char *v) {
  if (!v || (v[0] != '0' && v[0] != '1') || v[1] != 0) return -1;
  return v[0] - '0';
}

static inline void lpCfgInit(LpCfg *c) {
  c->edrx = 0;
  memcpy(c->edrxv, LP_EDRX_DEFAULT, 5);
  c->psm = 0;
}

// 1 applied, 0 not a low-power key, -1 rejected.
static inline int lpCfgToken(LpCfg *c, const char *k, const char *v) {
  if (!c || !k || !v) return 0;
  if (!strcmp(k, "edrx")) {
    int b = lpBit01(v);
    if (b < 0) return -1;
    c->edrx = b;
    return 1;
  }
  if (!strcmp(k, "edrxv")) {
    if (!lpEdrxValueOk(v)) return -1;
    memcpy(c->edrxv, v, 4);
    c->edrxv[4] = 0;
    return 1;
  }
  if (!strcmp(k, "psm")) {
    int b = lpBit01(v);
    if (b < 0) return -1;
    c->psm = b;
    return 1;
  }
  return 0;
}

// unit is 3 bits, value is 5 bits. Out is 8 chars plus NUL.
static inline bool lpTimerEncode(unsigned unit, unsigned value, char out[9]) {
  if (!out || unit > 7 || value > 31) return false;
  unsigned b = ((unit & 7u) << 5) | (value & 31u);
  for (int i = 7; i >= 0; i--) out[7 - i] = (b & (1u << i)) ? '1' : '0';
  out[8] = 0;
  return true;
}

static inline int lpCedrxsCmd(char *out, size_t cap, int enable, const char *cycle) {
  if (!out || cap < 8) return -1;
  if (!enable) return snprintf(out, cap, "AT+CEDRXS=0");
  if (!lpEdrxValueOk(cycle)) return -1;
  return snprintf(out, cap, "AT+CEDRXS=1,%d,\"%s\"", LP_EDRX_ACT, cycle);
}

static inline int lpCpsmsCmd(char *out, size_t cap, int enable) {
  if (!out || cap < 8) return -1;
  if (!enable) return snprintf(out, cap, "AT+CPSMS=0");
  return snprintf(out, cap, "AT+CPSMS=1,,,\"%s\",\"%s\"", LP_PSM_TAU, LP_PSM_ACT);
}

static inline int lpAppliedFragment(char *out, size_t cap, int edrx, const char *edrxv, int psm) {
  const char *cyc = lpEdrxValueOk(edrxv) ? edrxv : LP_EDRX_DEFAULT;
  return snprintf(out, cap, "edrx=%d edrxv=%s psm=%d", edrx ? 1 : 0, cyc, psm ? 1 : 0);
}

static inline const char *lpSkipWs(const char *p) {
  while (*p == ' ' || *p == '\t') p++;
  return p;
}

// One comma-separated field. *more is set when another field follows.
static inline const char *lpField(const char *p, char *dst, size_t cap, bool *more) {
  p = lpSkipWs(p);
  size_t n = 0;
  if (*p == '"') {
    p++;
    while (*p && *p != '"' && *p != '\r' && *p != '\n') {
      if (n + 1 < cap) dst[n++] = *p;
      p++;
    }
    if (*p == '"') p++;
  } else {
    while (*p && *p != ',' && *p != '\r' && *p != '\n') {
      if (*p != ' ' && n + 1 < cap) dst[n++] = *p;
      p++;
    }
  }
  dst[n] = 0;
  p = lpSkipWs(p);
  if (*p == ',') { *more = true; return p + 1; }
  *more = false;
  return p;
}

static inline bool lpParseCedrxrdp(const char *resp, LpEdrxRd *o) {
  memset(o, 0, sizeof(*o));
  o->act = -1;
  if (!resp) return false;
  const char *p = strstr(resp, "+CEDRXRDP:");
  if (!p) return false;
  p += 10;
  p = lpSkipWs(p);
  if (*p < '0' || *p > '9') return false;
  char *e = nullptr;
  long act = strtol(p, &e, 10);
  if (e == p) return false;
  o->act = (int)act;
  o->ok = 1;
  p = lpSkipWs(e);
  if (*p != ',') return true;
  p++;
  char f[3][16];
  bool more = true;
  for (int i = 0; i < 3 && more; i++) {
    f[i][0] = 0;
    p = lpField(p, f[i], sizeof(f[i]), &more);
    if (i == 0) snprintf(o->req, sizeof(o->req), "%s", f[i]);
    else if (i == 1) snprintf(o->nw, sizeof(o->nw), "%s", f[i]);
    else snprintf(o->ptw, sizeof(o->ptw), "%s", f[i]);
  }
  return true;
}

static inline bool lpParseCpsms(const char *resp, LpPsmRd *o) {
  memset(o, 0, sizeof(*o));
  o->mode = -1;
  o->grant_known = 0;
  if (!resp) return false;
  const char *p = strstr(resp, "+CPSMS:");
  if (!p) return false;
  p += 7;
  p = lpSkipWs(p);
  if (*p < '0' || *p > '9') return false;
  char *e = nullptr;
  long mode = strtol(p, &e, 10);
  if (e == p) return false;
  o->mode = (int)mode;
  o->ok = 1;
  p = lpSkipWs(e);
  if (*p != ',') return true;
  p++;
  char f[4][16];
  bool more = true;
  int n = 0;
  while (more && n < 4) {
    f[n][0] = 0;
    p = lpField(p, f[n], sizeof(f[n]), &more);
    n++;
  }
  if (n > 2) snprintf(o->tau, sizeof(o->tau), "%s", f[2]);
  if (n > 3) snprintf(o->actt, sizeof(o->actt), "%s", f[3]);
  return true;
}

// edrx_nw / psm timers: a granted or echoed value, else "rej" (asked and not given) or "none" (off).
// psm_grant_known stays 0. CPSMS? is not a grant.
static inline void lpClassify(int edrx_on, const char *configured, const LpEdrxRd *er, int er_valid,
                              int psm_on, const LpPsmRd *pr, int pr_valid, LpTel *t) {
  memset(t, 0, sizeof(*t));
  t->psm_grant_known = 0;
  const char *cycle = lpEdrxValueOk(configured) ? configured : LP_EDRX_DEFAULT;
  if (er_valid && er && lpEdrxValueOk(er->req)) snprintf(t->edrx_req, sizeof(t->edrx_req), "%s", er->req);
  else snprintf(t->edrx_req, sizeof(t->edrx_req), "%s", cycle);
  if (!er_valid || !er || er->act == 0 || !lpBits(er->nw, 4))
    snprintf(t->edrx_nw, sizeof(t->edrx_nw), "%s", edrx_on ? "rej" : "none");
  else
    snprintf(t->edrx_nw, sizeof(t->edrx_nw), "%s", er->nw);
  if (!pr_valid || !pr) {
    snprintf(t->psm_tau, sizeof(t->psm_tau), "rej");
    snprintf(t->psm_act, sizeof(t->psm_act), "rej");
  } else {
    if (lpBits(pr->tau, 8)) snprintf(t->psm_tau, sizeof(t->psm_tau), "%s", pr->tau);
    else snprintf(t->psm_tau, sizeof(t->psm_tau), "%s", psm_on ? "rej" : "none");
    if (lpBits(pr->actt, 8)) snprintf(t->psm_act, sizeof(t->psm_act), "%s", pr->actt);
    else snprintf(t->psm_act, sizeof(t->psm_act), "%s", psm_on ? "rej" : "none");
  }
}

// Telemetry strings are copied into JSON. Anything else becomes the fallback.
static inline const char *lpJsonTok(const char *s, const char *fallback) {
  if (!s || !s[0] || !fallback) return fallback ? fallback : "";
  size_t n = strlen(s);
  if (n > 8) return fallback;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return fallback;
  }
  return s;
}
