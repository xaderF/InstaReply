import Fastify from "fastify";
import formbody from "@fastify/formbody";
import rawBody from "fastify-raw-body";
import { env } from "./config/env";
import { prisma } from "./db/prisma";
import { InMemoryQueue } from "./queue/inMemoryQueue";
import { registerAdminRoutes } from "./routes/admin";
import { createWebhookWorker, registerWebhookRoutes } from "./routes/webhook";
import { InstagramGraphService } from "./services/ig";
import { createLlmService } from "./services/llm";
import { KeywordRulesService } from "./services/rules";
import { ParsedWebhookJob } from "./types/meta";

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(formbody);
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true
  });

  const queue = new InMemoryQueue<ParsedWebhookJob>({
    concurrency: 1,
    onError: (error, job) => {
      app.log.error({ error, job }, "Queue job failed");
    }
  });

  const llm = createLlmService(env, app.log);
  const rules = new KeywordRulesService();
  const ig = new InstagramGraphService({
    accessToken: env.metaAccessToken,
    businessAccountId: env.metaIgBusinessAccountId,
    logger: app.log
  });

  queue.start(
    createWebhookWorker({
      env,
      logger: app.log,
      prisma,
      llm,
      rules,
      ig
    })
  );

  app.get("/health", async () => ({ ok: true }));

  registerWebhookRoutes(app, {
    env,
    logger: app.log,
    queue
  });

  registerAdminRoutes(app, {
    prisma,
    ig,
    env,
    logger: app.log
  });

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  await app.listen({ port: env.port, host: "0.0.0.0" });
  app.log.info({ port: env.port }, "Server started");
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
