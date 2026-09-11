import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

// Derived rather than imported: `PaseoApi` lives in `@getpaseo/client`, and the
// compiler rejects a plugin server bundle that imports that specifier directly.
type PaseoApi = PluginHandlerContext["paseo"];
import {
  LimitAlertSchema,
  LimitAlertSettingsSchema,
  type LimitAlert,
  type LimitAlertSettings,
  type LimitAlertStatus,
} from "../shared/limit-alerts.shared";
import {
  detectUsageLimit,
  limitKindFor,
  resetUrlFor,
  topUpUrlFor,
  usageProviderIdFor,
  vendorLabelFor,
  type LimitDetection,
} from "../shared/limit-detect.shared";
import type { UsageSnapshot } from "../shared/limits.shared";
import { createNodeConfigAdapters, usageConfigPath, type ConfigAdapters } from "./config.server";

/**
 * One turn that a vendor refused because the account's quota ran out. The
 * daemon records the refusal, persists it, and (when a setting or the user says
 * so) either sends the original agent a continue prompt at the reset time or
 * starts a new agent on another provider.
 *
 * The daemon owns the state because the app may not be running when the reset
 * lands. Timers are in-process, so a scheduled resume is re-armed from the file
 * on every plugin start; one that came due while the daemon was off fires on
 * the next start.
 */

export type LimitAlertTurnEvent = PluginLifecycleEvents["agent.turn_ended"];

type TimelineItem = LimitAlertTurnEvent["timeline"][number];

const FILE_VERSION = 1;
const MAX_ALERTS = 50;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A single `setTimeout` cannot outlive this; a longer wait is armed in chains. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_RESUME_PROMPT = "The usage limit has reset. Continue where you left off.";
const MISSING_HANDOFF_DIRECTORY = "Usage-limit alert has no working directory to hand off from";
const UNKNOWN_RESET = "No reset time known for this alert";

/** Where the alert store lives and what the rest of the plugin speaks to it. */
export interface LimitAlertStoreAdapters extends ConfigAdapters {
  readFile(target: string): string | null;
  writeFile(target: string, text: string): void;
  now(): Date;
  randomId(): string;
}

export interface LimitAlertAdapters extends LimitAlertStoreAdapters {
  /** Fresh-enough quota readings, used when the refusal text names no reset. */
  readLimits(): Promise<UsageSnapshot>;
}

export interface LimitAlertService {
  /** Remembers the API used when a resume timer fires, and re-arms the store. */
  start(paseo: PaseoApi): void;
  record(event: LimitAlertTurnEvent, paseo: PaseoApi): Promise<LimitAlert | null>;
  list(agentId?: string): LimitAlert[];
  dismiss(id: string): LimitAlert;
  scheduleResume(id: string, at?: string, prompt?: string, automatic?: boolean): LimitAlert;
  cancelResume(id: string): LimitAlert;
  handOff(
    id: string,
    provider: string,
    modeId: string | undefined,
    paseo: PaseoApi,
  ): Promise<LimitAlert>;
  readSettings(): LimitAlertSettings;
  writeSettings(partial: Partial<LimitAlertSettings>): LimitAlertSettings;
  close(): void;
}

export function limitAlertsPath(adapters: ConfigAdapters): string {
  return path.join(path.dirname(usageConfigPath(adapters)), "limit-alerts.json");
}

export function createNodeLimitAlertAdapters(
  config: ConfigAdapters = createNodeConfigAdapters(),
): LimitAlertStoreAdapters {
  return {
    ...config,
    readFile(target) {
      try {
        return readFileSync(target, "utf8");
      } catch (cause) {
        const code = cause instanceof Error && "code" in cause ? cause.code : null;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw cause;
      }
    },
    writeFile(target, text) {
      const directory = path.dirname(target);
      const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
    },
    now: () => new Date(),
    randomId: randomUUID,
  };
}

/** A status the user has acted on. Only these age out of the store. */
const TERMINAL_STATUSES: Readonly<Record<LimitAlertStatus, boolean>> = {
  open: false,
  resume_scheduled: false,
  resumed: true,
  handed_off: true,
  dismissed: true,
};

function defaultSettings(): LimitAlertSettings {
  return LimitAlertSettingsSchema.parse({});
}

function parseAlerts(entries: readonly unknown[]): LimitAlert[] {
  const alerts: LimitAlert[] = [];
  for (const entry of entries) {
    const parsed = LimitAlertSchema.safeParse(entry);
    if (parsed.success) alerts.push(parsed.data);
  }
  return alerts.slice(0, MAX_ALERTS);
}

function load(adapters: LimitAlertStoreAdapters): {
  settings: LimitAlertSettings;
  alerts: LimitAlert[];
} {
  const text = adapters.readFile(limitAlertsPath(adapters));
  if (text === null) return { settings: defaultSettings(), alerts: [] };

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { settings: defaultSettings(), alerts: [] };
  }
  if (document === null || typeof document !== "object") {
    return { settings: defaultSettings(), alerts: [] };
  }

  const record = document as Record<string, unknown>;
  const settings = LimitAlertSettingsSchema.safeParse(record.settings ?? {});
  return {
    settings: settings.success ? settings.data : defaultSettings(),
    alerts: Array.isArray(record.alerts) ? parseAlerts(record.alerts) : [],
  };
}

/**
 * The fallback heading for a vendor the shared table does not know: the model's
 * vendor segment when the harness ran one, else the harness itself.
 */
function providerLabelFor(agentProvider: string, model: string | null): string {
  const source = model === null ? agentProvider : (model.split("/")[0] ?? model);
  return source
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * A turn only carries a usage limit when the outcome is a failure whose message
 * is one, or when the last assistant message or error item is. Claude Code
 * reports "You've hit your limit" as an assistant message on a turn that
 * otherwise completed.
 */
function detectionFor(event: LimitAlertTurnEvent, now: Date): LimitDetection | null {
  if (event.outcome.kind === "failed") {
    const direct = detectUsageLimit(event.outcome.error.message, now);
    if (direct) return direct;
  }
  const last = lastSignalItem(event.timeline);
  if (last === null) return null;
  return detectUsageLimit(last, now);
}

function lastSignalItem(timeline: LimitAlertTurnEvent["timeline"]): string | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item: TimelineItem | undefined = timeline[index];
    if (item === undefined) continue;
    if (item.type === "assistant_message") return item.text;
    if (item.type === "error") return item.message;
  }
  return null;
}

function lastUserMessage(timeline: LimitAlertTurnEvent["timeline"]): string | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item: TimelineItem | undefined = timeline[index];
    if (item?.type === "user_message") return item.text;
  }
  return null;
}

function resumePrompt(alert: LimitAlert): string {
  if (alert.lastUserMessage === null) return DEFAULT_RESUME_PROMPT;
  return `${DEFAULT_RESUME_PROMPT}\n\nMy last request was:\n${alert.lastUserMessage}`;
}

function handoffPrompt(alert: LimitAlert): string {
  const request = alert.lastUserMessage ?? "(the previous request was not recorded)";
  return `You are taking over from an agent on ${alert.providerLabel} that hit its usage limit. Continue the task.\n\nThe last request was:\n${request}`;
}

function prune(alerts: readonly LimitAlert[], nowMs: number): LimitAlert[] {
  const cutoff = nowMs - TERMINAL_RETENTION_MS;
  const kept: LimitAlert[] = [];
  for (const alert of alerts) {
    if (TERMINAL_STATUSES[alert.status]) {
      const detected = Date.parse(alert.detectedAt);
      if (Number.isNaN(detected) || detected < cutoff) continue;
    }
    kept.push(alert);
  }
  return kept.slice(0, MAX_ALERTS);
}

export function createLimitAlertService(adapters: LimitAlertAdapters): LimitAlertService {
  const loaded = load(adapters);
  let settings: LimitAlertSettings = loaded.settings;
  let alerts: LimitAlert[] = loaded.alerts;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let timerPaseo: PaseoApi | null = null;

  function findAlert(id: string): LimitAlert | null {
    return alerts.find((alert) => alert.id === id) ?? null;
  }

  function requireAlert(id: string): LimitAlert {
    const alert = findAlert(id);
    if (alert === null) throw new Error(`No usage-limit alert with id "${id}"`);
    return alert;
  }

  function updateAlert(alert: LimitAlert): void {
    alerts = alerts.map((existing) => (existing.id === alert.id ? alert : existing));
  }

  /** A new refusal supersedes the agent's still-open one rather than stacking. */
  function replaceAlert(alert: LimitAlert): void {
    const superseded = alerts.filter(
      (existing) => existing.agentId === alert.agentId && !TERMINAL_STATUSES[existing.status],
    );
    for (const existing of superseded) clearTimer(existing.id);
    alerts = [alert, ...alerts.filter((existing) => !superseded.includes(existing))];
  }

  function persist(): void {
    alerts = prune(alerts, adapters.now().getTime());
    const document = { version: FILE_VERSION, settings, alerts };
    adapters.writeFile(limitAlertsPath(adapters), `${JSON.stringify(document, null, 2)}\n`);
  }

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(id);
  }

  function armTimer(id: string, fireAt: number): void {
    clearTimer(id);
    if (Number.isNaN(fireAt)) return;
    const delay = Math.max(0, fireAt - adapters.now().getTime());
    if (delay <= MAX_TIMEOUT_MS) {
      timers.set(
        id,
        setTimeout(() => {
          void fireResume(id);
        }, delay),
      );
      return;
    }
    timers.set(
      id,
      setTimeout(() => armTimer(id, fireAt), MAX_TIMEOUT_MS),
    );
  }

  async function fireResume(id: string): Promise<void> {
    timers.delete(id);
    const alert = findAlert(id);
    if (alert === null || alert.status !== "resume_scheduled" || alert.resume === null) return;
    const paseo = timerPaseo;
    if (paseo === null) return;
    try {
      await paseo.agents.ref(alert.agentId).send(alert.resume.prompt);
      updateAlert({ ...alert, status: "resumed" });
    } catch {
      // The agent may be gone or busy. Hand the decision back to the user.
      updateAlert({ ...alert, status: "open", resume: null });
    }
    persist();
  }

  async function fallbackResetAt(usageProviderId: string | null): Promise<string | null> {
    if (usageProviderId === null) return null;
    let snapshot: UsageSnapshot;
    try {
      snapshot = await adapters.readLimits();
    } catch {
      return null;
    }
    const provider = snapshot.providers.find(
      (candidate) => candidate.providerId === usageProviderId,
    );
    if (provider === undefined) return null;

    let earliest: number | null = null;
    let instant: string | null = null;
    for (const reading of provider.readings) {
      if (reading.kind !== "quota") continue;
      const candidate = reading.window?.resetsAt ?? null;
      if (candidate === null) continue;
      const parsed = Date.parse(candidate);
      if (Number.isNaN(parsed)) continue;
      if (earliest === null || parsed < earliest) {
        earliest = parsed;
        instant = candidate;
      }
    }
    return instant;
  }

  /** A handle from `ref()` carries no snapshot until it is refreshed. */
  async function currentModel(paseo: PaseoApi, agentId: string): Promise<string | null> {
    try {
      const handle = paseo.agents.ref(agentId);
      await handle.refresh();
      return handle.current()?.model ?? null;
    } catch {
      return null;
    }
  }

  function start(paseo: PaseoApi): void {
    timerPaseo = paseo;
    for (const alert of alerts) {
      if (alert.status === "resume_scheduled" && alert.resume !== null) {
        armTimer(alert.id, Date.parse(alert.resume.scheduledFor));
      }
    }
  }

  async function record(event: LimitAlertTurnEvent, paseo: PaseoApi): Promise<LimitAlert | null> {
    if (!settings.enabled) return null;
    if (event.outcome.kind === "canceled") return null;
    start(paseo);

    const now = adapters.now();
    const detection = detectionFor(event, now);
    if (detection === null) return null;

    const model = await currentModel(paseo, event.agent.id);
    const usageProviderId = usageProviderIdFor(event.agent.provider, model);
    const limitKind = limitKindFor(event.agent.provider, model);
    // A balance has no window to wait for: only a top-up moves it, so a reset
    // time borrowed from a quota card would be a promise the vendor never made.
    const resetsAt =
      limitKind === "balance"
        ? null
        : (detection.resetsAt ?? (await fallbackResetAt(usageProviderId)));

    const alert: LimitAlert = {
      id: adapters.randomId(),
      agentId: event.agent.id,
      workspaceId: event.agent.workspaceId,
      agentProvider: event.agent.provider,
      providerLabel:
        vendorLabelFor(event.agent.provider, model) ??
        providerLabelFor(event.agent.provider, model),
      usageProviderId,
      message: detection.message,
      detectedAt: now.toISOString(),
      resetsAt,
      resetUrl: resetUrlFor(event.agent.provider, model),
      limitKind: limitKind ?? undefined,
      topUpUrl: topUpUrlFor(event.agent.provider, model),
      lastUserMessage: lastUserMessage(event.timeline),
      cwd: event.agent.cwd,
      title: event.agent.title,
      status: "open",
      resume: null,
      handoff: null,
    };
    replaceAlert(alert);
    persist();

    const handoffProvider = settings.handoffProvider;
    if (settings.autoHandoff && handoffProvider !== null) {
      await handOff(alert.id, handoffProvider, undefined, paseo);
    } else if (settings.autoResume && alert.resetsAt !== null) {
      scheduleResume(alert.id, undefined, undefined, true);
    }
    return findAlert(alert.id);
  }

  function list(agentId?: string): LimitAlert[] {
    const source = agentId === undefined ? alerts : alerts.filter((a) => a.agentId === agentId);
    const copies: LimitAlert[] = [];
    for (const alert of source) copies.push({ ...alert });
    return copies;
  }

  function dismiss(id: string): LimitAlert {
    const alert = requireAlert(id);
    clearTimer(id);
    const updated: LimitAlert = { ...alert, status: "dismissed", resume: null };
    updateAlert(updated);
    persist();
    return { ...updated };
  }

  function scheduleResume(id: string, at?: string, prompt?: string, automatic = false): LimitAlert {
    const alert = requireAlert(id);
    const target = at ?? alert.resetsAt;
    if (target === null || target === undefined) throw new Error(UNKNOWN_RESET);
    const instant = Date.parse(target);
    if (Number.isNaN(instant)) throw new Error(`Reset time "${target}" is not a valid instant`);

    const updated: LimitAlert = {
      ...alert,
      status: "resume_scheduled",
      resume: {
        scheduledFor: new Date(instant).toISOString(),
        prompt: prompt ?? resumePrompt(alert),
        automatic,
      },
      handoff: null,
    };
    updateAlert(updated);
    armTimer(id, instant);
    persist();
    return { ...updated };
  }

  function cancelResume(id: string): LimitAlert {
    const alert = requireAlert(id);
    clearTimer(id);
    const updated: LimitAlert = { ...alert, status: "open", resume: null };
    updateAlert(updated);
    persist();
    return { ...updated };
  }

  async function handOff(
    id: string,
    provider: string,
    modeId: string | undefined,
    paseo: PaseoApi,
  ): Promise<LimitAlert> {
    const alert = requireAlert(id);
    if (alert.cwd === null || alert.cwd === undefined || alert.cwd.length === 0) {
      throw new Error(`${MISSING_HANDOFF_DIRECTORY}: ${id}`);
    }
    const handle = await paseo.agents.create({
      config: { provider, ...(modeId === undefined ? {} : { modeId }) },
      cwd: alert.cwd,
      title: `${alert.title ?? "Agent"} (handoff)`,
      prompt: handoffPrompt(alert),
    });

    clearTimer(id);
    const updated: LimitAlert = {
      ...alert,
      status: "handed_off",
      resume: null,
      handoff: {
        agentId: handle.id,
        provider,
        createdAt: adapters.now().toISOString(),
      },
    };
    updateAlert(updated);
    persist();
    return { ...updated };
  }

  function readSettings(): LimitAlertSettings {
    return { ...settings };
  }

  function writeSettings(partial: Partial<LimitAlertSettings>): LimitAlertSettings {
    settings = {
      enabled: partial.enabled ?? settings.enabled,
      autoResume: partial.autoResume ?? settings.autoResume,
      handoffProvider:
        partial.handoffProvider !== undefined ? partial.handoffProvider : settings.handoffProvider,
      autoHandoff: partial.autoHandoff ?? settings.autoHandoff,
      toast: partial.toast ?? settings.toast,
    };
    persist();
    return { ...settings };
  }

  function close(): void {
    for (const id of timers.keys()) clearTimer(id);
    timerPaseo = null;
  }

  return {
    start,
    record,
    list,
    dismiss,
    scheduleResume,
    cancelResume,
    handOff,
    readSettings,
    writeSettings,
    close,
  };
}
