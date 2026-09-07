import {
  Icon,
  type PluginClientContext,
  type PluginComposerPillProps,
  useRpc,
} from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { type ComponentType, useCallback, useMemo, useSyncExternalStore } from "react";
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
import {
  EM_DASH,
  formatUpdatedLabel,
  formatWhenHint,
  isShowingStaleReadings,
  LIMITS_POLL_MS,
  USAGE_LIMITS_QUERY_KEY,
  useTickingClock,
} from "./limits.client";
import { readUsageLimits, type UsageIcon, type UsageProviderSnapshot } from "./limits.shared";
import { UsageMeter, usageTone } from "./meter.client";
import {
  composerPillId,
  type ComposerPillEntry,
  type PillMetrics,
  pillMetrics,
  type ResolvedPillSettings,
  resolvePillSettings,
  selectComposerPills,
  selectPillReading,
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

interface PillStyles {
  label: TextStyle;
  readout: TextStyle;
  stale: TextStyle;
  bar: ViewStyle;
  mark: ViewStyle;
  markText: TextStyle;
  markImage: ImageStyle;
  card: ViewStyle;
  cardTitle: TextStyle;
  cardHeadline: TextStyle;
  cardDetail: TextStyle;
  cardRow: ViewStyle;
  cardRule: ViewStyle;
  cardAction: TextStyle;
}

function createPillStyles(theme: PluginComposerPillProps["theme"], plate: string): PillStyles {
  const muted = theme.colors.foregroundMuted;
  const foreground = theme.colors.foreground;
  return {
    label: { fontSize: 12, color: muted, flexShrink: 1 },
    readout: { fontSize: 12, color: foreground, fontVariant: ["tabular-nums"] },
    // A stale number is still the best number available, so it dims rather
    // than disappears.
    stale: { fontSize: 12, color: muted, fontVariant: ["tabular-nums"] },
    bar: { width: RAIL_BAR_WIDTH },
    mark: {
      width: MARK_SIZE,
      height: MARK_SIZE,
      borderRadius: 4,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: plate,
    },
    markText: { fontSize: 8, fontWeight: "600", color: foreground },
    markImage: { width: MARK_SIZE, height: MARK_SIZE, borderRadius: 4 },
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
      minWidth: 196,
      maxWidth: 300,
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
    cardRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
    cardRule: {
      height: 1,
      marginVertical: 6,
      backgroundColor: theme.colors.border,
    },
    cardAction: { fontSize: 12, color: theme.colors.accent },
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
 */
let openPillId: string | null = null;
const openPillListeners = new Set<() => void>();

function toggleOpenPill(providerId: string): void {
  openPillId = openPillId === providerId ? null : providerId;
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
 * Every other window the provider publishes, one line each. A quota reads as
 * consumption because that is what runs out; a balance reads as what is left,
 * because "75% used" of a credit account buries the number that matters.
 */
function summaryLines(provider: UsageProviderSnapshot, skipReadingId: string | null): string[] {
  const lines: string[] = [];
  for (const reading of provider.readings) {
    if (reading.id === skipReadingId || reading.kind === "rate") {
      continue;
    }
    const settings = reading.kind === "balance" ? BALANCE_LINE_SETTINGS : QUOTA_LINE_SETTINGS;
    const metrics = pillMetrics(reading, settings);
    if (metrics.readout === null) {
      continue;
    }
    const name = metrics.windowLabel ?? reading.label;
    if (reading.kind === "balance") {
      lines.push(`${name} · ${metrics.readout} left`);
      continue;
    }
    lines.push(
      metrics.percentUsed === null
        ? `${name} · ${metrics.readout}`
        : `${name} · ${metrics.readout} used`,
    );
  }
  return lines;
}

const QUOTA_LINE_SETTINGS: ResolvedPillSettings = {
  order: null,
  style: "bar",
  value: "used",
  reading: null,
  label: "none",
  readout: "percent",
};

const BALANCE_LINE_SETTINGS: ResolvedPillSettings = {
  ...QUOTA_LINE_SETTINGS,
  value: "remaining",
  readout: "amount",
};

/**
 * The card a pill opens: the tracked reading in full, then one line per other
 * window so a weekly allowance is one glance away from a session figure.
 */
function PillCard({
  provider,
  metrics,
  styles,
  tone,
}: {
  provider: UsageProviderSnapshot;
  metrics: PillMetrics | null;
  styles: PillStyles;
  tone: string;
}) {
  const now = useTickingClock();
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
    () => summaryLines(provider, trackedReadingId(provider, metrics)),
    [metrics, provider],
  );
  const headlineStyle = useMemo(() => [styles.cardHeadline, { color: tone }], [styles, tone]);
  // Closing the card is the host press firing alongside this one, which is the
  // wanted order: the card gets out of the way and settings takes over.
  const openSettingsSurface = useCallback(() => {
    clientContext?.openSurface(SETTINGS_SURFACE_ID);
  }, []);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>
        {metrics?.windowLabel === null || metrics === null
          ? provider.label
          : `${provider.label} · ${metrics.windowLabel}`}
      </Text>
      {headline === null ? null : <Text style={headlineStyle}>{headline}</Text>}
      {amounts === null ? null : <Text style={styles.cardDetail}>{amounts}</Text>}
      {resets === null ? null : <Text style={styles.cardDetail}>{resets}</Text>}
      {provider.notice === null ? null : <Text style={styles.cardDetail}>{provider.notice}</Text>}
      {provider.error === null ? null : <Text style={styles.cardDetail}>{provider.error}</Text>}
      {others.length === 0 ? null : (
        <>
          <View style={styles.cardRule} />
          {others.map((line) => (
            <Text key={line} style={styles.cardDetail}>
              {line}
            </Text>
          ))}
        </>
      )}
      <View style={styles.cardRule} />
      <View style={styles.cardRow}>
        <Text style={styles.cardDetail}>{updated ?? provider.label}</Text>
        <Pressable accessibilityRole="button" onPress={openSettingsSurface}>
          <Text style={styles.cardAction}>Settings</Text>
        </Pressable>
      </View>
    </View>
  );
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
          <View style={settings.style === "bar" ? styles.bar : undefined}>
            <UsageMeter
              percentUsed={metrics.percentUsed ?? 0}
              percentFilled={metrics.percentFilled ?? 0}
              pacePercent={null}
              style={settings.style === "ring" ? "ring" : "bar"}
              scale="rail"
              theme={theme}
              compact
            />
          </View>
        ) : null}
        {settings?.readout === "none" ? null : (
          <Text style={stale ? styles.stale : styles.readout}>{metrics?.readout ?? EM_DASH}</Text>
        )}
        {opened === providerId && provider !== null ? (
          <PillCard provider={provider} metrics={metrics} styles={styles} tone={tone} />
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
