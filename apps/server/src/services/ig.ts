import { FastifyBaseLogger } from "fastify";

export interface SendMessageResult {
  messageId: string;
  latencyMs: number;
}

export interface IgService {
  sendMessage(toIgUserId: string, text: string): Promise<SendMessageResult>;
}

type InstagramServiceOptions = {
  accessToken: string;
  businessAccountId: string;
  logger: FastifyBaseLogger;
};

export class InstagramGraphService implements IgService {
  private readonly accessToken: string;
  private readonly businessAccountId: string;
  private readonly logger: FastifyBaseLogger;

  constructor(options: InstagramServiceOptions) {
    this.accessToken = options.accessToken;
    this.businessAccountId = options.businessAccountId;
    this.logger = options.logger;
  }

  async sendMessage(toIgUserId: string, text: string): Promise<SendMessageResult> {
    const startedAt = Date.now();
    const url = `https://graph.facebook.com/v20.0/${this.businessAccountId}/messages`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "instagram",
        recipient: { id: toIgUserId },
        message: { text }
      })
    });

    const latencyMs = Date.now() - startedAt;
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!response.ok) {
      const errorMessage = JSON.stringify(body);
      this.logger.error({ latencyMs, errorMessage }, "IG send failed");
      throw new Error(`Meta Graph API error: ${response.status} ${errorMessage}`);
    }

    const messageId =
      typeof body.message_id === "string"
        ? body.message_id
        : `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.logger.info({ latencyMs, toIgUserId }, "IG message sent");

    return { messageId, latencyMs };
  }
}
