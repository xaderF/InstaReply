# InstaReply MVP

Instagram DM auto-responder MVP built with Node.js, TypeScript, Fastify, Prisma, and PostgreSQL.

## Architecture Overview

- Fastify webhook endpoint receives Meta Instagram DM events.
- Webhook route validates `X-Hub-Signature-256` and immediately returns `200 OK`.
- Events are pushed to an in-memory async queue for background processing.
- Worker persists `RawEvent`, `Thread`, and dedupe-safe inbound `Message`.
- Worker maps sender to a contact segment (`FRIEND`, `KNOWN`, `STRANGER`, `VIP`).
- Per-segment policy controls auto-send, human approval, and optional custom template.
- Draft generation runs with policy template override, otherwise rules-first fallback to OpenAI LLM.
- Safety guardrails decide whether to auto-send or skip.
- Outbound messages are sent via Meta Graph API and logged in `DeliveryLog`.
- `/admin` page lets you manage segment labels/policies and send drafts manually.

## Key Properties

- Webhook-driven ingestion with retry-safe idempotent processing
- Structured LLM outputs (JSON) + validation for deterministic behavior
- Persisted conversation state + delivery metrics for observability

## Repo Structure

```text
apps/server/
  src/
    index.ts
    routes/webhook.ts
    routes/admin.ts
    services/ig.ts
    services/llm.ts
    services/rules.ts
    services/policy.ts
    db/prisma.ts
    utils/verifySignature.ts
    queue/inMemoryQueue.ts
    types/meta.ts
    types/llm.ts
    config/env.ts
prisma/
  schema.prisma
.env.example
README.md
package.json
tsconfig.json
```

## Required Environment Variables

Copy `.env.example` to `.env` and set:

- `PORT`
- `DATABASE_URL`
- `APP_SECRET`
- `META_ACCESS_TOKEN`
- `META_IG_BUSINESS_ACCOUNT_ID`
- `LLM_PROVIDER` (`openai`)
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

## Local Run (with ngrok)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Generate Prisma client:
   ```bash
   npm run prisma:generate
   ```
3. Run migrations:
   ```bash
   npm run prisma:migrate
   ```
4. Start server:
   ```bash
   npm run dev
   ```
5. Expose local server:
   ```bash
   ngrok http 3000
   ```
6. Configure Meta webhook callback URL to:
   `https://<ngrok-id>.ngrok.io/webhook/instagram`

## Scripts

- `npm run dev` - start dev server with watch mode
- `npm run build` - compile TypeScript
- `npm run start` - run compiled app
- `npm run prisma:migrate` - run Prisma migrations
- `npm run prisma:generate` - generate Prisma client

## Deploy Notes (Render)

1. Create a Render Web Service from this repository.
2. Set build command: `npm install && npm run prisma:generate && npm run build`
3. Set start command: `npm run start`
4. Add a Render PostgreSQL instance and set `DATABASE_URL`.
5. Set env vars from `.env.example`.
6. Run `npm run prisma:migrate` once (Render shell or CI step) before traffic.
7. Configure Meta webhook URL to your Render service URL:
   `https://<your-render-service>/webhook/instagram`

## Endpoints

- `GET /health`
- `POST /webhook/instagram`
- `GET /admin`
- `POST /admin/contact-segment`
- `POST /admin/policy`
- `POST /admin/send`
