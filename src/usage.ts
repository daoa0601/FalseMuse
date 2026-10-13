import { hasColumn, type SqlDatabase } from "./database.ts";
import { isRecord, parseJson } from "./json.ts";

export type Quota = Record<string, string>;
type TokenUsage = Record<string, number | { cached_tokens: number }>;

const quotaHeader =
  /^x-codex-(?:(?:primary|secondary)-(?:used-percent|window-minutes|reset-after-seconds|reset-at|over-secondary-limit-percent)|plan-type|active-limit|credits-(?:balance|has-credits|unlimited))$/;
const tokenFields = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "totalTokens",
  "input_tokens",
  "output_tokens",
  "total_tokens",
];

/** Keep only the subscription quota headers; drop session state and credentials. */
export function quotaHeaders(headers: unknown): Quota {
  if (!isRecord(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] =>
        quotaHeader.test(entry[0]) && typeof entry[1] === "string",
    ),
  );
}

/** Bulk compaction pauses at 80% of either window until that window resets. */
export function allowsCompaction(quota: Quota, now = Date.now()): boolean {
  return (["primary", "secondary"] as const).every((window) => {
    const reset = Number(quota[`x-codex-${window}-reset-at`]);
    if (reset > 0 && reset * 1000 <= now) return true;
    return Number(quota[`x-codex-${window}-used-percent`] ?? 0) < 80;
  });
}

function tokenUsage(usage: unknown): TokenUsage | null {
  if (!isRecord(usage)) return null;
  const tokens: TokenUsage = {};
  for (const field of tokenFields) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) tokens[field] = value;
  }
  const details = usage["input_tokens_details"];
  if (isRecord(details) && typeof details["cached_tokens"] === "number") {
    tokens["input_tokens_details"] = { cached_tokens: details["cached_tokens"] };
  }
  return tokens;
}

export interface ModelCallRecord {
  id?: unknown;
  date: unknown;
  purpose: string;
  model: unknown;
  usage: unknown;
  quota?: unknown;
  source?: string;
  job?: string | null;
}

interface StoredCall {
  date: string;
  purpose: string;
  model: string;
  usage: string;
  quota: string;
  source: string;
  job: string | null;
}

export class UsageLedger {
  private readonly database: SqlDatabase;

  constructor(database: SqlDatabase) {
    this.database = database;
    database.exec(
      "CREATE TABLE IF NOT EXISTS model_calls (id INTEGER PRIMARY KEY, date TEXT, purpose TEXT, model TEXT, usage TEXT, quota TEXT, source TEXT NOT NULL DEFAULT 'master', request_id TEXT, job TEXT)",
    );
    for (const [name, definition] of [
      ["source", "TEXT NOT NULL DEFAULT 'master'"],
      ["request_id", "TEXT"],
      ["job", "TEXT"],
    ] as const) {
      if (!hasColumn(database, "model_calls", name)) {
        database.exec(`ALTER TABLE model_calls ADD COLUMN ${name} ${definition}`);
      }
    }
    database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS model_call_delivery ON model_calls(source, request_id)",
    );
  }

  record({
    id = crypto.randomUUID(),
    date,
    purpose,
    model,
    usage,
    quota = {},
    source = "master",
    job = null,
  }: ModelCallRecord): void {
    if (
      typeof id !== "string" ||
      !/^[\w-]{1,80}$/.test(id) ||
      typeof model !== "string" ||
      model.length > 100 ||
      !model.trim()
    ) {
      throw new Error("A model call needs a delivery ID and model name");
    }
    if (typeof date !== "string" || !Number.isFinite(Date.parse(date))) {
      throw new Error("A model call needs its observation time");
    }
    this.database.exec(
      "INSERT OR IGNORE INTO model_calls(date, purpose, model, usage, quota, source, request_id, job) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      new Date(date).toISOString(),
      purpose,
      model,
      JSON.stringify(tokenUsage(usage)),
      JSON.stringify(quotaHeaders(quota)),
      source,
      id,
      job,
    );
  }

  latestQuota(): Quota {
    const [call] = this.database.rows<{ quota: string }>(
      "SELECT quota FROM model_calls WHERE quota<>'{}' ORDER BY date DESC, id DESC LIMIT 1",
    );
    return call ? quotaHeaders(parseJson(call.quota)) : {};
  }

  recent() {
    return this.database
      .rows<StoredCall>(
        "SELECT date, purpose, model, usage, quota, source, job FROM model_calls ORDER BY id DESC LIMIT 50",
      )
      .map((call) => ({
        ...call,
        usage: parseJson(call.usage),
        quota: quotaHeaders(parseJson(call.quota)),
      }));
  }
}
