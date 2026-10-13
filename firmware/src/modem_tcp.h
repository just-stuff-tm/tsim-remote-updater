#pragma once
#include <Arduino.h>
#include <Client.h>

// Raw TCP socket over SIM767x/A76xx AT commands (NETOPEN/CIPOPEN/CIPSEND/CIPRXGET mode 2).
// Modem's own SSL is NOT used; TLS is done on the ESP32 by ESP_SSLClient on top of this.
class ModemTcpClient : public Client {
 public:
  ModemTcpClient(HardwareSerial &s, uint8_t mux = 0) : _s(s), _mux(mux) {}

  static bool netOpen(HardwareSerial &s);   // tolerant: already-open is OK
  static void netClose(HardwareSerial &s);  // best-effort

  int connect(IPAddress ip, uint16_t port) override;
  int connect(const char *host, uint16_t port) override;
  size_t write(uint8_t b) override { return write(&b, 1); }
  size_t write(const uint8_t *buf, size_t size) override;
  int available() override;
  int read() override;
  int read(uint8_t *buf, size_t size) override;
  int peek() override;
  void flush() override {}
  void stop() override;
  uint8_t connected() override;
  operator bool() override { return connected(); }
  // Bytes still buffered in modem for this mux (AT+CIPRXGET=4). -1 on query fail.
  int queryRxRemaining();
  bool remoteClosed() const { return _remote_closed; }
  int closeReason() const { return _close_reason; }
  uint32_t rawTotal() const { return _raw_total; }
  int restLen() const { return _rest_len; }
  uint32_t rxErrors() const { return _rx_errors; }
  uint32_t staleOk() const { return _stale_ok; }
  uint32_t msSincePoll() const { return millis() - _last_poll; }

 private:
  bool waitFor(const char *a, const char *b, uint32_t timeout, String *acc = nullptr);
  int pollModem(size_t want);
  void noteClose(const String &line);
  HardwareSerial &_s;
  uint8_t _mux;
  bool _connected = false;
  bool _remote_closed = false;
  uint8_t _rx[1500];
  size_t _rx_len = 0, _rx_pos = 0;
  uint32_t _last_poll = 0;
  int _rest_len = 0;
  uint32_t _stale_ok = 0;
  int _close_reason = -1;
  uint8_t _last_conn = 0;
  uint32_t _raw_total = 0, _next_dbg = 16384, _rx_errors = 0;
};
