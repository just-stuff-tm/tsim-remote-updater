# Setup guide (no bots required)

Plan about 1–2 hours. You need a computer with Node.js 18+, Python 3, and a USB-C cable.

## 1. Accounts

1. **Cloudflare** (free): https://dash.cloudflare.com/sign-up
2. **Hologram**: https://dashboard.hologram.io — activate your SIM, then note:
   - the SIM's numeric **Device ID** (Devices → click the SIM; the number in the URL/details),
   - an **API key**: Account settings → API → generate key.

## 2. Deploy the Worker

```bash
git clone https://github.com/<you>/tsim-remote-updater && cd tsim-remote-updater/worker
npm install
npx wrangler login                         # opens a browser
npx wrangler kv namespace create STATE     # copy the printed id
```

Open `worker/wrangler.toml` and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with that id. The `[triggers]` cron is optional (only used by per-repeater scheduled checks, off by default); delete it if you don't want it.

Generate two random secrets (keep them in a password manager, never in git):

```bash
openssl rand -hex 32   # ADMIN_TOKEN
openssl rand -hex 32   # SESSION_SECRET
```

Set the secrets. Each command prompts you; **paste the value at the prompt** (don't put it on the command line):

```bash
npx wrangler secret put HOLOGRAM_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SESSION_SECRET
npm test            # local tests, should print ALL TESTS PASSED
npx wrangler deploy # prints https://tsim-remote-updater.<your-subdomain>.workers.dev
```

(You can also set/edit secrets in the Cloudflare dashboard: Workers & Pages → your worker → Settings → Variables and Secrets.)

## 3. Create your device and login

```bash
export W=https://tsim-remote-updater.<your-subdomain>.workers.dev
export ADMIN_TOKEN=<your admin token>

curl -X POST $W/admin/devices -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"tsim-1","name":"Hilltop repeater","hologram_device_id":"<Hologram device id>"}'
```

Save the returned `password` (dashboard) and `ingest_key` (firmware). They are shown only once.

Optional fleet login covering several repeaters:

```bash
curl -X POST $W/admin/accounts -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"id":"owner","devices":["tsim-1"]}'
```

## 4. Build the T-SIM firmware

```bash
pip install platformio esptool
cd ../firmware
cp include/config.example.h include/config.h
```

Edit `include/config.h`: `WORKER_URL` (your workers.dev URL, no trailing slash), `DEVICE_ID` (`tsim-1`), `DEVICE_KEY` (the ingest_key), `APN` (`hologram`). Then:

```bash
pio run
```

(Without `config.h` the build still succeeds using placeholder values from `config.example.h`, but that firmware can't reach your Worker.)

## 5. Wire it up

> **Other repeater boards:** any ESP32-family MeshCore board can be remotely flashed. nRF52 boards (RAK4631, T-Echo, T114, …) can only be rebooted and checked, not flashed. Set the file name pattern to your board's firmware. See "Supported repeater boards" in the README.


See the wiring table in the [README](../README.md#wiring). Recommended: power the Heltec from the same 1S battery via its JST battery connector (check polarity with a meter first, it is not standardized), **no 3V3 link** between the boards, shared GND plus TX/RX/RST/BOOT, a fuse on battery +, and never plug USB into the Heltec while it is battery-wired. Put the SIM in the T-SIM, attach the LTE antenna, the 18650 and (later) the solar panel. Flash your repeater firmware onto the Heltec first with the normal MeshCore web flasher.

## 6. Flash the T-SIM

Put it in **download mode**: hold **BOOT**, tap **RST**, release **BOOT**. Then (port is `/dev/ttyACM0` on Linux, `/dev/cu.usbmodem*` on macOS, `COMx` on Windows):

```bash
pio run -t upload --upload-port /dev/ttyACM0
```

or with esptool:

```bash
esptool.py --chip esp32s3 --port /dev/ttyACM0 --baud 921600 write_flash -z \
  --flash_mode dio --flash_freq 80m --flash_size 16MB \
  0x0 .pio/build/tsim7672g/bootloader.bin \
  0x8000 .pio/build/tsim7672g/partitions.bin \
  0xe000 ~/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin \
  0x10000 .pio/build/tsim7672g/firmware.bin
```

Tap **RST** once (without BOOT) to start it. `pio device monitor` shows the boot log for 2 minutes before it sleeps.

After this first USB flash (v1.6.0+ with the OTA partition table), later T-SIM firmware updates can be done from the dashboard (**T-SIM firmware update** → **Update T-SIM firmware**). Your config is kept in the board's NVS. If the new firmware can't reach the dashboard after booting, it rolls back on its own.

## 7. First test

Wait ~30 s after RST, open your Worker URL, log in, press **Request status**. Within 1–2 minutes you should see signal, battery and a mesh snapshot.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| T-SIM battery shows 0 V | Normal while USB is connected (board design). Unplug USB. |
| Console / mesh stats "paused (power saving)" | Repeater power-saving modes (e.g. EasySkyMesh `powersaving on`) sleep the Heltec's serial CLI. Repeater stats are still available over the mesh with MeshCore remote admin; T-SIM stats still come via Request status. `powersaving off` (from remote admin) re-enables it. |
| T-SIM OTA says "no OTA partition" | The board still has the old single-app partition table. Do one USB flash of all four files from a ≥1.6.0 build. |
| T-SIM OTA rolled back | The new firmware booted but couldn't post to `/ingest` (wrong config, no signal). Check the boot log over USB; a placeholder build needs NVS config from a correctly configured ≥1.6.0 USB flash. |
| Text arrives but T-SIM ignores it | Some carriers deliver SMS as UCS2 hex. Firmware ≥1.5.1 decodes it automatically; update the firmware. |
| Firmware download from GitHub fails (TLS) | GitHub sends 16 KB TLS records; the patched ESP_SSLClient in `firmware/patches/` uses a 16 KB receive buffer. Make sure `apply_patches.py` ran (clean build: `pio run -t clean && pio run`). |
| Dashboard says Hologram 403 / invalid key | The `HOLOGRAM_API_KEY` secret is wrong. Re-enter it with `wrangler secret put` or the Cloudflare dashboard (paste exactly, no spaces). |
| "Bad origin" on login | Use the exact workers.dev URL (not a proxy/preview URL). |
| Nothing shows after Request status | Check LTE antenna/signal, APN, and that `WORKER_URL`/`DEVICE_KEY` in `config.h` match. Watch the USB log. |
