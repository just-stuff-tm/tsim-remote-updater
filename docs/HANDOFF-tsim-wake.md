# Handoff for the LTE Meshcore bot — tsim wake (2026-10-28)

You were unavailable. This session finished the `tsim wake` work the user asked for after the 18.1 release. Read this before doing anything else on it.

## What the user decided
- Publish T-SIM v1.7.7 so they can install it themselves with the dashboard **Update T-SIM** button.
- Deploy the dashboard so the Heltec update source matches MeshCore-TSim-Powersaving, and so the GPIO6 labels match the new behavior.
- Take the GPIO6 reboot-detection wake away.
- They will press Update T-SIM. Do not text the device. Do not flash the Heltec.
- Tag ruleset 26005316 stays disabled. The MeshCore-TSim-Powersaving daily cron stays off. Do not clear the queued-command list.

## T-SIM v1.7.7 (published, not installed)
- Repo: `just-stuff-tm/tsim-remote-updater`. Release: https://github.com/just-stuff-tm/tsim-remote-updater/releases/tag/v1.7.7
- Tag `v1.7.7` on `31b2aea` (`31b2aea54e9254adbbcc6d44d71176c879cc04da`). Draft false. Not a prerelease. Latest. Published 2026-10-28T22:26:07Z. Release notes are `release-notes/v1.7.7.md`.
- CI (the tag push): https://github.com/just-stuff-tm/tsim-remote-updater/actions/runs/40779824408. Worker tests and the firmware job succeeded. Host tests passed in that run. The official `firmware.bin` is the CI build. The local PlatformIO bin was not uploaded.
- `firmware.bin` is 654832 bytes, first byte `0xE9`, sha256 `bed2bb1d58fd63be1ee7b17f3edcfe1669111c233a2ecda284beb428a38fc715`, matching `firmware.bin.sha256`. Also attached: `bootloader.bin`, `partitions.bin`, `boot_app0.bin`.
- The installed T-SIM is still v1.7.6 until the user presses Update T-SIM. v1.7.6 still treats a working GPIO6 wake as a Heltec reboot.
- Nothing was sent to the device.

### What v1.7.7 does
The repeater already sends `@TSIM <CMD> <seq>` and waits for `@TSIM ACK <seq>`.
- GPIO6 wake listens 9 seconds. A frame is handled.
- No `@TSIM` frame: log `GPIO6 wake: no @TSIM frame, ignored` and sleep. It does not call `hwHandleReboot("wake")` and it does not count as a spurious wake.
- GPIO6 stuck low still increments the spurious counter and can turn the wake off. `WDCFG hwake=1` turns it back on. `hwake=0|1` still arms ext1 and still gates the while-awake reboot check.
- Allowlist: `WAKE` (ACK, modem stays asleep), `STATUS` (ACK, then a status report), `MODEM_RESET` (ACK, then a forced watchdog recovery). Anything else is logged and not ACKed.
- The same seq is ACKed again and not run twice. An echoed `@TSIM ACK` is ignored.
- The same handler runs for a frame that arrives while the T-SIM is already awake.
- The while-awake serial reboot check (1.7.4) and the daylight uptime check (1.7.5) are still in the firmware. The dashboard switch text says that same switch still allows the 1.7.4 check.
- Parser: `firmware/src/tsim_frame.h`. Version string: `tsim-updater 1.7.7`.

## Dashboard (deployed)
- Live Worker script name is `heltec-update-worker` (not the name in `worker/wrangler.toml`). Content was replaced on 2026-10-28T22:27:40Z. Deployment `0033b7fc-959e-4f58-b00d-8ec706f76ffe`, version `d0081e52-a8a5-47e5-9d15-7a5d7c78a8a6`. The uploaded module matches `worker/src/index.js` at `31b2aea` (sha256 `333051f98a5162095ffa45664268e0b5aacd3454e10ab8c6da3176e374ac245a`).
- Secrets `ADMIN_TOKEN`, `HOLOGRAM_API_KEY`, and `SESSION_SECRET` were left in place. The `STATE` KV binding was left in place. Compatibility date is still `2025-01-01`. Cron is still `0 * * * *`. Do not deploy `worker/wrangler.toml` (placeholder KV id) or the old `/workspace/heltec-update-worker` tree.
- Login page returned 200. Unauthenticated `/api/fleet` returned 401. The dashboard was not logged into. Do not use the password that was pasted in chat.
- `SOURCE_VERSION` is 4. An untouched default Heltec source migrates on the next read to `just-stuff-tm/MeshCore-TSim-Powersaving`, pattern `Heltec_v3_repeater-MeshCore-TSim-Powersaving*-upgrade.bin`. Custom sources stay. The previous MeshCore + power saving preset stays in the list and is not the default.
- A real 18.1 Heltec `UPDATE` URL is longer than 160 characters. The worker stores `ghasset:<id>` and texts `UPDATE <origin>/gh/<id> ` only when an update is actually texted. That short link does not exist until someone presses Update Heltec. The user did not ask to update the Heltec. Nothing was texted.
- GPIO6 labels now say the pulse is the repeater `tsim wake` command, not a Heltec reboot.

## Repeater release (already Latest, unchanged this session)
- https://github.com/just-stuff-tm/MeshCore-TSim-Powersaving/releases/tag/MeshCore-TSim-Powersaving18.1 at `f94f48d7`. Do not rebuild it.
- Tag-creation ruleset 26005316 stays disabled. Branch ruleset 26005228 stays active. The daily cron in `easyskymesh-sync.yml` stays commented out.
- The notes on `f94f48d7` still say the T-SIM frame firmware was not released. That is stale: v1.7.7 is released. Do not retag 18.1 for that sentence.
- Doc commit `52e895b4` is on `tsim` and is not in the 18.1 tag.

## Still on the user
- Press **Update T-SIM** on the dashboard when they want 1.7.7. Do not press it for them.
- The installed tree-node wire shows 0 GPIO6 pulses. `tsim wake` cannot reach that T-SIM until the wire is fixed on site (Heltec GPIO43 TX, cathode of a 1N5817 toward the Heltec, anode to T-SIM GPIO6, 100 nF from GPIO6 to GND). Until they install 1.7.7, a working wire would still make v1.7.6 reset the modem.
- The dashboard password was pasted in chat on Oct 20. Remind them to rotate it. Do not repeat it.
- Duplicate queued adverts or commands were never listed. Read the queue only. Do not clear it.

## Do not
- Send SMS, `UPDATE`, `TSIMUPDATE`, CLI, or any other command to the T-SIM or the repeater unless they ask.
- Print the dashboard password, API keys, account ids, KV ids, or the workers.dev host.
- Turn ruleset 26005316 back on, or enable the daily cron.
- Flash the Heltec, or retag v1.7.7. A later handoff commit on `main` is not a release.
