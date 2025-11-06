# WhatsApp AI Bridge API

Backend service built on top of [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) that provisions WhatsApp sessions, exposes QR codes, forwards text messages to an AI backend, and stores metadata in PostgreSQL.

## Features

- **Create Session** endpoint bootstraps WhatsApp Web, fetches the user's API key from PostgreSQL, persists the session, and returns a time-boxed QR image.
- **Send Message** endpoint lives at `/agents/{agentId}/run` and proxies payloads to your configured AI backend, enforcing API-key validation.
- **Automatic message ingestion** forwards only text messages (with contact/group metadata) while ignoring statuses and unmentioned group chatter, then delivers AI-generated replies straight back to WhatsApp while simulating typing indicators. Attachments are archived temporarily and purged after 24 hours.
- **Session lifecycle** tools to reconnect existing clients (returning fresh QR codes), auto-restore persisted sessions on startup, or delete them entirely, including their cached auth files.
- **Live status tracking** persists connection state changes in PostgreSQL, including timestamps for the latest connect/disconnect events.
- **Documentation** served from `/docs` along with a Markdown API reference in `docs/api-reference.md`.

## Getting Started

### Prerequisites

- Node.js 20+
- Google Chrome or Chromium dependencies required by Puppeteer (see the whatsapp-web.js [documentation](https://wwebjs.dev/guide/installation.html)).
- PostgreSQL database reachable through the provided `DATABASE_URL`.

### Installation

```bash
npm install
cp .env.example .env
# edit .env with real values
npm run dev
```

The server listens on `PORT` (default `3000`). Browse to `http://localhost:3000/docs` for live API documentation. Session responses advertise message endpoints using `http://localhost:8000` by default; override this by setting `APP_BASE_URL`.

### Environment variables

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (required). |
| `APP_BASE_URL` | Public base URL of this API (used to compose `/agents/{agentId}/run`). Defaults to `http://localhost:8000`. |
| `AI_BACKEND_URL` | Base URL of the downstream AI service (`/agents/{agentId}/run` will be appended). Leave blank to disable forwarding. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated list of allowed origins for browser clients (default `*`). |
| `CORS_ALLOW_CREDENTIALS` | Set to `true` to allow credentialed cross-origin requests (only when origins are explicit). |
| `DEFAULT_OPENAI_API_KEY` | Optional fallback if callers omit `openai_api_key` in `/agents/{agentId}/run`. |
| `TEMP_DIR` | Directory for temporarily stored attachments (default `./temp`). |
| `QR_EXPIRATION_MINUTES` | QR validity window (default `5`). |
| `SESSION_CLEANUP_INTERVAL_MINUTES` | Reserved for future background jobs (default `60`). |
| `LOG_LEVEL` | Logging verbosity for Pino (default `info`). |
| `AI_REQUEST_TIMEOUT_MS` | Axios timeout when waiting for AI backend responses (default `120000`). |
| `REQUEST_LOGGING` | Enabled by default. Each HTTP request emits structured logs with request IDs, durations, and key metadata. |

## Database

On startup the service ensures a `whatsapp_user` table exists with the required columns:

```text
id SERIAL PRIMARY KEY
user_id BIGINT NOT NULL
agent_id VARCHAR(255) UNIQUE NOT NULL
api_key TEXT NOT NULL
session_name VARCHAR(255) NOT NULL
endpoint_url_run TEXT NOT NULL
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
```

The latest active entry from `api_key` is fetched during session creation. `key_hash` is used as the runtime API key.

Connection metadata is stored directly on `whatsapp_user` via the columns:

```text
status VARCHAR(50) NOT NULL DEFAULT 'awaiting_qr'
last_connected_at TIMESTAMPTZ
last_disconnected_at TIMESTAMPTZ
```

These fields update automatically when QR codes are generated, authentication succeeds or fails, and when the client disconnects.

## Message Flow

1. **Create Session** — Clients call `POST /sessions` with `userId` and `agentId`.
2. **Scan QR** — Response includes a base64 PNG QR code valid for 5 minutes. Scanning authenticates the WhatsApp client.
3. **Inbound messages** — whatsapp-web.js receives all incoming traffic.
   - Text messages are forwarded to the AI backend using the `/agents/{agentId}/run` contract, enriched with contact/group metadata, and AI replies are posted back to the same WhatsApp chat automatically with typing indicators shown while waiting.
   - Non-text messages are downloaded to `TEMP_DIR` and deleted after 24 hours.
   - Status updates and group messages without the bot mention are ignored.
4. **Outbound AI call** — `/agents/{agentId}/run` is also exposed publicly, validating the stored API key before proxying to `${AI_BACKEND_URL}` and delivering the AI's textual response to WhatsApp (typing indicators mirror the wait time).
5. **Session maintenance** — Use `DELETE /sessions/{agentId}` to tear down a bot or `POST /sessions/{agentId}/reconnect` to force logout and obtain a new QR code after transient network failures. Persisted sessions are automatically reloaded after process restarts.
   - Connection state transitions are saved on the `status` columns of `whatsapp_user`, providing visibility into availability.

## Temporary File Lifecycle

Attachments are stored with timestamped filenames inside `TEMP_DIR`. A background cleanup runs twice per day (or half the TTL) and removes files older than 24 hours. Files are not exposed over HTTP and should be consumed or moved before expiry if needed.

## Development Notes

- Logs are emitted via [Pino](https://github.com/pinojs/pino). Use `LOG_LEVEL=debug` while developing.
- Every HTTP request produces structured start/end logs (request ID, duration, status, metadata). Session bootstrap activity is also logged during application startup.
- Puppeteer launches in headless mode with `--no-sandbox`; adjust if deploying to hardened containers.
- The AI backend call uses Axios with a 30-second timeout and rethrows any upstream errors.

## API Summary

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/sessions` | Create or refresh a WhatsApp session; respond with QR code. |
| `DELETE` | `/sessions/{agentId}` | Destroy a WhatsApp session and delete its database record. |
| `POST` | `/sessions/{agentId}/reconnect` | Force a reconnection attempt. |
| `POST` | `/agents/{agentId}/run` | Validate API key and forward payload to AI backend. |
| `GET` | `/health` | Basic service uptime probe. |
| `GET` | `/docs` | Static API documentation. |

Refer to [`docs/api-reference.md`](docs/api-reference.md) for detailed payloads and samples.
