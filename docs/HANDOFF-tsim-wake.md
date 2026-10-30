# Handoff for the LTE Meshcore bot — you have it back (2026-10-29)

You were unavailable. Another session finished the `tsim wake` work and the user just handed it back to you. Read this before doing anything else on it. Working copy: `/workspace/tsim-v172` (not `tsim-v170`, not `/workspace/tsim-remote-updater`). Repeater tree: `/workspace/esm-tsim`, remote `tsimrepo` (not `origin`).

## What the user decided
- Publish T-SIM v1.7.7. They install from the dashboard. Do not text the device. Do not flash the Heltec.
- Point the dashboard Heltec source at MeshCore-TSim-Powersaving.
- Take the GPIO6 reboot-detection wake away. The daylight uptime check (1.7.5) and the while-awake serial check (1.7.4) stay.
- They asked why the daylight interval and solar voltage did not change on the card. The card was showing an old heartbeat. That display is fixed and deployed. Do not revert it.
- They asked for the 18.1 repeater release notes to name T-SIM v1.7.7. That text is updated. Do not rebuild or retag 18.1.
- Tag ruleset 26005316 on MeshCore-TSim-Powersaving stays disabled. The daily cron in `easyskymesh-sync.yml` stays commented out. Do not clear the queued-command list.
- The dashboard password was pasted in chat on Oct 20. Tell them to rotate it. Do not repeat it, and do not log in with it.

## T-SIM v1.7.7
- Release: https://github.com/just-stuff-tm/tsim-remote-updater/releases/tag/v1.7.7
- Tag `v1.7.7` is `31b2aea` (`31b2aea54e9254adbbcc6d44d71176c879cc04da`). Draft false. Latest. Published 2026-10-28T22:26:07Z. Notes: `release-notes/v1.7.7.md`. Do not move the tag.
- CI: https://github.com/just-stuff-tm/tsim-remote-updater/actions/runs/40779824408
- `firmware.bin` is 654832 bytes, first byte `0xE9`, sha256 `bed2bb1d58fd63be1ee7b17f3edcfe1669111c233a2ecda284beb428a38fc715`.
- The device `tsim-1` (Lilygo TSim Heltec V3) last reported `tsim-updater 1.7.7` at 2026-10-29T00:18:12Z. It is no longer on 1.7.6.
- GPIO6 listens 9 seconds for `@TSIM`. No frame: log `GPIO6 wake: no @TSIM frame, ignored` and sleep. It does not call `hwHandleReboot("wake")` and it does not count as a spurious wake. Stuck-low still can turn the wake off. `hwake=0|1` still arms ext1 and still gates the while-awake check.
- Allowlist: `WAKE` (ACK, modem stays asleep), `STATUS` (ACK, then a status report), `MODEM_RESET` (ACK, then watchdog recovery). Same seq is not run twice. An echoed `@TSIM ACK` is ignored.
- Parser: `firmware/src/tsim_frame.h`.

## Dashboard
- Live script name is `heltec-update-worker`. Do not deploy `worker/wrangler.toml` (placeholder KV id) or `/workspace/heltec-update-worker`.
- Secrets `ADMIN_TOKEN`, `HOLOGRAM_API_KEY`, and `SESSION_SECRET` stay. The `STATE` KV binding stays. Compatibility date `2025-01-01`. Cron `0 * * * *`.
- Two code deploys. The second one is current. Its module sha256 is `da5b6fd8fe2ad078354260abe5e0b1134163141a71bfe4bab17df8011546cd49` and it matches `worker/src/index.js` in the commit that adds this handoff. Login page returned 200. Unauthenticated `/api/fleet` returned 401.
- `SOURCE_VERSION` is 4. An untouched default Heltec source migrates on the next read to `just-stuff-tm/MeshCore-TSim-Powersaving`, pattern `Heltec_v3_repeater-MeshCore-TSim-Powersaving*-upgrade.bin`. A custom source stays. The old MeshCore + power saving preset stays and is not the default.
- A real 18.1 Heltec `UPDATE` URL is longer than 160 characters. The worker stores `ghasset:<id>` and texts `UPDATE <origin>/gh/<id> ` only when an update is actually texted. That short link does not exist until someone presses Update Heltec. Nothing was texted.
- Daylight row: `upollNow()` in `worker/src/index.js`. A `WDCFG` the T-SIM has applied is what the row and the two fields show, until a newer heartbeat reports something else. A save that is still waiting shows that save and the words "waiting for the T-SIM". It must not snap back to the old heartbeat.
- On `tsim-1` the applied settings at 2026-10-29T00:11:41Z are `upoll=60` (1 hour) and `usol=4800` (4.8 V), plus `int=720`, heartbeat on, stored texts left, GPIO6 wake on. The T-SIM replied `WDCFG applied 6: ... upoll=60 usol=4800`. "Applied 6" is a count of keys, not 6 hours. The last heartbeat is still 2026-10-28T15:26:34Z and still says `upoll=180` `usol=0`. The card should now show 1 hour and 4.8 V. Check counts on that row still come from the old heartbeat.
- One older command is still status `sent`, not done: `WDCFG ... upoll=0 usol=0` queued 2026-10-28T23:11:38Z. The later command above is the one the T-SIM applied. Do not clear the queue and do not send another `WDCFG` unless the user asks.
- The Heltec was not flashed from here. Update the T-SIM before the radio if both are still pending: v1.7.6 treats a GPIO6 pulse as a Heltec reboot. This device has already reported 1.7.7.

## Repeater release
- https://github.com/just-stuff-tm/MeshCore-TSim-Powersaving/releases/tag/MeshCore-TSim-Powersaving18.1
- Tag stays on `f94f48d7`. Draft false. Latest. 499 assets. Do not rebuild it and do not move the tag.
- Release notes now name T-SIM v1.7.7. The notes file on branch `tsim` is commit `f31cf623` (`.tsim/notes.md.in` and `.tsim/README.md`). That commit is not in the 18.1 tag. Doc commit `52e895b4` is also on `tsim` and not in the tag.
- `tsimrepo` is the remote that accepts pushes. `origin` is meshcore-dev and push returns 403.

## Still on the user
- The tree-node wire still shows 0 GPIO6 pulses (Heltec GPIO43 TX, cathode of a 1N5817 toward the Heltec, anode to T-SIM GPIO6, 100 nF from GPIO6 to GND). `tsim wake` cannot reach the T-SIM until that wire is fixed.
- Rotate the dashboard password from the Oct 20 chat. Do not repeat it.
- Duplicate queued adverts or commands were never listed. Read the queue only.

## Do not
- Send SMS, `UPDATE`, `TSIMUPDATE`, CLI, or any other command unless they ask.
- Print the dashboard password, API keys, account ids, KV ids, or the workers.dev host.
- Turn ruleset 26005316 back on, or enable the daily cron.
- Flash the Heltec, retag v1.7.7, or retag MeshCore-TSim-Powersaving18.1.
