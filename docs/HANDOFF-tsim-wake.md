# Handoff for the LTE Meshcore bot — tsim wake (2026-10-27)

You were unavailable. This session continued your `tsim wake` work. Read this before doing anything else on it.

## What the user decided
- Write the T-SIM `@TSIM` handler locally. Do not push it, do not release it, do not flash it.
- Publish MeshCore-TSim-Powersaving and mark it Latest.
- Leave this handoff so you can take the work back.

## T-SIM handler (done locally, not on the device)
- Repo on the box: `/workspace/tsim-v172`, branch `tsim-wake-frames`, commit `826ba57`.
- Not pushed. `main` / the dashboard are still v1.7.6 (`fa87629`).
- Firmware version string: `tsim-updater 1.7.7`.
- Host tests passed (`firmware/test/host_test.cpp`). `pio run -e tsim7672g` succeeded (flash 654645 bytes). Log: `/workspace/tsim-v172-logs/build177.log`.
- Nothing was texted, queued, or flashed. Do not OTA this until the user says so, and not before the GPIO6 wire is fixed.

### What v1.7.7 does
The repeater already sends `@TSIM <CMD> <seq>` and waits for `@TSIM ACK <seq>`.
- GPIO6 wake listens 9 seconds. A frame is handled. No frame still means a Heltec reboot (v1.7.3–1.7.6 path).
- Allowlist: `WAKE` (ACK, modem stays asleep), `STATUS` (ACK, then a status report), `MODEM_RESET` (ACK, then a forced watchdog recovery). Anything else is logged and not ACKed.
- The same seq is ACKed again and not run twice. An echoed `@TSIM ACK` is ignored.
- The same handler runs for a frame that arrives while the T-SIM is already awake.
- Parser: `firmware/src/tsim_frame.h`. Notes: `release-notes/v1.7.7.md`.

## Repeater release
- `tsim wake` is already on `just-stuff-tm/MeshCore-TSim-Powersaving` branch `tsim`.
- Doc fix after the build started: `52e895b4` removes the dead `design/tsim-wake-frames` link. The release run below is the parent commit `f94f48d7`.
- A workflow_dispatch was already running when this session tried to start one. This token cannot dispatch Actions (HTTP 403). Run: https://github.com/just-stuff-tm/MeshCore-TSim-Powersaving/actions/runs/40619447623
- The daily schedule in `easyskymesh-sync.yml` is still commented out. The user approved this publish. They did not ask to turn the daily schedule on.
- Do not flash the Heltec from this release unless the user says so. v1.7.6 on the T-SIM treats a working GPIO6 wake as a Heltec reboot.

## Still on the user
- The installed tree-node wire shows 0 GPIO6 pulses. `tsim wake` cannot reach that T-SIM until the wire is fixed on site (Heltec GPIO43 TX, cathode of a 1N5817 toward the Heltec, anode to T-SIM GPIO6, 100 nF from GPIO6 to GND).
- The dashboard password was pasted in chat on Oct 20. Remind them to rotate it. Do not repeat it.
- Duplicate queued adverts or commands were never listed. Read the queue only. Do not clear it and do not text the device unless they say so.

## Do not
- Send SMS, UPDATE, CLI, or any other command to the T-SIM or the repeater without an explicit go.
- Print the dashboard password or API keys.
- Push `tsim-wake-frames` or deploy the Worker for v1.7.7 unless they ask.
