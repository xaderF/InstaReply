import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import rawBody from "fastify-raw-body";
import type { Env } from "../../apps/server/src/config/env";
import { InMemoryQueue } from "../../apps/server/src/queue/inMemoryQueue";
import { registerWebhookRoutes } from "../../apps/server/src/routes/webhook";
import type { ParsedWebhookJob } from "../../apps/server/src/types/meta";

type Scenario = {
  name: string;
  requests: number;
  concurrency: number;
  queueConcurrency: number;
  workerDelayMs: number;
  timeoutMs: number;
};

type ScenarioResult = {
  name: string;
  requests: number;
  concurrency: number;
  queueConcurrency: number;
  workerDelayMs: number;
  successes: number;
  failures: number;
  successRate: number;
  ackLatencyMs: LatencyStats;
  dispatchDurationMs: number;
  totalDurationMs: number;
  queueDrainAfterDispatchMs: number;
  ackThroughputRps: number;
  fullyProcessed: boolean;
  processedJobs: number;
};

type LatencyStats = {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
};

type CliArgs = {
  preset: "quick" | "resume";
  out?: string;
  single?: Scenario;
};

const PRESETS: Record<"quick" | "resume", Scenario[]> = {
  quick: [
    {
      name: "quick",
      requests: 200,
      concurrency: 20,
      queueConcurrency: 1,
      workerDelayMs: 0,
      timeoutMs: 20_000
    }
  ],
  resume: [
    {
      name: "baseline",
      requests: 500,
      concurrency: 25,
      queueConcurrency: 1,
      workerDelayMs: 0,
      timeoutMs: 30_000
    },
    {
      name: "burst",
      requests: 2_000,
      concurrency: 100,
      queueConcurrency: 1,
      workerDelayMs: 0,
      timeoutMs: 45_000
    },
    {
      name: "queue_stress",
      requests: 1_000,
      concurrency: 50,
      queueConcurrency: 1,
      workerDelayMs: 3,
      timeoutMs: 60_000
    }
  ]
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = args.single ? [args.single] : PRESETS[args.preset];
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    // eslint-disable-next-line no-console
    console.log(`Running scenario "${scenario.name}"...`);
    const result = await runScenario(scenario);
    results.push(result);
    // eslint-disable-next-line no-console
    console.log(
      [
        `  successRate=${(result.successRate * 100).toFixed(2)}%`,
        `p50=${result.ackLatencyMs.p50.toFixed(2)}ms`,
        `p95=${result.ackLatencyMs.p95.toFixed(2)}ms`,
        `p99=${result.ackLatencyMs.p99.toFixed(2)}ms`,
        `throughput=${result.ackThroughputRps.toFixed(2)} req/s`
      ].join(" | ")
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    preset: args.single ? "custom" : args.preset,
    results
  };

  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
    // eslint-disable-next-line no-console
    console.log(`Saved benchmark report to ${outPath}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
  }
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const appSecret = "benchmark_app_secret";
  let processedJobs = 0;
  const queue = new InMemoryQueue<ParsedWebhookJob>({
    concurrency: scenario.queueConcurrency,
    onError: () => {
      // Intentionally empty for benchmark harness.
    }
  });

  queue.start(async () => {
    if (scenario.workerDelayMs > 0) {
      await sleep(scenario.workerDelayMs);
    }
    processedJobs += 1;
  });

  const app = Fastify({ logger: false });
  await app.register(formbody);
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true
  });

  registerWebhookRoutes(app, {
    env: createBenchmarkEnv(appSecret),
    logger: app.log,
    queue
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve benchmark server address");
  }
  const url = `http://127.0.0.1:${address.port}/webhook/instagram`;

  const latencies: number[] = [];
  let successes = 0;
  let failures = 0;

  const startedAt = performance.now();

  await runWithConcurrency(scenario.requests, scenario.concurrency, async (index) => {
    const payload = createPayload(index);
    const rawBody = JSON.stringify(payload);
    const signature = sign(rawBody, appSecret);

    const requestStarted = performance.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature
      },
      body: rawBody
    });
    latencies.push(performance.now() - requestStarted);

    if (response.ok) {
      successes += 1;
    } else {
      failures += 1;
    }
  });

  const dispatchedAt = performance.now();
  const fullyProcessed = await waitForProcessedJobs(
    () => processedJobs,
    scenario.requests,
    scenario.timeoutMs
  );
  const finishedAt = performance.now();

  await app.close();

  const dispatchDurationMs = dispatchedAt - startedAt;
  const totalDurationMs = finishedAt - startedAt;

  return {
    name: scenario.name,
    requests: scenario.requests,
    concurrency: scenario.concurrency,
    queueConcurrency: scenario.queueConcurrency,
    workerDelayMs: scenario.workerDelayMs,
    successes,
    failures,
    successRate: successes / scenario.requests,
    ackLatencyMs: summarizeLatencies(latencies),
    dispatchDurationMs,
    totalDurationMs,
    queueDrainAfterDispatchMs: finishedAt - dispatchedAt,
    ackThroughputRps: scenario.requests / (dispatchDurationMs / 1_000),
    fullyProcessed,
    processedJobs
  };
}

function createBenchmarkEnv(appSecret: string): Env {
  return {
    port: 0,
    databaseUrl: "postgresql://benchmark:benchmark@localhost:5432/benchmark",
    appSecret,
    metaAccessToken: "benchmark_token",
    metaIgBusinessAccountId: "benchmark_ig_account",
    metaAppId: "",
    metaAppSecret: "",
    metaAppRedirectUri: "",
    llmProvider: "openai",
    openaiApiKey: "benchmark_openai_key",
    openaiModel: "gpt-4.1-mini"
  };
}

function createPayload(index: number): Record<string, unknown> {
  const now = Date.now();
  const messageId = `m_${now}_${index}`;
  const senderId = `u_${1000 + (index % 100)}`;

  return {
    object: "instagram",
    entry: [
      {
        id: "ig_biz_account",
        time: now,
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: "ig_biz_account" },
            timestamp: now,
            conversation: { id: `thread_${senderId}` },
            message: {
              mid: messageId,
              text: index % 5 === 0 ? "What is your price?" : "Hello, I need help with my order."
            }
          }
        ]
      }
    ]
  };
}

function sign(rawBody: string, appSecret: string): string {
  const digest = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return `sha256=${digest}`;
}

async function runWithConcurrency(
  total: number,
  concurrency: number,
  task: (index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) {
        return;
      }
      await task(index);
    }
  });
  await Promise.all(workers);
}

async function waitForProcessedJobs(
  getProcessedCount: () => number,
  target: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (getProcessedCount() >= target) {
      return true;
    }
    await sleep(10);
  }
  return getProcessedCount() >= target;
}

function summarizeLatencies(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return {
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      avg: 0
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length
  };
}

function percentile(sortedValues: number[], percentileRank: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (percentileRank / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex];
  }
  const weight = position - lowerIndex;
  return (
    sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * weight
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseArgs(argv: string[]): CliArgs {
  const base: CliArgs = { preset: "quick" };
  let custom: Partial<Scenario> | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];

    switch (arg) {
      case "--preset":
        if (value === "quick" || value === "resume") {
          base.preset = value;
          i += 1;
        } else {
          throw new Error("--preset must be quick or resume");
        }
        break;
      case "--out":
        if (!value) throw new Error("--out requires a value");
        base.out = value;
        i += 1;
        break;
      case "--requests":
      case "--concurrency":
      case "--queue-concurrency":
      case "--worker-delay-ms":
      case "--timeout-ms": {
        if (!value) throw new Error(`${arg} requires a value`);
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          throw new Error(`${arg} must be a positive number`);
        }
        custom ??= {
          name: "custom",
          requests: 200,
          concurrency: 20,
          queueConcurrency: 1,
          workerDelayMs: 0,
          timeoutMs: 20_000
        };
        if (arg === "--requests") custom.requests = Math.floor(numeric);
        if (arg === "--concurrency") custom.concurrency = Math.floor(numeric);
        if (arg === "--queue-concurrency") custom.queueConcurrency = Math.floor(numeric);
        if (arg === "--worker-delay-ms") custom.workerDelayMs = numeric;
        if (arg === "--timeout-ms") custom.timeoutMs = Math.floor(numeric);
        i += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (custom) {
    base.single = {
      name: custom.name ?? "custom",
      requests: custom.requests ?? 200,
      concurrency: custom.concurrency ?? 20,
      queueConcurrency: custom.queueConcurrency ?? 1,
      workerDelayMs: custom.workerDelayMs ?? 0,
      timeoutMs: custom.timeoutMs ?? 20_000
    };
  }

  return base;
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
