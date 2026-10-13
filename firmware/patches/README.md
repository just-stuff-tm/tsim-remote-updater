# Library patches

## ESP_SSLClient 3.1.3 (`SSLClient.h`, `TCPClient.h`)
Applied automatically by `apply_patches.py` (PlatformIO `extra_scripts = pre:`),
which copies these files over `.pio/libdeps/<env>/ESP_SSLClient/src/client/`.
`SSLClient.h.diff` shows the change against upstream. The patches expose the
last BearSSL error / stop line for diagnostics and let the TCP layer read the
SIM767x socket without dropping buffered bytes. If the first build says the
library is not installed yet, run the build a second time.

## esp-serial-flasher (vendored in `lib/esp-serial-flasher`)
Espressif's esp-serial-flasher, vendored with an Arduino UART port
(`arduino_port.h`) for flashing the Heltec V3 (ESP32-S3) over UART from the T-SIM.
