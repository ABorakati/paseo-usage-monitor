import {
  Icon,
  type PluginClientContext,
  type PluginComposerPillProps,
  useRpc,
} from "@getpaseo/plugin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
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
import { formatUsageAmount } from "./amount.shared";
import { requestProviderEditor } from "./editor-request.client";
import {
  EM_DASH,
  formatUpdatedLabel,
  formatWhenHint,
  isShowingStaleReadings,
  LIMITS_POLL_MS,
  quotaPacePercent,
  USAGE_LIMITS_QUERY_KEY,
  useTickingClock,
} from "./limits.client";
import {
  readUsageLimits,
  type UsageIcon,
  type UsageProviderSnapshot,
  type UsageWindow,
} from "./limits.shared";
import { UsageMeter, usageTone } from "./meter.client";
import {
  composerPillId,
  type ComposerPillEntry,
  type PillMetrics,
  pillMetrics,
  resolvePillSettings,
  selectComposerPills,
  selectPillReading,
  usageWindowRows,
} from "./pills.shared";

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

function claimNextToggle(): void {
  toggleClaimedUntil = Date.now() + TOGGLE_CLAIM_MS;
}

function toggleOpenPill(providerId: string): void {
  if (Date.now() < toggleClaimedUntil) {
    toggleClaimedUntil = 0;
    return;
  }
  openPillId = openPillId === providerId ? null : providerId;
  for (const listener of openPillListeners) listener();
}

function closeOpenPill(): void {
  claimNextToggle();
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

function readOpenPill(): string | null {
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
}: {
  provider: UsageProviderSnapshot;
  metrics: PillMetrics | null;
  styles: PillStyles;
  tone: string;
  theme: PluginComposerPillProps["theme"];
}) {
  const now = useTickingClock();
  const { refreshing, refresh } = useProviderRefresh(provider.fetchedAt);
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
      <View style={styles.card}>
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
  function UsagePillContent({ theme }: PluginComposerPillProps) {
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
    const labelText = resolveLabel(settings?.label ?? "none", provider, metrics?.readingLabel);
    const showGauge =
      settings !== null && settings.style !== "none" && metrics?.percentFilled !== null;
    return (
      <>
        <PillMark
          icon={provider?.icon ?? null}
          label={provider?.label ?? providerId}
          styles={styles}
          color={tone}
        />
        {labelText === null ? null : (
          <Text numberOfLines={1} style={styles.label}>
            {labelText}
          </Text>
        )}
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
        {settings?.readout === "none" ? null : (
          <Text style={stale ? styles.stale : styles.readout}>{metrics?.readout ?? EM_DASH}</Text>
        )}
        {opened === providerId && provider !== null ? (
          <PillCard
            provider={provider}
            metrics={metrics}
            styles={styles}
            tone={tone}
            theme={theme}
          />
        ) : null}
      </>
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

interface AgentUpsert {
  kind: "upsert";
  agent: { id: string; workspaceId?: string | null };
}
interface AgentRemoval {
  kind: "remove";
  agentId: string;
}
type AgentUpdate = AgentUpsert | AgentRemoval;

function registrationKey(workspaceId: string, agentId: string, providerId: string): string {
  return `${workspaceId}\u0000${agentId}\u0000${providerId}`;
}

interface Registration {
  remove: () => void;
  /** Re-registers only when something the host copies changes. */
  signature: string;
}

/**
 * Pills are per agent, and the host wants one registration per composer, so the
 * live set is the cross product of open agents and opted-in providers. The
 * component reads the numbers itself; this loop only decides which pills exist.
 */
export function contributeComposerPills(client: PluginClientContext): () => void {
  // A panel component gets theme, host and layout, and no way to open anything.
  // The client entrypoint is the only place holding that capability, so the
  // detail panel borrows it from here rather than duplicating navigation.
  clientContext = client;
  const workspaceByAgent = new Map<string, string>();
  const registrations = new Map<string, Registration>();
  let entries: ComposerPillEntry[] = [];
  let stopped = false;

  function sync(): void {
    if (stopped) {
      return;
    }
    const wanted = new Map<
      string,
      { workspaceId: string; agentId: string; entry: ComposerPillEntry }
    >();
    for (const [agentId, workspaceId] of workspaceByAgent) {
      for (const entry of entries) {
        wanted.set(registrationKey(workspaceId, agentId, entry.providerId), {
          workspaceId,
          agentId,
          entry,
        });
      }
    }
    for (const [key, registration] of registrations) {
      const target = wanted.get(key);
      if (target !== undefined && target.entry.providerLabel === registration.signature) {
        continue;
      }
      registration.remove();
      registrations.delete(key);
    }
    for (const [key, target] of wanted) {
      if (registrations.has(key)) {
        continue;
      }
      const { workspaceId, agentId, entry } = target;
      const remove = client.addComposerPill({
        id: composerPillId(entry.providerId),
        title: `${entry.providerLabel} usage`,
        workspaceId,
        agentId,
        Component: pillComponentFor(entry.providerId),
        onPress() {
          // The card opens in place, anchored to the pill. A second press closes
          // it, and opening another pill's card closes this one.
          toggleOpenPill(entry.providerId);
        },
      });
      registrations.set(key, { remove, signature: entry.providerLabel });
    }
  }

  async function refresh(): Promise<void> {
    const snapshot = await client.rpc(readUsageLimits, { refresh: false });
    if (stopped) {
      return;
    }
    entries = selectComposerPills(snapshot.providers);
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
      if (workspaceByAgent.delete(update.agentId)) {
        sync();
      }
      return;
    }
    const workspaceId = update.agent.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId === "") {
      return;
    }
    if (workspaceByAgent.get(update.agent.id) === workspaceId) {
      return;
    }
    workspaceByAgent.set(update.agent.id, workspaceId);
    sync();
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
