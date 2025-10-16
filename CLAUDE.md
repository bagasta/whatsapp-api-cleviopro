# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a WhatsApp AI Bridge API built on top of whatsapp-web.js that provisions WhatsApp sessions, exposes QR codes, forwards text messages to an AI backend, and stores metadata in PostgreSQL. The service acts as a bridge between WhatsApp and an AI service, automatically handling message ingestion, AI processing, and response delivery.

## Development Commands

```bash
# Start development server with hot reload
npm run dev

# Start production server
npm start

# No tests currently defined
npm test  # Returns "No tests defined"
```

## Architecture

### Core Components

- **server.js**: Main entry point that bootstraps the application
- **app.js**: Express application setup with middleware and routes
- **config/env.js**: Environment configuration management
- **database/**: PostgreSQL connection and schema management
- **services/**: Core business logic for WhatsApp session management
- **routes/**: Express route definitions
- **middleware/**: Request handling middleware

### Key Services

1. **whatsappSessionManager.js**:
   - Manages WhatsApp client sessions using whatsapp-web.js
   - Handles QR code generation and authentication
   - Processes incoming messages and forwards to AI
   - Manages session lifecycle (create, reconnect, destroy)

2. **aiForwarder.js**:
   - Forwards messages to configured AI backend
   - Handles API key validation
   - Manages timeouts and error handling

3. **sessionBootstrap.js**:
   - Restores persisted sessions on startup
   - Handles automatic reconnection

### Database Schema

Uses PostgreSQL with a single main table `whatsapp_user`:
- Stores user credentials and API keys
- Tracks session status (awaiting_qr, connected, disconnected, auth_failed)
- Records connection timestamps
- Automatically updates `updated_at` via trigger

### Message Flow

1. Text messages received by WhatsApp client
2. Group messages filtered for bot mentions
3. Media attachments temporarily stored (24h TTL)
4. Text forwarded to AI backend with metadata
5. AI responses delivered back to WhatsApp with typing indicators

### Environment Configuration

Required environment variables:
- `DATABASE_URL`: PostgreSQL connection string
- `APP_BASE_URL`: Public base URL (default: http://localhost:8000)

Optional variables:
- `AI_BACKEND_URL`: AI service endpoint
- `DEFAULT_OPENAI_API_KEY`: Fallback API key
- `TEMP_DIR`: Attachment storage directory
- `QR_EXPIRATION_MINUTES`: QR code validity window
- `AI_REQUEST_TIMEOUT_MS`: AI request timeout
- `LOG_LEVEL`: Pino logging verbosity

## API Endpoints

- `POST /sessions` - Create new WhatsApp session (returns QR code)
- `DELETE /sessions/{agentId}` - Destroy session
- `POST /sessions/{agentId}/reconnect` - Force reconnection
- `POST /agents/{agentId}/run` - Public message endpoint with API validation
- `GET /health` - Service health check
- `GET /docs` - Static API documentation

## Session Management

Sessions are persisted using LocalAuth strategy in `.wwebjs_auth/` directory. Each session is identified by `agent-{agentId}`. The manager automatically handles reconnection attempts and maintains connection state in the database.

## Logging

Uses Pino for structured logging. Request logging middleware automatically tracks all HTTP requests with request IDs, durations, and metadata. WhatsApp session events are logged with agent context.