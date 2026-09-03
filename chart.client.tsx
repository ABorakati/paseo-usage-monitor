import { Icon, type PluginTheme } from "@getpaseo/plugin";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type TextStyle,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import type {
  UsageHistoryBucket,
  UsageHistoryMetric,
  UsageHistoryModelSeries,
  UsageHistorySeries,
  UsageTokenBreakdown,
} from "./history.shared";
import { childColor, seriesColor } from "./palette.shared";

/**
 * A layered filled-line chart with no drawing library. `react-native-svg` is
 * not available to plugins, so each series is drawn from dense sliver Views:
 * every sliver carries its share of the plot height as a percentage, the
 * translucent fill is its background, and a solid top border is the line
 * itself. Series layer from the same zero baseline, heaviest painted first.
 *
 * Hover follows the app's canonical pattern: a plain View with non-bubbling
 * pointer handlers. On native they never fire, and the chart renders without a
 * readout.
 */

const PLOT_HEIGHT_COMPACT = 120;
const PLOT_HEIGHT_REGULAR = 168;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Sampling density of the drawn curve, in sliver Views per plot. Each sample
 * is one View, so this is the knob between line smoothness and view count: at
 * these densities the worst case (MAX_PLOTTED_SERIES + "Other") stays under
 * a thousand simple Views.
 */
const CURVE_SAMPLES_REGULAR = 96;
const CURVE_SAMPLES_COMPACT = 72;
/** Width of the line drawn along the top edge of every fill. */
const LINE_WIDTH = 2;
/** Space above the top gridline, so the line stroke never clips. */
const PLOT_TOP_PAD = 8;
/** Opacity of the fill under each line, matching the layered-overlap look. */
const FILL_ALPHA = 0.12;
const GRID_TICK_COUNT = 4;
const MONTH_LABELS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Each limit sits half a unit below the power it names: 999,999 rounds to 1000
 * of the smaller unit, and `1M` reads better than `1000k`.
 */
const COMPACT_STEPS: readonly { limit: number; divisor: number; suffix: string }[] = [
  { limit: 999_500_000, divisor: 1_000_000_000, suffix: "B" },
  { limit: 999_500, divisor: 1_000_000, suffix: "M" },
  { limit: 1_000, divisor: 1_000, suffix: "k" },
];

/**
 * Cost is a client-only metric. The wire contract names the token projections
 * the server can compute for any log; money is a fourth *view* of the same
 * breakdown, not a fifth counter, so it never travels over the RPC.
 */
export type UsageChartMetric = UsageHistoryMetric | "cost";

/** Shown wherever a series carries real usage that no rate could price. */
const UNPRICED_LABEL = "unpriced";

/**
 * `work` is what the turn actually produced. Cache reads are counted again on
 * every turn, so on real logs `cached` is two orders of magnitude larger and
 * `total` reads as work performed when it is almost entirely re-reads.
 *
 * Null means "no rate known", which only `cost` can be, and which callers must
 * carry rather than flatten: an unpriced series plotted as zero reads as free.
 * `reasoningTokens` and `cacheCreationLongTtlTokens` are subsets of the output
 * and cache-write categories, so no metric may add them on top.
 */
export function metricValue(
  breakdown: UsageTokenBreakdown,
  metric: UsageChartMetric,
): number | null {
  if (metric === "cost") {
    return breakdown.costUsd;
  }
  if (metric === "work") {
    return breakdown.uncachedInputTokens + breakdown.outputTokens;
  }
  if (metric === "cached") {
    return breakdown.cachedInputTokens + breakdown.cacheCreationTokens;
  }
  return breakdown.tokens;
}

/**
 * What the priced series actually add up to. A snapshot total goes null as soon
 * as one model has no rate, and refusing to show anything then would hide the
 * spend that *is* known — so the surface falls back to this and marks it partial.
 */
export function pricedSubtotal(series: readonly UsageTokenBreakdown[]): number {
  let total = 0;
  for (const entry of series) {
    total += entry.costUsd ?? 0;
  }
  return total;
}

/** `1.2M`, `184k`, `18.4k`, `940`: one decimal below 100 of a unit, none above. */
export function formatTokensCompact(value: number): string {
  const magnitude = Math.round(value);
  for (const step of COMPACT_STEPS) {
    if (magnitude >= step.limit) {
      return scaleCompact(magnitude, step.divisor, step.suffix);
    }
  }
  return magnitude.toString();
}

function scaleCompact(value: number, divisor: number, suffix: string): string {
  const scaled = value / divisor;
  if (scaled >= 100) {
    return `${Math.round(scaled)}${suffix}`;
  }
  return `${Math.round(scaled * 10) / 10}${suffix}`;
}

/**
 * `$1.2k`, `$184.20`, `$0.42`, `<$0.01`: cents while a reader could still act on
 * them, compact once the figure is large enough that cents are noise. A nonzero
 * spend never rounds to `$0.00`, which would read as free, and a true zero
 * drops the cents it does not have.
 */
function formatCostCompact(value: number): string {
  for (const step of COMPACT_STEPS) {
    if (value >= step.limit) {
      return `$${scaleCompact(value, step.divisor, step.suffix)}`;
    }
  }
  if (value === 0) {
    return "$0";
  }
  if (value < 0.01) {
    return "<$0.01";
  }
  return `$${value.toFixed(2)}`;
}

/** One formatter for the axis, the legend and the headline, per metric. */
export function formatMetricValue(value: number | null, metric: UsageChartMetric): string {
  if (metric !== "cost") {
    return formatTokensCompact(value ?? 0);
  }
  return value === null ? UNPRICED_LABEL : formatCostCompact(value);
}

/**
 * Two formats, one per axis, chosen from the window length.
 *
 * A window longer than a day gets dates: clock times alone repeat, so a 6-hour
 * bucket inside a seven-day window would label the first and last tick
 * identically. A window of a day or less gets bare clock times — prefixing the
 * day number puts a date beside a time on one line, where it reads as one
 * confusing figure. The full day travels in the hover tooltip instead.
 */
type TickFormat = "date" | "time";

function tickFormat(windowMs: number): TickFormat {
  return windowMs > DAY_MS ? "date" : "time";
}

/**
 * The server aligns bucket starts to a UTC grid, so labels are read with the
 * UTC getters: local getters shift a midnight bucket into the previous day for
 * every zone west of Greenwich.
 */
function formatBucketTick(start: string, format: TickFormat): string {
  const date = new Date(start);
  if (format === "date") {
    return `${date.getUTCDate()} ${MONTH_LABELS[date.getUTCMonth()] ?? ""}`;
  }
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

interface AxisTicks {
  left: string;
  center: string;
  right: string;
}

function tickAt(buckets: readonly UsageHistoryBucket[], index: number, format: TickFormat): string {
  const bucket = buckets[index];
  if (bucket === undefined) {
    return "";
  }
  return formatBucketTick(bucket.start, format);
}

/**
 * Only three ticks: a label per column overlaps itself in a sidebar as narrow
 * as the compact layout allows.
 */
function axisTicks(buckets: readonly UsageHistoryBucket[], windowMs: number): AxisTicks {
  const format = tickFormat(windowMs);
  const last = buckets.length - 1;
  const ticks: AxisTicks = { left: tickAt(buckets, 0, format), center: "", right: "" };
  if (last <= 0) {
    return ticks;
  }
  ticks.right = tickAt(buckets, last, format);
  const middle = Math.round(last / 2);
  if (middle > 0 && middle < last) {
    ticks.center = tickAt(buckets, middle, format);
  }
  return ticks;
}

/**
 * Builds a scale whose maximum is a readable 1/2/5 x 10^n step at or above the
 * peak.
 *
 * Rounding the maximum *up* is the point: stopping at the last step below the
 * peak leaves the tallest point drawn past the top of the plot, where it is
 * clipped.
 */
export function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

/**
 * `#rgb` or `#rrggbb` at an alpha, for the translucent fill under each line.
 * Anything unparseable returns the colour unchanged: a solid fill is wrong
 * only where series overlap, and never wrong enough to hide a series.
 */
function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "");
  const digits = hex.length === 3 ? hex.replace(/./g, "$&$&") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) {
    return color;
  }
  const red = Number.parseInt(digits.slice(0, 2), 16);
  const green = Number.parseInt(digits.slice(2, 4), 16);
  const blue = Number.parseInt(digits.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * Fritsch-Carlson tangents for a unit-spaced series: the piecewise cubic
 * through these points cannot overshoot the data, so a spiky bucket never
 * paints a fill that rises above its own peak.
 */
function monotoneTangents(values: readonly number[]): readonly number[] {
  const count = values.length;
  if (count < 2) {
    return [0];
  }
  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    slopes.push((values[index + 1] ?? 0) - (values[index] ?? 0));
  }
  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }
  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }
  return tangents;
}

/**
 * Evaluates the monotone cubic through `values` at `samples` evenly spaced
 * sliver centres across the plot. The chart draws these, never the raw
 * points, so the line and its fill are one curve by construction.
 */
function sampleTrend(values: readonly number[], samples: number): number[] {
  const count = values.length;
  if (count === 0) {
    return [];
  }
  if (count === 1) {
    return Array.from({ length: samples }, () => values[0] ?? 0);
  }
  const tangents = monotoneTangents(values);
  const curve: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const x = ((sample + 0.5) / samples) * (count - 1);
    const index = Math.min(count - 2, Math.floor(x));
    const t = x - index;
    const y0 = values[index] ?? 0;
    const y1 = values[index + 1] ?? 0;
    const m0 = tangents[index] ?? 0;
    const m1 = tangents[index + 1] ?? 0;
    const t2 = t * t;
    const t3 = t2 * t;
    curve.push(
      (2 * t3 - 3 * t2 + 1) * y0 +
        (t3 - 2 * t2 + t) * m0 +
        (-2 * t3 + 3 * t2) * y1 +
        (t3 - t2) * m1,
    );
  }
  return curve;
}

function bandValue(bucket: PlottedBucket, bandKey: string, metric: UsageChartMetric): number {
  const breakdown = bucket.values.get(bandKey);
  if (breakdown === undefined) {
    return 0;
  }
  return metricValue(breakdown, metric) ?? 0;
}

/**
 * Layered series each measure from zero, so the axis tops out at the largest
 * single series-bucket value rather than the sum of the column: scaling
 * against a combined peak would leave the plot permanently half empty.
 */
function maxPlottedValue(
  buckets: readonly PlottedBucket[],
  bands: readonly PlottedBand[],
  metric: UsageChartMetric,
): number {
  let max = 0;
  for (const bucket of buckets) {
    for (const band of bands) {
      max = Math.max(max, bandValue(bucket, band.key, metric));
    }
  }
  return max;
}

/**
 * The tooltip is the one place the full context lives. The axis names times
 * alone in the 24h view, so the hovered bucket's day rides along here; hourly
 * buckets inside longer windows get the same treatment.
 */
function formatTooltipBucket(start: string): string {
  const date = new Date(start);
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${formatBucketTick(start, "date")} ${hours}:${minutes}`;
}

/**
 * Grouping by model puts every model of every provider on one chart, so a
 * three-vendor host plots ten bands where the surface used to plot two. Past
 * eight bands each one also reserves a pixel of the plot box, which starves the
 * small ones in the 120px compact layout, and eight is about as far as a
 * categorical palette can separate neighbours by hue alone.
 *
 * The tail is therefore summed into one trailing "Other" band rather than
 * dropped, so the legend still adds up to the snapshot total for the metric.
 *
 * The cap applies PER LEVEL, not to the chart as a whole. Which providers get a
 * row is decided from the collapsed rows alone, so opening a disclosure can
 * never evict a provider the user did not touch; an expanded provider then caps
 * its OWN models the same way, folding its tail into an indented "Other" that
 * reconciles to that provider rather than to the window.
 */
export const MAX_PLOTTED_SERIES = 8;

/** Namespaced, so it cannot collide with a provider id or a model id. */
const OTHER_SERIES_KEY = "usage.other";

function emptyBreakdown(): UsageTokenBreakdown {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreationLongTtlTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    tokens: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
  };
}

/**
 * A missing figure makes the aggregate unknown, not smaller: folding one
 * unpriced series into "Other" leaves "Other" unpriced rather than reporting the
 * rest of the tail as though it were the whole of it.
 */
function addMoney(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  return left + right;
}

function accumulate(target: UsageTokenBreakdown, source: UsageTokenBreakdown): void {
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheCreationLongTtlTokens += source.cacheCreationLongTtlTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.tokens += source.tokens;
  target.costUsd = addMoney(target.costUsd, source.costUsd);
  target.cacheSavingsUsd = addMoney(target.cacheSavingsUsd, source.cacheSavingsUsd);
}

/** A provider row and a model row rank and fold identically, so both feed this. */
interface LevelEntry extends UsageTokenBreakdown {
  key: string;
  label: string;
}

interface CappedLevel<Entry extends LevelEntry> {
  kept: Entry[];
  /** Totals of the tail past the cap, or null when nothing was folded. */
  fold: UsageTokenBreakdown | null;
  foldedKeys: string[];
}

/**
 * A series with none of the plotted metric is left out entirely. Grouping by
 * model surfaces models that a provider recorded with no tokens at all, and a
 * band of zero height would still take a legend row, a swatch and a colour away
 * from the bands that do carry usage. Nothing is lost: the rows dropped here add
 * zero to the metric being plotted.
 *
 * Unknown is not zero, so that rule stops at an unpriced series: it spent real
 * money that no rate could name, it keeps its row, and it ranks last because
 * there is no figure to rank it by.
 */
function isPlotted(entry: UsageTokenBreakdown, metric: UsageChartMetric): boolean {
  if (metric === "cost" && entry.costUsd === null) {
    return entry.tokens > 0;
  }
  return (metricValue(entry, metric) ?? 0) > 0;
}

/**
 * Ranks one level by the plotted metric and caps it. "Other" stays last whatever
 * it sums to: it is the tail of the ranking, not a series of its own.
 */
function capLevel<Entry extends LevelEntry>(
  entries: readonly Entry[],
  metric: UsageChartMetric,
): CappedLevel<Entry> {
  const ranked = entries
    .filter((entry) => isPlotted(entry, metric))
    .sort((left, right) => (metricValue(right, metric) ?? 0) - (metricValue(left, metric) ?? 0));
  if (ranked.length <= MAX_PLOTTED_SERIES) {
    return { kept: ranked, fold: null, foldedKeys: [] };
  }
  const folded = ranked.slice(MAX_PLOTTED_SERIES - 1);
  const fold = emptyBreakdown();
  for (const entry of folded) {
    accumulate(fold, entry);
  }
  return {
    kept: ranked.slice(0, MAX_PLOTTED_SERIES - 1),
    fold,
    foldedKeys: folded.map((entry) => entry.key),
  };
}

/**
 * One row of the legend, which is also one line in the plot. `expanded`
 * rows are the exception: an open provider keeps its legend row and its total,
 * but its line is gone from the plot because its models have taken its place.
 */
interface PlottedBand {
  key: string;
  label: string;
  /** The provider this row sits inside, or null when the row IS a provider. */
  parentKey: string | null;
  totals: UsageTokenBreakdown;
  color: string;
  /**
   * Models of this provider that carry the plotted metric. Zero draws no
   * chevron: a model with none of the metric gets no row, so a provider whose
   * every model is zero under `cost` has nothing to disclose.
   */
  childCount: number;
  expanded: boolean;
}

/** A row plus the bucket series that feed it: one key when named, many when folded. */
interface RoutedBand {
  band: PlottedBand;
  sources: string[];
}

interface PlottedBucket {
  start: string;
  /** Band key to what that band is worth in this bucket. */
  values: Map<string, UsageTokenBreakdown>;
}

interface PlottedChart {
  /** Legend order and paint order at once, so a swatch and its line agree. */
  bands: PlottedBand[];
  /** Only the bands actually drawn: an expanded provider has no band of its own. */
  drawn: PlottedBand[];
  buckets: PlottedBucket[];
}

/**
 * Both levels ride in every bucket, so a value is identified by its series key
 * AND the row it sits under: a provider's own total and one of its models are
 * two different rows that must never be added together.
 */
function lookupKey(parentKey: string | null, seriesKey: string): string {
  return `${parentKey ?? ""}\u0000${seriesKey}`;
}

function childRows(
  providerKey: string,
  parentColor: string,
  level: CappedLevel<UsageHistoryModelSeries>,
): RoutedBand[] {
  const count = level.kept.length + (level.fold === null ? 0 : 1);
  const rows: RoutedBand[] = level.kept.map((entry, index) => ({
    band: {
      key: entry.key,
      label: entry.label,
      parentKey: providerKey,
      totals: entry,
      color: childColor(parentColor, index, count),
      childCount: 0,
      expanded: false,
    },
    sources: [entry.key],
  }));
  if (level.fold !== null) {
    rows.push({
      band: {
        key: `${OTHER_SERIES_KEY}:${providerKey}`,
        label: `Other · ${level.foldedKeys.length} more`,
        parentKey: providerKey,
        totals: level.fold,
        color: childColor(parentColor, count - 1, count),
        childCount: 0,
        expanded: false,
      },
      sources: level.foldedKeys,
    });
  }
  return rows;
}

/**
 * A provider is only *shown* open when its models actually carry the plotted
 * metric: substituting a band for an empty list would drop that provider's
 * usage out of every column. The same count decides the chevron, so a row that
 * cannot open never offers to.
 */
function providerRows(
  provider: UsageHistorySeries,
  color: string,
  metric: UsageChartMetric,
  expanded: boolean,
): RoutedBand[] {
  const level = capLevel(provider.children, metric);
  const plotted = level.kept.length + level.foldedKeys.length;
  const children = expanded && plotted > 0 ? childRows(provider.key, color, level) : [];
  const row: RoutedBand = {
    band: {
      key: provider.key,
      label: provider.label,
      parentKey: null,
      totals: provider,
      color,
      childCount: plotted,
      expanded: children.length > 0,
    },
    sources: children.length > 0 ? [] : [provider.key],
  };
  return [row, ...children];
}

function flattenBucket(
  bucket: UsageHistoryBucket,
  route: ReadonlyMap<string, string>,
): PlottedBucket {
  const values = new Map<string, UsageTokenBreakdown>();
  for (const value of bucket.values) {
    const target = route.get(lookupKey(value.parentKey, value.seriesKey));
    if (target === undefined) {
      continue;
    }
    let total = values.get(target);
    if (total === undefined) {
      total = emptyBreakdown();
      values.set(target, total);
    }
    accumulate(total, value);
  }
  return { start: bucket.start, values };
}

/**
 * Resolves ranking, the per-level cap, the open disclosures and the palette in
 * one pass, so the legend and the plot can never disagree about what is drawn,
 * in what order, or in what colour.
 *
 * Series colour is derived from a stable alphabetical ordering of the providers
 * present in the unranked snapshot window, rather than from their rank under the
 * plotted metric. This preserves colour identity across metric changes.
 */
function planChart(
  buckets: readonly UsageHistoryBucket[],
  series: readonly UsageHistorySeries[],
  metric: UsageChartMetric,
  expandedKeys: ReadonlySet<string>,
  theme: PluginTheme,
): PlottedChart {
  const stableKeys = series
    .map((entry) => entry.key)
    .sort((left, right) => left.localeCompare(right));
  const count = Math.max(1, stableKeys.length);
  const level = capLevel(series, metric);
  const rows: RoutedBand[] = [];
  for (const provider of level.kept) {
    const index = stableKeys.indexOf(provider.key);
    const color = seriesColor(theme, index >= 0 ? index : 0, count);
    rows.push(...providerRows(provider, color, metric, expandedKeys.has(provider.key)));
  }
  if (level.fold !== null) {
    const foldIndex = stableKeys.findIndex(
      (key) => !level.kept.some((provider) => provider.key === key),
    );
    rows.push({
      band: {
        key: OTHER_SERIES_KEY,
        label: `Other · ${level.foldedKeys.length} more`,
        parentKey: null,
        totals: level.fold,
        color: seriesColor(theme, foldIndex >= 0 ? foldIndex : count - 1, count),
        childCount: 0,
        expanded: false,
      },
      sources: level.foldedKeys,
    });
  }
  const route = new Map<string, string>();
  for (const row of rows) {
    for (const source of row.sources) {
      route.set(lookupKey(row.band.parentKey, source), row.band.key);
    }
  }
  return {
    bands: rows.map((row) => row.band),
    drawn: rows.filter((row) => row.sources.length > 0).map((row) => row.band),
    buckets: buckets.map((bucket) => flattenBucket(bucket, route)),
  };
}

interface ChartStyles {
  chart: ViewStyle;
  plotRow: ViewStyle;
  yAxis: ViewStyle;
  axisText: TextStyle;
  plotArea: ViewStyle;
  plot: ViewStyle;
  layer: ViewStyle;
  sliver: ViewStyle;
  gridLine: ViewStyle;
  marker: ViewStyle;
  lineSegment: ViewStyle;
  baseline: ViewStyle;
  tickRow: ViewStyle;
  tickLeft: TextStyle;
  tickCenter: TextStyle;
  tickRight: TextStyle;
  legend: ViewStyle;
  legendRow: ViewStyle;
  legendChildRow: ViewStyle;
  chevronSlot: ViewStyle;
  swatch: ViewStyle;
  legendLabel: TextStyle;
  legendValue: TextStyle;
  legendUnpriced: TextStyle;
  tooltip: ViewStyle;
  tooltipPeriod: TextStyle;
  tooltipRow: ViewStyle;
  tooltipDot: ViewStyle;
  tooltipLabel: TextStyle;
  tooltipValue: TextStyle;
  tooltipTotalRow: ViewStyle;
  tooltipTotalLabel: TextStyle;
}

const EXPANDED_STATE = { expanded: true };
const COLLAPSED_STATE = { expanded: false };

/** Size and colour of every chevron in the legend, or null when none can open. */
interface ChevronConfig {
  size: number;
  color: string;
}

interface LegendRowProps {
  band: PlottedBand;
  metric: UsageChartMetric;
  /** Null keeps the gutter out of a legend where nothing is expandable. */
  chevron: ChevronConfig | null;
  styles: ChartStyles;
  onToggleSeries?: (seriesKey: string) => void;
}

/**
 * What pressing the row does, and what the row is worth, because a screen
 * reader reaches the chevron with no indentation to read the level from.
 */
function expanderLabel(band: PlottedBand, total: string, metric: UsageChartMetric): string {
  let measure = `${total} tokens`;
  if (metric === "cost") {
    measure = total === UNPRICED_LABEL ? "cost unknown, no rate for its models" : `${total} spent`;
  }
  const models = band.childCount === 1 ? "1 model" : `${band.childCount} models`;
  if (band.expanded) {
    return `Collapse ${band.label}, ${measure}, hiding its ${models}`;
  }
  return `Expand ${band.label}, ${measure}, to show its ${models}`;
}

function LegendRow({
  band,
  metric,
  chevron,
  styles,
  onToggleSeries,
}: LegendRowProps): ReactElement {
  const press = useCallback(() => {
    onToggleSeries?.(band.key);
  }, [onToggleSeries, band.key]);
  const value = metricValue(band.totals, metric);
  const total = formatMetricValue(value, metric);
  const unpriced = value === null;
  const expandable = band.childCount > 0;
  const row = [
    chevron === null ? null : (
      <View key="chevron" style={styles.chevronSlot}>
        {expandable ? (
          <Icon
            name={band.expanded ? "ChevronDown" : "ChevronRight"}
            size={chevron.size}
            color={chevron.color}
          />
        ) : null}
      </View>
    ),
    <View key="swatch" style={[styles.swatch, { backgroundColor: band.color }]} />,
    <Text key="label" numberOfLines={1} style={styles.legendLabel}>
      {band.label}
    </Text>,
    <Text key="total" style={unpriced ? styles.legendUnpriced : styles.legendValue}>
      {total}
    </Text>,
  ];
  const box = band.parentKey === null ? styles.legendRow : styles.legendChildRow;
  if (!expandable || onToggleSeries === undefined) {
    return <View style={box}>{row}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={band.expanded ? EXPANDED_STATE : COLLAPSED_STATE}
      accessibilityLabel={expanderLabel(band, total, metric)}
      onPress={press}
      style={box}
    >
      {row}
    </Pressable>
  );
}

export interface UsageTrendChartProps {
  buckets: readonly UsageHistoryBucket[];
  /**
   * Any order. The chart re-ranks by the selected metric for paint order,
   * because the server ranks by `tokens` and that order is wrong for every
   * other metric. Any length: the tail past `MAX_PLOTTED_SERIES` is summed
   * into one trailing "Other", at each level independently.
   */
  series: readonly UsageHistorySeries[];
  /**
   * Which projection of the breakdown the lines, the y-axis and the legend
   * plot. Under `cost` a series with no rate runs along the baseline and is
   * named as unpriced in the legend.
   */
  metric: UsageChartMetric;
  /** Span of the whole window, which decides date versus clock tick labels. */
  windowMs: number;
  /**
   * Providers showing their models. Both levels ride in every bucket, so a
   * disclosure opens with no request: the provider's line is replaced in place
   * by one line per model, and the bucket totals do not move.
   */
  expandedKeys: ReadonlySet<string>;
  theme: PluginTheme;
  compact: boolean;
  onToggleSeries?: (seriesKey: string) => void;
}

/**
 * Pointer handlers drive the hover readout. react-native-web forwards these
 * onto the DOM View (the app's canonical hover pattern); on native they never
 * fire and the chart renders without a readout. React Native's own types type
 * them as native pointer events, while the web runtime hands over React's
 * synthetic pointer event, so the geometry read below narrows structurally.
 */
type ViewPointerEvent = Parameters<NonNullable<ViewProps["onPointerMove"]>>[0];
/** One rotated segment of the drawn line, in measured plot pixels. */
interface LineSegmentDescriptor {
  key: string;
  x: number;
  y: number;
  length: number;
  angle: number;
}

export function UsageTrendChart({
  buckets,
  series,
  metric,
  windowMs,
  expandedKeys,
  theme,
  compact,
  onToggleSeries,
}: UsageTrendChartProps): ReactElement {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const plotHeight = compact ? PLOT_HEIGHT_COMPACT : PLOT_HEIGHT_REGULAR;
  const samples = compact ? CURVE_SAMPLES_COMPACT : CURVE_SAMPLES_REGULAR;
  const plan = useMemo(
    () => planChart(buckets, series, metric, expandedKeys, theme),
    [buckets, series, metric, expandedKeys, theme],
  );

  const { layers, max, gridTicks } = useMemo(() => {
    const scale = niceScale(maxPlottedValue(plan.buckets, plan.drawn, metric), GRID_TICK_COUNT);
    // Paint the heaviest series first, so the lighter ones are never buried.
    const ordered = plan.drawn
      .map((band, index) => ({ band, index }))
      .slice()
      .sort(
        (left, right) =>
          (metricValue(right.band.totals, metric) ?? 0) -
            (metricValue(left.band.totals, metric) ?? 0) || left.index - right.index,
      )
      .map(({ band }) => ({
        band,
        curve: sampleTrend(
          plan.buckets.map((bucket) => bandValue(bucket, band.key, metric)),
          samples,
        ).map((value, sample) => ({ value, key: `${band.key}:${sample}` })),
      }));
    return { layers: ordered, max: scale.max, gridTicks: scale.ticks };
  }, [plan, metric, samples]);

  const count = plan.buckets.length;
  const ticks = axisTicks(buckets, windowMs);
  const [plotWidth, setPlotWidth] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const trackHover = useCallback(
    (event: ViewPointerEvent) => {
      const pointer = event as unknown as {
        clientX: number;
        currentTarget: { getBoundingClientRect(): { left: number; width: number } };
      };
      const bounds = pointer.currentTarget.getBoundingClientRect();
      if (bounds.width === 0 || count === 0) {
        return;
      }
      const fraction = Math.min(1, Math.max(0, (pointer.clientX - bounds.left) / bounds.width));
      setHoverIndex(Math.min(count - 1, Math.round(fraction * (count - 1))));
    },
    [count],
  );
  const clearHover = useCallback(() => {
    setHoverIndex(null);
  }, []);

  const hoverFraction = hoverIndex === null || count <= 1 ? 0 : hoverIndex / (count - 1);
  const tooltipRight = hoverIndex !== null && hoverIndex * 2 > count - 1;
  const hoveredBucket = hoverIndex === null ? undefined : plan.buckets[hoverIndex];
  const chevron = useMemo(() => {
    if (!plan.bands.some((band) => band.childCount > 0)) {
      return null;
    }
    return { size: compact ? 12 : 14, color: theme.colors.foregroundMuted };
  }, [plan, compact, theme.colors.foregroundMuted]);

  /**
   * Share of the plot height one unit of the metric occupies, with the top pad
   * reserved so the line stroke never clips. Multiplies both the tick positions
   * and the sliver heights, so the gridlines and the curve cannot disagree.
   */
  const unitShare = max <= 0 ? 0 : (plotHeight - PLOT_TOP_PAD) / plotHeight / max;
  const handlePlotLayout = useCallback((event: LayoutChangeEvent) => {
    setPlotWidth(event.nativeEvent.layout.width);
  }, []);

  /**
   * The line joins sliver tops with one rotated segment per sample step. Caps
   * alone read as dashes wherever the curve steps more than its own width, and
   * a rotated View is the only way to draw a connected line without SVG.
   * Segment keys pair the band with the step's sample position, which is the
   * segment's identity for as long as the window is on screen.
   */
  const segmentsByBand = useMemo(() => {
    const byBand = new Map<string, LineSegmentDescriptor[]>();
    if (plotWidth <= 0) {
      return byBand;
    }
    for (const { band, curve } of layers) {
      const segments = curve.slice(0, -1).map(({ value }, index) => {
        const x1 = ((index + 0.5) / samples) * plotWidth;
        const x2 = ((index + 1.5) / samples) * plotWidth;
        const next = curve[index + 1]?.value ?? value;
        const y1 = plotHeight - Math.min(1, value * unitShare) * plotHeight;
        const y2 = plotHeight - Math.min(1, next * unitShare) * plotHeight;
        const dx = x2 - x1;
        const dy = y2 - y1;
        return {
          key: `${band.key}:${index}`,
          x: x1,
          y: y1 - LINE_WIDTH / 2,
          length: Math.hypot(dx, dy),
          angle: Math.atan2(dy, dx),
        };
      });
      byBand.set(band.key, segments);
    }
    return byBand;
  }, [layers, plotHeight, plotWidth, samples, unitShare]);

  return (
    <View style={styles.chart}>
      <View style={styles.plotRow}>
        <View style={styles.yAxis}>
          {gridTicks.map((tick) => (
            <Text key={tick} style={[styles.axisText, { top: `${(1 - tick * unitShare) * 100}%` }]}>
              {formatMetricValue(tick, metric)}
            </Text>
          ))}
        </View>
        <View style={styles.plotArea}>
          <View
            style={styles.plot}
            accessibilityRole="image"
            accessibilityLabel={`Layered ${metric} usage trend over ${count} buckets`}
            onLayout={handlePlotLayout}
            onPointerEnter={trackHover}
            onPointerMove={trackHover}
            onPointerLeave={clearHover}
          >
            {gridTicks.map((tick) =>
              tick === 0 ? null : (
                <View
                  key={tick}
                  style={[styles.gridLine, { top: `${(1 - tick * unitShare) * 100}%` }]}
                />
              ),
            )}
            {layers.map(({ band, curve }) => (
              <View key={band.key} style={styles.layer} pointerEvents="none">
                {curve.map(({ value, key }) => (
                  <View
                    key={key}
                    style={[
                      styles.sliver,
                      {
                        height: `${Math.min(100, value * unitShare * 100)}%`,
                        backgroundColor: withAlpha(band.color, FILL_ALPHA),
                      },
                    ]}
                  />
                ))}
                {(segmentsByBand.get(band.key) ?? []).map((segment) => (
                  <View
                    key={segment.key}
                    style={[
                      styles.lineSegment,
                      {
                        width: segment.length,
                        backgroundColor: band.color,
                        transform: [
                          { translateX: segment.x },
                          { translateY: segment.y },
                          { rotate: `${segment.angle}rad` },
                        ],
                      },
                    ]}
                  />
                ))}
              </View>
            ))}
          </View>
          {hoverIndex === null || count === 0 ? null : (
            <View
              style={[
                styles.marker,
                { height: plotHeight, left: count <= 1 ? 0 : `${hoverFraction * 100}%` },
              ]}
              pointerEvents="none"
            />
          )}
          {hoveredBucket === undefined ? null : (
            <View
              style={[
                styles.tooltip,
                tooltipRight
                  ? { right: `${(1 - hoverFraction) * 100}%` }
                  : { left: `${hoverFraction * 100}%` },
              ]}
              pointerEvents="none"
            >
              <Text style={styles.tooltipPeriod}>{formatTooltipBucket(hoveredBucket.start)}</Text>
              {plan.bands.map((band) => (
                <View key={band.key} style={styles.tooltipRow}>
                  <View style={[styles.tooltipDot, { backgroundColor: band.color }]} />
                  <Text numberOfLines={1} style={styles.tooltipLabel}>
                    {band.label}
                  </Text>
                  <Text style={styles.tooltipValue}>
                    {formatMetricValue(bandValue(hoveredBucket, band.key, metric), metric)}
                  </Text>
                </View>
              ))}
              <View style={styles.tooltipTotalRow}>
                <Text style={styles.tooltipTotalLabel}>Total</Text>
                <Text style={styles.tooltipValue}>
                  {formatMetricValue(
                    plan.drawn.reduce(
                      (sum, band) => sum + bandValue(hoveredBucket, band.key, metric),
                      0,
                    ),
                    metric,
                  )}
                </Text>
              </View>
            </View>
          )}
          <View style={styles.baseline} />
          <View style={styles.tickRow}>
            <Text numberOfLines={1} style={styles.tickLeft}>
              {ticks.left}
            </Text>
            <Text numberOfLines={1} style={styles.tickCenter}>
              {ticks.center}
            </Text>
            <Text numberOfLines={1} style={styles.tickRight}>
              {ticks.right}
            </Text>
          </View>
        </View>
      </View>
      <View style={styles.legend}>
        {plan.bands.map((band) => (
          <LegendRow
            key={band.key}
            band={band}
            metric={metric}
            chevron={chevron}
            styles={styles}
            onToggleSeries={onToggleSeries}
          />
        ))}
      </View>
    </View>
  );
}

function createStyles(theme: PluginTheme, compact: boolean): ChartStyles {
  const plotHeight = compact ? PLOT_HEIGHT_COMPACT : PLOT_HEIGHT_REGULAR;
  const chevronWidth = compact ? 12 : 14;
  return {
    chart: {
      gap: compact ? 10 : 14,
    },
    plotRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
    },
    yAxis: {
      height: plotHeight,
      width: compact ? 32 : 40,
      alignItems: "flex-end",
    },
    axisText: {
      position: "absolute",
      right: 0,
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 11,
      fontVariant: ["tabular-nums"],
      transform: [{ translateY: "-50%" }],
    },
    plotArea: {
      flex: 1,
    },
    plot: {
      height: plotHeight,
      backgroundColor: theme.colors.surface1,
      borderTopLeftRadius: 4,
      borderTopRightRadius: 4,
      overflow: "hidden",
    },
    layer: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      flexDirection: "row",
      alignItems: "flex-end",
    },
    sliver: {
      flex: 1,
    },
    lineSegment: {
      position: "absolute",
      left: 0,
      top: 0,
      height: LINE_WIDTH,
      transformOrigin: "0px 50%",
    },
    gridLine: {
      position: "absolute",
      left: 0,
      right: 0,
      height: 1,
      backgroundColor: theme.colors.border,
    },
    marker: {
      position: "absolute",
      top: 0,
      width: 1,
      backgroundColor: theme.colors.foregroundMuted,
      opacity: 0.5,
    },
    baseline: {
      height: 1,
      backgroundColor: theme.colors.border,
    },
    tickRow: {
      flexDirection: "row",
      paddingTop: 4,
    },
    tickLeft: {
      flex: 1,
      textAlign: "left",
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 11,
    },
    tickCenter: {
      flex: 1,
      textAlign: "center",
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 11,
    },
    tickRight: {
      flex: 1,
      textAlign: "right",
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 11,
    },
    legend: {
      gap: compact ? 4 : 6,
    },
    legendRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 2,
    },
    legendChildRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 2,
      paddingLeft: chevronWidth + (compact ? 12 : 16),
    },
    chevronSlot: {
      width: chevronWidth,
      alignItems: "center",
    },
    swatch: {
      width: 10,
      height: 10,
      borderRadius: 2,
    },
    legendLabel: {
      flex: 1,
      color: theme.colors.foreground,
      fontSize: compact ? 12 : 13,
    },
    legendValue: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 12 : 13,
      fontVariant: ["tabular-nums"],
    },
    legendUnpriced: {
      color: theme.colors.statusWarning,
      fontSize: compact ? 12 : 13,
    },
    tooltip: {
      position: "absolute",
      top: 6,
      zIndex: 10,
      minWidth: 120,
      maxWidth: "45%",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      paddingHorizontal: 10,
      paddingVertical: 8,
      gap: 3,
      marginLeft: 10,
      marginRight: 10,
      shadowColor: "#000000",
      shadowOpacity: 0.25,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 4,
    },
    tooltipPeriod: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 11,
      marginBottom: 2,
    },
    tooltipRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    tooltipDot: {
      width: 8,
      height: 8,
      borderRadius: 2,
    },
    tooltipLabel: {
      flex: 1,
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 11 : 12,
    },
    tooltipValue: {
      color: theme.colors.foreground,
      fontSize: compact ? 11 : 12,
      fontVariant: ["tabular-nums"],
    },
    tooltipTotalRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      marginTop: 3,
      paddingTop: 5,
    },
    tooltipTotalLabel: {
      flex: 1,
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 11 : 12,
    },
  };
}
