# How to Use

This guide walks through running the WhatsApp AI Bridge API locally, managing sessions, and exercising the main endpoints.

## 1. Prepare Your Environment

1. Install Node.js 20 or newer.
2. Ensure PostgreSQL is reachable and seeded with your users and API keys.
3. Clone the repository and install dependencies:
   ```bash
   git clone <your-repo-url>
   cd whatsapp_api_cleviopro
   npm install
   ```
4. Copy the environment template and edit the required values:
   ```bash
   cp .env.example .env
   ```

### Required Variables

Update at least the following keys in `.env`:

- `DATABASE_URL` – PostgreSQL connection string that exposes the `api_key` and `whatsapp_user` tables.
- `APP_BASE_URL` – Public URL clients will use to call `/agents/{agentId}/run`.
- (Optional) `AI_BACKEND_URL`, `DEFAULT_OPENAI_API_KEY`, `CORS_ALLOWED_ORIGINS`, `CORS_ALLOW_CREDENTIALS`, `PORT`, and timeout/logging knobs as documented in `README.md`.

## 2. Run the Server Locally

```bash
npm run dev
```

- The HTTP API listens on `PORT` (defaults to `3000`).
- Visit `http://localhost:3000/docs` to view the bundled API documentation.
- Logs stream through Pino; set `LOG_LEVEL=debug` for more detail while testing.

## 3. Create a WhatsApp Session

Issue a POST request to `/sessions` with the agent metadata that matches the rows in your database:

```bash
curl -X POST http://localhost:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{
        "userId": 123,
        "agentId": "support-bot"
      }'
```

- The response returns a base64 QR code (`qr.base64`). Scan it with WhatsApp within the `qr.expiresAt` window (defaults to 5 minutes).
- `endpointUrl` echoes the public URL constructed from `APP_BASE_URL` that downstream services must call to reach this agent.

## 4. Send Messages Through the Agent

Once the WhatsApp client is authenticated:

```bash
curl -X POST http://localhost:3000/agents/support-bot/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY_FROM_DB>" \
  -d '{
        "message": "Hello assistant!",
        "sessionId": "6281234567890@c.us"
      }'
```

- The service forwards the payload to `${AI_BACKEND_URL}/agents/{agentId}/run` (if configured) and relays the AI response back to WhatsApp.
- Add optional properties such as `openai_api_key`, `memory_enable`, or `metadata` according to `docs/api-reference.md`.

## 5. Manage Sessions

- Regenerate a QR code after network issues: `POST /sessions/{agentId}/reconnect`
- Tear down the agent: `DELETE /sessions/{agentId}`
- Check the live session state without leaving the `agents` namespace: `GET /agents/{agentId}/get-status`
- Inspect status fields (`connected`, `awaiting_qr`, timestamps) in the JSON responses or directly in the `whatsapp_user` table.

Example `curl` to check status (remember to pass the agent's unique `agentId`, not a display name):

```bash
curl -s http://localhost:3000/agents/AgentId/get-status | jq '{state: .state, isConnected: .isConnected, sessionState: .sessionState, updatedAt: .status.updatedAt}'
```

The response mirrors `GET /sessions/{agentId}` while also surfacing top-level `state` and `isConnected` fields so you can quickly see if the WhatsApp client is online. The nested `status` object still carries timestamp metadata and historical fields.

## 6. Housekeeping

- Temporary attachments land in the directory referenced by `TEMP_DIR` (`./temp` by default). Files older than 24 hours are purged automatically.
- Cached WhatsApp auth data lives in `.wwebjs_auth` and `.wwebjs_cache`. These directories are ignored by Git but must persist between restarts to avoid repeated QR scans.

Refer to `README.md` for a deeper architectural overview and to `docs/api-reference.md` for complete request/response schemas.
