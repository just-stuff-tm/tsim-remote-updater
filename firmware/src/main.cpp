#include <MD5Builder.h>
#include <esp_heap_caps.h>
#include <Arduino.h>
#include <LittleFS.h>
#include <esp_sleep.h>
#include <sys/time.h>
#include <driver/gpio.h>
#include <driver/rtc_io.h>
#include <esp_timer.h>
#include "hal/wdt_hal.h"
#include "soc/rtc.h"
#include <ctype.h>
#include <string.h>
#include <stdlib.h>
#include <stdarg.h>

#include <ESP_SSLClient.h>
#include "board.h"
#include "hw_guard.h"   // v1.7.6 self-reset guard + SMS merge (host-tested)
#include "tsim_frame.h" // v1.7.7 @TSIM frame parser (host-tested)
#include <Update.h>
#include <Preferences.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>
#include "esp_loader.h"
#include "arduino_port.h"
#include "modem_tcp.h"

SET_LOOP_TASK_STACK_SIZE(24 * 1024);

// Runtime config (v1.6.0): compiled-in values from include/config.h are saved to NVS; a build with the
// public placeholders (e.g. a GitHub release firmware.bin) loads them from NVS, so OTA keeps the config.
static char g_worker_url[160], g_device_id[40], g_device_key[80], g_apn[48], g_ingest_url[220], g_key_hdr[100];
static void loadConfig() {
  bool placeholder = strstr(DEVICE_KEY, "REPLACE") || strstr(WORKER_URL, "YOUR-SUBDOMAIN");
  Preferences p; p.begin("tsimcfg", false);
  if (!placeholder) {
    strncpy(g_worker_url, WORKER_URL, sizeof(g_worker_url) - 1); strncpy(g_device_id, DEVICE_ID, sizeof(g_device_id) - 1);
    strncpy(g_device_key, DEVICE_KEY, sizeof(g_device_key) - 1); strncpy(g_apn, APN, sizeof(g_apn) - 1);
    if (p.getString("url", "") != g_worker_url || p.getString("id", "") != g_device_id || p.getString("key", "") != g_device_key || p.getString("apn", "") != g_apn) {
      p.putString("url", g_worker_url); p.putString("id", g_device_id); p.putString("key", g_device_key); p.putString("apn", g_apn);
      Serial.println("config: saved compiled config to NVS");
    }
  } else if (p.getString("key", "").length()) {
    p.getString("url", g_worker_url, sizeof(g_worker_url)); p.getString("id", g_device_id, sizeof(g_device_id));
    p.getString("key", g_device_key, sizeof(g_device_key)); p.getString("apn", g_apn, sizeof(g_apn));
    Serial.println("config: placeholder build, using config from NVS");
  } else {
    strncpy(g_worker_url, WORKER_URL, sizeof(g_worker_url) - 1); strncpy(g_device_id, DEVICE_ID, sizeof(g_device_id) - 1);
    strncpy(g_device_key, DEVICE_KEY, sizeof(g_device_key) - 1); strncpy(g_apn, APN, sizeof(g_apn) - 1);
    Serial.println("config: WARNING placeholder build and no NVS config - set include/config.h and flash over USB");
  }
  p.end();
  snprintf(g_ingest_url, sizeof(g_ingest_url), "%s/ingest/%s", g_worker_url, g_device_id);
  snprintf(g_key_hdr, sizeof(g_key_hdr), "X-Device-Key: %s", g_device_key);
}

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

// v1.7.2 awake deadline: no wake may last forever. Two independent layers:
//  1. an esp_timer one-shot (runs in the high-priority esp_timer task) that restarts the ESP32;
//  2. the RTC hardware watchdog (RTC domain, independent of both CPUs and FreeRTOS), 60 s later, as a backstop.
// Both are re-armed with a longer limit while an update runs, and the RTC WDT is stopped right before deep sleep.
#define AWAKE_MAX_S        1200    // any wake: restart if still awake after 20 min (normal worst case: ~5 min recovery or a 5 min command batch)
#define AWAKE_MAX_UPD_S    2700    // while a T-SIM or Heltec update runs: 45 min
// RTC_NOINIT (not RTC_DATA): RTC_DATA is re-initialised on every boot that isn't a deep-sleep wake, so it can't carry a
// flag across esp_restart. A magic value marks "the deadline fired"; it is counted in NVS at the next boot.
#define DL_MAGIC 0xD1EAD172UL
RTC_NOINIT_ATTR static uint32_t s_dl_hit;
static esp_timer_handle_t s_dl_timer = nullptr;
static void dlFire(void *) { s_dl_hit = DL_MAGIC; esp_restart(); }
static void deadlineArm(uint32_t secs) {
  if (!s_dl_timer) { esp_timer_create_args_t a = {}; a.callback = dlFire; a.name = "awake_dl"; if (esp_timer_create(&a, &s_dl_timer) != ESP_OK) s_dl_timer = nullptr; }
  if (s_dl_timer) { esp_timer_stop(s_dl_timer); esp_timer_start_once(s_dl_timer, (uint64_t)secs * 1000000ULL); }
  wdt_hal_context_t r = {}; wdt_hal_init(&r, WDT_RWDT, 0, false);   // RTC watchdog (hardware, RTC domain)
  uint64_t ticks = (uint64_t)(secs + 60) * rtc_clk_slow_freq_get_hz();
  if (ticks > 0xFFFFFFFFULL) ticks = 0xFFFFFFFFULL;
  wdt_hal_write_protect_disable(&r);
  wdt_hal_disable(&r);
  wdt_hal_config_stage(&r, WDT_STAGE0, (uint32_t)ticks, WDT_STAGE_ACTION_RESET_SYSTEM);
  wdt_hal_feed(&r);
  wdt_hal_enable(&r);
  wdt_hal_write_protect_enable(&r);
}
static void deadlineStopForSleep() {
  if (s_dl_timer) esp_timer_stop(s_dl_timer);
  wdt_hal_context_t r = {}; wdt_hal_init(&r, WDT_RWDT, 0, false);
  wdt_hal_write_protect_disable(&r); wdt_hal_disable(&r); wdt_hal_write_protect_enable(&r);
}


// v1.4.1: dashboard telemetry queue (JSON bodies), flushed by pendingFlush()
static char s_ingest_q[6][1024];
static int s_ingest_q_len = 0;
static char s_ingest_body[1024];
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

static int64_t rtcNow();
RTC_DATA_ATTR static int64_t s_hw_cons = 0;  // v1.7.4: rtcNow() when the T-SIM last relayed a console "reboot" to the Heltec
// v1.7.5 uptime polling baseline (stats-core uptime_secs at rtcNow() s_up_last_t; 0 = no baseline). Cleared when the
// T-SIM resets the Heltec itself or relays a console reboot, so its own reboots never look like an unexplained one.
RTC_DATA_ATTR static uint32_t s_up_last = 0;
RTC_DATA_ATTR static int64_t s_up_last_t = 0;
RTC_DATA_ATTR static int64_t s_up_due = 0;
// v1.7.5 wire diagnostics (since the last T-SIM cold boot): bytes received in CLI replies, GPIO6 falling edges during
// those replies (0 with replies arriving = the GPIO6 wire isn't seeing Heltec TX), unsolicited bytes and edges outside
// CLI exchanges while awake, and the last sleep's Heltec-wake arming result (0 off, 1 auto-off, 2 skipped, 3 failed, 4 armed).
RTC_DATA_ATTR static uint32_t s_dg_clib = 0, s_dg_g6c = 0, s_dg_ub = 0, s_dg_g6i = 0;
RTC_DATA_ATTR static uint8_t s_hw_armres = 255;
RTC_DATA_ATTR static int64_t s_hw_own = 0;   // v1.7.3: rtcNow() when the T-SIM itself last reset the Heltec (its boot log isn't a "reboot")
// v1.7.6: the self-reset guard no longer depends on the RTC clock alone. The awake monitor's state carries a
// millis()-timed "self reset pending" flag that absorbs the first boot of the Heltec after heltecReboot(); the
// console "reboot" relay gets the same. s_hw_self counts boots absorbed as the T-SIM's own (NVS "hwo").
static HmState s_hm = {false, 0, {false, 0}};
static SelfReset s_cons = {false, 0};
static uint32_t s_hw_self = 0;
static void wdSave();
static void heltecReboot() {
  s_hw_own = rtcNow(); s_up_last_t = 0;
  selfResetMark(s_hm.self, millis());   // v1.7.6: set before the pulse, so the banner can never beat it
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
  logf("PDP: activating APN=%s", g_apn);
  snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+CGDCONT=1,\"IP\",\"%s\"", g_apn);
  modemAT(s_cmdbuf);
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
static float s_bat_idle_fwd(void);
static void ingestEvent(const char *type, const char *msg) {
  float bat = s_bat_idle_fwd();
  float sol = readAdcVolts(BOARD_SOLAR_ADC_PIN, 2.0f);
  char m[400], lr[170];
  jsonEsc(m, sizeof(m), msg); jsonEsc(lr, sizeof(lr), s_last_result);
  snprintf(s_ingest_body, sizeof(s_ingest_body),
    "{\"type\":\"%s\",\"fw\":\"%s\",\"uptime\":%lu,\"wake\":%d,\"rr\":%d,\"battery_v\":%.2f,\"battery_pct\":%d,"
    "\"solar_v\":%.2f,\"heap\":%u,\"last_update\":\"%s\",\"msg\":\"%s\"}",
    type, FW_VERSION, (unsigned long)(millis() / 1000UL), (int)s_wake_cause, (int)esp_reset_reason(), bat, batPercent(bat),
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
  if (!parseUrl(g_ingest_url, u)) return false;
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
               u.path, u.host, g_device_key, (unsigned)n);
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

static void markOtaValidIfPending(const char *why);
// v1.7.0: every post carries a compact telemetry snapshot ("tl") so the dashboard's T-SIM card stays current.
static size_t telemJson(char *out, size_t cap);
static char s_post_buf[4096 + 512];
static bool ingestSendRaw(const char *json) {
  size_t L = strlen(json);
  if (L > 1 && L + 400 < sizeof(s_post_buf) && json[L - 1] == '}' && !strstr(json, "\"tl\":{")) {
    memcpy(s_post_buf, json, L - 1); size_t o = L - 1;
    o += telemJson(s_post_buf + o, sizeof(s_post_buf) - o - 2);
    s_post_buf[o++] = '}'; s_post_buf[o] = 0; json = s_post_buf;
  }
  if (modemHttpPost(g_ingest_url, "application/json", g_key_hdr, json)) return true;
  logf("ingest: modem HTTPS failed, trying ESP32 TLS");
  return ingestPostTls(json);
}
static void hrpAfterPost(bool ok);   // v1.7.4 pending Heltec-reboot report (defined with the watchdog)
static bool ingestSend(const char *json) {
  bool ok = ingestSendRaw(json);
  if (ok) markOtaValidIfPending("ingest accepted");
  hrpAfterPost(ok);
  return ok;
}

// -------------------- Heltec MeshCore CLI + mesh snapshot + console (v1.5.0) --------------------
// MeshCore/EasySkyMesh repeater serial CLI (115200): commands end with '\r', typed chars are echoed,
// replies are printed as "  -> <reply>" (neighbors: multi-line). The Worker parses the raw text.
#define CLI_OUT_MAX        1024
#define CLI_TIMEOUT_MS     4000
#define CLI_QUIET_MS       350
#define CMD_FETCH_MAX      6144   // 1.6.9: up to 40 lines of "<id>\t<cmd>\n" (Worker caps the reply at 6000 bytes)
#define CMD_MAX_RUN        40     // 1.6.9: was 10
#define CMD_BUDGET_MS      300000 // stop starting new commands after 5 min of a batch
#define WD_CMD_BUDGET_MS   120000UL  // v1.7.2 watchdog wake: stop starting new console commands after 2 min
#define CMD_NOREPLY_STOP   3      // consecutive Heltec no-replies before skipping the rest (asleep / power saving)
static char s_cli_out[CLI_OUT_MAX];
static char s_mesh_body[4096];
static char s_cmd_list[CMD_FETCH_MAX];
static bool s_heltec_uart_on = false;

// v1.7.4 Heltec reboot detection while the T-SIM is awake. The Heltec UART (115200, the same baud as the ESP32-S3 ROM
// boot banner) stays open for the whole wake and every received byte goes through a line matcher looking for boot-only
// output: the ROM banner ("ESP-ROM:esp32...", "rst:0x.. ,boot:0x..") and stock MeshCore's "Repeater ID: <hex key>".
// Normal CLI replies never contain these; the echo of a command the T-SIM itself typed is skipped. GPIO6 is not used
// while awake: it pulses on every CLI reply. A hit only sets a flag; hwAwakeService() handles it at a safe point.
#define HM_RXBUF        4096
static bool s_hm_on = false;                 // monitor mode: keep the UART open between CLI commands
static const char *s_hm_echo = nullptr;      // command being typed by heltecCli (its echo is not a boot line)
static char s_hm_line[128]; static size_t s_hm_len = 0;
static volatile bool s_hwa_flag = false; static const char *s_hwa_mark = "";
static uint32_t s_hm_hits = 0;
static volatile uint32_t s_g6_edges = 0;
static uint32_t s_g6_cli_wake = 0;           // edges counted inside CLI exchanges this wake
static bool s_g6_on = false, s_in_cli = false;
static void IRAM_ATTR g6Isr() { s_g6_edges++; }
static void g6DiagStart() {
  if (s_g6_on) return;
  pinMode(HELTEC_HWAKE_PIN, INPUT_PULLUP);
  s_g6_edges = 0; s_g6_cli_wake = 0;
  attachInterrupt(digitalPinToInterrupt(HELTEC_HWAKE_PIN), g6Isr, FALLING);
  s_g6_on = true;
}
static void g6DiagStop() {
  if (!s_g6_on) return;
  detachInterrupt(digitalPinToInterrupt(HELTEC_HWAKE_PIN));
  uint32_t tot = s_g6_edges; s_dg_g6i += tot > s_g6_cli_wake ? tot - s_g6_cli_wake : 0;
  s_g6_on = false;
}
static bool hmHex(const char *p, int n) { for (int i = 0; i < n; i++) if (!isxdigit((unsigned char)p[i])) return false; return true; }
// v1.7.7 tsim-wake frames. The repeater retries the same seq until it sees "@TSIM ACK <seq>".
// s_tf_pend is set from the UART monitor; tfService() ACKs at a safe point (not inside a CLI read).
static bool s_tf_pend = false, s_tf_fresh = false, s_tf_status_boot = false;
static TsimFrame s_tf_fr;
static uint16_t s_tf_last = 0;
static char s_tf_cmd[16] = "";
static bool tfOnLine(const char *l) {
  if (strstr(l, "@TSIM ACK")) return true;   // our own ACK, echoed by the Heltec: never reply again
  TsimFrame fr;
  int k = tsimParseLine(l, &fr);
  if (k == TF_NONE) return false;
  if (k == TF_IGNORE) return true;
  if (k == TF_REJECT) { logf("tsim wake rejected: %.60s", l); return true; }
  s_tf_fr = fr;
  s_tf_pend = true;
  return true;
}
static void heltecMonLine(const char *l) {
  if (tfOnLine(l)) return;
  if (s_hm_echo && s_hm_echo[0] && strstr(l, s_hm_echo)) return;
  const char *m = nullptr, *q;
  if (strstr(l, "ESP-ROM:esp32")) m = "rom";
  else if ((q = strstr(l, "rst:0x")) && strstr(q, ",boot:0x")) m = "rst";
  else if ((q = strstr(l, "Repeater ID: ")) && strlen(q) >= 13 + 32 && hmHex(q + 13, 32)) m = "id";
  if (!m) return;
  s_hm_hits++;
  int v = hmClassify(s_hm, millis());   // v1.7.6
  if (v == HM_SAME) return;
  if (v == HM_SELF) { s_hw_self++; wdSave(); logf("Heltec boot output seen while awake (%s): the T-SIM's own reset, ignored", m); return; }
  s_hwa_mark = m; s_hwa_flag = true;
  logf("Heltec boot output seen while awake (%s)", m);
}
static void heltecMonFeed(int c) {
  if (c == '\n' || c == '\r') { if (s_hm_len) { s_hm_line[s_hm_len] = 0; heltecMonLine(s_hm_line); } s_hm_len = 0; return; }
  if (c < 0x20 || c > 0x7e) return;   // line noise / binary
  if (s_hm_len + 1 >= sizeof(s_hm_line)) { memmove(s_hm_line, s_hm_line + 64, s_hm_len - 64); s_hm_len -= 64; }  // keep the tail
  s_hm_line[s_hm_len++] = (char)c;
}
static void heltecMonPoll() {
  if (!s_heltec_uart_on || s_busy_update) return;
  while (HeltecSerial.available()) { int c = HeltecSerial.read(); if (c < 0) break; if (!s_in_cli) s_dg_ub++; heltecMonFeed(c); }
}

static void heltecCliBegin() {
  if (s_heltec_uart_on) return;
  pinMode(HELTEC_BOOT_PIN, INPUT);  // never hold BOOT low here
  HeltecSerial.setRxBufferSize(HM_RXBUF);   // v1.7.4: a whole boot log fits while the T-SIM is busy elsewhere
  HeltecSerial.begin(115200, SERIAL_8N1, HELTEC_UART_RX_PIN, HELTEC_UART_TX_PIN);
  s_heltec_uart_on = true;
  g6DiagStart();   // v1.7.5 wire self-test
  delay(30);
}
static void heltecCliEnd() {
  if (!s_heltec_uart_on) return;
  if (s_hm_on) { heltecMonPoll(); return; }   // v1.7.4 monitor mode: stay open until sleep
  HeltecSerial.flush();
  HeltecSerial.end();
  s_heltec_uart_on = false;
  heltecPinsRelease();
}
static void heltecMonStart() {
  if (s_busy_update) return;
  heltecCliBegin(); s_hm_on = true; s_hm_len = 0;
  while (HeltecSerial.available()) HeltecSerial.read();   // whatever was latched before the UART opened
}
static void heltecMonStop() {
  if (s_hm_on) { heltecMonPoll(); s_hm_on = false; }
  heltecCliEnd();
  g6DiagStop();
}
// ACK one frame. A repeat of the seq we already accepted is ACK-only (the repeater retries every 1.5 s).
static void tfAck(unsigned seq) {
  heltecCliBegin();
  char line[32];
  int n = snprintf(line, sizeof(line), "@TSIM ACK %u\r\n", seq);
  if (n > 0) HeltecSerial.write((const uint8_t *)line, (size_t)n);
  HeltecSerial.flush();
  logf("tsim wake ACK seq %u", seq);
}
static void tfService() {
  if (!s_tf_pend) return;
  s_tf_pend = false;
  TsimFrame fr = s_tf_fr;
  bool retry = s_tf_last != 0 && s_tf_last == (uint16_t)fr.seq;
  tfAck(fr.seq);
  if (retry) { logf("tsim wake %s seq %u retry (ACK only)", fr.cmd, fr.seq); return; }
  s_tf_last = (uint16_t)fr.seq;
  strncpy(s_tf_cmd, fr.cmd, sizeof(s_tf_cmd) - 1);
  s_tf_cmd[sizeof(s_tf_cmd) - 1] = 0;
  s_tf_fresh = true;
  logf("tsim wake %s seq %u", fr.cmd, fr.seq);
}
// After a GPIO6 wake, wait out the repeater's retry window (1 s boot + 5 x 1.5 s) before deciding
// the pulse was a Heltec reboot. Returns true when a new allowlisted command was accepted.
static bool tfListen(uint32_t ms) {
  heltecCliBegin();
  s_hm_on = true;
  s_hm_len = 0;
  uint32_t t0 = millis();
  while ((uint32_t)(millis() - t0) < ms) {
    heltecMonPoll();
    tfService();
    if (s_tf_fresh) return true;
    delay(20);
  }
  return false;
}

// Runs one CLI command; returns true when a "->" reply was seen. out = reply text (prefix kept for the Worker).
static bool heltecCli(const char *cmd, char *out, size_t cap, uint32_t timeout_ms = CLI_TIMEOUT_MS) {
  heltecCliBegin();
  // Wake a power-saving Heltec and flush any half-typed line: a bare CR is an empty command.
  heltecMonPoll();   // v1.7.4: anything unread goes through the boot matcher first
  if (!strcasecmp(cmd, "reboot")) { s_hw_cons = rtcNow(); s_up_last_t = 0; selfResetMark(s_cons, millis()); }   // v1.7.4: a reboot that follows is the console's own
  s_hm_echo = cmd;
  s_in_cli = true; uint32_t e0 = s_g6_edges;
  HeltecSerial.print("\r"); delay(120); HeltecSerial.print("\r"); delay(150);
  heltecMonPoll();
  HeltecSerial.print(cmd);
  HeltecSerial.print("\r");
  size_t n = 0; out[0] = 0;
  uint32_t t0 = millis(), last = millis();
  bool reply = false;
  while (millis() - t0 < timeout_ms) {
    while (HeltecSerial.available()) {
      int c = HeltecSerial.read();
      if (c < 0) break;
      heltecMonFeed(c);
      if (n + 1 < cap) { out[n++] = (char)c; out[n] = 0; }
      last = millis();
    }
    if (!reply && strstr(out, "-> ")) reply = true;
    if (reply && millis() - last > CLI_QUIET_MS) break;
    // v1.7.0: output beyond the echoed command line with no "-> " marker = a raw printout; stop after 700 ms quiet
    if (!reply && millis() - last > 700) { const char *nl = strchr(out, '\n'); if (nl && strlen(nl + 1) > 2) break; }
    delay(5);
  }
  if (s_hm_len) { s_hm_line[s_hm_len] = 0; heltecMonLine(s_hm_line); s_hm_len = 0; }   // last partial line, echo still known
  s_hm_echo = nullptr;
  { uint32_t de = s_g6_edges - e0; s_g6_cli_wake += de; s_dg_g6c += de; s_dg_clib += n; s_in_cli = false; }
  // Drop the echoed command line (everything up to the reply marker), keep "  -> ..." onwards.
  char *p = strstr(out, "  -> ");
  if (!p) p = strstr(out, "-> ");
  if (p && p != out) memmove(out, p, strlen(p) + 1);
  else if (!p) {  // no reply: strip a lone echo
    char *nl = strchr(out, '\n');
    if (nl && strncmp(out, cmd, strlen(cmd)) == 0) memmove(out, nl + 1, strlen(nl + 1) + 1);
  }
  trimInPlace(out);
  if (!reply && out[0] && strncmp(out, cmd, strlen(cmd)) != 0) reply = true;  // raw printout (get acl, log, ...)
  logf("cli '%.40s' -> %s %.80s", cmd, reply ? "ok" : "NO REPLY", out);
  return reply;
}

// Large JSON (mesh / cmd output): send directly (too big for the 520-byte retry queue).
static bool ingestSendBig(const char *json) {
  if (s_tcp_busy) { logf("ingest(big) skipped — tcp busy"); return false; }
  if (!s_pdp_up && !modemOpenData()) { logf("ingest(big): no PDP"); return false; }
  return ingestSend(json);
}

static void upFromCli(const char *out);   // v1.7.5 (uptime baseline / reboot check from any stats-core reply)
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
    if (ok && i == 3) upFromCli(s_cli_out);
    if (!ok && i == 0) {  // nothing from 'ver': retry once (Heltec may have been asleep)
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
               u.path, u.host, g_device_key);
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
static bool doTsimUpdate(const char *args);
static void pwrApplyCfg(const char *args, char *out, size_t cap);
static void gpsApplyCfg(const char *args, char *out, size_t cap);
static void csApplyCfg(const char *args, char *out, size_t cap);
static void wdApplyCfg(const char *args, char *out, size_t cap);
static void gpsReport(const char *trigger, char *out, size_t cap);
static bool doUpdate(const char *url, bool flash_too);
static void doConsoleCommands(bool sys_only = false, bool wd = false) {
  // wd (v1.7.2): watchdog wake. "?wd=1" also returns a queued Heltec UPDATE (the Worker keeps those for watchdog
  // wakes only, since a text wake gets the UPDATE text itself); console commands get a shorter time budget.
  static char cmd_url[240]; snprintf(cmd_url, sizeof(cmd_url), "%s/api/dev/%s/commands%s", g_worker_url, g_device_id, wd ? "?wd=1" : sys_only ? "?sys=1" : "");
  const uint32_t budget = wd ? WD_CMD_BUDGET_MS : CMD_BUDGET_MS;
  int st = httpsGetTls(cmd_url, s_cmd_list, sizeof(s_cmd_list));
  if (st != 200) { char m[60]; snprintf(m, sizeof(m), "CMD: command fetch failed (%d)", st); ingestEvent("event", m); return; }
  int ran = 0, noreply = 0; uint32_t b0 = millis();
  char *save = nullptr;
  for (char *line = strtok_r(s_cmd_list, "\n", &save); line && ran < CMD_MAX_RUN; line = strtok_r(nullptr, "\n", &save)) {
    char *tab = strchr(line, '\t');
    if (!tab) continue;
    *tab = 0;
    char id[20]; strncpy(id, line, sizeof(id) - 1); id[sizeof(id) - 1] = 0;
    static char cmd[480]; strncpy(cmd, tab + 1, sizeof(cmd) - 1); cmd[sizeof(cmd) - 1] = 0;
    trimInPlace(cmd);
    bool clean = cmd[0] != 0;
    for (char *q = cmd; *q; q++) if ((unsigned char)*q < 0x20 || (unsigned char)*q > 0x7e) clean = false;
    bool ok = false;
    static char ec[960], ei[40];
    // Over budget, or the Heltec stopped answering: report the rest as skipped so the Worker doesn't wait on them.
    const char *skip = (millis() - b0 > budget) ? "skipped: wake time limit reached" : (noreply >= CMD_NOREPLY_STOP ? "no reply from Heltec (skipped after repeated no-replies)" : nullptr);
    if (skip && clean && strncasecmp(cmd, "TSIMUPDATE ", 11) != 0 && strncasecmp(cmd, "PWRCFG ", 7) != 0 && strncasecmp(cmd, "GPS", 3) != 0 && strncasecmp(cmd, "CFGSNAP ", 8) != 0 && strncasecmp(cmd, "WDCFG ", 6) != 0 && strncasecmp(cmd, "UPDATE ", 7) != 0) {
      jsonEsc(ec, sizeof(ec), cmd); jsonEsc(ei, sizeof(ei), id);
      snprintf(s_mesh_body, sizeof(s_mesh_body), "{\"type\":\"cmd\",\"fw\":\"%s\",\"cmd_id\":\"%s\",\"cmd\":\"%s\",\"output\":\"\",\"error\":\"%s\"}", FW_VERSION, ei, ec, skip);
      ingestSendBig(s_mesh_body); ran++; continue;
    }
    if (clean && strncasecmp(cmd, "TSIMUPDATE ", 11) == 0) {  // T-SIM self-update (Worker system command, not a Heltec CLI command)
      jsonEsc(ec, sizeof(ec), cmd); jsonEsc(ei, sizeof(ei), id);
      snprintf(s_mesh_body, sizeof(s_mesh_body), "{\"type\":\"cmd\",\"fw\":\"%s\",\"cmd_id\":\"%s\",\"cmd\":\"%s\",\"sys\":true,\"output\":\"T-SIM OTA starting\"}", FW_VERSION, ei, ec);
      ingestSendBig(s_mesh_body);
      heltecCliEnd();
      static char a[480]; strncpy(a, cmd + 11, sizeof(a) - 1); a[sizeof(a) - 1] = 0;
      doTsimUpdate(a);  // reboots on success
      ran++;
      continue;
    }
    if (clean && strncasecmp(cmd, "UPDATE ", 7) == 0) {  // v1.7.2 queued Heltec update (Worker system command, watchdog wakes)
      const char *u = cmd + 7; while (*u == ' ') u++;
      bool okurl = (strncmp(u, "https://", 8) == 0 || strncmp(u, "http://", 7) == 0) && !strchr(u, ' ');
      jsonEsc(ec, sizeof(ec), cmd); jsonEsc(ei, sizeof(ei), id);
      snprintf(s_mesh_body, sizeof(s_mesh_body), "{\"type\":\"cmd\",\"fw\":\"%s\",\"cmd_id\":\"%s\",\"cmd\":\"%s\",\"sys\":true,\"output\":\"%s\"%s}", FW_VERSION, ei, ec,
               okurl ? "Heltec update starting (from the queue)" : "", okurl ? "" : ",\"error\":\"bad update URL\"");
      ingestSendBig(s_mesh_body);
      if (okurl) { heltecCliEnd(); static char uc[URL_MAX]; strncpy(uc, u, sizeof(uc) - 1); uc[sizeof(uc) - 1] = 0; doUpdate(uc, true); }
      ran++; continue;
    }
    if (clean && strncasecmp(cmd, "PWRCFG ", 7) == 0) {  // power/calibration config (Worker system command)
      static char po[400]; pwrApplyCfg(cmd + 7, po, sizeof(po));
      static char pe[600]; jsonEsc(pe, sizeof(pe), po); jsonEsc(ec, sizeof(ec), cmd); jsonEsc(ei, sizeof(ei), id);
      snprintf(s_mesh_body, sizeof(s_mesh_body), "{\"type\":\"cmd\",\"fw\":\"%s\",\"cmd_id\":\"%s\",\"cmd\":\"%s\",\"sys\":true,\"output\":\"%s\"}", FW_VERSION, ei, ec, pe);
      ingestSendBig(s_mesh_body);
      ran++;
      continue;
    }
    if (clean && strncasecmp(cmd, "CFGSNAP ", 8) == 0) {  // v1.7.0 settings cache config (Worker system command)
      static char co[200]; csApplyCfg(cmd + 8, co, sizeof(co));
      static char ce[300]; jsonEsc(ce, sizeof(ce), co); jsonEsc(ec, sizeof(ec), cmd); jsonEsc(ei, sizeof(ei), id);
      snprintf(s_mesh_body, sizeof(s_mesh_body), "{\"type\":\"cmd\",\"fw\":\"%s\",\"cmd_id\":\"%s\",\"cmd\":\"%s\",\"sys\":true,\"output\":\"%s\"}", FW_VERSION, ei, ec, ce);
      ingestSendBig(s_mesh_body); ran++; continue;
    }
    if (clean && strncasecmp(cmd, "WDCFG ", 6) == 0) {  // v1.7.1 modem watchdog config (Worker system command)
      static char wo[200]; wdApplyCfg(cmd + 6, wo, sizeof(wo));
      static char we[300]; jsonEsc(we, sizeof(we), wo); jsonEsc(ec, sizeof(ec), cmd); jsonEsc(ei, sizeof(ei), id);
      snprintf(s_mesh_body, sizeof(s_mesh_body), "{\"type\":\"cmd\",\"fw\":\"%s\",\"cmd_id\":\"%s\",\"cmd\":\"%s\",\"sys\":true,\"output\":\"%s\"}", FW_VERSION, ei, ec, we);
      ingestSendBig(s_mesh_body); ran++; continue;
    }
    if (clean && (strcasecmp(cmd, "GPSFIX") == 0 || strncasecmp(cmd, "GPSCFG ", 7) == 0)) {  // v1.6.7 GNSS (Worker system commands)
      static char go[300];
      if (cmd[3] == 'F' || cmd[3] == 'f') { heltecCliEnd(); gpsReport("cmd", go, sizeof(go)); } else gpsApplyCfg(cmd + 7, go, sizeof(go));
      static char ge[400]; jsonEsc(ge, sizeof(ge), go); jsonEsc(ec, sizeof(ec), cmd); jsonEsc(ei, sizeof(ei), id);
      snprintf(s_mesh_body, sizeof(s_mesh_body), "{\"type\":\"cmd\",\"fw\":\"%s\",\"cmd_id\":\"%s\",\"cmd\":\"%s\",\"sys\":true,\"output\":\"%s\"}", FW_VERSION, ei, ec, ge);
      ingestSendBig(s_mesh_body);
      ran++;
      continue;
    }
    if (clean) { ok = heltecCli(cmd, s_cli_out, sizeof(s_cli_out), 8000); noreply = ok ? 0 : noreply + 1; }
    else strcpy(s_cli_out, "");
    static char eo[CLI_OUT_MAX * 2];
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

// -------------------- T-SIM self-update (OTA, v1.6.0) --------------------
// TSIMUPDATE <url> [sha256:<64 hex>|md5:<32 hex>]
// Download -> LittleFS (same TLS/redirect path as Heltec images) -> verify size/hash -> Update (inactive
// OTA slot, image check) -> set boot partition -> reboot. The new app stays PENDING_VERIFY until it has
// posted to /ingest after the modem comes up (markOtaValidIfPending); otherwise it rolls back.
#define TSIM_FW_PATH "/tsim.bin"
extern "C" bool verifyRollbackLater() { return true; }  // we confirm the app ourselves (after ingest)

static bool otaPendingVerify() {
  const esp_partition_t *run = esp_ota_get_running_partition();
  esp_ota_img_states_t st;
  return run && esp_ota_get_state_partition(run, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY;
}
static void markOtaValidIfPending(const char *why) {
  if (!otaPendingVerify()) return;
  esp_ota_mark_app_valid_cancel_rollback();
  logf("OTA: new app marked VALID (%s)", why);
  char m[120]; snprintf(m, sizeof(m), "TSIM OTA OK: %s running (%s)", FW_VERSION, why);
  setLastResult("%s", m);
  ingestEvent("update", m);
}
static void rollbackIfPending(const char *why) {
  if (!otaPendingVerify()) return;
  logf("OTA: app NOT verified (%s) -> rollback + reboot", why);
  setLastResult("TSIM OTA ROLLBACK: %s never checked in (%s), reverting", FW_VERSION, why);
  Serial.flush(); delay(100);
  esp_ota_mark_app_invalid_rollback_and_reboot();
}

static bool fileHash(const char *path, bool sha, char *hexout) {
  File f = LittleFS.open(path, "r");
  if (!f) return false;
  uint8_t out[32];
  if (sha) {
    mbedtls_sha256_context c; mbedtls_sha256_init(&c); mbedtls_sha256_starts(&c, 0);
    while (f.available()) { size_t n = f.read(s_flash_block, sizeof(s_flash_block)); if (!n) break; mbedtls_sha256_update(&c, s_flash_block, n); }
    mbedtls_sha256_finish(&c, out); mbedtls_sha256_free(&c);
  } else {
    MD5Builder md5; md5.begin();
    while (f.available()) { size_t n = f.read(s_flash_block, sizeof(s_flash_block)); if (!n) break; md5.add(s_flash_block, n); }
    md5.calculate(); md5.getBytes(out);
  }
  f.close();
  int n = sha ? 32 : 16;
  for (int i = 0; i < n; i++) sprintf(hexout + i * 2, "%02x", out[i]);
  hexout[n * 2] = 0;
  return true;
}

static void tsimReport(const char *fmt, ...) {
  char m[200]; va_list ap; va_start(ap, fmt); vsnprintf(m, sizeof(m), fmt, ap); va_end(ap);
  setLastResult("%s", m);
  logf("%s", m);
  ingestEvent("update", m);
}

// Returns only on failure (success reboots).
static bool doTsimUpdate(const char *args) {
  static char url[URL_MAX]; char hash[80] = "";
  const char *sp = strchr(args, ' ');
  size_t ul = sp ? (size_t)(sp - args) : strlen(args);
  if (ul >= sizeof(url)) ul = sizeof(url) - 1;
  memcpy(url, args, ul); url[ul] = 0;
  if (sp) { while (*sp == ' ') sp++; strncpy(hash, sp, sizeof(hash) - 1); trimInPlace(hash); }
  for (char *q = hash; *q; q++) *q = tolower((unsigned char)*q);
  bool want_sha = strncmp(hash, "sha256:", 7) == 0, want_md5 = strncmp(hash, "md5:", 4) == 0;
  const char *want = want_sha ? hash + 7 : (want_md5 ? hash + 4 : "");
  if (hash[0] && !((want_sha && strlen(want) == 64) || (want_md5 && strlen(want) == 32))) { tsimReport("TSIM OTA FAIL: bad checksum '%.40s'", hash); return false; }
  if (!(strncmp(url, "https://", 8) == 0 || strncmp(url, "http://", 7) == 0)) { tsimReport("TSIM OTA FAIL: bad url"); return false; }
  const esp_partition_t *next = esp_ota_get_next_update_partition(NULL);
  if (!next) { tsimReport("TSIM OTA FAIL: no OTA partition (needs the v1.6.0 partition table via USB)"); return false; }

  s_busy_update = true;
  deadlineArm(AWAKE_MAX_UPD_S);   // v1.7.2: updates get a longer awake limit
  tsimReport("TSIM OTA start: %.150s", url);
  if (!modemWaitNetwork(60000) || !modemOpenData()) { tsimReport("TSIM OTA FAIL: no network"); s_busy_update = false; return false; }
  LittleFS.remove(TSIM_FW_PATH);
  bool dl = httpDownloadToFile(url, TSIM_FW_PATH);
  s_tcp_busy = false;
  pendingFlush();
  File f = LittleFS.open(TSIM_FW_PATH, "r");
  size_t size = f ? f.size() : 0;
  if (!dl || !f || size < 64 * 1024) { if (f) f.close(); tsimReport("TSIM OTA FAIL: download (%u bytes)", (unsigned)size); LittleFS.remove(TSIM_FW_PATH); s_busy_update = false; return false; }
  uint8_t magic = f.peek(); f.close();
  if (magic != 0xE9) { tsimReport("TSIM OTA FAIL: not an ESP32 app image (0x%02x)", magic); LittleFS.remove(TSIM_FW_PATH); s_busy_update = false; return false; }
  if (size > next->size) { tsimReport("TSIM OTA FAIL: image %u > slot %u", (unsigned)size, (unsigned)next->size); LittleFS.remove(TSIM_FW_PATH); s_busy_update = false; return false; }
  if (want[0]) {
    char got[65];
    if (!fileHash(TSIM_FW_PATH, want_sha, got) || strcmp(got, want) != 0) {
      tsimReport("TSIM OTA FAIL: %s mismatch (got %.16s…)", want_sha ? "sha256" : "md5", got);
      LittleFS.remove(TSIM_FW_PATH); s_busy_update = false; return false;
    }
    logf("TSIM OTA: %s OK", want_sha ? "sha256" : "md5");
  }
  { char m[120]; snprintf(m, sizeof(m), "TSIM OTA: downloaded %u bytes%s, writing %s", (unsigned)size, want[0] ? " (checksum OK)" : "", next->label); ingestEvent("update", m); }
  f = LittleFS.open(TSIM_FW_PATH, "r");
  bool ok = Update.begin(size, U_FLASH);
  size_t wr = 0;
  while (ok && f.available()) {
    size_t n = f.read(s_flash_block, sizeof(s_flash_block));
    if (!n) break;
    if (Update.write(s_flash_block, n) != n) ok = false; else wr += n;
  }
  f.close();
  LittleFS.remove(TSIM_FW_PATH);
  if (ok) ok = (wr == size) && Update.end(true);  // end(): verifies the app image, sets boot partition
  else Update.abort();
  if (!ok) { tsimReport("TSIM OTA FAIL: write/verify (%s)", Update.errorString()); s_busy_update = false; return false; }
  tsimReport("TSIM OTA: written %u bytes to %s, rebooting (new app must check in or it rolls back)", (unsigned)size, next->label);
  modemCloseData();
  Serial.flush(); delay(500);
  ESP.restart();
  return true;
}

// -------------------- flash --------------------
// Decide the flash address from the file contents only (never the filename), v1.6.2.
// Merged/factory image: partition table magic 0xAA 0x50 at 0x8000 and/or an app header 0xE9 at 0x10000
// -> write at 0x0. App-only image: 0xE9 at offset 0 -> write at 0x10000. Anything else: refuse.
// Returns 1 merged (from 0x0), 2 merged from 0x1000 (classic ESP32 only), 0 app-only, -1 unrecognised.
static int imageKind(File &f) {
  size_t size = f.size();
  uint8_t pt[2] = {0, 0}, ap[2] = {0, 0}, h[2] = {0, 0};
  if (size > 0x8002) { f.seek(0x8000); f.read(pt, 2); }
  if (size > 0x10010) { f.seek(0x10000); f.read(ap, 2); }
  f.seek(0); f.read(h, 2); f.seek(0);
  bool ptMagic = pt[0] == 0xAA && pt[1] == 0x50;
  bool gapErased = pt[0] == 0xFF && pt[1] == 0xFF;                 // merge_bin fills gaps with 0xFF
  bool app10k = ap[0] == 0xE9 && ap[1] >= 1 && ap[1] <= 16;        // magic + sane segment count
  bool app0 = h[0] == 0xE9 && h[1] >= 1 && h[1] <= 16;
  // v1.6.3: classic-ESP32 merged image built from 0x1000 (bootloader first): partition table at file 0x7000
  uint8_t pt7[2] = {0, 0};
  if (size > 0x7002) { f.seek(0x7000); f.read(pt7, 2); f.seek(0); }
  bool pt7Magic = pt7[0] == 0xAA && pt7[1] == 0x50;
  logf("flash: image check pt@0x8000=%d pt@0x7000=%d app@0x10000=%d app@0=%d", (int)ptMagic, (int)pt7Magic, (int)app10k, (int)app0);
  if (ptMagic || (app10k && gapErased)) return 1;
  if (pt7Magic && app0) return 2;
  if (app0) return 0;
  return -1;
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

// v1.6.4: flash details reported to the dashboard (chip, image type, address, bytes, verify)
static char s_flash_info[200] = "";
static const char *imageKindName(int k) { return k == 2 ? "classic-merged" : k == 1 ? "merged" : "app-only"; }

static bool flashHeltecFromFile(const char *path, const char *url) {
  s_flash_info[0] = 0;
  File f = LittleFS.open(path, "r");
  if (!f) { logf("flash: cannot open"); return false; }
  size_t size = f.size();
  if (size < 256) { logf("flash: too small"); f.close(); return false; }
  int kind = imageKind(f);
  f.close();
  (void)url;
  if (kind < 0) { logf("flash: not an ESP32 image (no 0xE9 header) - refusing"); return false; }
  bool merged = kind >= 1;
  uint32_t addr = merged ? 0x0 : 0x10000;   // final address chosen after chip detection
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
  {
    // v1.6.3: detect target chip and pick merged-image base. Classic ESP32 bootloader lives at 0x1000,
    // S2/S3/C2/C3/C6/H2 at 0x0. App partition is 0x10000 on all of them.
    target_chip_t chip = esp_loader_get_target();
    const char *cn = "unknown";
    switch (chip) {
      case ESP32_CHIP: cn = "ESP32"; break;
      case ESP32S2_CHIP: cn = "ESP32-S2"; break;
      case ESP32C3_CHIP: cn = "ESP32-C3"; break;
      case ESP32S3_CHIP: cn = "ESP32-S3"; break;
      case ESP32C2_CHIP: cn = "ESP32-C2"; break;
      case ESP32H2_CHIP: cn = "ESP32-H2"; break;
      case ESP32C6_CHIP: cn = "ESP32-C6"; break;
      default: break;
    }
    logf("flash: target chip %s (%d)", cn, (int)chip);
    progressf("UPDATE", "hammer_and_wrench", 4, "Repeater chip detected: %s", cn);
    if (chip == ESP8266_CHIP || chip >= ESP_MAX_CHIP || chip == ESP32_RESERVED0_CHIP) {
      setLastResult("FLASH REFUSED: unsupported/unknown repeater chip (%d)", (int)chip);
      logf("flash: unknown chip - refusing");
      f.close(); heltecEndFlash(true); return false;
    }
    if (kind == 2) {
      if (chip != ESP32_CHIP) {
        setLastResult("FLASH REFUSED: image is classic-ESP32 merged (from 0x1000) but chip is %s", cn);
        logf("flash: 0x1000 merged image on %s - refusing", cn);
        f.close(); heltecEndFlash(true); return false;
      }
      addr = 0x1000;
    }
    logf("flash: write address 0x%X (kind=%d, chip=%s)", addr, kind, cn);
    snprintf(s_flash_info, sizeof(s_flash_info), "chip=%s image=%s addr=0x%X size=%u",
             cn, imageKindName(kind), (unsigned)addr, (unsigned)size);
    { char m[240]; snprintf(m, sizeof(m), "Flashing: %s", s_flash_info); ingestEvent("update", m); }
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
  { size_t L = strlen(s_flash_info);
    snprintf(s_flash_info + L, sizeof(s_flash_info) - L, " written=%u verify=%s md5=%s",
             (unsigned)written, ok ? "OK" : "FAIL", md5_file.c_str()); }
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

// -------------------- POWER: battery calibration + low-battery repeat protection (v1.6.5) --------------------
// Idle battery = ADC sampled at the very start of a wake, before the modem is used (LTE draw sags the cell).
// Calibrated volts = raw * scale + offset (NVS "tsimpwr"; set from the dashboard via a PWRCFG system command).
static float s_cal_scale = 1.0f, s_cal_off = 0.0f;
static bool  s_lb_en = false, s_lb_imm = false;
static float s_lb_off = 3.40f, s_lb_on = 3.75f;   // ON must be >= OFF * 1.10 (user rule)
#define LB_MIN_RATIO 1.10f
static uint32_t s_lb_int_min = 30;
static uint8_t s_lb_state = 0;          // 0 = repeat left ON (normal), 1 = repeat OFF by protection
static float s_bat_raw_idle = 0, s_bat_idle = 0;
static char  s_lb_pending[160] = "";    // change not yet reported to the Worker
RTC_DATA_ATTR static bool s_ext0_failed = false;

static float batCal(float raw) { return raw < 0.5f ? raw : raw * s_cal_scale + s_cal_off; }  // <0.5 V = USB/no reading
static void pwrLoad() {
  Preferences p; p.begin("tsimpwr", true);
  s_cal_scale = p.getFloat("scale", 1.0f); s_cal_off = p.getFloat("off", 0.0f);
  s_lb_en = p.getBool("en", false); s_lb_imm = p.getBool("imm", false);
  s_lb_off = p.getFloat("lo", 3.40f); s_lb_on = p.getFloat("hi", 3.75f);
  s_lb_int_min = p.getUInt("int", 30); s_lb_state = p.getUChar("state", 0);
  String pend = p.getString("pend", ""); strncpy(s_lb_pending, pend.c_str(), sizeof(s_lb_pending) - 1);
  p.end();
  if (!(s_cal_scale > 0.5f && s_cal_scale < 1.5f)) s_cal_scale = 1.0f;
  if (!(s_cal_off > -0.5f && s_cal_off < 0.5f)) s_cal_off = 0.0f;
  if (!(s_lb_on >= s_lb_off * LB_MIN_RATIO - 0.005f)) { s_lb_off = 3.40f; s_lb_on = 3.75f; }
  if (s_lb_int_min < 5 || s_lb_int_min > 1440) s_lb_int_min = 30;
}
static void pwrSavePending(const char *m) {
  strncpy(s_lb_pending, m, sizeof(s_lb_pending) - 1); s_lb_pending[sizeof(s_lb_pending) - 1] = 0;
  Preferences p; p.begin("tsimpwr", false); p.putString("pend", s_lb_pending); p.putUChar("state", s_lb_state); p.end();
}
static void pwrReadIdle() {
  s_bat_raw_idle = readAdcVolts(BOARD_BAT_ADC_PIN, 2.0f);
  s_bat_idle = batCal(s_bat_raw_idle);
  logf("battery idle raw=%.3fV cal=%.3fV (x%.4f %+.3f)", s_bat_raw_idle, s_bat_idle, s_cal_scale, s_cal_off);
}
// Sends "set repeat on|off" to the MeshCore repeater and verifies with "get repeat". Returns true on success.
static bool heltecSetRepeat(bool on) {
  bool ok = heltecCli(on ? "set repeat on" : "set repeat off", s_cli_out, sizeof(s_cli_out), 4000);
  bool said = ok && strstr(s_cli_out, on ? "repeat is now ON" : "repeat is now OFF");
  bool got = heltecCli("get repeat", s_cli_out, sizeof(s_cli_out), 3000);
  bool is = got && strstr(s_cli_out, on ? "> on" : "> off");
  heltecCliEnd();
  logf("repeat %s: set=%d verify=%d", on ? "ON" : "OFF", (int)said, (int)is);
  return is || (said && !got);
}
// Hysteresis on the calibrated idle voltage. Returns true if the repeater state was changed.
static bool pwrCheck(const char *why) {
  if (!s_lb_en) return false;
  float v = s_bat_idle;
  if (v < 2.5f) { logf("lowbat: no valid reading (%.2fV, USB?) - skip", v); return false; }
  bool wantOff = s_lb_state == 0 && v < s_lb_off;
  bool wantOn  = s_lb_state == 1 && v >= s_lb_on;
  if (!wantOff && !wantOn) return false;
  bool ok = heltecSetRepeat(!wantOff);
  char m[160];
  if (ok) {
    s_lb_state = wantOff ? 1 : 0;
    snprintf(m, sizeof(m), "Battery protection: repeat %s at %.2fV (%s %.2fV, %s)", wantOff ? "OFF" : "ON", v,
             wantOff ? "below" : "at/above", wantOff ? s_lb_off : s_lb_on, why);
  } else {
    snprintf(m, sizeof(m), "Battery protection FAIL: repeat %s at %.2fV - no/unexpected CLI reply (%s)", wantOff ? "OFF" : "ON", v, why);
  }
  logf("%s", m);
  pwrSavePending(m);
  return ok;
}
// PWRCFG key=value ... (system command from the Worker)
static void pwrApplyCfg(const char *args, char *out, size_t cap) {
  Preferences p; p.begin("tsimpwr", false);
  char buf[300]; strncpy(buf, args, sizeof(buf) - 1); buf[sizeof(buf) - 1] = 0;
  char *save = nullptr; int n = 0;
  float lo = s_lb_off, hi = s_lb_on; bool thr = false;
  for (char *t = strtok_r(buf, " ", &save); t; t = strtok_r(nullptr, " ", &save)) {
    char *eq = strchr(t, '='); if (!eq) continue; *eq = 0; const char *k = t, *v = eq + 1;
    if (!strcmp(k, "scale")) { float f = atof(v); if (f > 0.5f && f < 1.5f) { s_cal_scale = f; p.putFloat("scale", f); n++; } }
    else if (!strcmp(k, "off")) { float f = atof(v); if (f > -0.5f && f < 0.5f) { s_cal_off = f; p.putFloat("off", f); n++; } }
    else if (!strcmp(k, "en")) { s_lb_en = atoi(v) != 0; p.putBool("en", s_lb_en); n++; }
    else if (!strcmp(k, "imm")) { s_lb_imm = atoi(v) != 0; p.putBool("imm", s_lb_imm); n++; }
    else if (!strcmp(k, "lo")) { lo = atof(v); thr = true; }
    else if (!strcmp(k, "hi")) { hi = atof(v); thr = true; }
    else if (!strcmp(k, "int")) { uint32_t m = (uint32_t)atoi(v); if (m >= 5 && m <= 1440) { s_lb_int_min = m; p.putUInt("int", m); n++; } }
  }
  bool rej = false;
  if (thr) { if (hi >= lo * LB_MIN_RATIO - 0.005f && lo >= 3.0f && hi <= 4.3f) { s_lb_off = lo; s_lb_on = hi; p.putFloat("lo", lo); p.putFloat("hi", hi); n++; } else rej = true; }
  if (!s_lb_en && s_lb_state == 1) {  // protection turned off while repeat was off: restore repeat
    if (heltecSetRepeat(true)) { s_lb_state = 0; p.putUChar("state", 0); }
  }
  p.end();
  s_bat_idle = batCal(s_bat_raw_idle);
  snprintf(out, cap, "PWRCFG applied %d%s: scale=%.4f off=%.3f en=%d lo=%.2f hi=%.2f int=%u imm=%d state=%s bat=%.2f",
           n, rej ? " (thresholds REJECTED: ON must be >= OFF x1.10)" : "", s_cal_scale, s_cal_off, (int)s_lb_en, s_lb_off, s_lb_on, (unsigned)s_lb_int_min, (int)s_lb_imm,
           s_lb_state ? "repeat_off" : "normal", s_bat_idle);
  logf("%s", out);
}
static void pwrReportPending() {
  if (!s_lb_pending[0]) return;
  ingestEvent("power", s_lb_pending);
  s_lb_pending[0] = 0;
  Preferences p; p.begin("tsimpwr", false); p.putString("pend", ""); p.end();
}
static size_t pwrJson(char *dst, size_t cap) {  // extra status fields
  return snprintf(dst, cap, ",\"battery_raw_v\":%.3f,\"cal_scale\":%.4f,\"cal_off\":%.3f,\"lb_en\":%s,\"lb_state\":%d,"
                  "\"lb_lo\":%.2f,\"lb_hi\":%.2f,\"lb_int\":%u,\"lb_imm\":%s",
                  s_bat_raw_idle, s_cal_scale, s_cal_off, s_lb_en ? "true" : "false", (int)s_lb_state,
                  s_lb_off, s_lb_on, (unsigned)s_lb_int_min, s_lb_imm ? "true" : "false");
}


// -------------------- GPS / GNSS (v1.6.7) --------------------
// SIM7672G built-in GNSS. Needs a GNSS antenna on the modem's GPS/GNSS u.FL connector.
// On demand (GPSFIX system command) and optionally on each STATUS check-in (GPSCFG auto=1, default off).
// Powers GNSS on, polls for a fix up to the timeout, reads lat/lon/alt/sats/HDOP, powers GNSS off.
static bool s_gps_auto = false;
static uint32_t s_gps_to = 180;         // seconds (v1.6.8: default 180, max 600)
static bool s_gps_done = false;         // a fix attempt already ran this wake
struct GpsFix { bool fix; double lat, lon; float alt, hdop; int sats; char utc[24]; char src[12]; uint32_t secs; };
static void gpsLoad() {
  Preferences p; p.begin("tsimgps", true);
  s_gps_auto = p.getBool("auto", false); s_gps_to = p.getUInt("to", 180);
  p.end();
  if (s_gps_to < 30 || s_gps_to > 600) s_gps_to = 180;
}
static void gpsApplyCfg(const char *args, char *out, size_t cap) {
  Preferences p; p.begin("tsimgps", false);
  char buf[120]; strncpy(buf, args, sizeof(buf) - 1); buf[sizeof(buf) - 1] = 0;
  char *save = nullptr; int n = 0;
  for (char *t = strtok_r(buf, " ", &save); t; t = strtok_r(nullptr, " ", &save)) {
    char *eq = strchr(t, '='); if (!eq) continue; *eq = 0; const char *k = t, *v = eq + 1;
    if (!strcmp(k, "auto")) { s_gps_auto = atoi(v) != 0; p.putBool("auto", s_gps_auto); n++; }
    else if (!strcmp(k, "to")) { uint32_t s = (uint32_t)atoi(v); if (s >= 30 && s <= 600) { s_gps_to = s; p.putUInt("to", s); n++; } }
  }
  p.end();
  snprintf(out, cap, "GPSCFG applied %d: auto=%d to=%u", n, (int)s_gps_auto, (unsigned)s_gps_to);
  logf("%s", out);
}
// "ddmm.mmmm" (or "dddmm.mmmm") -> degrees; plain decimal degrees are passed through.
static double gpsDeg(const char *s, bool lon) {
  const char *dot = strchr(s, '.');
  int intd = dot ? (int)(dot - s) : (int)strlen(s);
  double v = atof(s);
  if (intd >= (lon ? 5 : 4)) { double d = floor(v / 100.0); return d + (v - d * 100.0) / 60.0; }
  return v;
}
// Parses one +CGNSSINFO / +CGPSINFO payload (text after the colon). Returns true with a fix.
// SIM7672: mode,GPS-SVs,BEIDOU-SVs,GLONASS-SVs,GALILEO-SVs,lat,N/S,lon,E/W,date,UTC,alt,speed,course,PDOP,HDOP,VDOP
// CGPSINFO: lat,N/S,lon,E/W,date,UTC,alt,speed,course
static bool gpsParse(const char *line, bool cgnss, GpsFix &g) {
  char buf[200]; strncpy(buf, line, sizeof(buf) - 1); buf[sizeof(buf) - 1] = 0;
  char *nl = strpbrk(buf, "\r\n"); if (nl) *nl = 0;
  const char *tok[24]; int n = 0; char *p = buf;
  while (*p == ' ') p++;
  tok[n++] = p;
  for (; *p && n < 24; p++) if (*p == ',') { *p = 0; tok[n++] = p + 1; }
  int ns = -1;
  for (int i = 1; i + 2 < n; i++) if ((!strcmp(tok[i], "N") || !strcmp(tok[i], "S")) && (!strcmp(tok[i + 2], "E") || !strcmp(tok[i + 2], "W"))) { ns = i; break; }
  if (cgnss) {  // satellites in view/used: sum the constellation counts before lat
    int s = 0, last = ns > 0 ? ns - 1 : (n < 5 ? n : 5);
    for (int i = 1; i < last && i < 6; i++) s += atoi(tok[i]);
    if (s > g.sats) g.sats = s;
  }
  if (ns < 1 || !tok[ns - 1][0] || !tok[ns + 1][0]) return false;
  g.lat = gpsDeg(tok[ns - 1], false) * (tok[ns][0] == 'S' ? -1 : 1);
  g.lon = gpsDeg(tok[ns + 1], true) * (tok[ns + 2][0] == 'W' ? -1 : 1);
  if (!(g.lat >= -90 && g.lat <= 90 && g.lon >= -180 && g.lon <= 180) || (g.lat == 0 && g.lon == 0)) return false;
  const char *d = ns + 3 < n ? tok[ns + 3] : "", *t = ns + 4 < n ? tok[ns + 4] : "";
  if (strlen(d) >= 6 && strlen(t) >= 6)
    snprintf(g.utc, sizeof(g.utc), "20%.2s-%.2s-%.2sT%.2s:%.2s:%.2sZ", d + 4, d + 2, d, t, t + 2, t + 4);
  g.alt = ns + 5 < n ? atof(tok[ns + 5]) : 0;
  g.hdop = (cgnss && ns + 9 < n) ? atof(tok[ns + 9]) : -1;
  g.fix = true;
  return true;
}
static const char *gpsLine(const char *tag) { const char *p = strstr(s_at_resp, tag); return p ? p + strlen(tag) : nullptr; }
// v1.6.8: follows LilyGO-T-A76XX GPS_BuiltIn for T-SIM7670G/7672G (TinyGSM enableGPS with MODEM_GPS_ENABLE_GPIO 4, level 1):
// AT+CGDRT=4,1 + AT+CGSETV=4,1 (modem GPIO4 = GNSS antenna/LNA power), then AT+CGNSSPWR=1. We also wait for
// "+CGNSSPWR: READY!" and confirm with AT+CGNSSPWR? before the fix timer starts. GNSS is left on ~5 min after an
// attempt (warm retries) unless low-battery protection is active; the deadline survives deep sleep (RTC clock).
#define GPS_WARM_S 300
RTC_DATA_ATTR static bool s_gnss_on = false;
RTC_DATA_ATTR static double s_gc_lat = 0, s_gc_lon = 0; RTC_DATA_ATTR static int s_gc_sats = 0; RTC_DATA_ATTR static int64_t s_gc_at = 0;
RTC_DATA_ATTR static int64_t s_gnss_off_at = 0;   // epoch seconds (RTC time keeps running in deep sleep)
struct GpsDiag { int ready_ms; bool warm; char pwrq[48]; char ant[64]; char mode[40]; char first[160]; char last[160]; };
static GpsDiag s_gd;
static int64_t rtcNow() { struct timeval tv; gettimeofday(&tv, nullptr); return (int64_t)tv.tv_sec; }
// copy the first "+TAG..." line of s_at_resp (or a short reply) into dst, JSON-safe
static void gpsGrab(char *dst, size_t cap, const char *tag) {
  const char *p = tag ? strstr(s_at_resp, tag) : s_at_resp; if (!p) p = s_at_resp;
  while (*p == '\r' || *p == '\n' || *p == ' ') p++;
  size_t o = 0;
  for (; *p && o + 1 < cap; p++) {
    char c = *p;
    if (c == '\r' || c == '\n') { if (tag) break; c = ' '; }
    if (c == '"' || c == '\\' || (unsigned char)c < 0x20) c = '\'';
    if (c == ' ' && o && dst[o - 1] == ' ') continue;
    dst[o++] = c;
  }
  while (o && dst[o - 1] == ' ') o--;
  dst[o] = 0;
}
static bool gpsWaitReady(uint32_t ms) {
  if (strstr(s_at_resp, "READY!")) return true;
  size_t n = 0; uint32_t t = millis(); char buf[96] = "";
  while (millis() - t < ms) {
    while (ModemSerial.available()) {
      char c = (char)ModemSerial.read();
      if (n + 1 >= sizeof(buf)) { memmove(buf, buf + 48, n - 48); n -= 48; }
      buf[n++] = c; buf[n] = 0;
      if (strstr(buf, "READY!")) return true;
    }
    delay(5);
  }
  return false;
}
static void gpsPowerOff(const char *why) {
  modemAT("AT+CGNSSPWR=0", 5000);
  modemAT("AT+CGSETV=4,0", 2000); modemAT("AT+CGDRT=4,0", 2000);   // antenna power off (LilyGO disableGPS)
  s_gnss_on = false; s_gnss_off_at = 0;
  logf("GPS: GNSS powered off (%s)", why);
}
// Called once the modem is up each wake, and before sleeping: turns GNSS off when the warm window ran out
// or battery protection switched the repeater off.
static void gpsHousekeep() {
  if (!s_gnss_on) return;
  if (s_lb_state == 1) gpsPowerOff("battery protection");
  else if (rtcNow() >= s_gnss_off_at) gpsPowerOff("warm window over");
}
static bool gpsAcquire(GpsFix &g) {
  memset(&g, 0, sizeof(g)); g.hdop = -1; memset(&s_gd, 0, sizeof(s_gd)); s_gd.ready_ms = -1;
  uint32_t p0 = millis();
  // antenna power (modem GPIO4), exactly as LilyGO enableGPS for this board
  bool a1 = modemAT("AT+CGDRT=4,1", 2000), a2 = modemAT("AT+CGSETV=4,1", 2000);
  snprintf(s_gd.ant, sizeof(s_gd.ant), "CGDRT=4,1 %s; CGSETV=4,1 %s", a1 ? "OK" : "ERROR", a2 ? "OK" : "ERROR");
  bool already = modemAT("AT+CGNSSPWR?", 3000) && strstr(s_at_resp, "+CGNSSPWR: 1");
  s_gd.warm = already;
  bool cgnss;
  if (already) { cgnss = true; s_gd.ready_ms = 0; }
  else {
    cgnss = modemAT("AT+CGNSSPWR=1", 10000);
    // 1.6.9: some modem firmware never prints "+CGNSSPWR: READY!" (or prints it inside the OK response), which cost
    // a 30 s wait every attempt. Wait at most 5 s for the URC, then accept AT+CGNSSPWR? reporting 1 as ready.
    if (cgnss) {
      if (gpsWaitReady(5000)) s_gd.ready_ms = (int)(millis() - p0);
      else if (modemAT("AT+CGNSSPWR?", 3000) && strstr(s_at_resp, "+CGNSSPWR: 1")) s_gd.ready_ms = (int)(millis() - p0);
      else s_gd.ready_ms = -1;
    }
  }
  if (cgnss) {
    strcpy(g.src, "CGNSSINFO");
    if (modemAT("AT+CGNSSPWR?", 3000)) gpsGrab(s_gd.pwrq, sizeof(s_gd.pwrq), "+CGNSSPWR:"); else gpsGrab(s_gd.pwrq, sizeof(s_gd.pwrq), nullptr);
    if (modemAT("AT+CGNSSMODE?", 3000)) gpsGrab(s_gd.mode, sizeof(s_gd.mode), "+CGNSSMODE:");
  } else if (modemAT("AT+CGPS=1", 5000)) strcpy(g.src, "CGPSINFO");   // older SIMCom command set
  else { strcpy(g.src, "none"); gpsGrab(s_gd.pwrq, sizeof(s_gd.pwrq), nullptr); return false; }
  s_gnss_on = cgnss;
  uint32_t t0 = millis();   // fix timer starts only once GNSS reports ready
  while (millis() - t0 < s_gps_to * 1000UL) {
    if (modemAT(cgnss ? "AT+CGNSSINFO" : "AT+CGPSINFO", 3000)) {
      const char *tag = cgnss ? "+CGNSSINFO:" : "+CGPSINFO:";
      if (!s_gd.first[0]) gpsGrab(s_gd.first, sizeof(s_gd.first), tag);
      gpsGrab(s_gd.last, sizeof(s_gd.last), tag);
      const char *l = gpsLine(tag);
      if (l && gpsParse(l, cgnss, g)) break;
    }
    delay(5000);
  }
  g.secs = (millis() - t0) / 1000UL;
  if (!cgnss) modemAT("AT+CGPS=0", 5000);
  else if (s_lb_state == 1) gpsPowerOff("battery protection");
  else { s_gnss_off_at = rtcNow() + GPS_WARM_S; logf("GPS: GNSS kept on %ds for warm retries", GPS_WARM_S); }
  logf("GPS: %s src=%s sats=%d secs=%u ready=%dms", g.fix ? "fix" : "no fix", g.src, g.sats, (unsigned)g.secs, s_gd.ready_ms);
  return g.fix;
}
// Runs a fix attempt and posts {"type":"gps",...}. Summary text -> out.
static void gpsReport(const char *trigger, char *out, size_t cap) {
  s_gps_done = true;
  GpsFix g; gpsAcquire(g);
  if (g.fix) { s_gc_lat = g.lat; s_gc_lon = g.lon; s_gc_sats = g.sats; s_gc_at = rtcNow() > 1700000000LL ? rtcNow() : 1; }
  if (g.fix) snprintf(out, cap, "GPS fix %.6f,%.6f alt=%.0fm sats=%d hdop=%.1f in %us", g.lat, g.lon, g.alt, g.sats, g.hdop, (unsigned)g.secs);
  else if (!strcmp(g.src, "none")) snprintf(out, cap, "GPS unavailable: modem did not accept the GNSS power command");
  else snprintf(out, cap, "GPS no fix after %us (sats seen %d). Check the GNSS antenna and sky view.", (unsigned)g.secs, g.sats);
  static char diag[700];
  snprintf(diag, sizeof(diag), ",\"diag\":{\"ready_ms\":%d,\"warm\":%s,\"pwr\":\"%s\",\"ant\":\"%s\",\"mode\":\"%s\",\"first\":\"%s\",\"last\":\"%s\",\"sats\":%d,\"timeout\":%u}",
           s_gd.ready_ms, s_gd.warm ? "true" : "false", s_gd.pwrq, s_gd.ant, s_gd.mode, s_gd.first, s_gd.last, g.sats, (unsigned)s_gps_to);
  static char body[1400];
  if (g.fix)
    snprintf(body, sizeof(body), "{\"type\":\"gps\",\"fw\":\"%s\",\"fix\":true,\"lat\":%.6f,\"lon\":%.6f,\"alt\":%.1f,\"sats\":%d,\"hdop\":%.1f,"
             "\"utc\":\"%s\",\"secs\":%u,\"src\":\"%s\",\"trigger\":\"%s\",\"msg\":\"%s\"%s}",
             FW_VERSION, g.lat, g.lon, g.alt, g.sats, g.hdop, g.utc, (unsigned)g.secs, g.src, trigger, out, diag);
  else
    snprintf(body, sizeof(body), "{\"type\":\"gps\",\"fw\":\"%s\",\"fix\":false,\"sats\":%d,\"secs\":%u,\"src\":\"%s\",\"trigger\":\"%s\",\"msg\":\"%s\"%s}",
             FW_VERSION, g.sats, (unsigned)g.secs, g.src, trigger, out, diag);
  ingestSendBig(body);
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

static float s_bat_idle_fwd(void) { return s_bat_idle; }
RTC_DATA_ATTR static int s_sig_csq = -1, s_sig_rsrp = 0;
// v1.7.1 modem watchdog state (functions further down). Settings and counters live in NVS namespace "tsimwd".
#define WD_DEFAULT_MIN     180      // check every 3 h by default; 0 disables
#define WD_MIN_MIN         30
#define WD_MAX_MIN         1440
#define WD_LOWBAT_V        3.35f    // below this (valid idle reading): check only, no recovery and no heartbeat
#define WD_BUDGET_MS       300000UL // hard cap on recovery work per wake
#define MODEM_PWROFF_PULSE_MS 3000  // SIM7670G/7672G PWRKEY power-off pulse (LilyGO utilities.h)
static uint32_t s_wd_int_min = WD_DEFAULT_MIN;
static bool s_wd_hb = true, s_wd_sms = false, s_wd_pend = false;
static uint32_t s_wd_chk = 0, s_wd_ok = 0, s_wd_soft = 0, s_wd_hard = 0, s_wd_fail = 0;
static char s_wd_ev[320] = "";                    // "rtc,stage,result,secs;..." newest first
RTC_DATA_ATTR static int64_t s_wd_due = 0;        // rtcNow() when the next check is due (RTC time runs in deep sleep)
RTC_DATA_ATTR static uint8_t s_wd_fails = 0;      // consecutive failed checks (retry backoff)
// v1.7.2: watchdog wakes also fetch and run queued dashboard commands (WDCFG cmd=0|1, default on), a full T-SIM
// restart after WD_RESTART_FAILS failed recoveries in a row, and NVS counters for restarts and awake-deadline resets.
#define WD_RESTART_FAILS   3
static bool s_wd_cmd = true;
static uint32_t s_wd_rst = 0, s_wd_dlx = 0, s_wd_cmdn = 0;
// v1.7.3 Heltec-reboot wake (GPIO6, ext1 any-low). WDCFG hwake=0|1 (default on). Accepted wakes are rate limited (60 s
// apart, 6 per rolling 24 h); stuck-low / too-soon / over-limit wakes count as spurious and HW_SPUR_MAX in a row turn it
// off (hwk=2 "auto-off") until WDCFG hwake=1. Arming is skipped for a sleep when GPIO6 is low right before sleeping.
#define HW_DEBOUNCE_S   60
#define HW_MAX_DAY      6
#define HW_SPUR_MAX     3
#define HW_STUCK_MS     2000
static bool s_hw_en = true, s_hw_auto = false;
static uint32_t s_hw_n = 0, s_hw_ign = 0, s_hw_skip = 0, s_hw_spur = 0, s_hw_dayn = 0;
static int64_t s_hw_last = 0, s_hw_day0 = 0;
static const char *s_wd_reason = nullptr;   // set for a heartbeat that isn't a routine timer check
// v1.7.4: awake detections (serial boot output), and the pending report: reboots detected but not yet delivered to the
// dashboard (LTE down / post failed). Kept in NVS (survives deep sleep and power loss); sent in the "tl" block of the
// next successful post of any kind, then cleared.
static uint32_t s_hw_aw = 0, s_hw_up = 0;   // awake (serial banner) / uptime-poll detections (v1.7.5)
static uint32_t s_hrp_n = 0, s_hrp_sent = 0; static int64_t s_hrp_t = 0; static char s_hrp_src[8] = "";
static const char *s_wd_src = nullptr;      // heartbeat "src": wake | awake | console
static void hrpSave() { Preferences p; p.begin("tsimwd", false); p.putUInt("hrpn", s_hrp_n); p.putLong64("hrpt", s_hrp_t); p.putString("hrps", s_hrp_src); p.end(); }
static void hrpAdd(const char *src) {
  s_hrp_n++; s_hrp_t = rtcNow(); strncpy(s_hrp_src, src, sizeof(s_hrp_src) - 1); s_hrp_src[sizeof(s_hrp_src) - 1] = 0; hrpSave();
}
static void hrpAfterPost(bool ok) {
  if (ok && s_hrp_sent) { s_hrp_n = s_hrp_n > s_hrp_sent ? s_hrp_n - s_hrp_sent : 0; hrpSave(); logf("Heltec reboot report delivered (%u pending)", (unsigned)s_hrp_n); }
  s_hrp_sent = 0;
}
// v1.7.5 daylight uptime polling (WDCFG upoll=<0|15-1440 min>, default 60, 0 = off; usol=<mV>, default 2000, 0 = day and
// night). A timer wake reads the solar input; in daylight (solar >= usol) and above the low-battery guard it asks the
// Heltec "stats-core" over serial (no modem) and compares uptime_secs with the last reading + elapsed time.
#define UP_DEFAULT_MIN 60
#define UP_MIN_MIN     15
#define UP_DEFAULT_SOL 2000
#define UP_WRAP_S      4294967UL   // stock MeshCore uptime = millis()/1000 (32-bit): wraps after ~49.7 days
static uint32_t s_up_min = UP_DEFAULT_MIN, s_up_sol = UP_DEFAULT_SOL;
static uint32_t s_up_n = 0, s_up_night = 0, s_up_nr = 0, s_up_lowb = 0, s_up_det = 0;
static const char *s_hwa_src = "awake";
// Records one stats-core uptime reading; true when it went backwards (Heltec rebooted since the last reading).
static bool upCheck(uint32_t up) {
  int64_t now = rtcNow(); bool rb = false;
  if (s_up_last_t > 0 && now >= s_up_last_t) {
    int64_t el = now - s_up_last_t, expect = (int64_t)s_up_last + el, tol = 120 + el / 10;   // RTC drift in deep sleep
    bool wrap = expect + tol >= (int64_t)UP_WRAP_S;
    rb = !wrap && (int64_t)up + tol < expect && (int64_t)up <= el + tol;
    logf("uptime: Heltec up %us, expected ~%llds (last %us, %llds ago)%s", (unsigned)up, (long long)expect, (unsigned)s_up_last, (long long)el, rb ? " -> REBOOTED" : "");
  } else logf("uptime: Heltec up %us (new baseline)", (unsigned)up);
  s_up_last = up; s_up_last_t = now;
  if (rb) s_up_det++;
  return rb;
}
static bool upParse(const char *out, uint32_t *up) {
  const char *q = strstr(out, "\"uptime_secs\":"); if (!q) return false;
  char *e; unsigned long v = strtoul(q + 14, &e, 10); if (e == q + 14) return false;
  *up = (uint32_t)v; return true;
}
static void upFromCli(const char *out) {   // awake (status mesh snapshot): a reboot found here goes through hwAwakeService
  uint32_t up; if (!s_up_min || !upParse(out, &up)) return;
  bool rb = upCheck(up);
  if (rb && (selfResetActive(s_hm.self, millis()) || selfResetActive(s_cons, millis()))) { s_hw_self++; wdSave(); logf("uptime: reboot is the T-SIM's own reset, ignored"); return; }   // v1.7.6
  if (rb && !s_hwa_flag) { s_hwa_src = "uptime"; s_hwa_mark = "uptime"; s_hwa_flag = true; }
}
static void telemRefreshSignal() {
  if (s_tcp_busy) return;
  if (modemAT("AT+CSQ", 3000)) { const char *p = strstr(s_at_resp, "+CSQ:"); int v; if (p && sscanf(p, "+CSQ: %d", &v) == 1) s_sig_csq = v; }
}
static size_t telemJson(char *out, size_t cap) {
  float bl = batCal(readAdcVolts(BOARD_BAT_ADC_PIN, 2.0f)), sol = readAdcVolts(BOARD_SOLAR_ADC_PIN, 2.0f);
  int64_t now = rtcNow();
  size_t o = snprintf(out, cap, ",\"tl\":{\"fw\":\"%s\",\"bv\":%.2f,\"bp\":%d,\"bl\":%.2f,\"sv\":%.2f,\"csq\":%d,\"rsrp\":%d,\"up\":%lu,\"wake\":%d,\"rr\":%d,\"heap\":%u,\"tc\":%.1f,\"lb\":%d",
    FW_VERSION, s_bat_idle, batPercent(s_bat_idle), bl, sol, s_sig_csq, s_sig_rsrp, (unsigned long)(millis() / 1000UL), (int)s_wake_cause, (int)esp_reset_reason(),
    (unsigned)ESP.getFreeHeap(), temperatureRead(), (int)s_lb_state);
  if (o < cap) o += snprintf(out + o, cap - o, ",\"wdi\":%u,\"wdc\":%u,\"wds\":%u,\"wdh\":%u,\"wdf\":%u",
    (unsigned)s_wd_int_min, (unsigned)s_wd_chk, (unsigned)s_wd_soft, (unsigned)s_wd_hard, (unsigned)s_wd_fail);  // v1.7.1
  if (o < cap && now > 1700000000LL) o += snprintf(out + o, cap - o, ",\"ts\":%lld", (long long)now);
  if (o < cap && s_gc_at > 0) o += snprintf(out + o, cap - o, ",\"glat\":%.6f,\"glon\":%.6f,\"gsats\":%d,\"gat\":%lld", s_gc_lat, s_gc_lon, s_gc_sats, (long long)s_gc_at);
  if (o < cap) o += snprintf(out + o, cap - o, ",\"dg\":[%u,%u,%u,%u]", (unsigned)s_dg_clib, (unsigned)s_dg_g6c, (unsigned)s_dg_ub, (unsigned)(s_dg_g6i + (s_g6_on && s_g6_edges > s_g6_cli_wake ? s_g6_edges - s_g6_cli_wake : 0)));   // v1.7.5 wire diagnostics
  s_hrp_sent = 0;
  if (o < cap && s_hrp_n) {  // v1.7.4 pending Heltec-reboot report: count, seconds ago (-1 = before a cold boot), source
    long long ago = s_hrp_t > 0 && s_hrp_t <= now ? (long long)(now - s_hrp_t) : -1;
    o += snprintf(out + o, cap - o, ",\"hrp\":%u,\"hrpa\":%lld,\"hrps\":\"%s\"", (unsigned)s_hrp_n, ago, s_hrp_src);
    s_hrp_sent = s_hrp_n;
  }
  if (o < cap) o += snprintf(out + o, cap - o, "}");
  if (o >= cap) s_hrp_sent = 0;
  return o < cap ? o : 0;
}
static void doStatusReport(void) {
  float bat_load = batCal(readAdcVolts(BOARD_BAT_ADC_PIN, 2.0f));  // modem on: loaded
  float bat = s_bat_idle;                                          // idle (start of wake): reported value
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
    "APN=%s awake=%lus cmds=REBOOT|UPDATE|TSIMUPDATE|STATUS|CMD|TESTDL|GPSFIX",
    FW_VERSION, FW_BUILD_DATE, bat, batPercent(bat), sol,
    csq, cpsi, cops, cereg, ip, cgmr,
    (unsigned long)(millis()/1000UL), (int)s_wake_cause, (unsigned)ESP.getFreeHeap(),
    (unsigned)(tot - used), (unsigned)tot, s_last_result,
    g_apn, (unsigned long)(AWAKE_WINDOW_MS/1000UL));
  Serial.println(s_text_body);
  {
    int csqv = -1, rsrq = 0, rsrp = 0, reg = -1;
    char *p = strstr(csq, "+CSQ:"); if (p) sscanf(p, "+CSQ: %d", &csqv);
    s_sig_csq = csqv;
    // +CPSI: LTE,Online,MCC-MNC,TAC,CellID,PCI,Band,EARFCN,DLBW,ULBW,RSRQ,RSRP,RSSI,RSNR
    { int f = 0; const char *q = cpsi;
      while (*q) { if (*q == ',') { f++; if (f == 10) rsrq = atoi(q + 1); if (f == 11) rsrp = atoi(q + 1); } q++; } }
    s_sig_rsrp = rsrp;
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
      "{\"type\":\"status\",\"fw\":\"%s\",\"uptime\":%lu,\"wake\":%d,\"rr\":%d,\"battery_v\":%.2f,\"battery_pct\":%d,"
      "\"solar_v\":%.2f,\"csq\":%d,\"rsrp\":%d,\"rsrq\":%d,\"operator\":\"%s\",\"reg\":%d,\"ip\":\"%s\","
      "\"modem_fw\":\"%s\",\"heap\":%u,\"fs_free\":%u,\"last_update\":\"%s\",\"battery_load_v\":%.2f",
      FW_VERSION, (unsigned long)(millis() / 1000UL), (int)s_wake_cause, (int)esp_reset_reason(), bat, batPercent(bat), sol,
      csqv, rsrp, rsrq, ope, reg, ipe, mfw, (unsigned)ESP.getFreeHeap(), (unsigned)(tot - used), lr, bat_load);
    { size_t L = strlen(s_ingest_body); L += pwrJson(s_ingest_body + L, sizeof(s_ingest_body) - L);
      snprintf(s_ingest_body + L, sizeof(s_ingest_body) - L, ",\"msg\":\"STATUS\"}"); }
    ingestPostOrQueue(s_ingest_body);
  }
  (void)had;
}

// -------------------- UPDATE --------------------
static bool doUpdate(const char *url, bool flash_too) {
  heltecMonStop();   // v1.7.4: the flasher owns the Heltec UART (it resets the Heltec itself)
  s_busy_update = true;
  deadlineArm(AWAKE_MAX_UPD_S);   // v1.7.2: updates get a longer awake limit
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
  progressf("UPDATE", "signal_strength", 3, "PDP up APN=%s", g_apn);

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
  { char m[380]; snprintf(m, sizeof(m), "%s %.160s%s%s", flashed ? "SUCCESS:" : "FAIL: flash", url,
                          s_flash_info[0] ? " | " : "", s_flash_info); ingestEvent("update", m); }
  return flashed;
}

// -------------------- v1.7.0 repeater settings cache (CFGSNAP) --------------------
// When enabled, on a wake that already talks to the repeater, and at most every int hours, the T-SIM fetches the
// list of read-only "get" commands from the Worker (/api/dev/<id>/cfglist), runs them over serial, and posts the
// replies as {"type":"cfgsnap"}. Unsent parts are kept in LittleFS and retried on the next wake.
#define CFGSNAP_Q "/cfgsnap.q"
static bool s_cs_en = false, s_cs_now = false; static uint32_t s_cs_int_h = 24; static int64_t s_cs_last = 0;
static void csLoad() { Preferences p; p.begin("tsimcs", true); s_cs_en = p.getBool("en", false); s_cs_int_h = p.getUInt("int", 24); s_cs_last = p.getLong64("last", 0); p.end(); if (s_cs_int_h < 1 || s_cs_int_h > 168) s_cs_int_h = 24; }
static void csApplyCfg(const char *args, char *out, size_t cap) {
  Preferences p; p.begin("tsimcs", false);
  char buf[120]; strncpy(buf, args, sizeof(buf) - 1); buf[sizeof(buf) - 1] = 0; char *save = nullptr; int n = 0;
  for (char *t = strtok_r(buf, " ", &save); t; t = strtok_r(nullptr, " ", &save)) {
    char *eq = strchr(t, '='); if (!eq) continue; *eq = 0; const char *k = t, *v = eq + 1;
    if (!strcmp(k, "en")) { s_cs_en = atoi(v) != 0; p.putBool("en", s_cs_en); n++; }
    else if (!strcmp(k, "int")) { uint32_t h = (uint32_t)atoi(v); if (h >= 1 && h <= 168) { s_cs_int_h = h; p.putUInt("int", h); n++; } }
    else if (!strcmp(k, "now")) { s_cs_now = atoi(v) != 0; n++; }
  }
  p.end();
  snprintf(out, cap, "CFGSNAP applied %d: en=%d int=%uh%s", n, (int)s_cs_en, (unsigned)s_cs_int_h, s_cs_now ? " (refresh this wake)" : "");
  logf("%s", out);
}
static void csSendOrKeep(const char *body) {
  if (ingestSendBig(body)) return;
  File f = LittleFS.open(CFGSNAP_Q, "a"); if (f) { f.println(body); f.close(); logf("cfgsnap: part kept for retry"); }
}
static void csFlush() {
  if (!LittleFS.exists(CFGSNAP_Q)) return;
  File f = LittleFS.open(CFGSNAP_Q, "r"); if (!f) return;
  bool all = true;
  while (f.available()) { size_t n = f.readBytesUntil('\n', s_mesh_body, sizeof(s_mesh_body) - 1); s_mesh_body[n] = 0; trimInPlace(s_mesh_body); if (s_mesh_body[0] && !ingestSendBig(s_mesh_body)) { all = false; break; } }
  f.close(); if (all) LittleFS.remove(CFGSNAP_Q);
}
static void cfgSnapshot() {
  csFlush();
  int64_t now = rtcNow();
  bool due = s_cs_en && (s_cs_last <= 0 || now < s_cs_last || now - s_cs_last >= (int64_t)s_cs_int_h * 3600);
  if (!s_cs_now && (!due || s_lb_state == 1)) return;   // battery protection: only on explicit request
  s_cs_now = false;
  static char url[240]; snprintf(url, sizeof(url), "%s/api/dev/%s/cfglist", g_worker_url, g_device_id);
  if (httpsGetTls(url, s_cmd_list, sizeof(s_cmd_list)) != 200) { logf("cfgsnap: list fetch failed"); return; }
  static char esc[CLI_OUT_MAX + 256], ec[200];
  int part = 0, items = 0, noreply = 0, total = 0; uint32_t t0 = millis();
  size_t o = 0; char *save = nullptr;
  auto head = [&]() { o = snprintf(s_mesh_body, sizeof(s_mesh_body), "{\"type\":\"cfgsnap\",\"fw\":\"%s\",\"part\":%d%s,\"items\":[", FW_VERSION, part, now > 1700000000LL ? "" : ""); items = 0; };
  head();
  for (char *line = strtok_r(s_cmd_list, "\n", &save); line && total < 48; line = strtok_r(nullptr, "\n", &save)) {
    trimInPlace(line); if (!line[0]) continue;
    bool clean = true; for (char *q = line; *q; q++) if ((unsigned char)*q < 0x20 || (unsigned char)*q > 0x7e) clean = false;
    if (!clean || (strncasecmp(line, "get ", 4) && strcasecmp(line, "powersaving") && strcasecmp(line, "ver") && strcasecmp(line, "board") && strncasecmp(line, "region", 6) && strncasecmp(line, "gps", 3))) continue;  // read-only commands only
    if (!strncasecmp(line, "gps ", 4) && strcasecmp(line, "gps advert")) continue;
    if (!strncasecmp(line, "region ", 7) && strcasecmp(line, "region home") && strcasecmp(line, "region default")) continue;
    if (millis() - t0 > 180000UL || noreply >= 3) break;
    bool ok = heltecCli(line, s_cli_out, sizeof(s_cli_out), 4000); noreply = ok ? 0 : noreply + 1; total++;
    jsonEsc(esc, sizeof(esc), ok ? s_cli_out : ""); jsonEsc(ec, sizeof(ec), line);
    if (o + strlen(esc) + strlen(ec) + 64 > 3400) { snprintf(s_mesh_body + o, sizeof(s_mesh_body) - o, "]}"); csSendOrKeep(s_mesh_body); part++; head(); }
    o += snprintf(s_mesh_body + o, sizeof(s_mesh_body) - o, "%s[\"%s\",\"%s\"]", items ? "," : "", ec, esc); items++;
  }
  heltecCliEnd();
  snprintf(s_mesh_body + o, sizeof(s_mesh_body) - o, "],\"final\":true,\"count\":%d%s}", total, noreply >= 3 ? ",\"error\":\"no reply from Heltec\"" : "");
  csSendOrKeep(s_mesh_body);
  if (total && noreply < 3) { s_cs_last = rtcNow(); Preferences p; p.begin("tsimcs", false); p.putLong64("last", s_cs_last); p.end(); }
  logf("cfgsnap: %d command(s) in %lus", total, (unsigned long)((millis() - t0) / 1000));
}

// -------------------- v1.7.1 modem watchdog (self-recovery) --------------------
// The T-SIM normally sleeps until the modem rings it for a text. If the modem drops off LTE or hangs while the
// ESP32 sleeps, no text can arrive and nothing would ever wake it. The watchdog adds a timer wake (default every
// 3 h, 0 = off): it wakes the modem from sleep WITHOUT resetting it, checks AT / SIM / registration (CEREG, CREG)
// / packet attach (CGATT), and only if that fails escalates: soft recovery (AT+CFUN=0/1), then a hard
// power-cycle (AT+CPOF or a 3 s PWRKEY pulse, then the normal RESET + PWRKEY power-on). Every step has a timeout;
// the whole wake is capped. Then the modem goes back to sleep with the SMS ring wake re-armed.
// A heartbeat is posted to the dashboard after a recovery, after a failure that was not reported yet, and (hb=1,
// default) after every check. Queued dashboard commands are never fetched on a watchdog wake. Texts already stored
// on the modem are processed only when sms=1 (default off). No SMS is ever sent.
static void processSmsInbox();
static void wdSave() {
  Preferences p; p.begin("tsimwd", false);
  p.putUInt("chk", s_wd_chk); p.putUInt("ok", s_wd_ok); p.putUInt("soft", s_wd_soft); p.putUInt("hard", s_wd_hard); p.putUInt("fail", s_wd_fail);
  p.putBool("pend", s_wd_pend); p.putString("ev", s_wd_ev);
  p.putUInt("rst", s_wd_rst); p.putUInt("dlx", s_wd_dlx); p.putUInt("cmdn", s_wd_cmdn);
  p.putBool("hwake", s_hw_en); p.putBool("hwauto", s_hw_auto); p.putUInt("hwn", s_hw_n); p.putUInt("hwi", s_hw_ign); p.putUInt("hws", s_hw_skip);
  p.putUInt("hwsp", s_hw_spur); p.putUInt("hwdn", s_hw_dayn); p.putLong64("hwl", s_hw_last); p.putLong64("hwd0", s_hw_day0);
  p.putUInt("hwa", s_hw_aw); p.putUInt("hwu", s_hw_up); p.putUInt("hwo", s_hw_self);
  p.putUInt("upn", s_up_n); p.putUInt("upk", s_up_night); p.putUInt("upr", s_up_nr); p.putUInt("upb", s_up_lowb); p.putUInt("upd", s_up_det);
  p.end();
}
static void wdLoad() {
  Preferences p; p.begin("tsimwd", false);
  s_wd_int_min = p.getUInt("int", WD_DEFAULT_MIN); s_wd_hb = p.getBool("hb", true); s_wd_sms = p.getBool("sms", false);
  s_wd_chk = p.getUInt("chk", 0); s_wd_ok = p.getUInt("ok", 0); s_wd_soft = p.getUInt("soft", 0); s_wd_hard = p.getUInt("hard", 0); s_wd_fail = p.getUInt("fail", 0);
  s_wd_pend = p.getBool("pend", false);
  s_hw_en = p.getBool("hwake", true); s_hw_auto = p.getBool("hwauto", false); s_hw_n = p.getUInt("hwn", 0); s_hw_ign = p.getUInt("hwi", 0);
  s_hw_skip = p.getUInt("hws", 0); s_hw_spur = p.getUInt("hwsp", 0); s_hw_dayn = p.getUInt("hwdn", 0); s_hw_last = p.getLong64("hwl", 0); s_hw_day0 = p.getLong64("hwd0", 0);
  s_up_min = p.getUInt("upm", UP_DEFAULT_MIN); s_up_sol = p.getUInt("usol", UP_DEFAULT_SOL);
  s_up_n = p.getUInt("upn", 0); s_up_night = p.getUInt("upk", 0); s_up_nr = p.getUInt("upr", 0); s_up_lowb = p.getUInt("upb", 0); s_up_det = p.getUInt("upd", 0);
  s_hw_aw = p.getUInt("hwa", 0); s_hw_up = p.getUInt("hwu", 0); s_hw_self = p.getUInt("hwo", 0); s_hrp_n = p.getUInt("hrpn", 0); s_hrp_t = p.getLong64("hrpt", 0);
  { String hs = p.getString("hrps", ""); strncpy(s_hrp_src, hs.c_str(), sizeof(s_hrp_src) - 1); s_hrp_src[sizeof(s_hrp_src) - 1] = 0; }
  s_wd_cmd = p.getBool("cmd", true); s_wd_rst = p.getUInt("rst", 0); s_wd_dlx = p.getUInt("dlx", 0); s_wd_cmdn = p.getUInt("cmdn", 0);
  {  // last wake hit the awake deadline (esp_timer) or a hardware/task watchdog reset
    esp_reset_reason_t rr = esp_reset_reason();
    bool hit = s_dl_hit == DL_MAGIC || rr == ESP_RST_WDT || rr == ESP_RST_TASK_WDT || rr == ESP_RST_INT_WDT;
    s_dl_hit = 0;
    if (hit) { s_wd_dlx++; p.putUInt("dlx", s_wd_dlx); }
  }
  String ev = p.getString("ev", ""); strncpy(s_wd_ev, ev.c_str(), sizeof(s_wd_ev) - 1); s_wd_ev[sizeof(s_wd_ev) - 1] = 0;
  p.end();
  if (s_wd_int_min == 0) s_wd_int_min = WD_MAX_MIN;   // v1.7.2: the watchdog can no longer be turned off; 0 = every 24 h
  if (s_wd_int_min < WD_MIN_MIN || s_wd_int_min > WD_MAX_MIN) s_wd_int_min = WD_DEFAULT_MIN;
}
// Newest first, at most 6 entries: "<rtc s>,<stage>,<result>,<secs>"
static void wdAddEvent(const char *stage, const char *result, uint32_t secs) {
  char tmp[sizeof(s_wd_ev)];
  int n = snprintf(tmp, sizeof(tmp), "%lld,%s,%s,%u", (long long)rtcNow(), stage, result, (unsigned)secs);
  int kept = 0; const char *q = s_wd_ev;
  while (*q && kept < 5) {
    const char *e = strchr(q, ';'); size_t L = e ? (size_t)(e - q) : strlen(q);
    if (n + 1 + (int)L >= (int)sizeof(tmp)) break;
    tmp[n++] = ';'; memcpy(tmp + n, q, L); n += L; tmp[n] = 0; kept++;
    if (!e) break; q = e + 1;
  }
  strncpy(s_wd_ev, tmp, sizeof(s_wd_ev) - 1); s_wd_ev[sizeof(s_wd_ev) - 1] = 0;
  logf("WD event: %s %s %us", stage, result, (unsigned)secs);
}
static void wdSchedule(bool ok) {
  if (!s_wd_int_min) s_wd_int_min = WD_MAX_MIN;   // v1.7.2: never unscheduled
  int64_t secs = (int64_t)s_wd_int_min * 60;
  if (!ok) {  // retry sooner after a failure: 30, 60, 120 min ... capped at the interval
    int64_t b = 1800LL << (s_wd_fails > 1 ? (s_wd_fails - 1 > 4 ? 4 : s_wd_fails - 1) : 0);
    if (b < secs) secs = b;
  }
  s_wd_due = rtcNow() + secs;
}
// WDCFG int=<30..1440 min, 0 = 1440> hb=<0|1> sms=<0|1> cmd=<0|1>  (system command from the Worker; cmd since 1.7.2)
static void wdApplyCfg(const char *args, char *out, size_t cap) {
  Preferences p; p.begin("tsimwd", false);
  char buf[120]; strncpy(buf, args, sizeof(buf) - 1); buf[sizeof(buf) - 1] = 0;
  char *save = nullptr; int n = 0; bool rej = false;
  for (char *t = strtok_r(buf, " ", &save); t; t = strtok_r(nullptr, " ", &save)) {
    char *eq = strchr(t, '='); if (!eq) continue; *eq = 0; const char *k = t, *v = eq + 1;
    if (!strcmp(k, "int")) { uint32_t m = (uint32_t)atoi(v); if (m == 0) m = WD_MAX_MIN; if (m >= WD_MIN_MIN && m <= WD_MAX_MIN) { s_wd_int_min = m; p.putUInt("int", m); n++; } else rej = true; }
    else if (!strcmp(k, "hb")) { s_wd_hb = atoi(v) != 0; p.putBool("hb", s_wd_hb); n++; }
    else if (!strcmp(k, "sms")) { s_wd_sms = atoi(v) != 0; p.putBool("sms", s_wd_sms); n++; }
    else if (!strcmp(k, "cmd")) { s_wd_cmd = atoi(v) != 0; p.putBool("cmd", s_wd_cmd); n++; }
    else if (!strcmp(k, "upoll")) { uint32_t m = (uint32_t)atoi(v); if (m == 0 || (m >= UP_MIN_MIN && m <= WD_MAX_MIN)) { s_up_min = m; p.putUInt("upm", m); s_up_due = 0; n++; } else rej = true; }   // v1.7.5
    else if (!strcmp(k, "usol")) { uint32_t mv = (uint32_t)atoi(v); if (mv <= 20000) { s_up_sol = mv; p.putUInt("usol", mv); n++; } else rej = true; }
    else if (!strcmp(k, "hwake")) { s_hw_en = atoi(v) != 0; s_hw_auto = false; s_hw_spur = 0; p.putBool("hwake", s_hw_en); p.putBool("hwauto", false); p.putUInt("hwsp", 0); n++; }
  }
  p.end();
  s_wd_fails = 0; wdSchedule(true);
  snprintf(out, cap, "WDCFG applied %d%s: int=%u hb=%d sms=%d cmd=%d hwake=%d upoll=%u usol=%u", n, rej ? " (a value was REJECTED: int 30-1440, upoll 0 or 15-1440, usol 0-20000)" : "",
           (unsigned)s_wd_int_min, (int)s_wd_hb, (int)s_wd_sms, (int)s_wd_cmd, (int)s_hw_en, (unsigned)s_up_min, (unsigned)s_up_sol);
  logf("%s", out);
}
static int wdRegStat(const char *tag) {
  const char *p = strstr(s_at_resp, tag); if (!p) return -1;
  int a, b; if (sscanf(p + strlen(tag), " %d,%d", &a, &b) == 2) return b;
  return -1;
}
// 1 home, 5 roaming, 6/7 SMS only, 9/10 CSFB not preferred = registered
static bool wdRegOk(int st) { return st == 1 || st == 5 || st == 6 || st == 7 || st == 9 || st == 10; }
static bool wdRegistered() {
  if (modemAT("AT+CEREG?", 2000) && wdRegOk(wdRegStat("+CEREG:"))) return true;
  if (modemAT("AT+CREG?", 2000) && wdRegOk(wdRegStat("+CREG:"))) return true;
  return false;
}
static bool wdWaitReg(uint32_t ms) {
  uint32_t t0 = millis();
  do { if (wdRegistered()) return true; delay(2000); } while (millis() - t0 < ms);
  return false;
}
static bool wdAttached() {
  if (!modemAT("AT+CGATT?", 3000)) return false;
  const char *p = strstr(s_at_resp, "+CGATT:"); int v = 0;
  return p && sscanf(p, "+CGATT: %d", &v) == 1 && v == 1;
}
static bool wdProbe(int tries) {
  for (int i = 0; i < tries; i++) { if (modemAT("AT", 1000)) return true; delay(200); }
  return false;
}
static bool wdHealthy(uint32_t cpin_ms, uint32_t reg_ms) {
  return modemWaitCpinReady(cpin_ms) && wdWaitReg(reg_ms) && wdAttached();
}
static bool wdSoft() {
  logf("WD: soft recovery (AT+CFUN=0/1)");
  modemAT("AT+CFUN=0", 15000); delay(2000);
  modemAT("AT+CFUN=1", 15000); delay(1000);
  s_pdp_up = false;
  return wdHealthy(20000, 60000);
}
static bool wdHard(bool at_alive) {
  logf("WD: hard power-cycle");
  if (!(at_alive && modemAT("AT+CPOF", 10000))) {      // graceful power-off when it still answers, else PWRKEY
    pinMode(MODEM_PWRKEY_PIN, OUTPUT);
    digitalWrite(MODEM_PWRKEY_PIN, HIGH); delay(MODEM_PWROFF_PULSE_MS); digitalWrite(MODEM_PWRKEY_PIN, LOW);
  }
  delay(5000);
  ModemSerial.end();
  s_pdp_up = false;
  if (!modemPowerOn()) return false;                    // RESET pulse + PWRKEY on (the normal boot sequence)
  modemAT("ATE0"); modemAT("AT+CMEE=2");
  return wdHealthy(20000, 90000);
}
static int wdSmsStored() {
  if (!modemAT("AT+CPMS?", 3000)) return -1;
  const char *p = strstr(s_at_resp, "+CPMS:"); if (!p) return -1;
  p = strchr(p, ','); return p ? atoi(p + 1) : -1;
}
static size_t wdJson(char *dst, size_t cap) {
  int64_t now = rtcNow(), nx = s_wd_due > 0 ? s_wd_due - now : -1;
  size_t o = snprintf(dst, cap, ",\"wd\":{\"int\":%u,\"hb\":%d,\"sms\":%d,\"chk\":%u,\"ok\":%u,\"soft\":%u,\"hard\":%u,\"fail\":%u,\"fails\":%u,\"next\":%lld,\"cmd\":%d,\"cmdn\":%u,\"rst\":%u,\"dlx\":%u,\"hwk\":%d,\"hwn\":%u,\"hwi\":%u,\"hws\":%u,\"hwa\":%u,\"hwu\":%u,\"hwo\":%u,\"hwr\":%d,\"up\":%u,\"usol\":%u,\"upn\":%u,\"upk\":%u,\"upr\":%u,\"upb\":%u,\"upd\":%u,\"upu\":%lld,\"upa\":%lld,\"ev\":[",
    (unsigned)s_wd_int_min, (int)s_wd_hb, (int)s_wd_sms, (unsigned)s_wd_chk, (unsigned)s_wd_ok, (unsigned)s_wd_soft, (unsigned)s_wd_hard,
    (unsigned)s_wd_fail, (unsigned)s_wd_fails, (long long)nx, (int)s_wd_cmd, (unsigned)s_wd_cmdn, (unsigned)s_wd_rst, (unsigned)s_wd_dlx,
    s_hw_auto ? 2 : (int)s_hw_en, (unsigned)s_hw_n, (unsigned)s_hw_ign, (unsigned)s_hw_skip, (unsigned)s_hw_aw,
    (unsigned)s_hw_up, (unsigned)s_hw_self, s_hw_armres == 255 ? -1 : (int)s_hw_armres, (unsigned)s_up_min, (unsigned)s_up_sol, (unsigned)s_up_n, (unsigned)s_up_night, (unsigned)s_up_nr,
    (unsigned)s_up_lowb, (unsigned)s_up_det, s_up_last_t > 0 ? (long long)s_up_last : -1LL, s_up_last_t > 0 && now >= s_up_last_t ? (long long)(now - s_up_last_t) : -1LL);
  const char *q = s_wd_ev; bool first = true;
  while (*q && o < cap) {
    long long rtc = 0; char st[12] = "", rs[12] = ""; unsigned secs = 0;
    if (sscanf(q, "%lld,%11[^,],%11[^,],%u", &rtc, st, rs, &secs) == 4) {
      long long ago = rtc <= now ? now - rtc : -1;   // -1: logged before a cold boot (RTC restarted)
      o += snprintf(dst + o, cap - o, "%s[%lld,\"%s\",\"%s\",%u]", first ? "" : ",", ago, st, rs, secs); first = false;
    }
    const char *e = strchr(q, ';'); if (!e) break; q = e + 1;
  }
  if (o < cap) o += snprintf(dst + o, cap - o, "]}");
  return o < cap ? o : 0;
}
static bool wdHeartbeat(const char *stage, int sms) {
  if (!s_pdp_up && !modemOpenData()) return false;
  telemRefreshSignal();
  static char hb[1200];
  size_t o = snprintf(hb, sizeof(hb), "{\"type\":\"heartbeat\",\"fw\":\"%s\",\"stage\":\"%s\",\"sms_waiting\":%d,\"msg\":\"Watchdog check: %s%s\"%s%s%s",
                      FW_VERSION, stage, sms, stage, s_wd_reason ? " (Heltec reboot detected)" : "",
                      s_wd_reason ? ",\"reason\":\"" : "", s_wd_reason ? s_wd_reason : "", s_wd_reason ? "\"" : "");
  if (s_wd_reason && s_wd_src) o += snprintf(hb + o, sizeof(hb) - o, ",\"src\":\"%s\"", s_wd_src);   // v1.7.4
  o += wdJson(hb + o, sizeof(hb) - o - 2);
  snprintf(hb + o, sizeof(hb) - o, "}");
  return ingestSend(hb);
}
// Runs on a watchdog timer wake. Returns true when the modem ends up healthy.
// force (v1.7.3, Heltec-reboot wake): recover even when the check passes (CFUN reset, then power-cycle if that fails)
// and always post a heartbeat.
static bool wdRun(bool force = false) {
  uint32_t t0 = millis();
  s_wd_chk++;
  pinMode(MODEM_DTR_PIN, OUTPUT); digitalWrite(MODEM_DTR_PIN, LOW);   // DTR low: modem leaves CSCLK sleep (no reset)
  ModemSerial.setRxBufferSize(8192);
  ModemSerial.begin(MODEM_BAUD, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
  delay(150);
  bool at = wdProbe(5);
  if (at) { modemAT("ATE0"); modemAT("AT+CMEE=2"); }
  bool ok = at && wdHealthy(5000, 20000);
  if (s_hrp_n) s_wd_pend = true;   // v1.7.4: an undelivered Heltec-reboot report goes out with this heartbeat
  if (force) { logf("WD: forced recovery (check said healthy=%d)", (int)ok); ok = false; s_wd_pend = true; }
  bool lowbat = s_bat_idle >= 2.5f && s_bat_idle < WD_LOWBAT_V;
  const char *stage = "ok"; bool hard_tried = false;
  logf("WD: check AT=%d healthy=%d bat=%.2fV", (int)at, (int)ok, s_bat_idle);
  if (!ok && lowbat) {
    stage = "lowbat"; wdAddEvent("check", "lowbat", (millis() - t0) / 1000);
  } else if (!ok) {
    if (at) {
      s_wd_soft++; stage = "soft";
      ok = wdSoft();
      wdAddEvent("soft", ok ? "ok" : "fail", (millis() - t0) / 1000);
    }
    if (!ok && millis() - t0 < WD_BUDGET_MS) {
      s_wd_hard++; stage = "hard"; hard_tried = true;
      ok = wdHard(at && wdProbe(2));
      wdAddEvent("hard", ok ? "ok" : "fail", (millis() - t0) / 1000);
    }
    if (ok) { modemConfigureSms(); s_wd_pend = true; }  // CNMI/CMGF are lost after CFUN/reset: re-arm the SMS ring
  }
  // Data check: bring up PDP only when a heartbeat is going out; a PDP failure gets one soft recovery.
  int sms = -1;
  if (ok && !lowbat && (s_wd_hb || s_wd_pend)) {
    if (!modemOpenData() && strcmp(stage, "ok") == 0 && millis() - t0 < WD_BUDGET_MS) {
      s_wd_soft++; stage = "soft";
      ok = wdSoft();
      wdAddEvent("soft-pdp", ok ? "ok" : "fail", (millis() - t0) / 1000);
      if (ok) { modemConfigureSms(); s_wd_pend = true; }
    }
    if (ok) {
      sms = wdSmsStored();
      if (s_lb_pending[0]) pwrReportPending();
      if (wdHeartbeat(stage, sms)) s_wd_pend = false;
    }
  }
  if (ok) { if (strcmp(stage, "ok") == 0) s_wd_ok++; s_wd_fails = 0; }
  else if (strcmp(stage, "lowbat") != 0) { s_wd_fail++; if (s_wd_fails < 255) s_wd_fails++; s_wd_pend = true; if (!hard_tried) wdAddEvent("check", "fail", (millis() - t0) / 1000); }
  wdSchedule(ok || strcmp(stage, "lowbat") == 0);
  // v1.7.2: recovery keeps failing -> restart the whole T-SIM (fresh boot path: full modem power-on, SIM and network
  // wait). Once every WD_RESTART_FAILS failures in a row, so a dead network can't cause a restart loop.
  if (!ok && strcmp(stage, "lowbat") != 0 && s_wd_fails >= WD_RESTART_FAILS && s_wd_fails % WD_RESTART_FAILS == 0) {
    s_wd_rst++; wdAddEvent("restart", "esp", (millis() - t0) / 1000); wdSave();
    logf("WD: %u failed recoveries in a row -> T-SIM restart (#%u)", (unsigned)s_wd_fails, (unsigned)s_wd_rst);
    Serial.flush(); delay(200);
    esp_restart();
  }
  wdSave();
  logf("WD: done stage=%s ok=%d in %lus, next check in %lld s", stage, (int)ok, (unsigned long)((millis() - t0) / 1000), (long long)(s_wd_due - rtcNow()));
  if (ok && s_wd_sms) processSmsInbox();   // optional (default off): run texts already stored on the modem
  // v1.7.2: fetch and run queued dashboard commands (console, system commands, TSIMUPDATE, queued Heltec UPDATE), so
  // they get through even when texts don't. One fetch per wake, no retry; skipped on low battery.
  if (ok && !lowbat && s_wd_cmd) {
    s_wd_cmdn++; wdSave();
    doConsoleCommands(false, true);
  }
  return ok;
}

// v1.7.4: after a detected Heltec reboot, wait (bounded) for the modem to be registered with data and deliver the
// heartbeat. If it still can't go out, the report stays pending in NVS and rides on the next successful post.
#define HRP_RETRY_MS 120000UL
static void hwReportRetry() {
  if (!s_hrp_n) return;
  uint32_t t0 = millis();
  while (s_hrp_n && millis() - t0 < HRP_RETRY_MS) {
    if (wdRegistered() && (s_pdp_up || modemOpenData()) && wdHeartbeat("ok", -1)) break;
    s_pdp_up = false; delay(5000);
  }
  logf(s_hrp_n ? "Heltec reboot report still pending (%u), sent with the next check-in" : "Heltec reboot report delivered", (unsigned)s_hrp_n);
}
// Accepted Heltec reboot (both paths): count, persist the pending report, then recover or (console) just report.
static void hwHandleReboot(const char *src, bool console);
static void hwHandleReboot(const char *src, bool console) {
  s_hw_n++; s_hw_dayn++; s_hw_last = rtcNow(); s_hw_spur = 0;
  if (!strcmp(src, "awake")) s_hw_aw++; else if (!strcmp(src, "uptime")) s_hw_up++;
  s_up_last_t = 0;   // v1.7.5: the next stats-core reading starts a new baseline
  wdAddEvent("heltec", console ? "console" : "reboot", 0);
  hrpAdd(console ? "console" : src); wdSave();
  gpio_hold_dis((gpio_num_t)MODEM_DTR_PIN);
  s_wd_reason = "heltec-reboot"; s_wd_src = console ? "console" : src;
  if (console) {
    logf("Heltec reboot detected (console) -> reported, modem recovery skipped");
    pinMode(MODEM_DTR_PIN, OUTPUT); digitalWrite(MODEM_DTR_PIN, LOW);
  } else {
    logf("Heltec reboot detected (%s, #%u, %u today) -> modem recovery", src, (unsigned)s_hw_n, (unsigned)s_hw_dayn);
    wdRun(true);
  }
  hwReportRetry();
  s_wd_reason = nullptr; s_wd_src = nullptr;
}
static bool s_hwa_busy = false;
static void hwAwakeService() {
  heltecMonPoll();
  tfService();   // v1.7.7: @TSIM frames that arrived while awake
  if (s_tf_fresh && !s_busy_update) {
    s_tf_fresh = false;
    if (!strcmp(s_tf_cmd, "STATUS")) doStatusReport();
    else if (!strcmp(s_tf_cmd, "MODEM_RESET")) { logf("tsim wake MODEM_RESET -> modem recovery"); wdRun(true); }
  }
  if (!s_hwa_flag || s_hwa_busy || s_busy_update) return;
  s_hwa_flag = false; s_hwa_busy = true;
  int64_t now = rtcNow();
  if (s_hw_day0 <= 0 || now < s_hw_day0 || now - s_hw_day0 >= 86400) { s_hw_day0 = now; s_hw_dayn = 0; }
  bool own = rtcOwnWindow(s_hw_own, now, HW_DEBOUNCE_S) || selfResetActive(s_hm.self, millis());   // v1.7.6
  bool console = rtcOwnWindow(s_hw_cons, now, HW_DEBOUNCE_S) || selfResetActive(s_cons, millis());
  if (console) s_cons.pending = false;
  const char *src = s_hwa_src; s_hwa_src = "awake";
  bool cold = !strcmp(src, "awake") && s_wake_cause == ESP_SLEEP_WAKEUP_UNDEFINED && millis() < 60000;   // both powered up together
  const char *why = (!s_hw_en && strcmp(src, "uptime")) ? "off (WDCFG hwake=0)" : cold ? "T-SIM cold start (both booted together)" : own ? "T-SIM reset the Heltec itself" :
                    (s_hw_last > 0 && now >= s_hw_last && now - s_hw_last < HW_DEBOUNCE_S) ? "within 60 s of the last one" :
                    s_hw_dayn >= HW_MAX_DAY ? "daily limit (6) reached" : nullptr;
  if (why) {
    if (own && !cold) { s_hm.self.pending = false; s_hw_self++; wdSave(); }   // v1.7.6
    else if (s_hw_en) { s_hw_ign++; wdSave(); }
    logf("Heltec reboot (%s, %s) ignored: %s", src, s_hwa_mark, why);
  } else {
    hwHandleReboot(src, console);
  }
  s_hwa_busy = false;
}

// v1.7.5 uptime poll on a timer wake. Serial only: the modem stays asleep unless a reboot is found.
// Returns 1 when a reboot was found and accepted (caller runs hwHandleReboot), 0 otherwise.
static int upPoll(uint32_t *up_out) {
  int64_t now = rtcNow();
  s_up_due = now + (int64_t)s_up_min * 60;
  float sol = readAdcVolts(BOARD_SOLAR_ADC_PIN, 2.0f);
  if (s_up_sol && sol * 1000.0f < (float)s_up_sol) { s_up_night++; wdSave(); logf("uptime poll: skipped, solar %.2f V < %.2f V (night)", sol, s_up_sol / 1000.0f); return 0; }
  if ((s_bat_idle >= 2.5f && s_bat_idle < WD_LOWBAT_V) || s_lb_state) { s_up_lowb++; wdSave(); logf("uptime poll: skipped, low battery %.2f V", s_bat_idle); return 0; }
  s_up_n++;
  heltecCliBegin();
  bool ok = heltecCli("stats-core", s_cli_out, sizeof(s_cli_out), 3000);
  uint32_t up = 0; bool got = ok && upParse(s_cli_out, &up);
  if (!got) {   // stock CLI answers at once; one retry in case the line was busy
    ok = heltecCli("stats-core", s_cli_out, sizeof(s_cli_out), 3000); got = ok && upParse(s_cli_out, &up);
  }
  heltecCliEnd();
  if (!got) { s_up_nr++; wdSave(); logf("uptime poll: no reply from the Heltec"); return 0; }
  bool rb = upCheck(up); *up_out = up;
  if (!rb) { wdSave(); return 0; }
  if (s_hw_day0 <= 0 || now < s_hw_day0 || now - s_hw_day0 >= 86400) { s_hw_day0 = now; s_hw_dayn = 0; }
  bool own = rtcOwnWindow(s_hw_own, now, HW_DEBOUNCE_S) || selfResetActive(s_hm.self, millis()) || selfResetActive(s_cons, millis());   // v1.7.6
  const char *why = own ? "T-SIM reset the Heltec itself" : (s_hw_last > 0 && now >= s_hw_last && now - s_hw_last < HW_DEBOUNCE_S) ? "within 60 s of the last one" :
                    s_hw_dayn >= HW_MAX_DAY ? "daily limit (6) reached" : nullptr;
  if (why) { if (own) s_hw_self++; else s_hw_ign++; wdSave(); logf("Heltec reboot (uptime) ignored: %s", why); return 0; }
  return 1;
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
  telemRefreshSignal();
  if (strcasecmp(s_cmdbuf, "STATUS") == 0) {
    doStatusReport();
    doConsoleCommands(true);   // v1.6.5: pick up queued system commands (e.g. PWRCFG) with no extra SMS
    if (s_gps_auto && !s_gps_done) { static char go[300]; gpsReport("auto", go, sizeof(go)); }  // v1.6.7 optional location on check-in
    meshSnapshot();
    cfgSnapshot();   // v1.7.0
    return true;
  }
  if (strcasecmp(s_cmdbuf, "CMD") == 0) {
    doConsoleCommands();
    meshSnapshot();
    cfgSnapshot();   // v1.7.0
    return true;
  }
  if (strcasecmp(s_cmdbuf, "REBOOT") == 0) {
    heltecReboot();
    { progressf("REBOOT", "arrows_counterclockwise", 3, "REBOOT done"); ingestEvent("reboot", "REBOOT done"); }
    doConsoleCommands(true);
    return true;
  }
  if (strncasecmp(s_cmdbuf, "TSIMUPDATE ", 11) == 0) {
    static char a[URL_MAX + 100]; strncpy(a, s_cmdbuf + 11, sizeof(a) - 1); a[sizeof(a) - 1] = 0;
    doTsimUpdate(a);
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
static char s_sms_stat[24];
static char s_sms_ts[32];
static int parseOneCmgl(const char **p_inout) {
  const char *p = strstr(*p_inout, "+CMGL:");
  if (!p) return -1;
  int index = -1;
  if (sscanf(p, "+CMGL: %d", &index) != 1) { *p_inout = p + 6; return -1; }
  const char *q = p; int quotes = 0;
  const char *fs = nullptr, *fe = nullptr, *ss = nullptr, *se = nullptr, *ts = nullptr, *te = nullptr;
  while (*q && *q != '\n' && quotes < 8) {
    if (*q == '"') { quotes++;
      if (quotes == 1) ss = q + 1; else if (quotes == 2) se = q;
      else if (quotes == 3) fs = q + 1; else if (quotes == 4) fe = q;
      else if (quotes == 7) ts = q + 1; else if (quotes == 8) te = q; }
    q++;
  }
  s_sms_stat[0] = 0; s_sms_ts[0] = 0;
  if (ss && se && se > ss) { size_t l = se - ss; if (l >= sizeof(s_sms_stat)) l = sizeof(s_sms_stat) - 1; memcpy(s_sms_stat, ss, l); s_sms_stat[l] = 0; }
  if (ts && te && te > ts) { size_t l = te - ts; if (l >= sizeof(s_sms_ts)) l = sizeof(s_sms_ts) - 1; memcpy(s_sms_ts, ts, l); s_sms_ts[l] = 0; }
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

// v1.6.6: SMS replay protection.
//  - each message is deleted from the modem BEFORE its command runs (an update reboot can no longer leave it stored)
//  - in the read-all fallback, already-read (REC READ) messages are discarded, never executed
//  (No time-based dedupe: a legitimate Retry of the same command always runs.)
static bool looksLikeCommand(const char *body) {
  static char n[1024]; strncpy(n, body, sizeof(n) - 1); n[sizeof(n) - 1] = 0; normalizeSmsBody(n);
  size_t l = strlen(n); if (l >= 4 && strcasecmp(n + l - 4, " ACK") == 0) { n[l - 4] = 0; normalizeSmsBody(n); }
  return !strcasecmp(n, "STATUS") || !strcasecmp(n, "CMD") || !strcasecmp(n, "REBOOT") ||
         !strncasecmp(n, "UPDATE ", 7) || !strncasecmp(n, "TSIMUPDATE ", 11);
}

static void processSmsInbox() {
  // Read with UCS2 so every char ('_', '@', '$', ...) arrives as unambiguous hex.
  modemAT("AT+CSCS=\"UCS2\"");
  bool all_mode = false;
  if (!modemAT("AT+CMGL=\"REC UNREAD\"", 15000) || !strstr(s_at_resp, "+CMGL:")) {
    modemAT("AT+CMGL=\"ALL\"", 15000); all_mode = true;
  }
  static char inbox[8192];
  strncpy(inbox, s_at_resp, sizeof(inbox) - 1); inbox[sizeof(inbox) - 1] = 0;
  modemAT("AT+CSCS=\"GSM\"");  // restore default charset
  // Pass 1: collect messages (and GSM re-reads) while they still exist on the modem.
  struct Msg { int idx; bool stale; char ts[32]; char from[160]; char body[1024]; };
  static Msg msgs[10];
  const char *cursor = inbox;
  int count = 0;
  while (count < 10) {
    int idx = parseOneCmgl(&cursor);
    if (idx < 0) break;
    Msg &m = msgs[count++];
    m.idx = idx;
    m.stale = all_mode && strstr(s_sms_stat, "READ") && !strstr(s_sms_stat, "UNREAD");
    strncpy(m.ts, s_sms_ts, sizeof(m.ts) - 1); m.ts[sizeof(m.ts) - 1] = 0;
    strncpy(m.from, s_sms_from, sizeof(m.from) - 1); m.from[sizeof(m.from) - 1] = 0;
    strncpy(m.body, s_sms_body, sizeof(m.body) - 1); m.body[sizeof(m.body) - 1] = 0;
    logf("SMS[%d] stat=%s ts=%s from=%s body='%.200s'", idx, s_sms_stat, s_sms_ts, m.from, m.body);
    if (!m.stale && !looksLikeCommand(m.body)) {
      // v1.5.1: some texts come back from UCS2 CMGL as short/odd hex (e.g. "005300" for STATUS).
      // Re-read this one message in GSM charset (before it is deleted).
      snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+CMGR=%d", idx);
      if (modemAT(s_cmdbuf, 5000)) {
        const char *h = strstr(s_at_resp, "+CMGR:");
        const char *nl = h ? strchr(h, '\n') : nullptr;
        if (nl) {
          const char *bs = nl + 1; if (*bs == '\r') bs++;
          const char *be = strstr(bs, "\r\nOK"); if (!be) be = strstr(bs, "\nOK"); if (!be) be = bs + strlen(bs);
          size_t bl = (size_t)(be - bs); if (bl >= sizeof(m.body)) bl = sizeof(m.body) - 1;
          memcpy(m.body, bs, bl); m.body[bl] = 0; trimInPlace(m.body);
          logf("SMS[%d] GSM re-read body='%.200s'", idx, m.body);
        }
      }
    }
  }
  // Pass 2: delete every collected message first, so nothing can be replayed after a reboot.
  for (int i = 0; i < count; i++) {
    snprintf(s_cmdbuf, sizeof(s_cmdbuf), "AT+CMGD=%d", msgs[i].idx);
    modemAT(s_cmdbuf, 5000);
  }
  // Pass 3: execute. v1.7.6: identical STATUS / CMD texts in one pass run once (all were deleted in pass 2).
  static char norm[10][16]; const char *seen[10]; int nseen = 0, merged = 0;
  for (int i = 0; i < count; i++) {
    Msg &m = msgs[i];
    if (m.stale) { logf("SMS[%d] ignored: already read (stale)", m.idx); continue; }
    char *n = norm[nseen]; strncpy(n, m.body, sizeof(norm[0]) - 1); n[sizeof(norm[0]) - 1] = 0;
    if (strlen(m.body) < sizeof(norm[0])) {
      normalizeSmsBody(n);
      size_t l = strlen(n); if (l >= 4 && strcasecmp(n + l - 4, " ACK") == 0) { n[l - 4] = 0; normalizeSmsBody(n); }
    } else n[0] = 0;   // long bodies (UPDATE ...) are never merged
    if (smsIsDup(seen, nseen, n)) { merged++; logf("SMS[%d] merged: same %s already ran this pass", m.idx, n); continue; }
    if (smsMergeable(n)) seen[nseen++] = n;
    handleCommand(m.from, m.body);
  }
  if (merged) { char em[64]; snprintf(em, sizeof(em), "Merged %d duplicate text(s) (ran once)", merged); ingestEvent("event", em); }
  logf("SMS processed: %d", count);
}

// v1.7.1: one timer for every reason to wake (battery check, GNSS warm window end, modem watchdog). 0 = none.
static uint64_t sleepTimerSecs() {
  if (s_ext0_failed) return 60;
  int64_t best = -1;
  auto take = [&](int64_t secs) { if (secs < 5) secs = 5; if (best < 0 || secs < best) best = secs; };
  if (s_lb_en) take((int64_t)s_lb_int_min * 60);
  if (s_gnss_on) take(s_gnss_off_at - rtcNow());
  if (s_wd_int_min) { if (s_wd_due <= 0) wdSchedule(true); take(s_wd_due - rtcNow()); }
  if (s_up_min) { if (s_up_due <= 0) s_up_due = rtcNow() + (int64_t)s_up_min * 60; take(s_up_due - rtcNow()); }   // v1.7.5
  if (best < 0 || best > (int64_t)WD_MAX_MIN * 60) best = (int64_t)WD_MAX_MIN * 60;   // v1.7.2: there is ALWAYS a timer (<= 24 h)
  return (uint64_t)best;
}
// v1.7.3: arm the optional Heltec-reboot wake (GPIO6, ext1 any-low; ext0 stays on the modem RI pin). Not armed when it's
// off (WDCFG hwake=0, or auto-off after spurious wakes) or when GPIO6 isn't steadily high right before sleep (wire missing
// and floating low, or the Heltec still printing): that sleep then has only the SMS + timer wakes, so it can't storm.
static const char *hwArmInner();
static const char *hwArm() {
  const char *r = hwArmInner();
  s_hw_armres = !strcmp(r, "off") ? 0 : !strcmp(r, "auto-off") ? 1 : !strncmp(r, "SKIPPED", 7) ? 2 : !strcmp(r, "FAILED") ? 3 : 4;
  return r;
}
static const char *hwArmInner() {
  if (!s_hw_en) return "off";
  if (s_hw_auto) return "auto-off";
  pinMode(HELTEC_HWAKE_PIN, INPUT_PULLUP);   // internal ~45k pull-up (an external one is optional); unconnected reads high
  uint32_t t = millis(); int highs = 0;
  while (millis() - t < 1500) { if (digitalRead(HELTEC_HWAKE_PIN)) { if (++highs >= 25) break; } else highs = 0; delay(2); }
  if (highs < 25) {
    s_hw_skip++; { Preferences p; p.begin("tsimwd", false); p.putUInt("hws", s_hw_skip); p.end(); }
    return "SKIPPED (GPIO6 low)";
  }
  if (esp_sleep_enable_ext1_wakeup(1ULL << HELTEC_HWAKE_PIN, ESP_EXT1_WAKEUP_ANY_LOW) != ESP_OK) return "FAILED";
  // Keep the pull-up in deep sleep: RTC pad pull-up (needs the RTC peripheral domain powered; ext0 needs it too).
  rtc_gpio_init((gpio_num_t)HELTEC_HWAKE_PIN);
  rtc_gpio_set_direction((gpio_num_t)HELTEC_HWAKE_PIN, RTC_GPIO_MODE_INPUT_ONLY);
  rtc_gpio_pulldown_dis((gpio_num_t)HELTEC_HWAKE_PIN);
  rtc_gpio_pullup_en((gpio_num_t)HELTEC_HWAKE_PIN);
  esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);
  return "armed";
}
static void armWakeups() {
  s_ext0_failed = esp_sleep_enable_ext0_wakeup((gpio_num_t)MODEM_RI_PIN, 0) != ESP_OK;
  const char *hw = hwArm();
  uint64_t secs = sleepTimerSecs();
  if (!secs) secs = (uint64_t)WD_MAX_MIN * 60;
  esp_sleep_enable_timer_wakeup(secs * 1000000ULL);
  deadlineStopForSleep();
  logf("sleep: SMS ring wake %s, Heltec wake %s, timer %llus (battery %s, GNSS %s, watchdog %s)", s_ext0_failed ? "FAILED" : "armed", hw,
       (unsigned long long)secs, s_lb_en ? "on" : "off", s_gnss_on ? "warm" : "off", s_wd_int_min ? "on" : "off");
}

// Timer-wake path: the modem was never woken, so skip AT+CSCLK; just re-arm wakeups and sleep.
static void sleepQuick() {
  heltecMonStop();
  g6DiagStop();
  heltecPinsRelease();
  pinMode(MODEM_RI_PIN, INPUT);
  gpio_hold_en((gpio_num_t)MODEM_DTR_PIN);
  gpio_deep_sleep_hold_en();
  armWakeups();
  Serial.flush(); delay(50);
  esp_deep_sleep_start();
}

static void goToSleep() {
  if (s_busy_update) { logf("sleep deferred — UPDATE running"); return; }
  hwAwakeService();   // v1.7.4: a Heltec reboot seen during this wake is handled before sleeping
  heltecMonStop();
  g6DiagStop();
  gpsHousekeep();
  rollbackIfPending("no successful ingest before sleep");
  logf("Deep sleep; RI GPIO%d LOW", MODEM_RI_PIN);
  heltecPinsRelease();
  modemEnableSleep();
  pinMode(MODEM_RI_PIN, INPUT);
  gpio_hold_en((gpio_num_t)MODEM_DTR_PIN);
  gpio_deep_sleep_hold_en();
  armWakeups();   // v1.7.1: SMS ring + one timer (battery check / GNSS warm window end / modem watchdog)
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
  if (strcasecmp(line, "WDCHECK") == 0) { wdRun(); return; }   // v1.7.1 run one watchdog check now (bench test)
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
  if (strncasecmp(line, "TSIMUPDATE ", 11) == 0) { handleCommand("USB", line); return; }
  if (strncasecmp(line, "AT", 2) == 0) {
    const char *cmd = line;
    if (line[2] == ' ') { cmd = line + 3; while (*cmd && isspace((unsigned char)*cmd)) cmd++; }
    modemAT(cmd, 15000); return;
  }
  logf("USB: AT|REBOOT|UPDATE|TSIMUPDATE|TESTDL|STATUS|MESH|CMD|CLI <cmd>|WDCHECK|LASTLOG|SLEEP|STAY");
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
          deadline = millis() + window_ms; next_countdown = millis(); deadlineArm(AWAKE_MAX_S);
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
    hwAwakeService();   // v1.7.4
    delay(20);
  }
}

void setup() {
  deadlineArm(AWAKE_MAX_S);   // v1.7.2: first thing, so nothing after this can keep the T-SIM awake forever
  Serial.begin(115200);
  delay(800);
  s_wake_cause = esp_sleep_get_wakeup_cause();
  bool fast = (s_wake_cause == ESP_SLEEP_WAKEUP_EXT0) || (s_wake_cause == ESP_SLEEP_WAKEUP_TIMER);
  logf("=== %s ===", FW_VERSION);
  logf("Built: %s", FW_BUILD_DATE);
  logf("Wake: %d%s", (int)s_wake_cause, fast ? " (fast)" : " (cold/RST)");
  loadConfig();
  logf("ingest: %s", g_ingest_url);
  { const esp_partition_t *r = esp_ota_get_running_partition(); logf("app partition: %s%s", r ? r->label : "?", otaPendingVerify() ? " (OTA pending verify)" : ""); }
  logf("heap: %u", (unsigned)ESP.getFreeHeap());
  analogReadResolution(12);
  // LilyGO ReadBattery example: 11 dB attenuation, GPIO4 = VBAT/2, GPIO5 = solar/2 (both ADC1).
  // Per LilyGO, the battery reads 0 V on T-SIM7670G/7672G while USB is plugged in.
  analogSetPinAttenuation(BOARD_BAT_ADC_PIN, ADC_11db);
  analogSetPinAttenuation(BOARD_SOLAR_ADC_PIN, ADC_11db);
  pwrLoad();
  gpsLoad(); csLoad(); wdLoad();
  pwrReadIdle();   // v1.6.5: idle battery, before the modem is touched
  // v1.7.1 watchdog timer wake. The RTC clock drifts, so a wake up to 10% early still counts; with battery checks off
  // the watchdog is the only timer left (GNSS warm-window wakes and OTA verification keep the full boot path).
  // v1.7.3 Heltec-reboot wake (GPIO6 went low: the Heltec printed its boot log).
  if (s_wake_cause == ESP_SLEEP_WAKEUP_EXT1 && (esp_sleep_get_ext1_wakeup_status() & (1ULL << HELTEC_HWAKE_PIN))) {
    gpio_deep_sleep_hold_dis();          // DTR keeps its own pad hold until we know the modem gets touched
    heltecPinsRelease();
    pinMode(HELTEC_HWAKE_PIN, INPUT_PULLUP);   // also releases the RTC pad config from sleep
    int64_t now = rtcNow();
    bool stuck = true; uint32_t t = millis();
    while (millis() - t < HW_STUCK_MS) { if (digitalRead(HELTEC_HWAKE_PIN)) { stuck = false; break; } delay(5); }
    if (stuck) {
      s_hw_ign++;
      if (++s_hw_spur >= HW_SPUR_MAX) { s_hw_auto = true; wdAddEvent("hwake", "auto-off", 0); logf("Heltec wake: %u spurious wakes in a row -> turned off (WDCFG hwake=1 re-enables)", (unsigned)s_hw_spur); }
      wdSave();
      logf("Heltec wake ignored: GPIO6 stuck low (ignored %u)", (unsigned)s_hw_ign);
      sleepQuick(); return;
    }
    // v1.7.7: tsim wake pulses this pin too. Listen before calling it a Heltec reboot.
    logf("GPIO6 wake: listening 9s for @TSIM");
    if (tfListen(9000)) {
      s_tf_fresh = false;
      s_hwa_flag = false;   // UART chatter from the pulses is not a second reboot
      if (!strcmp(s_tf_cmd, "WAKE")) { logf("tsim wake WAKE: ACK sent, modem left asleep"); sleepQuick(); return; }
      if (!strcmp(s_tf_cmd, "MODEM_RESET")) {
        if (!LittleFS.begin(true)) logf("LittleFS mount failed");
        gpio_hold_dis((gpio_num_t)MODEM_DTR_PIN);
        logf("tsim wake MODEM_RESET -> modem recovery");
        wdRun(true);
        goToSleep(); return;
      }
      logf("tsim wake STATUS: booting the modem for a status report");
      s_tf_status_boot = true;
    } else {
      heltecMonStop();
      if (s_hw_day0 <= 0 || now < s_hw_day0 || now - s_hw_day0 >= 86400) { s_hw_day0 = now; s_hw_dayn = 0; }
      bool own = rtcOwnWindow(s_hw_own, now, HW_DEBOUNCE_S);   // v1.7.6: tolerant of a clock that stepped back
      const char *why = own ? "T-SIM reset the Heltec itself" :
                        (s_hw_last > 0 && now >= s_hw_last && now - s_hw_last < HW_DEBOUNCE_S) ? "within 60 s of the last one" :
                        s_hw_dayn >= HW_MAX_DAY ? "daily limit (6) reached" : nullptr;
      if (why) {
        if (own) s_hw_self++; else s_hw_ign++;
        if (!own && ++s_hw_spur >= HW_SPUR_MAX) { s_hw_auto = true; wdAddEvent("hwake", "auto-off", 0); logf("Heltec wake: %u spurious wakes in a row -> turned off (WDCFG hwake=1 re-enables)", (unsigned)s_hw_spur); }
        wdSave();
        logf("Heltec wake ignored: %s (ignored %u)", why, (unsigned)s_hw_ign);
        sleepQuick(); return;
      }
      if (!LittleFS.begin(true)) logf("LittleFS mount failed");
      hwHandleReboot("wake", false);   // no @TSIM frame: still a Heltec reboot
      goToSleep(); return;
    }
  }
  bool wd_wake = false;
  if (s_wake_cause == ESP_SLEEP_WAKEUP_TIMER && s_wd_int_min && !s_gnss_on && !s_ext0_failed && !otaPendingVerify()) {
    int64_t tol = (int64_t)s_wd_int_min * 6; if (tol < 60) tol = 60;
    wd_wake = !s_lb_en || s_wd_due <= 0 || rtcNow() >= s_wd_due - tol;
  }
  if (wd_wake) {
    logf("Watchdog wake (every %u min)", (unsigned)s_wd_int_min);
    gpio_deep_sleep_hold_dis();
    gpio_hold_dis((gpio_num_t)MODEM_DTR_PIN);
    heltecPinsRelease();
    heltecMonStart();   // v1.7.4 awake reboot detection
    if (!LittleFS.begin(true)) logf("LittleFS mount failed");
    if (s_lb_en) pwrCheck("timer");   // battery check due at the same time: no extra wake
    uint32_t up = 0;
    if (s_up_min && upPoll(&up) == 1) { hwHandleReboot("uptime", false); s_up_last = up; s_up_last_t = rtcNow(); }   // v1.7.5
    else wdRun();
    goToSleep(); return;
  }
  // v1.7.5 uptime-poll timer wake: serial only, the modem stays asleep (DTR held) unless a reboot is found.
  if (s_wake_cause == ESP_SLEEP_WAKEUP_TIMER && s_up_min && !s_gnss_on && !s_ext0_failed && !otaPendingVerify()) {
    int64_t tol = (int64_t)s_up_min * 6; if (tol < 60) tol = 60;
    if (s_up_due <= 0 || rtcNow() >= s_up_due - tol) {
      gpio_deep_sleep_hold_dis();          // release Heltec UART/RST/BOOT pads; DTR keeps its own pad hold
      heltecPinsRelease();
      logf("Uptime poll wake (every %u min)", (unsigned)s_up_min);
      uint32_t up = 0;
      if (upPoll(&up) == 1) {
        if (!LittleFS.begin(true)) logf("LittleFS mount failed");
        hwHandleReboot("uptime", false);
        s_up_last = up; s_up_last_t = rtcNow();
        goToSleep(); return;
      }
      if (!s_lb_en) { sleepQuick(); return; }
    }
  }
  // v1.6.5 battery-check timer wake: modem stays asleep (DTR stays held), no LTE.
  if (s_wake_cause == ESP_SLEEP_WAKEUP_TIMER && s_lb_en && !s_gnss_on && !s_ext0_failed && !otaPendingVerify()) {
    gpio_deep_sleep_hold_dis();          // release Heltec UART/RST/BOOT pads; DTR keeps its own pad hold
    heltecPinsRelease();
    bool changed = pwrCheck("timer");
    if (!(changed && s_lb_imm)) { logf(s_lb_pending[0] ? "battery check: change saved, reported at next wake" : "battery check: no change"); sleepQuick(); return; }
    logf("battery change - reporting now (immediate report on)");
  }
  gpio_deep_sleep_hold_dis();
  gpio_hold_dis((gpio_num_t)MODEM_DTR_PIN);
  heltecPinsRelease();
  heltecMonStart();   // v1.7.4 awake reboot detection
  if (!LittleFS.begin(true)) logf("LittleFS mount failed");
  else {
    logf("LittleFS OK total=%u used=%u", (unsigned)LittleFS.totalBytes(), (unsigned)LittleFS.usedBytes());
    loadLastResult();
    printLastLog();
  }
  if (!modemPowerOn()) {
    if (s_tf_status_boot) { logf("tsim wake STATUS: modem did not start"); goToSleep(); return; }
    if (!fast) interactiveWindow(AWAKE_WINDOW_MS);
    goToSleep(); return;
  }
  modemAT("ATE0"); modemAT("AT+CMEE=2");
  gpsHousekeep();   // v1.6.8: GNSS warm window / battery protection
  bool sim = modemWaitCpinReady(20000);
  modemLogDiagnostics();
  if (sim) {
    if (modemWaitNetwork(fast ? 30000 : 60000)) { s_wd_fails = 0; wdSchedule(true); }  // v1.7.1 a good wake restarts the watchdog interval
    modemConfigureSms();
    if (otaPendingVerify()) ingestEvent("event", "T-SIM booted new firmware after OTA, checking in");  // success marks it valid
    if (s_wake_cause != ESP_SLEEP_WAKEUP_TIMER || !s_lb_en) pwrCheck("wake");
    pwrReportPending();
    if (s_hrp_n) wdHeartbeat("ok", -1);   // v1.7.4: deliver an earlier Heltec-reboot report that couldn't go out
    processSmsInbox();
    if (s_tf_status_boot) doStatusReport();
  } else if (s_tf_status_boot) logf("tsim wake STATUS: no SIM, report skipped");
  if (s_tf_status_boot) { goToSleep(); return; }
  if (fast && !s_busy_update) { goToSleep(); return; }
  interactiveWindow(AWAKE_WINDOW_MS);
  goToSleep();
}

void loop() { delay(1000); goToSleep(); }
