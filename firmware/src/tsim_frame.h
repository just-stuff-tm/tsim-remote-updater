// v1.7.7: pure parser for the repeater's "tsim wake" frames. No Arduino.
// The Heltec sends "@TSIM <CMD> <seq>\r\n" (CMD upper-case, seq 1..65535) and expects
// "@TSIM ACK <seq>\r\n". It echoes that ACK back, which must be ignored.
#pragma once
#include <ctype.h>
#include <stdint.h>
#include <string.h>

enum { TF_NONE = 0, TF_IGNORE = 1, TF_CMD = 2, TF_REJECT = 3 };

struct TsimFrame { char cmd[16]; unsigned seq; };

// Allowlist the repeater is written for. Anything else is rejected (no ACK).
static inline bool tsimCmdAllowed(const char *cmd) {
  return cmd && (!strcmp(cmd, "WAKE") || !strcmp(cmd, "STATUS") || !strcmp(cmd, "MODEM_RESET"));
}

// One complete line, without the CR/LF. Leading spaces are skipped.
static inline int tsimParseLine(const char *line, TsimFrame *out) {
  if (!line) return TF_NONE;
  while (*line == ' ' || *line == '\t') line++;
  if (strncmp(line, "@TSIM ", 6) != 0) return TF_NONE;
  const char *p = line + 6;
  if (!strncmp(p, "ACK", 3) && (p[3] == 0 || p[3] == ' ')) return TF_IGNORE;
  char cmd[16];
  int n = 0;
  while (*p && *p != ' ' && *p != '\t') {
    unsigned char c = (unsigned char)*p++;
    if (n >= 15 || !(isalnum(c) || c == '_')) return TF_REJECT;
    cmd[n++] = (char)toupper(c);
  }
  cmd[n] = 0;
  if (!n) return TF_REJECT;
  while (*p == ' ' || *p == '\t') p++;
  if (!isdigit((unsigned char)*p)) return TF_REJECT;
  unsigned seq = 0;
  while (isdigit((unsigned char)*p)) {
    seq = seq * 10u + (unsigned)(*p - '0');
    if (seq > 65535u) return TF_REJECT;
    p++;
  }
  if (*p || seq == 0) return TF_REJECT;
  if (!tsimCmdAllowed(cmd)) return TF_REJECT;
  if (out) {
    memcpy(out->cmd, cmd, sizeof(out->cmd));
    out->seq = seq;
  }
  return TF_CMD;
}
