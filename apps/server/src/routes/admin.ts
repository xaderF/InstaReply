import { MessageDirection, PrismaClient } from "@prisma/client";
import { FastifyBaseLogger, FastifyInstance } from "fastify";
import { Env } from "../config/env";
import { IgService } from "../services/ig";

type AdminRouteDeps = {
  prisma: PrismaClient;
  ig: IgService;
  env: Env;
  logger: FastifyBaseLogger;
};

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRouteDeps
): void {
  app.get("/admin", async (_request, reply) => {
    const messages = await deps.prisma.message.findMany({
      where: { direction: MessageDirection.IN },
      orderBy: { receivedAt: "desc" },
      take: 20
    });

    const rows = messages
      .map((msg) => {
        const confidence =
          typeof msg.confidence === "number" ? msg.confidence.toFixed(2) : "n/a";
        const suggestedReply = msg.suggestedReply ?? "";
        const disabled = suggestedReply ? "" : "disabled";

        return `
          <tr>
            <td>${escapeHtml(msg.id)}</td>
            <td>${escapeHtml(msg.senderIgId)}</td>
            <td>${escapeHtml(msg.text ?? "")}</td>
            <td>${escapeHtml(msg.intent ?? "n/a")} (${confidence})</td>
            <td>
              <form method="POST" action="/admin/send">
                <input type="hidden" name="messageId" value="${escapeHtml(msg.id)}" />
                <textarea name="reply" rows="3" cols="50">${escapeHtml(suggestedReply)}</textarea>
                <button type="submit" ${disabled}>Send</button>
              </form>
            </td>
          </tr>
        `;
      })
      .join("");

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>InstaReply Admin</title>
          <style>
            body { font-family: sans-serif; margin: 24px; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ccc; padding: 8px; vertical-align: top; }
            textarea { width: 100%; }
          </style>
        </head>
        <body>
          <h1>InstaReply Admin</h1>
          <p>Last 20 inbound messages and suggested replies.</p>
          <table>
            <thead>
              <tr>
                <th>Message ID</th>
                <th>Sender</th>
                <th>Inbound Text</th>
                <th>Draft Intent</th>
                <th>Suggested Reply</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </body>
      </html>
    `;

    reply.type("text/html").send(html);
  });

  app.post<{ Body: { messageId?: string; reply?: string } }>(
    "/admin/send",
    async (request, reply) => {
      const messageId = request.body?.messageId;
      const replyText = request.body?.reply?.trim();

      if (!messageId || !replyText) {
        return reply.code(400).send({ error: "messageId and reply are required" });
      }

      const inbound = await deps.prisma.message.findUnique({
        where: { id: messageId }
      });

      if (!inbound || inbound.direction !== MessageDirection.IN) {
        return reply.code(404).send({ error: "Inbound message not found" });
      }

      try {
        const send = await deps.ig.sendMessage(inbound.senderIgId, replyText);

        const outbound = await deps.prisma.message.create({
          data: {
            igMessageId: send.messageId,
            threadId: inbound.threadId,
            senderIgId: deps.env.metaIgBusinessAccountId,
            direction: MessageDirection.OUT,
            text: replyText,
            receivedAt: new Date()
          }
        });

        await deps.prisma.deliveryLog.create({
          data: {
            messageId: outbound.id,
            status: "SENT_MANUAL",
            latencyMs: send.latencyMs
          }
        });

        return reply.redirect("/admin");
      } catch (error) {
        deps.logger.error({ error, messageId }, "Manual send failed");

        await deps.prisma.deliveryLog.create({
          data: {
            messageId: inbound.id,
            status: "ERROR_MANUAL",
            error: toErrorMessage(error)
          }
        });

        return reply.code(500).send({ error: "Failed to send message" });
      }
    }
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
