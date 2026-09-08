import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useReducer } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import {
  consumeCodexBankedReset,
  readCodexBankedReset,
  type CodexBankedResetDetails,
  type CodexBankedResetOutcome,
} from "../shared/codex-reset.shared";
import {
  readUsageLimits,
  USAGE_LIMITS_QUERY_KEY,
  type UsageProviderSnapshot,
} from "../shared/limits.shared";

export type BankedResetStatus = "idle" | "checking" | "confirming" | "consuming" | "done" | "error";

export interface BankedResetState {
  status: BankedResetStatus;
  details: CodexBankedResetDetails | null;
  message: string | null;
}

const RESET_BUSY_STATE = { busy: true, disabled: true };
const RESET_IDLE_STATE = { busy: false, disabled: false };

export const BANKED_RESET_IDLE: BankedResetState = {
  status: "idle",
  details: null,
  message: null,
};

export type BankedResetEvent =
  | { type: "check" }
  | { type: "prepared"; details: CodexBankedResetDetails }
  | { type: "consume" }
  | { type: "complete"; message: string }
  | { type: "failed"; message: string }
  | { type: "cancel" };

export function bankedResetReducer(
  state: BankedResetState,
  event: BankedResetEvent,
): BankedResetState {
  switch (event.type) {
    case "check":
      return { status: "checking", details: null, message: null };
    case "prepared":
      return event.details.availableCount > 0 && event.details.redeemRequestId !== null
        ? { status: "confirming", details: event.details, message: null }
        : { status: "done", details: null, message: "No banked reset is available." };
    case "consume":
      return state.details === null
        ? state
        : { status: "consuming", details: state.details, message: null };
    case "complete":
      return { status: "done", details: null, message: event.message };
    case "failed":
      return { status: "error", details: state.details, message: event.message };
    case "cancel":
      return BANKED_RESET_IDLE;
    default:
      return state;
  }
}

export function bankedResetAvailableCount(provider: UsageProviderSnapshot): number {
  if (provider.supportsBankedReset !== true) return 0;
  const reading = provider.readings.find(
    (candidate) => candidate.kind === "balance" && candidate.id === "banked-resets",
  );
  if (reading?.kind !== "balance" || reading.remaining === null || reading.remaining <= 0) return 0;
  return Math.floor(reading.remaining);
}

export function bankedResetOutcomeMessage(
  outcome: CodexBankedResetOutcome,
  windowsReset: number,
): string {
  switch (outcome) {
    case "reset":
      return windowsReset === 1
        ? "Banked reset applied to your Codex limits."
        : `Banked reset applied to ${windowsReset} Codex limits.`;
    case "nothing_to_reset":
      return "Nothing needed resetting. Your banked reset remains available.";
    case "no_credit":
      return "No banked reset is available.";
    case "already_redeemed":
      return "This banked reset was already applied.";
  }
}

interface BankedResetStyles {
  container: ViewStyle;
  prompt: TextStyle;
  detail: TextStyle;
  error: TextStyle;
  actions: ViewStyle;
  button: ViewStyle;
  primaryButton: ViewStyle;
  buttonDisabled: ViewStyle;
  buttonText: TextStyle;
  primaryButtonText: TextStyle;
}

function createStyles(theme: PluginTheme, compact: boolean): BankedResetStyles {
  const fontSize = compact ? 11 : 12;
  return {
    container: {
      gap: 6,
      marginTop: 4,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    prompt: { color: theme.colors.foreground, fontSize, lineHeight: fontSize + 4 },
    detail: {
      color: theme.colors.foregroundMuted,
      fontSize,
      lineHeight: fontSize + 4,
    },
    error: { color: theme.colors.statusDanger, fontSize, lineHeight: fontSize + 4 },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
    button: {
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: 7,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    primaryButton: {
      backgroundColor: theme.colors.accent,
      borderColor: theme.colors.accent,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: theme.colors.foreground, fontSize, fontWeight: "600" },
    primaryButtonText: { color: theme.colors.accentForeground, fontSize, fontWeight: "600" },
  };
}

function expirationLabel(timestamp: string | null): string | null {
  if (timestamp === null) return null;
  const expiresAt = new Date(timestamp);
  if (Number.isNaN(expiresAt.getTime())) return null;
  return `Expires ${expiresAt.toLocaleString()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CodexBankedResetAction({
  provider,
  theme,
  compact,
  beforeAction,
}: {
  provider: UsageProviderSnapshot;
  theme: PluginTheme;
  compact: boolean;
  beforeAction?: () => void;
}) {
  const inspectReset = useRpc(readCodexBankedReset);
  const consumeReset = useRpc(consumeCodexBankedReset);
  const readSnapshot = useRpc(readUsageLimits);
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(bankedResetReducer, BANKED_RESET_IDLE);
  const styles = useMemo(() => createStyles(theme, compact), [compact, theme]);
  const availableCount = bankedResetAvailableCount(provider);

  const refreshSnapshot = useCallback(() => {
    void (async () => {
      try {
        const snapshot = await readSnapshot({ refresh: true });
        queryClient.setQueryData(USAGE_LIMITS_QUERY_KEY, snapshot);
      } catch (error: unknown) {
        console.warn("[usage-monitor] post-banked-reset read failed", error);
      }
    })();
  }, [queryClient, readSnapshot]);

  const prepare = useCallback(() => {
    beforeAction?.();
    if (state.status === "checking" || state.status === "consuming") return;
    dispatch({ type: "check" });
    void (async () => {
      try {
        const details = await inspectReset({ providerId: provider.providerId });
        dispatch({ type: "prepared", details });
      } catch (error: unknown) {
        dispatch({ type: "failed", message: errorMessage(error) });
      }
    })();
  }, [beforeAction, inspectReset, provider.providerId, state.status]);

  const consume = useCallback(() => {
    beforeAction?.();
    const details = state.details;
    if (details === null || state.status === "consuming") return;
    const redeemRequestId = details.redeemRequestId;
    if (redeemRequestId === null) return;
    dispatch({ type: "consume" });
    void (async () => {
      try {
        const result = await consumeReset({
          providerId: provider.providerId,
          creditId: details.credit?.id ?? null,
          redeemRequestId,
        });
        dispatch({
          type: "complete",
          message: bankedResetOutcomeMessage(result.outcome, result.windowsReset),
        });
        refreshSnapshot();
      } catch (error: unknown) {
        dispatch({ type: "failed", message: errorMessage(error) });
      }
    })();
  }, [beforeAction, consumeReset, provider.providerId, refreshSnapshot, state]);

  const cancel = useCallback(() => {
    beforeAction?.();
    dispatch({ type: "cancel" });
  }, [beforeAction]);

  if (availableCount === 0 && state.status === "idle") return null;
  const isConsuming = state.status === "consuming";
  const expires = expirationLabel(state.details?.credit?.expiresAt ?? null);

  return (
    <View style={styles.container}>
      {state.status === "idle" ? (
        <Pressable accessibilityRole="button" onPress={prepare} style={styles.button}>
          <Text style={styles.buttonText}>
            {availableCount === 1
              ? "Use banked reset"
              : `Use one of ${availableCount} banked resets`}
          </Text>
        </Pressable>
      ) : null}
      {state.status === "checking" ? (
        <Text style={styles.detail}>Checking reset details…</Text>
      ) : null}
      {state.status === "confirming" ||
      state.status === "consuming" ||
      (state.status === "error" && state.details !== null) ? (
        <>
          <Text style={styles.prompt}>
            Use one banked reset now? This refreshes your five-hour and weekly Codex limits.
          </Text>
          {state.details?.credit?.title ? (
            <Text style={styles.detail}>{state.details.credit.title}</Text>
          ) : null}
          {state.details?.credit?.description ? (
            <Text style={styles.detail}>{state.details.credit.description}</Text>
          ) : null}
          {expires === null ? null : <Text style={styles.detail}>{expires}</Text>}
          {state.message === null ? null : <Text style={styles.error}>{state.message}</Text>}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={isConsuming}
              onPress={cancel}
              style={[styles.button, isConsuming ? styles.buttonDisabled : null]}
            >
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={isConsuming ? RESET_BUSY_STATE : RESET_IDLE_STATE}
              disabled={isConsuming}
              onPress={consume}
              style={[
                styles.button,
                styles.primaryButton,
                isConsuming ? styles.buttonDisabled : null,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                {state.status === "consuming"
                  ? "Applying…"
                  : state.status === "error"
                    ? "Try again"
                    : "Use reset"}
              </Text>
            </Pressable>
          </View>
        </>
      ) : null}
      {state.status === "done" ? <Text style={styles.detail}>{state.message}</Text> : null}
      {state.status === "error" && state.details === null ? (
        <>
          <Text style={styles.error}>{state.message}</Text>
          <Pressable accessibilityRole="button" onPress={prepare} style={styles.button}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
