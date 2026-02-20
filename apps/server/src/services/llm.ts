import OpenAI from "openai";
import { FastifyBaseLogger } from "fastify";
import { Env } from "../config/env";
import { LlmDraft, llmDraftSchema } from "../types/llm";

export interface LlmService {
  generateDraft(text: string): Promise<LlmDraft>;
}

class OpenAiLlmService implements LlmService {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger: FastifyBaseLogger;

  constructor(apiKey: string, model: string, logger: FastifyBaseLogger) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.logger = logger;
  }

  async generateDraft(text: string): Promise<LlmDraft> {
    const startedAt = Date.now();

    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are an Instagram support assistant. Return strict JSON only with keys: intent, confidence, reply, needs_human_approval. " +
              "intent must be one of: general_question, pricing, order_support, shipping, refund, unknown. " +
              "confidence must be 0..1. reply must be concise and friendly."
          },
          {
            role: "user",
            content: `Incoming DM: "${text}"`
          }
        ]
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = llmDraftSchema.parse(JSON.parse(raw));

      this.logger.info(
        { latencyMs: Date.now() - startedAt, intent: parsed.intent },
        "LLM draft generated"
      );

      return parsed;
    } catch (error) {
      this.logger.error(
        { error, latencyMs: Date.now() - startedAt },
        "LLM draft generation failed"
      );

      return {
        intent: "unknown",
        confidence: 0.0,
        reply: "Thanks for your message. A team member will review this shortly.",
        needs_human_approval: true
      };
    }
  }
}

export function createLlmService(
  env: Env,
  logger: FastifyBaseLogger
): LlmService {
  if (env.llmProvider === "openai") {
    return new OpenAiLlmService(env.openaiApiKey, env.openaiModel, logger);
  }

  throw new Error(`Unsupported LLM provider: ${env.llmProvider}`);
}
