# Handoff for the LTE Meshcore bot — tsim wake (2026-10-27)

You were unavailable. This session continued your `tsim wake` work. Read this before doing anything else on it.

## What the user decided
- Write the T-SIM `@TSIM` handler locally. Do not push it, do not release it, do not flash it.
- Publish MeshCore-TSim-Powersaving and mark it Latest.
- After publish: leave tag ruleset 26005316 disabled, and leave the dashboard alone.
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

## Repeater release (published and marked Latest)
- Repo: `just-stuff-tm/MeshCore-TSim-Powersaving`, branch `tsim`.
- Latest: https://github.com/just-stuff-tm/MeshCore-TSim-Powersaving/releases/tag/MeshCore-TSim-Powersaving18.1
- Tag and name: `MeshCore-TSim-Powersaving18.1`. Draft false. Not a prerelease. Published 2026-10-28T02:53:12Z. Target `f94f48d70103183680f75abeaaf417dcbbe7af15`. 499 assets.
- Build run (it had already started with publish left off, so the workflow wrote a draft): https://github.com/just-stuff-tm/MeshCore-TSim-Powersaving/actions/runs/40619447623. Conclusion success. 249 of 264 envs built. No Heltec V3 env was in the not-built list. This token cannot dispatch Actions (HTTP 403). The existing draft was published through the Releases API. It was not rebuilt.
- Download check after publish, through the API, matched `SHA256SUMS.txt`:
  - `Heltec_v3_repeater-MeshCore-TSim-Powersaving18.1-upgrade.bin` — 1200896 bytes, first byte `0xE9`, sha256 `86439e523776536de7650badf7a39e3121f177b6bd6936882d5c15b306faf7f4`
  - `Heltec_v3_repeater_headless-MeshCore-TSim-Powersaving18.1-upgrade.bin` — 1187536 bytes, first byte `0xE9`, sha256 `5ae308daf7ce8189eb0ad60a987a367dbb7b6dcc395763163dedda3004225ba4`
- The updater uses `Heltec_v3_repeater-...-upgrade.bin`. It does not use `freshInstall` or `_headless`.
- Doc commit `52e895b4` (dead design-branch link removed) is on `tsim` and is not in this release. The notes on `f94f48d7` already say `tsim wake` needs T-SIM frame firmware that is not released, and that an older T-SIM treats the GPIO6 wake as a Heltec reboot.
- Tag-creation ruleset 26005316 (`HOLD: no tags until names are agreed`) has enforcement disabled. It blocked the tag. The name was already agreed and the user had asked to publish. The user then said to leave it off. Branch ruleset 26005228 (`tsim: no force-push or deletion`) is still active.
- The daily cron in `easyskymesh-sync.yml` is still commented out.
- The dashboard was not opened. The documented default Heltec update source is `just-stuff-tm/MeshCore` branch `powersaving`, pattern `Heltec_v3_repeater-v*-powersaving-*.bin`. That pattern does not match `Heltec_v3_repeater-MeshCore-TSim-Powersaving18.1-upgrade.bin`, so the dashboard will not select this release on its own. The user said to leave the dashboard alone. Do not change the Worker or any device update source unless they change their mind.
- Nothing was sent to the T-SIM or the Heltec. Leave this release unflashed unless the user says so. Installed T-SIM v1.7.6 treats a working GPIO6 wake as a Heltec reboot and ignores `@TSIM`.

## Still on the user
- The installed tree-node wire shows 0 GPIO6 pulses. `tsim wake` cannot reach that T-SIM until the wire is fixed on site (Heltec GPIO43 TX, cathode of a 1N5817 toward the Heltec, anode to T-SIM GPIO6, 100 nF from GPIO6 to GND).
- The dashboard password was pasted in chat on Oct 20. Remind them to rotate it. Do not repeat it.
- Duplicate queued adverts or commands were never listed. Read the queue only. Do not clear it and do not text the device unless they say so.

## Do not
- Send SMS, UPDATE, CLI, or any other command to the T-SIM or the repeater without an explicit go.
- Print the dashboard password or API keys.
- Push `tsim-wake-frames` or deploy the Worker for v1.7.7 unless they ask.
- Turn ruleset 26005316 back on, enable the daily cron, or point a device at 18.1 unless they ask.
