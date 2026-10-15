# AGENTS.md

AI agents building or deploying this project: read [docs/FOR-AI-AGENTS.md](docs/FOR-AI-AGENTS.md) first. Never commit `firmware/include/config.h` or any secret.

- Worker tests: `cd worker && npm install && npm test`
- Firmware build: `cd firmware && pio run` (uses `config.example.h` if `config.h` is missing)

## Wiring (hardware, ask the human to do it)
- Recommended: Heltec powered directly from the same 1S Li-ion battery via its JST battery connector (+ and −); **no 3V3 link** between T-SIM and Heltec; shared GND plus TX/RX/RST/BOOT. The T-SIM does the solar charging.
- Warn the human: verify the JST polarity with a meter (1.25 mm pitch, not standardized); never plug USB into the Heltec while battery-wired (its charger would charge the cell); fuse on battery +; optional 10 µF + 100 nF ceramics on each board's 3V3/GND and 1 kΩ series resistors on the serial lines.
- The T-SIM can reset the Heltec but cannot power-cycle it. Benefit: the repeater reports the true battery voltage over the mesh.

## Repeater boards
- Remote flash only for ESP32-family targets (ESP32, S2, S3, C3, C6). The T-SIM detects the chip via `esp_loader_get_target()` and refuses unknown chips. nRF52 targets (UF2/DFU) cannot be flashed, only rebooted, status-checked and given console commands.
- Ask the human for the exact board, and set the Worker update source `asset_pattern`/`direct_url` to that board's **app-only** file (written at 0x10000). Merged images go to 0x0 (or 0x1000 for classic-ESP32 images that start with the bootloader).
- Controller must be a LilyGO T-SIM7670G/7672G.
