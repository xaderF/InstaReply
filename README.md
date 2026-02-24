# InstaReply

Instagram DM auto-responder MVP built to demonstrate practical backend + LLM integration skills for internships/co-op recruiting.

This is intentionally an MVP, not a production-ready SaaS.

## What This Project Demonstrates

- Secure webhook ingestion with HMAC verification (`X-Hub-Signature-256`)
- Async queue-based processing (fast webhook ACK + background work)
- Idempotent persistence with Prisma + PostgreSQL
- Rule-first reply drafting with OpenAI fallback
- Segment-based automation policies (`FRIEND`, `KNOWN`, `STRANGER`, `VIP`)
- Admin panel for contact segmentation, policy tuning, and manual send

## Stack

- Node.js + TypeScript
- Fastify
- Prisma + PostgreSQL
- OpenAI API (`chat.completions`)
- Meta Graph API (Instagram outbound messaging)

## Verified Status (February 24, 2026)

The following checks were run in this repo:

- `npm run test` -> 13/13 passing
- `npm run build` -> passes
- `npm run prisma:generate` -> passes
- `npm run perf:webhook` -> passes (quick benchmark)
- Server smoke check: `GET /health` returns `{"ok":true}`

## Prerequisites

- Node.js 20+ (tested with Node 25.3.0)
- npm
- PostgreSQL 14+
- Optional: `ngrok` if you want external webhook callbacks into local dev

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Set these values:

- `PORT` - local server port
- `DATABASE_URL` - PostgreSQL connection string
- `APP_SECRET` - Meta app secret (also used for local signature testing)
- `META_ACCESS_TOKEN` - Meta token for sending outbound Instagram messages
- `META_IG_BUSINESS_ACCOUNT_ID` - IG business account ID
- `LLM_PROVIDER` - currently only `openai`
- `OPENAI_API_KEY` - OpenAI API key
- `OPENAI_MODEL` - default `gpt-4.1-mini`

Note: for local-only testing without real Meta/OpenAI calls, values can be placeholders except `DATABASE_URL` must point to a working local Postgres instance.

## Local Setup

1. Install dependencies:
```bash
npm install
```

2. Start Postgres (example with Docker):
```bash
docker run --name instareply-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=instareply \
  -p 5432:5432 \
  -d postgres:16
```

3. Sync schema and generate Prisma client:
```bash
npx prisma db push
npm run prisma:generate
```

4. Start the server:
```bash
npm run dev
```

5. Smoke test:
```bash
curl http://localhost:3000/health
```

6. Open admin UI:
`http://localhost:3000/admin`

## How To Test Locally

### 1) Automated checks

```bash
npm run test
npm run build
npm run perf:webhook
```

### 2) Manual webhook simulation (no Meta dashboard needed)

1. Keep server running locally.
2. Export your app secret from `.env`:
```bash
export APP_SECRET='your_meta_app_secret'
```
3. Send a signed Instagram-style webhook event:
```bash
BODY='{"object":"instagram","entry":[{"id":"ig_biz","messaging":[{"sender":{"id":"user_123"},"recipient":{"id":"ig_biz"},"timestamp":1700000000000,"conversation":{"id":"thread_user_123"},"message":{"mid":"mid_local_001","text":"How much does this cost?"}}]}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$APP_SECRET" -hex | awk '{print $NF}')

curl -i http://localhost:3000/webhook/instagram \
  -H "content-type: application/json" \
  -H "x-hub-signature-256: sha256=$SIG" \
  -d "$BODY"
```

4. Open `/admin` and confirm the inbound message and suggested reply were recorded.

Tip: If you do not want outbound API calls during local testing, set `STRANGER` policy `Auto send` off in `/admin` before sending events.

## Running Against Real Meta Webhooks

1. Run app locally: `npm run dev`
2. Expose with ngrok: `ngrok http 3000`
3. Configure Meta callback URL to:
`https://<your-ngrok-id>.ngrok.io/webhook/instagram`
4. Send real DMs and monitor `/admin` + logs

## NPM Scripts

- `npm run dev` - start dev server with watch mode
- `npm run build` - compile TypeScript into `dist/`
- `npm run start` - run compiled server
- `npm run test` - run Node test suite via `tsx`
- `npm run prisma:migrate` - run Prisma migrate dev
- `npm run prisma:generate` - generate Prisma client
- `npm run perf:webhook` - run quick webhook benchmark
- `npm run perf:webhook:resume` - run multi-scenario benchmark and save report

## API Endpoints

- `GET /health`
- `POST /webhook/instagram`
- `GET /admin`
- `POST /admin/contact-segment`
- `POST /admin/policy`
- `POST /admin/send`

## Repo Layout

```text
apps/server/src/
  config/env.ts
  db/prisma.ts
  queue/inMemoryQueue.ts
  routes/admin.ts
  routes/webhook.ts
  services/{ig,llm,policy,rules}.ts
  utils/verifySignature.ts
prisma/schema.prisma
scripts/perf/webhookBench.ts
tests/
```

## Current Limitations

- In-memory queue only (no durable broker)
- No auth around `/admin`
- Designed as a backend MVP for portfolio/demo use
