# WhatsApp API Reference

## Overview

The service exposes RESTful endpoints to manage WhatsApp Web sessions and proxy user messages to an AI backend. Sessions are tied to a `userId` and `agentId`, and rely on WhatsApp Web authentication via QR code scanning. All requests and responses use JSON unless stated otherwise.

Base URL: `http://localhost:8000` (override via `APP_BASE_URL`)

All requests to `/agents/{agentId}/run` require the `Authorization: Bearer <API KEY>` header, where the key is automatically retrieved from the PostgreSQL `api_key` table during session creation.

---

## Create Session

`POST /sessions`

### Request Body

```json
{
  "userId": 123,
  "agentId": "support-bot"
}
```

### cURL Example

```bash
curl -X POST http://localhost:8000/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 123,
    "agentId": "support-bot"
  }'
```

### Behavior

1. Fetches the latest active API key for the provided `userId` from `cleviopro.public.api_key`.
2. Spins up (or rehydrates) a WhatsApp Web session scoped to `agentId`.
3. Stores the session metadata in `cleviopro.public.whatsapp_user`:
   - `user_id`, `agent_id`, `api_key`, `endpoint_url_run`, timestamps.
4. Generates a QR code image valid for 5 minutes and returns it as a base64 encoded PNG.
5. If the QR code expires before the device is authenticated, the session and its QR code are discarded automatically; call this endpoint again to start over.

### Success Response

```json
{
  "message": "Session created. Scan the QR code within 5 minutes to authenticate.",
  "endpointUrl": "http://localhost:8000/agents/support-bot/run",
  "session": {
    "userId": 123,
    "agentId": "support-bot"
  },
  "status": {
    "state": "awaiting_qr",
    "lastConnectedAt": null,
    "lastDisconnectedAt": null,
    "updatedAt": "2025-01-01T11:55:00.000Z"
  },
  "qr": {
    "contentType": "image/png",
    "base64": "iVBORw0KGgoAAAANSUhEUgAA...",
    "expiresAt": "2025-01-01T12:00:00.000Z"
  }
}
```

If the session is already authenticated, the response omits the `qr` block and returns status `200`.

---

## Delete Session

`DELETE /sessions/{agentId}`

- Destroys the WhatsApp client, removes persisted auth files, and deletes the matching record from `whatsapp_user`.
- Response: `204 No Content`.

### cURL Example

```bash
curl -X DELETE http://localhost:8000/sessions/support-bot
```

---

## Get Session Status

`GET /sessions/{agentId}`

- Returns the current persisted status together with the live WhatsApp client state (if running).
- `isReady` indicates whether the in-memory session is authenticated and ready to send messages.
- Response: `404 Not Found` when no session record exists.

### cURL Example

```bash
curl http://localhost:8000/sessions/support-bot
```

```bash
curl http://localhost:8000/sessions/support-bot | jq
```

### Success Response

```json
{
  "agentId": "support-bot",
  "userId": 123,
  "status": {
    "state": "connected",
    "lastConnectedAt": "2025-01-01T12:05:00.000Z",
    "lastDisconnectedAt": "2024-12-31T18:10:00.000Z",
    "updatedAt": "2025-01-01T12:05:00.000Z"
  },
  "sessionState": "ready",
  "isReady": true,
  "hasClient": true
}
```

---

## Reconnect Session

`POST /sessions/{agentId}/reconnect`

- Logs out the WhatsApp client, re-initializes it, and returns a fresh QR code image.
- Response payload:

### cURL Example

```bash
curl -X POST http://localhost:8000/sessions/support-bot/reconnect
```

```json
{
  "message": "Session reinitialized. Scan the QR code within 5 minutes to authenticate.",
  "endpointUrl": "http://localhost:8000/agents/support-bot/run",
  "session": {
    "userId": 123,
    "agentId": "support-bot"
  },
  "status": {
    "state": "awaiting_qr",
    "lastConnectedAt": null,
    "lastDisconnectedAt": "2025-01-01T11:50:00.000Z",
    "updatedAt": "2025-01-01T11:55:00.000Z"
  },
  "qr": {
    "contentType": "image/png",
    "base64": "iVBORw0KGgoAAAANSUhEUgAA...",
    "expiresAt": "2025-01-01T12:00:00.000Z"
  }
}
```

---

## Send Message (AI Forwarding)

`POST /agents/{agentId}/run`

### Headers

- `Content-Type: application/json`
- `Authorization: Bearer <API KEY>` (validated against the stored key for the agent)

### Request Body

```json
{
  "message": "Hello assistant!",
  "openai_api_key": "sk-***",          // optional; falls back to DEFAULT_OPENAI_API_KEY
  "sessionId": "6281234567890@c.us",   // phone number or group id
  "memory_enable": true,
  "context_memory": "100",
  "rag_enable": true,
  "metadata": {
    "whatsapp_name": "Customer",
    "chat_name": "VIP Support"
  }
}
```

### cURL Example

```bash
curl -X POST http://localhost:8000/agents/support-bot/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "message": "Hello assistant!",
    "sessionId": "6281234567890@c.us"
  }'
```

### Behavior

- Validates the API key and payload.
- Resolves the downstream AI endpoint using `${AI_BACKEND_URL}/agents/{agentId}/run`.
- Forwards the request via HTTPS with the stored API key and returns the downstream response body.
- Extracts a reply text (if any) from the AI response and sends it back to the WhatsApp `sessionId` automatically while displaying a typing indicator during processing.

### Success Response

```json
{
  "status": "forwarded",
  "payload": {
    "reply": "Hello! How can I help you today?",
    "sessionId": "6281234567890@c.us"
  },
  "replySent": true,
  "replyText": "Hello! How can I help you today?"
}
```

If the AI backend URL is not configured, the endpoint returns `503 Service Unavailable`.

---

## Send Direct WhatsApp Message

`POST /agents/{agentId}/messages`

### Headers

- `Content-Type: application/json`
- `Authorization: Bearer <API KEY>`

### Request Body

```json
{
  "to": "6281234567890",
  "message": "Reminder: our meeting starts in 10 minutes."
}
```

### cURL Example

```bash
curl -X POST http://localhost:8000/agents/support-bot/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "to": "6281234567890",
    "message": "Reminder: our meeting starts in 10 minutes."
  }'
```

### Behavior

- Validates the stored API key for the agent and checks that both `to` and `message` are provided.
- Converts a bare phone number into a WhatsApp chat ID by appending `@c.us`; existing chat IDs (for example `XXXXXXXXXX@g.us`) are respected.
- Requires the WhatsApp session to be in the `ready` state before sending; otherwise returns `409 Conflict`.
- Sends the specified `message` from the authenticated bot number to the `to` recipient without invoking the AI backend.

### Success Response

```json
{
  "status": "sent",
  "to": "6281234567890@c.us"
}
```

If the destination chat cannot be reached, the endpoint returns `502 Bad Gateway`.

---

## Send Media Message

`POST /agents/{agentId}/media`

### Headers

- `Content-Type: application/json`
- `Authorization: Bearer <API KEY>`

### Request Body

```json
{
  "to": "6281234567890",
  "type": "document",
  "filename": "invoice.pdf",
  "data": "BASE64_ENCODED_FILE",
  "caption": "Invoice #123",
  "mimetype": "application/pdf"
}
```

You may provide either `data` (base64 string) or `url` for the file source. Supported `type` values: `document`, `image`, `audio`, `video`, `sticker`.

### cURL Example

```bash
curl -X POST http://localhost:8000/agents/support-bot/media \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "to": "6281234567890",
    "type": "document",
    "filename": "invoice.pdf",
    "data": "'"$(base64 -w0 ./invoice.pdf)"'",
    "caption": "Invoice #123",
    "mimetype": "application/pdf"
  }'
```

### Behavior

- Validates the stored API key and required fields (`to`, `type`, and either `data` or `url`).
- Converts bare phone numbers into WhatsApp IDs with `@c.us`.
- Downloads remote files when `url` is provided; otherwise decodes the supplied base64 `data`.
- Sends the file using WhatsApp Web.js with sensible defaults (`sendMediaAsDocument` for documents, caption support where applicable).
- Optionally persists a copy to the temp directory (default `true`); disable by setting `save_to_temp: false`.

### Success Response

```json
{
  "status": "sent",
  "to": "6281234567890@c.us",
  "type": "document",
  "messageId": "true_6281234567890@c.us_XXXXXXXXXXXXXX",
  "previewPath": "/home/app/temp/2025-01-01T12-05-00_6281234567890@c.us.pdf"
}
```

If WhatsApp rejects the media, the endpoint returns `502 Bad Gateway` with the underlying reason.

---

## Session Status Tracking

The column `status` on `whatsapp_user` reflects whether the WhatsApp client is awaiting QR scan, connected, disconnected, or encountered authentication issues. Companion columns `last_connected_at` and `last_disconnected_at` capture the most recent state transitions. These values update automatically whenever the client emits lifecycle events.

Inspect the Create Session response (or query `whatsapp_user`) to monitor availability.

---

## Webhook-free Message Flow

- Incoming WhatsApp messages are captured directly by WhatsApp Web.js.
- Attachments are downloaded to the `TEMP_DIR` folder and scheduled for deletion after 24 hours.
- Non-text messages, statuses/stories, and group messages without an explicit bot mention are ignored for AI forwarding.
- Text messages trigger automatic forwarding to the AI backend using the same payload structure as the `/agents/{agentId}/run` endpoint, and any textual reply is delivered back into the originating WhatsApp chat with typing indicators shown while the AI response is pending.
- Metadata sent alongside AI payloads includes contact name, phone number, group name, and whether the chat is a group.

---

## Health Check

`GET /health`

Returns basic uptime telemetry:

```json
{
  "status": "ok",
  "uptime": 123.45,
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

---

## Temporary File Policy

- The service saves both the binary file and metadata in filesystem paths under `${TEMP_DIR}`.
- A background cleanup job removes files older than 24 hours.
- Files are never exposed over HTTP and should be consumed by downstream processors before expiry.
