import assert from "node:assert/strict";
import test from "node:test";
import formbody from "@fastify/formbody";
import { ContactSegment, MessageDirection, PrismaClient } from "@prisma/client";
import Fastify, { FastifyInstance } from "fastify";
import { Env } from "../../apps/server/src/config/env";
import { registerAdminRoutes } from "../../apps/server/src/routes/admin";
import { IgService } from "../../apps/server/src/services/ig";

type ContactRecord = {
  id: string;
  senderIgId: string;
  segment: ContactSegment;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type MessageRecord = {
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

type ReplyPolicyRecord = {
  id: string;
  segment: ContactSegment;
  autoSend: boolean;
  requireHumanApproval: boolean;
  template: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function createEnv(): Env {
  return {
    port: 3000,
    databaseUrl: "postgresql://local/test",
    appSecret: "app_secret",
    metaAccessToken: "meta_token",
    metaIgBusinessAccountId: "ig_biz_id",
    metaAppId: "",
    metaAppSecret: "",
    metaAppRedirectUri: "",
    llmProvider: "openai",
    openaiApiKey: "openai_key",
    openaiModel: "gpt-4.1-mini"
  };
}

function form(payload: Record<string, string>): string {
  return new URLSearchParams(payload).toString();
}

function createAdminPrismaMock(): {
  prisma: PrismaClient;
  contacts: Map<string, ContactRecord>;
  messages: Map<string, MessageRecord>;
  policies: Map<ContactSegment, ReplyPolicyRecord>;
  deliveryLogs: Array<{ messageId: string; status: string; error?: string | null }>;
} {
  let idCounter = 0;
  const contacts = new Map<string, ContactRecord>();
  const messages = new Map<string, MessageRecord>();
  const policies = new Map<ContactSegment, ReplyPolicyRecord>();
  const deliveryLogs: Array<{ messageId: string; status: string; error?: string | null }> = [];

  const nextId = (prefix: string): string => `${prefix}_${++idCounter}`;

  const prisma = {
    contact: {
      findMany: async ({ take }: { take: number }): Promise<ContactRecord[]> => {
        return [...contacts.values()]
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, take);
      },
      upsert: async ({
        where,
        update,
        create
      }: {
        where: { senderIgId: string };
        update: { segment: ContactSegment };
        create: { senderIgId: string; segment: ContactSegment };
      }): Promise<ContactRecord> => {
        const existing = contacts.get(where.senderIgId);
        if (existing) {
          existing.segment = update.segment;
          existing.updatedAt = new Date();
          contacts.set(existing.senderIgId, existing);
          return existing;
        }

        const now = new Date();
        const created: ContactRecord = {
          id: nextId("contact"),
          senderIgId: create.senderIgId,
          segment: create.segment,
          notes: null,
          createdAt: now,
          updatedAt: now
        };
        contacts.set(created.senderIgId, created);
        return created;
      }
    },
    message: {
      findMany: async ({
        where,
        take
      }: {
        where: { direction: MessageDirection };
        take: number;
      }): Promise<MessageRecord[]> => {
        return [...messages.values()]
          .filter((message) => message.direction === where.direction)
          .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
          .slice(0, take);
      },
      findUnique: async ({
        where
      }: {
        where: { id: string };
      }): Promise<MessageRecord | null> => {
        return messages.get(where.id) ?? null;
      },
      create: async ({
        data
      }: {
        data: {
          igMessageId: string;
          threadId: string;
          senderIgId: string;
          direction: MessageDirection;
          text: string;
          receivedAt: Date;
        };
      }): Promise<MessageRecord> => {
        const created: MessageRecord = {
          id: nextId("message"),
          igMessageId: data.igMessageId,
          threadId: data.threadId,
          senderIgId: data.senderIgId,
          direction: data.direction,
          text: data.text,
          receivedAt: data.receivedAt,
          intent: null,
          confidence: null,
          needsHumanApproval: false,
          suggestedReply: null
        };
        messages.set(created.id, created);
        return created;
      }
    },
    replyPolicy: {
      upsert: async ({
        where,
        update,
        create
      }: {
        where: { segment: ContactSegment };
        update: {
          autoSend: boolean;
          requireHumanApproval: boolean;
          template: string | null;
        };
        create: {
          segment: ContactSegment;
          autoSend: boolean;
          requireHumanApproval: boolean;
          template: string | null;
        };
      }): Promise<ReplyPolicyRecord> => {
        const existing = policies.get(where.segment);
        if (existing) {
          existing.autoSend = update.autoSend;
          existing.requireHumanApproval = update.requireHumanApproval;
          existing.template = update.template;
          existing.updatedAt = new Date();
          policies.set(where.segment, existing);
          return existing;
        }

        const now = new Date();
        const created: ReplyPolicyRecord = {
          id: nextId("policy"),
          segment: create.segment,
          autoSend: create.autoSend,
          requireHumanApproval: create.requireHumanApproval,
          template: create.template,
          createdAt: now,
          updatedAt: now
        };
        policies.set(created.segment, created);
        return created;
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
    contacts,
    messages,
    policies,
    deliveryLogs
  };
}

async function buildApp(prisma: PrismaClient, ig: IgService): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(formbody);
  registerAdminRoutes(app, {
    prisma,
    ig,
    env: createEnv(),
    logger: app.log
  });
  return app;
}

test("GET /admin renders escaped content and policy tables", async () => {
  const db = createAdminPrismaMock();
  const inbound: MessageRecord = {
    id: "inbound_1",
    igMessageId: "mid_1",
    threadId: "thread_1",
    senderIgId: "<script>alert(1)</script>",
    direction: MessageDirection.IN,
    text: "<b>Hello</b>",
    receivedAt: new Date(),
    intent: "pricing",
    confidence: 0.9,
    needsHumanApproval: false,
    suggestedReply: "<img src=x />"
  };
  db.messages.set(inbound.id, inbound);
  db.contacts.set(inbound.senderIgId, {
    id: "contact_1",
    senderIgId: inbound.senderIgId,
    segment: ContactSegment.STRANGER,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date()
  });

  const ig: IgService = {
    sendMessage: async () => ({ messageId: "out_1", latencyMs: 5 })
  };
  const app = await buildApp(db.prisma, ig);

  try {
    const response = await app.inject({ method: "GET", url: "/admin" });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /InstaReply Admin/);
    assert.match(response.body, /&lt;b&gt;Hello&lt;\/b&gt;/);
    assert.match(response.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(response.body, /&lt;img src=x \/&gt;/);
  } finally {
    await app.close();
  }
});

test("POST /admin/contact-segment validates input and updates contact", async () => {
  const db = createAdminPrismaMock();
  const ig: IgService = {
    sendMessage: async () => ({ messageId: "out_1", latencyMs: 5 })
  };
  const app = await buildApp(db.prisma, ig);

  try {
    const invalid = await app.inject({
      method: "POST",
      url: "/admin/contact-segment",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({ senderIgId: "user_1", segment: "NOT_VALID" })
    });
    assert.equal(invalid.statusCode, 400);

    const valid = await app.inject({
      method: "POST",
      url: "/admin/contact-segment",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({ senderIgId: "user_1", segment: "VIP" })
    });
    assert.equal(valid.statusCode, 302);
    assert.equal(valid.headers.location, "/admin");
    assert.equal(db.contacts.get("user_1")?.segment, ContactSegment.VIP);
  } finally {
    await app.close();
  }
});

test("POST /admin/policy upserts policy flags and template", async () => {
  const db = createAdminPrismaMock();
  const ig: IgService = {
    sendMessage: async () => ({ messageId: "out_1", latencyMs: 5 })
  };
  const app = await buildApp(db.prisma, ig);

  try {
    const response = await app.inject({
      method: "POST",
      url: "/admin/policy",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({
        segment: "STRANGER",
        autoSend: "on",
        template: "Thanks for reaching out!"
      })
    });

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "/admin");

    const updated = db.policies.get(ContactSegment.STRANGER);
    assert.ok(updated);
    assert.equal(updated.autoSend, true);
    assert.equal(updated.requireHumanApproval, false);
    assert.equal(updated.template, "Thanks for reaching out!");
  } finally {
    await app.close();
  }
});

test("POST /admin/send handles not-found, success, and send failure flows", async () => {
  const db = createAdminPrismaMock();
  const inbound: MessageRecord = {
    id: "inbound_1",
    igMessageId: "mid_inbound_1",
    threadId: "thread_1",
    senderIgId: "user_77",
    direction: MessageDirection.IN,
    text: "Help please",
    receivedAt: new Date(),
    intent: "general_question",
    confidence: 0.8,
    needsHumanApproval: true,
    suggestedReply: "Thanks for your message."
  };
  db.messages.set(inbound.id, inbound);

  let sendShouldFail = false;
  const ig: IgService = {
    sendMessage: async () => {
      if (sendShouldFail) {
        throw new Error("network fail");
      }
      return { messageId: "meta_out_1", latencyMs: 12 };
    }
  };
  const app = await buildApp(db.prisma, ig);

  try {
    const notFound = await app.inject({
      method: "POST",
      url: "/admin/send",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({ messageId: "missing_id", reply: "test" })
    });
    assert.equal(notFound.statusCode, 404);

    const success = await app.inject({
      method: "POST",
      url: "/admin/send",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({ messageId: inbound.id, reply: "Manual reply text" })
    });
    assert.equal(success.statusCode, 302);
    assert.equal(success.headers.location, "/admin");
    assert.ok(
      [...db.messages.values()].some(
        (message) =>
          message.direction === MessageDirection.OUT && message.text === "Manual reply text"
      )
    );
    assert.ok(db.deliveryLogs.some((log) => log.status === "SENT_MANUAL"));

    sendShouldFail = true;
    const failed = await app.inject({
      method: "POST",
      url: "/admin/send",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({ messageId: inbound.id, reply: "This will fail" })
    });
    assert.equal(failed.statusCode, 500);
    assert.ok(db.deliveryLogs.some((log) => log.status === "ERROR_MANUAL"));
  } finally {
    await app.close();
  }
});
