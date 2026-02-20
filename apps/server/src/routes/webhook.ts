import { MessageDirection, Prisma, PrismaClient } from "@prisma/client";
import { FastifyBaseLogger, FastifyInstance } from "fastify";
import { Env } from "../config/env";
import { InMemoryQueue } from "../queue/inMemoryQueue";
import { IgService } from "../services/ig";
import { LlmService } from "../services/llm";
import { RulesService } from "../services/rules";
import { ParsedWebhookJob, MetaMessagingEvent, MetaWebhookPayload } from "../types/meta";
import { verifySignature } from "../utils/verifySignature";

type WebhookRouteDeps = {
  env: Env;
  logger: FastifyBaseLogger;
  queue: InMemoryQueue<ParsedWebhookJob>;
};

type WorkerDeps = {
  env: Env;
  logger: FastifyBaseLogger;
  prisma: PrismaClient;
  llm: LlmService;
  rules: RulesService;
  ig: IgService;
};

export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookRouteDeps
): void {
  app.post<{ Body: MetaWebhookPayload }>(
    "/webhook/instagram",
    {
      config: {
        rawBody: true
      }
    },
    async (request, reply) => {
      const rawSignature = request.headers["x-hub-signature-256"];
      const signature = Array.isArray(rawSignature)
        ? rawSignature[0]
        : rawSignature;
      const rawBody = String((request as { rawBody?: string }).rawBody ?? "");

      if (!verifySignature(rawBody, signature, deps.env.appSecret)) {
        return reply.code(401).send({ error: "Invalid signature" });
      }

      const payload = request.body ?? {};
      const jobs = extractJobs(payload);

      for (const job of jobs) {
        deps.queue.enqueue({
          ...job,
          rawPayload: payload
        });
      }

      deps.logger.info({ queuedJobs: jobs.length }, "Webhook accepted");
      return reply.code(200).send({ ok: true });
    }
  );
}

export function createWebhookWorker(deps: WorkerDeps) {
  return async (job: ParsedWebhookJob): Promise<void> => {
    const receivedAt = Number.isFinite(job.timestamp)
      ? new Date(job.timestamp)
      : new Date();

    await deps.prisma.rawEvent.upsert({
      where: { igMessageId: job.messageId },
      update: {},
      create: {
        igMessageId: job.messageId,
        payload: job.rawPayload as Prisma.InputJsonValue,
        receivedAt
      }
    });

    const existing = await deps.prisma.message.findUnique({
      where: { igMessageId: job.messageId }
    });

    if (existing) {
      deps.logger.info({ igMessageId: job.messageId }, "Duplicate message skipped");
      return;
    }

    const thread = await deps.prisma.thread.upsert({
      where: { igThreadId: job.threadId },
      update: {},
      create: { igThreadId: job.threadId }
    });

    const inbound = await deps.prisma.message.create({
      data: {
        igMessageId: job.messageId,
        threadId: thread.id,
        senderIgId: job.senderId,
        direction: MessageDirection.IN,
        text: job.text,
        receivedAt
      }
    });

    if (!job.text.trim()) {
      await createSkipLog(deps.prisma, inbound.id, "Guardrail: empty message text");
      return;
    }

    if (job.isFromSelfOrSystem) {
      await createSkipLog(deps.prisma, inbound.id, "Guardrail: self/system message");
      return;
    }

    const rulesDraft = deps.rules.generateDraft(job.text);
    const draft = rulesDraft ?? (await deps.llm.generateDraft(job.text));

    await deps.prisma.message.update({
      where: { id: inbound.id },
      data: {
        intent: draft.intent,
        confidence: draft.confidence,
        suggestedReply: draft.reply,
        needsHumanApproval: draft.needs_human_approval
      }
    });

    if (draft.confidence < 0.6 || draft.needs_human_approval) {
      await createSkipLog(
        deps.prisma,
        inbound.id,
        "Guardrail: low confidence or human approval required"
      );
      return;
    }

    try {
      const send = await deps.ig.sendMessage(job.senderId, draft.reply);

      const outbound = await deps.prisma.message.create({
        data: {
          igMessageId: send.messageId,
          threadId: thread.id,
          senderIgId: deps.env.metaIgBusinessAccountId,
          direction: MessageDirection.OUT,
          text: draft.reply,
          receivedAt: new Date()
        }
      });

      await deps.prisma.deliveryLog.create({
        data: {
          messageId: outbound.id,
          status: "SENT",
          latencyMs: send.latencyMs
        }
      });
    } catch (error) {
      await deps.prisma.deliveryLog.create({
        data: {
          messageId: inbound.id,
          status: "ERROR",
          error: toErrorMessage(error)
        }
      });
    }
  };
}

async function createSkipLog(
  prisma: PrismaClient,
  messageId: string,
  reason: string
): Promise<void> {
  await prisma.deliveryLog.create({
    data: {
      messageId,
      status: "SKIPPED",
      error: reason
    }
  });
}

function extractJobs(payload: MetaWebhookPayload): Omit<ParsedWebhookJob, "rawPayload">[] {
  const jobs: Omit<ParsedWebhookJob, "rawPayload">[] = [];

  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const job = eventToJob(entry.id ?? "unknown_thread", event);
      if (job) {
        jobs.push(job);
      }
    }
  }

  return jobs;
}

function eventToJob(
  entryId: string,
  event: MetaMessagingEvent
): Omit<ParsedWebhookJob, "rawPayload"> | null {
  const messageId = event.message?.mid;
  const senderId = event.sender?.id;

  if (!messageId || !senderId) {
    return null;
  }

  return {
    messageId,
    senderId,
    text: event.message?.text ?? "",
    timestamp: event.timestamp ?? Date.now(),
    threadId: event.conversation?.id ?? `${entryId}_${senderId}`,
    isFromSelfOrSystem:
      Boolean(event.message?.is_echo) || event.sender?.id === event.recipient?.id
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
