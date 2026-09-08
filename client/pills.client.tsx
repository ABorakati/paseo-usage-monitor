import {
  type PluginClientContext,
  type PluginComposerPillProps,
  useRpc,
  usePaseo,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
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
  LIMITS_POLL_MS,
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
import { UsageMeter, usageTone } from "./meter.client";
import {
  composerPillId,
  type ComposerPillEntry,
  matchesPillSelection,
  type PillMetrics,
  pillMetrics,
  resolvePillSettings,
  selectComposerPills,
  selectPillReading,
  usageWindowRows,
} from "../shared/pills.shared";

/**
 * Usage on the composer rail, and the card a pill opens above itself. The host
 * owns the pressable, the pill chrome and the pending state, so a component
 * here draws the inside of one pill and nothing else. Every rule about which
 * reading a pill tracks lives in `pills.shared.ts`.
 *
 * The card is an absolutely-positioned child of the pill rather than a
 * portalled popover: the host's anchored menu belongs to the app, and a plugin
 * only gets to draw inside its own pill. The rail sets no `overflow`, so the
 * card clears the pill and floats over the transcript.
 */

const SETTINGS_SURFACE_ID = "settings";
/** Big enough to read as a gauge, small enough to leave the label room. */
const RAIL_BAR_WIDTH = 34;
const MARK_SIZE = 14;
/**
 * Clears the 32px pill and leaves the same 12px gap the host's own anchored
 * panels leave above a rail pill.
 */
const CARD_LIFT = 44;
/**
 * Fixed rather than a min/max pair: the card is absolute, so a flexible width
 * would size itself to the pill it hangs off and jump about between providers.
 */
const CARD_WIDTH = 232;
/** The card is wide enough for a bar, and a bar states progress plainly. */
const CARD_METER_STYLE = "bar" as const;
/**
 * How far the dismiss catcher reaches beyond the pill. Larger than any pane the
 * composer sits in, so a press outside the card always lands on it.
 */
const CATCHER_REACH = 4000;
/** Chat pane width below which the pill collapses to just its mark icon. */
const NARROW_PANE_WIDTH = 540;

function findPaneElement(node: HTMLElement | null): HTMLElement | null {
  if (!node) {
    return null;
  }
  return (
    node.closest?.('[data-testid^="workspace-pane-"], [data-testid="workspace-side-panel"]') ??
    node.parentElement?.parentElement?.parentElement ??
    null
  );
}

export function pillInstanceKey(agentId: string | undefined | null, providerId: string): string {
  return agentId ? `${agentId}\u0000${providerId}` : providerId;
}
export interface CardPlacement {
  left: number;
  maxWidth: number;
}

export function computeCardPlacement(input: {
  pillLeft: number;
  paneLeft: number;
  paneRight: number;
  cardWidth?: number;
  paneMargin?: number;
}): CardPlacement {
  const cardWidth = input.cardWidth ?? CARD_WIDTH;
  const margin = input.paneMargin ?? 8;
  const paneWidth = Math.max(0, input.paneRight - input.paneLeft);
  const maxWidth = Math.min(cardWidth, Math.max(160, paneWidth - margin * 2));
  const maxAllowedRight = input.paneRight - margin;
  const overflowRight = input.pillLeft + maxWidth - maxAllowedRight;
  let left = 0;
  if (overflowRight > 0) {
    left = -overflowRight;
  }
  const minAllowedLeft = input.paneLeft + margin;
  const minLeft = minAllowedLeft - input.pillLeft;
  left = Math.max(minLeft, left);
  return { left, maxWidth };
}

interface PillStyles {
  label: TextStyle;
  readout: TextStyle;
  stale: TextStyle;
  bar: ViewStyle;
  gauge: ViewStyle;
  mark: ViewStyle;
  markText: TextStyle;
  markImage: ImageStyle;
  card: ViewStyle;
  cardTitle: TextStyle;
  cardHeadline: TextStyle;
  cardDetail: TextStyle;
  cardMeter: ViewStyle;
  cardRefresh: ViewStyle;
  cardWindow: ViewStyle;
  cardCatcher: ViewStyle;
  cardIconAction: ViewStyle;
  cardRow: ViewStyle;
  cardRule: ViewStyle;
  cardAction: TextStyle;
  terminalOutput: ViewStyle;
  terminalLine: TextStyle;
  terminalActions: ViewStyle;
  pillContent: ViewStyle;
}

function createPillStyles(theme: PluginComposerPillProps["theme"], plate: string): PillStyles {
  const muted = theme.colors.foregroundMuted;
  const foreground = theme.colors.foreground;
  /**
   * The rail hands each pill a shrinking box and clips nothing, so anything
   * that cannot shrink spills out of its own pill on a narrow pane. The text
   * gives way first and truncates; the mark and the gauge hold their size,
   * because a half-drawn gauge is worse than a shortened word.
   */
  const shrinkable: TextStyle = { flexShrink: 1, minWidth: 0 };
  const fixed: ViewStyle = { flexShrink: 0, flexGrow: 0 };
  return {
    label: { fontSize: 12, color: muted, ...shrinkable },
    readout: { fontSize: 12, color: foreground, fontVariant: ["tabular-nums"], ...shrinkable },
    // A stale number is still the best number available, so it dims rather
    // than disappears.
    stale: {
      fontSize: 12,
      color: muted,
      fontVariant: ["tabular-nums"],
      ...shrinkable,
    },
    pillContent: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexShrink: 1,
      minWidth: 0,
    },
    bar: { ...fixed, width: RAIL_BAR_WIDTH },
    gauge: fixed,
    mark: {
      ...fixed,
      width: MARK_SIZE,
      height: MARK_SIZE,
      borderRadius: 4,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: plate,
    },
    markText: { fontSize: 8, fontWeight: "600", color: foreground },
    markImage: { width: MARK_SIZE, height: MARK_SIZE, borderRadius: 4, flexShrink: 0 },
    /**
     * Anchored to the pill rather than portalled: the host's own anchored menu
     * belongs to the app, and a plugin only gets to draw inside its pill. The
     * rail sets no `overflow`, so an absolute child clears the pill and floats
     * over the transcript.
     */
    card: {
      position: "absolute",
      bottom: CARD_LIFT,
      left: 0,
      width: CARD_WIDTH,
      gap: 2,
      padding: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      zIndex: 40,
      elevation: 8,
      shadowColor: "#000000",
      shadowOpacity: 0.35,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
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
    /**
     * Reaches far past the rail in every direction so a press anywhere outside
     * the card lands on it. Transparent, and below the card's own z-index.
     */
    cardCatcher: {
      position: "absolute",
      left: -CATCHER_REACH,
      right: -CATCHER_REACH,
      top: -CATCHER_REACH,
      bottom: -CATCHER_REACH,
      zIndex: 39,
    },
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
     * The live capture of the CLI the reader launched. Fixed height rather than
     * flowing with output length, so a chatty CLI never grows the card past the
     * rail it hangs off; the tail is what matters, and it stays pinned in view.
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
 * a 32px pill has no use for.
 */
function PillMark({
  icon,
  label,
  styles,
  color,
}: {
  icon: UsageIcon | null;
  label: string;
  styles: PillStyles;
  color: string;
}) {
  if (icon?.kind === "image") {
    return (
      <Image
        accessibilityIgnoresInvertColors
        source={imageSource(icon.uri)}
        style={styles.markImage}
      />
    );
  }
  if (icon?.kind === "lucide") {
    return <Icon name={icon.name} size={MARK_SIZE} color={color} />;
  }
  const text = icon?.kind === "monogram" ? icon.text : label;
  return (
    <View style={styles.mark}>
      <Text style={styles.markText}>{text.slice(0, 2).toUpperCase()}</Text>
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
 * Which pill has its card open. One at a time and module-level, because every
 * pill is its own React tree and opening one has to close the last.
 *
 * A control inside the card is a child of the host's own pressable, and a
 * plugin cannot stop that press from reaching it, so a press on the dismiss
 * catcher or on Refresh would otherwise be undone by the host toggling right
 * after. Those presses claim the next toggle instead, which makes the outcome
 * the same whichever handler runs first.
 */
let openPillId: string | null = null;
let toggleClaimedUntil = 0;
const openPillListeners = new Set<() => void>();
/** Covers the host's press landing, short enough to never strand a pill. */
const TOGGLE_CLAIM_MS = 350;

export function claimNextToggle(): void {
  toggleClaimedUntil = Date.now() + TOGGLE_CLAIM_MS;
}

export function resetToggleClaim(): void {
  toggleClaimedUntil = 0;
}

export function toggleOpenPill(instanceKey: string): void {
  if (Date.now() < toggleClaimedUntil) {
    toggleClaimedUntil = 0;
    return;
  }
  openPillId = openPillId === instanceKey ? null : instanceKey;
  for (const listener of openPillListeners) listener();
}

export function closeOpenPill(claimToggle = true): void {
  if (claimToggle) {
    claimNextToggle();
  }
  if (openPillId === null) {
    return;
  }
  openPillId = null;
  for (const listener of openPillListeners) listener();
}

function subscribeOpenPill(listener: () => void): () => void {
  openPillListeners.add(listener);
  return () => {
    openPillListeners.delete(listener);
  };
}

export function readOpenPill(): string | null {
  return openPillId;
}
/**
 * The card a pill opens: the tracked reading in full, then one row per other
 * window so a weekly allowance is one glance away from a session figure.
 */
function PillCard({
  provider,
  metrics,
  styles,
  tone,
  theme,
  anchorRef,
  workspaceId,
}: {
  provider: UsageProviderSnapshot;
  metrics: PillMetrics | null;
  styles: PillStyles;
  tone: string;
  theme: PluginComposerPillProps["theme"];
  anchorRef?: { current: View | null };
  workspaceId: string;
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
   * Opens this provider's own editor. Closing the card is the host press
   * firing alongside this one, which is the wanted order: the card gets out of
   * the way and the settings screen takes over.
   */
  const openProviderSettings = useCallback(() => {
    requestProviderEditor(provider.providerId);
    clientContext?.openSurface(SETTINGS_SURFACE_ID);
  }, [provider.providerId]);
  const closeCard = useCallback(() => {
    closeOpenPill();
  }, []);
  const cardRef = useRef<View | null>(null);
  const [cardOffset, setCardOffset] = useState<{ left: number; maxWidth: number }>({
    left: 0,
    maxWidth: CARD_WIDTH,
  });

  const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

  useIsomorphicLayoutEffect(() => {
    const el = anchorRef?.current as unknown as HTMLElement | null;
    if (!el || typeof document === "undefined") {
      return;
    }
    const pane = findPaneElement(el);
    const updateOffset = () => {
      const paneRect = pane?.getBoundingClientRect?.();
      const pillRect = el.getBoundingClientRect?.();
      if (!paneRect || !pillRect) {
        return;
      }
      setCardOffset(
        computeCardPlacement({
          pillLeft: pillRect.left,
          paneLeft: paneRect.left,
          paneRight: paneRect.right,
        }),
      );
    };
    updateOffset();
    if (typeof ResizeObserver !== "undefined" && pane) {
      const observer = new ResizeObserver(updateOffset);
      observer.observe(pane);
      return () => {
        observer.disconnect();
      };
    }
  }, [anchorRef]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const cardEl = cardRef.current as unknown as HTMLElement | null;
      if (cardEl && !cardEl.contains(e.target as Node)) {
        closeCard();
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [closeCard]);

  const cardStyle = useMemo<ViewStyle[]>(
    () => [
      styles.card,
      {
        left: cardOffset.left,
        width: Math.min(CARD_WIDTH, cardOffset.maxWidth),
      },
    ],
    [styles.card, cardOffset],
  );

  return (
    <>
      {/*
       * Dismisses on a press anywhere else. A plugin cannot reach the host's
       * overlay host, so the catcher is a child of the pill stretched well past
       * the composer. It sits under the card and above everything else, which
       * is what makes the first click outside close rather than act.
       */}
      <Pressable
        accessibilityLabel={`Close ${provider.label} usage`}
        accessibilityRole="button"
        onPress={closeCard}
        style={styles.cardCatcher}
      />
      <View ref={cardRef} style={cardStyle}>
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
        <CodexBankedResetAction
          provider={provider}
          theme={theme}
          compact
          beforeAction={claimNextToggle}
        />
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
    </>
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
    // Only a pressed refresh claims the toggle: the press reaches the host's
    // pressable too and would close the card the reader is watching. The
    // automatic one runs from an effect, where no press is in flight, and
    // claiming there would swallow the reader's next press instead.
    claimNextToggle();
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
 * One component per provider, cached: the host remounts a pill when its
 * component identity changes, so building a new one on every poll would reset
 * the pill on a one-minute cycle.
 */
const pillComponents = new Map<string, ComponentType<PluginComposerPillProps>>();

export function pillComponentFor(providerId: string): ComponentType<PluginComposerPillProps> {
  const existing = pillComponents.get(providerId);
  if (existing !== undefined) {
    return existing;
  }
  function UsagePillContent({ theme, agentId, layout, workspaceId }: PluginComposerPillProps) {
    const readSnapshot = useRpc(readUsageLimits);
    // Shares the panel's key, so the rail costs no extra request and both
    // surfaces always agree on the numbers.
    const { data } = useQuery({
      queryKey: USAGE_LIMITS_QUERY_KEY,
      queryFn: () => readSnapshot({ refresh: false }),
      refetchInterval: LIMITS_POLL_MS,
      refetchOnWindowFocus: Platform.OS === "web",
    });
    const provider = findProvider(data?.providers, providerId);
    const settings = provider === null ? null : resolvePillSettings(provider.display);
    const reading =
      provider === null || settings === null
        ? null
        : selectPillReading(provider.readings, settings.reading);
    const metrics = reading === null || settings === null ? null : pillMetrics(reading, settings);
    const failed = provider?.status === "error";
    const stale = provider?.notice !== null && provider?.notice !== undefined;
    const tone = failed ? theme.colors.statusDanger : usageTone(metrics?.percentUsed ?? 0, theme);
    const styles = useMemo(() => createPillStyles(theme, tone), [theme, tone]);
    const opened = useSyncExternalStore(subscribeOpenPill, readOpenPill, readOpenPill);
    const pillKey = pillInstanceKey(agentId, providerId);
    const containerRef = useRef<View | null>(null);
    const [paneWidth, setPaneWidth] = useState<number | null>(null);

    const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

    useIsomorphicLayoutEffect(() => {
      const el = containerRef.current as unknown as HTMLElement | null;
      if (!el || typeof document === "undefined") {
        return;
      }
      const pane = findPaneElement(el);
      if (!pane) {
        return;
      }
      const updateWidth = () => {
        const rect = pane.getBoundingClientRect?.();
        if (rect && Number.isFinite(rect.width) && rect.width > 0) {
          setPaneWidth(rect.width);
        }
      };
      updateWidth();
      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (entry.contentRect.width > 0) {
              setPaneWidth(entry.contentRect.width);
            }
          }
        });
        observer.observe(pane);
        return () => {
          observer.disconnect();
        };
      }
    }, []);

    const isNarrow = Boolean(
      layout?.compact || (paneWidth !== null && paneWidth < NARROW_PANE_WIDTH),
    );
    const labelText = resolveLabel(settings?.label ?? "none", provider, metrics?.readingLabel);
    const showGauge =
      !isNarrow &&
      settings !== null &&
      settings.style !== "none" &&
      metrics?.percentFilled !== null;
    return (
      <View ref={containerRef} style={styles.pillContent}>
        <PillMark
          icon={provider?.icon ?? null}
          label={provider?.label ?? providerId}
          styles={styles}
          color={tone}
        />
        {!isNarrow && labelText !== null ? (
          <Text numberOfLines={1} style={styles.label}>
            {labelText}
          </Text>
        ) : null}
        {showGauge && metrics !== null && settings !== null ? (
          <View style={settings.style === "bar" ? styles.bar : styles.gauge}>
            <UsageMeter
              percentUsed={metrics.percentUsed ?? 0}
              percentFilled={metrics.percentFilled ?? 0}
              pacePercent={null}
              style={settings.style === "ring" ? "ring" : "bar"}
              scale="rail"
              // The host paints the pill `surface2` while hovered, which is the
              // meter's own default track, so the empty part of the gauge
              // vanished under the cursor.
              trackColor={theme.colors.surface0}
              theme={theme}
              compact
            />
          </View>
        ) : null}
        {!isNarrow && settings?.readout !== "none" ? (
          <Text style={stale ? styles.stale : styles.readout}>{metrics?.readout ?? EM_DASH}</Text>
        ) : null}
        {opened === pillKey && provider !== null ? (
          <PillCard
            provider={provider}
            metrics={metrics}
            styles={styles}
            tone={tone}
            theme={theme}
            anchorRef={containerRef}
            workspaceId={workspaceId}
          />
        ) : null}
      </View>
    );
  }
  UsagePillContent.displayName = `UsagePillContent(${providerId})`;
  pillComponents.set(providerId, UsagePillContent);
  return UsagePillContent;
}

function resolveLabel(
  mode: "provider" | "reading" | "none",
  provider: UsageProviderSnapshot | null,
  readingLabel: string | undefined,
): string | null {
  if (mode === "none") {
    return null;
  }
  if (mode === "reading") {
    return readingLabel ?? provider?.label ?? null;
  }
  return provider?.label ?? null;
}

/**
 * The host copies a contribution's fields once, so a pill re-registers only
 * when one of them changes. The selection a rule reads is part of that: an
 * agent that switches model must lose the pills that no longer match it.
 */
interface Registration {
  remove: () => void;
  signature: string;
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
  /** Only the fields the host copies; a change here forces re-registration. */
  signature: string;
}

/**
 * Pills are per agent, and the host wants one registration per composer, so the
 * live set is the cross product of open agents and the providers whose rules
 * accept that agent's own harness and model. The component reads the numbers
 * itself; this loop only decides which pills exist.
 */
export function contributeComposerPills(client: PluginClientContext): () => void {
  // A panel component gets theme, host and layout, and no way to open anything.
  // The client entrypoint is the only place holding that capability, so the
  // detail panel borrows it from here rather than duplicating navigation.
  clientContext = client;
  const selectionByAgent = new Map<string, AgentSelection>();
  const registrations = new Map<string, Registration>();
  let entries: ComposerPillEntry[] = [];
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
          signature: JSON.stringify([selection.workspaceId, entry.providerLabel]),
        });
      }
    }
    for (const [key, registration] of registrations) {
      const target = wanted.get(key);
      if (target !== undefined && target.signature === registration.signature) {
        continue;
      }
      registration.remove();
      registrations.delete(key);
    }
    for (const [key, target] of wanted) {
      if (registrations.has(key)) {
        continue;
      }
      const { agentId, workspaceId, entry } = target;
      const remove = client.addComposerPill({
        id: composerPillId(entry.providerId),
        title: `${entry.providerLabel} usage`,
        workspaceId,
        agentId,
        Component: pillComponentFor(entry.providerId),
        onPress() {
          // The card opens in place, anchored to the pill. A second press closes
          // it, and opening another pill's card closes this one.
          toggleOpenPill(pillInstanceKey(agentId, entry.providerId));
        },
      });
      registrations.set(key, { remove, signature: target.signature });
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
  const timer = setInterval(refreshQuietly, LIMITS_POLL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    for (const registration of registrations.values()) {
      registration.remove();
    }
    registrations.clear();
  };
}

/**
 * The client entrypoint is the only place holding navigation, so the card
 * borrows it from here to reach the settings surface.
 */
let clientContext: PluginClientContext | null = null;
