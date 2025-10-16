# LangChain API Project Documentation

## Project Overview

This project is a scalable **LangChain Agent API** built with FastAPI that enables creating and managing AI agents with dynamic tool integration. The API provides a comprehensive platform for building AI-powered agents with support for various tools including Google services, document processing, and custom integrations.

### Key Features
- **Multi-layer Authentication**: JWT users + API keys with plan-based expiration
- **Agent Management**: Create, configure, and manage LangChain-based AI agents
- **Dynamic Tool Integration**: Built-in tools plus custom tool registration
- **RAG Support**: Document upload and pgvector-based retrieval
- **OAuth Integration**: Google OAuth with dynamic scope generation
- **Asynchronous Execution**: Background agent execution with session-scoped memory
- **Vector Database**: PostgreSQL with pgvector for embeddings

## Architecture

### Technology Stack
- **Backend**: FastAPI (async web framework)
- **Database**: PostgreSQL 15 with pgvector extension
- **Cache**: Redis 7
- **ORM**: SQLAlchemy 2.0 (async)
- **Authentication**: JWT + OAuth2 (Google)
- **AI Framework**: LangChain + LangGraph
- **Containerization**: Docker & Docker Compose
- **Proxy**: Nginx (reverse proxy)

### Project Structure
```
/home/bagas/Langchain-API-new/
├── app/
│   ├── main.py                 # FastAPI application entry point
│   ├── api/
│   │   └── v1/
│   │       ├── agents.py       # Agent management endpoints
│   │       ├── auth.py         # Authentication endpoints
│   │       └── tools.py        # Tool management endpoints
│   ├── core/
│   │   ├── config.py           # Application configuration
│   │   ├── database.py         # Database connection and setup
│   │   ├── deps.py             # Dependency injection
│   │   └── logging.py          # Logging configuration
│   ├── models/
│   │   ├── user.py             # User model
│   │   ├── agent.py            # Agent model
│   │   ├── auth.py             # Authentication models
│   │   ├── tool.py             # Tool models
│   │   ├── execution.py        # Execution model
│   │   └── embedding.py        # Embedding model for RAG
│   ├── services/
│   │   ├── auth_service.py     # Authentication business logic
│   │   ├── execution_service.py # Agent execution logic
│   │   └── tool_service.py     # Tool management logic
│   └── tools/                  # Built-in tool implementations
├── alembic/                    # Database migrations
├── tests/                      # Test suite
├── docker-compose.yml          # Docker configuration
├── requirements.txt            # Python dependencies
└── CLAUDE.md                   # Development guidelines
```

## Database Schema

### Core Tables

#### 1. Users (`users`)
**Purpose**: Stores user authentication and profile information
```sql
Columns:
- id: UUID (Primary Key)
- email: VARCHAR(255) (Unique, Indexed) - stores normalized email or phone
- password_hash: VARCHAR(255) - bcrypt hashed password
- is_active: BOOLEAN - account activation status
- created_at: TIMESTAMPTZ - registration timestamp
```

#### 2. Agents (`agents`)
**Purpose**: Stores AI agent configurations and settings
```sql
Columns:
- id: UUID (Primary Key)
- user_id: UUID (Foreign Key → users.id)
- name: VARCHAR(255) - agent display name
- config: JSONB - agent configuration (LLM settings, prompts, etc.)
- status: ENUM (active, inactive, deleted)
- mcp_servers: JSONB - MCP server configurations
- allowed_tools: TEXT[] - list of permitted tool names
```

#### 3. Authentication (`auth_tokens`, `api_keys`)

**Auth Tokens** - OAuth token storage:
```sql
Columns:
- id: UUID (Primary Key)
- user_id: UUID (Foreign Key → users.id)
- service: VARCHAR(50) - 'google', 'microsoft', etc.
- access_token: TEXT - encrypted OAuth access token
- refresh_token: TEXT - encrypted OAuth refresh token
- scope: TEXT[] - OAuth scopes array
- expires_at: TIMESTAMPTZ - token expiration
```

**API Keys** - Plan-based API access:
```sql
Columns:
- id: UUID (Primary Key)
- user_id: UUID (Foreign Key → users.id)
- access_token: VARCHAR (Unique) - API key string
- plan_code: ENUM ('PRO_M', 'PRO_Y') - subscription plan
- expires_at: TIMESTAMPTZ - key expiration
- is_active: BOOLEAN - key status
- created_at: TIMESTAMPTZ - creation timestamp
```

#### 4. Tools (`tools`, `agent_tools`)

**Tools Registry**:
```sql
Columns:
- id: UUID (Primary Key)
- name: VARCHAR(255) (Unique, Indexed) - tool identifier
- description: TEXT - tool description
- schema: JSONB - JSON schema for tool parameters
- type: ENUM ('builtin', 'custom') - tool category
```

**Agent-Tool Mapping**:
```sql
Columns:
- agent_id: UUID (Composite Primary Key → agents.id)
- tool_id: UUID (Composite Primary Key → tools.id)
- config: JSONB - tool-specific configuration
```

#### 5. Executions (`executions`)
**Purpose**: Tracks agent execution history and conversation memory
```sql
Columns:
- id: UUID (Primary Key)
- agent_id: UUID (Foreign Key → agents.id)
- input: JSONB - user input/request
- output: JSONB - agent response/output
- session_id: VARCHAR(255) (Indexed) - conversation session
- status: ENUM (pending, running, completed, failed, cancelled)
- duration_ms: INTEGER - execution time in milliseconds
- error_message: TEXT - error details if failed
```

#### 6. Embeddings (`embeddings`)
**Purpose**: RAG functionality with vector storage
```sql
Columns:
- id: UUID (Primary Key)
- agent_id: UUID (Foreign Key → agents.id)
- content: TEXT - original text content
- embedding: VECTOR(1536) - OpenAI embedding vector
- metadata: JSONB - additional metadata
```

### Database Relationships
```
Users (1) ←→ (N) Agents
Users (1) ←→ (N) AuthTokens
Users (1) ←→ (N) ApiKeys
Agents (1) ←→ (N) Executions
Agents (1) ←→ (N) Embeddings
Agents (N) ←→ (N) Tools (through AgentTools)
```

## API Endpoints

### Authentication Endpoints (`/api/v1/auth`)

#### User Registration & Login
- `POST /register` - Create new user account
- `POST /login` - Authenticate user and return JWT token
- `GET /me` - Get current user profile

#### Google OAuth Integration
- `GET /google/authorize` - Initiate Google OAuth flow
- `GET /google/callback` - Handle OAuth callback
- `DELETE /google/revoke` - Revoke Google access

#### API Key Management
- `POST /api-keys` - Generate new API key
- `GET /api-keys` - List user's API keys
- `DELETE /api-keys/{key_id}` - Revoke API key

### Agent Management (`/api/v1/agents`)

#### CRUD Operations
- `GET /` - List user's agents
- `POST /` - Create new agent
- `GET /{agent_id}` - Get agent details
- `PUT /{agent_id}` - Update agent configuration
- `DELETE /{agent_id}` - Delete agent

#### Agent Execution
- `POST /{agent_id}/execute` - Execute agent with input
- `GET /{agent_id}/executions` - List execution history
- `GET /{agent_id}/executions/{execution_id}` - Get execution details
- `POST /{agent_id}/upload` - Upload documents for RAG

### Tool Management (`/api/v1/tools`)

#### Tool Registry
- `GET /` - List available tools
- `GET /{tool_id}` - Get tool details and schema
- `POST /` - Register custom tool
- `PUT /{tool_id}` - Update tool configuration
- `DELETE /{tool_id}` - Remove tool

## Setup Requirements

### Prerequisites
- **Python 3.11+** - Application runtime
- **PostgreSQL 15+** - Database with pgvector extension
- **Redis 7+** - Caching and session storage
- **Docker & Docker Compose** - Containerization (recommended)

### Environment Variables

#### Core Configuration
```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/langchain_api
REDIS_URL=redis://localhost:6379/0

# Security
SECRET_KEY=your-secret-key-here-change-in-production
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=30

# Application
PROJECT_NAME=LangChain Agent API
API_V1_STR=/api/v1
DEBUG=false
LOG_LEVEL=INFO
```

#### OAuth Configuration
```bash
# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:8000/api/v1/auth/google/callback

# Allowed OAuth Scopes (comma-separated)
GOOGLE_SCOPES=https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/spreadsheets
```

#### AI Services
```bash
# OpenAI
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-4-turbo-preview

# Optional: Other AI providers
ANTHROPIC_API_KEY=your-anthropic-key
```

#### CORS Configuration
```bash
# Comma-separated list of allowed origins
BACKEND_CORS_ORIGINS=http://localhost:3000,https://yourdomain.com
```

### Installation Steps

#### 1. Clone and Setup
```bash
git clone <repository-url>
cd Langchain-API-new
```

#### 2. Environment Setup
```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Linux/Mac
# or venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt
```

#### 3. Database Setup
```bash
# Create database
createdb langchain_api

# Enable pgvector extension
DATABASE_URL="postgresql://user:password@localhost:5432/langchain_api" \
  scripts/install_pgvector.sh

# Run migrations
alembic upgrade head
```

#### 4. Environment Configuration
```bash
# Copy environment template
cp .env.example .env

# Edit .env with your configuration
nano .env
```

#### 5. Start Application
```bash
# Development mode
uvicorn app.main:app --reload

# Or with Docker Compose (recommended)
docker-compose up -d
```

### API Usage Workflow

#### 1. User Registration
```bash
curl -X POST "http://localhost:8000/api/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "securepassword"
  }'
```

#### 2. Login and Get JWT Token
```bash
curl -X POST "http://localhost:8000/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "securepassword"
  }'
```

#### 3. Generate API Key
```bash
curl -X POST "http://localhost:8000/api/v1/auth/api-keys" \
  -H "Authorization: Bearer <jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "plan_code": "PRO_M"
  }'
```

#### 4. Create Agent
```bash
curl -X POST "http://localhost:8000/api/v1/agents" \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Email Assistant",
    "config": {
      "model": "gpt-4-turbo-preview",
      "system_message": "You are a helpful email assistant.",
      "temperature": 0.7
    },
    "allowed_tools": ["gmail", "calendar"],
    "mcp_servers": {}
  }'
```

#### 5. Execute Agent
```bash
curl -X POST "http://localhost:8000/api/v1/agents/{agent_id}/execute" \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Check my recent emails",
    "session_id": "user_session_123"
  }'
```

## Built-in Tools

### Google Services
- **Gmail**: Read, send, and manage emails
- **Google Sheets**: Read and write spreadsheet data
- **Google Calendar**: Manage calendar events
- **Google Drive**: Access and manage files

### Document Processing
- **PDF Reader**: Extract text from PDF files
- **Word Processor**: Handle .docx files
- **Excel Reader**: Process .xlsx files
- **PowerPoint Reader**: Extract from .pptx files

### Custom Tools
- **Web Search**: Internet search capabilities
- **Calculator**: Mathematical computations
- **Text Processing**: String manipulation and analysis

## Development Guidelines

### Code Quality
```bash
# Format code
black app/ tests/

# Sort imports
isort app/ tests/

# Lint code
flake8 app/ tests/

# Type checking
mypy app/
```

### Testing
```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=app --cov-report=html

# Run specific test
pytest tests/test_agents.py::test_create_agent -v
```

### Database Migrations
```bash
# Create new migration
alembic revision --autogenerate -m "Description of changes"

# Apply migrations
alembic upgrade head

# Rollback
alembic downgrade -1
```

## Production Deployment

### Docker Configuration
The project includes Docker Compose setup with:
- **Application Container**: FastAPI app with Python 3.11
- **PostgreSQL**: Database with pgvector extension
- **Redis**: Caching and session storage
- **Nginx**: Reverse proxy with SSL support

### Security Considerations
- Use HTTPS in production
- Rotate SECRET_KEY regularly
- Implement rate limiting
- Monitor API usage and logs
- Keep dependencies updated
- Use environment-specific configurations

### Monitoring
- Health check endpoint: `/health`
- Request logging enabled
- Error tracking with structured logging
- Performance metrics available

## API Rate Limits

### Plan-based Limits
- **PRO_M (Monthly)**: 30-day expiration
- **PRO_Y (Yearly)**: 365-day expiration

### Usage Tracking
- Execution history stored in database
- Session-based memory management
- Resource usage monitoring

## Troubleshooting

### Common Issues
1. **Database Connection**: Ensure PostgreSQL is running and pgvector is enabled
2. **OAuth Callbacks**: Verify redirect URIs match configuration
3. **CORS Errors**: Check allowed origins in environment variables
4. **Tool Permissions**: Ensure tools are whitelisted for agents

### Debug Commands
```bash
# Check database connection
docker-compose exec db psql -U postgres -d langchain_api

# View logs
docker-compose logs app

# Test API
curl http://localhost:8000/health
```

This documentation provides a comprehensive overview of the LangChain API project, making it suitable for integration with WhatsApp API development and understanding the complete system architecture.