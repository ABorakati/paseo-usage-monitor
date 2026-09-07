import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * Cumulative usage over time.
 *
 * Paseo keeps no usage history: `lastUsage` is the latest turn only, it never
 * reaches disk, and the plugin SDK does not expose it. The agent CLIs do keep
 * one — Claude Code writes per-message token counts to its project transcripts
 * and Codex writes per-turn counts to its rollout logs — so history is read
 * back out of those files rather than sampled forward from first run.
 *
 * Tokens are the only metric. Claude Code's `costUSD` is null in current
 * transcripts and Codex logs carry no cost at all, so a dollar figure would
 * have to come from a bundled price table that goes stale silently.
 */

export const UsageHistoryRangeSchema = z.enum(["24h", "7d", "30d"]);

export const UsageHistoryGroupBySchema = z.enum(["provider", "model"]);

export const UsageHistoryQuerySchema = z.object({
  range: UsageHistoryRangeSchema,
  /**
   * Whether a series is one provider or one model. Grouping by model spans
   * every provider at once, which is the only way to compare two models a user
   * reaches through different tools.
   */
  groupBy: UsageHistoryGroupBySchema,
});

/**
 * Five token categories, not three, because they price differently and because
 * merging them hides what a turn actually cost. A cache READ is cheap, a cache
 * WRITE is dearer than fresh input, and reasoning tokens are a SUBSET of output
 * that must never be added on top — doing so inflates every total. On real logs
 * cache reads are two orders of magnitude larger than the work a turn produced,
 * which is why the surface picks a metric rather than plotting one aggregate.
 *
 * `tokens` is the only sum: uncachedInput + cachedInput + cacheCreation + output.
 */
export const UsageTokenBreakdownSchema = z.object({
  uncachedInputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheCreationTokens: z.number(),
  /**
   * The share of `cacheCreationTokens` written with a long TTL, which vendors
   * bill dearer than the default: Anthropic charges 1.6x for a 1-hour cache.
   * Measured on this machine's transcripts, every Claude cache write is a 1-hour
   * one, so pricing the whole category at the base rate understated Claude spend
   * by 37.5%. A subset field, like `reasoningTokens` - never added on top.
   */
  cacheCreationLongTtlTokens: z.number(),
  outputTokens: z.number(),
  /** Reported where a provider separates it; already inside `outputTokens`. */
  reasoningTokens: z.number(),
  tokens: z.number(),
  /**
   * Null when neither the provider reported a cost nor a rate was known for the
   * model. A null here is why the surface must never show a total as if it were
   * complete money.
   */
  costUsd: z.number().nullable(),
  /** What the cache reads saved against paying fresh input rates. */
  cacheSavingsUsd: z.number().nullable(),
});

export const UsageHistoryBucketValueSchema = UsageTokenBreakdownSchema.extend({
  seriesKey: z.string(),
  /**
   * Which provider row this value belongs under, or null when it IS a top-level
   * row. Both levels ride in the same bucket so the chart can swap a provider's
   * band for its models without refetching.
   */
  parentKey: z.string().nullable(),
});

export const UsageHistoryBucketSchema = UsageTokenBreakdownSchema.extend({
  start: z.string(),
  values: z.array(UsageHistoryBucketValueSchema),
});

/**
 * A model row inside one provider. Two levels is the whole hierarchy - a model
 * has no children - so the shape is spelled out flat rather than made recursive.
 */
export const UsageHistoryModelSeriesSchema = UsageTokenBreakdownSchema.extend({
  key: z.string(),
  label: z.string(),
});

export const UsageHistorySeriesSchema = UsageTokenBreakdownSchema.extend({
  key: z.string(),
  label: z.string(),
  /**
   * The models this provider ran, so expanding a provider costs no second
   * request and shows its breakdown in place. Empty when grouping by model,
   * because then the models ARE the top level.
   */
  children: z.array(UsageHistoryModelSeriesSchema),
});

/**
 * Where the money figures came from. `providerReported` costs are the vendor's
 * own numbers; `modelPriced` ones were computed from a rate table, so the UI has
 * to say how old that table is instead of implying the total is authoritative.
 */
export const UsageRatesStatusSchema = z.enum(["fresh", "cached", "unavailable"]);

export const UsageRatesReportSchema = z.object({
  status: UsageRatesStatusSchema,
  fetchedAt: z.string().nullable(),
  /** Models in this window that a rate was found for, and that had none. */
  pricedModels: z.array(z.string()),
  unpricedModels: z.array(z.string()),
});

export const UsageHistoryScanErrorSchema = z.object({
  source: z.string(),
  message: z.string(),
});

export const UsageHistoryMetricSchema = z.enum(["work", "cached", "total"]);

export const UsageHistorySnapshotSchema = z.object({
  range: UsageHistoryRangeSchema,
  from: z.string(),
  to: z.string(),
  bucketMs: z.number(),
  buckets: z.array(UsageHistoryBucketSchema),
  series: z.array(UsageHistorySeriesSchema),
  totals: UsageTokenBreakdownSchema,
  rates: UsageRatesReportSchema,
  scanErrors: z.array(UsageHistoryScanErrorSchema),
});

export const readUsageHistory = defineRpc({
  name: "usage.history.read",
  input: UsageHistoryQuerySchema,
  output: UsageHistorySnapshotSchema,
});

export type UsageHistoryRange = z.infer<typeof UsageHistoryRangeSchema>;
export type UsageHistoryQuery = z.infer<typeof UsageHistoryQuerySchema>;
export type UsageHistoryGroupBy = z.infer<typeof UsageHistoryGroupBySchema>;
export type UsageTokenBreakdown = z.infer<typeof UsageTokenBreakdownSchema>;
export type UsageRatesStatus = z.infer<typeof UsageRatesStatusSchema>;
export type UsageRatesReport = z.infer<typeof UsageRatesReportSchema>;
export type UsageHistoryModelSeries = z.infer<typeof UsageHistoryModelSeriesSchema>;
export type UsageHistoryBucketValue = z.infer<typeof UsageHistoryBucketValueSchema>;
export type UsageHistoryBucket = z.infer<typeof UsageHistoryBucketSchema>;
export type UsageHistorySeries = z.infer<typeof UsageHistorySeriesSchema>;
export type UsageHistoryScanError = z.infer<typeof UsageHistoryScanErrorSchema>;
export type UsageHistorySnapshot = z.infer<typeof UsageHistorySnapshotSchema>;
export type UsageHistoryMetric = z.infer<typeof UsageHistoryMetricSchema>;
