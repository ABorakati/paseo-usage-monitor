import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  type UsageHistoryBucket,
  type UsageHistoryBucketValue,
  type UsageHistoryModelSeries,
  type UsageHistoryQuery,
  type UsageHistoryRange,
  type UsageHistoryScanError,
  type UsageHistorySeries,
  type UsageHistorySnapshot,
  type UsageRatesReport,
  type UsageTokenBreakdown,
  UsageTokenBreakdownSchema,
} from "./history.shared";
import {
  createNodePricingAdapters,
  loadPricingTable,
  type ModelRate,
  priceBreakdown,
  type PricingAdapters,
  type PricingTable,
} from "./pricing.server";

/** Every directory that could not be read names itself, siblings still reached. */
export interface UsageHistoryFileScan {
  files: string[];
  errors: UsageHistoryScanError[];
}

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export interface HistoryAdapters {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  listFiles(directory: string): UsageHistoryFileScan;
  statFile(path: string): FileStat | null;
  readTextFile(path: string): string | null;
  readScanCacheFile(path: string): string | null;
  writeScanCacheFile(path: string, content: string): void;
  pricing: PricingAdapters;
  now(): Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface RangeWindow {
  windowMs: number;
  bucketMs: number;
}

const RANGE_WINDOWS: Record<UsageHistoryRange, RangeWindow> = {
  "24h": { windowMs: 24 * HOUR_MS, bucketMs: HOUR_MS },
  "7d": { windowMs: 7 * DAY_MS, bucketMs: 6 * HOUR_MS },
  "30d": { windowMs: 30 * DAY_MS, bucketMs: DAY_MS },
};

const CLAUDE_PROVIDER_ID = "claude-code";
const CODEX_PROVIDER_ID = "codex";

/**
 * Paseo drives agents through omp, so the same vendor reaches the user twice:
 * once through its own CLI and once through omp. Prefixing keeps the two apart,
 * because merging them would hide which tool spent the tokens.
 */
const OMP_PROVIDER_PREFIX = "omp-";
const OMP_LABEL_SUFFIX = " (omp)";
const UNKNOWN_VENDOR = "unknown";
const OMP_UNKNOWN_PROVIDER_ID = `${OMP_PROVIDER_PREFIX}${UNKNOWN_VENDOR}`;

const PROVIDER_LABELS: Record<string, string> = {
  [CLAUDE_PROVIDER_ID]: "Claude Code",
  [CODEX_PROVIDER_ID]: "Codex",
};

/** Vendor slugs omp writes today; anything else is title-cased from its slug. */
const OMP_VENDOR_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  "google-antigravity": "Google Antigravity",
  "openai-codex": "OpenAI Codex",
  [UNKNOWN_VENDOR]: "Unknown",
};

const CLAUDE_PROJECTS_DIR = "projects";
const CLAUDE_USAGE_MARKER = '"usage":{';
const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";
const CODEX_USAGE_MARKER = '"last_token_usage"';
const CODEX_CONTEXT_MARKER = '"turn_context"';
const OMP_USAGE_MARKER = '"usage":{';
const OMP_MODEL_CHANGE_TYPE = "model_change";
const OMP_MODEL_CHANGE_MARKER = `"${OMP_MODEL_CHANGE_TYPE}"`;
const OMP_DEFAULT_CONFIG_DIR = ".omp";
const OMP_XDG_APP_DIR = "omp";
const OMP_AGENT_DIR = "agent";
const OMP_PROFILES_DIR = "profiles";
const OMP_SESSIONS_DIR = "sessions";
const UNKNOWN_MODEL = "unknown";
const JSONL_SUFFIX = ".jsonl";
const UNREADABLE_MESSAGE = "Could not read transcript file";

/**
 * The plugin subprocess reads transcripts synchronously and the daemon
 * abandons the RPC after 30s, so an unbounded rollout log would hang the read.
 */
const MAX_TRANSCRIPT_MIB = 64;
const MAX_TRANSCRIPT_BYTES = MAX_TRANSCRIPT_MIB * 1024 * 1024;

/**
 * A 30-day scan re-reads about 74 MiB of append-only transcripts on this
 * machine, and all but the few files touched today are byte-identical between
 * scans. Parsed rows are kept per file under its size and mtime, so an
 * unchanged file is never split, JSON-parsed or validated twice.
 */
const SCAN_CACHE_VERSION = 1;
const SCAN_CACHE_FILE = "scan-cache.json";
const MAX_SCAN_CACHE_FILES = 512;

const OptionalNumber = z.number().nullish();
const OptionalText = z.string().nullish();

const ClaudeUsageSchema = z.object({
  input_tokens: OptionalNumber,
  output_tokens: OptionalNumber,
  cache_creation_input_tokens: OptionalNumber,
  cache_read_input_tokens: OptionalNumber,
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: OptionalNumber,
      ephemeral_1h_input_tokens: OptionalNumber,
    })
    .nullish(),
});

const ClaudeLineSchema = z.object({
  timestamp: z.string(),
  requestId: OptionalText,
  isSidechain: z.boolean().nullish(),
  costUSD: OptionalNumber,
  message: z.object({
    id: OptionalText,
    model: OptionalText,
    usage: ClaudeUsageSchema,
  }),
});

const CodexLineSchema = z.object({
  timestamp: OptionalText,
  created_at: OptionalText,
  createdAt: OptionalText,
  payload: z.object({
    model: OptionalText,
    info: z
      .object({
        last_token_usage: z
          .object({
            input_tokens: OptionalNumber,
            cached_input_tokens: OptionalNumber,
            cache_write_input_tokens: OptionalNumber,
            output_tokens: OptionalNumber,
            reasoning_output_tokens: OptionalNumber,
            total_tokens: OptionalNumber,
          })
          .nullish(),
      })
      .nullish(),
  }),
});

/**
 * omp reports the bare model on each message and the vendor-qualified model on
 * a separate `model_change` line, so a row's provider only exists once the two
 * are read in order.
 */
const OmpLineSchema = z.object({
  type: OptionalText,
  id: OptionalText,
  timestamp: OptionalText,
  model: OptionalText,
  message: z
    .object({
      model: OptionalText,
      usage: z
        .object({
          input: OptionalNumber,
          output: OptionalNumber,
          cacheRead: OptionalNumber,
          cacheWrite: OptionalNumber,
          reasoningTokens: OptionalNumber,
          cost: z.object({ total: OptionalNumber }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

type ClaudeLine = z.infer<typeof ClaudeLineSchema>;
type ClaudeUsage = z.infer<typeof ClaudeUsageSchema>;
type CodexLine = z.infer<typeof CodexLineSchema>;
type OmpLine = z.infer<typeof OmpLineSchema>;

/**
 * One turn as its log recorded it. `breakdown.costUsd` is the vendor's own
 * figure or null when the log carried none, and `breakdown.cacheSavingsUsd` is
 * null until a rate table prices the row: neither is ever recomputed from a
 * cost the vendor already reported.
 */
const UsageRowSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  timestampMs: z.number(),
  /** Dedup identity within its own provider; null when the line carried none. */
  dedupKey: z.string().nullable(),
  /** Claude replays a sidechain turn under a fresh request id. */
  sidechain: z.boolean(),
  breakdown: UsageTokenBreakdownSchema,
});

const ScanCacheEntrySchema = z.object({
  mtimeMs: z.number(),
  size: z.number(),
  rows: z.array(UsageRowSchema),
});

const ScanCacheFileSchema = z.object({
  version: z.literal(SCAN_CACHE_VERSION),
  files: z.record(z.string(), ScanCacheEntrySchema),
});

type UsageRow = z.infer<typeof UsageRowSchema>;
type ScanCacheEntry = z.infer<typeof ScanCacheEntrySchema>;

interface ScanCache {
  /** Rows from an unchanged file, or null when the file has to be read. */
  get(path: string, stat: FileStat): UsageRow[] | null;
  put(path: string, stat: FileStat, rows: UsageRow[]): void;
  flush(): void;
}

interface ScanContext {
  adapters: HistoryAdapters;
  from: number;
  scanErrors: UsageHistoryScanError[];
  cache: ScanCache;
}

export function createNodeHistoryAdapters(): HistoryAdapters {
  return {
    env: process.env,
    homeDir: homedir(),
    listFiles: listFilesRecursive,
    statFile: statFileOrNull,
    readTextFile: readTextFileOrNull,
    readScanCacheFile: readTextFileOrNull,
    writeScanCacheFile: writeScanCacheOrIgnore,
    pricing: createNodePricingAdapters(),
    now() {
      return new Date();
    },
  };
}

export async function readUsageHistorySnapshot(
  query: UsageHistoryQuery,
  adapters: HistoryAdapters,
): Promise<UsageHistorySnapshot> {
  const window = RANGE_WINDOWS[query.range];
  const to = adapters.now().getTime();
  const from = to - window.windowMs;
  const cache = createScanCache(adapters);
  const context: ScanContext = { adapters, from, scanErrors: [], cache };
  const rows = [...scanClaude(context), ...scanCodex(context), ...scanOmp(context)];
  cache.flush();
  return buildSnapshot({
    query,
    rows,
    from,
    to,
    bucketMs: window.bucketMs,
    rates: await loadPricingTable(adapters.pricing),
    scanErrors: dedupeScanErrors(context.scanErrors),
  });
}

function scanClaude(context: ScanContext): UsageRow[] {
  const entries = new Map<string, UsageRow>();
  const rows: UsageRow[] = [];
  for (const path of claudeTranscripts(context)) {
    for (const row of scanFile(path, context, collectClaudeRows)) {
      mergeClaudeRow(row, entries, rows);
    }
  }
  for (const row of entries.values()) rows.push(row);
  return rows;
}

function scanCodex(context: ScanContext): UsageRow[] {
  return scanFirstWins(codexTranscripts(context), context, collectCodexRows);
}

function scanOmp(context: ScanContext): UsageRow[] {
  return scanFirstWins(ompTranscripts(context), context, collectOmpRows);
}

/** Codex and omp both re-emit an identical line, and the first one wins. */
function scanFirstWins(
  paths: readonly string[],
  context: ScanContext,
  parse: (text: string) => UsageRow[],
): UsageRow[] {
  const rows: UsageRow[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    for (const row of scanFile(path, context, parse)) {
      if (acceptFirstRow(row, seen)) rows.push(row);
    }
  }
  return rows;
}

function acceptFirstRow(row: UsageRow, seen: Set<string>): boolean {
  if (row.dedupKey === null) return true;
  if (seen.has(row.dedupKey)) return false;
  seen.add(row.dedupKey);
  return true;
}

function mergeClaudeRow(row: UsageRow, entries: Map<string, UsageRow>, unkeyed: UsageRow[]): void {
  if (row.dedupKey === null) {
    unkeyed.push(row);
    return;
  }
  const existing = entries.get(row.dedupKey);
  entries.set(row.dedupKey, existing === undefined ? row : preferredClaudeRow(existing, row));
}

function claudeTranscripts(context: ScanContext): string[] {
  const files: string[] = [];
  for (const root of new Set(claudeRoots(context.adapters))) {
    files.push(...listJsonlFiles(join(root, CLAUDE_PROJECTS_DIR), context));
  }
  return [...new Set(files)];
}

function claudeRoots(adapters: HistoryAdapters): string[] {
  const configured = splitPaths(adapters.env.CLAUDE_CONFIG_DIR);
  if (configured.length > 0) {
    return configured.map((entry) =>
      basename(entry) === CLAUDE_PROJECTS_DIR ? dirname(entry) : entry,
    );
  }
  const configHome = nonEmpty(adapters.env.XDG_CONFIG_HOME) ?? join(adapters.homeDir, ".config");
  return [join(configHome, "claude"), join(adapters.homeDir, ".claude")];
}

function codexTranscripts(context: ScanContext): string[] {
  const configured = splitPaths(context.adapters.env.CODEX_HOME);
  const roots = configured.length > 0 ? configured : [join(context.adapters.homeDir, ".codex")];
  const files: string[] = [];
  for (const root of new Set(roots)) {
    files.push(...codexRootFiles(root, context));
  }
  return [...new Set(files)];
}

function codexRootFiles(root: string, context: ScanContext): string[] {
  const scoped = [
    ...listJsonlFiles(join(root, "sessions"), context),
    ...listJsonlFiles(join(root, "archived_sessions"), context),
  ];
  if (scoped.length > 0) return scoped;
  return listJsonlFiles(root, context);
}

function ompTranscripts(context: ScanContext): string[] {
  const files: string[] = [];
  for (const root of new Set(ompSessionRoots(context.adapters))) {
    files.push(...listJsonlFiles(root, context));
  }
  return [...new Set(files)];
}

/**
 * omp honours no `OMP_HOME`. Verified against the shipped binary, it resolves
 * `homedir()/(PI_CONFIG_DIR || ".omp")`, appends `profiles/<profile>` for
 * `OMP_PROFILE`/`PI_PROFILE`, then `agent` — unless `PI_CODING_AGENT_DIR`
 * replaces the agent directory outright, which a profile disables. Session
 * data additionally relocates under `XDG_DATA_HOME/omp` when that tree exists,
 * so both candidates are scanned and the absent one yields nothing.
 */
function ompSessionRoots(adapters: HistoryAdapters): string[] {
  const profile = nonEmpty(adapters.env.OMP_PROFILE) ?? nonEmpty(adapters.env.PI_PROFILE);
  const override = profile === null ? nonEmpty(adapters.env.PI_CODING_AGENT_DIR) : null;
  if (override !== null) return [join(override, OMP_SESSIONS_DIR)];
  const suffix = profile === null ? [] : [OMP_PROFILES_DIR, profile];
  const configName = nonEmpty(adapters.env.PI_CONFIG_DIR) ?? OMP_DEFAULT_CONFIG_DIR;
  const roots = [join(adapters.homeDir, configName, ...suffix, OMP_AGENT_DIR, OMP_SESSIONS_DIR)];
  const dataHome = nonEmpty(adapters.env.XDG_DATA_HOME);
  if (dataHome !== null) {
    roots.push(join(dataHome, OMP_XDG_APP_DIR, ...suffix, OMP_SESSIONS_DIR));
  }
  return roots;
}

function listJsonlFiles(directory: string, context: ScanContext): string[] {
  const scan = context.adapters.listFiles(directory);
  context.scanErrors.push(...scan.errors);
  return scan.files.filter((path) => path.endsWith(JSONL_SUFFIX));
}

function scanFile(
  path: string,
  context: ScanContext,
  parse: (text: string) => UsageRow[],
): UsageRow[] {
  const stat = context.adapters.statFile(path);
  if (stat === null || stat.size === 0 || stat.mtimeMs < context.from) return [];
  const cached = context.cache.get(path, stat);
  if (cached !== null) return cached;
  if (stat.size > MAX_TRANSCRIPT_BYTES) {
    context.scanErrors.push({
      source: path,
      message: `Transcript exceeds the ${MAX_TRANSCRIPT_MIB} MiB scan limit`,
    });
    return [];
  }
  const text = context.adapters.readTextFile(path);
  if (text === null) {
    context.scanErrors.push({ source: path, message: UNREADABLE_MESSAGE });
    return [];
  }
  const rows = parse(text);
  context.cache.put(path, stat, rows);
  return rows;
}

/**
 * A cache is never allowed to break the live path, so a corrupt, truncated or
 * older-shaped file counts as an empty one and the scan reads every transcript.
 */
function createScanCache(adapters: HistoryAdapters): ScanCache {
  const path = scanCachePath(adapters);
  const stored = loadScanCacheEntries(adapters, path);
  const live = new Map<string, ScanCacheEntry>();
  let parsed = false;
  return {
    get(filePath: string, stat: FileStat): UsageRow[] | null {
      const entry = stored.get(filePath);
      if (entry === undefined) return null;
      if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) return null;
      live.set(filePath, entry);
      return entry.rows;
    },
    put(filePath: string, stat: FileStat, rows: UsageRow[]): void {
      live.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
      parsed = true;
    },
    flush(): void {
      const retained = retainScanCacheEntries(adapters, stored, live);
      if (!parsed && retained.size === stored.size) return;
      const payload = { version: SCAN_CACHE_VERSION, files: Object.fromEntries(retained) };
      adapters.writeScanCacheFile(path, JSON.stringify(payload));
    },
  };
}

/**
 * A range shorter than the cached one never stats the older files, so entries
 * this scan did not touch are kept — dropping them would make the next 30-day
 * read parse everything again. An entry whose file has vanished or changed goes.
 */
function retainScanCacheEntries(
  adapters: HistoryAdapters,
  stored: Map<string, ScanCacheEntry>,
  live: Map<string, ScanCacheEntry>,
): Map<string, ScanCacheEntry> {
  const retained = new Map(live);
  for (const [path, entry] of stored) {
    if (retained.has(path)) continue;
    const stat = adapters.statFile(path);
    if (stat === null || stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) continue;
    retained.set(path, entry);
  }
  return capScanCacheEntries(retained);
}

/** The newest files are the ones a later scan will look at, so they survive. */
function capScanCacheEntries(entries: Map<string, ScanCacheEntry>): Map<string, ScanCacheEntry> {
  if (entries.size <= MAX_SCAN_CACHE_FILES) return entries;
  const byRecency = [...entries].sort((left, right) => right[1].mtimeMs - left[1].mtimeMs);
  return new Map(byRecency.slice(0, MAX_SCAN_CACHE_FILES));
}

function loadScanCacheEntries(
  adapters: HistoryAdapters,
  path: string,
): Map<string, ScanCacheEntry> {
  const text = adapters.readScanCacheFile(path);
  if (text === null) return new Map();
  const parsed = ScanCacheFileSchema.safeParse(parseJson(text));
  if (!parsed.success) return new Map();
  return new Map(Object.entries(parsed.data.files));
}

function scanCachePath(adapters: HistoryAdapters): string {
  const paseoHome = nonEmpty(adapters.env.PASEO_HOME) ?? join(adapters.homeDir, ".paseo");
  return join(paseoHome, "usage-limits", SCAN_CACHE_FILE);
}

function collectClaudeRows(text: string): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(CLAUDE_USAGE_MARKER)) continue;
    const parsed = ClaudeLineSchema.safeParse(parseJson(line));
    if (!parsed.success) continue;
    const row = claudeRow(parsed.data);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function claudeRow(record: ClaudeLine): UsageRow | null {
  const model = nonEmpty(record.message.model) ?? UNKNOWN_MODEL;
  const timestampMs = Date.parse(record.timestamp);
  if (model === CLAUDE_SYNTHETIC_MODEL || Number.isNaN(timestampMs)) return null;
  const usage = record.message.usage;
  const creation = claudeCacheCreation(usage);
  return {
    providerId: CLAUDE_PROVIDER_ID,
    model,
    timestampMs,
    dedupKey: claudeDedupKey(record),
    sidechain: record.isSidechain === true,
    breakdown: scannedBreakdown({
      uncachedInputTokens: usage.input_tokens ?? 0,
      cachedInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: creation.total,
      cacheCreationLongTtlTokens: creation.longTtl,
      outputTokens: usage.output_tokens ?? 0,
      /** Anthropic folds thinking into `output_tokens` and reports no split. */
      reasoningTokens: 0,
      reportedCostUsd: record.costUSD ?? null,
    }),
  };
}

function claudeDedupKey(record: ClaudeLine): string | null {
  const messageId = nonEmpty(record.message.id);
  if (messageId !== null) return `message:${messageId}`;
  const requestId = nonEmpty(record.requestId);
  if (requestId !== null) return `request:${requestId}`;
  return null;
}

function preferredClaudeRow(existing: UsageRow, candidate: UsageRow): UsageRow {
  if (candidate.breakdown.tokens > existing.breakdown.tokens) return candidate;
  if (candidate.breakdown.tokens < existing.breakdown.tokens) return existing;
  return existing.sidechain && !candidate.sidechain ? candidate : existing;
}

interface ClaudeCacheCreation {
  total: number;
  longTtl: number;
}

/**
 * The ephemeral breakdown wins over the flat `cache_creation_input_tokens`,
 * because it is the only place the 1-hour share appears and Anthropic bills
 * that share at 1.6x the 5-minute rate.
 */
function claudeCacheCreation(usage: ClaudeUsage): ClaudeCacheCreation {
  const creation = usage.cache_creation;
  if (creation === null || creation === undefined) {
    return { total: usage.cache_creation_input_tokens ?? 0, longTtl: 0 };
  }
  const shortTtl = creation.ephemeral_5m_input_tokens ?? 0;
  const longTtl = creation.ephemeral_1h_input_tokens ?? 0;
  return { total: shortTtl + longTtl, longTtl };
}

function collectCodexRows(text: string): UsageRow[] {
  const rows: UsageRow[] = [];
  let model = UNKNOWN_MODEL;
  for (const line of text.split("\n")) {
    if (!line.includes(CODEX_USAGE_MARKER) && !line.includes(CODEX_CONTEXT_MARKER)) continue;
    const parsed = CodexLineSchema.safeParse(parseJson(line));
    if (!parsed.success) continue;
    const contextModel = nonEmpty(parsed.data.payload.model);
    if (contextModel !== null) {
      model = contextModel;
      continue;
    }
    const row = codexRow(parsed.data, model);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function codexRow(record: CodexLine, model: string): UsageRow | null {
  const usage = record.payload.info?.last_token_usage;
  if (usage === null || usage === undefined) return null;
  const stamp =
    nonEmpty(record.timestamp) ?? nonEmpty(record.created_at) ?? nonEmpty(record.createdAt);
  if (stamp === null) return null;
  const timestampMs = Date.parse(stamp);
  if (Number.isNaN(timestampMs)) return null;
  const dedupKey = [
    stamp,
    model,
    usage.input_tokens ?? 0,
    usage.cached_input_tokens ?? 0,
    usage.cache_write_input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.reasoning_output_tokens ?? 0,
    usage.total_tokens ?? 0,
  ].join("|");
  return {
    providerId: CODEX_PROVIDER_ID,
    model,
    timestampMs,
    dedupKey,
    sidechain: false,
    breakdown: scannedBreakdown({
      uncachedInputTokens: usage.input_tokens ?? 0,
      cachedInputTokens: usage.cached_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_write_input_tokens ?? 0,
      /** Codex reports no cache TTL split, so none is guessed. */
      cacheCreationLongTtlTokens: 0,
      outputTokens: usage.output_tokens ?? 0,
      reasoningTokens: usage.reasoning_output_tokens ?? 0,
      /** Rollout logs carry no cost figure at all. */
      reportedCostUsd: null,
    }),
  };
}

function collectOmpRows(text: string): UsageRow[] {
  const rows: UsageRow[] = [];
  let qualified: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes(OMP_USAGE_MARKER) && !line.includes(OMP_MODEL_CHANGE_MARKER)) continue;
    const parsed = OmpLineSchema.safeParse(parseJson(line));
    if (!parsed.success) continue;
    if (parsed.data.type === OMP_MODEL_CHANGE_TYPE) {
      qualified = nonEmpty(parsed.data.model) ?? qualified;
      continue;
    }
    const row = ompRow(parsed.data, qualified);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * `usage.totalTokens` is exactly the sum of the four counts and `cttl` is a
 * breakdown of `cacheWrite`, so only the four are read; adding any of the rest
 * double counts the turn.
 */
function ompRow(record: OmpLine, qualified: string | null): UsageRow | null {
  const usage = record.message?.usage;
  if (usage === null || usage === undefined) return null;
  const stamp = nonEmpty(record.timestamp);
  if (stamp === null) return null;
  const timestampMs = Date.parse(stamp);
  if (Number.isNaN(timestampMs)) return null;
  const attribution = ompAttribution(qualified, record.message?.model);
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const lineId = nonEmpty(record.id);
  const identity = [
    stamp,
    attribution.model,
    usage.input ?? 0,
    usage.output ?? 0,
    cacheRead,
    cacheWrite,
  ];
  return {
    providerId: attribution.providerId,
    model: attribution.model,
    timestampMs,
    dedupKey: lineId === null ? `line:${identity.join("|")}` : `id:${lineId}`,
    sidechain: false,
    breakdown: scannedBreakdown({
      uncachedInputTokens: usage.input ?? 0,
      cachedInputTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      /** omp passes no cache TTL split through, so none is guessed. */
      cacheCreationLongTtlTokens: 0,
      outputTokens: usage.output ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
      reportedCostUsd: usage.cost?.total ?? null,
    }),
  };
}

interface OmpAttribution {
  providerId: string;
  model: string;
}

function ompAttribution(qualified: string | null, bare: string | null | undefined): OmpAttribution {
  if (qualified === null) {
    return { providerId: OMP_UNKNOWN_PROVIDER_ID, model: nonEmpty(bare) ?? UNKNOWN_MODEL };
  }
  const slash = qualified.indexOf("/");
  if (slash <= 0) return { providerId: OMP_UNKNOWN_PROVIDER_ID, model: qualified };
  return {
    providerId: `${OMP_PROVIDER_PREFIX}${qualified.slice(0, slash)}`,
    model: qualified.slice(slash + 1),
  };
}

interface BreakdownInput {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  cacheCreationLongTtlTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reportedCostUsd: number | null;
}

/**
 * `tokens` sums exactly the four billable categories. `reasoningTokens` and
 * `cacheCreationLongTtlTokens` sit inside output and cache creation and are
 * clamped to them, because Codex reports a reasoning figure that can exceed the
 * output it belongs to.
 */
function scannedBreakdown(input: BreakdownInput): UsageTokenBreakdown {
  return {
    uncachedInputTokens: input.uncachedInputTokens,
    cachedInputTokens: input.cachedInputTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    cacheCreationLongTtlTokens: Math.min(
      input.cacheCreationLongTtlTokens,
      input.cacheCreationTokens,
    ),
    outputTokens: input.outputTokens,
    reasoningTokens: Math.min(input.reasoningTokens, input.outputTokens),
    tokens:
      input.uncachedInputTokens +
      input.cachedInputTokens +
      input.cacheCreationTokens +
      input.outputTokens,
    costUsd: input.reportedCostUsd,
    cacheSavingsUsd: null,
  };
}

interface BreakdownTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  cacheCreationLongTtlTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  tokens: number;
  costUsd: number;
  /**
   * Cleared by the first row that carried no cost. A total that silently omits
   * part of the spend reads as complete money, so the aggregate goes null.
   */
  costKnown: boolean;
  cacheSavingsUsd: number;
  savingsKnown: boolean;
}

/** Carries the row identity a series key alone cannot recover for labelling. */
interface SeriesTotals extends BreakdownTotals {
  providerId: string;
  model: string;
  /** Null on a top-level row; names the provider row a model row expands under. */
  parentKey: string | null;
}

/**
 * Where one row lands at both levels. A model row rides alongside its provider
 * row rather than replacing it, so expanding a provider needs no second read.
 * `childKey` is null when grouping by model, because then the models ARE the top
 * level and a second copy of them would double every column.
 */
interface RowKeys {
  parentKey: string;
  childKey: string | null;
}

interface SnapshotInput {
  query: UsageHistoryQuery;
  rows: readonly UsageRow[];
  from: number;
  to: number;
  bucketMs: number;
  rates: PricingTable;
  scanErrors: UsageHistoryScanError[];
}

/** A row and the money that came out of it, priced once and read twice. */
interface PricedRow {
  row: UsageRow;
  breakdown: UsageTokenBreakdown;
}

interface RowPricer {
  price(row: UsageRow): PricedRow;
  report(): UsageRatesReport;
}

/**
 * A rate lookup normalises the model name and walks every known key, so the
 * answer is kept per model rather than recomputed for each of thousands of
 * rows. The models it was asked about are exactly the ones the snapshot shows,
 * which is what the report has to name.
 */
function createRowPricer(table: PricingTable): RowPricer {
  const rates = new Map<string, ModelRate | null>();
  function rateFor(model: string): ModelRate | null {
    const known = rates.get(model);
    if (known !== undefined) return known;
    const resolved = table.rateFor(model);
    rates.set(model, resolved);
    return resolved;
  }
  return {
    price(row: UsageRow): PricedRow {
      const priced = priceBreakdown(row.breakdown, rateFor(row.model));
      return {
        row,
        breakdown: {
          ...row.breakdown,
          costUsd: row.breakdown.costUsd ?? priced.costUsd,
          cacheSavingsUsd: priced.cacheSavingsUsd,
        },
      };
    },
    report(): UsageRatesReport {
      const pricedModels: string[] = [];
      const unpricedModels: string[] = [];
      for (const [model, rate] of rates) {
        if (rate === null) unpricedModels.push(model);
        else pricedModels.push(model);
      }
      return {
        status: table.status,
        fetchedAt: table.fetchedAt,
        pricedModels: pricedModels.sort(),
        unpricedModels: unpricedModels.sort(),
      };
    },
  };
}

function buildSnapshot(input: SnapshotInput): UsageHistorySnapshot {
  const inWindow = input.rows.filter(
    (row) => row.timestampMs >= input.from && row.timestampMs <= input.to,
  );
  const alignedFrom = Math.floor(input.from / input.bucketMs) * input.bucketMs;
  const alignedLast = Math.floor(input.to / input.bucketMs) * input.bucketMs;
  const bucketCount = (alignedLast - alignedFrom) / input.bucketMs + 1;

  const byModel = input.query.groupBy === "model";
  const pricer = createRowPricer(input.rates);
  const totals = new Map<string, SeriesTotals>();
  const bucketTotals = new Map<number, Map<string, SeriesTotals>>();
  for (const row of inWindow) {
    const keys = rowKeys(row, byModel);
    const priced = pricer.price(row);
    accumulateRow(totals, keys, priced);
    const index = Math.floor((row.timestampMs - alignedFrom) / input.bucketMs);
    const perSeries = bucketTotals.get(index) ?? new Map<string, SeriesTotals>();
    bucketTotals.set(index, perSeries);
    accumulateRow(perSeries, keys, priced);
  }

  const series = buildSeries(totals, byModel);
  const snapshotTotals = createTotals();
  for (const entry of series) addBreakdown(snapshotTotals, entry);
  return {
    range: input.query.range,
    from: new Date(input.from).toISOString(),
    to: new Date(input.to).toISOString(),
    bucketMs: input.bucketMs,
    buckets: buildBuckets(bucketTotals, series, alignedFrom, input.bucketMs, bucketCount),
    series,
    totals: toBreakdown(snapshotTotals),
    rates: pricer.report(),
    scanErrors: input.scanErrors,
  };
}

function rowKeys(row: UsageRow, byModel: boolean): RowKeys {
  const modelKey = `${row.providerId}:${row.model}`;
  if (byModel) return { parentKey: modelKey, childKey: null };
  return { parentKey: row.providerId, childKey: modelKey };
}

function providerLabel(providerId: string): string {
  const known = PROVIDER_LABELS[providerId];
  if (known !== undefined) return known;
  if (!providerId.startsWith(OMP_PROVIDER_PREFIX)) return providerId;
  const vendor = providerId.slice(OMP_PROVIDER_PREFIX.length);
  return `${OMP_VENDOR_LABELS[vendor] ?? vendorSlugLabel(vendor)}${OMP_LABEL_SUFFIX}`;
}

function vendorSlugLabel(vendor: string): string {
  return vendor
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function createTotals(): BreakdownTotals {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreationLongTtlTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    tokens: 0,
    costUsd: 0,
    costKnown: true,
    cacheSavingsUsd: 0,
    savingsKnown: true,
  };
}

function addBreakdown(totals: BreakdownTotals, value: UsageTokenBreakdown): void {
  totals.uncachedInputTokens += value.uncachedInputTokens;
  totals.cachedInputTokens += value.cachedInputTokens;
  totals.cacheCreationTokens += value.cacheCreationTokens;
  totals.cacheCreationLongTtlTokens += value.cacheCreationLongTtlTokens;
  totals.outputTokens += value.outputTokens;
  totals.reasoningTokens += value.reasoningTokens;
  totals.tokens += value.tokens;
  if (value.costUsd === null) totals.costKnown = false;
  else totals.costUsd += value.costUsd;
  if (value.cacheSavingsUsd === null) totals.savingsKnown = false;
  else totals.cacheSavingsUsd += value.cacheSavingsUsd;
}

function toBreakdown(totals: BreakdownTotals): UsageTokenBreakdown {
  return {
    uncachedInputTokens: totals.uncachedInputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    cacheCreationLongTtlTokens: totals.cacheCreationLongTtlTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    tokens: totals.tokens,
    costUsd: totals.costKnown ? totals.costUsd : null,
    cacheSavingsUsd: totals.savingsKnown ? totals.cacheSavingsUsd : null,
  };
}

function accumulateRow(totals: Map<string, SeriesTotals>, keys: RowKeys, priced: PricedRow): void {
  accumulateAt(totals, keys.parentKey, null, priced);
  if (keys.childKey !== null) accumulateAt(totals, keys.childKey, keys.parentKey, priced);
}

function accumulateAt(
  totals: Map<string, SeriesTotals>,
  key: string,
  parentKey: string | null,
  priced: PricedRow,
): void {
  const existing = totals.get(key);
  if (existing !== undefined) {
    addBreakdown(existing, priced.breakdown);
    return;
  }
  const created: SeriesTotals = {
    providerId: priced.row.providerId,
    model: priced.row.model,
    parentKey,
    ...createTotals(),
  };
  addBreakdown(created, priced.breakdown);
  totals.set(key, created);
}

function buildSeries(totals: Map<string, SeriesTotals>, byModel: boolean): UsageHistorySeries[] {
  const shared = byModel ? sharedModelNames(totals) : new Set<string>();
  const children = groupChildren(totals);
  const series: UsageHistorySeries[] = [];
  for (const [key, value] of totals) {
    if (value.parentKey !== null) continue;
    series.push({
      key,
      label: seriesLabel(key, value, byModel, shared),
      ...toBreakdown(value),
      children: children.get(key) ?? [],
    });
  }
  return series.sort(compareSeries);
}

/** A provider's models, ranked the way the top level is so the two read alike. */
function groupChildren(totals: Map<string, SeriesTotals>): Map<string, UsageHistoryModelSeries[]> {
  const children = new Map<string, UsageHistoryModelSeries[]>();
  for (const [key, value] of totals) {
    const parentKey = value.parentKey;
    if (parentKey === null) continue;
    const rows = children.get(parentKey) ?? [];
    children.set(parentKey, rows);
    rows.push({ key, label: value.model, ...toBreakdown(value) });
  }
  for (const rows of children.values()) rows.sort(compareSeries);
  return children;
}

/**
 * A model name reached through two providers would render as two identical
 * legend entries, so only those names carry the provider label. A child row
 * never needs one: it is already drawn inside the provider it belongs to.
 */
function seriesLabel(
  key: string,
  totals: SeriesTotals,
  byModel: boolean,
  shared: ReadonlySet<string>,
): string {
  if (!byModel) return providerLabel(key);
  if (!shared.has(totals.model)) return totals.model;
  return `${totals.model} · ${providerLabel(totals.providerId)}`;
}

function sharedModelNames(totals: Map<string, SeriesTotals>): Set<string> {
  const providersByModel = new Map<string, Set<string>>();
  for (const value of totals.values()) {
    const providers = providersByModel.get(value.model) ?? new Set<string>();
    providersByModel.set(value.model, providers);
    providers.add(value.providerId);
  }
  const shared = new Set<string>();
  for (const [model, providers] of providersByModel) {
    if (providers.size > 1) shared.add(model);
  }
  return shared;
}

interface RankedRow {
  key: string;
  tokens: number;
}

function compareSeries(left: RankedRow, right: RankedRow): number {
  if (right.tokens !== left.tokens) return right.tokens - left.tokens;
  return left.key.localeCompare(right.key);
}

function buildBuckets(
  bucketTotals: Map<number, Map<string, SeriesTotals>>,
  series: readonly UsageHistorySeries[],
  alignedFrom: number,
  bucketMs: number,
  bucketCount: number,
): UsageHistoryBucket[] {
  const buckets: UsageHistoryBucket[] = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const perSeries = bucketTotals.get(index);
    const values = perSeries === undefined ? [] : bucketValues(perSeries, series);
    const totals = createTotals();
    /** A model row repeats its provider's tokens, so only the top level sums. */
    for (const value of values) {
      if (value.parentKey === null) addBreakdown(totals, value);
    }
    buckets.push({
      start: new Date(alignedFrom + index * bucketMs).toISOString(),
      ...toBreakdown(totals),
      values,
    });
  }
  return buckets;
}

/**
 * Both levels ride in one array: a provider row, then the model rows that
 * expand under it. A row the bucket holds is emitted even when it summed to
 * nothing, because dropping it would leave a provider's cost null while every
 * child it kept read as priced.
 */
function bucketValues(
  perSeries: Map<string, SeriesTotals>,
  series: readonly UsageHistorySeries[],
): UsageHistoryBucketValue[] {
  const values: UsageHistoryBucketValue[] = [];
  for (const entry of series) {
    pushBucketValue(values, perSeries, entry.key, null);
    for (const child of entry.children) pushBucketValue(values, perSeries, child.key, entry.key);
  }
  return values;
}

function pushBucketValue(
  values: UsageHistoryBucketValue[],
  perSeries: Map<string, SeriesTotals>,
  seriesKey: string,
  parentKey: string | null,
): void {
  const totals = perSeries.get(seriesKey);
  if (totals === undefined) return;
  values.push({ seriesKey, parentKey, ...toBreakdown(totals) });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function splitPaths(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function listFilesRecursive(directory: string): UsageHistoryFileScan {
  const scan: UsageHistoryFileScan = { files: [], errors: [] };
  collectFiles(directory, scan);
  return scan;
}

function collectFiles(directory: string, scan: UsageHistoryFileScan): void {
  for (const entry of readDirectory(directory, scan)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(path, scan);
      continue;
    }
    if (entry.isFile()) scan.files.push(path);
  }
}

function readDirectory(directory: string, scan: UsageHistoryFileScan) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    scan.errors.push({
      source: directory,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function dedupeScanErrors(errors: readonly UsageHistoryScanError[]): UsageHistoryScanError[] {
  const seen = new Set<string>();
  const unique: UsageHistoryScanError[] = [];
  for (const error of errors) {
    const key = `${error.source}\u0000${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(error);
  }
  return unique;
}

function statFileOrNull(path: string): FileStat | null {
  try {
    const stats = statSync(path);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

function readTextFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * A test run must never write the scan cache into the developer's own
 * `~/.paseo`: entries there are replayed as their real history on the next
 * scan. A test that wants the on-disk cache points `PASEO_HOME` or `homeDir` at
 * a temp directory, and one that does not injects its own adapters.
 */
function refuseWriteOutsideTempDuringTests(path: string): void {
  if (process.env.VITEST === undefined) return;
  if (path.startsWith(tmpdir())) return;
  throw new Error(
    `refusing to write the usage scan cache to ${path} during a test run: point PASEO_HOME at a temp directory or inject HistoryAdapters`,
  );
}

function writeScanCacheOrIgnore(path: string, content: string): void {
  refuseWriteOutsideTempDuringTests(path);
  const directory = dirname(path);
  try {
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.${SCAN_CACHE_FILE}.${process.pid}.tmp`);
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } catch {
    // A cache that cannot be written must not fail the scan it was speeding up.
  }
}

function isMissingPath(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = error.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
