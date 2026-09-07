import {
  Icon,
  type PluginClientContext,
  type PluginComposerPillProps,
  type PluginWorkspacePanelProps,
  useRpc,
} from "@getpaseo/plugin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ComponentType, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  Image,
  type ImageStyle,
  Platform,
  Pressable,
  ScrollView,
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
  groupReadings,
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
  type UsageReading,
} from "./limits.shared";
import { UsageMeter, usageTone } from "./meter.client";
import {
  composerPillId,
  type ComposerPillEntry,
  pillMetrics,
  resolvePillSettings,
  selectComposerPills,
  selectPillReading,
} from "./pills.shared";

/**
 * Usage on the composer rail, and the panel a pill opens. The host owns the
 * pressable, the pill chrome and the pending state, so the pill component here
 * draws the inside of one pill and nothing else. Every rule about which reading
 * a pill tracks lives in `pills.shared.ts`.
 *
 * The detail panel is a panel rather than a floating popover because a plugin
 * gets a plain `onPress` with no anchor to hang one from. It answers what a
 * single glance cannot: every window the provider publishes, what each one
 * resets at, and how stale the numbers are.
 */

const DETAIL_PANEL_ID = "pill";
const DASHBOARD_SURFACE_ID = "limits";
const SETTINGS_SURFACE_ID = "settings";
/** Big enough to read as a gauge, small enough to leave the label room. */
const RAIL_BAR_WIDTH = 34;
const MARK_SIZE = 14;
/** The detail rows are wide, so every gauge there reads left to right. */
const DETAIL_METER_STYLE = "bar" as const;

interface PillStyles {
  label: TextStyle;
  readout: TextStyle;
  stale: TextStyle;
  bar: ViewStyle;
  mark: ViewStyle;
  markText: TextStyle;
  markImage: ImageStyle;
}

function createPillStyles(muted: string, foreground: string, plate: string): PillStyles {
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
    const styles = useMemo(
      () => createPillStyles(theme.colors.foregroundMuted, theme.colors.foreground, tone),
      [theme.colors.foregroundMuted, theme.colors.foreground, tone],
    );
    const labelText = resolveLabel(settings?.label ?? "provider", provider, metrics?.readingLabel);
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
          // The panel reads the focused provider from the store, so the same
          // panel serves every pill and an already-open one retargets.
          focusProvider(entry.providerId);
          client.openPanel(DETAIL_PANEL_ID, { workspaceId, agentId, location: "explorer" });
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
 * Which provider the detail panel is showing. Module state rather than panel
 * state: the pill that opens the panel is a different React tree, and pressing
 * a second pill has to retarget a panel that is already open.
 */
let focusedProviderId: string | null = null;
const focusListeners = new Set<() => void>();
let clientContext: PluginClientContext | null = null;

function focusProvider(providerId: string): void {
  if (focusedProviderId === providerId) {
    return;
  }
  focusedProviderId = providerId;
  for (const listener of focusListeners) listener();
}

function subscribeFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

function readFocus(): string | null {
  return focusedProviderId;
}

interface DetailStyles {
  screen: ViewStyle;
  body: ViewStyle;
  header: ViewStyle;
  identity: ViewStyle;
  title: TextStyle;
  subtitle: TextStyle;
  notice: TextStyle;
  error: TextStyle;
  group: ViewStyle;
  groupLabel: TextStyle;
  row: ViewStyle;
  rowHeader: ViewStyle;
  rowLabel: TextStyle;
  rowValue: TextStyle;
  hint: TextStyle;
  actions: ViewStyle;
  action: ViewStyle;
  actionText: TextStyle;
  empty: TextStyle;
}

function createDetailStyles(theme: PluginComposerPillProps["theme"]): DetailStyles {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    body: { padding: 12, gap: 12 },
    header: { flexDirection: "row", alignItems: "center", gap: 8 },
    identity: { flex: 1, gap: 2 },
    title: { fontSize: 14, fontWeight: "600", color: theme.colors.foreground },
    subtitle: { fontSize: 11, color: theme.colors.foregroundMuted },
    notice: { fontSize: 11, color: theme.colors.statusWarning },
    error: { fontSize: 11, color: theme.colors.statusDanger },
    group: { gap: 8 },
    groupLabel: {
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      color: theme.colors.foregroundMuted,
    },
    row: {
      gap: 6,
      padding: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    rowHeader: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 8,
    },
    rowLabel: { fontSize: 12, color: theme.colors.foreground, flexShrink: 1 },
    rowValue: { fontSize: 12, color: theme.colors.foreground, fontVariant: ["tabular-nums"] },
    hint: { fontSize: 11, color: theme.colors.foregroundMuted },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    action: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    actionText: { fontSize: 12, color: theme.colors.foreground },
    empty: { fontSize: 12, color: theme.colors.foregroundMuted },
  };
}

/** A quota's two sides, as the panel states them: "2,500 of 10,000 · 7,500 left". */
function quotaAmounts(reading: UsageReading): string | null {
  if (reading.kind !== "quota") {
    return null;
  }
  const parts: string[] = [];
  if (reading.used !== null) {
    const ceiling = reading.limit === null ? null : formatUsageAmount(reading.limit, reading.unit);
    const used = formatUsageAmount(reading.used, reading.unit);
    parts.push(ceiling === null ? `${used} used` : `${used} of ${ceiling}`);
  }
  if (reading.remaining !== null) {
    parts.push(`${formatUsageAmount(reading.remaining, reading.unit)} left`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

function DetailRow({
  reading,
  styles,
  theme,
  now,
}: {
  reading: UsageReading;
  styles: DetailStyles;
  theme: PluginComposerPillProps["theme"];
  now: number;
}) {
  if (reading.kind === "rate") {
    const changes = formatWhenHint("Changes", reading.changesAt, now);
    return (
      <View style={styles.row}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowLabel}>{reading.label}</Text>
          <Text style={styles.rowValue}>{reading.state}</Text>
        </View>
        {reading.detail === null ? null : <Text style={styles.hint}>{reading.detail}</Text>}
        {changes === null ? null : <Text style={styles.hint}>{changes}</Text>}
      </View>
    );
  }
  const percentUsed =
    reading.kind === "quota"
      ? reading.percent
      : reading.percentRemaining === null
        ? null
        : 100 - reading.percentRemaining;
  const amounts =
    reading.kind === "quota"
      ? quotaAmounts(reading)
      : reading.remaining === null
        ? null
        : `${formatUsageAmount(reading.remaining, reading.unit, reading.currency)} left`;
  const window = reading.kind === "quota" ? reading.window : null;
  const resets = formatWhenHint("Resets", window?.resetsAt ?? null, now);
  // Many presets name the reading after its window, and "Session · Session"
  // says nothing twice.
  const rowLabel =
    window === null || window.label === reading.label
      ? reading.label
      : `${reading.label} · ${window.label}`;
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowLabel}>{rowLabel}</Text>
        <Text style={styles.rowValue}>
          {percentUsed === null ? (amounts ?? EM_DASH) : `${Math.round(percentUsed)}%`}
        </Text>
      </View>
      {percentUsed === null ? null : (
        <UsageMeter
          percentUsed={percentUsed}
          pacePercent={quotaPacePercent(window, now)}
          style={DETAIL_METER_STYLE}
          theme={theme}
          compact
        />
      )}
      {percentUsed === null || amounts === null ? null : <Text style={styles.hint}>{amounts}</Text>}
      {resets === null ? null : <Text style={styles.hint}>{resets}</Text>}
    </View>
  );
}

/**
 * The panel a pill opens: one provider, every reading it publishes, and the
 * two things the rail cannot say — what each window resets at, and how old the
 * numbers are.
 */
export function UsagePillDetailPanel({ theme, layout }: PluginWorkspacePanelProps) {
  const readSnapshot = useRpc(readUsageLimits);
  const queryClient = useQueryClient();
  const now = useTickingClock();
  const [refreshing, setRefreshing] = useState(false);
  const focused = useSyncExternalStore(subscribeFocus, readFocus, readFocus);
  const { data } = useQuery({
    queryKey: USAGE_LIMITS_QUERY_KEY,
    queryFn: () => readSnapshot({ refresh: false }),
    refetchInterval: LIMITS_POLL_MS,
    refetchOnWindowFocus: Platform.OS === "web",
  });
  const styles = useMemo(() => createDetailStyles(theme), [theme]);
  const markStyles = useMemo(
    () =>
      createPillStyles(theme.colors.foregroundMuted, theme.colors.foreground, theme.colors.accent),
    [theme],
  );
  const providers = data?.providers ?? [];
  const provider =
    providers.find((candidate) => candidate.providerId === focused) ??
    providers.find((candidate) => resolvePillSettings(candidate.display) !== null) ??
    null;
  const refresh = useCallback(() => {
    setRefreshing(true);
    void (async () => {
      try {
        const snapshot = await readSnapshot({ refresh: true });
        queryClient.setQueryData(USAGE_LIMITS_QUERY_KEY, snapshot);
      } catch (error: unknown) {
        // The stale numbers stay on screen; the provider's own notice explains
        // why they did not move.
        console.warn("[usage-monitor] detail refresh failed", error);
      } finally {
        setRefreshing(false);
      }
    })();
  }, [queryClient, readSnapshot]);
  const openSettings = useCallback(() => {
    clientContext?.openSurface(SETTINGS_SURFACE_ID);
  }, []);
  const openDashboard = useCallback(() => {
    clientContext?.openSurface(DASHBOARD_SURFACE_ID);
  }, []);
  if (provider === null) {
    return (
      <View style={styles.screen}>
        <View style={styles.body}>
          <Text style={styles.empty}>
            No provider is on the composer rail yet. Turn one on under Composer pill in settings.
          </Text>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={openSettings} style={styles.action}>
              <Text style={styles.actionText}>Open settings</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }
  const updated = formatUpdatedLabel(provider.fetchedAt, now, isShowingStaleReadings(provider));
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.header}>
          <PillMark
            icon={provider.icon}
            label={provider.label}
            styles={markStyles}
            color={theme.colors.foregroundMuted}
          />
          <View style={styles.identity}>
            <Text style={styles.title}>{provider.label}</Text>
            {updated === null ? null : <Text style={styles.subtitle}>{updated}</Text>}
          </View>
        </View>
        {provider.notice === null ? null : <Text style={styles.notice}>{provider.notice}</Text>}
        {provider.error === null ? null : <Text style={styles.error}>{provider.error}</Text>}
        {provider.readings.length === 0 ? (
          <Text style={styles.empty}>This provider published no readings.</Text>
        ) : null}
        {groupReadings(provider.readings).map((group) => (
          <View key={group.key} style={styles.group}>
            {group.label === null ? null : <Text style={styles.groupLabel}>{group.label}</Text>}
            {group.readings.map((reading) => (
              <DetailRow
                key={reading.id}
                reading={reading}
                styles={styles}
                theme={theme}
                now={now}
              />
            ))}
          </View>
        ))}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={refreshing ? ACTION_BUSY : ACTION_IDLE}
            disabled={refreshing}
            onPress={refresh}
            style={styles.action}
          >
            <Text style={styles.actionText}>{refreshing ? "Refreshing…" : "Refresh"}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={openSettings} style={styles.action}>
            <Text style={styles.actionText}>Settings</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={openDashboard} style={styles.action}>
            <Text style={styles.actionText}>{layout.compact ? "Dashboard" : "Open dashboard"}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const ACTION_BUSY = { busy: true, disabled: true };
const ACTION_IDLE = { busy: false, disabled: false };
