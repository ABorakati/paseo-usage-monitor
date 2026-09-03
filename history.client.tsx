import {
  Icon,
  useRpc,
  type PluginSurfaceProps,
  type PluginTheme,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";
import { Platform, ScrollView, Text, View, type TextStyle, type ViewStyle } from "react-native";
import {
  UsageTrendChart,
  formatMetricValue,
  formatTokensCompact,
  metricValue,
  pricedSubtotal,
  type UsageChartMetric,
} from "./chart.client";
import {
  readUsageHistory,
  type UsageHistoryGroupBy,
  type UsageHistoryRange,
  type UsageHistoryScanError,
  type UsageHistorySnapshot,
  type UsageRatesReport,
  type UsageTokenBreakdown,
} from "./history.shared";
import { TooltipPressable as Pressable } from "./tooltip.client";

const RANGE_ORDER: readonly UsageHistoryRange[] = ["24h", "7d", "30d"];
const METRIC_ORDER: readonly UsageChartMetric[] = ["work", "cached", "total", "cost"];
const GROUP_BY_ORDER: readonly UsageHistoryGroupBy[] = ["provider", "model"];

const WINDOW_LABEL: Record<UsageHistoryRange, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

const METRIC_LABEL: Record<UsageChartMetric, string> = {
  work: "Work",
  cached: "Cached",
  total: "Total",
  cost: "Cost",
};

/** Completes "<count> …" in the headline, so each metric names itself. */
const METRIC_HEADLINE: Record<UsageChartMetric, string> = {
  work: "tokens of work",
  cached: "cached tokens",
  total: "tokens total",
  cost: "spent",
};

const METRIC_NOUN: Record<UsageChartMetric, string> = {
  work: "work",
  cached: "cached",
  total: "total",
  cost: "cost",
};

/** Spelled out per metric, because "Plot cost tokens" is not a thing. */
const METRIC_ACTION: Record<UsageChartMetric, string> = {
  work: "Plot work tokens",
  cached: "Plot cached tokens",
  total: "Plot total tokens",
  cost: "Plot cost in US dollars",
};

const GROUP_BY_LABEL: Record<UsageHistoryGroupBy, string> = {
  provider: "By provider",
  model: "By model",
};

const GROUP_BY_NOUN: Record<UsageHistoryGroupBy, string> = {
  provider: "provider",
  model: "model",
};

const EMPTY_HINT =
  "History is read back out of the Claude Code, Codex and omp session logs on this host. None of them recorded token usage in this window.";

/**
 * Why the Cost pill is dead, said where a screen reader will reach it: the pill
 * is disabled rather than plotting a column of zeros that would read as free.
 */
const COST_DISABLED_LABEL =
  "Cost is unavailable: no rate table could be loaded, so these tokens cannot be priced";

const COST_UNAVAILABLE_HINT =
  "Cost is unavailable: no rate table could be loaded, so these tokens cannot be priced.";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface PillAccessibilityState {
  selected: boolean;
  disabled?: boolean;
}

const SELECTED_STATE: PillAccessibilityState = { selected: true };
const UNSELECTED_STATE: PillAccessibilityState = { selected: false };
const DISABLED_STATE: PillAccessibilityState = { selected: false, disabled: true };
const EXPANDED_STATE = { expanded: true };
const COLLAPSED_STATE = { expanded: false };
const PILL_HIT_SLOP = { top: 8, bottom: 8, left: 4, right: 4 };
const DROPDOWN_TRIGGER_HIT_SLOP = { top: 7, bottom: 7, left: 4, right: 4 };
const DROPDOWN_OPTION_HIT_SLOP = { top: 6, bottom: 6, left: 4, right: 4 };

/**
 * Which providers are showing their models. Local state, never a query
 * parameter: both levels ride in every snapshot, so a disclosure opens without
 * a request and survives a range or metric change untouched.
 */
const NOTHING_EXPANDED: ReadonlySet<string> = new Set();

interface HistoryStyles {
  screen: ViewStyle;
  content: ViewStyle;
  header: ViewStyle;
  total: TextStyle;
  window: TextStyle;
  pills: ViewStyle;
  pill: ViewStyle;
  pillSelected: ViewStyle;
  pillText: TextStyle;
  pillTextSelected: TextStyle;
  pillDisabled: ViewStyle;
  pillTextDisabled: TextStyle;
  dropdown: ViewStyle;
  dropdownTrigger: ViewStyle;
  dropdownTriggerText: TextStyle;
  dropdownMenu: ViewStyle;
  dropdownOption: ViewStyle;
  dropdownOptionSelected: ViewStyle;
  dropdownOptionText: TextStyle;
  dropdownOptionTextSelected: TextStyle;
  muted: TextStyle;
  rates: TextStyle;
  error: TextStyle;
  footer: TextStyle;
}

interface SelectorPillProps<Value extends string> {
  value: Value;
  label: string;
  accessibilityLabel: string;
  selected: boolean;
  /** A metric the snapshot cannot answer, kept visible so its absence is explained. */
  disabled: boolean;
  styles: HistoryStyles;
  onSelect: (value: Value) => void;
}

function pillState(selected: boolean, disabled: boolean): PillAccessibilityState {
  if (disabled) {
    return DISABLED_STATE;
  }
  return selected ? SELECTED_STATE : UNSELECTED_STATE;
}

function SelectorPill<Value extends string>({
  value,
  label,
  accessibilityLabel,
  selected,
  disabled,
  styles,
  onSelect,
}: SelectorPillProps<Value>): ReactElement {
  const press = useCallback(() => onSelect(value), [onSelect, value]);
  let box = styles.pill;
  let text = styles.pillText;
  if (disabled) {
    box = styles.pillDisabled;
    text = styles.pillTextDisabled;
  } else if (selected) {
    box = styles.pillSelected;
    text = styles.pillTextSelected;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={pillState(selected, disabled)}
      accessibilityLabel={accessibilityLabel}
      tooltip={accessibilityLabel}
      disabled={disabled}
      hitSlop={PILL_HIT_SLOP}
      onPress={press}
      style={box}
    >
      <Text style={text}>{label}</Text>
    </Pressable>
  );
}

interface GroupByOptionProps {
  value: UsageHistoryGroupBy;
  selected: boolean;
  styles: HistoryStyles;
  onSelect: (value: UsageHistoryGroupBy) => void;
}

function GroupByOption({ value, selected, styles, onSelect }: GroupByOptionProps): ReactElement {
  const press = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      accessibilityLabel={`Group usage by ${GROUP_BY_NOUN[value]}`}
      tooltip={`Group usage by ${GROUP_BY_NOUN[value]}`}
      hitSlop={DROPDOWN_OPTION_HIT_SLOP}
      onPress={press}
      style={selected ? styles.dropdownOptionSelected : styles.dropdownOption}
    >
      <Text style={selected ? styles.dropdownOptionTextSelected : styles.dropdownOptionText}>
        {GROUP_BY_LABEL[value]}
      </Text>
    </Pressable>
  );
}

/** Only cost can be unavailable, and only because no rate table would load. */
function metricUnavailable(
  snapshot: UsageHistorySnapshot | undefined,
  metric: UsageChartMetric,
): boolean {
  return metric === "cost" && snapshot?.rates.status === "unavailable";
}

/**
 * What the selected metric is worth over the whole window, and whether that is
 * the whole of it. A cost total goes null as soon as one model has no rate, and
 * refusing to report anything then would hide the spend that *is* known — so the
 * surface falls back to the priced series and marks the figure as a floor.
 */
interface SelectedTotal {
  value: number;
  partial: boolean;
}

function selectedTotal(snapshot: UsageHistorySnapshot, metric: UsageChartMetric): SelectedTotal {
  const total = metricValue(snapshot.totals, metric);
  if (total !== null) {
    return { value: total, partial: false };
  }
  return { value: pricedSubtotal(snapshot.series), partial: true };
}

function headline(
  snapshot: UsageHistorySnapshot | undefined,
  metric: UsageChartMetric,
  range: UsageHistoryRange,
): string {
  if (snapshot === undefined) {
    return `— · ${WINDOW_LABEL[range]}`;
  }
  const total = selectedTotal(snapshot, metric);
  let figure = formatMetricValue(total.value, metric);
  if (total.partial) {
    // A floor of nothing is not a floor: say the figure is unknown instead.
    figure = total.value > 0 ? `${figure}+` : "—";
  }
  return `${figure} ${METRIC_HEADLINE[metric]} · ${WINDOW_LABEL[range]}`;
}

/**
 * Always the whole split, whichever metric is plotted: the number the headline
 * omits is the one a reader would otherwise assume away. Reasoning tokens and
 * long-TTL cache writes are subsets, so each is quoted inside the category it
 * belongs to rather than beside it, where it would read as extra tokens.
 */
function splitLabel(totals: UsageTokenBreakdown): string {
  let output = `${formatTokensCompact(totals.outputTokens)} out`;
  if (totals.reasoningTokens > 0) {
    output = `${output} (${formatTokensCompact(totals.reasoningTokens)} reasoning)`;
  }
  let write = `${formatTokensCompact(totals.cacheCreationTokens)} cache write`;
  if (totals.cacheCreationLongTtlTokens > 0) {
    write = `${write} (${formatTokensCompact(totals.cacheCreationLongTtlTokens)} at 1h)`;
  }
  const read = `${formatTokensCompact(totals.cachedInputTokens)} cache read`;
  return `${formatTokensCompact(totals.uncachedInputTokens)} in · ${output} · ${read} · ${write}`;
}

function emptyHint(snapshot: UsageHistorySnapshot, metric: UsageChartMetric): string {
  if (snapshot.totals.tokens === 0) {
    return EMPTY_HINT;
  }
  const total = formatTokensCompact(snapshot.totals.tokens);
  const alternatives = METRIC_ORDER.filter(
    (option) => option !== metric && !metricUnavailable(snapshot, option),
  )
    .map((option) => METRIC_LABEL[option])
    .join(", ");
  if (metric === "cost") {
    return `No priced usage in this window. The logs hold ${total} tokens, but no rate priced any of the models behind them, so try ${alternatives}, or a wider range.`;
  }
  return `No ${METRIC_NOUN[metric]} tokens in this window. The logs do hold ${total} tokens across the other metrics, so try ${alternatives}, or a wider range.`;
}

/**
 * Where the money came from, and what it leaves out. A total that silently
 * excludes a model is worse than no total, so up to three unpriced models are
 * named here and the rest are counted.
 */
function ratesLine(rates: UsageRatesReport, now: number): string {
  if (rates.status === "unavailable") {
    return COST_UNAVAILABLE_HINT;
  }
  const source =
    rates.status === "fresh"
      ? "Priced from today's rate table."
      : cachedTableAge(rates.fetchedAt, now);
  if (rates.unpricedModels.length === 0) {
    return source;
  }
  const named = rates.unpricedModels.slice(0, 3);
  const hidden = rates.unpricedModels.length - named.length;
  const listed = hidden > 0 ? `${named.join(", ")} +${hidden} more` : named.join(", ");
  return `${source} Excludes ${listed}: no rate found.`;
}

/** Coarse on purpose: the exact age of a rate table never changes a decision. */
function cachedTableAge(fetchedAt: string | null, now: number): string {
  const fetched = fetchedAt === null ? Number.NaN : Date.parse(fetchedAt);
  if (Number.isNaN(fetched)) {
    return "Priced from a cached rate table of unknown age.";
  }
  const elapsed = now - fetched;
  if (elapsed < HOUR_MS) {
    return "Priced from a rate table fetched less than an hour ago.";
  }
  if (elapsed < DAY_MS) {
    return `Priced from a rate table fetched ${Math.floor(elapsed / HOUR_MS)}h ago.`;
  }
  return `Priced from a rate table fetched ${Math.floor(elapsed / DAY_MS)}d ago.`;
}

function scanErrorSummary(errors: readonly UsageHistoryScanError[]): string {
  const sources = errors.slice(0, 3).map((error) => error.source);
  const hidden = errors.length - sources.length;
  if (hidden > 0) {
    sources.push(`+${hidden} more`);
  }
  return `Skipped while scanning: ${sources.join(", ")}`;
}

function UsageHistoryBody({ theme, layout }: PluginSurfaceProps): ReactElement {
  const [range, setRange] = useState<UsageHistoryRange>("24h");
  const [metric, setMetric] = useState<UsageChartMetric>("work");
  const [groupBy, setGroupBy] = useState<UsageHistoryGroupBy>("provider");
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NOTHING_EXPANDED);
  const readHistory = useRpc(readUsageHistory);
  const query = useQuery({
    queryKey: ["usage-limits", "history", range, groupBy],
    queryFn: () => readHistory({ range, groupBy }),
    staleTime: 30_000,
  });
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);

  const snapshot = query.data;
  if (metricUnavailable(snapshot, metric)) {
    setMetric("work");
  }

  const toggleSeries = useCallback((seriesKey: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(seriesKey)) {
        next.delete(seriesKey);
      } else {
        next.add(seriesKey);
      }
      return next;
    });
  }, []);
  const toggleGroupMenu = useCallback(() => setGroupMenuOpen((open) => !open), []);
  const chooseGroupBy = useCallback((option: UsageHistoryGroupBy) => {
    setGroupBy(option);
    setGroupMenuOpen(false);
    // Grouping by model puts the models AT the top level, where nothing nests.
    if (option === "model") {
      setExpanded(NOTHING_EXPANDED);
    }
  }, []);

  const total = snapshot === undefined ? null : selectedTotal(snapshot, metric);
  const hasUsage = snapshot !== undefined && total !== null && total.value > 0;
  const scanErrors = snapshot?.scanErrors ?? [];
  let ratesHint: string | null = null;
  if (snapshot !== undefined && (metric === "cost" || snapshot.rates.status === "unavailable")) {
    ratesHint = ratesLine(snapshot.rates, Date.now());
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.total}>{headline(snapshot, metric, range)}</Text>
        {snapshot === undefined ? null : (
          <Text style={styles.window}>{splitLabel(snapshot.totals)}</Text>
        )}
      </View>
      <View style={styles.pills}>
        {RANGE_ORDER.map((option) => (
          <SelectorPill
            key={option}
            value={option}
            label={option}
            accessibilityLabel={`Show the ${WINDOW_LABEL[option]}`}
            selected={option === range}
            disabled={false}
            styles={styles}
            onSelect={setRange}
          />
        ))}
      </View>
      <View style={styles.pills}>
        {METRIC_ORDER.map((option) => {
          const unavailable = metricUnavailable(snapshot, option);
          return (
            <SelectorPill
              key={option}
              value={option}
              label={METRIC_LABEL[option]}
              accessibilityLabel={unavailable ? COST_DISABLED_LABEL : METRIC_ACTION[option]}
              selected={option === metric}
              disabled={unavailable}
              styles={styles}
              onSelect={setMetric}
            />
          );
        })}
      </View>
      {ratesHint === null ? null : <Text style={styles.rates}>{ratesHint}</Text>}
      <View style={styles.dropdown}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={groupMenuOpen ? EXPANDED_STATE : COLLAPSED_STATE}
          accessibilityLabel={`Grouped by ${GROUP_BY_NOUN[groupBy]}. Choose provider or model.`}
          tooltip="Choose usage grouping"
          hitSlop={DROPDOWN_TRIGGER_HIT_SLOP}
          onPress={toggleGroupMenu}
          style={styles.dropdownTrigger}
        >
          <Text style={styles.dropdownTriggerText}>{GROUP_BY_LABEL[groupBy]}</Text>
          <Icon
            name="ChevronDown"
            size={layout.compact ? 14 : 16}
            color={theme.colors.foregroundMuted}
          />
        </Pressable>
        {groupMenuOpen ? (
          <View style={styles.dropdownMenu}>
            {GROUP_BY_ORDER.map((option) => (
              <GroupByOption
                key={option}
                value={option}
                selected={option === groupBy}
                styles={styles}
                onSelect={chooseGroupBy}
              />
            ))}
          </View>
        ) : null}
      </View>
      {query.isPending ? <Text style={styles.muted}>Reading usage logs…</Text> : null}
      {query.error === null ? null : <Text style={styles.error}>{query.error.message}</Text>}
      {snapshot !== undefined && !hasUsage ? (
        <Text style={styles.muted}>{emptyHint(snapshot, metric)}</Text>
      ) : null}
      {hasUsage && snapshot !== undefined ? (
        <UsageTrendChart
          buckets={snapshot.buckets}
          series={snapshot.series}
          metric={metric}
          windowMs={Date.parse(snapshot.to) - Date.parse(snapshot.from)}
          theme={theme}
          compact={layout.compact}
          expandedKeys={expanded}
          onToggleSeries={toggleSeries}
        />
      ) : null}
      {scanErrors.length > 0 ? (
        <Text style={styles.footer}>{scanErrorSummary(scanErrors)}</Text>
      ) : null}
    </ScrollView>
  );
}

export function UsageHistorySurface(props: PluginSurfaceProps): ReactElement {
  return <UsageHistoryBody theme={props.theme} host={props.host} layout={props.layout} />;
}

export function UsageHistoryPanel(props: PluginWorkspacePanelProps): ReactElement {
  return <UsageHistoryBody theme={props.theme} host={props.host} layout={props.layout} />;
}

function createStyles(theme: PluginTheme, compact: boolean): HistoryStyles {
  return {
    screen: {
      flex: 1,
      backgroundColor: theme.colors.surface0,
    },
    content: {
      padding: compact ? 16 : 24,
      gap: compact ? 12 : 16,
    },
    header: {
      gap: 2,
    },
    total: {
      color: theme.colors.foreground,
      fontSize: compact ? 17 : 20,
      fontVariant: ["tabular-nums"],
    },
    window: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 12 : 13,
    },
    pills: {
      flexDirection: "row",
      gap: 6,
    },
    pill: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 999,
      backgroundColor: theme.colors.surface1,
    },
    pillSelected: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 999,
      backgroundColor: theme.colors.accent,
    },
    pillText: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 12 : 13,
    },
    pillTextSelected: {
      color: theme.colors.accentForeground,
      fontSize: compact ? 12 : 13,
    },
    pillDisabled: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 999,
      backgroundColor: theme.colors.surface1,
      opacity: 0.45,
    },
    pillTextDisabled: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 12 : 13,
      textDecorationLine: "line-through",
    },
    dropdown: {
      alignSelf: "flex-start",
      zIndex: 2,
    },
    dropdownTrigger: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    dropdownTriggerText: {
      color: theme.colors.foreground,
      fontSize: compact ? 12 : 13,
    },
    dropdownMenu: {
      position: Platform.OS === "web" ? "absolute" : "relative",
      top: Platform.OS === "web" ? "100%" : undefined,
      left: 0,
      marginTop: 4,
      minWidth: 132,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      overflow: "hidden",
    },
    dropdownOption: {
      paddingVertical: 8,
      paddingHorizontal: 12,
    },
    dropdownOptionSelected: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      backgroundColor: theme.colors.surface1,
    },
    dropdownOptionText: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 12 : 13,
    },
    dropdownOptionTextSelected: {
      color: theme.colors.foreground,
      fontSize: compact ? 12 : 13,
    },
    muted: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 12 : 13,
      lineHeight: compact ? 18 : 20,
    },
    rates: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 11 : 12,
      lineHeight: compact ? 16 : 18,
    },
    error: {
      color: theme.colors.statusDanger,
      fontSize: compact ? 12 : 13,
    },
    footer: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 11,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      paddingTop: 8,
    },
  };
}
