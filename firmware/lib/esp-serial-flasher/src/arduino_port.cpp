#include "arduino_port.h"
#include "esp_loader_io.h"
#include <Arduino.h>

static HardwareSerial *s_uart = nullptr;
static int s_reset_pin = -1;
static int s_boot_pin = -1;
static uint32_t s_time_end = 0;

extern "C" {

void loader_port_arduino_init(loader_arduino_config_t *config)
{
    s_uart = config->uart;
    s_reset_pin = config->reset_pin;
    s_boot_pin = config->boot_pin;

    pinMode(s_reset_pin, OUTPUT);
    digitalWrite(s_reset_pin, HIGH);
    pinMode(s_boot_pin, OUTPUT);
    digitalWrite(s_boot_pin, HIGH);

    s_uart->begin(115200, SERIAL_8N1, config->uart_rx_pin, config->uart_tx_pin);
    s_uart->setTimeout(100);
}

void loader_port_arduino_deinit(void)
{
    if (s_uart) {
        s_uart->end();
    }
    if (s_reset_pin >= 0) {
        pinMode(s_reset_pin, INPUT);
    }
    if (s_boot_pin >= 0) {
        pinMode(s_boot_pin, INPUT);
    }
    s_uart = nullptr;
}

esp_loader_error_t loader_port_write(const uint8_t *data, uint16_t size, uint32_t timeout)
{
    if (!s_uart) return ESP_LOADER_ERROR_FAIL;
    s_uart->setTimeout(timeout);
    size_t written = s_uart->write(data, size);
    s_uart->flush();
    return (written == size) ? ESP_LOADER_SUCCESS : ESP_LOADER_ERROR_TIMEOUT;
}

esp_loader_error_t loader_port_read(uint8_t *data, uint16_t size, uint32_t timeout)
{
    if (!s_uart) return ESP_LOADER_ERROR_FAIL;
    s_uart->setTimeout(timeout);
    size_t got = s_uart->readBytes((char *)data, size);
    return (got == size) ? ESP_LOADER_SUCCESS : ESP_LOADER_ERROR_TIMEOUT;
}

void loader_port_delay_ms(uint32_t ms)
{
    delay(ms);
}

void loader_port_start_timer(uint32_t ms)
{
    s_time_end = millis() + ms;
}

uint32_t loader_port_remaining_time(void)
{
    int32_t remaining = (int32_t)(s_time_end - millis());
    return (remaining > 0) ? (uint32_t)remaining : 0;
}

void loader_port_enter_bootloader(void)
{
    digitalWrite(s_boot_pin, LOW);
    delay(10);
    digitalWrite(s_reset_pin, LOW);
    delay(SERIAL_FLASHER_RESET_HOLD_TIME_MS);
    digitalWrite(s_reset_pin, HIGH);
    delay(SERIAL_FLASHER_BOOT_HOLD_TIME_MS);
    digitalWrite(s_boot_pin, HIGH);
}

void loader_port_reset_target(void)
{
    digitalWrite(s_reset_pin, LOW);
    delay(SERIAL_FLASHER_RESET_HOLD_TIME_MS);
    digitalWrite(s_reset_pin, HIGH);
}

void loader_port_debug_print(const char *str)
{
    Serial.print("[flasher] ");
    Serial.println(str);
}

esp_loader_error_t loader_port_change_transmission_rate(uint32_t transmission_rate)
{
    if (!s_uart) return ESP_LOADER_ERROR_FAIL;
    // HardwareSerial::updateBaudRate exists on ESP32 Arduino
    s_uart->updateBaudRate(transmission_rate);
    return ESP_LOADER_SUCCESS;
}

} // extern "C"
