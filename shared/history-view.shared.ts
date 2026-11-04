import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The user's last Usage history view: presentation preferences only, never
 * usage data. Range, metric, grouping, and which provider rows are expanded.
 * Dropdown-open and hover state stay ephemeral on purpose.
 *
 * Cost is a client-only metric (see `UsageChartMetric`), so the schema names
 * it here rather than reusing the token-only `UsageHistoryMetricSchema`.
 */
export const HistoryViewRangeSchema = z.enum(["24h", "7d", "30d"]);

export const HistoryViewMetricSchema = z.enum(["work", "cached", "total", "cost"]);

export const HistoryViewGroupBySchema = z.enum(["provider", "model"]);

export const HistoryViewPreferencesSchema = z.object({
  // Each field catches its own default, so one obsolete value degrades that
  // field instead of failing the whole document for schema-level readers.
  range: HistoryViewRangeSchema.default("24h").catch("24h"),
  metric: HistoryViewMetricSchema.default("work").catch("work"),
  groupBy: HistoryViewGroupBySchema.default("provider").catch("provider"),
  /**
   * Stable provider keys (`claude-code`, `codex`, …) whose model rows are
   * shown. Keys for providers with no rows in the current window are kept:
   * they cost nothing and reapply when the provider returns.
   */
  expandedKeys: z.array(z.string()).default([]).catch([]),
});

export type HistoryViewPreferences = z.infer<typeof HistoryViewPreferencesSchema>;

export const HISTORY_VIEW_DEFAULTS: HistoryViewPreferences = {
  range: "24h",
  metric: "work",
  groupBy: "provider",
  expandedKeys: [],
};

export const historyViewSettings = defineSettings({
  id: "history-view",
  scope: "host",
  version: 1,
  schema: HistoryViewPreferencesSchema,
});
