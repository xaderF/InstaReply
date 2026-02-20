import { z } from "zod";

export const intentSchema = z.enum([
  "general_question",
  "pricing",
  "order_support",
  "shipping",
  "refund",
  "unknown"
]);

export const llmDraftSchema = z.object({
  intent: intentSchema,
  confidence: z.number().min(0).max(1),
  reply: z.string().min(1),
  needs_human_approval: z.boolean()
});

export type Intent = z.infer<typeof intentSchema>;
export type LlmDraft = z.infer<typeof llmDraftSchema>;
