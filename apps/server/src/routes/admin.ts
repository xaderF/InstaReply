import { ContactSegment, MessageDirection, PrismaClient } from "@prisma/client";
import { FastifyBaseLogger, FastifyInstance } from "fastify";
import { Env } from "../config/env";
import { IgService } from "../services/ig";
import {
  CONTACT_SEGMENTS,
  ensureAllPolicies,
  isContactSegment
} from "../services/policy";

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
    const policies = await ensureAllPolicies(deps.prisma);

    const contacts = await deps.prisma.contact.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50
    });

    const segmentBySender = new Map(
      contacts.map((contact) => [contact.senderIgId, contact.segment])
    );

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
        const segment = segmentBySender.get(msg.senderIgId) ?? ContactSegment.STRANGER;

        return `
          <tr>
            <td>${escapeHtml(msg.id)}</td>
            <td>${escapeHtml(msg.senderIgId)}</td>
            <td>${escapeHtml(segment)}</td>
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

    const contactRows = contacts
      .map((contact) => {
        const options = CONTACT_SEGMENTS.map((segment) => {
          const selected = segment === contact.segment ? "selected" : "";
          return `<option value="${segment}" ${selected}>${segment}</option>`;
        }).join("");

        return `
          <tr>
            <td>${escapeHtml(contact.senderIgId)}</td>
            <td>
              <form method="POST" action="/admin/contact-segment">
                <input type="hidden" name="senderIgId" value="${escapeHtml(contact.senderIgId)}" />
                <select name="segment">${options}</select>
                <button type="submit">Save</button>
              </form>
            </td>
          </tr>
        `;
      })
      .join("");

    const policyRows = policies
      .map((policy) => {
        const autoChecked = policy.autoSend ? "checked" : "";
        const approvalChecked = policy.requireHumanApproval ? "checked" : "";

        return `
          <tr>
            <td>${escapeHtml(policy.segment)}</td>
            <td>
              <form method="POST" action="/admin/policy">
                <input type="hidden" name="segment" value="${escapeHtml(policy.segment)}" />
                <label>
                  <input type="checkbox" name="autoSend" ${autoChecked} />
                  Auto send
                </label>
                <label style="margin-left: 12px;">
                  <input type="checkbox" name="requireHumanApproval" ${approvalChecked} />
                  Require approval
                </label>
                <div style="margin-top: 8px;">
                  <textarea name="template" rows="3" cols="70">${escapeHtml(
                    policy.template ?? ""
                  )}</textarea>
                </div>
                <button type="submit">Update Policy</button>
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
          <p><a href="/app">Open frontend console</a></p>
          <h2>Segment Policies</h2>
          <p>Set auto-send behavior and optional template per audience segment.</p>
          <table>
            <thead>
              <tr>
                <th>Segment</th>
                <th>Policy Controls</th>
              </tr>
            </thead>
            <tbody>${policyRows}</tbody>
          </table>

          <h2 style="margin-top: 32px;">Contact Segments</h2>
          <p>Manually label senders to differentiate friends, known users, strangers, and VIPs.</p>
          <form method="POST" action="/admin/contact-segment" style="margin-bottom: 12px;">
            <input type="text" name="senderIgId" placeholder="Instagram sender ID" />
            <select name="segment">
              ${CONTACT_SEGMENTS.map((segment) => `<option value="${segment}">${segment}</option>`).join("")}
            </select>
            <button type="submit">Add / Update Contact</button>
          </form>
          <table>
            <thead>
              <tr>
                <th>Sender ID</th>
                <th>Segment</th>
              </tr>
            </thead>
            <tbody>${contactRows}</tbody>
          </table>

          <h2 style="margin-top: 32px;">Inbound Messages</h2>
          <p>Last 20 inbound messages and suggested replies.</p>
          <table>
            <thead>
              <tr>
                <th>Message ID</th>
                <th>Sender</th>
                <th>Segment</th>
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

  app.post<{ Body: { senderIgId?: string; segment?: string } }>(
    "/admin/contact-segment",
    async (request, reply) => {
      const senderIgId = request.body?.senderIgId?.trim();
      const segment = request.body?.segment?.trim();

      if (!senderIgId || !segment || !isContactSegment(segment)) {
        return reply.code(400).send({ error: "senderIgId and valid segment are required" });
      }

      await deps.prisma.contact.upsert({
        where: { senderIgId },
        update: { segment },
        create: {
          senderIgId,
          segment
        }
      });

      return reply.redirect("/admin");
    }
  );

  app.post<{
    Body: {
      segment?: string;
      autoSend?: "on";
      requireHumanApproval?: "on";
      template?: string;
    };
  }>("/admin/policy", async (request, reply) => {
    const segment = request.body?.segment?.trim();

    if (!segment || !isContactSegment(segment)) {
      return reply.code(400).send({ error: "Valid segment is required" });
    }

    const template = request.body?.template?.trim() ?? "";
    const autoSend = request.body?.autoSend === "on";
    const requireHumanApproval = request.body?.requireHumanApproval === "on";

    await deps.prisma.replyPolicy.upsert({
      where: { segment },
      update: {
        autoSend,
        requireHumanApproval,
        template: template.length > 0 ? template : null
      },
      create: {
        segment,
        autoSend,
        requireHumanApproval,
        template: template.length > 0 ? template : null
      }
    });

    return reply.redirect("/admin");
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
