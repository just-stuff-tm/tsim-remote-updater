# Instructions for AI agents (Grok Bot etc.)

You are building and deploying this project for a human. Human-oriented steps are in [SETUP.md](SETUP.md); follow them, with these rules.

## Ask the human for
1. Cloudflare account access (they run `npx wrangler login`, or give a scoped API token with Workers + KV edit).
2. Hologram API key and the SIM's numeric Hologram device id.
3. Names: device id(s) (e.g. `tsim-1`), repeater display names, optional fleet login id.
4. Repeater firmware update source (default `IoTThinks/EasySkyMesh`, pattern `Heltec_v3_repeater-*-upgrade.bin`).
5. Which board (T-SIM7670G-S3 or T-SIM7672G; same pinout) and the USB port for flashing.

## Order of operations
1. `npm install`; `wrangler kv namespace create STATE`; put the id in `wrangler.toml` locally (it's a public-safe id but keep the human's fork free of their account details if publishing).
2. Generate `ADMIN_TOKEN` and `SESSION_SECRET` with `openssl rand -hex 32`.
3. Set `HOLOGRAM_API_KEY`, `ADMIN_TOKEN`, `SESSION_SECRET` with `wrangler secret put` (stdin/interactive) or have the human paste them in the Cloudflare dashboard. **Some connectors/tools redact or mangle secret values** — after setting, verify (e.g. a Hologram call returns 200, admin `GET /admin/devices` returns 200), and if a value is wrong ask the human to paste it in the dashboard.
4. `npm test`, then `wrangler deploy`.
5. `POST /admin/devices` (and optionally `/admin/accounts`). Give the human the password; keep the ingest_key only in `firmware/include/config.h`.
6. Copy `config.example.h` → `config.h`, fill in, `pio run`.
7. Hardware steps need the human: wiring, putting the T-SIM in download mode (hold BOOT, tap RST, release BOOT), and tapping RST after flashing. Ask and wait.
8. Flash (`pio run -t upload` or esptool, offsets in SETUP.md), then ask the human to press Request status.

## Never
- Never commit or paste into public places: passwords, ADMIN_TOKEN, SESSION_SECRET, ingest keys, Hologram key/device ids, phone numbers, emails, Cloudflare account/KV ids, the workers.dev subdomain. `config.h` is gitignored; keep it that way.
- Never make the T-SIM send SMS. It reports over data only.
- Never add automatic/periodic texts by default. Send the minimum texts (one per action; Worker rate-limits to 1/60 s). Scheduled checks stay off unless the human asks.
- Don't defeat repeater power saving (e.g. no auto-reboots of the Heltec to reach the CLI). When power saving is on, the console pauses; that's intended.

## Verification checklist
- [ ] `npm test` prints ALL TESTS PASSED
- [ ] Login page loads; wrong password rejected; correct one shows the device
- [ ] `GET /admin/devices` with the token returns 200, without it 401
- [ ] Hologram key accepted (Request status logs "sent", not 403)
- [ ] T-SIM boot log: modem registered, no errors
- [ ] After Request status, fresh telemetry appears within ~2 min
- [ ] Check for update shows the latest release and sends nothing
- [ ] `git grep` for every secret value returns nothing before any push
