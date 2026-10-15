#pragma once
// Board pins and constants. Per-user settings live in include/config.h
// (copy include/config.example.h -> include/config.h; config.h is gitignored).
#if __has_include("../include/config.h")
#include "../include/config.h"
#endif
#ifndef WORKER_URL  // no include/config.h: fall back to placeholders so CI / fresh clones build
#warning "include/config.h not found - building with config.example.h placeholders"
#include "../include/config.example.h"
#endif
#ifndef WORKER_URL
#error "Set WORKER_URL in include/config.h"
#endif
#define INGEST_URL          WORKER_URL "/ingest/" DEVICE_ID

#define FW_VERSION          "tsim-updater 1.6.5"
#define FW_BUILD_DATE       __DATE__ " " __TIME__

// LilyGO T-SIM7670G-S3 / T-SIM7672G V1.1 modem pins
#define MODEM_TX_PIN        11
#define MODEM_RX_PIN        10
#define MODEM_PWRKEY_PIN    18
#define MODEM_RESET_PIN     17
#define MODEM_RESET_LEVEL   LOW
#define MODEM_RI_PIN        3
#define MODEM_DTR_PIN       9
#define BOARD_BAT_ADC_PIN   4   // VBAT via 1:2 divider (LilyGO utilities.h, LILYGO_T_SIM7670G_S3); 0 V while USB powered
#define BOARD_SOLAR_ADC_PIN 5   // solar input via 1:2 divider

#define MODEM_BAUD          115200
#define MODEM_PWR_PULSE_MS  100

// Heltec V3 control (from T-SIM)
#define HELTEC_RST_PIN      1
#define HELTEC_BOOT_PIN     2
#define HELTEC_UART_TX_PIN  42
#define HELTEC_UART_RX_PIN  41




#define FW_PATH             "/fw.bin"
#define LAST_UPDATE_PATH    "/last_update.txt"
#define FLASH_BLOCK_SIZE    1024
#define HTTP_CHUNK          1460
#define URL_MAX             2048
#define AT_CMD_MAX          2200
#define LOG_RING_LINES      40
#define LOG_LINE_MAX        180
#define HTTP_MAX_REDIRECTS  5
#define AWAKE_WINDOW_MS     120000UL
