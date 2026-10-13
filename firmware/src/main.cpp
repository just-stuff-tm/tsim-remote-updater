#include <MD5Builder.h>
#include <esp_heap_caps.h>
#include <Arduino.h>
#include <LittleFS.h>
#include <esp_sleep.h>
#include <driver/gpio.h>
#include <ctype.h>
#include <string.h>
#include <stdlib.h>
#include <stdarg.h>

#include <ESP_SSLClient.h>

#include "board.h"
#include "esp_loader.h"
#include "arduino_port.h"
#include "modem_tcp.h"

SET_LOOP_TASK_STACK_SIZE(24 * 1024);

static HardwareSerial ModemSerial(1);
static HardwareSerial HeltecSerial(2);

static char s_logbuf[LOG_LINE_MAX];
static char s_at_resp[8192];
static char s_cmdbuf[AT_CMD_MAX];
static char s_url[URL_MAX];
static char s_url2[URL_MAX];
static char s_sms_body[2600];  // UCS2 hex is 4x text length
static char s_sms_from[160];
static char s_text_body[900];
static uint8_t s_http_buf[HTTP_CHUNK + 64];
static uint8_t s_flash_block[FLASH_BLOCK_SIZE];

static char s_log_ring[LOG_RING_LINES][LOG_LINE_MAX];
static int s_log_head = 0;
static int s_log_count = 0;
static char s_last_result[160] = "none";
static esp_sleep_wakeup_cause_t s_wake_cause = ESP_SLEEP_WAKEUP_UNDEFINED;
static bool s_pdp_up = false;
static bool s_busy_update = false;
static bool s_tcp_busy = false;  // true while TLS/TCP socket owns the modem AT UART


// v1.4.1: dashboard telemetry queue (JSON bodies), flushed by pendingFlush()
static char s_ingest_q[6][520];
static int s_ingest_q_len = 0;
static char s_ingest_body[640];
static void ingestEvent(const char *type, const char *msg);
static void ingestFlush(void);
static bool ingestSend(const char *json);
static bool modemHttpPost(const char *url, const char *ctype, const char *userdata, const char *body);

static void persistLastUpdate(void);
static void pendingFlush(void);
static bool modemOpenData(void);
static void modemCloseData(void);

static void logf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(s_logbuf, sizeof(s_logbuf), fmt, ap);
  va_end(ap);
  Serial.println(s_logbuf);
  strncpy(s_log_ring[s_log_head], s_logbuf, LOG_LINE_MAX - 1);
  s_log_ring[s_log_head][LOG_LINE_MAX - 1] = 0;
  s_log_head = (s_log_head + 1) % LOG_RING_LINES;
  if (s_log_count < LOG_RING_LINES) s_log_count++;
}

// C++ overload for modem_tcp.h declaration
void netlog(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(s_logbuf, sizeof(s_logbuf), fmt, ap);
  va_end(ap);
  Serial.println(s_logbuf);
  strncpy(s_log_ring[s_log_head], s_logbuf, LOG_LINE_MAX - 1);
  s_log_ring[s_log_head][LOG_LINE_MAX - 1] = 0;
  s_log_head = (s_log_head + 1) % LOG_RING_LINES;
  if (s_log_count < LOG_RING_LINES) s_log_count++;
}

static void setLastResult(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(s_last_result, sizeof(s_last_result), fmt, ap);
  va_end(ap);
  logf("RESULT: %s", s_last_result);
  persistLastUpdate();
}

static File openCreate(const char *path, const char *mode) {
  // ESP32 Arduino FS: third arg create=true required on some builds
  File f = LittleFS.open(path, mode, true);
  if (!f) f = LittleFS.open(path, mode); // fallback
  return f;
}

static void persistLastUpdate(void) {
  File f = openCreate(LAST_UPDATE_PATH, "w");
  if (!f) {
    logf("persist: open failed for %s", LAST_UPDATE_PATH);
    return;
  }
  f.printf("result=%s\n", s_last_result);
  f.printf("fw=%s\n", FW_VERSION);
  f.printf("built=%s\n", FW_BUILD_DATE);
  f.printf("--- last %d log lines ---\n", s_log_count);
  int start = (s_log_head - s_log_count + LOG_RING_LINES) % LOG_RING_LINES;
  for (int i = 0; i < s_log_count; i++) f.println(s_log_ring[(start + i) % LOG_RING_LINES]);
  f.close();
}

static void printLastLog(void) {
  logf("=== LASTLOG (result: %s) ===", s_last_result);
  if (LittleFS.exists(LAST_UPDATE_PATH)) {
    File f = LittleFS.open(LAST_UPDATE_PATH, "r");
    if (f) {
      while (f.available()) Serial.println(f.readStringUntil('\n'));
      f.close();
      return;
    }
  }
  logf("(no %s yet — in-memory ring)", LAST_UPDATE_PATH);
  int start = (s_log_head - s_log_count + LOG_RING_LINES) % LOG_RING_LINES;
  for (int i = 0; i < s_log_count; i++) Serial.println(s_log_ring[(start + i) % LOG_RING_LINES]);
}

static void loadLastResult(void) {
  if (!LittleFS.exists(LAST_UPDATE_PATH)) return;
  File f = LittleFS.open(LAST_UPDATE_PATH, "r");
  if (!f) return;
  String line = f.readStringUntil('\n');
  f.close();
  if (line.startsWith("result=")) {
    strncpy(s_last_result, line.c_str() + 7, sizeof(s_last_result) - 1);
  }
}

static void heltecPinsRelease() {
  pinMode(HELTEC_RST_PIN, INPUT);
  pinMode(HELTEC_BOOT_PIN, INPUT);
  pinMode(HELTEC_UART_TX_PIN, INPUT);
  pinMode(HELTEC_UART_RX_PIN, INPUT);
}

static void heltecReboot() {
  logf("REBOOT: pulsing Heltec RST");
  pinMode(HELTEC_RST_PIN, OUTPUT);
  digitalWrite(HELTEC_RST_PIN, LOW);
  delay(200);
  digitalWrite(HELTEC_RST_PIN, HIGH);
  delay(50);
  pinMode(HELTEC_RST_PIN, INPUT);
}

// -------------------- modem AT --------------------
static size_t modemReadUntil(uint32_t timeout_ms) {
  size_t n = 0;
  s_at_resp[0] = 0;
  uint32_t start = millis();
  while (millis() - start < timeout_ms) {
    while (ModemSerial.available()) {
      if (n + 1 >= sizeof(s_at_resp)) {
        memmove(s_at_resp, s_at_resp + sizeof(s_at_resp) / 2, n - sizeof(s_at_resp) / 2);
        n -= sizeof(s_at_resp) / 2;
        s_at_resp[n] = 0;
      }
      char c = (char)ModemSerial.read();
      s_at_resp[n++] = c;
      s_at_resp[n] = 0;
      if (n >= 4 && strcmp(s_at_resp + n - 4, "OK\r\n") == 0) return n;
      if (n >= 7 && strcmp(s_at_resp + n - 7, "ERROR\r\n") == 0) return n;
      // Soft-success: CIPCLOSE already closed
      if (strstr(s_at_resp, "+CIPCLOSE:") && strstr(s_at_resp, ",4") &&
          n >= 2 && s_at_resp[n - 2] == '\r' && s_at_resp[n - 1] == '\n')
        return n;
      // Soft-success: leftover No data after socket ops
      if (strstr(s_at_resp, "+IP ERROR: No data") &&
          n >= 2 && s_at_resp[n - 2] == '\r' && s_at_resp[n - 1] == '\n') {
        // keep reading until OK/ERROR completes the AT response
      }
      if (strstr(s_at_resp, "+CME ERROR") || strstr(s_at_resp, "+CMS ERROR")) {
        if (n >= 2 && s_at_resp[n - 2] == '\r' && s_at_resp[n - 1] == '\n') return n;
      }
    }
    delay(1);
  }
  return n;
}

static bool respLooksOk(const char *r) {
  if (!r || !r[0]) return false;
  // CIPCLOSE already-closed
  if (strstr(r, "+CIPCLOSE:") && strstr(r, ",4")) return true;
  // HTTPTERM with no session
  if (strstr(r, "ERROR") && strstr(r, "HTTPTERM")) return true;
  bool hasOk = strstr(r, "OK") != nullptr;
  bool hasErr = strstr(r, "ERROR") != nullptr;
  // "+IP ERROR: No data\nERROR" alone is not OK
  if (hasOk && !hasErr) return true;
  if (hasOk && hasErr && strstr(r, "+CIPCLOSE:")) return true;
  return false;
}

static bool modemAT(const char *cmd, uint32_t timeout_ms = 3000) {
  if (s_tcp_busy) {
    logf("AT BLOCKED (tcp busy): %s", cmd);
    return false;
  }
  while (ModemSerial.available()) ModemSerial.read();
  logf(">> %s", cmd);
  ModemSerial.print(cmd);
  ModemSerial.print("\r\n");
  size_t n = modemReadUntil(timeout_ms);
  bool ok = respLooksOk(s_at_resp);
  if (!ok) logf("<< FAIL (%u): %.180s", (unsigned)n, s_at_resp);
  else if (n < 180) logf("<< %s", s_at_resp);
  else logf("<< OK (%u bytes)", (unsigned)n);
  return ok;
}

static bool modemPowerOn() {
  pinMode(MODEM_DTR_PIN, OUTPUT);
  digitalWrite(MODEM_DTR_PIN, LOW);
  pinMode(MODEM_RESET_PIN, OUTPUT);
  digitalWrite(MODEM_RESET_PIN, !MODEM_RESET_LEVEL);
  delay(100);
  digitalWrite(MODEM_RESET_PIN, MODEM_RESET_LEVEL);
  delay(2600);
  digitalWrite(MODEM_RESET_PIN, !MODEM_RESET_LEVEL);
  pinMode(MODEM_PWRKEY_PIN, OUTPUT);
  digitalWrite(MODEM_PWRKEY_PIN, LOW);
  delay(100);
  digitalWrite(MODEM_PWRKEY_PIN, HIGH);
  delay(MODEM_PWR_PULSE_MS);
  digitalWrite(MODEM_PWRKEY_PIN, LOW);
  ModemSerial.setRxBufferSize(8192);
  ModemSerial.begin(MODEM_BAUD, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
  delay(500);
  for (int i = 0; i < 40; i++) {
    if (modemAT("AT", 1000)) { logf("Modem online"); return true; }
    if (i == 20) {
      digitalWrite(MODEM_PWRKEY_PIN, HIGH);
      delay(MODEM_PWR_PULSE_MS);
      digitalWrite(MODEM_PWRKEY_PIN, LOW);
    }
  }
  logf("ERROR: modem did not respond to AT");
  return false;
}

static bool modemWaitCpinReady(uint32_t timeout_ms = 20000) {
  uint32_t start = millis();
  while (millis() - start < timeout_ms) {
    modemAT("AT+CPIN?", 3000);
    if (strstr(s_at_resp, "READY")) { logf("SIM READY"); return true; }
    if (strstr(s_at_resp, "SIM PIN") || strstr(s_at_resp, "SIM PUK")) return false;
    delay(1000);
  }
  return false;
}

static bool modemWaitNetwork(uint32_t timeout_ms = 60000) {
  uint32_t start = millis();
  while (millis() - start < timeout_ms) {
    modemAT("AT+CEREG?", 2000);
    if (strstr(s_at_resp, ",1") || strstr(s_at_resp, ",5")) { logf("Network registered (CEREG)"); return true; }
    modemAT("AT+CREG?", 2000);
    if (strstr(s_at_resp, ",1") || strstr(s_at_resp, ",5")) { logf("Network registered (CREG)"); return true; }
    delay(2000);
  }
  logf("Network not registered after %u ms", (unsigned)timeout_ms);
  return false;
}

static void modemLogDiagnostics() {
  logf("--- modem diagnostics ---");
  modemAT("AT+CGMR", 5000);
  modemAT("AT+CPIN?", 3000);
  modemAT("AT+CSQ", 3000);
  modemAT("AT+COPS?", 5000);
  modemAT("AT+CEREG?", 3000);
  logf("--- end diagnostics ---");
}

static void modemConfigureSms() {
  modemAT("ATE0");
  modemAT("AT+CMEE=2");
  modemAT("AT+CMGF=1");
  modemAT("AT+CSCS=\"GSM\"");
  modemAT("AT+CNMI=2,1,0,0,0");
  const char *cpms_try[] = {
    "AT+CPMS=\"SM\",\"SM\",\"SM\"",
    "AT+CPMS=\"ME\",\"ME\",\"ME\"",
    "AT+CPMS=\"MT\",\"MT\",\"MT\"",
  };
  for (size_t i = 0; i < 3; i++) {
    if (modemAT(cpms_try[i], 5000)) { logf("CPMS OK: %s", cpms_try[i]); return; }
  }
  logf("CPMS failed — continuing");
}

static void modemEnableSleep() {
  digitalWrite(MODEM_DTR_PIN, HIGH);
  modemAT("AT+CSCLK=1");
}

static bool modemOpenData() {
  if (s_pdp_up) { logf("PDP: already up"); return true; }
  logf("PDP: activating APN=%s", APN);
  modemAT("AT+CGDCONT=1,\"IP\",\"" APN "\"");
  bool ok = modemAT("AT+CGACT=1,1", 60000);
  delay(1500);
  modemAT("AT+CGPADDR=1", 5000);
  logf("PDP address: %.160s", s_at_resp);
  // DNS (best-effort)
  modemAT("AT+CDNSCFG=\"8.8.8.8\",\"8.8.4.4\"", 5000);
  if (ok || strstr(s_at_resp, ".")) {
    s_pdp_up = true;
    logf("PDP: UP");
    return true;
  }
  logf("PDP: FAILED");
  s_pdp_up = false;
  return false;
}

static void modemCloseData() {
  // Soft teardown: leave PDP; close HTTP / socket best-effort.
  logf("PDP: soft teardown (leave context; HTTPTERM + CIPCLOSE only)");
  if (!s_tcp_busy) {
    modemAT("AT+HTTPTERM", 3000);
    // +CIPCLOSE: 0,4 = already closed — treat as OK via modemReadUntil
    modemAT("AT+CIPCLOSE=0", 5000);
  } else {
    logf("PDP: skip AT teardown — tcp still busy");
  }
}

// -------------------- modem HTTP POST (no CID/HTTPSSL) --------------------
static bool modemHttpPost(const char *url, const char *ctype, const char *userdata, const char *body) {
  if (s_tcp_busy) { logf("httpPost blocked — tcp busy"); return false; }
  bool brought = false;
  if (!s_pdp_up) {
    if (!modemOpenData()) { logf("http: no PDP"); return false; }
    brought = true;
  }
  // Clear any leftover socket URCs, then terminate prior HTTP session
  modemAT("AT+HTTPTERM", 3000);
  // Brief settle so CIPCLOSE/No data URCs drain before HTTPINIT
  delay(200);
  while (ModemSerial.available()) ModemSerial.read();
  // Cloudflare (workers.dev) rejects TLS without SNI; ntfy.sh did not need it.
  modemAT("AT+CSSLCFG=\"sslversion\",0,4", 3000);
  modemAT("AT+CSSLCFG=\"enableSNI\",0,1", 3000);
  if (!modemAT("AT+HTTPINIT", 10000)) {
    logf("http: HTTPINIT fail — retry after HTTPTERM");
    modemAT("AT+HTTPTERM", 3000);
    delay(300);
    while (ModemSerial.available()) ModemSerial.read();
    if (!modemAT("AT+HTTPINIT", 10000)) {
      logf("http: HTTPINIT fail");
      return false;
    }
  }
  // No AT+HTTPPARA="CID" — errors on this FW
  // No AT+HTTPSSL=1 — errors on this FW; URL scheme is enough
  snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+HTTPPARA=\"URL\",\"%s\"", url);
  if (!modemAT(s_cmdbuf, 10000)) { modemAT("AT+HTTPTERM"); return false; }
  if (strncmp(url, "https://", 8) == 0) modemAT("AT+HTTPPARA=\"SSLCFG\",0", 3000);  // ok if unsupported
  snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+HTTPPARA=\"CONTENT\",\"%s\"", ctype);
  modemAT(s_cmdbuf, 5000);
  if (userdata && *userdata) {
    snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+HTTPPARA=\"USERDATA\",\"%s\"", userdata);
    modemAT(s_cmdbuf, 5000);
  }

  size_t blen = strlen(body);
  snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+HTTPDATA=%u,30", (unsigned)blen);
  while (ModemSerial.available()) ModemSerial.read();
  ModemSerial.print(s_cmdbuf);
  ModemSerial.print("\r\n");
  uint32_t t0 = millis();
  bool got_dl = false;
  String wait;
  while (millis() - t0 < 10000) {
    while (ModemSerial.available()) wait += (char)ModemSerial.read();
    if (wait.indexOf("DOWNLOAD") >= 0 || wait.indexOf(">") >= 0) { got_dl = true; break; }
    if (wait.indexOf("ERROR") >= 0) break;
    delay(10);
  }
  if (!got_dl) {
    logf("http: no DOWNLOAD: %.80s", wait.c_str());
    modemAT("AT+HTTPTERM");
    return false;
  }
  ModemSerial.write((const uint8_t *)body, blen);
  modemReadUntil(15000);
  modemAT("AT+HTTPACTION=1", 60000);
  t0 = millis();
  size_t urc_len = strlen(s_at_resp);
  int status = -1;
  while (millis() - t0 < 60000) {
    char *p = strstr(s_at_resp, "+HTTPACTION:");
    if (p) {
      int a, b, c;
      if (sscanf(p, "+HTTPACTION: %d,%d,%d", &a, &b, &c) >= 2) { status = b; break; }
    }
    while (ModemSerial.available() && urc_len + 1 < sizeof(s_at_resp)) {
      s_at_resp[urc_len++] = (char)ModemSerial.read();
      s_at_resp[urc_len] = 0;
    }
    delay(20);
  }
  logf("httpPost: %.40s status=%d", url, status);
  modemAT("AT+HTTPTERM", 5000);
  (void)brought;
  return (status >= 200 && status < 300);
}

static void pendingFlush(void) {
  if (s_tcp_busy) { logf("pendingFlush deferred — tcp busy"); return; }
  ingestFlush();
}

// Progress lines: USB log only (results reach the dashboard via ingestEvent)
static void progressf(const char *title, const char *tags, int pri, const char *fmt, ...) {
  (void)tags; (void)pri;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(s_text_body, sizeof(s_text_body), fmt, ap);
  va_end(ap);
  logf("[%s] %.160s", title, s_text_body);
}

// -------------------- Dashboard telemetry ingest (v1.4.1) --------------------
static float readAdcVolts(int pin, float divider);
static int batPercent(float v);

static void jsonEsc(char *dst, size_t n, const char *src) {
  size_t o = 0;
  for (; src && *src && o + 7 < n; src++) {
    unsigned char c = (unsigned char)*src;
    if (c == '"' || c == '\\') { dst[o++] = '\\'; dst[o++] = c; }
    else if (c == '\n') { dst[o++] = '\\'; dst[o++] = 'n'; }
    else if (c < 0x20) { o += snprintf(dst + o, n - o, "\\u%04x", c); }
    else dst[o++] = c;
  }
  dst[o] = 0;
}

// Never while a TCP/TLS socket owns the modem: queue, flushed by pendingFlush()
static void ingestPostOrQueue(const char *json) {
  if (s_tcp_busy) {
    if (s_ingest_q_len >= 6) { memmove(s_ingest_q[0], s_ingest_q[1], sizeof(s_ingest_q[0]) * 5); s_ingest_q_len--; }
    strncpy(s_ingest_q[s_ingest_q_len], json, sizeof(s_ingest_q[0]) - 1);
    s_ingest_q[s_ingest_q_len][sizeof(s_ingest_q[0]) - 1] = 0;
    s_ingest_q_len++;
    logf("ingest queued (%d)", s_ingest_q_len);
    return;
  }
  if (!s_pdp_up && !modemOpenData()) { logf("ingest: no PDP"); return; }
  ingestSend(json);
}

static void ingestFlush(void) {
  if (s_tcp_busy || s_ingest_q_len == 0) return;
  for (int i = 0; i < s_ingest_q_len; i++) ingestSend(s_ingest_q[i]);
  s_ingest_q_len = 0;
}

// Light event (no AT queries)
static void ingestEvent(const char *type, const char *msg) {
  float bat = readAdcVolts(BOARD_BAT_ADC_PIN, 2.0f);
  float sol = readAdcVolts(BOARD_SOLAR_ADC_PIN, 2.0f);
  char m[200], lr[170];
  jsonEsc(m, sizeof(m), msg); jsonEsc(lr, sizeof(lr), s_last_result);
  snprintf(s_ingest_body, sizeof(s_ingest_body),
    "{\"type\":\"%s\",\"fw\":\"%s\",\"uptime\":%lu,\"wake\":%d,\"battery_v\":%.2f,\"battery_pct\":%d,"
    "\"solar_v\":%.2f,\"heap\":%u,\"last_update\":\"%s\",\"msg\":\"%s\"}",
    type, FW_VERSION, (unsigned long)(millis() / 1000UL), (int)s_wake_cause, bat, batPercent(bat),
    sol, (unsigned)ESP.getFreeHeap(), lr, m);
  ingestPostOrQueue(s_ingest_body);
}

// -------------------- SMS helpers --------------------
// v1.4.0: outgoing SMS removed entirely. Results go to the dashboard via /ingest.

static void trimInPlace(char *s) {
  char *e = s + strlen(s);
  while (e > s && (isspace((unsigned char)e[-1]) || e[-1] == '\r' || e[-1] == '\n')) *--e = 0;
  char *p = s;
  while (*p && (isspace((unsigned char)*p) || *p == '\r' || *p == '\n')) p++;
  if (p != s) memmove(s, p, strlen(p) + 1);
}

static void normalizeSmsBody(char *s) {
  char *r = s, *w = s;
  while (*r) { if (*r != '\r' && *r != '\n') *w++ = *r; r++; }
  *w = 0;
  trimInPlace(s);
  for (int pass = 0; pass < 2; pass++) {
    size_t n = strlen(s);
    if (n >= 2 && s[0] == '"' && s[n - 1] == '"') {
      memmove(s, s + 1, n - 2); s[n - 2] = 0; trimInPlace(s);
    } else break;
  }
  w = s; r = s; bool in_space = false;
  while (*r) {
    if (isspace((unsigned char)*r)) {
      if (!in_space && w != s) { *w++ = ' '; in_space = true; }
      r++;
    } else { *w++ = *r++; in_space = false; }
  }
  *w = 0;
  trimInPlace(s);
}

// -------------------- URL parse --------------------
struct UrlParts {
  bool https;
  char host[128];
  uint16_t port;
  char path[URL_MAX]; // includes query
};

static bool parseUrl(const char *url, UrlParts &u) {
  memset(&u, 0, sizeof(u));
  u.port = 0;
  strcpy(u.path, "/");
  if (strncmp(url, "https://", 8) == 0) { u.https = true; url += 8; u.port = 443; }
  else if (strncmp(url, "http://", 7) == 0) { u.https = false; url += 7; u.port = 80; }
  else return false;
  size_t i = 0;
  while (*url && *url != '/' && *url != '?' && *url != ':' && i + 1 < sizeof(u.host)) u.host[i++] = *url++;
  u.host[i] = 0;
  if (*url == ':') {
    url++;
    u.port = 0;
    while (isdigit((unsigned char)*url)) { u.port = u.port * 10 + (*url - '0'); url++; }
  }
  if (*url == '/' || *url == '?') {
    strncpy(u.path, url, sizeof(u.path) - 1);
  }
  return u.host[0] != 0 && u.port != 0;
}

static bool resolveRedirect(const char *base, const char *location, char *out, size_t outlen) {
  static char locbuf[URL_MAX];
  strncpy(locbuf, location, sizeof(locbuf) - 1);
  locbuf[sizeof(locbuf) - 1] = 0;
  trimInPlace(locbuf);
  if (!locbuf[0]) return false;
  if (strncmp(locbuf, "http://", 7) == 0 || strncmp(locbuf, "https://", 8) == 0) {
    strncpy(out, locbuf, outlen - 1); out[outlen - 1] = 0; return true;
  }
  UrlParts b;
  if (!parseUrl(base, b)) return false;
  if (locbuf[0] == '/') {
    snprintf(out, outlen, "%s://%s%s", b.https ? "https" : "http", b.host, locbuf);
    return true;
  }
  // relative
  char dir[URL_MAX];
  strncpy(dir, b.path, sizeof(dir) - 1);
  char *slash = strrchr(dir, '/');
  if (slash) slash[1] = 0; else strcpy(dir, "/");
  snprintf(out, outlen, "%s://%s%s%s", b.https ? "https" : "http", b.host, dir, locbuf);
  return true;
}

// -------------------- ESP32-TLS HTTP download --------------------
static int clientReadLine(Client &c, char *buf, size_t buflen, uint32_t timeout_ms) {
  size_t n = 0;
  uint32_t t0 = millis();
  while (millis() - t0 < timeout_ms && n + 1 < buflen) {
    if (!c.connected() && !c.available()) break;
    if (!c.available()) { delay(1); continue; }
    int ch = c.read();
    if (ch < 0) continue;
    if (ch == '\n') { buf[n] = 0; return (int)n; }
    if (ch != '\r') buf[n++] = (char)ch;
  }
  buf[n] = 0;
  return n ? (int)n : -1;
}

static int clientReadExact(Client &c, uint8_t *buf, int len, uint32_t timeout_ms) {
  int got = 0;
  uint32_t t0 = millis();
  uint32_t last = millis();
  while (got < len && millis() - t0 < timeout_ms) {
    int n = c.read(buf + got, len - got);
    if (n > 0) { got += n; last = millis(); continue; }
    // empty — keep trying until timeout; do not treat !connected as hard stop
    if (millis() - last > timeout_ms) break;
    delay(20);
  }
  return got;
}

// Fallback: POST over ESP32 TLS (BearSSL, SNI) on a raw modem socket — same path that downloads from GitHub.
static bool ingestPostTls(const char *json) {
  UrlParts u;
  if (!parseUrl(INGEST_URL, u)) return false;
  if (!ModemTcpClient::netOpen(ModemSerial)) { logf("ingest-tls: NETOPEN failed"); return false; }
  ModemTcpClient tcp(ModemSerial, 0);
  ESP_SSLClient ssl;
  s_tcp_busy = true;
  ssl.setClient(&tcp);
  ssl.setInsecure();
  ssl.setBufferSizes(16384, 2048);
  ssl.setDebugLevel(0);
  bool ok = false;
  if (ssl.connect(u.host, u.port)) {
    size_t n = strlen(json);
    ssl.printf("POST %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: tsim-updater/1.5.0\r\n"
               "Content-Type: application/json\r\nX-Device-Key: %s\r\nContent-Length: %u\r\nConnection: close\r\n\r\n",
               u.path, u.host, DEVICE_KEY, (unsigned)n);
    ssl.write((const uint8_t *)json, n);
    ssl.flush();
    char line[160];
    int st = 0;
    if (clientReadLine(ssl, line, sizeof(line), 20000) >= 0) sscanf(line, "HTTP/%*d.%*d %d", &st);
    logf("ingest-tls: status=%d", st);
    ok = st >= 200 && st < 300;
  } else {
    logf("ingest-tls: SSL connect failed br_err=%d", ssl.tsimLastSSLError());
  }
  ssl.stop();
  tcp.stop();
  s_tcp_busy = false;
  return ok;
}

static bool ingestSend(const char *json) {
  if (modemHttpPost(INGEST_URL, "application/json", "X-Device-Key: " DEVICE_KEY, json)) return true;
  logf("ingest: modem HTTPS failed, trying ESP32 TLS");
  return ingestPostTls(json);
}

// -------------------- Heltec MeshCore CLI + mesh snapshot + console (v1.5.0) --------------------
// MeshCore/EasySkyMesh repeater serial CLI (115200): commands end with '\r', typed chars are echoed,
// replies are printed as "  -> <reply>" (neighbors: multi-line). The Worker parses the raw text.
#define CLI_OUT_MAX        1024
#define CLI_TIMEOUT_MS     4000
#define CLI_QUIET_MS       350
#define CMD_FETCH_MAX      1800
#define CMD_MAX_RUN        10
static char s_cli_out[CLI_OUT_MAX];
static char s_mesh_body[4096];
static char s_cmd_list[CMD_FETCH_MAX];
static bool s_heltec_uart_on = false;

static void heltecCliBegin() {
  if (s_heltec_uart_on) return;
  pinMode(HELTEC_BOOT_PIN, INPUT);  // never hold BOOT low here
  HeltecSerial.begin(115200, SERIAL_8N1, HELTEC_UART_RX_PIN, HELTEC_UART_TX_PIN);
  s_heltec_uart_on = true;
  delay(30);
}
static void heltecCliEnd() {
  if (!s_heltec_uart_on) return;
  HeltecSerial.flush();
  HeltecSerial.end();
  s_heltec_uart_on = false;
  heltecPinsRelease();
}

// Runs one CLI command; returns true when a "->" reply was seen. out = reply text (prefix kept for the Worker).
static bool heltecCli(const char *cmd, char *out, size_t cap, uint32_t timeout_ms = CLI_TIMEOUT_MS) {
  heltecCliBegin();
  // Wake a power-saving Heltec and flush any half-typed line: a bare CR is an empty command.
  HeltecSerial.print("\r"); delay(120); HeltecSerial.print("\r"); delay(150);
  while (HeltecSerial.available()) HeltecSerial.read();
  HeltecSerial.print(cmd);
  HeltecSerial.print("\r");
  size_t n = 0; out[0] = 0;
  uint32_t t0 = millis(), last = millis();
  bool reply = false;
  while (millis() - t0 < timeout_ms) {
    while (HeltecSerial.available()) {
      int c = HeltecSerial.read();
      if (c < 0) break;
      if (n + 1 < cap) { out[n++] = (char)c; out[n] = 0; }
      last = millis();
    }
    if (!reply && strstr(out, "-> ")) reply = true;
    if (reply && millis() - last > CLI_QUIET_MS) break;
    delay(5);
  }
  // Drop the echoed command line (everything up to the reply marker), keep "  -> ..." onwards.
  char *p = strstr(out, "  -> ");
  if (!p) p = strstr(out, "-> ");
  if (p && p != out) memmove(out, p, strlen(p) + 1);
  else if (!p) {  // no reply: strip a lone echo
    char *nl = strchr(out, '\n');
    if (nl && strncmp(out, cmd, strlen(cmd)) == 0) memmove(out, nl + 1, strlen(nl + 1) + 1);
  }
  trimInPlace(out);
  logf("cli '%.40s' -> %s %.80s", cmd, reply ? "ok" : "NO REPLY", out);
  return reply;
}

// Large JSON (mesh / cmd output): send directly (too big for the 520-byte retry queue).
static bool ingestSendBig(const char *json) {
  if (s_tcp_busy) { logf("ingest(big) skipped — tcp busy"); return false; }
  if (!s_pdp_up && !modemOpenData()) { logf("ingest(big): no PDP"); return false; }
  return ingestSend(json);
}

static void meshSnapshot(void) {
  static const char *const cmds[][2] = {
    {"ver", "ver"}, {"name", "get name"}, {"clock", "clock"}, {"stats_core", "stats-core"},
    {"stats_radio", "stats-radio"}, {"stats_packets", "stats-packets"}, {"neighbors", "neighbors"},
  };
  size_t o = snprintf(s_mesh_body, sizeof(s_mesh_body), "{\"type\":\"mesh\",\"fw\":\"%s\"", FW_VERSION);
  int replies = 0;
  static char esc[CLI_OUT_MAX + 256];
  for (size_t i = 0; i < sizeof(cmds) / sizeof(cmds[0]); i++) {
    bool ok = heltecCli(cmds[i][1], s_cli_out, 700);
    if (ok) replies++;
    else if (i == 0) {  // nothing from 'ver': retry once (Heltec may have been asleep)
      ok = heltecCli(cmds[i][1], s_cli_out, 700, 6000);
      if (ok) replies++;
    }
    jsonEsc(esc, sizeof(esc), s_cli_out);
    if (o + strlen(esc) + 40 < sizeof(s_mesh_body))
      o += snprintf(s_mesh_body + o, sizeof(s_mesh_body) - o, ",\"%s\":\"%s\"", cmds[i][0], esc);
    if (i == 0 && !ok) break;  // Heltec silent: don't burn awake time on the rest
  }
  heltecCliEnd();
  if (!replies) o += snprintf(s_mesh_body + o, sizeof(s_mesh_body) - o, ",\"error\":\"no reply from Heltec CLI\"");
  snprintf(s_mesh_body + o, sizeof(s_mesh_body) - o, "}");
  logf("mesh snapshot: %d replies, %u bytes", replies, (unsigned)strlen(s_mesh_body));
  ingestSendBig(s_mesh_body);
}

// HTTPS GET over ESP32 TLS (same path as firmware downloads). Body -> out (NUL-terminated). Returns HTTP status.
static int httpsGetTls(const char *url, char *out, size_t cap) {
  out[0] = 0;
  UrlParts u;
  if (!parseUrl(url, u)) return -1;
  if (!s_pdp_up && !modemOpenData()) { logf("get: no PDP"); return -1; }
  if (!ModemTcpClient::netOpen(ModemSerial)) { logf("get-tls: NETOPEN failed"); return -1; }
  ModemTcpClient tcp(ModemSerial, 0);
  ESP_SSLClient ssl;
  s_tcp_busy = true;
  ssl.setClient(&tcp);
  ssl.setInsecure();
  ssl.setBufferSizes(16384, 2048);
  ssl.setDebugLevel(0);
  int st = -1;
  if (ssl.connect(u.host, u.port)) {
    ssl.printf("GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: tsim-updater/1.5.0\r\nX-Device-Key: %s\r\nConnection: close\r\n\r\n",
               u.path, u.host, DEVICE_KEY);
    ssl.flush();
    char line[200];
    if (clientReadLine(ssl, line, sizeof(line), 20000) >= 0) sscanf(line, "HTTP/%*d.%*d %d", &st);
    bool chunked = false; long clen = -1;
    while (clientReadLine(ssl, line, sizeof(line), 10000) > 0) {
      if (strncasecmp(line, "Content-Length:", 15) == 0) clen = atol(line + 15);
      if (strncasecmp(line, "Transfer-Encoding:", 18) == 0 && strstr(line, "chunked")) chunked = true;
    }
    size_t n = 0;
    uint32_t t0 = millis();
    while (millis() - t0 < 15000 && n + 1 < cap && (clen < 0 || (long)n < clen)) {
      int c = ssl.available() ? ssl.read() : -1;
      if (c < 0) { if (!ssl.connected()) break; delay(5); continue; }
      out[n++] = (char)c;
    }
    out[n] = 0;
    if (chunked) {  // de-chunk in place: "<hex>\r\n<data>\r\n...0\r\n\r\n"
      char *r = out, *w = out;
      while (*r) {
        long sz = strtol(r, &r, 16);
        r = strstr(r, "\r\n"); if (!r || sz <= 0) break; r += 2;
        if ((size_t)sz > strlen(r)) sz = strlen(r);
        memmove(w, r, sz); w += sz; r += sz;
        if (r[0] == '\r' && r[1] == '\n') r += 2;
      }
      *w = 0;
    }
    logf("get-tls: status=%d body=%u", st, (unsigned)strlen(out));
  } else {
    logf("get-tls: SSL connect failed br_err=%d", ssl.tsimLastSSLError());
  }
  ssl.stop();
  tcp.stop();
  s_tcp_busy = false;
  return st;
}

// CMD wake: pull queued console commands from the Worker, run each on the Heltec CLI, post outputs.
static void doConsoleCommands(void) {
  int st = httpsGetTls(WORKER_URL "/api/dev/" DEVICE_ID "/commands", s_cmd_list, sizeof(s_cmd_list));
  if (st != 200) { char m[60]; snprintf(m, sizeof(m), "CMD: command fetch failed (%d)", st); ingestEvent("event", m); return; }
  int ran = 0;
  char *save = nullptr;
  for (char *line = strtok_r(s_cmd_list, "\n", &save); line && ran < CMD_MAX_RUN; line = strtok_r(nullptr, "\n", &save)) {
    char *tab = strchr(line, '\t');
    if (!tab) continue;
    *tab = 0;
    char id[20]; strncpy(id, line, sizeof(id) - 1); id[sizeof(id) - 1] = 0;
    char cmd[128]; strncpy(cmd, tab + 1, sizeof(cmd) - 1); cmd[sizeof(cmd) - 1] = 0;
    trimInPlace(cmd);
    bool clean = cmd[0] != 0;
    for (char *q = cmd; *q; q++) if ((unsigned char)*q < 0x20 || (unsigned char)*q > 0x7e) clean = false;
    bool ok = false;
    if (clean) ok = heltecCli(cmd, s_cli_out, sizeof(s_cli_out), 8000);
    else strcpy(s_cli_out, "");
    static char eo[CLI_OUT_MAX * 2], ec[260], ei[40];
    jsonEsc(eo, sizeof(eo), s_cli_out); jsonEsc(ec, sizeof(ec), cmd); jsonEsc(ei, sizeof(ei), id);
    snprintf(s_mesh_body, sizeof(s_mesh_body), "{\"type\":\"cmd\",\"fw\":\"%s\",\"cmd_id\":\"%s\",\"cmd\":\"%s\",\"output\":\"%s\"%s}",
             FW_VERSION, ei, ec, eo, !clean ? ",\"error\":\"rejected by T-SIM\"" : (ok ? "" : ",\"error\":\"no reply from Heltec\""));
    ingestSendBig(s_mesh_body);
    ran++;
  }
  heltecCliEnd();
  logf("CMD: ran %d command(s)", ran);
}

static bool httpDownloadTls(const char *start_url, const char *path) {
  strncpy(s_url, start_url, sizeof(s_url) - 1);
  s_url[sizeof(s_url) - 1] = 0;

  if (!ModemTcpClient::netOpen(ModemSerial)) {
    logf("TLS-DL: NETOPEN failed");
    return false;
  }

  for (int hop = 0; hop <= HTTP_MAX_REDIRECTS; hop++) {
    UrlParts u;
    if (!parseUrl(s_url, u)) {
      logf("TLS-DL: bad URL");
      s_tcp_busy = false;
      pendingFlush();
      return false;
    }
    logf("TLS-DL hop %d %s://%s:%u path=%.60s", hop,
         u.https ? "https" : "http", u.host, u.port, u.path);

    ModemTcpClient tcp(ModemSerial, 0);
    ESP_SSLClient ssl;
    ssl.setDebugLevel(1);  // print BearSSL errors
    Client *cli = &tcp;

    s_tcp_busy = true;  // no other AT (esp. telemetry) until socket fully closed

    if (u.https) {
      ssl.setClient(&tcp);
      ssl.setInsecure();
      // Servers send max-size 16 KB TLS records; BearSSL needs 16384+325 = 16709 B input
      // buffer or it fails with BR_ERR_TOO_LARGE (6). Lib clamps to 16384 and adds 325.
      ssl.setBufferSizes(16384, 2048);
      logf("TLS-DL: SSL bufs rx=%d tx=%d heap=%u largest=%u psram=%u",
           ssl.tsimInBufSize(), ssl.tsimOutBufSize(), (unsigned)ESP.getFreeHeap(),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT), (unsigned)ESP.getFreePsram());
      ssl.setDebugLevel(0);
      cli = &ssl;
      logf("TLS-DL: connecting SSL to %s:%u (SNI)", u.host, u.port);
      if (!ssl.connect(u.host, u.port)) {
        logf("TLS-DL: SSL connect failed (br_err=%d inbuf_alloc=%d heap=%u)", ssl.tsimLastSSLError(),
             (int)ssl.tsimInBufAllocated(), (unsigned)ESP.getFreeHeap());
        ssl.stop();
        tcp.stop();
        s_tcp_busy = false;
        progressf("UPDATE", "x", 5, "TLS connect failed");
        pendingFlush();
        return false;
      }
      logf("TLS-DL: SSL connected (rx_buf=%d tx_buf=%d alloc=%d heap=%u largest=%u)", ssl.tsimInBufSize(), ssl.tsimOutBufSize(), (int)ssl.tsimInBufAllocated(), (unsigned)ESP.getFreeHeap(), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
    } else {
      logf("TLS-DL: connecting plain TCP %s:%u", u.host, u.port);
      if (!tcp.connect(u.host, u.port)) {
        logf("TLS-DL: TCP connect failed");
        s_tcp_busy = false;
        progressf("UPDATE", "x", 5, "TCP connect failed");
        pendingFlush();
        return false;
      }
    }

    // Queue hop notice (USB already has logf); flush only after close
    {
      char b[160];
      snprintf(b, sizeof(b), "TLS hop %d %s://%s", hop, u.https ? "https" : "http", u.host);
      progressf("UPDATE", "globe_with_meridians", 3, "%s", b);
    }

    cli->printf("GET %s HTTP/1.1\r\n", u.path);
    cli->printf("Host: %s\r\n", u.host);
    cli->print("User-Agent: tsim-updater/1.5.0\r\n");
    cli->print("Accept: */*\r\n");
    cli->print("Connection: close\r\n");
    cli->print("\r\n");
    cli->flush();

    static char line[URL_MAX];
    if (clientReadLine(*cli, line, sizeof(line), 30000) < 0) {
      logf("TLS-DL: no status line");
      cli->stop();
      tcp.stop();
      s_tcp_busy = false;
      pendingFlush();
      return false;
    }
    logf("TLS-DL status: %.120s", line);
    int ver_maj = 0, ver_min = 0, status = 0;
    if (sscanf(line, "HTTP/%d.%d %d", &ver_maj, &ver_min, &status) < 3) {
      logf("TLS-DL: bad status line");
      cli->stop(); tcp.stop();
      s_tcp_busy = false; pendingFlush();
      return false;
    }
    progressf("UPDATE", "globe_with_meridians", 3, "HTTP hop %d status=%d", hop, status);

    long content_length = -1;
    bool chunked = false;
    static char location[URL_MAX];
    location[0] = 0;

    while (true) {
      int n = clientReadLine(*cli, line, sizeof(line), 30000);
      if (n < 0) {
        logf("TLS-DL: header timeout");
        cli->stop(); tcp.stop();
        s_tcp_busy = false; pendingFlush();
        return false;
      }
      if (n == 0) break;
      if (strncasecmp(line, "Content-Length:", 15) == 0) {
        content_length = atol(line + 15);
      } else if (strncasecmp(line, "Transfer-Encoding:", 18) == 0) {
        if (strstr(line, "chunked") || strstr(line, "Chunked") || strstr(line, "CHUNKED"))
          chunked = true;
      } else if (strncasecmp(line, "Location:", 9) == 0) {
        const char *p = line + 9;
        while (*p == ' ' || *p == '\t') p++;
        strncpy(location, p, sizeof(location) - 1);
      }
    }
    logf("TLS-DL headers: len=%ld chunked=%d loc=%.80s", content_length, (int)chunked, location);

    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
      // Fully close this hop's socket BEFORE any AT (telemetry flush) or next connect
      logf("TLS-DL: closing socket before redirect follow");
      cli->stop();
      tcp.stop();
      s_tcp_busy = false;
      pendingFlush();  // safe now — posts hop status etc.

      if (hop >= HTTP_MAX_REDIRECTS) {
        logf("TLS-DL: too many redirects");
        return false;
      }
      if (!location[0] || !resolveRedirect(s_url, location, s_url2, sizeof(s_url2))) {
        logf("TLS-DL: missing/bad Location");
        return false;
      }
      strncpy(s_url, s_url2, sizeof(s_url) - 1);
      s_url[sizeof(s_url) - 1] = 0;
      logf("TLS-DL redirect -> %.120s", s_url);
      continue;
    }

    if (status != 200) {
      logf("TLS-DL: unexpected status %d", status);
      cli->stop(); tcp.stop();
      s_tcp_busy = false; pendingFlush();
      return false;
    }

    LittleFS.remove(path);
    File f = openCreate(path, "w");
    if (!f) {
      logf("TLS-DL: LittleFS open fail");
      cli->stop(); tcp.stop();
      s_tcp_busy = false; pendingFlush();
      return false;
    }

    long written = 0;
    int next_pct = 10;
    int next_prog = 20;

    if (chunked) {
      logf("TLS-DL: reading chunked body");
      while (true) {
        if (clientReadLine(*cli, line, sizeof(line), 30000) < 0) {
          logf("TLS-DL: chunk size timeout");
          f.close(); LittleFS.remove(path);
          cli->stop(); tcp.stop();
          s_tcp_busy = false; pendingFlush();
          return false;
        }
        char *semi = strchr(line, ';');
        if (semi) *semi = 0;
        long chunk = strtol(line, nullptr, 16);
        if (chunk < 0) {
          f.close(); LittleFS.remove(path);
          cli->stop(); tcp.stop();
          s_tcp_busy = false; pendingFlush();
          return false;
        }
        if (chunk == 0) {
          while (clientReadLine(*cli, line, sizeof(line), 5000) > 0) {}
          break;
        }
        long left = chunk;
        while (left > 0) {
          int want = (int)((left > (long)HTTP_CHUNK) ? HTTP_CHUNK : left);
          int got = clientReadExact(*cli, s_http_buf, want, 60000);
          if (got <= 0) {
            logf("TLS-DL: chunk read fail");
            f.close(); LittleFS.remove(path);
            cli->stop(); tcp.stop();
            s_tcp_busy = false; pendingFlush();
            return false;
          }
          f.write(s_http_buf, got);
          written += got;
          left -= got;
        }
        clientReadExact(*cli, s_http_buf, 2, 5000);
        if (content_length > 0) {
          int pct = (int)((written * 100) / content_length);
          if (pct >= next_pct) { logf("DL: %d%% (%ld)", pct, written); next_pct += 10; }
          if (pct >= next_prog) {
            progressf("UPDATE", "arrow_down", 3, "Download %d%% (%ld bytes)", pct, written);
            next_prog += 20;
          }
        } else if ((written % (256 * 1024)) < HTTP_CHUNK) {
          logf("DL: %ld bytes (chunked)", written);
        }
      }
    } else {
      if (content_length <= 0)
        logf("TLS-DL: no Content-Length — reading until close (idle 30s)");
      else
        logf("TLS-DL: streaming %ld bytes", content_length);

      uint32_t t_start = millis();
      uint32_t last_byte_ms = millis();
      const uint32_t IDLE_ABORT_MS = 30000;
      long next_dbg16 = 16384;
      uint32_t last_starve_log = 0;
      bool ssl_dead = false, ssl_dead_logged = false;

      while (content_length < 0 || written < content_length) {
        int want = 1460; // TCP MSS-sized chunks
        if (want > (int)sizeof(s_http_buf)) want = (int)sizeof(s_http_buf);
        if (content_length >= 0 && (content_length - written) < want)
          want = (int)(content_length - written);
        if (want <= 0) break;

        // Drain any already-decrypted / buffered bytes first (don't require connected())
        int got = 0;
        if (cli->available() > 0) {
          got = cli->read(s_http_buf, want);
        } else {
          // Try a direct read — SSL may pull from TCP even when available() was 0
          got = cli->read(s_http_buf, want);
        }

        if (got > 0) {
          f.write(s_http_buf, got);
          written += got;
          last_byte_ms = millis();
          if (written >= next_dbg16) {
            logf("DL-DBG: dec=%ld raw=%lu rest_len=%d rxerr=%lu staleOK=%lu", written, (unsigned long)tcp.rawTotal(), tcp.restLen(), (unsigned long)tcp.rxErrors(), (unsigned long)tcp.staleOk());
            next_dbg16 += 16384;
          }
          if (content_length > 0) {
            int pct = (int)((written * 100L) / content_length);
            if (pct >= next_pct || written >= content_length) {
              uint32_t elapsed = millis() - t_start;
              float bps = elapsed ? (written * 1000.0f) / elapsed : 0;
              logf("DL: %d%% (%ld / %ld) %.0f B/s", pct, written, content_length, bps);
              next_pct = ((pct / 10) + 1) * 10;
            }
            if (pct >= next_prog || written >= content_length) {
              progressf("UPDATE", "arrow_down", 3, "Download %d%% (%ld / %ld)", pct, written, content_length);
              next_prog += 20;
            }
          } else if ((written % (128 * 1024)) < 1460) {
            logf("DL: %ld bytes so far", written);
          }
          continue;
        }

        // Empty read — NOT end of stream when Content-Length remains
        delay(40);

        // Modem-level remaining bytes (raw TCP, still encrypted for HTTPS)
        int ssl_av = cli->available();   // drives SSL engine -> tcp.available() -> CIPRXGET=2
        int rem = tcp.restLen();          // from last CIPRXGET=2 (no extra AT traffic)
        // SSL engine died? Log exactly why, once, then keep pumping a few times
        if (cli == &ssl && !ssl_dead && ssl_av <= 0 && ssl.tsimEngineState() == BR_SSL_CLOSED) ssl_dead = true;
        if (cli == &ssl && !ssl_dead && ssl_av <= 0 && !ssl.connected()) ssl_dead = true;
        if (ssl_dead && !ssl_dead_logged) {
          ssl_dead_logged = true;
          logf("SSL-DEAD: br_err=%d eng_state=%d stop_line=%d ssl_wr_err=%d tcp_wr_err=%d tcp_conn=%d close_reason=%d rest_len=%d raw=%lu dec=%ld",
               ssl.tsimLastSSLError(), ssl.tsimEngineState(), ssl.tsimStopLine(), ssl.tsimWriteError(),
               tcp.getWriteError(), (int)tcp.connected(), tcp.closeReason(), tcp.restLen(),
               (unsigned long)tcp.rawTotal(), written);
          progressf("UPDATE", "warning", 4, "SSL closed br_err=%d line=%d at %ld bytes", ssl.tsimLastSSLError(), ssl.tsimStopLine(), written);
        }
        if (ssl_dead) {
          // The BearSSL engine is closed: it cannot decrypt further records, so pumping
          // TCP bytes into it cannot recover the stream. Abort with the diagnostic above.
          if (rem > 0 || tcp.available() > 0) logf("SSL-DEAD: %d raw bytes left undecryptable", rem);
          break;
        }
        if (rem > 0 && tcp.msSincePoll() > 1000 && millis() - last_starve_log > 1000) {
          logf("DL-WARN: rest_len=%d but no CIPRXGET=2 for %lu ms (ssl connected=%d)", rem,
               (unsigned long)tcp.msSincePoll(), (int)cli->connected());
          last_starve_log = millis();
          tcp.available();  // force a poll
        }
        bool rem_closed = tcp.remoteClosed();

        if (content_length >= 0 && written < content_length) {
          if (millis() - last_byte_ms < IDLE_ABORT_MS) {
            // Transient empty (+IP ERROR: No data) — retry
            continue;
          }
          // Idle timeout with nothing left in modem / SSL
          logf("TLS-DL: no progress %lu ms: dec=%ld/%ld raw=%lu rem=%d rest_len=%d ssl_av=%d closed=%d rxerr=%lu staleOK=%lu modemRem=%d sslConn=%d",
               (unsigned long)(millis() - last_byte_ms), written, content_length,
               (unsigned long)tcp.rawTotal(), rem, tcp.restLen(), ssl_av, (int)rem_closed,
               (unsigned long)tcp.rxErrors(), (unsigned long)tcp.staleOk(), tcp.queryRxRemaining(), (int)cli->connected());
          progressf("UPDATE", "warning", 4, "DL stalled %ld/%ld raw=%lu rem=%d", written, content_length, (unsigned long)tcp.rawTotal(), rem);
          break;
        }

        // Unknown length: stop only on remote close + empty + idle
        if (content_length < 0) {
          if (ssl_av > 0 || rem > 0) continue;
          if (rem_closed || !tcp.connected()) {
            if (millis() - last_byte_ms > 2000) break;
          }
          if (millis() - last_byte_ms > IDLE_ABORT_MS) break;
        }
      }
    }

    f.close();
    // Close socket fully before any AT / telemetry flush
    logf("TLS-DL: closing socket after body (%ld bytes)", written);
    cli->stop();
    tcp.stop();
    s_tcp_busy = false;
    pendingFlush();

    if (content_length >= 0 && written != content_length) {
      logf("TLS-DL: size mismatch got=%ld expected=%ld", written, content_length);
      LittleFS.remove(path);
      return false;
    }
    if (written <= 0) {
      logf("TLS-DL: empty body");
      LittleFS.remove(path);
      return false;
    }
    logf("TLS-DL: complete %ld bytes OK", written);
    progressf("UPDATE", "white_check_mark", 3, "Download done: %ld bytes", written);
    return true;
  }
  s_tcp_busy = false;
  pendingFlush();
  return false;
}

// Plain http:// fallback using modem built-in HTTP (no SSL cmds)
static bool httpDownloadModemPlain(const char *url, const char *path) {
  logf("HTTP-plain (modem) %s", url);
  modemAT("AT+HTTPTERM", 3000);
  if (!modemAT("AT+HTTPINIT", 10000)) return false;
  snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+HTTPPARA=\"URL\",\"%s\"", url);
  if (!modemAT(s_cmdbuf, 10000)) { modemAT("AT+HTTPTERM"); return false; }
  modemAT("AT+HTTPACTION=0", 120000);
  uint32_t t0 = millis();
  size_t urc_len = strlen(s_at_resp);
  int status = -1, datalen = -1;
  while (millis() - t0 < 120000) {
    char *p = strstr(s_at_resp, "+HTTPACTION:");
    if (p) {
      int a, b, c;
      if (sscanf(p, "+HTTPACTION: %d,%d,%d", &a, &b, &c) >= 2) { status = b; datalen = c; break; }
    }
    while (ModemSerial.available() && urc_len + 1 < sizeof(s_at_resp)) {
      s_at_resp[urc_len++] = (char)ModemSerial.read(); s_at_resp[urc_len] = 0;
    }
    delay(20);
  }
  logf("MODEM-HTTP status=%d len=%d", status, datalen);
  if (status >= 300 && status < 400) logf("MODEM-HTTP: redirect, not followed");
  if (status != 200 || datalen <= 0) { modemAT("AT+HTTPTERM"); return false; }

  LittleFS.remove(path);
  File f = openCreate(path, "w");
  if (!f) { modemAT("AT+HTTPTERM"); return false; }
  int offset = 0;
  while (offset < datalen) {
    int chunk = HTTP_CHUNK;
    if (offset + chunk > datalen) chunk = datalen - offset;
    snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+HTTPREAD=%d,%d", offset, chunk);
    while (ModemSerial.available()) ModemSerial.read();
    ModemSerial.print(s_cmdbuf); ModemSerial.print("\r\n");
    size_t hdr_n = 0; s_at_resp[0] = 0;
    uint32_t t1 = millis();
    int readLen = -1; bool done = false;
    while (millis() - t1 < 60000 && !done) {
      while (ModemSerial.available()) {
        char c = (char)ModemSerial.read();
        if (hdr_n + 1 >= sizeof(s_at_resp)) { f.close(); LittleFS.remove(path); modemAT("AT+HTTPTERM"); return false; }
        s_at_resp[hdr_n++] = c; s_at_resp[hdr_n] = 0;
        char *p = strstr(s_at_resp, "+HTTPREAD:");
        if (p) {
          char *nl = strchr(p, '\n');
          if (nl) {
            sscanf(p, "+HTTPREAD: %d", &readLen);
            int got = 0;
            if (readLen <= 0 || readLen > (int)sizeof(s_http_buf)) { logf("MODEM-HTTP: bad HTTPREAD len %d", readLen); f.close(); LittleFS.remove(path); modemAT("AT+HTTPTERM"); return false; }
            while (got < readLen && millis() - t1 < 90000) {
              int av = ModemSerial.available();
              if (av <= 0) { delay(1); continue; }
              if (av > readLen - got) av = readLen - got;
              got += ModemSerial.readBytes(s_http_buf + got, av);
            }
            if (got != readLen) { f.close(); LittleFS.remove(path); modemAT("AT+HTTPTERM"); return false; }
            f.write(s_http_buf, got); offset += got; modemReadUntil(5000); done = true;
            if (offset / 16384 != (offset - got) / 16384) {
              logf("MODEM-HTTP: %d/%d (%d%%)", offset, datalen, (int)(offset * 100LL / datalen));
              progressf("UPDATE", "arrow_down", 3, "Download %d%% (%d / %d)", (int)(offset * 100LL / datalen), offset, datalen);
            }
            break;
          }
        }
      }
      if (!done) delay(1);
    }
    if (!done) { f.close(); LittleFS.remove(path); modemAT("AT+HTTPTERM"); return false; }
  }
  f.close();
  modemAT("AT+HTTPTERM");
  logf("HTTP-plain complete %d", datalen);
  return true;
}

static bool httpDownloadToFile(const char *url, const char *path) {
  if (strncmp(url, "https://", 8) == 0) {
    // Modem's built-in HTTPS first (works for non-redirect URLs, e.g. raw.githubusercontent.com).
    // 3xx / 709 / any failure -> ESP32 TLS path (follows redirects).
    if (httpDownloadModemPlain(url, path)) return true;
    logf("modem HTTP(S) failed/redirect -> ESP32 TLS path");
    progressf("UPDATE", "arrows_counterclockwise", 3, "Modem HTTP failed, trying ESP32 TLS");
    return httpDownloadTls(url, path);
  }
  if (strncmp(url, "http://", 7) == 0) {
    // Prefer TLS path also works for http (plain TCP); modem HTTP as fallback
    if (httpDownloadTls(url, path)) return true;
    logf("TLS-DL http failed — modem HTTP fallback");
    return httpDownloadModemPlain(url, path);
  }
  return false;
}

// -------------------- flash --------------------
static bool isMergedImage(File &f, const char *url) {
  if (url && (strstr(url, "-merged") || strstr(url, "merged") || strstr(url, "factory") ||
              strstr(url, "freshInstall"))) return true;
  uint8_t magic = 0;
  f.seek(0);
  if (f.read(&magic, 1) != 1) return false;
  return (magic == 0xE9 && f.size() > 1024 * 1024);
}

// Stream the LittleFS file once (after it is closed) and MD5 it. md5_pad covers
// the file plus 0xFF up to 'padded_len' (what the Heltec actually hashes).
static bool fileMd5(const char *path, size_t padded_len, String &md5_file, String &md5_pad) {
  File f = LittleFS.open(path, "r");
  if (!f) return false;
  MD5Builder a, b; a.begin(); b.begin();
  size_t total = 0;
  while (true) {
    size_t n = f.read(s_flash_block, FLASH_BLOCK_SIZE);
    if (n == 0) break;
    a.add(s_flash_block, n); b.add(s_flash_block, n);
    total += n;
  }
  f.close();
  uint8_t ff = 0xFF;
  for (size_t i = total; i < padded_len; i++) b.add(&ff, 1);
  a.calculate(); b.calculate();
  md5_file = a.toString(); md5_pad = b.toString();
  logf("flash: file MD5 %s (%u bytes)%s%s", md5_file.c_str(), (unsigned)total,
       padded_len != total ? ", padded " : "", padded_len != total ? md5_pad.c_str() : "");
  return true;
}

// Always leave the Heltec running its app: BOOT high-Z, then RST pulse.
static void heltecEndFlash(bool loader_up) {
  if (loader_up) loader_port_arduino_deinit();
  pinMode(HELTEC_BOOT_PIN, INPUT);   // release BOOT/GPIO0 first
  delay(20);
  heltecReboot();                    // pulse RST -> normal boot
  heltecPinsRelease();
  logf("flash: BOOT released + Heltec reset");
}

static bool flashHeltecFromFile(const char *path, const char *url) {
  File f = LittleFS.open(path, "r");
  if (!f) { logf("flash: cannot open"); return false; }
  size_t size = f.size();
  if (size < 256) { logf("flash: too small"); f.close(); return false; }
  bool merged = isMergedImage(f, url);
  f.close();
  uint32_t addr = merged ? 0x0 : 0x10000;
  uint32_t flash_size = (size + 3) & ~3u;

  String md5_file, md5_pad;
  if (!fileMd5(path, flash_size, md5_file, md5_pad)) { logf("flash: MD5 read fail"); return false; }

  logf("flash: START size=%u addr=0x%X merged=%d", (unsigned)size, addr, (int)merged);
  progressf("UPDATE", "hammer_and_wrench", 4, "Flash start: %u bytes @ 0x%X merged=%d md5=%s",
        (unsigned)size, addr, (int)merged, md5_file.c_str());

  f = LittleFS.open(path, "r");
  if (!f) { logf("flash: reopen fail"); return false; }

  loader_arduino_config_t cfg = {};
  cfg.uart = &HeltecSerial;
  cfg.reset_pin = HELTEC_RST_PIN;
  cfg.boot_pin = HELTEC_BOOT_PIN;
  cfg.uart_tx_pin = HELTEC_UART_TX_PIN;
  cfg.uart_rx_pin = HELTEC_UART_RX_PIN;
  loader_port_arduino_init(&cfg);

  esp_loader_connect_args_t connect = ESP_LOADER_CONNECT_DEFAULT();
  connect.trials = 15; connect.sync_timeout = 200;
  esp_loader_error_t err = esp_loader_connect(&connect);
  if (err != ESP_LOADER_SUCCESS) {
    logf("flash: connect fail %d, stub", (int)err);
    err = esp_loader_connect_with_stub(&connect);
  }
  if (err != ESP_LOADER_SUCCESS) {
    logf("flash: connect FAILED %d", (int)err);
    f.close(); heltecEndFlash(true); return false;
  }
  if (esp_loader_change_transmission_rate(460800) == ESP_LOADER_SUCCESS) {
    HeltecSerial.updateBaudRate(460800);
  }
  err = esp_loader_flash_start(addr, flash_size, FLASH_BLOCK_SIZE);
  if (err != ESP_LOADER_SUCCESS) {
    logf("flash: start FAILED %d", (int)err);
    f.close(); heltecEndFlash(true); return false;
  }
  size_t written = 0;
  int next_pct = 20;
  while (written < size) {
    size_t toRead = FLASH_BLOCK_SIZE;
    if (written + toRead > size) toRead = size - written;
    size_t got = f.read(s_flash_block, toRead);
    if (got != toRead) {
      logf("flash: file read short %u/%u @%u", (unsigned)got, (unsigned)toRead, (unsigned)written);
      f.close(); heltecEndFlash(true); return false;
    }
    // Pass the REAL length: the library pads to the block size itself and its
    // incremental MD5 then covers only (got+3)&~3 bytes, matching flash_size.
    err = esp_loader_flash_write(s_flash_block, (uint32_t)got);
    if (err != ESP_LOADER_SUCCESS) {
      logf("flash: write fail @%u", (unsigned)written);
      f.close(); heltecEndFlash(true); return false;
    }
    written += got;
    int pct = (int)((written * 100ULL) / size);
    if (pct >= next_pct || written >= size) {
      logf("flash: %d%%", pct);
      progressf("UPDATE", "hammer_and_wrench", 3, "Flash %d%%", pct);
      next_pct += 20;
    }
  }
  f.close();

  // Verify against the MD5 we streamed from the file (independent of the
  // library's incremental context). Heltec hashes addr..addr+flash_size.
  err = esp_loader_flash_verify_known_md5(addr, flash_size, (const uint8_t *)md5_pad.c_str());
  bool ok = (err == ESP_LOADER_SUCCESS);
  if (ok) {
    logf("flash: MD5 OK  file=%s  heltec=%s", md5_file.c_str(), md5_pad.c_str());
    progressf("UPDATE", "white_check_mark", 3, "MD5 verify OK %s", md5_file.c_str());
    esp_loader_flash_finish(true);
    delay(200);
  } else {
    logf("flash: MD5 FAILED err=%d expected(file)=%s (Heltec value printed by [flasher] above)",
         (int)err, md5_pad.c_str());
    progressf("UPDATE", "x", 5, "MD5 mismatch, file=%s", md5_file.c_str());
  }
  heltecEndFlash(true);   // ALWAYS: release BOOT + reset, success or failure
  if (ok) progressf("UPDATE", "recycle", 3, "Heltec reset done");
  return ok;
}

// -------------------- STATUS --------------------
static float readAdcVolts(int pin, float divider) {
  uint32_t mv = 0;
  for (int i = 0; i < 8; i++) mv += analogReadMilliVolts(pin);
  return ((mv / 8) * divider) / 1000.0f;
}
static int batPercent(float v) {
  if (v >= 4.15f) return 100;
  if (v <= 3.30f) return 0;
  return (int)((v - 3.30f) * 100.0f / 0.85f);
}

static void doStatusReport(void) {
  float bat = readAdcVolts(BOARD_BAT_ADC_PIN, 2.0f);
  float sol = readAdcVolts(BOARD_SOLAR_ADC_PIN, 2.0f);
  static char csq[80]="?", cpsi[200]="?", cops[80]="?", cereg[40]="?", ip[80]="?", cgmr[120]="?";
  auto grab = [](const char *tag, char *dst, size_t n) {
    char *p = strstr(s_at_resp, tag);
    if (!p) return;
    strncpy(dst, p, n - 1); dst[n - 1] = 0;
    char *nl = strpbrk(dst, "\r\n"); if (nl) *nl = 0;
  };
  if (modemAT("AT+CSQ", 3000)) grab("+CSQ:", csq, sizeof(csq));
  if (modemAT("AT+CPSI?", 5000)) grab("+CPSI:", cpsi, sizeof(cpsi));
  if (modemAT("AT+COPS?", 5000)) grab("+COPS:", cops, sizeof(cops));
  if (modemAT("AT+CEREG?", 3000)) grab("+CEREG:", cereg, sizeof(cereg));
  if (modemAT("AT+CGMR", 5000)) {
    strncpy(cgmr, s_at_resp, sizeof(cgmr) - 1);
    for (char *q = cgmr; *q; q++) if (*q == '\r' || *q == '\n') *q = ' ';
  }
  bool had = s_pdp_up;
  if (!s_pdp_up) modemOpenData();
  if (modemAT("AT+CGPADDR=1", 5000)) grab("+CGPADDR:", ip, sizeof(ip));
  size_t tot = LittleFS.totalBytes(), used = LittleFS.usedBytes();
  snprintf(s_text_body, sizeof(s_text_body),
    "%s | %s\nbat=%.2fV (%d%%) solar=%.2fV\n%s\n%s\n%s\n%s\n%s\nmodem: %.80s\n"
    "uptime=%lus wake=%d heap=%u\nLittleFS free=%u/%u\nlast: %s\n"
    "APN=%s awake=%lus cmds=REBOOT|UPDATE|STATUS|CMD|TESTDL",
    FW_VERSION, FW_BUILD_DATE, bat, batPercent(bat), sol,
    csq, cpsi, cops, cereg, ip, cgmr,
    (unsigned long)(millis()/1000UL), (int)s_wake_cause, (unsigned)ESP.getFreeHeap(),
    (unsigned)(tot - used), (unsigned)tot, s_last_result,
    APN, (unsigned long)(AWAKE_WINDOW_MS/1000UL));
  Serial.println(s_text_body);
  {
    int csqv = -1, rsrq = 0, rsrp = 0, reg = -1;
    char *p = strstr(csq, "+CSQ:"); if (p) sscanf(p, "+CSQ: %d", &csqv);
    // +CPSI: LTE,Online,MCC-MNC,TAC,CellID,PCI,Band,EARFCN,DLBW,ULBW,RSRQ,RSRP,RSSI,RSNR
    { int f = 0; const char *q = cpsi;
      while (*q) { if (*q == ',') { f++; if (f == 10) rsrq = atoi(q + 1); if (f == 11) rsrp = atoi(q + 1); } q++; } }
    p = strstr(cereg, "+CEREG:"); if (p) { int a, b2; if (sscanf(p, "+CEREG: %d,%d", &a, &b2) == 2) reg = b2; }
    char op[64] = "", ipv[48] = "", mfw[100] = "", lr[170];
    p = strchr(cops, '"'); if (p) { strncpy(op, p + 1, sizeof(op) - 1); char *e = strchr(op, '"'); if (e) *e = 0; }
    p = strchr(ip, ','); if (p) { strncpy(ipv, p + 1, sizeof(ipv) - 1); char *e = strpbrk(ipv, "\r\n "); if (e) *e = 0; }
    p = strstr(cgmr, "+CGMR:"); jsonEsc(mfw, sizeof(mfw), p ? p + 6 : cgmr);
    { char *e = strstr(mfw, "OK"); if (e) *e = 0; size_t L = strlen(mfw); while (L && mfw[L-1] == ' ') mfw[--L] = 0;
      char *st = mfw; while (*st == ' ') st++; memmove(mfw, st, strlen(st) + 1); }
    char ope[80], ipe[60]; jsonEsc(ope, sizeof(ope), op); jsonEsc(ipe, sizeof(ipe), ipv);
    jsonEsc(lr, sizeof(lr), s_last_result);
    snprintf(s_ingest_body, sizeof(s_ingest_body),
      "{\"type\":\"status\",\"fw\":\"%s\",\"uptime\":%lu,\"wake\":%d,\"battery_v\":%.2f,\"battery_pct\":%d,"
      "\"solar_v\":%.2f,\"csq\":%d,\"rsrp\":%d,\"rsrq\":%d,\"operator\":\"%s\",\"reg\":%d,\"ip\":\"%s\","
      "\"modem_fw\":\"%s\",\"heap\":%u,\"fs_free\":%u,\"last_update\":\"%s\",\"msg\":\"STATUS\"}",
      FW_VERSION, (unsigned long)(millis() / 1000UL), (int)s_wake_cause, bat, batPercent(bat), sol,
      csqv, rsrp, rsrq, ope, reg, ipe, mfw, (unsigned)ESP.getFreeHeap(), (unsigned)(tot - used), lr);
    ingestPostOrQueue(s_ingest_body);
  }
  (void)had;
}

// -------------------- UPDATE --------------------
static bool doUpdate(const char *url, bool flash_too) {
  s_busy_update = true;
  logf("UPDATE: begin flash=%d url_len=%u", (int)flash_too, (unsigned)strlen(url));
  progressf("UPDATE", "rocket", 4, "UPDATE start flash=%d\n%.160s", (int)flash_too, url);
  { char m[220]; snprintf(m, sizeof(m), "%s start: %.180s", flash_too ? "UPDATE" : "TESTDL", url); ingestEvent("update", m); }

  if (!modemWaitNetwork(60000)) {
    setLastResult("FAIL: no network");
    progressf("UPDATE", "x", 5, "FAIL: no network");
    s_busy_update = false; return false;
  }
  if (!modemOpenData()) {
    setLastResult("FAIL: PDP down");
    progressf("UPDATE", "x", 5, "FAIL: PDP down");
    s_busy_update = false; return false;
  }
  progressf("UPDATE", "signal_strength", 3, "PDP up APN=%s", APN);

  bool dl = httpDownloadToFile(url, FW_PATH);
  s_tcp_busy = false;
  pendingFlush();
  if (!dl) {
    setLastResult("FAIL: download");
    progressf("UPDATE", "x", 5, "FAIL: download");
    ingestEvent("update", "FAIL: download");
    modemCloseData();
    s_busy_update = false; return false;
  }
  if (!flash_too) {
    size_t sz = 0;
    File f = LittleFS.open(FW_PATH, "r");
    if (f) { sz = f.size(); f.close(); }
    setLastResult("OK: TESTDL %u bytes", (unsigned)sz);
    progressf("TESTDL", "white_check_mark", 3, "TESTDL OK %u bytes (no flash)", (unsigned)sz);
    ingestEvent("update", s_last_result);
    LittleFS.remove(FW_PATH);
    modemCloseData();
    s_busy_update = false;
    return true;
  }
  { size_t sz = 0; File f = LittleFS.open(FW_PATH, "r"); if (f) { sz = f.size(); f.close(); }
    char m[80]; snprintf(m, sizeof(m), "Download done: %u bytes, flashing", (unsigned)sz); ingestEvent("update", m); }
  bool flashed = flashHeltecFromFile(FW_PATH, url);
  LittleFS.remove(FW_PATH);
  modemCloseData();
  s_busy_update = false;
  if (flashed) {
    setLastResult("OK: flashed");
    progressf("UPDATE", "tada", 4, "SUCCESS: Heltec updated");
  } else {
    setLastResult("FAIL: flash");
    progressf("UPDATE", "x", 5, "FAIL: flash");
  }
  { char m[220]; snprintf(m, sizeof(m), "%s %.180s", flashed ? "SUCCESS:" : "FAIL: flash", url); ingestEvent("update", m); }
  return flashed;
}

static bool handleCommand(const char *from, const char *body) {
  (void)from;
  strncpy(s_cmdbuf, body, sizeof(s_cmdbuf) - 1);
  s_cmdbuf[sizeof(s_cmdbuf) - 1] = 0;
  normalizeSmsBody(s_cmdbuf);
  if (!s_cmdbuf[0]) return false;
  // Legacy trailing " ACK" token: accepted but ignored (no SMS is ever sent).
  size_t len = strlen(s_cmdbuf);
  if (len >= 4 && strcasecmp(s_cmdbuf + len - 4, " ACK") == 0) {
    s_cmdbuf[len - 4] = 0; normalizeSmsBody(s_cmdbuf);
  }
  if (strcasecmp(s_cmdbuf, "STATUS") == 0) {
    doStatusReport();
    meshSnapshot();
    return true;
  }
  if (strcasecmp(s_cmdbuf, "CMD") == 0) {
    doConsoleCommands();
    meshSnapshot();
    return true;
  }
  if (strcasecmp(s_cmdbuf, "REBOOT") == 0) {
    heltecReboot();
    { progressf("REBOOT", "arrows_counterclockwise", 3, "REBOOT done"); ingestEvent("reboot", "REBOOT done"); }
    return true;
  }
  if (strncasecmp(s_cmdbuf, "UPDATE ", 7) == 0) {
    const char *url = s_cmdbuf + 7;
    if (!(strncmp(url, "http://", 7) == 0 || strncmp(url, "https://", 8) == 0)) return false;
    if (strchr(url, ' ')) return false;
    static char url_copy[URL_MAX];
    strncpy(url_copy, url, sizeof(url_copy) - 1); url_copy[sizeof(url_copy) - 1] = 0;
    doUpdate(url_copy, true);
    return true;
  }
  logf("Ignore invalid SMS '%.80s'", s_cmdbuf);
  return false;
}

// -------------------- SMS text decoding --------------------
static bool isHexStr(const char *s, size_t n) {
  if (n == 0 || (n % 4) != 0) return false;
  for (size_t i = 0; i < n; i++) if (!isxdigit((unsigned char)s[i])) return false;
  return true;
}
static int hexNib(char c) { return c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10; }

// GSM 03.38 default alphabet -> ASCII, for any raw 7-bit chars that slip through
static char gsmToAscii(unsigned char c) {
  switch (c) {
    case 0x00: return '@'; case 0x02: return '$'; case 0x11: return '_';
    default: return (c >= 0x20 && c < 0x7f) ? (char)c : '?';
  }
}

// Decode an SMS field read with AT+CSCS="UCS2" (hex UTF-16BE, incl. surrogates)
// into UTF-8. Falls back to GSM->ASCII mapping if the field is not hex.
static void decodeSmsField(char *s, size_t cap) {
  size_t n = strlen(s);
  static char out[1024];
  size_t o = 0;
  if (isHexStr(s, n)) {
    for (size_t i = 0; i + 4 <= n && o + 5 < sizeof(out); i += 4) {
      uint32_t u = (hexNib(s[i]) << 12) | (hexNib(s[i+1]) << 8) | (hexNib(s[i+2]) << 4) | hexNib(s[i+3]);
      if (u >= 0xD800 && u <= 0xDBFF && i + 8 <= n) {
        uint32_t lo = (hexNib(s[i+4]) << 12) | (hexNib(s[i+5]) << 8) | (hexNib(s[i+6]) << 4) | hexNib(s[i+7]);
        if (lo >= 0xDC00 && lo <= 0xDFFF) { u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00); i += 4; }
      }
      if (u < 0x80) out[o++] = (char)u;
      else if (u < 0x800) { out[o++] = 0xC0 | (u >> 6); out[o++] = 0x80 | (u & 0x3F); }
      else if (u < 0x10000) { out[o++] = 0xE0 | (u >> 12); out[o++] = 0x80 | ((u >> 6) & 0x3F); out[o++] = 0x80 | (u & 0x3F); }
      else { out[o++] = 0xF0 | (u >> 18); out[o++] = 0x80 | ((u >> 12) & 0x3F); out[o++] = 0x80 | ((u >> 6) & 0x3F); out[o++] = 0x80 | (u & 0x3F); }
    }
  } else {
    for (size_t i = 0; i < n && o + 1 < sizeof(out); i++) {
      unsigned char c = (unsigned char)s[i];
      out[o++] = (c == '\r' || c == '\n' || c == '\t') ? (char)c : (c < 0x80 ? gsmToAscii(c) : (char)c);
    }
  }
  out[o] = 0;
  strncpy(s, out, cap - 1); s[cap - 1] = 0;
}

// -------------------- SMS inbox --------------------
static int parseOneCmgl(const char **p_inout) {
  const char *p = strstr(*p_inout, "+CMGL:");
  if (!p) return -1;
  int index = -1;
  if (sscanf(p, "+CMGL: %d", &index) != 1) { *p_inout = p + 6; return -1; }
  const char *q = p; int quotes = 0;
  const char *fs = nullptr, *fe = nullptr;
  while (*q && *q != '\n' && quotes < 4) {
    if (*q == '"') { quotes++; if (quotes == 3) fs = q + 1; else if (quotes == 4) { fe = q; break; } }
    q++;
  }
  s_sms_from[0] = 0;
  if (fs && fe && fe > fs) {
    size_t fl = (size_t)(fe - fs);
    if (fl >= sizeof(s_sms_from)) fl = sizeof(s_sms_from) - 1;
    memcpy(s_sms_from, fs, fl); s_sms_from[fl] = 0;
  }
  const char *nl = strchr(p, '\n');
  if (!nl) { *p_inout = p + 6; return -1; }
  const char *bs = nl + 1; if (*bs == '\r') bs++;
  const char *next = strstr(bs, "+CMGL:");
  const char *okpos = strstr(bs, "\nOK");
  const char *be = bs + strlen(bs);
  if (next && next < be) be = next;
  if (okpos && okpos < be) be = okpos;
  size_t bl = (size_t)(be - bs);
  if (bl >= sizeof(s_sms_body)) bl = sizeof(s_sms_body) - 1;
  memcpy(s_sms_body, bs, bl); s_sms_body[bl] = 0;
  trimInPlace(s_sms_body);
  decodeSmsField(s_sms_body, sizeof(s_sms_body));
  decodeSmsField(s_sms_from, sizeof(s_sms_from));
  *p_inout = be;
  return index;
}

static void processSmsInbox() {
  // Read with UCS2 so every char ('_', '@', '$', ...) arrives as unambiguous hex.
  modemAT("AT+CSCS=\"UCS2\"");
  if (!modemAT("AT+CMGL=\"REC UNREAD\"", 15000) || !strstr(s_at_resp, "+CMGL:"))
    modemAT("AT+CMGL=\"ALL\"", 15000);
  static char inbox[8192];
  strncpy(inbox, s_at_resp, sizeof(inbox) - 1); inbox[sizeof(inbox) - 1] = 0;
  modemAT("AT+CSCS=\"GSM\"");  // restore default charset
  const char *cursor = inbox;
  int count = 0;
  while (count < 10) {
    int idx = parseOneCmgl(&cursor);
    if (idx < 0) break;
    count++;
    logf("SMS[%d] from=%s body='%.200s'", idx, s_sms_from, s_sms_body);
    static char from_copy[160], body_copy[1024];
    strncpy(from_copy, s_sms_from, sizeof(from_copy)-1); from_copy[sizeof(from_copy)-1]=0;
    strncpy(body_copy, s_sms_body, sizeof(body_copy)-1); body_copy[sizeof(body_copy)-1]=0;
    if (!handleCommand(from_copy, body_copy)) {
      // v1.5.1: some texts come back from UCS2 CMGL as short/odd hex (e.g. "005300" for STATUS).
      // Re-read this one message in GSM charset and try again.
      modemAT("AT+CSCS=\"GSM\"");
      snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+CMGR=%d", idx);
      if (modemAT(s_cmdbuf, 5000)) {
        const char *h = strstr(s_at_resp, "+CMGR:");
        const char *nl = h ? strchr(h, '\n') : nullptr;
        if (nl) {
          const char *bs = nl + 1; if (*bs == '\r') bs++;
          const char *be = strstr(bs, "\r\nOK"); if (!be) be = strstr(bs, "\nOK"); if (!be) be = bs + strlen(bs);
          size_t bl = (size_t)(be - bs); if (bl >= sizeof(body_copy)) bl = sizeof(body_copy) - 1;
          memcpy(body_copy, bs, bl); body_copy[bl] = 0; trimInPlace(body_copy);
          logf("SMS[%d] GSM re-read body='%.200s'", idx, body_copy);
          handleCommand(from_copy, body_copy);
        }
      }
    }
    snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+CMGD=%d", idx);
    modemAT(s_cmdbuf, 5000);
  }
  logf("SMS processed: %d", count);
}

static void goToSleep() {
  if (s_busy_update) { logf("sleep deferred — UPDATE running"); return; }
  logf("Deep sleep; RI GPIO%d LOW", MODEM_RI_PIN);
  heltecPinsRelease();
  modemEnableSleep();
  pinMode(MODEM_RI_PIN, INPUT);
  gpio_hold_en((gpio_num_t)MODEM_DTR_PIN);
  gpio_deep_sleep_hold_en();
  if (esp_sleep_enable_ext0_wakeup((gpio_num_t)MODEM_RI_PIN, 0) != ESP_OK)
    esp_sleep_enable_timer_wakeup(60ULL * 1000000ULL);
  Serial.flush(); delay(100);
  esp_deep_sleep_start();
}

// -------------------- USB --------------------
static char s_usb_line[URL_MAX + 32];
static size_t s_usb_len = 0;

static void handleUsbLine(char *line) {
  trimInPlace(line);
  if (!line[0]) return;
  if (strcasecmp(line, "SLEEP") == 0) { goToSleep(); return; }
  if (strcasecmp(line, "STAY") == 0) return;
  if (strcasecmp(line, "LASTLOG") == 0) { printLastLog(); return; }
  if (strcasecmp(line, "STATUS") == 0) { doStatusReport(); return; }
  if (strcasecmp(line, "MESH") == 0) { meshSnapshot(); return; }
  if (strcasecmp(line, "CMD") == 0) { doConsoleCommands(); meshSnapshot(); return; }
  if (strncasecmp(line, "CLI ", 4) == 0) { heltecCli(line + 4, s_cli_out, sizeof(s_cli_out)); heltecCliEnd(); Serial.println(s_cli_out); return; }
  if (strcasecmp(line, "REBOOT") == 0) {
    heltecReboot(); { progressf("REBOOT", "arrows_counterclockwise", 3, "REBOOT done"); ingestEvent("reboot", "REBOOT done"); } return;
  }
  if (strncasecmp(line, "TESTDL ", 7) == 0) {
    const char *url = line + 7;
    while (*url && isspace((unsigned char)*url)) url++;
    static char u[URL_MAX];
    strncpy(u, url, sizeof(u)-1); u[sizeof(u)-1]=0;
    doUpdate(u, false); return;
  }
  if (strncasecmp(line, "UPDATE ", 7) == 0) { handleCommand("USB", line); return; }
  if (strncasecmp(line, "AT", 2) == 0) {
    const char *cmd = line;
    if (line[2] == ' ') { cmd = line + 3; while (*cmd && isspace((unsigned char)*cmd)) cmd++; }
    modemAT(cmd, 15000); return;
  }
  logf("USB: AT|REBOOT|UPDATE|TESTDL|STATUS|MESH|CMD|CLI <cmd>|LASTLOG|SLEEP|STAY");
}

static void interactiveWindow(uint32_t window_ms) {
  uint32_t deadline = millis() + window_ms;
  uint32_t next_countdown = millis();
  uint32_t next_sms = millis() + 3000;
  s_usb_len = 0;
  logf("Awake %us — AT|REBOOT|UPDATE|TESTDL|STATUS|LASTLOG|SLEEP|STAY", (unsigned)(window_ms/1000));
  printLastLog();
  while ((int32_t)(deadline - millis()) > 0) {
    if (s_busy_update) deadline = millis() + window_ms;
    while (Serial.available()) {
      char c = (char)Serial.read();
      if (c == '\r') continue;
      if (c == '\n') {
        s_usb_line[s_usb_len] = 0;
        if (strcasecmp(s_usb_line, "STAY") == 0) {
          deadline = millis() + window_ms; next_countdown = millis();
          logf("STAY: +%us", (unsigned)(window_ms/1000));
        } else if (strcasecmp(s_usb_line, "SLEEP") == 0) { goToSleep(); return; }
        else handleUsbLine(s_usb_line);
        s_usb_len = 0;
      } else if (s_usb_len + 1 < sizeof(s_usb_line)) s_usb_line[s_usb_len++] = c;
    }
    if ((int32_t)(millis() - next_countdown) >= 0) {
      int32_t left = (int32_t)(deadline - millis()); if (left < 0) left = 0;
      logf("Awake: %d s left%s", (int)((left+999)/1000), s_busy_update ? " (UPDATE)" : "");
      next_countdown = millis() + 15000;
    }
    if ((int32_t)(millis() - next_sms) >= 0) {
      if (!s_busy_update) processSmsInbox();
      next_sms = millis() + 3000;
    }
    delay(20);
  }
}

void setup() {
  Serial.begin(115200);
  delay(800);
  s_wake_cause = esp_sleep_get_wakeup_cause();
  bool fast = (s_wake_cause == ESP_SLEEP_WAKEUP_EXT0) || (s_wake_cause == ESP_SLEEP_WAKEUP_TIMER);
  logf("=== %s ===", FW_VERSION);
  logf("Built: %s", FW_BUILD_DATE);
  logf("Wake: %d%s", (int)s_wake_cause, fast ? " (fast)" : " (cold/RST)");
  logf("ingest: %s", INGEST_URL);
  logf("heap: %u", (unsigned)ESP.getFreeHeap());
  gpio_deep_sleep_hold_dis();
  gpio_hold_dis((gpio_num_t)MODEM_DTR_PIN);
  heltecPinsRelease();
  analogReadResolution(12);
  // LilyGO ReadBattery example: 11 dB attenuation, GPIO4 = VBAT/2, GPIO5 = solar/2 (both ADC1).
  // Per LilyGO, the battery reads 0 V on T-SIM7670G/7672G while USB is plugged in.
  analogSetPinAttenuation(BOARD_BAT_ADC_PIN, ADC_11db);
  analogSetPinAttenuation(BOARD_SOLAR_ADC_PIN, ADC_11db);
  if (!LittleFS.begin(true)) logf("LittleFS mount failed");
  else {
    logf("LittleFS OK total=%u used=%u", (unsigned)LittleFS.totalBytes(), (unsigned)LittleFS.usedBytes());
    loadLastResult();
    printLastLog();
  }
  if (!modemPowerOn()) {
    if (!fast) interactiveWindow(AWAKE_WINDOW_MS);
    goToSleep(); return;
  }
  modemAT("ATE0"); modemAT("AT+CMEE=2");
  bool sim = modemWaitCpinReady(20000);
  modemLogDiagnostics();
  if (sim) {
    modemWaitNetwork(fast ? 30000 : 60000);
    modemConfigureSms();
    processSmsInbox();
  }
  if (fast && !s_busy_update) { goToSleep(); return; }
  interactiveWindow(AWAKE_WINDOW_MS);
  goToSleep();
}

void loop() { delay(1000); goToSleep(); }
