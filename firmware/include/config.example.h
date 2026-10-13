#pragma once
// Copy this file to include/config.h and fill in your values.
// include/config.h is gitignored — never commit it.

// Your deployed Worker, no trailing slash
#define WORKER_URL  "https://tsim-remote-updater.YOUR-SUBDOMAIN.workers.dev"
// Device id you registered with POST /admin/devices
#define DEVICE_ID   "tsim-1"
// ingest_key returned once by /admin/devices (or /admin/devices/<id>/rotate-key)
#define DEVICE_KEY  "REPLACE_WITH_INGEST_KEY"
// Cellular APN for your SIM
#define APN         "hologram"
