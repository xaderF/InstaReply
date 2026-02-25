import { readFile } from "node:fs/promises";
import path from "node:path";
import { ContactSegment, MessageDirection, PrismaClient } from "@prisma/client";
import { FastifyBaseLogger, FastifyInstance } from "fastify";
import { Env } from "../config/env";
import {
  disconnectInstagramConnection,
  getOrCreateInstagramConnection,
  markInstagramConnectionError,
  upsertConnectedInstagramConnection
} from "../services/connection";
import {
  CONTACT_SEGMENTS,
  ensureAllPolicies,
  isContactSegment
} from "../services/policy";
import { IgService } from "../services/ig";

type FrontendRouteDeps = {
  prisma: PrismaClient;
  ig: IgService;
  env: Env;
  logger: FastifyBaseLogger;
};

type MetaTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
};

type MetaAccountsResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    instagram_business_account?: {
      id?: string;
      username?: string;
    };
  }>;
};

const REACT_CONSOLE_JS_PATH = path.resolve(
  process.cwd(),
  "apps/server/src/public/reactConsole.js"
);

export function registerFrontendRoutes(app: FastifyInstance, deps: FrontendRouteDeps): void {
  app.get("/app-react", async (_request, reply) => {
    reply.type("text/html").send(renderReactConsoleShell());
  });

  app.get("/app-react/static/reactConsole.js", async (_request, reply) => {
    const source = await readFile(REACT_CONSOLE_JS_PATH, "utf8");
    reply.type("application/javascript").send(source);
  });

  app.get("/api/app/state", async (_request, reply) => {
    const state = await loadConsoleState(deps.prisma);
    return reply.send({
      ...state,
      oauth: {
        ready:
          deps.env.metaAppId.trim().length > 0 &&
          deps.env.metaAppSecret.trim().length > 0,
        startUrl: "/oauth/meta/start",
        configuredRedirect: deps.env.metaAppRedirectUri.trim() || null
      }
    });
  });

  app.post<{
    Body: {
      accessToken?: string;
      igBusinessAccountId?: string;
      pageId?: string;
      pageName?: string;
    };
  }>("/api/app/connection/manual", async (request, reply) => {
    const accessToken = request.body?.accessToken?.trim();
    const igBusinessAccountId = request.body?.igBusinessAccountId?.trim();

    if (!accessToken || !igBusinessAccountId) {
      return reply.code(400).send({ error: "accessToken and igBusinessAccountId are required" });
    }

    const connection = await upsertConnectedInstagramConnection(deps.prisma, {
      accessToken,
      igBusinessAccountId,
      pageId: request.body?.pageId?.trim() || null,
      pageName: request.body?.pageName?.trim() || null,
      scope: "manual",
      tokenType: "manual"
    });

    return reply.send({ ok: true, connection });
  });

  app.post("/api/app/connection/disconnect", async (_request, reply) => {
    const connection = await disconnectInstagramConnection(deps.prisma);
    return reply.send({ ok: true, connection });
  });

  app.post<{
    Body: {
      senderIgId?: string;
      segment?: string;
    };
  }>("/api/app/contact-segment", async (request, reply) => {
    const senderIgId = request.body?.senderIgId?.trim();
    const segment = request.body?.segment?.trim();

    if (!senderIgId || !segment || !isContactSegment(segment)) {
      return reply.code(400).send({ error: "senderIgId and valid segment are required" });
    }

    const contact = await deps.prisma.contact.upsert({
      where: { senderIgId },
      update: { segment },
      create: {
        senderIgId,
        segment
      }
    });

    return reply.send({ ok: true, contact });
  });

  app.post<{
    Body: {
      segment?: string;
      autoSend?: boolean;
      requireHumanApproval?: boolean;
      template?: string;
    };
  }>("/api/app/policy", async (request, reply) => {
    const segment = request.body?.segment?.trim();

    if (!segment || !isContactSegment(segment)) {
      return reply.code(400).send({ error: "Valid segment is required" });
    }

    const template = request.body?.template?.trim() ?? "";
    const autoSend = Boolean(request.body?.autoSend);
    const requireHumanApproval = Boolean(request.body?.requireHumanApproval);

    const policy = await deps.prisma.replyPolicy.upsert({
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

    return reply.send({ ok: true, policy });
  });

  app.post<{
    Body: {
      messageId?: string;
      reply?: string;
    };
  }>("/api/app/send", async (request, reply) => {
    const messageId = request.body?.messageId?.trim();
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
      const senderIgId = await resolveOutboundSenderId(deps.prisma, deps.env);

      const outbound = await deps.prisma.message.create({
        data: {
          igMessageId: send.messageId,
          threadId: inbound.threadId,
          senderIgId,
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

      return reply.send({ ok: true, outbound });
    } catch (error) {
      deps.logger.error({ error, messageId }, "React console manual send failed");

      await deps.prisma.deliveryLog.create({
        data: {
          messageId: inbound.id,
          status: "ERROR_MANUAL",
          error: toErrorMessage(error)
        }
      });

      return reply.code(500).send({ error: "Failed to send message" });
    }
  });

  app.get<{ Querystring: { notice?: string } }>("/app", async (request, reply) => {
    const connection = await getOrCreateInstagramConnection(deps.prisma);
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
              <form method="POST" action="/admin/contact-segment" class="inline-form">
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
              <form method="POST" action="/admin/policy" class="stack-form">
                <input type="hidden" name="segment" value="${escapeHtml(policy.segment)}" />
                <div class="toggles">
                  <label>
                    <input type="checkbox" name="autoSend" ${autoChecked} />
                    Auto send
                  </label>
                  <label>
                    <input type="checkbox" name="requireHumanApproval" ${approvalChecked} />
                    Require approval
                  </label>
                </div>
                <textarea name="template" rows="3" placeholder="Optional fixed template for this segment">${escapeHtml(
                  policy.template ?? ""
                )}</textarea>
                <button type="submit">Update</button>
              </form>
            </td>
          </tr>
        `;
      })
      .join("");

    const messageRows = messages
      .map((message) => {
        const confidence =
          typeof message.confidence === "number" ? message.confidence.toFixed(2) : "n/a";
        const suggestedReply = message.suggestedReply ?? "";
        const disabled = suggestedReply ? "" : "disabled";
        const segment = segmentBySender.get(message.senderIgId) ?? ContactSegment.STRANGER;

        return `
          <tr>
            <td>${escapeHtml(message.senderIgId)}</td>
            <td>${escapeHtml(segment)}</td>
            <td>${escapeHtml(message.text ?? "")}</td>
            <td>${escapeHtml(message.intent ?? "n/a")} (${confidence})</td>
            <td>
              <form method="POST" action="/admin/send" class="stack-form">
                <input type="hidden" name="messageId" value="${escapeHtml(message.id)}" />
                <textarea name="reply" rows="3">${escapeHtml(suggestedReply)}</textarea>
                <button type="submit" ${disabled}>Send Reply</button>
              </form>
            </td>
          </tr>
        `;
      })
      .join("");

    const currentHost = request.headers.host ?? "localhost:3000";
    const inferredCallback = `${request.protocol}://${currentHost}/oauth/meta/callback`;
    const configuredCallback = deps.env.metaAppRedirectUri.trim();
    const oauthReady = deps.env.metaAppId.trim().length > 0 && deps.env.metaAppSecret.trim().length > 0;
    const notice = request.query.notice?.trim() ?? "";

    const html = `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>InstaReply Console</title>
          <style>
            :root {
              --bg-top: #fffbf5;
              --bg-bottom: #f0f4ff;
              --card: rgba(255, 255, 255, 0.82);
              --ink: #1a1a2b;
              --muted: #5f667a;
              --line: rgba(39, 44, 72, 0.14);
              --accent: #ff6a3d;
              --accent-2: #2a6fdb;
              --ok: #0f8a4f;
              --warn: #d27f00;
              --err: #c22f44;
              --radius: 16px;
            }

            * { box-sizing: border-box; }

            body {
              margin: 0;
              min-height: 100vh;
              font-family: "Avenir Next", "Segoe UI", "Noto Sans", sans-serif;
              color: var(--ink);
              background:
                radial-gradient(circle at 6% 10%, rgba(255, 106, 61, 0.26), transparent 36%),
                radial-gradient(circle at 90% 8%, rgba(42, 111, 219, 0.22), transparent 33%),
                linear-gradient(160deg, var(--bg-top), var(--bg-bottom));
              padding: 24px;
            }

            .shell {
              max-width: 1200px;
              margin: 0 auto;
              display: grid;
              gap: 18px;
            }

            .hero {
              border: 1px solid var(--line);
              border-radius: var(--radius);
              background: var(--card);
              backdrop-filter: blur(8px);
              padding: 20px;
              box-shadow: 0 14px 30px rgba(17, 24, 47, 0.08);
              animation: fade-in 260ms ease-out;
            }

            .hero h1 {
              margin: 0;
              font-size: clamp(1.5rem, 2.8vw, 2.2rem);
              letter-spacing: 0.01em;
            }

            .hero p {
              margin: 10px 0 0;
              color: var(--muted);
              max-width: 76ch;
            }

            .notice {
              margin-top: 14px;
              border-radius: 12px;
              padding: 10px 12px;
              font-size: 0.92rem;
              border: 1px solid rgba(42, 111, 219, 0.24);
              background: rgba(42, 111, 219, 0.08);
            }

            .grid {
              display: grid;
              gap: 18px;
              grid-template-columns: repeat(12, minmax(0, 1fr));
            }

            .card {
              grid-column: span 12;
              border-radius: var(--radius);
              border: 1px solid var(--line);
              background: var(--card);
              backdrop-filter: blur(8px);
              box-shadow: 0 10px 24px rgba(17, 24, 47, 0.06);
              padding: 16px;
              animation: rise-in 300ms ease-out;
            }

            .card h2 {
              margin: 0 0 8px;
              font-size: 1.05rem;
            }

            .subtle {
              margin: 0;
              color: var(--muted);
              font-size: 0.92rem;
            }

            .meta {
              margin-top: 12px;
              display: grid;
              gap: 8px;
              font-size: 0.92rem;
            }

            .badge {
              display: inline-flex;
              align-items: center;
              border-radius: 999px;
              padding: 6px 10px;
              font-weight: 600;
              font-size: 0.82rem;
              border: 1px solid transparent;
            }

            .badge.ok {
              color: var(--ok);
              background: rgba(15, 138, 79, 0.1);
              border-color: rgba(15, 138, 79, 0.24);
            }

            .badge.warn {
              color: var(--warn);
              background: rgba(210, 127, 0, 0.12);
              border-color: rgba(210, 127, 0, 0.24);
            }

            .badge.err {
              color: var(--err);
              background: rgba(194, 47, 68, 0.11);
              border-color: rgba(194, 47, 68, 0.24);
            }

            .actions {
              margin-top: 12px;
              display: flex;
              flex-wrap: wrap;
              gap: 10px;
            }

            button,
            .button-link {
              border: 1px solid transparent;
              border-radius: 11px;
              font: inherit;
              font-weight: 600;
              padding: 8px 12px;
              cursor: pointer;
              text-decoration: none;
              display: inline-flex;
              align-items: center;
              justify-content: center;
            }

            .primary {
              color: white;
              background: linear-gradient(135deg, var(--accent), #ff895e);
              box-shadow: 0 5px 15px rgba(255, 106, 61, 0.28);
            }

            .secondary {
              color: var(--accent-2);
              border-color: rgba(42, 111, 219, 0.28);
              background: rgba(42, 111, 219, 0.08);
            }

            .danger {
              color: var(--err);
              border-color: rgba(194, 47, 68, 0.3);
              background: rgba(194, 47, 68, 0.07);
            }

            form {
              margin: 0;
            }

            .manual-grid {
              margin-top: 14px;
              display: grid;
              gap: 8px;
              grid-template-columns: repeat(2, minmax(0, 1fr));
            }

            input,
            select,
            textarea {
              width: 100%;
              padding: 8px 10px;
              border-radius: 10px;
              border: 1px solid rgba(39, 44, 72, 0.2);
              font: inherit;
              color: var(--ink);
              background: rgba(255, 255, 255, 0.92);
            }

            table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 10px;
              font-size: 0.92rem;
            }

            th,
            td {
              border: 1px solid var(--line);
              padding: 10px;
              vertical-align: top;
              text-align: left;
            }

            th {
              background: rgba(255, 255, 255, 0.7);
            }

            .inline-form {
              display: flex;
              gap: 8px;
              align-items: center;
            }

            .stack-form {
              display: grid;
              gap: 8px;
            }

            .toggles {
              display: flex;
              flex-wrap: wrap;
              gap: 10px;
              color: var(--muted);
            }

            .wide { grid-column: span 12; }
            .half { grid-column: span 6; }

            @media (max-width: 960px) {
              body { padding: 14px; }
              .half { grid-column: span 12; }
              .manual-grid { grid-template-columns: 1fr; }
              .inline-form { flex-direction: column; align-items: stretch; }
            }

            @keyframes fade-in {
              from { opacity: 0; transform: translateY(6px); }
              to { opacity: 1; transform: translateY(0); }
            }

            @keyframes rise-in {
              from { opacity: 0; transform: translateY(10px); }
              to { opacity: 1; transform: translateY(0); }
            }
          </style>
        </head>
        <body>
          <main class="shell">
            <section class="hero">
              <h1>InstaReply Console</h1>
              <p>Connect your Instagram app, review inbound DMs, and tune automated reply behavior by audience segment.</p>
              <p style="margin-top:12px;">
                <a href="/app-react" class="button-link secondary">Back to New Tabbed Layout</a>
              </p>
              ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
            </section>

            <section class="grid">
              <article class="card half">
                <h2>Instagram Connection</h2>
                <p class="subtle">OAuth connect is preferred. Manual values are available for local demos and testing.</p>
                <div class="meta">
                  <div>
                    ${statusBadge(connection.status)}
                  </div>
                  <div><strong>IG Business ID:</strong> ${escapeHtml(connection.igBusinessAccountId ?? "Not set")}</div>
                  <div><strong>Page:</strong> ${escapeHtml(connection.pageName ?? "Not set")} (${escapeHtml(connection.pageId ?? "n/a")})</div>
                  <div><strong>Last Error:</strong> ${escapeHtml(connection.lastError ?? "None")}</div>
                  <div><strong>OAuth Redirect:</strong> ${escapeHtml(
                    configuredCallback || inferredCallback
                  )}</div>
                </div>

                <div class="actions">
                  <a href="/oauth/meta/start" class="button-link primary">Connect With Meta OAuth</a>
                  <form method="POST" action="/app/connection/disconnect">
                    <button type="submit" class="danger">Disconnect</button>
                  </form>
                </div>
                ${
                  oauthReady
                    ? ""
                    : `<p class="subtle" style="margin-top:10px;">To enable OAuth, set <code>META_APP_ID</code> and <code>META_APP_SECRET</code> in your environment.</p>`
                }

                <form method="POST" action="/app/connection/manual" class="stack-form" style="margin-top:12px;">
                  <div class="manual-grid">
                    <div>
                      <label>Access Token</label>
                      <input name="accessToken" placeholder="EAAB..." required />
                    </div>
                    <div>
                      <label>Instagram Business Account ID</label>
                      <input name="igBusinessAccountId" placeholder="1784..." required />
                    </div>
                    <div>
                      <label>Page ID (optional)</label>
                      <input name="pageId" placeholder="1234567890" />
                    </div>
                    <div>
                      <label>Page Name (optional)</label>
                      <input name="pageName" placeholder="My Brand Page" />
                    </div>
                  </div>
                  <button type="submit" class="secondary">Save Manual Connection</button>
                </form>
              </article>

              <article class="card half">
                <h2>Quick Add Contact Segment</h2>
                <p class="subtle">Set sender segment to control policy behavior.</p>
                <form method="POST" action="/admin/contact-segment" class="stack-form" style="margin-top:10px;">
                  <input name="senderIgId" placeholder="Instagram sender ID" required />
                  <select name="segment">
                    ${CONTACT_SEGMENTS.map((segment) => `<option value="${segment}">${segment}</option>`).join("")}
                  </select>
                  <button type="submit" class="secondary">Add Or Update Contact</button>
                </form>
              </article>

              <article class="card wide">
                <h2>Segment Policies</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Segment</th>
                      <th>Policy Controls</th>
                    </tr>
                  </thead>
                  <tbody>${policyRows}</tbody>
                </table>
              </article>

              <article class="card wide">
                <h2>Contacts</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Sender</th>
                      <th>Segment</th>
                    </tr>
                  </thead>
                  <tbody>${contactRows}</tbody>
                </table>
              </article>

              <article class="card wide">
                <h2>Inbound Message Inbox</h2>
                <p class="subtle">Send replies directly from suggested drafts or your own edits.</p>
                <table>
                  <thead>
                    <tr>
                      <th>Sender</th>
                      <th>Segment</th>
                      <th>Inbound</th>
                      <th>Intent / Confidence</th>
                      <th>Reply</th>
                    </tr>
                  </thead>
                  <tbody>${messageRows}</tbody>
                </table>
              </article>
            </section>
          </main>
        </body>
      </html>
    `;

    reply.type("text/html").send(html);
  });

  app.post<{
    Body: {
      accessToken?: string;
      igBusinessAccountId?: string;
      pageId?: string;
      pageName?: string;
    };
  }>("/app/connection/manual", async (request, reply) => {
    const accessToken = request.body?.accessToken?.trim();
    const igBusinessAccountId = request.body?.igBusinessAccountId?.trim();

    if (!accessToken || !igBusinessAccountId) {
      return reply.redirect("/app?notice=Missing required manual connection fields.");
    }

    await upsertConnectedInstagramConnection(deps.prisma, {
      accessToken,
      igBusinessAccountId,
      pageId: request.body?.pageId?.trim() || null,
      pageName: request.body?.pageName?.trim() || null,
      scope: "manual",
      tokenType: "manual"
    });

    return reply.redirect("/app?notice=Manual connection saved.");
  });

  app.post("/app/connection/disconnect", async (_request, reply) => {
    await disconnectInstagramConnection(deps.prisma);
    return reply.redirect("/app?notice=Instagram connection cleared.");
  });

  app.get("/oauth/meta/start", async (request, reply) => {
    if (!deps.env.metaAppId.trim() || !deps.env.metaAppSecret.trim()) {
      await markInstagramConnectionError(
        deps.prisma,
        "OAuth cannot start: META_APP_ID or META_APP_SECRET is not configured."
      );
      return reply.redirect("/app?notice=OAuth not configured. Add META_APP_ID and META_APP_SECRET.");
    }

    const redirectUri = getRedirectUri(request, deps.env);
    const params = new URLSearchParams({
      client_id: deps.env.metaAppId.trim(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: [
        "pages_show_list",
        "pages_read_engagement",
        "instagram_business_basic",
        "instagram_business_manage_messages"
      ].join(",")
    });

    return reply.redirect(`https://www.facebook.com/v20.0/dialog/oauth?${params.toString()}`);
  });

  app.get<{
    Querystring: {
      code?: string;
      error?: string;
      error_description?: string;
    };
  }>("/oauth/meta/callback", async (request, reply) => {
    if (request.query.error) {
      const message =
        request.query.error_description?.trim() ||
        request.query.error.trim() ||
        "OAuth permission request was declined.";
      await markInstagramConnectionError(deps.prisma, message);
      return reply.redirect("/app?notice=OAuth failed. Check connection details.");
    }

    const code = request.query.code?.trim();
    if (!code) {
      await markInstagramConnectionError(deps.prisma, "OAuth callback missing code.");
      return reply.redirect("/app?notice=OAuth callback did not include a code.");
    }

    if (!deps.env.metaAppId.trim() || !deps.env.metaAppSecret.trim()) {
      await markInstagramConnectionError(
        deps.prisma,
        "OAuth callback failed: app credentials are not configured."
      );
      return reply.redirect("/app?notice=OAuth credentials are not configured in environment.");
    }

    try {
      const token = await exchangeCodeForToken({
        code,
        appId: deps.env.metaAppId.trim(),
        appSecret: deps.env.metaAppSecret.trim(),
        redirectUri: getRedirectUri(request, deps.env)
      });

      const profile = await fetchInstagramProfile(token.access_token);
      if (!profile.igBusinessAccountId) {
        throw new Error(
          "OAuth succeeded but no instagram_business_account was found on linked pages."
        );
      }

      await upsertConnectedInstagramConnection(deps.prisma, {
        accessToken: token.access_token,
        igBusinessAccountId: profile.igBusinessAccountId,
        pageId: profile.pageId,
        pageName: profile.pageName,
        scope: token.scope ?? null,
        tokenType: token.token_type ?? null
      });

      return reply.redirect("/app?notice=Instagram connected successfully.");
    } catch (error) {
      const message = toErrorMessage(error);
      deps.logger.error({ error }, "Meta OAuth callback failed");
      await markInstagramConnectionError(deps.prisma, message);
      return reply.redirect("/app?notice=OAuth token exchange failed. Check logs and app settings.");
    }
  });
}

async function loadConsoleState(prisma: PrismaClient): Promise<{
  connection: {
    id: string;
    status: string;
    pageId: string | null;
    pageName: string | null;
    igBusinessAccountId: string | null;
    tokenType: string | null;
    scope: string | null;
    lastError: string | null;
    connectedAt: Date | null;
    updatedAt: Date;
  };
  policies: Array<{
    segment: string;
    autoSend: boolean;
    requireHumanApproval: boolean;
    template: string | null;
  }>;
  contacts: Array<{ senderIgId: string; segment: string }>;
  messages: Array<{
    id: string;
    senderIgId: string;
    segment: string;
    text: string;
    intent: string | null;
    confidence: number | null;
    suggestedReply: string | null;
    needsHumanApproval: boolean;
    receivedAt: string;
  }>;
  accountSummaries: Array<{
    senderIgId: string;
    segment: string;
    inboundCount: number;
    lastInboundAt: string;
    lastInboundText: string;
    lastAutomatedReplyAt: string | null;
  }>;
}> {
  const connection = await getOrCreateInstagramConnection(prisma);
  const policies = await ensureAllPolicies(prisma);
  const contacts = await prisma.contact.findMany({
    orderBy: { updatedAt: "desc" },
    take: 50
  });
  const segmentBySender = new Map(
    contacts.map((contact) => [contact.senderIgId, contact.segment])
  );
  const recentMessages = await prisma.message.findMany({
    orderBy: { receivedAt: "desc" },
    take: 500
  });
  const inboundMessages = recentMessages.filter(
    (message) => message.direction === MessageDirection.IN
  );
  const outboundMessages = recentMessages.filter(
    (message) => message.direction === MessageDirection.OUT
  );
  const latestOutboundByThread = new Map<string, Date>();
  for (const outbound of outboundMessages) {
    const existing = latestOutboundByThread.get(outbound.threadId);
    if (!existing || outbound.receivedAt > existing) {
      latestOutboundByThread.set(outbound.threadId, outbound.receivedAt);
    }
  }

  const summaryBySender = new Map<
    string,
    {
      senderIgId: string;
      segment: ContactSegment;
      inboundCount: number;
      lastInboundAt: Date;
      lastInboundText: string;
      threadIds: Set<string>;
      lastAutomatedReplyAt: Date | null;
    }
  >();

  for (const inbound of inboundMessages) {
    const existing = summaryBySender.get(inbound.senderIgId);
    if (existing) {
      existing.inboundCount += 1;
      existing.threadIds.add(inbound.threadId);
      if (inbound.receivedAt > existing.lastInboundAt) {
        existing.lastInboundAt = inbound.receivedAt;
        existing.lastInboundText = inbound.text ?? "";
      }
      continue;
    }

    summaryBySender.set(inbound.senderIgId, {
      senderIgId: inbound.senderIgId,
      segment: segmentBySender.get(inbound.senderIgId) ?? ContactSegment.STRANGER,
      inboundCount: 1,
      lastInboundAt: inbound.receivedAt,
      lastInboundText: inbound.text ?? "",
      threadIds: new Set([inbound.threadId]),
      lastAutomatedReplyAt: null
    });
  }

  for (const summary of summaryBySender.values()) {
    let latest: Date | null = null;
    for (const threadId of summary.threadIds) {
      const outboundAt = latestOutboundByThread.get(threadId);
      if (outboundAt && (!latest || outboundAt > latest)) {
        latest = outboundAt;
      }
    }
    summary.lastAutomatedReplyAt = latest;
  }

  const messages = inboundMessages.slice(0, 20);
  const accountSummaries = [...summaryBySender.values()]
    .sort((a, b) => b.lastInboundAt.getTime() - a.lastInboundAt.getTime())
    .map((summary) => ({
      senderIgId: summary.senderIgId,
      segment: summary.segment,
      inboundCount: summary.inboundCount,
      lastInboundAt: summary.lastInboundAt.toISOString(),
      lastInboundText: summary.lastInboundText,
      lastAutomatedReplyAt: summary.lastAutomatedReplyAt?.toISOString() ?? null
    }));

  return {
    connection: {
      id: connection.id,
      status: connection.status,
      pageId: connection.pageId,
      pageName: connection.pageName,
      igBusinessAccountId: connection.igBusinessAccountId,
      tokenType: connection.tokenType,
      scope: connection.scope,
      lastError: connection.lastError,
      connectedAt: connection.connectedAt,
      updatedAt: connection.updatedAt
    },
    policies: policies.map((policy) => ({
      segment: policy.segment,
      autoSend: policy.autoSend,
      requireHumanApproval: policy.requireHumanApproval,
      template: policy.template
    })),
    contacts: contacts.map((contact) => ({
      senderIgId: contact.senderIgId,
      segment: contact.segment
    })),
    messages: messages.map((message) => ({
      id: message.id,
      senderIgId: message.senderIgId,
      segment: segmentBySender.get(message.senderIgId) ?? ContactSegment.STRANGER,
      text: message.text ?? "",
      intent: message.intent,
      confidence: message.confidence,
      suggestedReply: message.suggestedReply,
      needsHumanApproval: message.needsHumanApproval,
      receivedAt: message.receivedAt.toISOString()
    })),
    accountSummaries
  };
}

async function resolveOutboundSenderId(
  prisma: PrismaClient,
  env: Env
): Promise<string> {
  const connection = await prisma.instagramConnection.findFirst({
    where: { status: "CONNECTED" },
    orderBy: { updatedAt: "desc" }
  });

  return (
    connection?.igBusinessAccountId?.trim() ||
    env.metaIgBusinessAccountId.trim() ||
    "ig_business_account"
  );
}

function renderReactConsoleShell(): string {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>InstaReply React Console</title>
        <style>
          :root {
            --ig-purple: #7b2ff7;
            --ig-pink: #f63795;
            --ig-orange: #ff7a18;
            --ink: #22233a;
            --muted: #5e5f76;
            --card: rgba(255, 255, 255, 0.9);
            --line: rgba(36, 36, 64, 0.14);
            --ok: #0e8a4b;
            --warn: #b87300;
            --err: #c83a4b;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            min-height: 100vh;
            color: var(--ink);
            font-family: "Avenir Next", "Segoe UI", "Noto Sans", sans-serif;
            background:
              radial-gradient(circle at 10% 10%, rgba(246, 55, 149, 0.24), transparent 34%),
              radial-gradient(circle at 88% 14%, rgba(123, 47, 247, 0.24), transparent 30%),
              radial-gradient(circle at 24% 88%, rgba(255, 122, 24, 0.2), transparent 34%),
              linear-gradient(160deg, #fff7fd, #f5f8ff);
          }
          #root { padding: 20px; }
        </style>
      </head>
      <body>
        <div id="root"></div>
        <script type="module" src="/app-react/static/reactConsole.js"></script>
      </body>
    </html>
  `;
}

async function exchangeCodeForToken(input: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ access_token: string; token_type?: string; scope?: string }> {
  const params = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    redirect_uri: input.redirectUri,
    code: input.code
  });

  const response = await fetch(
    `https://graph.facebook.com/v20.0/oauth/access_token?${params.toString()}`
  );
  const body = (await response.json().catch(() => ({}))) as MetaTokenResponse;

  if (!response.ok || !body.access_token) {
    throw new Error(`Token exchange failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return {
    access_token: body.access_token,
    token_type: body.token_type,
    scope: body.scope
  };
}

async function fetchInstagramProfile(accessToken: string): Promise<{
  pageId: string | null;
  pageName: string | null;
  igBusinessAccountId: string | null;
}> {
  const params = new URLSearchParams({
    fields: "id,name,instagram_business_account{id,username}",
    access_token: accessToken
  });

  const response = await fetch(`https://graph.facebook.com/v20.0/me/accounts?${params}`);
  const body = (await response.json().catch(() => ({}))) as MetaAccountsResponse;

  if (!response.ok) {
    throw new Error(`Failed to fetch page accounts: ${response.status} ${JSON.stringify(body)}`);
  }

  const page = (body.data ?? []).find(
    (item) => item.instagram_business_account?.id && item.id
  );

  if (!page) {
    return {
      pageId: null,
      pageName: null,
      igBusinessAccountId: null
    };
  }

  return {
    pageId: page.id ?? null,
    pageName: page.name ?? null,
    igBusinessAccountId: page.instagram_business_account?.id ?? null
  };
}

function getRedirectUri(
  request: { protocol: string; headers: Record<string, unknown> },
  env: Env
): string {
  const configured = env.metaAppRedirectUri.trim();
  if (configured) return configured;

  const host = String(request.headers.host ?? "localhost:3000");
  return `${request.protocol}://${host}/oauth/meta/callback`;
}

function statusBadge(status: string): string {
  if (status === "CONNECTED") {
    return `<span class="badge ok">CONNECTED</span>`;
  }

  if (status === "ERROR") {
    return `<span class="badge err">ERROR</span>`;
  }

  return `<span class="badge warn">DISCONNECTED</span>`;
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
