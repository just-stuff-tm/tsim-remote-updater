# AGENTS.md

AI agents building or deploying this project: read [docs/FOR-AI-AGENTS.md](docs/FOR-AI-AGENTS.md) first. Never commit `firmware/include/config.h` or any secret.

- Worker tests: `cd worker && npm install && npm test`
- Firmware build: `cd firmware && pio run` (uses `config.example.h` if `config.h` is missing)

## Repeater boards
- Remote flash only for ESP32-family targets (ESP32, S2, S3, C3, C6). The T-SIM detects the chip via `esp_loader_get_target()` and refuses unknown chips. nRF52 targets (UF2/DFU) cannot be flashed, only rebooted, status-checked and given console commands.
- Ask the human for the exact board, and set the Worker update source `asset_pattern`/`direct_url` to that board's **app-only** file (written at 0x10000). Merged images go to 0x0 (or 0x1000 for classic-ESP32 images that start with the bootloader).
- Controller must be a LilyGO T-SIM7670G/7672G.
