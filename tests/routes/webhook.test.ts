import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import formbody from "@fastify/formbody";
import Fastify, { FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import { Env } from "../../apps/server/src/config/env";
import { InMemoryQueue } from "../../apps/server/src/queue/inMemoryQueue";
import { registerWebhookRoutes } from "../../apps/server/src/routes/webhook";
import { ParsedWebhookJob } from "../../apps/server/src/types/meta";

function sign(rawBodyValue: string, appSecret: string): string {
  const digest = crypto
    .createHmac("sha256", appSecret)
    .update(rawBodyValue, "utf8")
    .digest("hex");
  return `sha256=${digest}`;
}

function createEnv(appSecret: string): Env {
  return {
    port: 3000,
    databaseUrl: "postgresql://local/test",
    appSecret,
    metaAccessToken: "token",
    metaIgBusinessAccountId: "ig_biz_id",
    llmProvider: "openai",
    openaiApiKey: "openai_key",
    openaiModel: "gpt-4.1-mini"
  };
}

async function buildApp(queue: InMemoryQueue<ParsedWebhookJob>, env: Env): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(formbody);
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true
  });

  registerWebhookRoutes(app, {
    env,
    logger: app.log,
    queue
  });

  return app;
}

test("webhook rejects invalid signature", async () => {
  const appSecret = "webhook_secret";
  const env = createEnv(appSecret);
  const queue = new InMemoryQueue<ParsedWebhookJob>();
  const queuedJobs: ParsedWebhookJob[] = [];
  const originalEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = (job: ParsedWebhookJob): void => {
    queuedJobs.push(job);
    originalEnqueue(job);
  };

  const app = await buildApp(queue, env);
  try {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "entry_1",
          messaging: [
            {
              sender: { id: "user_1" },
              recipient: { id: "biz_1" },
              timestamp: Date.now(),
              message: { mid: "mid_1", text: "hello" }
            }
          ]
        }
      ]
    };

    const response = await app.inject({
      method: "POST",
      url: "/webhook/instagram",
      payload,
      headers: {
        "x-hub-signature-256": "sha256=not_valid"
      }
    });

    assert.equal(response.statusCode, 401);
    assert.equal(queuedJobs.length, 0);
  } finally {
    await app.close();
  }
});

test("webhook accepts valid signature and enqueues parsed jobs", async () => {
  const appSecret = "webhook_secret";
  const env = createEnv(appSecret);
  const queue = new InMemoryQueue<ParsedWebhookJob>();
  const queuedJobs: ParsedWebhookJob[] = [];
  const originalEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = (job: ParsedWebhookJob): void => {
    queuedJobs.push(job);
    originalEnqueue(job);
  };

  const app = await buildApp(queue, env);
  try {
    const timestamp = Date.now();
    const payload = {
      object: "instagram",
      entry: [
        {
          id: "entry_1",
          messaging: [
            {
              sender: { id: "user_1" },
              recipient: { id: "biz_1" },
              timestamp,
              conversation: { id: "thread_1" },
              message: { mid: "mid_1", text: "hello there" }
            }
          ]
        }
      ]
    };
    const rawBodyValue = JSON.stringify(payload);
    const signature = sign(rawBodyValue, appSecret);

    const response = await app.inject({
      method: "POST",
      url: "/webhook/instagram",
      payload: rawBodyValue,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(queuedJobs.length, 1);
    assert.equal(queuedJobs[0].messageId, "mid_1");
    assert.equal(queuedJobs[0].senderId, "user_1");
    assert.equal(queuedJobs[0].threadId, "thread_1");
    assert.equal(queuedJobs[0].text, "hello there");
    assert.equal(queuedJobs[0].isFromSelfOrSystem, false);
  } finally {
    await app.close();
  }
});
