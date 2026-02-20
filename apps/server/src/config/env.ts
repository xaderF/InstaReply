import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(1),
  META_ACCESS_TOKEN: z.string().min(1),
  META_IG_BUSINESS_ACCOUNT_ID: z.string().min(1),
  LLM_PROVIDER: z.enum(["openai"]).default("openai"),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini")
});

export type Env = {
  port: number;
  databaseUrl: string;
  appSecret: string;
  metaAccessToken: string;
  metaIgBusinessAccountId: string;
  llmProvider: "openai";
  openaiApiKey: string;
  openaiModel: string;
};

const parsed = envSchema.parse(process.env);

export const env: Env = {
  port: parsed.PORT,
  databaseUrl: parsed.DATABASE_URL,
  appSecret: parsed.APP_SECRET,
  metaAccessToken: parsed.META_ACCESS_TOKEN,
  metaIgBusinessAccountId: parsed.META_IG_BUSINESS_ACCOUNT_ID,
  llmProvider: parsed.LLM_PROVIDER,
  openaiApiKey: parsed.OPENAI_API_KEY,
  openaiModel: parsed.OPENAI_MODEL
};
