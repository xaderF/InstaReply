import assert from "node:assert/strict";
import test from "node:test";
import formbody from "@fastify/formbody";
import {
  ConnectionStatus,
  ContactSegment,
  MessageDirection,
  PrismaClient
} from "@prisma/client";
import Fastify, { FastifyInstance } from "fastify";
import { Env } from "../../apps/server/src/config/env";
import { registerFrontendRoutes } from "../../apps/server/src/routes/app";
import { IgService } from "../../apps/server/src/services/ig";

type ConnectionRecord = {
  id: string;
  status: ConnectionStatus;
  pageId: string | null;
  pageName: string | null;
  igBusinessAccountId: string | null;
  accessToken: string | null;
  tokenType: string | null;
  scope: string | null;
  lastError: string | null;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function createEnv(overrides: Partial<Env> = {}): Env {
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
    openaiModel: "gpt-4.1-mini",
    ...overrides
  };
}

function form(payload: Record<string, string>): string {
  return new URLSearchParams(payload).toString();
}

function createPrismaMock(): {
  prisma: PrismaClient;
  connection: ConnectionRecord;
} {
  let idCounter = 0;
  const connection: ConnectionRecord = {
    id: "connection_1",
    status: ConnectionStatus.DISCONNECTED,
    pageId: null,
    pageName: null,
    igBusinessAccountId: null,
    accessToken: null,
    tokenType: null,
    scope: null,
    lastError: null,
    connectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const prisma = {
    instagramConnection: {
      findFirst: async (): Promise<ConnectionRecord | null> => connection,
      create: async (): Promise<ConnectionRecord> => connection,
      update: async ({
        data
      }: {
        where: { id: string };
        data: Partial<ConnectionRecord>;
      }): Promise<ConnectionRecord> => {
        Object.assign(connection, data, { updatedAt: new Date() });
        return connection;
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
      }) => ({
        id: `policy_${++idCounter}`,
        segment: where.segment,
        autoSend: create.autoSend,
        requireHumanApproval: create.requireHumanApproval,
        template: create.template,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    },
    contact: {
      findMany: async () => []
    },
    message: {
      findMany: async ({
        where
      }: {
        where?: { direction?: MessageDirection };
      }) => {
        if (where?.direction && where.direction !== MessageDirection.IN) return [];
        return [
          {
            id: "msg_1",
            senderIgId: "user_1",
            threadId: "thread_1",
            igMessageId: "mid_1",
            text: "Hello",
            intent: "general_question",
            confidence: 0.85,
            suggestedReply: "Hi there!",
            direction: MessageDirection.IN,
            needsHumanApproval: false,
            receivedAt: new Date()
          }
        ];
      }
    }
  };

  return { prisma: prisma as unknown as PrismaClient, connection };
}

async function buildApp(prisma: PrismaClient, env: Env): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(formbody);
  const ig: IgService = {
    sendMessage: async () => ({ messageId: "out_1", latencyMs: 1 })
  };
  registerFrontendRoutes(app, {
    prisma,
    ig,
    env,
    logger: app.log
  });
  return app;
}

test("GET /app renders frontend dashboard", async () => {
  const db = createPrismaMock();
  const app = await buildApp(db.prisma, createEnv());

  try {
    const response = await app.inject({ method: "GET", url: "/app" });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /InstaReply Console/);
    assert.match(response.body, /DISCONNECTED/);
    assert.match(response.body, /Inbound Message Inbox/);
  } finally {
    await app.close();
  }
});

test("GET /app-react renders React shell and script tag", async () => {
  const db = createPrismaMock();
  const app = await buildApp(db.prisma, createEnv());

  try {
    const response = await app.inject({ method: "GET", url: "/app-react" });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /InstaReply React Console/);
    assert.match(response.body, /\/app-react\/static\/reactConsole\.js/);
  } finally {
    await app.close();
  }
});

test("GET /api/app/state returns connection, policies, contacts, and messages", async () => {
  const db = createPrismaMock();
  const app = await buildApp(db.prisma, createEnv());

  try {
    const response = await app.inject({ method: "GET", url: "/api/app/state" });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.ok(payload.connection);
    assert.ok(Array.isArray(payload.policies));
    assert.ok(Array.isArray(payload.contacts));
    assert.ok(Array.isArray(payload.messages));
    assert.ok(Array.isArray(payload.accountSummaries));
    assert.ok(payload.oauth);
  } finally {
    await app.close();
  }
});

test("POST /app/connection/manual saves connection state", async () => {
  const db = createPrismaMock();
  const app = await buildApp(db.prisma, createEnv());

  try {
    const response = await app.inject({
      method: "POST",
      url: "/app/connection/manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: form({
        accessToken: "manual_token",
        igBusinessAccountId: "178412341234",
        pageId: "12345",
        pageName: "Test Page"
      })
    });

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, "/app?notice=Manual connection saved.");
    assert.equal(db.connection.status, ConnectionStatus.CONNECTED);
    assert.equal(db.connection.accessToken, "manual_token");
    assert.equal(db.connection.igBusinessAccountId, "178412341234");
  } finally {
    await app.close();
  }
});

test("GET /oauth/meta/start handles missing oauth config", async () => {
  const db = createPrismaMock();
  const app = await buildApp(db.prisma, createEnv({ metaAppId: "", metaAppSecret: "" }));

  try {
    const response = await app.inject({ method: "GET", url: "/oauth/meta/start" });
    assert.equal(response.statusCode, 302);
    assert.equal(
      response.headers.location,
      "/app?notice=OAuth not configured. Add META_APP_ID and META_APP_SECRET."
    );
    assert.equal(db.connection.status, ConnectionStatus.ERROR);
    assert.match(String(db.connection.lastError), /META_APP_ID/);
  } finally {
    await app.close();
  }
});

test("GET /oauth/meta/start redirects to facebook oauth dialog when configured", async () => {
  const db = createPrismaMock();
  const env = createEnv({
    metaAppId: "123456",
    metaAppSecret: "top_secret",
    metaAppRedirectUri: "https://demo.example.com/oauth/meta/callback"
  });
  const app = await buildApp(db.prisma, env);

  try {
    const response = await app.inject({ method: "GET", url: "/oauth/meta/start" });
    assert.equal(response.statusCode, 302);
    assert.match(
      String(response.headers.location),
      /https:\/\/www\.facebook\.com\/v20\.0\/dialog\/oauth/
    );
    assert.match(String(response.headers.location), /client_id=123456/);
  } finally {
    await app.close();
  }
});
