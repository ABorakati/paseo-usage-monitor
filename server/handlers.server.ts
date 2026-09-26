import type { PaseoApi } from "@getpaseo/client";
import { createCodexBankedResetService } from "./codex-reset.server";
import { createNodeConfigAdapters, loadUsageConfig, usageConfigPath } from "./config.server";
import {
  createNodeUsageConfigStoreAdapters,
  readUsageConfigState,
  removeUsageProviderEntry,
  testUsageProviderEntry,
  type UsageProviderTestResult,
  writeUsageProviderEntry,
} from "./config-store.server";
import type { UsageConfigState, UsageProviderWrite } from "../shared/config.shared";
import type { CodexBankedResetDetails } from "../shared/codex-reset.shared";
import type { ClaudeStatusLineStatus } from "../shared/claude-hook.shared";
import type { LimitAlert, LimitAlertSettings } from "../shared/limit-alerts.shared";
import { createClaudeHookService, createNodeClaudeHookAdapters } from "./claude-hook.server";
import { createNodeCredentialAdapters, expandPath } from "./credentials.server";
import { UsageInterpolationError } from "./errors.server";
import { createNodeHistoryAdapters, readUsageHistorySnapshot } from "./history.server";
import type { UsageHistoryQuery, UsageHistorySnapshot } from "../shared/history.shared";
import {
  createLimitAlertService,
  createNodeLimitAlertAdapters,
  type LimitAlertService,
  type LimitAlertTurnEvent,
} from "./limit-alerts.server";
import type { UsageSnapshot } from "../shared/limits.shared";
import {
  createLiveFileWatcher,
  createNodeLiveFileWatchAdapters,
  type LiveFileTarget,
} from "./live-file-watch.server";
import { buildProviderRegistry, type UsageProviderEntry } from "./registry.server";
import { createUsageService, type UsageService } from "./service.server";
import { createNodeReadingStoreAdapters, createReadingStore } from "./reading-store.server";
import { createNodeSourceAdapters } from "./source.server";

const configAdapters = createNodeConfigAdapters();
const credentialAdapters = createNodeCredentialAdapters();
const sourceAdapters = createNodeSourceAdapters();
const readingStore = createReadingStore(createNodeReadingStoreAdapters());
const historyAdapters = createNodeHistoryAdapters();
const configPath = usageConfigPath(configAdapters);
const configStoreAdapters = createNodeUsageConfigStoreAdapters(configAdapters);

interface ServiceCache {
  /** The config text the live service was built from, or null when the file was absent. */
  configText: string | null;
  service: UsageService;
  /** The file sources that service reads, resolved for the watcher. */
  liveTargets: LiveFileTarget[];
}

let cache: ServiceCache | null = null;

const liveFileWatcher = createLiveFileWatcher({
  adapters: createNodeLiveFileWatchAdapters(),
  onChanged(providerIds) {
    cache?.service.invalidate(providerIds);
  },
});

const claudeHookService = createClaudeHookService(createNodeClaudeHookAdapters());

/**
 * Every enabled provider that reads a local file, with the path the watcher
 * should sit on. A candidate whose variable is unset is skipped rather than
 * fatal: the provider will say so itself when it is read.
 */
function liveFileTargets(entries: readonly UsageProviderEntry[]): LiveFileTarget[] {
  const targets: LiveFileTarget[] = [];
  for (const entry of entries) {
    const provider = entry.provider;
    if (!provider?.enabled || provider.source?.kind !== "file") continue;
    for (const candidate of provider.source.files) {
      try {
        targets.push({ providerId: entry.id, path: expandPath(candidate, credentialAdapters) });
      } catch (error) {
        if (!(error instanceof UsageInterpolationError)) throw error;
      }
    }
  }
  return targets;
}

/**
 * Keyed on the config's own bytes rather than its mtime and size, so an edit
 * that preserves both still rebuilds. A read failure propagates as a
 * `UsageConfigError` instead of resolving to the defaults.
 */

function resolveService(): UsageService {
  const read = configAdapters.readConfigFile(configPath);
  const configText = read.kind === "text" ? read.text : null;
  if (cache !== null && cache.configText === configText) return cache.service;
  const entries = buildProviderRegistry(loadUsageConfig(configAdapters));
  const service = createUsageService({
    entries,
    configPath,
    adapters: {
      source: sourceAdapters,
      credentials: credentialAdapters,
      readings: readingStore,
      now: () => new Date(),
    },
  });
  cache = { configText, service, liveTargets: liveFileTargets(entries) };
  return service;
}

export function readLimits(input: { refresh: boolean }): Promise<UsageSnapshot> {
  const service = resolveService();
  // Cheap when the target set is unchanged, and the way a watch attaches once
  // the directory a file source names exists.
  liveFileWatcher.sync(cache?.liveTargets ?? []);
  return service.read({ refresh: input.refresh });
}

export function readHistory(query: UsageHistoryQuery): Promise<UsageHistorySnapshot> {
  return readUsageHistorySnapshot(query, historyAdapters);
}

export function readConfig(): UsageConfigState {
  return readUsageConfigState(configStoreAdapters);
}

/** A write changes the providers the next read builds, so the cached service goes. */
export function writeProvider(input: UsageProviderWrite): UsageConfigState {
  const state = writeUsageProviderEntry(input, configStoreAdapters);
  cache = null;
  return state;
}

export function removeProvider(input: { id: string }): UsageConfigState {
  const state = removeUsageProviderEntry(input.id, configStoreAdapters);
  cache = null;
  return state;
}

export function testProvider(input: { id: string }): Promise<UsageProviderTestResult> {
  return testUsageProviderEntry(input.id, configStoreAdapters);
}

export function readCodexBankedReset(input: {
  providerId: string;
}): Promise<CodexBankedResetDetails> {
  return createCodexBankedResetService({
    entries: buildProviderRegistry(loadUsageConfig(configAdapters)),
    source: sourceAdapters,
    credentials: credentialAdapters,
  }).read(input.providerId);
}

export function consumeCodexBankedReset(input: {
  providerId: string;
  creditId: string | null;
  redeemRequestId: string;
}) {
  return createCodexBankedResetService({
    entries: buildProviderRegistry(loadUsageConfig(configAdapters)),
    source: sourceAdapters,
    credentials: credentialAdapters,
  }).consume(input);
}

export function readStatusLine(): Promise<ClaudeStatusLineStatus> {
  return claudeHookService.read();
}

export function installStatusLine(): Promise<ClaudeStatusLineStatus> {
  return claudeHookService.install();
}

export function uninstallStatusLine(): Promise<ClaudeStatusLineStatus> {
  return claudeHookService.uninstall();
}

export function closeLiveFileWatcher(): void {
  liveFileWatcher.close();
}

/**
 * Built on first use rather than at import, so a daemon that never records a
 * limit and a test that only registers contracts both leave the real file
 * alone.
 */
let limitAlertService: LimitAlertService | null = null;

function limitAlerts(): LimitAlertService {
  if (limitAlertService === null) {
    limitAlertService = createLimitAlertService({
      ...createNodeLimitAlertAdapters(configAdapters),
      readLimits: () => readLimits({ refresh: false }),
    });
  }
  return limitAlertService;
}

/** Any entry point re-arms the store, so a reload's first RPC revives timers. */
function startedLimitAlerts(paseo: PaseoApi): LimitAlertService {
  const service = limitAlerts();
  service.start(paseo);
  return service;
}

export function recordLimitAlert(
  event: LimitAlertTurnEvent,
  paseo: PaseoApi,
): Promise<LimitAlert | null> {
  return limitAlerts().record(event, paseo);
}

export function readLimitAlerts(
  input: { agentId?: string },
  paseo: PaseoApi,
): { alerts: LimitAlert[] } {
  return { alerts: startedLimitAlerts(paseo).list(input.agentId) };
}

export function dismissLimitAlert(input: { id: string }, paseo: PaseoApi): { alert: LimitAlert } {
  return { alert: startedLimitAlerts(paseo).dismiss(input.id) };
}

export function scheduleLimitAlertResume(
  input: { id: string; at?: string; prompt?: string },
  paseo: PaseoApi,
): { alert: LimitAlert } {
  return { alert: startedLimitAlerts(paseo).scheduleResume(input.id, input.at, input.prompt) };
}

export function cancelLimitAlertResume(
  input: { id: string },
  paseo: PaseoApi,
): { alert: LimitAlert } {
  return { alert: startedLimitAlerts(paseo).cancelResume(input.id) };
}

export async function handOffLimitAlert(
  input: { id: string; provider: string; modeId?: string },
  paseo: PaseoApi,
): Promise<{ alert: LimitAlert }> {
  return {
    alert: await startedLimitAlerts(paseo).handOff(input.id, input.provider, input.modeId, paseo),
  };
}

export function readLimitAlertSettings(paseo: PaseoApi): LimitAlertSettings {
  return startedLimitAlerts(paseo).readSettings();
}

export function writeLimitAlertSettings(
  input: Partial<LimitAlertSettings>,
  paseo: PaseoApi,
): LimitAlertSettings {
  return startedLimitAlerts(paseo).writeSettings(input);
}

export function closeLimitAlerts(): void {
  limitAlertService?.close();
}
