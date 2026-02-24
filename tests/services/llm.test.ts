import assert from "node:assert/strict";
import test from "node:test";
import { Env } from "../../apps/server/src/config/env";
import { createLlmService } from "../../apps/server/src/services/llm";

function createEnv(): Env {
  return {
    port: 3000,
    databaseUrl: "postgresql://local/test",
    appSecret: "app_secret",
    metaAccessToken: "meta_token",
    metaIgBusinessAccountId: "ig_biz_id",
    llmProvider: "openai",
    openaiApiKey: "openai_key",
    openaiModel: "gpt-4.1-mini"
  };
}

function createLoggerMock(): {
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  infoCalls: unknown[][];
  errorCalls: unknown[][];
} {
  const infoCalls: unknown[][] = [];
  const errorCalls: unknown[][] = [];

  return {
    logger: {
      info: (...args: unknown[]) => infoCalls.push(args),
      error: (...args: unknown[]) => errorCalls.push(args)
    },
    infoCalls,
    errorCalls
  };
}

test("OpenAI service returns parsed structured draft on valid response", async () => {
  const { logger, infoCalls, errorCalls } = createLoggerMock();
  const service = createLlmService(createEnv(), logger as never) as unknown as {
    generateDraft: (text: string) => Promise<{
      intent: string;
      confidence: number;
      reply: string;
      needs_human_approval: boolean;
    }>;
    client: {
      chat: {
        completions: {
          create: (...args: unknown[]) => Promise<{
            choices: Array<{ message: { content: string } }>;
          }>;
        };
      };
    };
  };

  service.client.chat.completions.create = async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            intent: "pricing",
            confidence: 0.92,
            reply: "Thanks for reaching out. Happy to share pricing details.",
            needs_human_approval: false
          })
        }
      }
    ]
  });

  const draft = await service.generateDraft("How much does this cost?");

  assert.equal(draft.intent, "pricing");
  assert.equal(draft.confidence, 0.92);
  assert.equal(draft.needs_human_approval, false);
  assert.match(draft.reply, /pricing/i);
  assert.equal(infoCalls.length, 1);
  assert.equal(errorCalls.length, 0);
});

test("OpenAI service falls back safely when provider call fails", async () => {
  const { logger, errorCalls } = createLoggerMock();
  const service = createLlmService(createEnv(), logger as never) as unknown as {
    generateDraft: (text: string) => Promise<{
      intent: string;
      confidence: number;
      reply: string;
      needs_human_approval: boolean;
    }>;
    client: {
      chat: {
        completions: {
          create: (...args: unknown[]) => Promise<unknown>;
        };
      };
    };
  };

  service.client.chat.completions.create = async () => {
    throw new Error("quota exceeded");
  };

  const draft = await service.generateDraft("Tell me something random");

  assert.equal(draft.intent, "unknown");
  assert.equal(draft.confidence, 0.0);
  assert.equal(draft.needs_human_approval, true);
  assert.match(draft.reply, /team member will review this shortly/i);
  assert.equal(errorCalls.length, 1);
});
