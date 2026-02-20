import { LlmDraft } from "../types/llm";

export interface RulesService {
  generateDraft(text: string): LlmDraft | null;
}

export class KeywordRulesService implements RulesService {
  generateDraft(text: string): LlmDraft | null {
    const normalized = text.toLowerCase();

    if (this.hasAny(normalized, ["price", "how much", "cost"])) {
      return {
        intent: "pricing",
        confidence: 0.95,
        reply:
          "Thanks for reaching out. Our pricing depends on your needs. Share what you're looking for and I'll send the best option.",
        needs_human_approval: false
      };
    }

    if (this.hasAny(normalized, ["refund", "return", "chargeback"])) {
      return {
        intent: "refund",
        confidence: 0.9,
        reply:
          "I can help with refund support. Please share your order number and the issue, and we'll review it right away.",
        needs_human_approval: false
      };
    }

    if (this.hasAny(normalized, ["shipping", "delivery", "tracking"])) {
      return {
        intent: "shipping",
        confidence: 0.9,
        reply:
          "Happy to help with shipping updates. Send your order number and I'll check status and ETA for you.",
        needs_human_approval: false
      };
    }

    if (this.hasAny(normalized, ["order", "purchase", "invoice"])) {
      return {
        intent: "order_support",
        confidence: 0.88,
        reply:
          "I can help with your order. Please share your order number and a short description of the issue.",
        needs_human_approval: false
      };
    }

    return null;
  }

  private hasAny(text: string, keywords: string[]): boolean {
    return keywords.some((keyword) => text.includes(keyword));
  }
}
