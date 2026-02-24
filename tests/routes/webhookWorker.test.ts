import assert from "node:assert/strict";
import test from "node:test";
import { ContactSegment, MessageDirection, PrismaClient } from "@prisma/client";
import { Env } from "../../apps/server/src/config/env";
import { createWebhookWorker } from "../../apps/server/src/routes/webhook";
import { LlmDraft } from "../../apps/server/src/types/llm";
import { ParsedWebhookJob } from "../../apps/server/src/types/meta";

type StoredMessage = {
  id: string;
  igMessageId: string;
  threadId: string;
  senderIgId: string;
  direction: MessageDirection;
  text: string | null;
  receivedAt: Date;
  intent: string | null;
  confidence: number | null;
  needsHumanApproval: boolean;
  suggestedReply: string | null;
};

type StoredContact = {
  id: string;
  senderIgId: string;
  segment: ContactSegment;
};

type StoredPolicy = {
  id: string;
  segment: ContactSegment;
  autoSend: boolean;
  requireHumanApproval: boolean;
  template: string | null;
};

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

function createJob(overrides: Partial<ParsedWebhookJob> = {}): ParsedWebhookJob {
  return {
    messageId: "mid_1",
    senderId: "sender_1",
    text: "How much does this cost?",
    timestamp: Date.now(),
    threadId: "thread_1",
    isFromSelfOrSystem: false,
    rawPayload: { object: "instagram", entry: [] },
    ...overrides
  };
}

function createWebhookPrismaMock(): {
  prisma: PrismaClient;
  messagesByIgId: Map<string, StoredMessage>;
  contactsBySender: Map<string, StoredContact>;
  policiesBySegment: Map<ContactSegment, StoredPolicy>;
  deliveryLogs: Array<{ messageId: string; status: string; error?: string | null }>;
} {
  let idCounter = 0;
  const messagesById = new Map<string, StoredMessage>();
  const messagesByIgId = new Map<string, StoredMessage>();
  const threadsByIgId = new Map<string, { id: string; igThreadId: string }>();
  const contactsBySender = new Map<string, StoredContact>();
  const policiesBySegment = new Map<ContactSegment, StoredPolicy>();
  const rawEventsByIgMessageId = new Set<string>();
  const deliveryLogs: Array<{ messageId: string; status: string; error?: string | null }> = [];

  const nextId = (prefix: string): string => `${prefix}_${++idCounter}`;

  const prisma = {
    rawEvent: {
      upsert: async ({
        where
      }: {
        where: { igMessageId: string };
      }): Promise<{ id: string; igMessageId: string }> => {
        rawEventsByIgMessageId.add(where.igMessageId);
        return {
          id: `raw_${where.igMessageId}`,
          igMessageId: where.igMessageId
        };
      }
    },
    message: {
      findUnique: async ({
        where
      }: {
        where: { igMessageId?: string; id?: string };
      }): Promise<StoredMessage | null> => {
        if (where.igMessageId) {
          return messagesByIgId.get(where.igMessageId) ?? null;
        }
        if (where.id) {
          return messagesById.get(where.id) ?? null;
        }
        return null;
      },
      create: async ({
        data
      }: {
        data: {
          igMessageId: string;
          threadId: string;
          senderIgId: string;
          direction: MessageDirection;
          text?: string | null;
          receivedAt: Date;
        };
      }): Promise<StoredMessage> => {
        const created: StoredMessage = {
          id: nextId("message"),
          igMessageId: data.igMessageId,
          threadId: data.threadId,
          senderIgId: data.senderIgId,
          direction: data.direction,
          text: data.text ?? null,
          receivedAt: data.receivedAt,
          intent: null,
          confidence: null,
          needsHumanApproval: false,
          suggestedReply: null
        };
        messagesById.set(created.id, created);
        messagesByIgId.set(created.igMessageId, created);
        return created;
      },
      update: async ({
        where,
        data
      }: {
        where: { id: string };
        data: {
          intent: string;
          confidence: number;
          suggestedReply: string;
          needsHumanApproval: boolean;
        };
      }): Promise<StoredMessage> => {
        const existing = messagesById.get(where.id);
        if (!existing) {
          throw new Error(`Message not found: ${where.id}`);
        }
        existing.intent = data.intent;
        existing.confidence = data.confidence;
        existing.suggestedReply = data.suggestedReply;
        existing.needsHumanApproval = data.needsHumanApproval;
        messagesById.set(existing.id, existing);
        messagesByIgId.set(existing.igMessageId, existing);
        return existing;
      }
    },
    thread: {
      upsert: async ({
        where,
        create
      }: {
        where: { igThreadId: string };
        create: { igThreadId: string };
      }): Promise<{ id: string; igThreadId: string }> => {
        const existing = threadsByIgId.get(where.igThreadId);
        if (existing) return existing;
        const createdThread = {
          id: nextId("thread"),
          igThreadId: create.igThreadId
        };
        threadsByIgId.set(create.igThreadId, createdThread);
        return createdThread;
      }
    },
    contact: {
      upsert: async ({
        where,
        create
      }: {
        where: { senderIgId: string };
        create: { senderIgId: string; segment: ContactSegment };
      }): Promise<StoredContact> => {
        const existing = contactsBySender.get(where.senderIgId);
        if (existing) return existing;
        const createdContact: StoredContact = {
          id: nextId("contact"),
          senderIgId: create.senderIgId,
          segment: create.segment
        };
        contactsBySender.set(createdContact.senderIgId, createdContact);
        return createdContact;
      }
    },
    replyPolicy: {
      upsert: async ({
        where,
        create
      }: {
        where: { segment: ContactSegment };
        create: {
          segment: ContactSegment;
          autoSend: boolean;
          requireHumanApproval: boolean;
          template: string | null;
        };
      }): Promise<StoredPolicy> => {
        const existing = policiesBySegment.get(where.segment);
        if (existing) return existing;
        const createdPolicy: StoredPolicy = {
          id: nextId("policy"),
          segment: create.segment,
          autoSend: create.autoSend,
          requireHumanApproval: create.requireHumanApproval,
          template: create.template
        };
        policiesBySegment.set(createdPolicy.segment, createdPolicy);
        return createdPolicy;
      }
    },
    deliveryLog: {
      create: async ({
        data
      }: {
        data: { messageId: string; status: string; error?: string; latencyMs?: number };
      }): Promise<{ messageId: string; status: string; error?: string | null }> => {
        const created = {
          messageId: data.messageId,
          status: data.status,
          error: data.error ?? null
        };
        deliveryLogs.push(created);
        return created;
      }
    }
  };

  return {
    prisma: prisma as unknown as PrismaClient,
    messagesByIgId,
    contactsBySender,
    policiesBySegment,
    deliveryLogs
  };
}

function createLoggerMock(): { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void } {
  return {
    info: () => undefined,
    error: () => undefined
  };
}

test("webhook worker skips duplicate inbound message IDs", async () => {
  const db = createWebhookPrismaMock();
  const env = createEnv();

  await (db.prisma as unknown as {
    message: {
      create: (args: {
        data: {
          igMessageId: string;
          threadId: string;
          senderIgId: string;
          direction: MessageDirection;
          text: string;
          receivedAt: Date;
        };
      }) => Promise<StoredMessage>;
    };
  }).message.create({
    data: {
      igMessageId: "mid_duplicate",
      threadId: "thread_dup",
      senderIgId: "sender_dup",
      direction: MessageDirection.IN,
      text: "already processed",
      receivedAt: new Date()
    }
  });

  let sendCount = 0;
  const worker = createWebhookWorker({
    env,
    logger: createLoggerMock() as never,
    prisma: db.prisma,
    llm: {
      generateDraft: async (): Promise<LlmDraft> => ({
        intent: "unknown",
        confidence: 0,
        reply: "fallback",
        needs_human_approval: true
      })
    },
    rules: {
      generateDraft: () => null
    },
    ig: {
      sendMessage: async () => {
        sendCount += 1;
        return { messageId: "out_should_not_happen", latencyMs: 1 };
      }
    }
  });

  await worker(createJob({ messageId: "mid_duplicate" }));

  assert.equal(sendCount, 0);
  assert.equal(db.deliveryLogs.length, 0);
});

test("webhook worker logs skip for empty inbound text", async () => {
  const db = createWebhookPrismaMock();
  const env = createEnv();
  let sendCount = 0;

  const worker = createWebhookWorker({
    env,
    logger: createLoggerMock() as never,
    prisma: db.prisma,
    llm: {
      generateDraft: async (): Promise<LlmDraft> => ({
        intent: "general_question",
        confidence: 0.9,
        reply: "hello",
        needs_human_approval: false
      })
    },
    rules: {
      generateDraft: () => null
    },
    ig: {
      sendMessage: async () => {
        sendCount += 1;
        return { messageId: "out_1", latencyMs: 1 };
      }
    }
  });

  await worker(createJob({ messageId: "mid_empty", text: "   " }));

  assert.equal(sendCount, 0);
  assert.equal(db.deliveryLogs.length, 1);
  assert.equal(db.deliveryLogs[0].status, "SKIPPED");
  assert.match(String(db.deliveryLogs[0].error), /empty message text/);
});

test("webhook worker applies FRIEND policy and skips auto-send", async () => {
  const db = createWebhookPrismaMock();
  const env = createEnv();
  let sendCount = 0;

  db.contactsBySender.set("friend_sender", {
    id: "contact_friend",
    senderIgId: "friend_sender",
    segment: ContactSegment.FRIEND
  });

  const worker = createWebhookWorker({
    env,
    logger: createLoggerMock() as never,
    prisma: db.prisma,
    llm: {
      generateDraft: async (): Promise<LlmDraft> => ({
        intent: "general_question",
        confidence: 0.9,
        reply: "llm fallback",
        needs_human_approval: false
      })
    },
    rules: {
      generateDraft: () => ({
        intent: "pricing",
        confidence: 0.95,
        reply: "Rule draft",
        needs_human_approval: false
      })
    },
    ig: {
      sendMessage: async () => {
        sendCount += 1;
        return { messageId: "out_1", latencyMs: 1 };
      }
    }
  });

  await worker(createJob({ messageId: "mid_friend", senderId: "friend_sender" }));

  assert.equal(sendCount, 0);
  assert.equal(db.deliveryLogs.length, 1);
  assert.equal(db.deliveryLogs[0].status, "SKIPPED");
  assert.match(String(db.deliveryLogs[0].error), /auto-send disabled for segment FRIEND/);
});

test("webhook worker auto-sends for default STRANGER policy on confident rule draft", async () => {
  const db = createWebhookPrismaMock();
  const env = createEnv();
  let sendCount = 0;

  const worker = createWebhookWorker({
    env,
    logger: createLoggerMock() as never,
    prisma: db.prisma,
    llm: {
      generateDraft: async (): Promise<LlmDraft> => ({
        intent: "unknown",
        confidence: 0.1,
        reply: "llm fallback",
        needs_human_approval: true
      })
    },
    rules: {
      generateDraft: () => ({
        intent: "shipping",
        confidence: 0.91,
        reply: "Shipping reply",
        needs_human_approval: false
      })
    },
    ig: {
      sendMessage: async () => {
        sendCount += 1;
        return { messageId: "out_sent_1", latencyMs: 9 };
      }
    }
  });

  await worker(createJob({ messageId: "mid_send_ok", senderId: "stranger_sender" }));

  assert.equal(sendCount, 1);

  const inbound = db.messagesByIgId.get("mid_send_ok");
  assert.ok(inbound);
  assert.equal(inbound.intent, "shipping");
  assert.equal(inbound.suggestedReply, "Shipping reply");

  const outbound = [...db.messagesByIgId.values()].find(
    (message) => message.igMessageId === "out_sent_1" && message.direction === MessageDirection.OUT
  );
  assert.ok(outbound);
  assert.ok(db.deliveryLogs.some((log) => log.status === "SENT"));
});

test("webhook worker falls back to LLM draft and records send errors", async () => {
  const db = createWebhookPrismaMock();
  const env = createEnv();

  const worker = createWebhookWorker({
    env,
    logger: createLoggerMock() as never,
    prisma: db.prisma,
    llm: {
      generateDraft: async (): Promise<LlmDraft> => ({
        intent: "general_question",
        confidence: 0.93,
        reply: "LLM reply",
        needs_human_approval: false
      })
    },
    rules: {
      generateDraft: () => null
    },
    ig: {
      sendMessage: async () => {
        throw new Error("Meta unavailable");
      }
    }
  });

  await worker(
    createJob({
      messageId: "mid_llm_fallback",
      senderId: "stranger_llm",
      text: "Completely unrelated question"
    })
  );

  const inbound = db.messagesByIgId.get("mid_llm_fallback");
  assert.ok(inbound);
  assert.equal(inbound.intent, "general_question");
  assert.equal(inbound.suggestedReply, "LLM reply");
  assert.ok(db.deliveryLogs.some((log) => log.status === "ERROR"));
  assert.ok(db.deliveryLogs.some((log) => String(log.error).includes("Meta unavailable")));
});
