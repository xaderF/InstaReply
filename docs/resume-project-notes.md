# InstaReply Resume Project Notes

## Project Summary
InstaReply is an Instagram DM auto-responder MVP that receives Meta webhook events, validates signatures, queues work asynchronously, classifies messages, generates replies (rules-first + LLM fallback), and sends responses through the Meta Graph API.

## Tech Stack Used
- Language/runtime: TypeScript + Node.js (`package.json`)
- Backend framework: Fastify (`package.json`, `apps/server/src/index.ts`)
- Request parsing: `@fastify/formbody`, `fastify-raw-body` for signature-safe raw payload access (`apps/server/src/index.ts`)
- Database + ORM: PostgreSQL + Prisma (`prisma/schema.prisma`)
- Validation/config: Zod + dotenv (`apps/server/src/config/env.ts`, `apps/server/src/types/llm.ts`)
- AI integration: OpenAI Chat Completions with structured JSON outputs (`apps/server/src/services/llm.ts`)
- External API integration: Meta Graph API for Instagram outbound messaging (`apps/server/src/services/ig.ts`)
- Dev tooling: `tsx`, TypeScript compiler, Prisma CLI (`package.json`)

## Core Architecture You Implemented
- Secure webhook ingestion with HMAC SHA-256 verification (`apps/server/src/utils/verifySignature.ts`, `apps/server/src/routes/webhook.ts`)
- Immediate 200 ACK pattern + async background queue for non-blocking webhook handling (`apps/server/src/routes/webhook.ts`, `apps/server/src/queue/inMemoryQueue.ts`)
- Idempotent processing via unique message IDs + upsert patterns (`apps/server/src/routes/webhook.ts`, `prisma/schema.prisma`)
- Contact segmentation and policy-driven automation (FRIEND/KNOWN/STRANGER/VIP) (`apps/server/src/services/policy.ts`)
- Hybrid response generation strategy:
  - deterministic keyword rules first (`apps/server/src/services/rules.ts`)
  - LLM fallback with schema validation (`apps/server/src/services/llm.ts`)
- Guardrails for safety and operational control (empty/self messages, confidence threshold, approval gating) (`apps/server/src/routes/webhook.ts`)
- Admin console for policy tuning, contact labeling, and manual send workflow (`apps/server/src/routes/admin.ts`)
- Delivery logging with status + latency fields for observability (`prisma/schema.prisma`, `apps/server/src/services/ig.ts`)

## Performance Test Cases Added
- Benchmark script: `scripts/perf/webhookBench.ts`
- NPM scripts:
  - `npm run perf:webhook`
  - `npm run perf:webhook:resume`
- Output report: `docs/perf/latest-webhook-bench.json`

### Benchmark Scenarios
1. `baseline`: 500 requests, concurrency 25
2. `burst`: 2000 requests, concurrency 100
3. `queue_stress`: 1000 requests, concurrency 50, simulated worker delay 3 ms/job

## Raw Metrics (Generated February 21, 2026)
Source: `docs/perf/latest-webhook-bench.json`

1. Baseline
- Success rate: 100%
- p50 ACK latency: 4.52 ms
- p95 ACK latency: 33.55 ms
- p99 ACK latency: 58.00 ms
- ACK throughput: 2,993 req/s

2. Burst
- Success rate: 100%
- p50 ACK latency: 6.79 ms
- p95 ACK latency: 72.60 ms
- p99 ACK latency: 261.56 ms
- ACK throughput: 5,872 req/s

3. Queue Stress
- Success rate: 100%
- p50 ACK latency: 4.32 ms
- p95 ACK latency: 24.59 ms
- p99 ACK latency: 72.63 ms
- ACK throughput: 6,915 req/s
- Queue drain after dispatch: 3,289.81 ms (shows webhook ACK remains fast even with slower background workers)

## Resume Bullet Ideas (Metric-Backed)
- Built an Instagram DM auto-response backend with Fastify, Prisma, PostgreSQL, and OpenAI, including secure webhook verification and policy-based automation controls.
- Designed an async queue-based webhook pipeline that maintained 100% ACK success in load tests, with p50 latency of 4.5-6.8 ms across 500-2000 request scenarios.
- Scaled webhook intake to 5.9k req/s under burst traffic (2,000 requests @ 100 concurrency) while preserving idempotent processing and delivery observability.
- Implemented rule-first intent handling with LLM fallback and schema validation, plus guardrails for confidence, human approval, and segment-specific policies.
- Added operational admin tooling for contact segmentation, policy tuning, and manual message dispatch to support safe human-in-the-loop workflows.
