import type { PluginCleanup, PluginTheme } from "@getpaseo/plugin";
import {
  type PluginClientContext,
  type PluginTimelineItemProps,
  useAgent,
  usePaseo,
  useRpc,
} from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, Text, type TextStyle, View, type ViewStyle } from "react-native";
import {
  detectUsageLimit,
  limitKindFor,
  limitKindFromText,
  parseResetInstant,
  resetUrlFor,
  topUpUrlFor,
  vendorLabelFor,
  type LimitKind,
} from "../shared/limit-detect.shared";
import {
  cancelLimitAlertResume,
  dismissLimitAlert,
  handOffLimitAlert,
  LIMIT_ALERTS_QUERY_KEY,
  LIMIT_ALERT_SETTINGS_QUERY_KEY,
  LIMIT_ALERT_TIMELINE_KIND,
  LIMIT_ALERT_TIMELINE_VERSION,
  LimitAlertTimelineDataSchema,
  readLimitAlertSettings,
  readLimitAlerts,
  scheduleLimitAlertResume,
  type LimitAlert,
  type LimitAlertStatus,
  type LimitAlertTimelineData,
} from "../shared/limit-alerts.shared";
import { formatWhenHint, useTickingClock } from "./limits.client";

/**
 * A usage-limit refusal drawn as a callout in place of the raw turn error. The
 * daemon hook owns detection and persistence; the client owns where the
 * callout sits, what it offers, and when the reader is told about it.
 *
 * The transformer has no agent context, so it stamps only what the vendor's own
 * wording carries. The renderer upgrades everything else from `useAgent` and
 * the live alert, which is also what lets the callout change state (resume
 * armed, handed off) without the timeline itself changing.
 */

/** The daemon poll cadence while an alert still wants an answer. */
export const LIMIT_ALERT_POLL_MS = 15_000;

/** How long the warning toast stays up. */
const LIMIT_ALERT_TOAST_MS = 8_000;

/** The transformer's stand-in for an agent provider it cannot see. */
export const LIMIT_ALERT_UNKNOWN_PROVIDER = "unknown";

/** Heading label until the renderer resolves the provider from the agent. */
export const LIMIT_ALERT_FALLBACK_LABEL = "Provider";

// Derived rather than imported: `PaseoApi` lives in `@getpaseo/client`, and the
// compiler rejects a client bundle that imports that specifier directly — only
// `usePaseo()`'s own return type is reachable from here.
type PaseoApi = ReturnType<typeof usePaseo>;

const HANDOFF_OPTIONS_QUERY_KEY = ["usage-limits", "handoff-options"] as const;

const ACCESS_DISABLED = { disabled: true };

/**
 * Paseo calls the harness `provider`; this only feeds a fallback heading, and
 * the alert the daemon recorded wins whenever it is present.
 */
const AGENT_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "GitHub Copilot",
  "github-copilot": "GitHub Copilot",
  omp: "Oh My Pi",
  pi: "Pi",
  opencode: "OpenCode",
  gemini: "Gemini",
  antigravity: "Antigravity",
  "antigravity-acp": "Antigravity",
  "antigravity-official": "Antigravity",
  cursor: "Cursor",
  deepseek: "DeepSeek",
};

function slugLabel(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter((part) => part !== "")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function providerLabelFor(agentProvider: string | null | undefined): string | null {
  if (agentProvider === null || agentProvider === undefined || agentProvider === "") return null;
  if (agentProvider === LIMIT_ALERT_UNKNOWN_PROVIDER) return null;
  return AGENT_PROVIDER_LABELS[agentProvider] ?? slugLabel(agentProvider);
}

/**
 * Which timeline items become callouts. Null for anything but a finished
 * refusal: a streaming assistant message is still being written, and only the
 * two item types a vendor uses for this refusal are classified at all.
 *
 * `now` anchors a text that names only a wall-clock reset, so the value can be
 * pinned in a test; the transformer leaves it at the current instant.
 */
export function limitAlertTimelineData(
  item: AgentTimelineItem,
  phase: "streaming" | "complete",
  now: Date = new Date(),
): LimitAlertTimelineData | null {
  if (phase !== "complete") return null;
  const text =
    item.type === "error" ? item.message : item.type === "assistant_message" ? item.text : null;
  if (text === null) return null;
  const detection = detectUsageLimit(text, now);
  if (detection === null) return null;
  return {
    agentProvider: LIMIT_ALERT_UNKNOWN_PROVIDER,
    providerLabel: LIMIT_ALERT_FALLBACK_LABEL,
    message: detection.message,
    resetsAt: detection.resetsAt,
    resetUrl: null,
    // A money refusal names itself ("Insufficient Balance"); a window refusal
    // does not, so the renderer decides the rest from the live alert.
    limitKind: limitKindFromText(text) ?? undefined,
  };
}

function timelineItem(data: LimitAlertTimelineData) {
  return {
    type: "plugin" as const,
    kind: LIMIT_ALERT_TIMELINE_KIND,
    version: LIMIT_ALERT_TIMELINE_VERSION,
    data: { ...data },
  };
}

/**
 * Claude Code reports its refusal as an assistant message and other vendors as
 * a failed turn, so both item types get a transformer and neither is left to
 * the raw error text.
 */
export function contributeLimitAlerts(client: PluginClientContext): PluginCleanup {
  const removeError = client.addTimelineTransformer({
    id: "usage-limit-error",
    query: { itemType: "error" },
    transform({ item, phase }) {
      const data = limitAlertTimelineData(item, phase);
      return data === null ? undefined : { items: [timelineItem(data)] };
    },
  });
  const removeAssistant = client.addTimelineTransformer({
    id: "usage-limit-assistant",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
      const data = limitAlertTimelineData(item, phase);
      return data === null ? undefined : { items: [timelineItem(data)] };
    },
  });
  const removeRenderer = client.addTimelineRenderer({
    kind: LIMIT_ALERT_TIMELINE_KIND,
    version: LIMIT_ALERT_TIMELINE_VERSION,
    schema: LimitAlertTimelineDataSchema,
    Component: LimitAlertCallout,
  });
  return () => {
    removeError();
    removeAssistant();
    removeRenderer();
  };
}

/**
 * The alert whose wording matches this item, else the agent's newest one. A
 * second refusal in the same turn has its own wording, so the exact match is
 * the one that keeps two callouts in one transcript apart.
 */
export function matchLimitAlert(
  alerts: readonly LimitAlert[] | undefined,
  message: string,
): LimitAlert | null {
  if (alerts === undefined || alerts.length === 0) return null;
  const exact = alerts.find((alert) => alert.message === message);
  if (exact !== undefined) return exact;
  let newest: LimitAlert | null = null;
  for (const alert of alerts) {
    if (newest === null || Date.parse(alert.detectedAt) > Date.parse(newest.detectedAt)) {
      newest = alert;
    }
  }
  return newest;
}

/** Only an alert still waiting on the reader is worth a poll. */
export function alertPollInterval(alerts: readonly LimitAlert[] | undefined): number | false {
  if (alerts === undefined) return false;
  const wantsAnswer = alerts.some(
    (alert) => alert.status === "open" || alert.status === "resume_scheduled",
  );
  return wantsAnswer ? LIMIT_ALERT_POLL_MS : false;
}

/**
 * One toast per alert, for the life of the client. Module state rather than a
 * ref because the renderer remounts as the transcript virtualizes, and a
 * remount must not re-announce a limit the reader already saw.
 */
const toastedAlertIds = new Set<string>();

export function claimAlertToast(id: string, seen: Set<string> = toastedAlertIds): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}

export function limitAlertToastMessage(
  providerLabel: string,
  resetsAt: string | null,
  now: number,
  limitKind?: LimitKind | null,
): string {
  if (limitKind === "balance") return `${providerLabel} balance exhausted`;
  const when = formatWhenHint("Resets", resetsAt, now);
  if (when === null) return `${providerLabel} usage limit reached`;
  return `${providerLabel} usage limit reached, ${when.slice(0, 1).toLowerCase()}${when.slice(1)}`;
}

/** Which actions a callout offers. */
export interface CalloutActions {
  /** Buy credit. A balance never refills on its own, so this is the only fix. */
  topUp: boolean;
  /** Open the vendor's page for the quota. */
  usage: boolean;
  /** Arm a resume, or cancel one already armed. False for a balance. */
  resume: boolean;
  handoff: boolean;
  dismiss: boolean;
}

/**
 * A balance has no window to wait for, so it offers a top-up where a window
 * offers a resume. An alert the daemon has not answered yet carries no kind,
 * and keeps the resume affordance rather than losing both.
 */
export function calloutActions(input: {
  limitKind: LimitKind | null;
  topUpUrl: string | null;
  usageUrl: string | null;
  status: LimitAlertStatus;
}): CalloutActions {
  const waiting = input.status === "open" || input.status === "resume_scheduled";
  const balance = input.limitKind === "balance";
  const topUp = balance && input.topUpUrl !== null;
  return {
    topUp,
    // Several vendors show the balance and sell the credit on one page, so the
    // top-up button carries the link and the usage button steps aside.
    usage: input.usageUrl !== null && !(topUp && input.topUpUrl === input.usageUrl),
    resume: waiting && !balance,
    handoff: waiting,
    dismiss: waiting,
  };
}

/** "Resets in 3h · 15:00": the countdown decides urgency, the clock is what you diarise. */
export function limitAlertResetHint(resetsAt: string | null, now: number): string | null {
  const relative = formatWhenHint("Resets", resetsAt, now);
  if (relative === null || resetsAt === null) return null;
  const absolute = new Date(resetsAt);
  if (Number.isNaN(absolute.getTime())) return relative;
  return `${relative} · ${absolute.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function formatAbsolute(instant: string | null | undefined): string | null {
  if (instant === null || instant === undefined) return null;
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  });
}

/** `provider/model`, split at the first slash because a model id may contain more. */
export function splitHandoffValue(
  value: string | null | undefined,
): { provider: string; modelId: string } | null {
  if (value === null || value === undefined) return null;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

/**
 * A handoff remembers the full `provider/model`, so the provider segment is
 * what names it in prose.
 */
export function handoffTargetLabel(value: string | null): string | null {
  if (value === null) return null;
  return providerLabelFor(splitHandoffValue(value)?.provider ?? value) ?? value;
}

/**
 * The typed resume time: an instant as ISO, or a bare `HH:MM` meaning the next
 * occurrence of that local time. Anything else goes through the same parser the
 * detector uses, so "resets 3pm" typed by hand still lands.
 */
export function parseResumeAt(text: string, now: Date): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const clock = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (clock !== null) {
    const hours = Number(clock[1] ?? "");
    const minutes = Number(clock[2] ?? "");
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    if (hours > 23 || minutes > 59) return null;
    const at = new Date(now);
    at.setHours(hours, minutes, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }
  return parseResetInstant(trimmed, now);
}

export interface HandoffModelOption {
  id: string;
  label: string;
}

export interface HandoffProviderOption {
  provider: string;
  label: string;
  models: HandoffModelOption[];
}

async function loadHandoffOptions(paseo: PaseoApi): Promise<HandoffProviderOption[]> {
  const available = await paseo.providers.listAvailable();
  const providers = available.providers
    .filter((entry) => entry.available)
    .map((entry) => entry.provider);
  return Promise.all(
    providers.map(async (provider): Promise<HandoffProviderOption> => {
      const label = providerLabelFor(provider) ?? provider;
      try {
        const result = await paseo.providers.listModels(provider);
        const models = (result.models ?? [])
          .filter((model) => model.isSelectable !== false)
          .map((model) => ({ id: model.id, label: model.label }));
        return { provider, label, models };
      } catch {
        // One provider whose model list fails must not blank the picker.
        return { provider, label, models: [] };
      }
    }),
  );
}

/**
 * Providers a handoff can target, each with its selectable models. Shared by
 * the callout's picker and the settings select so both offer the same list.
 */
export function useHandoffOptions(enabled: boolean) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: HANDOFF_OPTIONS_QUERY_KEY,
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () => loadHandoffOptions(paseo),
  });
}

interface CalloutStyles {
  card: ViewStyle;
  header: ViewStyle;
  title: TextStyle;
  message: TextStyle;
  detail: TextStyle;
  muted: TextStyle;
  success: TextStyle;
  error: TextStyle;
  actions: ViewStyle;
  button: ViewStyle;
  primaryButton: ViewStyle;
  selectedButton: ViewStyle;
  disabledButton: ViewStyle;
  buttonText: TextStyle;
  primaryButtonText: TextStyle;
  input: TextStyle;
  modalBody: ViewStyle;
  optionGroup: ViewStyle;
  optionGroupTitle: TextStyle;
  optionRow: ViewStyle;
}

function createStyles(theme: PluginTheme, compact: boolean): CalloutStyles {
  const fontSize = compact ? 12 : 13;
  const small = compact ? 11 : 12;
  return {
    card: {
      gap: 6,
      marginVertical: 4,
      padding: 12,
      borderWidth: 1,
      borderColor: theme.colors.statusWarning,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
    },
    header: { flexDirection: "row", alignItems: "center", gap: 6 },
    title: {
      color: theme.colors.statusWarning,
      fontSize,
      fontWeight: "600",
      flexShrink: 1,
    },
    message: { color: theme.colors.foreground, fontSize, lineHeight: fontSize + 4 },
    detail: { color: theme.colors.foregroundMuted, fontSize: small },
    muted: { color: theme.colors.foregroundMuted, fontSize: small },
    success: { color: theme.colors.statusSuccess, fontSize: small },
    error: { color: theme.colors.statusDanger, fontSize: small },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 2 },
    button: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: compact ? 8 : 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
      maxWidth: "100%",
      flexShrink: 1,
    },
    primaryButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: compact ? 9 : 7,
      borderRadius: 8,
      backgroundColor: theme.colors.accent,
      maxWidth: "100%",
      flexShrink: 1,
    },
    selectedButton: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
    disabledButton: { opacity: 0.5 },
    buttonText: {
      color: theme.colors.foreground,
      fontSize: small,
      fontWeight: "600",
      flexShrink: 1,
    },
    primaryButtonText: {
      color: theme.colors.accentForeground,
      fontSize: small,
      fontWeight: "600",
      flexShrink: 1,
    },
    input: {
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface0,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize,
    },
    modalBody: { gap: 8 },
    optionGroup: { gap: 6 },
    optionGroupTitle: { color: theme.colors.foreground, fontSize: small, fontWeight: "600" },
    optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  };
}

type AlertAction =
  | { kind: "dismiss" }
  | { kind: "resume"; at?: string }
  | { kind: "cancel" }
  | { kind: "handoff"; provider: string };

function CalloutButton({
  label,
  styles,
  tone = "normal",
  disabled = false,
  onPress,
}: {
  label: string;
  styles: CalloutStyles;
  tone?: "normal" | "primary";
  disabled?: boolean;
  onPress(): void;
}) {
  const primary = tone === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={disabled ? ACCESS_DISABLED : undefined}
      disabled={disabled}
      onPress={onPress}
      style={[
        primary ? styles.primaryButton : styles.button,
        disabled ? styles.disabledButton : null,
      ]}
    >
      <Text style={primary ? styles.primaryButtonText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

/**
 * One model in the handoff picker. A child component rather than an inline
 * press handler, because a `map` cannot own a stable callback.
 */
function HandoffModelButton({
  value,
  label,
  selected,
  disabled,
  styles,
  onSelect,
}: {
  value: string;
  label: string;
  selected: boolean;
  disabled: boolean;
  styles: CalloutStyles;
  onSelect(value: string): void;
}) {
  const press = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={selected ? `${label}, the default handoff` : label}
      disabled={disabled}
      onPress={press}
      style={[
        styles.button,
        selected ? styles.selectedButton : null,
        disabled ? styles.disabledButton : null,
      ]}
    >
      <Text style={selected ? styles.primaryButtonText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function LimitAlertCallout({
  agentId,
  item,
  theme,
  layout,
}: PluginTimelineItemProps<LimitAlertTimelineData>) {
  const data = item.data;
  const compact = layout.compact;
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const now = useTickingClock();
  const toast = useToast();
  const queryClient = useQueryClient();
  const readAlerts = useRpc(readLimitAlerts);
  const readSettings = useRpc(readLimitAlertSettings);
  const dismiss = useRpc(dismissLimitAlert);
  const scheduleResume = useRpc(scheduleLimitAlertResume);
  const cancelResume = useRpc(cancelLimitAlertResume);
  const handOff = useRpc(handOffLimitAlert);
  const agentProvider = useAgent(agentId, (agent) => agent.provider);
  const agentModel = useAgent(agentId, (agent) => agent.model);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeText, setResumeText] = useState("");
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);

  const alertsQuery = useQuery({
    queryKey: [...LIMIT_ALERTS_QUERY_KEY, agentId],
    queryFn: () => readAlerts({ agentId }),
    refetchInterval: (query) => alertPollInterval(query.state.data?.alerts),
  });
  const settingsQuery = useQuery({
    queryKey: LIMIT_ALERT_SETTINGS_QUERY_KEY,
    queryFn: () => readSettings({}),
    staleTime: 5 * 60_000,
  });
  const alert = matchLimitAlert(alertsQuery.data?.alerts, data.message);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: LIMIT_ALERTS_QUERY_KEY });
  }, [queryClient]);

  /**
   * One mutation for every action: they share a target and an invalidation, and
   * the card stays single-action at a time because a resume and a handoff for
   * the same alert are mutually exclusive anyway.
   */
  const act = useMutation({
    mutationFn: (action: AlertAction) => {
      if (alert === null) return Promise.reject(new Error("The alert is not loaded yet"));
      switch (action.kind) {
        case "dismiss":
          return dismiss({ id: alert.id });
        case "resume":
          return scheduleResume(
            action.at === undefined ? { id: alert.id } : { id: alert.id, at: action.at },
          );
        case "cancel":
          return cancelResume({ id: alert.id });
        case "handoff":
          return handOff({ id: alert.id, provider: action.provider });
      }
    },
    onSuccess: invalidate,
  });

  const handoffOptionsQuery = useHandoffOptions(handoffOpen);
  const enabled = settingsQuery.data?.enabled !== false;
  const toastEnabled = settingsQuery.data?.toast !== false;
  const providerLabel =
    alert?.providerLabel ??
    vendorLabelFor(agentProvider ?? "", agentModel ?? null) ??
    providerLabelFor(agentProvider) ??
    data.providerLabel;
  const message = alert?.message ?? data.message;
  const resetsAt = alert?.resetsAt ?? data.resetsAt;
  const resetUrl =
    alert?.resetUrl ?? resetUrlFor(agentProvider ?? "", agentModel ?? null) ?? data.resetUrl;
  const status = alert?.status ?? "open";
  // The alert wins; the vendor table covers the moment before it arrives, and
  // an alert recorded before the kind existed.
  const limitKind =
    alert?.limitKind ?? data.limitKind ?? limitKindFor(agentProvider ?? "", agentModel ?? null);
  const topUpUrl =
    alert?.topUpUrl ?? data.topUpUrl ?? topUpUrlFor(agentProvider ?? "", agentModel ?? null);
  const actions = calloutActions({ limitKind, topUpUrl, usageUrl: resetUrl, status });
  const busy = act.isPending;
  const pendingAlert = alert === null;

  useEffect(() => {
    if (!enabled || !toastEnabled || alert === null || alert.status !== "open") return;
    if (!claimAlertToast(alert.id)) return;
    toast.show(limitAlertToastMessage(providerLabel, alert.resetsAt, Date.now(), limitKind), {
      variant: "warning",
      durationMs: LIMIT_ALERT_TOAST_MS,
    });
  }, [alert, enabled, limitKind, providerLabel, toast, toastEnabled]);

  const openResume = useCallback(() => {
    setResumeError(null);
    if (resetsAt !== null) {
      act.mutate({ kind: "resume" });
      return;
    }
    setResumeText("");
    setResumeOpen(true);
  }, [act, resetsAt]);

  const confirmResume = useCallback(() => {
    const at = parseResumeAt(resumeText, new Date());
    if (at === null) {
      setResumeError("Enter an ISO time or an HH:MM time.");
      return;
    }
    setResumeOpen(false);
    act.mutate({ kind: "resume", at });
  }, [act, resumeText]);

  const chooseHandoff = useCallback(
    (provider: string) => {
      setHandoffOpen(false);
      act.mutate({ kind: "handoff", provider });
    },
    [act],
  );

  const dismissAlert = useCallback(() => act.mutate({ kind: "dismiss" }), [act]);
  const cancelResumeSchedule = useCallback(() => act.mutate({ kind: "cancel" }), [act]);
  const openHandoff = useCallback(() => setHandoffOpen(true), []);
  const closeResume = useCallback(() => setResumeOpen(false), []);
  const changeResumeOpen = useCallback((open: boolean) => setResumeOpen(open), []);
  const changeHandoffOpen = useCallback((open: boolean) => setHandoffOpen(open), []);
  const openUsagePage = useCallback(() => {
    if (resetUrl !== null) {
      void Linking.openURL(resetUrl);
    }
  }, [resetUrl]);
  const openTopUpPage = useCallback(() => {
    if (topUpUrl !== null) {
      void Linking.openURL(topUpUrl);
    }
  }, [topUpUrl]);

  if (!enabled || status === "dismissed") return null;

  const resetHint = limitAlertResetHint(resetsAt, now);
  const heading =
    limitKind === "balance"
      ? `${providerLabel} balance exhausted`
      : `${providerLabel} usage limit reached`;
  const resumedAt = formatAbsolute(alert?.resume?.scheduledFor);
  const defaultHandoff = settingsQuery.data?.handoffProvider ?? null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Icon name="TriangleAlert" size={14} color={theme.colors.statusWarning} />
        <Text style={styles.title}>{heading}</Text>
      </View>
      {message === "" ? null : (
        <Text selectable style={styles.message}>
          {message}
        </Text>
      )}
      {status === "open" && limitKind === "balance" ? (
        <Text style={styles.detail}>Top up to continue</Text>
      ) : null}
      {status === "open" && limitKind !== "balance" && resetHint !== null ? (
        <Text style={styles.detail}>{resetHint}</Text>
      ) : null}
      {status === "resume_scheduled" ? (
        <Text style={styles.detail}>
          {formatWhenHint("Resumes", alert?.resume?.scheduledFor ?? resetsAt, now) ??
            "Resume scheduled"}
        </Text>
      ) : null}
      {status === "resumed" ? (
        <Text style={styles.success}>
          {resumedAt === null ? "Resumed" : `Resumed at ${resumedAt}`}
        </Text>
      ) : null}
      {status === "handed_off" ? (
        <>
          <Text style={styles.success}>
            {`Handed off to ${handoffTargetLabel(alert?.handoff?.provider ?? null) ?? "another provider"}`}
          </Text>
          {alert?.handoff === null || alert?.handoff === undefined ? null : (
            <Text selectable style={styles.detail}>
              {`Continues in agent ${alert.handoff.agentId}`}
            </Text>
          )}
        </>
      ) : null}
      {act.isError ? <Text style={styles.error}>{act.error.message}</Text> : null}
      <View style={styles.actions}>
        {actions.usage ? (
          <CalloutButton label="Open usage page" styles={styles} onPress={openUsagePage} />
        ) : null}
        {actions.topUp ? (
          <CalloutButton
            label="Top up"
            styles={styles}
            tone="primary"
            disabled={pendingAlert || busy}
            onPress={openTopUpPage}
          />
        ) : null}
        {actions.resume && status === "open" ? (
          <CalloutButton
            label="Resume at reset"
            styles={styles}
            tone="primary"
            disabled={pendingAlert || busy}
            onPress={openResume}
          />
        ) : null}
        {actions.resume && status === "resume_scheduled" ? (
          <CalloutButton
            label="Cancel resume"
            styles={styles}
            tone="primary"
            disabled={pendingAlert || busy}
            onPress={cancelResumeSchedule}
          />
        ) : null}
        {actions.handoff ? (
          <CalloutButton
            label="Hand off…"
            styles={styles}
            disabled={pendingAlert || busy}
            onPress={openHandoff}
          />
        ) : null}
        {actions.dismiss ? (
          <CalloutButton
            label="Dismiss"
            styles={styles}
            disabled={pendingAlert || busy}
            onPress={dismissAlert}
          />
        ) : null}
      </View>
      <Modal title="Resume when the quota resets" open={resumeOpen} onOpenChange={changeResumeOpen}>
        <Modal.Content>
          <View style={styles.modalBody}>
            <Text style={styles.muted}>
              The error named no reset time. Enter one as an ISO instant or as HH:MM.
            </Text>
            <TextInput
              accessibilityLabel="Resume time"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setResumeText}
              placeholder="15:00"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              value={resumeText}
            />
            {resumeError === null ? null : <Text style={styles.error}>{resumeError}</Text>}
            <View style={styles.actions}>
              <CalloutButton label="Cancel" styles={styles} onPress={closeResume} />
              <CalloutButton
                label="Schedule"
                styles={styles}
                tone="primary"
                disabled={busy}
                onPress={confirmResume}
              />
            </View>
          </View>
        </Modal.Content>
      </Modal>
      <Modal
        title="Hand off to another provider"
        open={handoffOpen}
        onOpenChange={changeHandoffOpen}
      >
        <Modal.Content scrollable>
          <View style={styles.modalBody}>
            {handoffOptionsQuery.isPending ? (
              <Text style={styles.muted}>Loading providers…</Text>
            ) : null}
            {handoffOptionsQuery.isError ? (
              <Text style={styles.error}>{handoffOptionsQuery.error.message}</Text>
            ) : null}
            {handoffOptionsQuery.data !== undefined && handoffOptionsQuery.data.length === 0 ? (
              <Text style={styles.muted}>No provider is available to hand this work to.</Text>
            ) : null}
            {(handoffOptionsQuery.data ?? []).map((option) => (
              <View key={option.provider} style={styles.optionGroup}>
                <Text style={styles.optionGroupTitle}>{option.label}</Text>
                {option.models.length === 0 ? (
                  <Text style={styles.muted}>No selectable models.</Text>
                ) : (
                  <View style={styles.optionRow}>
                    {option.models.map((model) => {
                      const value = `${option.provider}/${model.id}`;
                      return (
                        <HandoffModelButton
                          key={value}
                          value={value}
                          label={model.label}
                          selected={value === defaultHandoff}
                          disabled={busy}
                          styles={styles}
                          onSelect={chooseHandoff}
                        />
                      );
                    })}
                  </View>
                )}
              </View>
            ))}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
