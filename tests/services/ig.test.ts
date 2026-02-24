import assert from "node:assert/strict";
import test from "node:test";
import { InstagramGraphService } from "../../apps/server/src/services/ig";

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

test("InstagramGraphService sends message and returns Meta message_id", async () => {
  const originalFetch = globalThis.fetch;
  const { logger, infoCalls } = createLoggerMock();
  let capturedUrl = "";
  let capturedBody = "";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ message_id: "meta_msg_123" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const service = new InstagramGraphService({
      accessToken: "test_token",
      businessAccountId: "ig_biz_123",
      logger: logger as never
    });

    const result = await service.sendMessage("user_42", "Hello from test");

    assert.equal(result.messageId, "meta_msg_123");
    assert.ok(result.latencyMs >= 0);
    assert.equal(capturedUrl, "https://graph.facebook.com/v20.0/ig_biz_123/messages");
    assert.match(capturedBody, /"messaging_product":"instagram"/);
    assert.match(capturedBody, /"recipient":\{"id":"user_42"\}/);
    assert.match(capturedBody, /"message":\{"text":"Hello from test"\}/);
    assert.equal(infoCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InstagramGraphService falls back to generated id when message_id is missing", async () => {
  const originalFetch = globalThis.fetch;
  const { logger } = createLoggerMock();

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const service = new InstagramGraphService({
      accessToken: "test_token",
      businessAccountId: "ig_biz_123",
      logger: logger as never
    });

    const result = await service.sendMessage("user_7", "No message_id response");
    assert.match(result.messageId, /^out_/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("InstagramGraphService throws and logs when Meta API responds with error", async () => {
  const originalFetch = globalThis.fetch;
  const { logger, errorCalls } = createLoggerMock();

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: { message: "Bad token" } }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const service = new InstagramGraphService({
      accessToken: "bad_token",
      businessAccountId: "ig_biz_123",
      logger: logger as never
    });

    await assert.rejects(
      () => service.sendMessage("user_9", "Should fail"),
      /Meta Graph API error: 400/
    );

    assert.equal(errorCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
