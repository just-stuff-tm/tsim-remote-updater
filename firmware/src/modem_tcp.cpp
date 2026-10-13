#include "modem_tcp.h"

extern void netlog(const char *fmt, ...);

static void drain(HardwareSerial &s) { while (s.available()) s.read(); }

static bool readLine(HardwareSerial &s, String &out, uint32_t timeout) {
  out = "";
  uint32_t t0 = millis();
  while (millis() - t0 < timeout) {
    while (s.available()) {
      char c = (char)s.read();
      if (c == '\n') return true;
      if (c != '\r') out += c;
      if (out.length() > 600) return true;
    }
    delay(1);
  }
  return false;
}

bool ModemTcpClient::waitFor(const char *a, const char *b, uint32_t timeout, String *acc) {
  uint32_t t0 = millis();
  String line;
  while (millis() - t0 < timeout) {
    if (!readLine(_s, line, timeout - (millis() - t0))) break;
    if (!line.length()) continue;
    if (acc) { *acc += line; *acc += '\n'; }
    if (line.startsWith("+IPCLOSE:") || line.startsWith("+CIPCLOSE:")) { noteClose(line); }
    // CIPCLOSE already-closed (err 4): treat as success when looking for CIPCLOSE
    if (a && line.indexOf(a) >= 0) {
      if (line.startsWith("+CIPCLOSE:") && line.indexOf(",4") >= 0) return true;
      return true;
    }
    if (b && line.indexOf(b) >= 0) {
      // "+CIPCLOSE: 0,4" often followed by ERROR — still success
      if (line.startsWith("+CIPCLOSE:") && line.indexOf(",4") >= 0) return true;
      if (acc && acc->indexOf("+CIPCLOSE:") >= 0 && acc->indexOf(",4") >= 0) return true;
      return false;
    }
  }
  return false;
}

bool ModemTcpClient::netOpen(HardwareSerial &s) {
  ModemTcpClient tmp(s);
  String acc;
  drain(s);
  s.print("AT+NETOPEN?\r\n");
  tmp.waitFor("OK", "ERROR", 3000, &acc);
  if (acc.indexOf("+NETOPEN: 1") >= 0) {
    drain(s);
    s.print("AT+CIPRXGET=1\r\n");
    acc = "";
    if (tmp.waitFor("OK", "ERROR", 3000, &acc)) {
      netlog("TCP: NETOPEN already up, CIPRXGET=1 OK");
      return true;
    }
    netlog("TCP: CIPRXGET=1 refused while open -> NETCLOSE/reopen");
    netClose(s);
  }
  drain(s);
  s.print("AT+CIPRXGET=1\r\n");
  acc = "";
  tmp.waitFor("OK", "ERROR", 3000, &acc);
  netlog("TCP: CIPRXGET=1 -> %s", acc.indexOf("OK") >= 0 ? "OK" : acc.c_str());
  drain(s);
  s.print("AT+NETOPEN\r\n");
  acc = "";
  uint32_t t0 = millis();
  while (millis() - t0 < 30000) {
    if (!tmp.waitFor("+NETOPEN:", "already opened", 30000 - (millis() - t0), &acc)) {
      if (acc.indexOf("already opened") >= 0) { netlog("TCP: NETOPEN already opened"); return true; }
      break;
    }
    if (acc.indexOf("+NETOPEN: 0") >= 0) { netlog("TCP: NETOPEN OK"); return true; }
    netlog("TCP: NETOPEN fail: %.120s", acc.c_str());
    return false;
  }
  netlog("TCP: NETOPEN timeout: %.120s", acc.c_str());
  return false;
}

void ModemTcpClient::netClose(HardwareSerial &s) {
  ModemTcpClient tmp(s);
  drain(s);
  s.print("AT+NETCLOSE\r\n");
  tmp.waitFor("+NETCLOSE:", "ERROR", 10000);
}

int ModemTcpClient::connect(IPAddress ip, uint16_t port) {
  char h[20];
  snprintf(h, sizeof(h), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
  return connect(h, port);
}

int ModemTcpClient::connect(const char *host, uint16_t port) {
  stop();
  _rx_len = _rx_pos = 0; _rest_len = 0; _raw_total = 0; _next_dbg = 16384; _rx_errors = 0;
  _remote_closed = false;
  drain(_s);
  _s.printf("AT+CIPOPEN=%u,\"TCP\",\"%s\",%u\r\n", _mux, host, port);
  String acc;
  char want[24];
  snprintf(want, sizeof(want), "+CIPOPEN: %u,", _mux);
  if (!waitFor(want, "ERROR", 30000, &acc)) {
    netlog("TCP: CIPOPEN %s:%u failed: %.120s", host, port, acc.c_str());
    return 0;
  }
  int p = acc.indexOf(want);
  int err = acc.substring(p + strlen(want)).toInt();
  if (err != 0) {
    netlog("TCP: CIPOPEN %s:%u err=%d", host, port, err);
    return 0;
  }
  _connected = true; _last_conn = 1; _close_reason = -1;
  netlog("TCP: connected %s:%u", host, port);
  return 1;
}

size_t ModemTcpClient::write(const uint8_t *buf, size_t size) {
  if (!_connected) return 0;
  size_t sent = 0;
  while (sent < size) {
    size_t n = size - sent;
    if (n > 1400) n = 1400;
    drain(_s);
    _s.printf("AT+CIPSEND=%u,%u\r\n", _mux, (unsigned)n);
    uint32_t t0 = millis();
    bool prompt = false;
    while (millis() - t0 < 5000) {
      if (_s.available()) {
        char c = (char)_s.read();
        if (c == '>') { prompt = true; break; }
      } else delay(1);
    }
    if (!prompt) { netlog("TCP: CIPSEND no prompt"); setWriteError(1); return sent; }
    _s.write(buf + sent, n);
    String acc;
    char want[24];
    snprintf(want, sizeof(want), "+CIPSEND: %u,", _mux);
    if (!waitFor(want, "ERROR", 15000, &acc)) {
      netlog("TCP: CIPSEND fail: %.100s", acc.c_str());
      setWriteError(2);
      return sent;
    }
    sent += n;
  }
  return sent;
}

// Read one CR/LF-terminated header line from the modem WITHOUT touching any
// bytes beyond the '\n'. Used only for AT response/URC lines, never payload.
static bool readHdrLine(HardwareSerial &s, String &out, uint32_t timeout) {
  out = "";
  uint32_t t0 = millis();
  while (millis() - t0 < timeout) {
    int c = s.read();
    if (c < 0) { delay(1); continue; }
    if (c == '\n') return true;
    if (c != '\r') out += (char)c;
    if (out.length() > 200) return true;
  }
  return false;
}

// Only a close URC for OUR link counts: "+IPCLOSE: <link>,<reason>" / "+CIPCLOSE: <link>,<err>"
void ModemTcpClient::noteClose(const String &line) {
  int link = -1, reason = -1;
  const char *c = line.c_str();
  if (sscanf(c, "+IPCLOSE: %d,%d", &link, &reason) < 1 && sscanf(c, "+CIPCLOSE: %d,%d", &link, &reason) < 1) return;
  if (link != _mux) return;
  if (!_remote_closed) netlog("TCP: link %d closed by modem URC '%s' (rest_len=%d raw=%lu)", link, c, _rest_len, (unsigned long)_raw_total);
  _remote_closed = true;
  _close_reason = reason;
}

int ModemTcpClient::pollModem(size_t want) {
  if (want > sizeof(_rx)) want = sizeof(_rx);
  if (want > 1460) want = 1460;
  // Only discard stray text if nothing is mid-flight. We never blindly drain
  // here anymore: draining could swallow payload bytes of a late response.
  _s.printf("AT+CIPRXGET=2,%u,%u\r\n", _mux, (unsigned)want);
  String line;
  uint32_t t0 = millis();
  while (millis() - t0 < 5000) {
    if (!readHdrLine(_s, line, 5000 - (millis() - t0))) break;
    if (!line.length()) continue;
    if (line.startsWith("+IPCLOSE:") || line.startsWith("+CIPCLOSE:")) { noteClose(line); continue; }
    if (line.startsWith("+CIPRXGET: 1")) continue;  // "data arrived" URC: header only, no payload
    if (line.startsWith("+CIPRXGET: 2,")) {
      int mux = -1, rl = -1, rest = -1;
      if (sscanf(line.c_str(), "+CIPRXGET: 2,%d,%d,%d", &mux, &rl, &rest) < 3 || rl < 0 || rl > (int)sizeof(_rx)) {
        netlog("TCP: bad CIPRXGET hdr '%s'", line.c_str());
        _rx_errors++;
        return -1;
      }
      // Exactly rl raw bytes, pure binary (CR/LF inside payload preserved).
      int got = 0;
      uint32_t t1 = millis();
      while (got < rl && millis() - t1 < 5000) {
        int av = _s.available();
        if (av > 0) {
          if (av > rl - got) av = rl - got;
          got += _s.readBytes(_rx + got, av);
          t1 = millis();
        } else delay(1);
      }
      if (got != rl) {
        netlog("TCP: short payload %d/%d (UART overrun?) rest=%d", got, rl, rest);
        _rx_errors++;
      }
      _rx_len = got; _rx_pos = 0;
      _rest_len = rest;
      _raw_total += got;
      if (_raw_total >= _next_dbg) {
        netlog("TCP-DBG: raw=%lu rest_len=%d last_rl=%d errs=%u", (unsigned long)_raw_total, rest, rl, _rx_errors);
        _next_dbg += 16384;
      }
      // Trailer: "\r\nOK\r\n" (URCs may interleave)
      String tail; uint32_t t2 = millis();
      while (millis() - t2 < 2000) {
        if (!readHdrLine(_s, tail, 2000)) break;
        if (tail == "OK") break;
        if (tail.startsWith("+IPCLOSE:") || tail.startsWith("+CIPCLOSE:")) { noteClose(tail); }
      }
      return got;
    }
    if (line.indexOf("No data") >= 0) {
      _rest_len = 0;
      String t; readHdrLine(_s, t, 300); if (!t.length()) readHdrLine(_s, t, 300); // eat trailing ERROR
      return 0;
    }
    if (line.indexOf("ERROR") >= 0) {
      netlog("TCP: CIPRXGET=2 got '%s' (closed=%d) - link kept", line.c_str(), (int)_remote_closed);
      return 0;
    }
    // A bare "OK" is never a valid CIPRXGET=2 reply (data -> +CIPRXGET: 2 header,
    // empty -> +IP ERROR). It is a stale trailer of an earlier command: skip it
    // instead of returning, otherwise every later reply is read by the wrong command.
    if (line == "OK") { _stale_ok++; continue; }
  }
  netlog("TCP: CIPRXGET=2 no response");
  _rx_errors++;
  return -1;
}

int ModemTcpClient::queryRxRemaining() {
  // AT+CIPRXGET=4,<mux> -> +CIPRXGET: 4,<mux>,<remain> \r\n OK. Consume through
  // the final OK synchronously so no stale trailer desyncs the next command.
  _s.printf("AT+CIPRXGET=4,%u\r\n", _mux);
  String line; int rem = -1;
  uint32_t t0 = millis();
  while (millis() - t0 < 2000) {
    if (!readHdrLine(_s, line, 2000 - (millis() - t0))) break;
    if (!line.length()) continue;
    if (line.startsWith("+IPCLOSE:") || line.startsWith("+CIPCLOSE:")) { noteClose(line); continue; }
    if (line.startsWith("+CIPRXGET: 4,")) {
      int mux = 0, r = 0;
      if (sscanf(line.c_str(), "+CIPRXGET: 4,%d,%d", &mux, &r) >= 2) rem = r;
      continue;
    }
    if (line.startsWith("+CIPRXGET: 1")) continue;
    if (line == "OK") return rem < 0 ? 0 : rem;
    if (line.indexOf("ERROR") >= 0) return rem;
  }
  return rem;
}

int ModemTcpClient::available() {
  if (_rx_pos < _rx_len) return (int)(_rx_len - _rx_pos);
  if (!_connected && !_remote_closed) return 0;
  // Bound poll rate — never flood CIPRXGET when empty
  if (_rest_len <= 0 && millis() - _last_poll < 20) {
    // Report local buffer only during throttle; caller should retry
    return 0;
  }
  _last_poll = millis();
  int n = pollModem(sizeof(_rx));
  _last_poll = millis();
  // modem says more is buffered but this read was empty: retry right away
  for (int i = 0; n <= 0 && _rest_len > 0 && i < 3; i++) { n = pollModem(sizeof(_rx)); _last_poll = millis(); }
  if (n < 0) n = 0;
  return n;
}

int ModemTcpClient::read() {
  uint8_t b;
  return read(&b, 1) == 1 ? b : -1;
}

int ModemTcpClient::read(uint8_t *buf, size_t size) {
  if (_rx_pos >= _rx_len && available() <= 0) return -1;
  size_t n = _rx_len - _rx_pos;
  if (n > size) n = size;
  memcpy(buf, _rx + _rx_pos, n);
  _rx_pos += n;
  return (int)n;
}

int ModemTcpClient::peek() {
  if (_rx_pos >= _rx_len && available() <= 0) return -1;
  return _rx[_rx_pos];
}

void ModemTcpClient::stop() {
  if (_connected) netlog("TCP: stop() requested (rest_len=%d raw=%lu remote_closed=%d)", _rest_len, (unsigned long)_raw_total, (int)_remote_closed);
  // ONLY close if we believe the socket is open — never CIPCLOSE on a fresh client
  if (_connected) {
    drain(_s);
    _s.printf("AT+CIPCLOSE=%u\r\n", _mux);
    String acc;
    char want[24];
    snprintf(want, sizeof(want), "+CIPCLOSE: %u,", _mux);
    uint32_t t0 = millis();
    while (millis() - t0 < 5000) {
      String line;
      if (!readLine(_s, line, 1000)) break;
      if (line.startsWith(want)) {
        int err = line.substring(strlen(want)).toInt();
        // 0 = ok, 4 = already closed — both fine
        if (err != 0 && err != 4) netlog("TCP: CIPCLOSE err=%d", err);
        break;
      }
      if (line == "ERROR") break; // often after 0,4
      if (line.indexOf("+IP ERROR: No data") >= 0) continue;
    }
  }
  _connected = false;
  _remote_closed = false;
  _rx_len = _rx_pos = 0;
  _rest_len = 0;
}

uint8_t ModemTcpClient::connected() {
  uint8_t r;
  const char *why;
  if (_rx_pos < _rx_len)            { r = 1; why = "local bytes"; }
  else if (_rest_len > 0)           { r = 1; why = "modem rest_len>0"; }
  else if (_connected && !_remote_closed) { r = 1; why = "link open"; }
  else if (_connected && _remote_closed) {
    int rem = queryRxRemaining();
    if (rem > 0) { _rest_len = rem; r = 1; why = "closed but modem has bytes"; }
    else { r = 0; why = "remote closed + drained"; }
  } else { r = 0; why = "stopped locally"; }
  if (r != _last_conn) {
    netlog("TCP: connected() %d -> %d (%s, close_reason=%d rest_len=%d raw=%lu)", _last_conn, r, why,
           _close_reason, _rest_len, (unsigned long)_raw_total);
    _last_conn = r;
  }
  return r;
}
