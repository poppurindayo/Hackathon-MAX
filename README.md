# Hackathon-MAX

MAX chatbot for finding nearby places.

## Environment

Copy `.env.example` to `.env` and set:

- `BOT_TOKEN` — MAX bot token.
- `TWOGIS_KEY` — 2GIS API key.
- `DB_PATH` — SQLite database path, default `./data/bot.db`.
- `LOG_PATH` — JSONL log file, default `./logs/bot.log`.
- `LOG_LEVEL` — `debug`, `info`, `warn` or `error`.
- `LOG_SALT` — random secret used to pseudonymize user IDs in logs.

## Logging

Logs are written as one JSON object per line. Important events include:

- `update.received` / `update.completed` / `update.error` — lifecycle of incoming bot updates;
- `bot.response` / `bot.response.error` — outgoing bot responses;
- `2gis.request` / `2gis.response` / `2gis.error` — external API requests, status and latency;
- `search.error`, `db.upsert_user.error`, `bot.start.error` — application failures.

API keys, tokens, passwords and authorization headers are automatically redacted. User IDs are stored as stable pseudonyms rather than raw MAX IDs.

The global middleware catches unhandled errors, logs them with a request ID and sends a generic user-facing error message without exposing internal details.

## Run

```bash
pnpm install
pnpm build
pnpm start
```

For a type-check without emitting files:

```bash
pnpm test
```
