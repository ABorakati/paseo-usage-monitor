import {
  Icon,
  type PluginClientContext,
  type PluginComposerPillProps,
  useRpc,
} from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { type ComponentType, useMemo } from "react";
import {
  Image,
  type ImageStyle,
  Platform,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { EM_DASH, LIMITS_POLL_MS, USAGE_LIMITS_QUERY_KEY } from "./limits.client";
import { readUsageLimits, type UsageIcon, type UsageProviderSnapshot } from "./limits.shared";
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
 * Usage on the composer rail. The host owns the pressable, the pill chrome and
 * the pending state, so a component here draws the inside of one pill and
 * nothing else. Every rule about which reading a pill tracks lives in
 * `pills.shared.ts`; this file is rendering and registration only.
 *
 * The press target is the Usage Monitor panel rather than a detail popover:
 * plugins get a plain `onPress` callback with no anchor, and that panel already
 * answers the questions a pill raises — every window, its reset time, its pace,
 * and how stale the numbers are.
 */

const PANEL_ID = "limits";
/** Big enough to read as a gauge, small enough to leave the label room. */
const RAIL_BAR_WIDTH = 34;
const MARK_SIZE = 14;

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
          client.openPanel(PANEL_ID, { workspaceId, agentId, location: "workspace" });
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
