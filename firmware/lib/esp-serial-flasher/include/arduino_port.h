#pragma once
#include <stdint.h>
#include <HardwareSerial.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    HardwareSerial *uart;
    int reset_pin;
    int boot_pin;
    int uart_tx_pin;
    int uart_rx_pin;
} loader_arduino_config_t;

void loader_port_arduino_init(loader_arduino_config_t *config);
void loader_port_arduino_deinit(void);

#ifdef __cplusplus
}
#endif
