# Language AI App

AI-powered Spanish practice app with multi-provider LLM backend (Anthropic, OpenRouter, OpenAI-compatible, Ollama).

## Run locally

1. Create `.env` in project root:

```
PORT=3000
PROVIDER=anthropic # or openrouter | openai | ollama

# Anthropic
ANTHROPIC_API_KEY=your_key
ANTHROPIC_MODEL=claude-3-5-sonnet-20240620

# OpenRouter
OPENROUTER_API_KEY=your_key
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
APP_URL=http://localhost:5173

# OpenAI-compatible
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4o-mini

# Ollama local
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:14b
```

2. Install and run:

```
npm i
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:3000

## Build and run production

```
npm run build
npm start
```

Serves built frontend from the backend on port 3000.

## Docker

Build and run with Docker:

```
docker build -t language-ai-app .
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY=your_key \
  language-ai-app
```

Or with docker-compose (reads env from your shell):

```
docker compose up --build
```

For Ollama, ensure Ollama is running on your host (default `127.0.0.1:11434`). On macOS, `host.docker.internal` is used inside the container via compose.

## Switching providers

Set `PROVIDER` to one of:

- `anthropic`
- `openrouter`
- `openai`
- `ollama`

Optionally override the default model via corresponding `*_MODEL` env vars.


