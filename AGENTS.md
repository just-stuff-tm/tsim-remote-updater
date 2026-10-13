# AGENTS.md

AI agents building or deploying this project: read [docs/FOR-AI-AGENTS.md](docs/FOR-AI-AGENTS.md) first. Never commit `firmware/include/config.h` or any secret.

- Worker tests: `cd worker && npm install && npm test`
- Firmware build: `cd firmware && pio run` (uses `config.example.h` if `config.h` is missing)
