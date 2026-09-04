import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createNodeHistoryAdapters,
  type HistoryAdapters,
  readAgentProviderWindows,
  readUsageHistorySnapshot,
} from "./history.server";
import type {
  UsageHistoryBucket,
  UsageHistorySnapshot,
  UsageTokenBreakdown,
} from "./history.shared";
import type { PricingAdapters } from "./pricing.server";

const HOME = "/home/tester";
const CLAUDE_DIR = `${HOME}/.claude/projects/proj`;
const CODEX_DIR = `${HOME}/.codex/sessions/2026/08/26`;
const OMP_DIR = `${HOME}/.omp/agent/sessions/-proj`;
const SCAN_CACHE_PATH = `${HOME}/.paseo/usage-limits/scan-cache.json`;
const NOW = "2026-08-26T12:30:00.000Z";
const OMP_REPORTED_COST = 0.422;

/** The shape LiteLLM publishes, narrowed to the fields the pricer reads. */
interface RateEntry {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
}

interface FakeFile {
  text: string | null;
  mtime: string;
  size?: number;
}

interface HarnessOptions {
  files?: Record<string, FakeFile | string>;
  env?: NodeJS.ProcessEnv;
  now?: string;
  directoryFailures?: Record<string, string>;
  /** Absent by default, so a model is unpriced unless a test says otherwise. */
  rates?: Record<string, RateEntry>;
  scanCache?: string;
}

interface Harness {
  adapters: HistoryAdapters;
  reads: string[];
  cacheWrites: number;
  files: Map<string, FakeFile>;
  scanCache(): string | null;
}

const PROVIDER_QUERY = { range: "24h", groupBy: "provider" } as const;
const MODEL_QUERY = { range: "24h", groupBy: "model" } as const;

function createHarness(options: HarnessOptions = {}): Harness {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const now = options.now ?? NOW;
  const directoryFailures = options.directoryFailures ?? {};
  const files = new Map<string, FakeFile>();
  for (const [path, value] of Object.entries(options.files ?? {})) {
    const val = typeof value === "string" ? { text: value, mtime: now } : value;
    files.set(path, val);
    files.set(norm(path), val);
  }
  const reads: string[] = [];
  const cache = new Map<string, string>();
  if (options.scanCache !== undefined) {
    cache.set(SCAN_CACHE_PATH, options.scanCache);
    cache.set(norm(SCAN_CACHE_PATH), options.scanCache);
  }
  const harness: Harness = {
    adapters: {
      env: options.env ?? {},
      homeDir: HOME,
      listFiles(directory) {
        const normDir = norm(directory);
        const failure = directoryFailures[directory] ?? directoryFailures[normDir];
        if (failure !== undefined) {
          return { files: [], errors: [{ source: directory, message: failure }] };
        }
        const seen = new Set<string>();
        const matched: string[] = [];
        for (const path of files.keys()) {
          const np = norm(path);
          if (np.startsWith(`${normDir}/`) && !seen.has(np)) {
            seen.add(np);
            matched.push(np);
          }
        }
        return {
          files: matched,
          errors: [],
        };
      },
      statFile(path) {
        const file = files.get(path) ?? files.get(norm(path));
        if (file === undefined) return null;
        const size = file.size ?? (file.text === null ? 1 : file.text.length);
        return { mtimeMs: Date.parse(file.mtime), size };
      },
      readTextFile(path) {
        reads.push(norm(path));
        return files.get(path)?.text ?? files.get(norm(path))?.text ?? null;
      },
      readScanCacheFile(path) {
        return cache.get(path) ?? cache.get(norm(path)) ?? null;
      },
      writeScanCacheFile(path, content) {
        harness.cacheWrites += 1;
        cache.set(path, content);
        cache.set(norm(path), content);
      },
      pricing: createPricingStub(options.rates, now),
      now() {
        return new Date(now);
      },
    },
    reads,
    cacheWrites: 0,
    files,
    scanCache() {
      return cache.get(SCAN_CACHE_PATH) ?? cache.get(norm(SCAN_CACHE_PATH)) ?? null;
    },
  };
  return harness;
}

/**
 * No rate cache on disk and no network: the table is whatever `rates` names.
 * Omitting them is the unavailable case, which is how most of these tests run.
 */
function createPricingStub(
  rates: Record<string, RateEntry> | undefined,
  now: string,
): PricingAdapters {
  return {
    env: {},
    homeDir: HOME,
    readTextFile() {
      return null;
    },
    writeTextFile() {},
    fetchJson() {
      if (rates === undefined) return Promise.reject(new Error("no rates in this test"));
      return Promise.resolve(rates);
    },
    now() {
      return new Date(now);
    },
  };
}

interface BreakdownFields {
  uncachedInputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  cacheCreationLongTtlTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number | null;
  cacheSavingsUsd?: number | null;
}

/** `tokens` is summed here from the four billable fields, never copied in. */
function breakdown(fields: BreakdownFields): UsageTokenBreakdown {
  const uncachedInputTokens = fields.uncachedInputTokens ?? 0;
  const cachedInputTokens = fields.cachedInputTokens ?? 0;
  const cacheCreationTokens = fields.cacheCreationTokens ?? 0;
  const outputTokens = fields.outputTokens ?? 0;
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    cacheCreationLongTtlTokens: fields.cacheCreationLongTtlTokens ?? 0,
    outputTokens,
    reasoningTokens: fields.reasoningTokens ?? 0,
    tokens: uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens,
    costUsd: fields.costUsd ?? null,
    cacheSavingsUsd: fields.cacheSavingsUsd ?? null,
  };
}

const TOKEN_COUNTERS = [
  "uncachedInputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
  "cacheCreationLongTtlTokens",
  "outputTokens",
  "reasoningTokens",
  "tokens",
] as const;

/** Every counter at once, so a subset field cannot drift between two levels. */
function expectCountersSum(
  parts: readonly UsageTokenBreakdown[],
  whole: UsageTokenBreakdown,
): void {
  for (const counter of TOKEN_COUNTERS) {
    expect(parts.reduce((sum, part) => sum + part[counter], 0)).toBe(whole[counter]);
  }
}

interface ClaudeLineFields {
  timestamp: string;
  usage: Record<string, unknown>;
  model?: string;
  id?: string;
  requestId?: string;
  isSidechain?: boolean;
  costUSD?: number | null;
}

function claudeLine(fields: ClaudeLineFields): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: fields.timestamp,
    sessionId: "session-1",
    requestId: fields.requestId ?? "req_011",
    costUSD: fields.costUSD ?? null,
    isSidechain: fields.isSidechain ?? false,
    message: {
      id: fields.id ?? "msg_011",
      model: fields.model ?? "claude-opus-5",
      usage: fields.usage,
    },
  });
}

function codexUsageLine(
  timestamp: string,
  last: Record<string, number>,
  total?: Record<string, number>,
): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: last,
        total_token_usage: total ?? last,
        model_context_window: 258400,
      },
    },
  });
}

function codexContextLine(timestamp: string, model: string): string {
  return JSON.stringify({ timestamp, type: "turn_context", payload: { model, effort: "medium" } });
}

interface OmpUsageFields {
  timestamp: string;
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  id?: string;
  reasoningTokens?: number;
  /** Null drops the cost block, which is how a log without one reads. */
  costTotal?: number | null;
}

function ompUsageLine(fields: OmpUsageFields): string {
  const cacheRead = fields.cacheRead ?? 0;
  const cacheWrite = fields.cacheWrite ?? 0;
  const costTotal = fields.costTotal === undefined ? OMP_REPORTED_COST : fields.costTotal;
  const cost =
    costTotal === null
      ? {}
      : {
          cost: {
            input: 0.00001,
            output: 0.0113,
            cacheRead: 0.398,
            cacheWrite: 0.0124,
            total: costTotal,
          },
        };
  return JSON.stringify({
    type: "message",
    id: fields.id ?? "c771e912",
    timestamp: fields.timestamp,
    message: {
      role: "assistant",
      model: fields.model,
      usage: {
        input: fields.input,
        output: fields.output,
        cacheRead,
        cacheWrite,
        totalTokens: fields.input + fields.output + cacheRead + cacheWrite,
        reasoningTokens: fields.reasoningTokens ?? 0,
        ...cost,
      },
    },
  });
}

function ompModelChangeLine(timestamp: string, model: string): string {
  return JSON.stringify({ type: "model_change", timestamp, model });
}

function bucketAt(snapshot: UsageHistorySnapshot, start: string): UsageHistoryBucket {
  const bucket = snapshot.buckets.find((entry) => entry.start === start);
  if (bucket === undefined) throw new Error(`no bucket starting at ${start}`);
  return bucket;
}

describe("readUsageHistorySnapshot: Claude Code transcripts", () => {
  test("aggregates one assistant line into its hour bucket with the five-category split", async () => {
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 36510,
            cache_read_input_tokens: 20228,
            output_tokens: 10,
          },
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);
    const split = breakdown({
      uncachedInputTokens: 2,
      cachedInputTokens: 20228,
      cacheCreationTokens: 36510,
      outputTokens: 10,
    });

    expect(snapshot.series).toEqual([
      {
        key: "claude-code",
        label: "Claude Code",
        ...split,
        children: [{ key: "claude-code:claude-opus-5", label: "claude-opus-5", ...split }],
      },
    ]);
    expect(snapshot.totals).toEqual(split);
    expect(bucketAt(snapshot, "2026-08-26T12:00:00.000Z")).toEqual({
      start: "2026-08-26T12:00:00.000Z",
      ...split,
      values: [
        { seriesKey: "claude-code", parentKey: null, ...split },
        { seriesKey: "claude-code:claude-opus-5", parentKey: "claude-code", ...split },
      ],
    });
    expect(snapshot.scanErrors).toEqual([]);
  });

  test("sums tokens from exactly the four billable Claude categories", async () => {
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 36510,
            cache_read_input_tokens: 20228,
            output_tokens: 10,
          },
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.tokens).toBe(56750);
    expect(snapshot.totals.tokens).toBe(2 + 20228 + 36510 + 10);
    expect(snapshot.totals.reasoningTokens).toBe(0);
  });

  test("prefers the cache_creation ephemeral breakdown and keeps the 1-hour share", async () => {
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 36510,
            cache_read_input_tokens: 100,
            cache_creation: {
              ephemeral_5m_input_tokens: 1000,
              ephemeral_1h_input_tokens: 500,
            },
          },
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.cacheCreationTokens).toBe(1500);
    expect(snapshot.totals.cacheCreationLongTtlTokens).toBe(500);
    expect(snapshot.totals.cachedInputTokens).toBe(100);
    expect(snapshot.totals.tokens).toBe(1600);
  });

  test("reads the flat cache creation field and no TTL share when no breakdown is present", async () => {
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 36510,
            cache_read_input_tokens: 100,
          },
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.cacheCreationTokens).toBe(36510);
    expect(snapshot.totals.cacheCreationLongTtlTokens).toBe(0);
  });

  test("skips a <synthetic> model record", async () => {
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          model: "<synthetic>",
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.series).toEqual([]);
    expect(snapshot.totals.tokens).toBe(0);
  });

  test("counts a repeated message.id + requestId pair once", async () => {
    const line = claudeLine({
      timestamp: "2026-08-26T12:12:34.035Z",
      id: "msg_dup",
      requestId: "req_dup",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: `${line}\n${line}\n`,
        [`${CLAUDE_DIR}/copy.jsonl`]: line,
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.tokens).toBe(120);
  });

  test("counts a sidechain replay under a new request id once, keeping the non-sidechain record", async () => {
    const primary = claudeLine({
      timestamp: "2026-08-26T12:12:34.035Z",
      id: "msg_shared",
      requestId: "req_primary",
      model: "claude-opus-5",
      isSidechain: false,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const replay = claudeLine({
      timestamp: "2026-08-26T12:12:35.035Z",
      id: "msg_shared",
      requestId: "req_replay",
      model: "claude-haiku-9",
      isSidechain: true,
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const harness = createHarness({
      files: { [`${CLAUDE_DIR}/a.jsonl`]: `${replay}\n${primary}\n` },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.tokens).toBe(120);
    expect(snapshot.series[0]?.children.map((child) => child.key)).toEqual([
      "claude-code:claude-opus-5",
    ]);
  });

  test("normalises a CLAUDE_CONFIG_DIR entry that already points at projects", async () => {
    const harness = createHarness({
      env: { CLAUDE_CONFIG_DIR: `/opt/claude/projects,${HOME}/other` },
      files: {
        "/opt/claude/projects/x.jsonl": claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.tokens).toBe(10);
  });
});

describe("readUsageHistorySnapshot: Codex rollouts", () => {
  test("attributes a token_count event to the most recent turn_context model", async () => {
    const harness = createHarness({
      files: {
        [`${CODEX_DIR}/rollout.jsonl`]: [
          codexUsageLine("2026-08-26T12:05:00.000Z", {
            input_tokens: 10,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            total_tokens: 11,
          }),
          codexContextLine("2026-08-26T12:10:00.000Z", "gpt-5.6-terra"),
          codexUsageLine("2026-08-26T12:13:17.346Z", {
            input_tokens: 24741,
            cached_input_tokens: 11008,
            cache_write_input_tokens: 0,
            output_tokens: 13,
            reasoning_output_tokens: 2,
            total_tokens: 24756,
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);
    const terra = breakdown({
      uncachedInputTokens: 24741,
      cachedInputTokens: 11008,
      outputTokens: 13,
      reasoningTokens: 2,
    });

    expect(snapshot.series[0]?.key).toBe("codex");
    expect(snapshot.series[0]?.children).toEqual([
      { key: "codex:gpt-5.6-terra", label: "gpt-5.6-terra", ...terra },
      {
        key: "codex:unknown",
        label: "unknown",
        ...breakdown({ uncachedInputTokens: 10, outputTokens: 1 }),
      },
    ]);
    expect(snapshot.series[0]?.children[0]?.tokens).toBe(24741 + 11008 + 13);
  });

  test("uses last_token_usage rather than total_token_usage", async () => {
    const harness = createHarness({
      files: {
        [`${CODEX_DIR}/rollout.jsonl`]: codexUsageLine(
          "2026-08-26T12:13:17.346Z",
          {
            input_tokens: 10,
            cached_input_tokens: 5,
            cache_write_input_tokens: 1,
            output_tokens: 2,
            reasoning_output_tokens: 1,
            total_tokens: 21,
          },
          {
            input_tokens: 900000,
            cached_input_tokens: 900000,
            cache_write_input_tokens: 900000,
            output_tokens: 900000,
            reasoning_output_tokens: 900000,
            total_tokens: 4500000,
          },
        ),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);
    const split = breakdown({
      uncachedInputTokens: 10,
      cachedInputTokens: 5,
      cacheCreationTokens: 1,
      outputTokens: 2,
      reasoningTokens: 1,
    });

    expect(snapshot.series).toEqual([
      {
        key: "codex",
        label: "Codex",
        ...split,
        children: [{ key: "codex:unknown", label: "unknown", ...split }],
      },
    ]);
    expect(snapshot.totals.tokens).toBe(18);
  });

  test("caps a reasoning count that exceeds the output it belongs to, and keeps it out of tokens", async () => {
    const harness = createHarness({
      files: {
        [`${CODEX_DIR}/rollout.jsonl`]: codexUsageLine("2026-08-26T12:13:17.346Z", {
          input_tokens: 100,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 40,
          reasoning_output_tokens: 512,
          total_tokens: 652,
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.outputTokens).toBe(40);
    expect(snapshot.totals.reasoningTokens).toBe(40);
    expect(snapshot.totals.tokens).toBe(140);
  });

  test("drops re-emitted identical snapshots", async () => {
    const line = codexUsageLine("2026-08-26T12:13:17.346Z", {
      input_tokens: 100,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: 0,
      total_tokens: 110,
    });
    const harness = createHarness({
      files: {
        [`${CODEX_DIR}/rollout.jsonl`]: `${line}\n${line}\n${line}`,
        [`${HOME}/.codex/archived_sessions/old.jsonl`]: line,
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.tokens).toBe(110);
  });

  test("scans the CODEX_HOME root itself when neither sessions directory yields files", async () => {
    const harness = createHarness({
      env: { CODEX_HOME: "/srv/codex" },
      files: {
        "/srv/codex/loose.jsonl": codexUsageLine("2026-08-26T12:13:17.346Z", {
          input_tokens: 4,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          total_tokens: 5,
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.tokens).toBe(5);
  });
});

describe("readUsageHistorySnapshot: omp sessions", () => {
  test("attributes a usage line to the vendor of the preceding model_change", async () => {
    const harness = createHarness({
      files: {
        [`${OMP_DIR}/a.jsonl`]: [
          ompModelChangeLine("2026-08-26T12:00:00.000Z", "anthropic/claude-opus-5"),
          ompUsageLine({
            timestamp: "2026-08-26T12:13:09.875Z",
            model: "claude-opus-5",
            input: 2,
            output: 452,
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);
    const split = breakdown({
      uncachedInputTokens: 2,
      outputTokens: 452,
      costUsd: OMP_REPORTED_COST,
    });

    expect(snapshot.series).toEqual([
      {
        key: "omp-anthropic",
        label: "Anthropic (omp)",
        ...split,
        children: [{ key: "omp-anthropic:claude-opus-5", label: "claude-opus-5", ...split }],
      },
    ]);
  });

  test("re-attributes later rows after a mid-file model_change", async () => {
    const harness = createHarness({
      files: {
        [`${OMP_DIR}/a.jsonl`]: [
          ompModelChangeLine("2026-08-26T12:00:00.000Z", "anthropic/claude-opus-5"),
          ompUsageLine({
            timestamp: "2026-08-26T12:05:00.000Z",
            model: "claude-opus-5",
            id: "line-1",
            input: 10,
            output: 0,
          }),
          ompModelChangeLine("2026-08-26T12:10:00.000Z", "google-antigravity/gemini-3-pro"),
          ompUsageLine({
            timestamp: "2026-08-26T12:15:00.000Z",
            model: "gemini-3-pro",
            id: "line-2",
            input: 20,
            output: 0,
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.series.map((entry) => [entry.key, entry.label, entry.tokens])).toEqual([
      ["omp-google-antigravity", "Google Antigravity (omp)", 20],
      ["omp-anthropic", "Anthropic (omp)", 10],
    ]);
  });

  test("falls back to the bare model under an unknown vendor before any model_change", async () => {
    const harness = createHarness({
      files: {
        [`${OMP_DIR}/a.jsonl`]: [
          ompUsageLine({
            timestamp: "2026-08-26T12:05:00.000Z",
            model: "gpt-5.6-sol",
            id: "line-early",
            input: 7,
            output: 3,
          }),
          ompModelChangeLine("2026-08-26T12:10:00.000Z", "openai-codex/gpt-5.6-sol"),
          ompUsageLine({
            timestamp: "2026-08-26T12:15:00.000Z",
            model: "gpt-5.6-sol",
            id: "line-late",
            input: 1,
            output: 1,
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);
    const unknownVendor = snapshot.series.find((entry) => entry.key === "omp-unknown");

    expect(unknownVendor?.tokens).toBe(10);
    expect(unknownVendor?.children.map((child) => [child.key, child.tokens])).toEqual([
      ["omp-unknown:gpt-5.6-sol", 10],
    ]);
  });

  test("splits cacheRead and cacheWrite into their own categories without adding totalTokens", async () => {
    const harness = createHarness({
      files: {
        [`${OMP_DIR}/a.jsonl`]: [
          ompModelChangeLine("2026-08-26T12:00:00.000Z", "anthropic/claude-opus-5"),
          ompUsageLine({
            timestamp: "2026-08-26T12:13:09.875Z",
            model: "claude-opus-5",
            input: 2,
            output: 452,
            cacheRead: 796529,
            cacheWrite: 1982,
            reasoningTokens: 300,
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.uncachedInputTokens).toBe(2);
    expect(snapshot.totals.cachedInputTokens).toBe(796529);
    expect(snapshot.totals.cacheCreationTokens).toBe(1982);
    expect(snapshot.totals.cacheCreationLongTtlTokens).toBe(0);
    expect(snapshot.totals.outputTokens).toBe(452);
    expect(snapshot.totals.reasoningTokens).toBe(300);
    expect(snapshot.totals.tokens).toBe(2 + 796529 + 1982 + 452);
  });

  test("counts a line id repeated across an append-only re-scan once", async () => {
    const line = ompUsageLine({
      timestamp: "2026-08-26T12:13:09.875Z",
      model: "claude-opus-5",
      id: "c771e912",
      input: 100,
      output: 20,
    });
    const change = ompModelChangeLine("2026-08-26T12:00:00.000Z", "anthropic/claude-opus-5");
    const harness = createHarness({
      files: {
        [`${OMP_DIR}/a.jsonl`]: [change, line, line].join("\n"),
        [`${OMP_DIR}/copy.jsonl`]: [change, line].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.tokens).toBe(120);
  });

  test("skips a malformed line and a line carrying no usage", async () => {
    const harness = createHarness({
      files: {
        [`${OMP_DIR}/a.jsonl`]: [
          '{"type":"message","message":{"usage":{ truncated',
          JSON.stringify({ type: "custom", timestamp: NOW, data: { usage: { input: 5 } } }),
          ompModelChangeLine("2026-08-26T12:00:00.000Z", "anthropic/claude-opus-5"),
          ompUsageLine({
            timestamp: "2026-08-26T12:13:09.875Z",
            model: "claude-opus-5",
            input: 1,
            output: 1,
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.scanErrors).toEqual([]);
    expect(snapshot.totals.tokens).toBe(2);
  });

  test("reads the PI_CODING_AGENT_DIR sessions tree instead of the home default", async () => {
    const harness = createHarness({
      env: { PI_CODING_AGENT_DIR: "/srv/omp-agent" },
      files: {
        [`${OMP_DIR}/ignored.jsonl`]: [
          ompModelChangeLine("2026-08-26T12:00:00.000Z", "anthropic/claude-opus-5"),
          ompUsageLine({
            timestamp: "2026-08-26T12:13:09.875Z",
            model: "claude-opus-5",
            id: "ignored",
            input: 999,
            output: 999,
          }),
        ].join("\n"),
        "/srv/omp-agent/sessions/-proj/a.jsonl": [
          ompModelChangeLine("2026-08-26T12:00:00.000Z", "anthropic/claude-sonnet-5"),
          ompUsageLine({
            timestamp: "2026-08-26T12:13:09.875Z",
            model: "claude-sonnet-5",
            id: "kept",
            input: 4,
            output: 1,
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.tokens).toBe(5);
  });

  test("reads the profile sessions tree named by OMP_PROFILE", async () => {
    const harness = createHarness({
      env: { OMP_PROFILE: "work" },
      files: {
        [`${HOME}/.omp/profiles/work/agent/sessions/-proj/a.jsonl`]: [
          ompModelChangeLine("2026-08-26T12:00:00.000Z", "anthropic/claude-opus-5"),
          ompUsageLine({
            timestamp: "2026-08-26T12:13:09.875Z",
            model: "claude-opus-5",
            input: 6,
            output: 2,
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.totals.tokens).toBe(8);
  });
});

describe("readAgentProviderWindows", () => {
  const HOUR_MS = 3_600_000;
  const SESSION_MS = 5 * HOUR_MS;
  const WEEK_MS = 7 * 24 * HOUR_MS;

  function ompHarness(lines: readonly string[]) {
    return createHarness({ files: { [`${OMP_DIR}/a.jsonl`]: lines.join("\n") } });
  }

  test("keeps each window to the rows inside it", () => {
    const harness = ompHarness([
      ompModelChangeLine("2026-08-19T00:00:00.000Z", "google-antigravity/gemini-3-pro"),
      // NOW is 2026-08-26T12:30Z: one turn inside the 5-hour window, one
      // outside it but inside the week.
      ompUsageLine({ timestamp: "2026-08-26T10:00:00.000Z", model: "g", id: "recent", input: 10, output: 0 }),
      ompUsageLine({ timestamp: "2026-08-24T10:00:00.000Z", model: "g", id: "older", input: 400, output: 0 }),
    ]);

    const [session, week] = readAgentProviderWindows(
      "omp-google-antigravity",
      [SESSION_MS, WEEK_MS],
      harness.adapters,
    );

    expect(session).toEqual({ windowMs: SESSION_MS, requests: 1, tokens: 10, costUsd: OMP_REPORTED_COST });
    expect(week).toEqual({
      windowMs: WEEK_MS,
      requests: 2,
      tokens: 410,
      costUsd: OMP_REPORTED_COST * 2,
    });
  });

  test("counts only the provider asked for", () => {
    const harness = ompHarness([
      ompModelChangeLine("2026-08-26T10:00:00.000Z", "google-antigravity/gemini-3-pro"),
      ompUsageLine({ timestamp: "2026-08-26T11:00:00.000Z", model: "g", id: "gemini", input: 10, output: 0 }),
      ompModelChangeLine("2026-08-26T11:30:00.000Z", "anthropic/claude-opus-5"),
      ompUsageLine({ timestamp: "2026-08-26T12:00:00.000Z", model: "c", id: "claude", input: 999, output: 0 }),
    ]);

    const [window] = readAgentProviderWindows(
      "omp-google-antigravity",
      [SESSION_MS],
      harness.adapters,
    );

    expect(window).toMatchObject({ requests: 1, tokens: 10 });
  });

  test("withholds the cost of a window where one turn priced itself and another did not", () => {
    const harness = ompHarness([
      ompModelChangeLine("2026-08-26T10:00:00.000Z", "google-antigravity/gemini-3-pro"),
      ompUsageLine({ timestamp: "2026-08-26T11:00:00.000Z", model: "g", id: "priced", input: 10, output: 0 }),
      ompUsageLine({
        timestamp: "2026-08-26T11:10:00.000Z",
        model: "g",
        id: "unpriced",
        input: 10,
        output: 0,
        costTotal: null,
      }),
    ]);

    const [window] = readAgentProviderWindows(
      "omp-google-antigravity",
      [SESSION_MS],
      harness.adapters,
    );

    expect(window).toMatchObject({ requests: 2, tokens: 20, costUsd: null });
  });

  test("reports an empty window rather than nothing when the provider is idle", () => {
    const harness = ompHarness([]);

    const [window] = readAgentProviderWindows(
      "omp-google-antigravity",
      [SESSION_MS],
      harness.adapters,
    );

    expect(window).toEqual({ windowMs: SESSION_MS, requests: 0, tokens: 0, costUsd: 0 });
  });
});

describe("readUsageHistorySnapshot: windowing", () => {
  test("drops rows older than the window even when their file is fresh", async () => {
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: [
          claudeLine({
            timestamp: "2026-08-24T12:12:34.035Z",
            id: "msg_old",
            usage: { input_tokens: 999, output_tokens: 999 },
          }),
          claudeLine({
            timestamp: "2026-08-26T12:12:34.035Z",
            id: "msg_new",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(harness.reads).toEqual([`${CLAUDE_DIR}/a.jsonl`]);
    expect(snapshot.totals.tokens).toBe(2);
  });

  test("never reads a file whose mtime predates the window", async () => {
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/stale.jsonl`]: {
          text: claudeLine({
            timestamp: "2026-08-26T12:12:34.035Z",
            usage: { input_tokens: 500, output_tokens: 500 },
          }),
          mtime: "2026-08-23T00:00:00.000Z",
        },
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(harness.reads).toEqual([]);
    expect(snapshot.totals.tokens).toBe(0);
    expect(snapshot.scanErrors).toEqual([]);
  });

  test("emits a contiguous hour-aligned axis for 24h", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, createHarness().adapters);

    expect(snapshot.bucketMs).toBe(60 * 60 * 1000);
    expect(snapshot.buckets).toHaveLength(25);
    expect(snapshot.buckets[0]?.start).toBe("2026-08-25T12:00:00.000Z");
    expect(snapshot.buckets[24]?.start).toBe("2026-08-26T12:00:00.000Z");
    expect(snapshot.buckets.every((bucket) => bucket.tokens === 0)).toBe(true);
    expect(snapshot.buckets.every((bucket) => bucket.values.length === 0)).toBe(true);
    expect(snapshot.from).toBe("2026-08-25T12:30:00.000Z");
    expect(snapshot.to).toBe(NOW);
  });

  test("emits a contiguous six-hour axis for 7d", async () => {
    const snapshot = await readUsageHistorySnapshot(
      { range: "7d", groupBy: "provider" },
      createHarness().adapters,
    );

    expect(snapshot.bucketMs).toBe(6 * 60 * 60 * 1000);
    expect(snapshot.buckets).toHaveLength(29);
    expect(snapshot.buckets[0]?.start).toBe("2026-08-19T12:00:00.000Z");
    expect(snapshot.buckets[28]?.start).toBe("2026-08-26T12:00:00.000Z");
  });

  test("emits a contiguous day axis for 30d", async () => {
    const snapshot = await readUsageHistorySnapshot(
      { range: "30d", groupBy: "provider" },
      createHarness().adapters,
    );

    expect(snapshot.bucketMs).toBe(24 * 60 * 60 * 1000);
    expect(snapshot.buckets).toHaveLength(31);
    expect(snapshot.buckets[0]?.start).toBe("2026-07-27T00:00:00.000Z");
    expect(snapshot.buckets[30]?.start).toBe("2026-08-26T00:00:00.000Z");
  });
});

describe("readUsageHistorySnapshot: series and nesting", () => {
  function mixedHarness(): Harness {
    return createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: [
          claudeLine({
            timestamp: "2026-08-26T12:12:34.035Z",
            id: "msg_opus",
            model: "claude-opus-5",
            usage: { input_tokens: 100, output_tokens: 0 },
          }),
          claudeLine({
            timestamp: "2026-08-26T11:12:34.035Z",
            id: "msg_haiku",
            model: "claude-haiku-9",
            usage: { input_tokens: 40, output_tokens: 0 },
          }),
        ].join("\n"),
        [`${CODEX_DIR}/rollout.jsonl`]: [
          codexContextLine("2026-08-26T12:00:00.000Z", "gpt-5.6-terra"),
          codexUsageLine("2026-08-26T12:13:17.346Z", {
            input_tokens: 50,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 0,
            total_tokens: 55,
          }),
        ].join("\n"),
      },
    });
  }

  test("keys series by provider and sorts them by tokens descending", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, mixedHarness().adapters);

    expect(snapshot.series.map((entry) => [entry.key, entry.tokens])).toEqual([
      ["claude-code", 140],
      ["codex", 55],
    ]);
    expect(bucketAt(snapshot, "2026-08-26T12:00:00.000Z").values).toEqual([
      { seriesKey: "claude-code", parentKey: null, ...breakdown({ uncachedInputTokens: 100 }) },
      {
        seriesKey: "claude-code:claude-opus-5",
        parentKey: "claude-code",
        ...breakdown({ uncachedInputTokens: 100 }),
      },
      {
        seriesKey: "codex",
        parentKey: null,
        ...breakdown({ uncachedInputTokens: 50, outputTokens: 5 }),
      },
      {
        seriesKey: "codex:gpt-5.6-terra",
        parentKey: "codex",
        ...breakdown({ uncachedInputTokens: 50, outputTokens: 5 }),
      },
    ]);
    expect(bucketAt(snapshot, "2026-08-26T11:00:00.000Z").values).toEqual([
      { seriesKey: "claude-code", parentKey: null, ...breakdown({ uncachedInputTokens: 40 }) },
      {
        seriesKey: "claude-code:claude-haiku-9",
        parentKey: "claude-code",
        ...breakdown({ uncachedInputTokens: 40 }),
      },
    ]);
  });

  test("a provider carries the models it ran as children, ranked by tokens", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, mixedHarness().adapters);

    expect(snapshot.series.map((entry) => entry.children.map((child) => child.key))).toEqual([
      ["claude-code:claude-opus-5", "claude-code:claude-haiku-9"],
      ["codex:gpt-5.6-terra"],
    ]);
    expect(snapshot.series[0]?.children.map((child) => [child.label, child.tokens])).toEqual([
      ["claude-opus-5", 100],
      ["claude-haiku-9", 40],
    ]);
  });
});

describe("readUsageHistorySnapshot: model grouping", () => {
  function crossProviderHarness(): Harness {
    return createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: [
          claudeLine({
            timestamp: "2026-08-26T12:12:34.035Z",
            id: "msg_opus_cli",
            model: "claude-opus-5",
            usage: { input_tokens: 100, output_tokens: 0 },
          }),
          claudeLine({
            timestamp: "2026-08-26T11:12:34.035Z",
            id: "msg_haiku_cli",
            model: "claude-haiku-9",
            usage: { input_tokens: 40, output_tokens: 0 },
          }),
        ].join("\n"),
        [`${OMP_DIR}/a.jsonl`]: [
          ompModelChangeLine("2026-08-26T12:00:00.000Z", "anthropic/claude-opus-5"),
          ompUsageLine({
            timestamp: "2026-08-26T12:13:09.875Z",
            model: "claude-opus-5",
            id: "omp_opus",
            input: 60,
            output: 0,
          }),
          ompModelChangeLine("2026-08-26T12:20:00.000Z", "google-antigravity/gemini-3-pro"),
          ompUsageLine({
            timestamp: "2026-08-26T12:25:00.000Z",
            model: "gemini-3-pro",
            id: "omp_gemini",
            input: 20,
            output: 0,
          }),
        ].join("\n"),
      },
    });
  }

  test("keys one series per provider-and-model pair across every provider", async () => {
    const snapshot = await readUsageHistorySnapshot(MODEL_QUERY, crossProviderHarness().adapters);

    expect(snapshot.series.map((entry) => [entry.key, entry.label, entry.tokens])).toEqual([
      ["claude-code:claude-opus-5", "claude-opus-5 · Claude Code", 100],
      ["omp-anthropic:claude-opus-5", "claude-opus-5 · Anthropic (omp)", 60],
      ["claude-code:claude-haiku-9", "claude-haiku-9", 40],
      ["omp-google-antigravity:gemini-3-pro", "gemini-3-pro", 20],
    ]);
    expect(snapshot.totals.tokens).toBe(220);
  });

  test("carries the model series keys into every bucket value", async () => {
    const snapshot = await readUsageHistorySnapshot(MODEL_QUERY, crossProviderHarness().adapters);

    expect(bucketAt(snapshot, "2026-08-26T12:00:00.000Z").values).toEqual([
      {
        seriesKey: "claude-code:claude-opus-5",
        parentKey: null,
        ...breakdown({ uncachedInputTokens: 100 }),
      },
      {
        seriesKey: "omp-anthropic:claude-opus-5",
        parentKey: null,
        ...breakdown({ uncachedInputTokens: 60, costUsd: OMP_REPORTED_COST }),
      },
      {
        seriesKey: "omp-google-antigravity:gemini-3-pro",
        parentKey: null,
        ...breakdown({ uncachedInputTokens: 20, costUsd: OMP_REPORTED_COST }),
      },
    ]);
    expect(bucketAt(snapshot, "2026-08-26T11:00:00.000Z").values).toEqual([
      {
        seriesKey: "claude-code:claude-haiku-9",
        parentKey: null,
        ...breakdown({ uncachedInputTokens: 40 }),
      },
    ]);
  });
});

describe("readUsageHistorySnapshot: nested invariants", () => {
  /**
   * Two providers, two models each, every counter non-zero: the shape that makes
   * an arithmetic slip between the two levels visible.
   */
  function nestedHarness(): Harness {
    return createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: [
          claudeLine({
            timestamp: "2026-08-26T12:12:34.035Z",
            id: "msg_opus",
            model: "claude-opus-5",
            usage: {
              input_tokens: 11,
              output_tokens: 7,
              cache_read_input_tokens: 900,
              cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 },
            },
          }),
          claudeLine({
            timestamp: "2026-08-26T11:12:34.035Z",
            id: "msg_haiku",
            model: "claude-haiku-9",
            usage: {
              input_tokens: 3,
              output_tokens: 1,
              cache_read_input_tokens: 20,
              cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 5 },
            },
          }),
        ].join("\n"),
        [`${CODEX_DIR}/rollout.jsonl`]: [
          codexContextLine("2026-08-26T12:00:00.000Z", "gpt-5.6-terra"),
          codexUsageLine("2026-08-26T12:13:17.346Z", {
            input_tokens: 500,
            cached_input_tokens: 100,
            cache_write_input_tokens: 9,
            output_tokens: 30,
            reasoning_output_tokens: 12,
            total_tokens: 639,
          }),
          codexContextLine("2026-08-26T12:20:00.000Z", "gpt-5.6-sol"),
          codexUsageLine("2026-08-26T12:25:00.000Z", {
            input_tokens: 40,
            cached_input_tokens: 10,
            cache_write_input_tokens: 1,
            output_tokens: 4,
            reasoning_output_tokens: 2,
            total_tokens: 55,
          }),
        ].join("\n"),
      },
    });
  }

  test("a provider's children sum to it on every counter, subsets included", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, nestedHarness().adapters);

    expect(snapshot.series.map((entry) => [entry.key, entry.tokens])).toEqual([
      ["claude-code", 1052],
      ["codex", 694],
    ]);
    expect(snapshot.series[0]?.cacheCreationLongTtlTokens).toBe(65);
    expect(snapshot.series[1]?.reasoningTokens).toBe(14);
    for (const entry of snapshot.series) expectCountersSum(entry.children, entry);
  });

  test("the model rows in a bucket sum to their provider's row in that bucket", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, nestedHarness().adapters);
    const bucket = bucketAt(snapshot, "2026-08-26T12:00:00.000Z");
    const parents = bucket.values.filter((value) => value.parentKey === null);

    expect(parents.map((value) => [value.seriesKey, value.tokens])).toEqual([
      ["claude-code", 1018],
      ["codex", 694],
    ]);
    for (const parent of parents) {
      expectCountersSum(
        bucket.values.filter((value) => value.parentKey === parent.seriesKey),
        parent,
      );
    }
    expect(
      bucket.values.filter((value) => value.parentKey === "codex").map((value) => value.seriesKey),
    ).toEqual(["codex:gpt-5.6-terra", "codex:gpt-5.6-sol"]);
  });

  test("a bucket's totals sum only its top-level rows, never the models again", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, nestedHarness().adapters);
    const bucket = bucketAt(snapshot, "2026-08-26T12:00:00.000Z");
    const everyRow = bucket.values.reduce((sum, value) => sum + value.tokens, 0);

    expect(bucket.tokens).toBe(1018 + 694);
    expectCountersSum(
      bucket.values.filter((value) => value.parentKey === null),
      bucket,
    );
    expect(everyRow).toBe(bucket.tokens * 2);
  });

  test("the top level sums to the snapshot totals with the models left out", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, nestedHarness().adapters);

    expectCountersSum(snapshot.series, snapshot.totals);
    expect(snapshot.totals.tokens).toBe(1052 + 694);
  });

  test("grouping by model lifts the models to the top level and leaves no children", async () => {
    const snapshot = await readUsageHistorySnapshot(MODEL_QUERY, nestedHarness().adapters);
    const parentKeys = snapshot.buckets.flatMap((bucket) =>
      bucket.values.map((value) => value.parentKey),
    );

    expect(snapshot.series.map((entry) => entry.key)).toEqual([
      "claude-code:claude-opus-5",
      "codex:gpt-5.6-terra",
      "codex:gpt-5.6-sol",
      "claude-code:claude-haiku-9",
    ]);
    expect(snapshot.series.every((entry) => entry.children.length === 0)).toBe(true);
    expect(parentKeys.every((key) => key === null)).toBe(true);
  });

  test("a provider that ran exactly one model still carries a one-element children array", async () => {
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.series[0]?.children).toHaveLength(1);
    expect(snapshot.series[0]?.children[0]?.key).toBe("claude-code:claude-opus-5");
    expect(snapshot.series[0]?.children[0]?.tokens).toBe(10);
  });

  test("one unpriced model empties its provider's cost while its sibling keeps a figure", async () => {
    const harness = createHarness({
      rates: {
        "gpt-5.6-terra": { input_cost_per_token: 0.000001, output_cost_per_token: 0.00001 },
      },
      files: {
        [`${CODEX_DIR}/rollout.jsonl`]: [
          codexContextLine("2026-08-26T12:00:00.000Z", "gpt-5.6-terra"),
          codexUsageLine("2026-08-26T12:10:00.000Z", {
            input_tokens: 1000,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 1000,
          }),
          codexContextLine("2026-08-26T12:20:00.000Z", "gpt-5.6-unlisted"),
          codexUsageLine("2026-08-26T12:25:00.000Z", {
            input_tokens: 7,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 7,
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);
    const codex = snapshot.series[0];
    const bucket = bucketAt(snapshot, "2026-08-26T12:00:00.000Z");

    expect(
      codex?.children.find((child) => child.key === "codex:gpt-5.6-terra")?.costUsd,
    ).toBeCloseTo(0.001, 10);
    expect(
      codex?.children.find((child) => child.key === "codex:gpt-5.6-unlisted")?.costUsd,
    ).toBeNull();
    expect(codex?.costUsd).toBeNull();
    expect(bucket.values.find((value) => value.parentKey === null)?.costUsd).toBeNull();
    expect(snapshot.totals.costUsd).toBeNull();
  });
});

describe("readUsageHistorySnapshot: failures", () => {
  test("reports one scanError for an unreadable file and still aggregates the rest", async () => {
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/broken.jsonl`]: { text: null, mtime: NOW },
        [`${CLAUDE_DIR}/good.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.scanErrors).toEqual([
      { source: `${CLAUDE_DIR}/broken.jsonl`, message: "Could not read transcript file" },
    ]);
    expect(snapshot.totals.tokens).toBe(7);
  });

  test("reports a directory scan failure without throwing", async () => {
    const harness = createHarness({
      directoryFailures: { [`${HOME}/.claude/projects`]: "EACCES: permission denied" },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(
      snapshot.scanErrors.map((e) => ({
        source: e.source.replace(/\\/g, "/"),
        message: e.message,
      })),
    ).toEqual([{ source: `${HOME}/.claude/projects`, message: "EACCES: permission denied" }]);
  });

  test("skips malformed lines without reporting an error", async () => {
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: [
          '{"type":"assistant","message":{"usage":{ truncated',
          claudeLine({
            timestamp: "2026-08-26T12:12:34.035Z",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          "",
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.scanErrors).toEqual([]);
    expect(snapshot.totals.tokens).toBe(2);
  });

  test("a machine with no agent logs returns an empty snapshot", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, createHarness().adapters);

    expect(snapshot.series).toEqual([]);
    expect(snapshot.scanErrors).toEqual([]);
    expect(snapshot.totals).toEqual(breakdown({ costUsd: 0, cacheSavingsUsd: 0 }));
    expect(snapshot.buckets).toHaveLength(25);
  });
});

describe("readUsageHistorySnapshot: metric split", () => {
  function splitHarness(): Harness {
    return createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: {
            input_tokens: 2,
            output_tokens: 10,
            cache_creation_input_tokens: 36510,
            cache_read_input_tokens: 20228,
          },
        }),
        [`${CODEX_DIR}/rollout.jsonl`]: [
          codexContextLine("2026-08-26T12:00:00.000Z", "gpt-5.6-terra"),
          codexUsageLine("2026-08-26T12:13:17.346Z", {
            input_tokens: 24741,
            cached_input_tokens: 11008,
            cache_write_input_tokens: 7,
            output_tokens: 13,
            reasoning_output_tokens: 2,
            total_tokens: 24756,
          }),
        ].join("\n"),
      },
    });
  }

  test("splits a Claude and a Codex row across every bucket value at both levels", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, splitHarness().adapters);
    const claude = breakdown({
      uncachedInputTokens: 2,
      cachedInputTokens: 20228,
      cacheCreationTokens: 36510,
      outputTokens: 10,
    });
    const codex = breakdown({
      uncachedInputTokens: 24741,
      cachedInputTokens: 11008,
      cacheCreationTokens: 7,
      outputTokens: 13,
      reasoningTokens: 2,
    });

    expect(bucketAt(snapshot, "2026-08-26T12:00:00.000Z").values).toEqual([
      { seriesKey: "claude-code", parentKey: null, ...claude },
      { seriesKey: "claude-code:claude-opus-5", parentKey: "claude-code", ...claude },
      { seriesKey: "codex", parentKey: null, ...codex },
      { seriesKey: "codex:gpt-5.6-terra", parentKey: "codex", ...codex },
    ]);
  });

  test("a bucket carries the sum of its values", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, splitHarness().adapters);
    const bucket = bucketAt(snapshot, "2026-08-26T12:00:00.000Z");

    expect(bucket.uncachedInputTokens).toBe(24743);
    expect(bucket.cachedInputTokens).toBe(31236);
    expect(bucket.cacheCreationTokens).toBe(36517);
    expect(bucket.outputTokens).toBe(23);
    expect(bucket.reasoningTokens).toBe(2);
    expect(bucket.tokens).toBe(92519);
    expect(bucket.tokens).toBe(
      bucket.uncachedInputTokens +
        bucket.cachedInputTokens +
        bucket.cacheCreationTokens +
        bucket.outputTokens,
    );
  });

  test("the snapshot totals carry the split across both providers", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, splitHarness().adapters);

    expect(snapshot.totals.uncachedInputTokens).toBe(24743);
    expect(snapshot.totals.cachedInputTokens).toBe(31236);
    expect(snapshot.totals.cacheCreationTokens).toBe(36517);
    expect(snapshot.totals.outputTokens).toBe(23);
    expect(snapshot.totals.reasoningTokens).toBe(2);
    expect(snapshot.totals.tokens).toBe(92519);
  });

  test("empty buckets report a zeroed split", async () => {
    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, splitHarness().adapters);

    expect(bucketAt(snapshot, "2026-08-26T03:00:00.000Z")).toEqual({
      start: "2026-08-26T03:00:00.000Z",
      ...breakdown({ costUsd: 0, cacheSavingsUsd: 0 }),
      values: [],
    });
  });
});

describe("readUsageHistorySnapshot: cost", () => {
  const TERRA_RATES: Record<string, RateEntry> = {
    "gpt-5.6-terra": {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.00001,
      cache_read_input_token_cost: 0.0000001,
      cache_creation_input_token_cost: 0.000002,
    },
  };

  function codexHarness(rates: Record<string, RateEntry> | undefined): Harness {
    return createHarness({
      rates,
      files: {
        [`${CODEX_DIR}/rollout.jsonl`]: [
          codexContextLine("2026-08-26T12:00:00.000Z", "gpt-5.6-terra"),
          codexUsageLine("2026-08-26T12:13:17.346Z", {
            input_tokens: 1000,
            cached_input_tokens: 2000,
            cache_write_input_tokens: 500,
            output_tokens: 100,
            reasoning_output_tokens: 20,
            total_tokens: 3620,
          }),
        ].join("\n"),
      },
    });
  }

  test("uses the cost the log reported and never re-prices it", async () => {
    const harness = createHarness({
      rates: {
        "claude-opus-5": { input_cost_per_token: 999, output_cost_per_token: 999 },
      },
      files: {
        [`${OMP_DIR}/a.jsonl`]: [
          ompModelChangeLine("2026-08-26T12:00:00.000Z", "anthropic/claude-opus-5"),
          ompUsageLine({
            timestamp: "2026-08-26T12:13:09.875Z",
            model: "claude-opus-5",
            input: 2,
            output: 452,
            costTotal: 0.75,
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.series[0]?.costUsd).toBe(0.75);
    expect(snapshot.totals.costUsd).toBe(0.75);
  });

  test("prices a row from the rate table when the log reported no cost", async () => {
    const snapshot = await readUsageHistorySnapshot(
      PROVIDER_QUERY,
      codexHarness(TERRA_RATES).adapters,
    );

    expect(snapshot.totals.costUsd).toBeCloseTo(0.0032, 10);
    expect(snapshot.totals.cacheSavingsUsd).toBeCloseTo(0.0018, 10);
    expect(snapshot.rates.status).toBe("fresh");
    expect(snapshot.rates.fetchedAt).toBe(NOW);
  });

  test("reports no cost at all when the table knows no rate for the model", async () => {
    const snapshot = await readUsageHistorySnapshot(
      PROVIDER_QUERY,
      codexHarness(undefined).adapters,
    );

    expect(snapshot.totals.costUsd).toBeNull();
    expect(snapshot.totals.cacheSavingsUsd).toBeNull();
    expect(snapshot.rates).toEqual({
      status: "unavailable",
      fetchedAt: null,
      pricedModels: [],
      unpricedModels: ["gpt-5.6-terra"],
    });
  });

  test("an aggregate holding one unpriceable row reports no cost rather than a partial sum", async () => {
    const harness = createHarness({
      rates: TERRA_RATES,
      files: {
        [`${CODEX_DIR}/rollout.jsonl`]: [
          codexContextLine("2026-08-26T12:00:00.000Z", "gpt-5.6-terra"),
          codexUsageLine("2026-08-26T12:10:00.000Z", {
            input_tokens: 1000,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 1000,
          }),
          codexContextLine("2026-08-26T12:20:00.000Z", "gpt-5.6-unlisted"),
          codexUsageLine("2026-08-26T12:25:00.000Z", {
            input_tokens: 7,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 7,
          }),
        ].join("\n"),
      },
    });

    const byProvider = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);
    const byModel = await readUsageHistorySnapshot(MODEL_QUERY, harness.adapters);
    const priced = byModel.series.find((entry) => entry.key === "codex:gpt-5.6-terra");
    const unpriced = byModel.series.find((entry) => entry.key === "codex:gpt-5.6-unlisted");

    expect(byProvider.series[0]?.costUsd).toBeNull();
    expect(byProvider.totals.costUsd).toBeNull();
    expect(byProvider.totals.tokens).toBe(1007);
    expect(priced?.costUsd).toBeCloseTo(0.001, 10);
    expect(unpriced?.costUsd).toBeNull();
    expect(byModel.totals.costUsd).toBeNull();
  });

  test("names the models a rate was found for and those that had none", async () => {
    const harness = createHarness({
      rates: TERRA_RATES,
      files: {
        [`${CODEX_DIR}/rollout.jsonl`]: [
          codexContextLine("2026-08-26T12:00:00.000Z", "gpt-5.6-terra"),
          codexUsageLine("2026-08-26T12:10:00.000Z", {
            input_tokens: 1000,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 1000,
          }),
        ].join("\n"),
        [`${CLAUDE_DIR}/a.jsonl`]: [
          claudeLine({
            timestamp: "2026-08-26T12:12:34.035Z",
            id: "msg_opus",
            model: "claude-opus-5",
            usage: { input_tokens: 5, output_tokens: 5 },
          }),
          claudeLine({
            timestamp: "2026-08-26T12:13:34.035Z",
            id: "msg_haiku",
            model: "claude-haiku-9",
            usage: { input_tokens: 5, output_tokens: 5 },
          }),
        ].join("\n"),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.rates).toEqual({
      status: "fresh",
      fetchedAt: NOW,
      pricedModels: ["gpt-5.6-terra"],
      unpricedModels: ["claude-haiku-9", "claude-opus-5"],
    });
  });
});

describe("readUsageHistorySnapshot: scan cache", () => {
  function cachedHarness(): Harness {
    return createHarness({
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: {
            input_tokens: 2,
            output_tokens: 10,
            cache_read_input_tokens: 20228,
            cache_creation: { ephemeral_1h_input_tokens: 500 },
          },
        }),
      },
    });
  }

  test("reuses the rows of an unchanged file instead of reading it again", async () => {
    const harness = cachedHarness();

    const cold = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(harness.reads).toEqual([`${CLAUDE_DIR}/a.jsonl`]);
    expect(harness.cacheWrites).toBe(1);

    harness.reads.length = 0;
    const warm = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(harness.reads).toEqual([]);
    expect(harness.cacheWrites).toBe(1);
    expect(warm.totals).toEqual(cold.totals);
    expect(warm.totals.cacheCreationLongTtlTokens).toBe(500);
  });

  test("re-reads a file whose size and mtime moved on", async () => {
    const harness = cachedHarness();
    await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);
    harness.reads.length = 0;
    harness.files.set(`${CLAUDE_DIR}/a.jsonl`, {
      text: claudeLine({
        timestamp: "2026-08-26T12:20:00.000Z",
        id: "msg_appended",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      mtime: "2026-08-26T12:25:00.000Z",
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(harness.reads).toEqual([`${CLAUDE_DIR}/a.jsonl`]);
    expect(snapshot.totals.tokens).toBe(2);
    expect(harness.cacheWrites).toBe(2);
  });

  test("ignores a corrupt cache file and scans every transcript", async () => {
    const harness = createHarness({
      scanCache: '{"version":1,"files":{ truncated',
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(harness.reads).toEqual([`${CLAUDE_DIR}/a.jsonl`]);
    expect(snapshot.totals.tokens).toBe(7);
    expect(snapshot.scanErrors).toEqual([]);
  });

  test("ignores a cache file written to an older shape", async () => {
    const harness = createHarness({
      scanCache: JSON.stringify({
        version: 1,
        files: { [`${CLAUDE_DIR}/a.jsonl`]: { mtimeMs: Date.parse(NOW), rows: [{ tokens: 99 }] } },
      }),
      files: {
        [`${CLAUDE_DIR}/a.jsonl`]: claudeLine({
          timestamp: "2026-08-26T12:12:34.035Z",
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(harness.reads).toEqual([`${CLAUDE_DIR}/a.jsonl`]);
    expect(snapshot.totals.tokens).toBe(7);
  });

  test("drops a cached entry whose file has gone", async () => {
    const harness = cachedHarness();
    await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);
    harness.files.delete(`${CLAUDE_DIR}/a.jsonl`);

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);
    const cache = harness.scanCache();

    expect(snapshot.totals.tokens).toBe(0);
    expect(cache).not.toBeNull();
    expect(JSON.parse(cache ?? "").files).toEqual({});
  });
});

describe("readUsageHistorySnapshot: read ceiling", () => {
  test("skips a transcript above the 64 MiB ceiling and names the limit", async () => {
    const line = claudeLine({
      timestamp: "2026-08-26T12:12:34.035Z",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/huge.jsonl`]: { text: line, mtime: NOW, size: 64 * 1024 * 1024 + 1 },
        [`${CLAUDE_DIR}/small.jsonl`]: line,
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(harness.reads).toEqual([`${CLAUDE_DIR}/small.jsonl`]);
    expect(snapshot.scanErrors).toEqual([
      {
        source: `${CLAUDE_DIR}/huge.jsonl`,
        message: "Transcript exceeds the 64 MiB scan limit",
      },
    ]);
    expect(snapshot.totals.tokens).toBe(2);
  });

  test("reads a transcript exactly at the ceiling", async () => {
    const line = claudeLine({
      timestamp: "2026-08-26T12:12:34.035Z",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const harness = createHarness({
      files: {
        [`${CLAUDE_DIR}/edge.jsonl`]: { text: line, mtime: NOW, size: 64 * 1024 * 1024 },
      },
    });

    const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, harness.adapters);

    expect(snapshot.scanErrors).toEqual([]);
    expect(snapshot.totals.tokens).toBe(2);
  });
});

describe("createNodeHistoryAdapters", () => {
  function nodeAdapters(root: string): HistoryAdapters {
    return {
      ...createNodeHistoryAdapters(),
      env: { CLAUDE_CONFIG_DIR: root },
      homeDir: root,
      pricing: createPricingStub(undefined, new Date().toISOString()),
    };
  }

  test.skipIf(process.platform === "win32")(
    "a nested unreadable directory yields the sibling rows and one scanError naming it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "usage-history-"));
      const locked = join(root, "projects", "locked");
      const line = claudeLine({
        timestamp: new Date().toISOString(),
        id: "msg_open",
        usage: { input_tokens: 3, output_tokens: 4 },
      });
      mkdirSync(join(root, "projects", "open"), { recursive: true });
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(root, "projects", "open", "a.jsonl"), line);
      writeFileSync(
        join(locked, "b.jsonl"),
        claudeLine({
          timestamp: new Date().toISOString(),
          id: "msg_locked",
          usage: { input_tokens: 900, output_tokens: 900 },
        }),
      );
      chmodSync(locked, 0o000);

      try {
        const snapshot = await readUsageHistorySnapshot(PROVIDER_QUERY, nodeAdapters(root));

        expect(snapshot.totals.tokens).toBe(7);
        expect(snapshot.scanErrors).toHaveLength(1);
        expect(snapshot.scanErrors[0]?.source).toBe(locked);
        expect(snapshot.scanErrors[0]?.message).toContain("EACCES");
      } finally {
        chmodSync(locked, 0o700);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("writes the scan cache under the resolved paseo home and reads it back", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-history-"));
    mkdirSync(join(root, "projects", "open"), { recursive: true });
    writeFileSync(
      join(root, "projects", "open", "a.jsonl"),
      claudeLine({
        timestamp: new Date().toISOString(),
        id: "msg_cached",
        usage: { input_tokens: 11, output_tokens: 4 },
      }),
    );

    try {
      const adapters = nodeAdapters(root);
      const cold = await readUsageHistorySnapshot(PROVIDER_QUERY, adapters);
      const cachePath = join(root, ".paseo", "usage-limits", "scan-cache.json");

      expect(cold.totals.tokens).toBe(15);
      expect(existsSync(cachePath)).toBe(true);

      const warm = await readUsageHistorySnapshot(PROVIDER_QUERY, adapters);

      expect(warm.totals).toEqual(cold.totals);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns an empty scan with no error for a directory that does not exist", () => {
    const adapters = createNodeHistoryAdapters();

    expect(adapters.listFiles(join(tmpdir(), "usage-history-absent-9f2c"))).toEqual({
      files: [],
      errors: [],
    });
  });

  test.skipIf(process.platform === "win32")(
    "names the unreadable subdirectory itself rather than the root",
    () => {
      const root = mkdtempSync(join(tmpdir(), "usage-history-"));
      const locked = join(root, "projects", "locked");
      mkdirSync(join(root, "projects", "open"), { recursive: true });
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(root, "projects", "open", "a.jsonl"), "{}");
      chmodSync(locked, 0o000);

      try {
        const scan = createNodeHistoryAdapters().listFiles(join(root, "projects"));

        expect(scan.files).toEqual([join(root, "projects", "open", "a.jsonl")]);
        expect(scan.errors).toHaveLength(1);
        expect(scan.errors[0]?.source).toBe(locked);
        expect(scan.errors[0]?.message).toContain("EACCES");
      } finally {
        chmodSync(locked, 0o700);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
