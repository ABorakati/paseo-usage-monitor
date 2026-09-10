import type { PluginTheme } from "@getpaseo/plugin";
import {
  type PluginButtonContentProps,
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
  useRpc,
  usePaseo,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Image,
  type ImageStyle,
  Platform,
  Pressable,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { formatUsageAmount } from "../shared/amount.shared";
import { requestProviderEditor } from "./editor-request.client";
import {
  EM_DASH,
  formatUpdatedLabel,
  formatWhenHint,
  isShowingStaleReadings,
  limitsPollInterval,
  LIMITS_POLL_MS,
  LIVE_LIMITS_POLL_MS,
  quotaPacePercent,
  useTickingClock,
} from "./limits.client";
import {
  readUsageLimits,
  USAGE_LIMITS_QUERY_KEY,
  type UsageIcon,
  type UsageProviderSnapshot,
  type UsageWindow,
} from "../shared/limits.shared";
import { CodexBankedResetAction } from "./codex-reset.client";
import { clampPercent, UsageMeter, usageTone } from "./meter.client";
import {
  composerPillId,
  type ComposerPillEntry,
  matchesPillSelection,
  type PillMetrics,
  pillMetrics,
  type ResolvedPillSettings,
  resolvePillSettings,
  selectComposerPills,
  selectPillReading,
  usageWindowRows,
} from "../shared/pills.shared";

/**
 * Usage on the composer rail: the mark the host draws inside each pill, and
 * the card body the host shows when one is pressed. The host owns the
 * pressable, the pill chrome, the anchoring, the containment and the
 * dismissal, so a component here draws the inside of one pill — or the body
 * of its card — and nothing else. Every rule about which reading a pill
 * tracks lives in `pills.shared.ts`.
 *
 * The label is not a component: the host renders one text line from the
 * contribution, so `contributeComposerPills` publishes it through the
 * registration the host hands back.
 */

const SETTINGS_SURFACE_ID = "settings";
/** The card is wide enough for a bar, and a bar states progress plainly. */
const CARD_METER_STYLE = "bar" as const;
/** The rail has room for one 14px shape, and a dial reads as a level there. */
const RAIL_METER_STYLE = "ring" as const;
/**
 * The slot the host hands a custom icon. `UsageMeter`'s rail ring is 14px too,
 * so a ring fills the slot exactly; the marks drawn inside the other styles
 * scale from the same number.
 */
const MARK_SLOT = 14;
/** The mark inside the ring, and the one above the bar, at the 14px slot. */
const RING_MARK_SIZE = 8;
const BAR_MARK_SIZE = 10;
const MARK_RADIUS = 4;
const MARK_TEXT_SIZE = 8;
/** The bar pinned under the pill's mark. */
const MARK_BAR_HEIGHT = 3;

interface MarkStyles {
  /** The slot this mark draws in, so an icon can size itself to it. */
  size: number;
  box: ViewStyle;
  text: TextStyle;
  image: ImageStyle;
}

/** The provider mark at one of the pill's three sizes. */
function createMarkStyles(size: number, plate: string, foreground: string): MarkStyles {
  const radius = Math.max(2, Math.round((size * MARK_RADIUS) / MARK_SLOT));
  return {
    size,
    box: {
      width: size,
      height: size,
      borderRadius: radius,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: plate,
      flexShrink: 0,
    },
    // Two initials still have to read in the smallest slot the host hands out.
    text: {
      fontSize: Math.max(5, Math.round((size * MARK_TEXT_SIZE) / MARK_SLOT)),
      fontWeight: "600",
      color: foreground,
    },
    image: { width: size, height: size, borderRadius: radius, flexShrink: 0 },
  };
}

interface PillStyles {
  mark: MarkStyles;
  ringMark: MarkStyles;
  barMark: MarkStyles;
  ring: ViewStyle;
  ringMarkBox: ViewStyle;
  bar: ViewStyle;
  barTrack: ViewStyle;
  barFill: ViewStyle;
  cardBody: ViewStyle;
  cardTitle: TextStyle;
  cardHeadline: TextStyle;
  cardDetail: TextStyle;
  cardMeter: ViewStyle;
  cardRefresh: ViewStyle;
  cardWindow: ViewStyle;
  cardIconAction: ViewStyle;
  cardRow: ViewStyle;
  cardRule: ViewStyle;
  cardAction: TextStyle;
  terminalOutput: ViewStyle;
  terminalLine: TextStyle;
  terminalActions: ViewStyle;
}

function createPillStyles(theme: PluginTheme, plate: string, size: number): PillStyles {
  const muted = theme.colors.foregroundMuted;
  const foreground = theme.colors.foreground;
  // Stated at the 14px slot, so a host that hands a smaller one still gets a
  // mark that leaves the gauge around it readable.
  const ringMarkSize = Math.max(4, Math.round((size * RING_MARK_SIZE) / MARK_SLOT));
  const barMarkSize = Math.max(4, Math.round((size * BAR_MARK_SIZE) / MARK_SLOT));
  return {
    mark: createMarkStyles(size, plate, foreground),
    ringMark: createMarkStyles(ringMarkSize, plate, foreground),
    barMark: createMarkStyles(barMarkSize, plate, foreground),
    /**
     * `UsageMeter`'s rail ring is 14px and the host's slot is 14px, so the
     * gauge is the whole box; the mark sits on the hole in its middle.
     */
    ring: {
      width: size,
      height: size,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    ringMarkBox: {
      position: "absolute",
      left: (size - ringMarkSize) / 2,
      top: (size - ringMarkSize) / 2,
    },
    /** Mark on top, its own progress bar pinned to the foot of the same box. */
    bar: {
      width: size,
      height: size,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "space-between",
      flexShrink: 0,
    },
    // Darker than the meter's own default track: the host paints the pill
    // `surface2` while it is hovered, which would swallow the empty part.
    barTrack: {
      width: "100%",
      height: MARK_BAR_HEIGHT,
      borderRadius: MARK_BAR_HEIGHT / 2,
      backgroundColor: theme.colors.surface0,
      overflow: "hidden",
      flexShrink: 0,
    },
    barFill: {
      height: MARK_BAR_HEIGHT,
      borderRadius: MARK_BAR_HEIGHT / 2,
      backgroundColor: plate,
    },
    // The host draws the popover's own surface around the body, so this only
    // spaces the rows inside it.
    cardBody: { gap: 2 },
    cardTitle: { fontSize: 14, fontWeight: "600", color: foreground },
    cardHeadline: { fontSize: 14, fontWeight: "600", color: foreground },
    cardDetail: { fontSize: 12, color: muted },
    cardMeter: { marginTop: 4, marginBottom: 6 },
    // A 24px target on a 13px glyph: small enough not to compete with the
    // title, big enough to press without aiming.
    cardRefresh: {
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 6,
      flexShrink: 0,
    },
    cardWindow: { gap: 4, marginTop: 6 },
    cardIconAction: {
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 6,
      flexShrink: 0,
    },
    cardRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    cardRule: {
      height: 1,
      marginVertical: 6,
      backgroundColor: theme.colors.border,
    },
    cardAction: { fontSize: 12, color: theme.colors.accent, flexShrink: 0 },
    /**
     * The live capture of the CLI the reader launched. A fixed ceiling rather
     * than a flowing height, so a chatty CLI cannot push the rest of the body
     * out of the host's popover; the tail is what matters, and it stays in
     * view.
     */
    terminalOutput: {
      marginTop: 4,
      marginBottom: 2,
      padding: 8,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
      gap: 2,
    },
    terminalLine: {
      fontSize: 10,
      lineHeight: 13,
      fontFamily: Platform.OS === "web" ? "monospace" : undefined,
      color: theme.colors.foregroundMuted,
    },
    terminalActions: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 2,
    },
  };
}

/**
 * A rail-sized provider mark. `ProviderMark` in `limits.client.tsx` draws the
 * card's 24-28px mark and needs that surface's whole stylesheet to do it, which
 * a 14px pill has no use for.
 */
function PillMark({
  icon,
  label,
  styles,
  color,
}: {
  icon: UsageIcon | null;
  label: string;
  styles: MarkStyles;
  color: string;
}) {
  if (icon?.kind === "image") {
    return (
      <Image accessibilityIgnoresInvertColors source={imageSource(icon.uri)} style={styles.image} />
    );
  }
  if (icon?.kind === "lucide") {
    return <Icon name={icon.name} size={styles.size} color={color} />;
  }
  const text = icon?.kind === "monogram" ? icon.text : label;
  return (
    <View style={styles.box}>
      <Text style={styles.text}>{text.slice(0, 2).toUpperCase()}</Text>
    </View>
  );
}

const imageSources = new Map<string, { uri: string }>();
function imageSource(uri: string): { uri: string } {
  const existing = imageSources.get(uri);
  if (existing !== undefined) {
    return existing;
  }
  const source = { uri };
  imageSources.set(uri, source);
  return source;
}

function findProvider(
  providers: readonly UsageProviderSnapshot[] | undefined,
  providerId: string,
): UsageProviderSnapshot | null {
  return providers?.find((provider) => provider.providerId === providerId) ?? null;
}

/**
 * The body a pill's popover shows: the tracked reading in full, then one row
 * per other window so a weekly allowance is one glance away from a session
 * figure. The host owns the popover's surface, its placement and its
 * dismissal, so this draws the rows and nothing around them.
 */
function PillCard({
  provider,
  metrics,
  styles,
  tone,
  theme,
  workspaceId,
  close,
}: {
  provider: UsageProviderSnapshot;
  metrics: PillMetrics | null;
  styles: PillStyles;
  tone: string;
  theme: PluginTheme;
  workspaceId: string;
  close: () => void;
}) {
  const now = useTickingClock();
  const { refreshing, refresh } = useProviderRefresh(provider.fetchedAt);
  const terminalRefresh = useTerminalRefresh(
    workspaceId,
    provider.authRefreshCommand ?? "",
    provider.label,
  );
  const headline = useMemo(() => {
    if (metrics === null || metrics.readout === null) {
      return null;
    }
    return metrics.percentUsed === null ? metrics.readout : `${metrics.readout} used`;
  }, [metrics]);
  const amounts = useMemo(
    () => (metrics === null ? null : trackedAmounts(provider, metrics)),
    [metrics, provider],
  );
  const resets = formatWhenHint("Resets", metrics?.resetsAt ?? null, now);
  const updated = formatUpdatedLabel(provider.fetchedAt, now, isShowingStaleReadings(provider));
  const others = useMemo(
    () => usageWindowRows(provider.readings, trackedReadingId(provider, metrics)),
    [metrics, provider],
  );
  const headlineStyle = useMemo(() => [styles.cardHeadline, { color: tone }], [styles, tone]);
  const trackedWindow = useMemo(() => trackedReadingWindow(provider, metrics), [metrics, provider]);
  /**
   * Opens this provider's own editor and drops the popover: once the settings
   * surface is what the reader is looking at, the card has said its piece.
   */
  const openProviderSettings = useCallback(() => {
    requestProviderEditor(provider.providerId);
    clientContext?.openSurface(SETTINGS_SURFACE_ID);
    close();
  }, [close, provider.providerId]);

  return (
    <View style={styles.cardBody}>
      <View style={styles.cardRow}>
        <Text numberOfLines={1} style={styles.cardTitle}>
          {metrics?.windowLabel === null || metrics === null
            ? provider.label
            : `${provider.label} · ${metrics.windowLabel}`}
        </Text>
        <Pressable
          accessibilityLabel={`Refresh ${provider.label} usage`}
          accessibilityRole="button"
          accessibilityState={refreshing ? CARD_BUSY : CARD_IDLE}
          disabled={refreshing}
          onPress={refresh}
          style={styles.cardRefresh}
        >
          <Icon
            name="RefreshCw"
            size={13}
            color={refreshing ? theme.colors.foregroundMuted : theme.colors.foreground}
          />
        </Pressable>
      </View>
      {headline === null ? null : <Text style={headlineStyle}>{headline}</Text>}
      {metrics === null || metrics.percentFilled === null ? null : (
        <View style={styles.cardMeter}>
          <UsageMeter
            percentUsed={metrics.percentUsed ?? 0}
            percentFilled={metrics.percentFilled}
            pacePercent={quotaPacePercent(trackedWindow, now)}
            style={CARD_METER_STYLE}
            trackColor={theme.colors.surface0}
            theme={theme}
            compact
          />
        </View>
      )}
      {amounts === null ? null : <Text style={styles.cardDetail}>{amounts}</Text>}
      {resets === null ? null : <Text style={styles.cardDetail}>{resets}</Text>}
      {provider.notice === null ? null : <Text style={styles.cardDetail}>{provider.notice}</Text>}
      {provider.error === null ? null : <Text style={styles.cardDetail}>{provider.error}</Text>}
      <CodexBankedResetAction provider={provider} theme={theme} compact />
      {provider.authRefreshCommand === null ? null : terminalRefresh.status === "idle" ? (
        <Pressable
          accessibilityLabel={`Refresh ${provider.label} credentials by running ${provider.authRefreshCommand}`}
          accessibilityRole="button"
          onPress={terminalRefresh.start}
        >
          <Text style={styles.cardAction}>Refresh via terminal</Text>
        </Pressable>
      ) : (
        <>
          <View style={styles.terminalOutput}>
            <Text style={styles.terminalLine}>
              {terminalRefresh.lines.length === 0
                ? `Starting \`${provider.authRefreshCommand}\`…`
                : terminalRefresh.lines.join("\n")}
            </Text>
          </View>
          <View style={styles.terminalActions}>
            <Text style={styles.cardDetail}>
              {terminalRefresh.status === "running" ? "Running…" : "Done."}
            </Text>
            {terminalRefresh.status === "running" ? (
              <Pressable
                accessibilityLabel={`Stop refreshing ${provider.label} credentials`}
                accessibilityRole="button"
                onPress={terminalRefresh.stop}
              >
                <Text style={styles.cardAction}>Stop</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      )}
      {others.length === 0 ? null : (
        <>
          <View style={styles.cardRule} />
          {others.map((row) => (
            <View key={row.id} style={styles.cardWindow}>
              <View style={styles.cardRow}>
                <Text numberOfLines={1} style={styles.cardDetail}>
                  {row.name}
                </Text>
                <Text style={styles.cardDetail}>{row.readout}</Text>
              </View>
              {row.percentFilled === null ? null : (
                <UsageMeter
                  percentUsed={row.percentUsed ?? 0}
                  percentFilled={row.percentFilled}
                  pacePercent={quotaPacePercent(row.window, now)}
                  style={CARD_METER_STYLE}
                  trackColor={theme.colors.surface0}
                  theme={theme}
                  compact
                />
              )}
            </View>
          ))}
        </>
      )}
      <View style={styles.cardRule} />
      <View style={styles.cardRow}>
        <Text numberOfLines={1} style={styles.cardDetail}>
          {refreshing ? "Refreshing…" : (updated ?? provider.label)}
        </Text>
        <Pressable
          accessibilityLabel={`${provider.label} settings`}
          accessibilityRole="button"
          onPress={openProviderSettings}
          style={styles.cardIconAction}
        >
          <Icon name="Settings2" size={13} color={theme.colors.accent} />
        </Pressable>
      </View>
    </View>
  );
}

const CARD_BUSY = { busy: true, disabled: true };
const CARD_IDLE = { busy: false, disabled: false };
/**
 * How stale a reading has to be before opening a card is worth a vendor call.
 * Anthropic throttles its own quota endpoint after very few requests, so a
 * refresh on every press would spend that budget on numbers that just arrived.
 */
const REFRESH_ON_OPEN_AFTER_MS = 60_000;

/**
 * Forces a vendor read and publishes it to the shared snapshot. Opening the
 * card refreshes on its own when the numbers have aged; the button always
 * refreshes, because a reader who presses it is asking about now.
 */
function useProviderRefresh(fetchedAt: string | null): {
  refreshing: boolean;
  refresh: () => void;
} {
  const readSnapshot = useRpc(readUsageLimits);
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const runRefresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        const snapshot = await readSnapshot({ refresh: true });
        queryClient.setQueryData(USAGE_LIMITS_QUERY_KEY, snapshot);
      } catch (error: unknown) {
        // The last good numbers stay on the card, and the provider's own
        // notice explains why they did not move.
        console.warn("[usage-monitor] refresh failed", error);
      } finally {
        setRefreshing(false);
      }
    })();
  }, [queryClient, readSnapshot]);
  const refresh = useCallback(() => {
    // The host owns the popover, so a press inside the card does not travel
    // through the pill's own trigger; nothing has to be claimed here.
    runRefresh();
  }, [runRefresh]);
  const aged =
    fetchedAt === null || Date.now() - new Date(fetchedAt).getTime() > REFRESH_ON_OPEN_AFTER_MS;
  useEffect(() => {
    if (aged) {
      runRefresh();
    }
    // Runs once per open: the card mounts on press and unmounts on close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { refreshing, refresh };
}

/**
 * Derived rather than imported: `PaseoApi`/`PaseoTerminalHandle` live in
 * `@getpaseo/client`, and the compiler rejects a client bundle that imports
 * that specifier directly — only `usePaseo()`'s own return type is reachable
 * from here.
 */
type TerminalRefreshApi = ReturnType<typeof usePaseo>;
type TerminalHandle = Awaited<ReturnType<TerminalRefreshApi["terminals"]["create"]>>;

/** How often the CLI's own output is re-read while a refresh terminal runs. */
const TERMINAL_REFRESH_POLL_MS = 1_000;
/**
 * Starting the CLI is enough to refresh its token (see docs/CREDENTIALS.md);
 * nothing here waits for it to exit. A fixed ceiling always ends the run, so a
 * CLI that hangs at an interactive prompt this plugin never drives cannot
 * leave a process running unattended.
 */
const TERMINAL_REFRESH_TIMEOUT_MS = 20_000;
/** Compact card, compact tail: the reader watches the CLI start, not its history. */
const TERMINAL_OUTPUT_MAX_LINES = 6;

export type TerminalRefreshStatus = "idle" | "running" | "done";

export interface TerminalRefreshState {
  status: TerminalRefreshStatus;
  lines: string[];
}

export const TERMINAL_REFRESH_IDLE: TerminalRefreshState = { status: "idle", lines: [] };

export type TerminalRefreshEvent =
  | { type: "start" }
  | { type: "output"; lines: string[] }
  | { type: "finish" }
  | { type: "failed"; message: string };

/**
 * The pure state transition, kept apart from the hook so it is testable
 * without rendering: `start` always resets, `output`/`finish` are no-ops once
 * the run has already ended, and `failed` moves straight to `done` carrying
 * the one line that explains why.
 */
export function terminalRefreshReducer(
  state: TerminalRefreshState,
  event: TerminalRefreshEvent,
): TerminalRefreshState {
  switch (event.type) {
    case "start":
      return { status: "running", lines: [] };
    case "output":
      return state.status === "running"
        ? { status: "running", lines: event.lines.slice(-TERMINAL_OUTPUT_MAX_LINES) }
        : state;
    case "finish":
      return state.status === "running" ? { status: "done", lines: state.lines } : state;
    case "failed":
      return { status: "done", lines: [event.message] };
    default:
      return state;
  }
}

/**
 * Runs the CLI that owns a stale credential, visibly, so the reader watches
 * their own tool refresh its own token rather than this plugin guessing at an
 * OAuth flow it does not own — the same trap CodexBar's direct-refresh path
 * fell into by minting a token from a CLI's own refresh token and desyncing
 * it. Only ever runs from an explicit press: never on a poll, never retried
 * automatically, and never sent a keystroke, because starting the CLI is the
 * whole remedy.
 */
function useTerminalRefresh(
  workspaceId: string,
  command: string,
  providerLabel: string,
): {
  status: TerminalRefreshStatus;
  lines: string[];
  start: () => void;
  stop: () => void;
} {
  const paseo = usePaseo();
  const readSnapshot = useRpc(readUsageLimits);
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(terminalRefreshReducer, TERMINAL_REFRESH_IDLE);
  const statusRef = useRef<TerminalRefreshStatus>(state.status);
  statusRef.current = state.status;
  const handleRef = useRef<TerminalHandle | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teardown = useCallback(async () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const handle = handleRef.current;
    handleRef.current = null;
    if (handle === null) return;
    try {
      await handle.kill();
    } catch {
      // Already gone; nothing left to clean up.
    }
  }, []);

  const finish = useCallback(() => {
    void teardown();
    dispatch({ type: "finish" });
    void (async () => {
      try {
        const snapshot = await readSnapshot({ refresh: true });
        queryClient.setQueryData(USAGE_LIMITS_QUERY_KEY, snapshot);
      } catch (error: unknown) {
        console.warn("[usage-monitor] post-terminal-refresh read failed", error);
      }
    })();
  }, [queryClient, readSnapshot, teardown]);

  const start = useCallback(() => {
    if (statusRef.current === "running") {
      return;
    }
    dispatch({ type: "start" });
    void (async () => {
      try {
        const handle = await paseo.terminals.create({
          workspaceId,
          command,
          name: `Refresh ${providerLabel} credentials`,
        });
        handleRef.current = handle;
        pollRef.current = setInterval(() => {
          void (async () => {
            try {
              const result = await handle.capture({ stripAnsi: true });
              dispatch({ type: "output", lines: result.lines });
            } catch {
              // The terminal may have already exited; the timeout settles state.
            }
          })();
        }, TERMINAL_REFRESH_POLL_MS);
        timeoutRef.current = setTimeout(finish, TERMINAL_REFRESH_TIMEOUT_MS);
      } catch (error: unknown) {
        dispatch({
          type: "failed",
          message: `Could not start \`${command}\`: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();
  }, [command, finish, paseo, providerLabel, workspaceId]);

  useEffect(() => () => void teardown(), [teardown]);

  return { status: state.status, lines: state.lines, start, stop: finish };
}

/** The tracked reading's window, so the card's bar can carry a pace marker. */
function trackedReadingWindow(
  provider: UsageProviderSnapshot,
  metrics: PillMetrics | null,
): UsageWindow | null {
  if (metrics === null) {
    return null;
  }
  const reading = provider.readings.find(
    (candidate) => candidate.kind === "quota" && candidate.label === metrics.readingLabel,
  );
  return reading !== undefined && reading.kind === "quota" ? reading.window : null;
}

function trackedReadingId(
  provider: UsageProviderSnapshot,
  metrics: PillMetrics | null,
): string | null {
  if (metrics === null) {
    return null;
  }
  return provider.readings.find((reading) => reading.label === metrics.readingLabel)?.id ?? null;
}

/** "498k / 1m tokens" for the tracked reading, when the vendor states both sides. */
function trackedAmounts(provider: UsageProviderSnapshot, metrics: PillMetrics): string | null {
  const reading = provider.readings.find((candidate) => candidate.label === metrics.readingLabel);
  if (reading === undefined || reading.kind === "rate") {
    return null;
  }
  if (reading.kind === "balance") {
    if (reading.remaining === null) {
      return null;
    }
    const total =
      reading.total === null
        ? null
        : formatUsageAmount(reading.total, reading.unit, reading.currency);
    const left = formatUsageAmount(reading.remaining, reading.unit, reading.currency);
    return total === null ? `${left} left` : `${left} of ${total} left`;
  }
  if (reading.used === null) {
    return reading.remaining === null
      ? null
      : `${formatUsageAmount(reading.remaining, reading.unit)} ${reading.unit} left`;
  }
  const used = formatUsageAmount(reading.used, reading.unit);
  if (reading.limit === null) {
    return `${used} ${reading.unit}`;
  }
  return `${used} / ${formatUsageAmount(reading.limit, reading.unit)} ${reading.unit}`;
}

/**
 * One icon per provider, cached: the host remounts a button when its icon
 * component identity changes, so building a new one on every poll would reset
 * the pill on a one-minute cycle.
 */
const pillIcons = new Map<string, ComponentType<PluginButtonIconProps>>();

export function pillIconFor(providerId: string): ComponentType<PluginButtonIconProps> {
  const existing = pillIcons.get(providerId);
  if (existing !== undefined) {
    return existing;
  }
  function UsagePillIcon({ theme, size }: PluginButtonIconProps) {
    const readSnapshot = useRpc(readUsageLimits);
    // Shares the panel's key, so the rail costs no extra request and both
    // surfaces always agree on the numbers.
    const { data } = useQuery({
      queryKey: USAGE_LIMITS_QUERY_KEY,
      queryFn: () => readSnapshot({ refresh: false }),
      refetchInterval: (query) => limitsPollInterval(query.state.data),
      refetchOnWindowFocus: Platform.OS === "web",
    });
    const provider = findProvider(data?.providers, providerId);
    const settings = provider === null ? null : resolvePillSettings(provider.display);
    const reading =
      provider === null || settings === null
        ? null
        : selectPillReading(provider.readings, settings.reading);
    const metrics = reading === null || settings === null ? null : pillMetrics(reading, settings);
    // The tone carries the provider's own health, so a failed fetch reads as
    // danger whatever the last number said.
    const tone =
      provider?.status === "error"
        ? theme.colors.statusDanger
        : usageTone(metrics?.percentUsed ?? 0, theme);
    const styles = useMemo(() => createPillStyles(theme, tone, size), [theme, tone, size]);
    const mark = {
      icon: provider?.icon ?? null,
      label: provider?.label ?? providerId,
      color: tone,
    };
    /**
     * A provider that has not opted onto the rail, one set to no gauge, or a
     * reading with no ceiling to draw: the mark alone still says which
     * provider the pill belongs to.
     */
    if (
      settings === null ||
      settings.style === "none" ||
      metrics === null ||
      metrics.percentFilled === null
    ) {
      return <PillMark {...mark} styles={styles.mark} />;
    }
    if (settings.style === "ring") {
      return (
        <View style={styles.ring}>
          <UsageMeter
            percentUsed={metrics.percentUsed ?? 0}
            percentFilled={metrics.percentFilled}
            pacePercent={null}
            style={RAIL_METER_STYLE}
            scale="rail"
            trackColor={theme.colors.surface0}
            theme={theme}
            compact
          />
          <View style={styles.ringMarkBox}>
            <PillMark {...mark} styles={styles.ringMark} />
          </View>
        </View>
      );
    }
    return (
      <View style={styles.bar}>
        <PillMark {...mark} styles={styles.barMark} />
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${clampPercent(metrics.percentFilled)}%` }]} />
        </View>
      </View>
    );
  }
  UsagePillIcon.displayName = `UsagePillIcon(${providerId})`;
  pillIcons.set(providerId, UsagePillIcon);
  return UsagePillIcon;
}

/**
 * One card body per provider, cached for the same reason its icon is.
 */
const pillContents = new Map<string, ComponentType<PluginButtonContentProps>>();

export function pillContentFor(providerId: string): ComponentType<PluginButtonContentProps> {
  const existing = pillContents.get(providerId);
  if (existing !== undefined) {
    return existing;
  }
  function UsagePillCard({ theme, workspaceId, close }: PluginButtonContentProps) {
    const readSnapshot = useRpc(readUsageLimits);
    const { data } = useQuery({
      queryKey: USAGE_LIMITS_QUERY_KEY,
      queryFn: () => readSnapshot({ refresh: false }),
      refetchInterval: (query) => limitsPollInterval(query.state.data),
      refetchOnWindowFocus: Platform.OS === "web",
    });
    const provider = findProvider(data?.providers, providerId);
    const settings = provider === null ? null : resolvePillSettings(provider.display);
    const reading =
      provider === null || settings === null
        ? null
        : selectPillReading(provider.readings, settings.reading);
    const metrics = reading === null || settings === null ? null : pillMetrics(reading, settings);
    const tone =
      provider?.status === "error"
        ? theme.colors.statusDanger
        : usageTone(metrics?.percentUsed ?? 0, theme);
    // The card draws no mark, but it shares the stylesheet, and the rail slot
    // is what its mark sizes are stated at.
    const styles = useMemo(() => createPillStyles(theme, tone, MARK_SLOT), [theme, tone]);
    // Nothing to draw before the first snapshot lands, and nothing to draw if
    // the provider has since left it.
    if (provider === null) {
      return null;
    }
    return (
      <PillCard
        provider={provider}
        metrics={metrics}
        styles={styles}
        tone={tone}
        theme={theme}
        workspaceId={workspaceId}
        close={close}
      />
    );
  }
  UsagePillCard.displayName = `UsagePillCard(${providerId})`;
  pillContents.set(providerId, UsagePillCard);
  return UsagePillCard;
}

/**
 * The host renders exactly one text line per pill, so the three things the old
 * two-slot pill drew separately are joined here. The host always renders text —
 * an omitted label falls back to the title — so an empty join falls back to the
 * provider's own name.
 */
function composerPillLabel(
  provider: UsageProviderSnapshot,
  settings: ResolvedPillSettings,
  metrics: PillMetrics | null,
): string {
  const parts: string[] = [];
  if (settings.label === "provider") {
    parts.push(provider.label);
  }
  if (settings.label === "reading" && metrics !== null) {
    parts.push(metrics.readingLabel);
  }
  if (settings.readout === "percent" || settings.readout === "amount") {
    // A stale reading keeps its number: the last good one beats a dash, and
    // the card says why it did not move.
    parts.push(metrics?.readout ?? EM_DASH);
  }
  const joined = parts.filter((part) => part !== "").join(" · ");
  return joined === "" ? provider.label : joined;
}

/** The label for one entry, from the snapshot the poll last published. */
function entryLabel(provider: UsageProviderSnapshot | null, entry: ComposerPillEntry): string {
  if (provider === null) {
    return entry.providerLabel;
  }
  const reading = selectPillReading(provider.readings, entry.settings.reading);
  const metrics = reading === null ? null : pillMetrics(reading, entry.settings);
  return composerPillLabel(provider, entry.settings, metrics);
}

/**
 * A pill's live registration with the host. The handle updates the button in
 * place, so a pill whose text changes keeps its identity and its place on the
 * rail; only a pill that is no longer wanted is removed and re-added.
 */
interface Registration {
  handle: PluginButtonRegistration;
  /** The one contribution field `update` cannot change, so a change here re-registers. */
  workspaceId: string;
  title: string;
  label: string;
}

interface AgentSelection {
  workspaceId: string;
  /** The harness a rule matches on `harness`. */
  provider: string | null;
  /** Qualified `vendor/model` id a rule matches on `provider` and `model`. */
  model: string | null;
}

interface AgentUpsert {
  kind: "upsert";
  agent: {
    id: string;
    workspaceId?: string | null;
    provider?: string | null;
    model?: string | null;
  };
}
interface AgentRemoval {
  kind: "remove";
  agentId: string;
}
type AgentUpdate = AgentUpsert | AgentRemoval;

function registrationKey(agentId: string, providerId: string): string {
  return `${agentId}\u0000${providerId}`;
}

interface WantedPill {
  agentId: string;
  workspaceId: string;
  entry: ComposerPillEntry;
  title: string;
  label: string;
}

/**
 * Pills are per agent, and the host wants one registration per composer, so the
 * live set is the cross product of open agents and the providers whose rules
 * accept that agent's own harness and model. The icon reads the numbers itself;
 * this loop decides which pills exist and what text each one carries.
 */
export function contributeComposerPills(client: PluginClientContext): () => void {
  // A popover's content gets theme, host and layout, and no way to open
  // anything. The client entrypoint is the only place holding that capability,
  // so the card body borrows it from here rather than duplicating navigation.
  clientContext = client;
  const selectionByAgent = new Map<string, AgentSelection>();
  const registrations = new Map<string, Registration>();
  let entries: ComposerPillEntry[] = [];
  let providers: readonly UsageProviderSnapshot[] = [];
  let live = false;
  let stopped = false;

  function sync(): void {
    if (stopped) {
      return;
    }
    const wanted = new Map<string, WantedPill>();
    for (const [agentId, selection] of selectionByAgent) {
      for (const entry of entries) {
        if (!matchesPillSelection(entry.pill, selection)) {
          continue;
        }
        wanted.set(registrationKey(agentId, entry.providerId), {
          agentId,
          workspaceId: selection.workspaceId,
          entry,
          title: `${entry.providerLabel} usage`,
          label: entryLabel(findProvider(providers, entry.providerId), entry),
        });
      }
    }
    for (const [key, registration] of registrations) {
      const target = wanted.get(key);
      // The host copies the workspace once, so a pill that moves pane is a new
      // registration rather than an update; everything else publishes in place.
      if (target === undefined || target.workspaceId !== registration.workspaceId) {
        registration.handle.remove();
        registrations.delete(key);
        continue;
      }
      if (registration.title !== target.title) {
        registration.handle.update({ title: target.title });
        registration.title = target.title;
      }
      if (registration.label !== target.label) {
        registration.handle.update({ label: target.label });
        registration.label = target.label;
      }
    }
    for (const [key, target] of wanted) {
      if (registrations.has(key)) {
        continue;
      }
      const { agentId, workspaceId, entry, title, label } = target;
      const handle = client.addComposerPill({
        id: composerPillId(entry.providerId),
        workspaceId,
        agentId,
        button: {
          title,
          label,
          icon: pillIconFor(entry.providerId),
          // The host anchors, contains, scrolls and dismisses this popover;
          // the card draws its body and nothing around it.
          behavior: { kind: "popover", Content: pillContentFor(entry.providerId) },
        },
      });
      registrations.set(key, { handle, workspaceId, title, label });
    }
  }

  function trackAgent(agent: {
    id: string;
    workspaceId?: string | null;
    provider?: string | null;
    model?: string | null;
  }): boolean {
    const workspaceId = agent.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId === "") {
      return false;
    }
    const selection: AgentSelection = {
      workspaceId,
      provider: agent.provider ?? null,
      model: agent.model ?? null,
    };
    const previous = selectionByAgent.get(agent.id);
    if (
      previous !== undefined &&
      previous.workspaceId === selection.workspaceId &&
      previous.provider === selection.provider &&
      previous.model === selection.model
    ) {
      return false;
    }
    selectionByAgent.set(agent.id, selection);
    return true;
  }

  /**
   * The subscription only reports changes, so a page that opens onto idle
   * agents would see none of them. The list is the starting state the
   * subscription then keeps current.
   */
  async function refresh(): Promise<void> {
    const [snapshot, directory] = await Promise.all([
      client.rpc(readUsageLimits, { refresh: false }),
      client.paseo.agents.list(),
    ]);
    if (stopped) {
      return;
    }
    entries = selectComposerPills(snapshot.providers);
    providers = snapshot.providers;
    live = snapshot.providers.some((provider) => provider.live);
    for (const entry of directory.entries) {
      trackAgent(entry.agent);
    }
    sync();
  }

  function refreshQuietly(): void {
    refresh().catch((error: unknown) => {
      // The rail is ambient: a failed read leaves the pills that already exist
      // showing their last numbers, and the panel reports the error properly.
      console.warn("[usage-monitor] composer pill refresh failed", error);
    });
  }

  const unsubscribe: () => void = client.paseo.agents.subscribe((update: AgentUpdate) => {
    if (update.kind === "remove") {
      if (selectionByAgent.delete(update.agentId)) {
        sync();
      }
      return;
    }
    if (trackAgent(update.agent)) {
      sync();
    }
  });

  refreshQuietly();
  // Re-armed rather than fixed, so a watched file source gets the shorter poll
  // as soon as one appears in the snapshot.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function scheduleRefresh(): void {
    timer = setTimeout(
      () => {
        refreshQuietly();
        scheduleRefresh();
      },
      live ? LIVE_LIMITS_POLL_MS : LIMITS_POLL_MS,
    );
  }
  scheduleRefresh();

  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    for (const registration of registrations.values()) {
      registration.handle.remove();
    }
    registrations.clear();
  };
}

/**
 * The client entrypoint is the only place holding navigation, so the card
 * borrows it from here to reach the settings surface.
 */
let clientContext: PluginClientContext | null = null;
