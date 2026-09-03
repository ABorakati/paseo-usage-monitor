import { createNodeConfigAdapters, loadUsageConfig, usageConfigPath } from "./config.server";
import {
  createNodeUsageConfigStoreAdapters,
  readUsageConfigState,
  removeUsageProviderEntry,
  testUsageProviderEntry,
  type UsageProviderTestResult,
  writeUsageProviderEntry,
} from "./config-store.server";
import type { UsageConfigState, UsageProviderWrite } from "./config.shared";
import { createNodeCredentialAdapters } from "./credentials.server";
import { createNodeHistoryAdapters, readUsageHistorySnapshot } from "./history.server";
import type { UsageHistoryQuery, UsageHistorySnapshot } from "./history.shared";
import type { UsageSnapshot } from "./limits.shared";
import { buildProviderRegistry } from "./registry.server";
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
}

let cache: ServiceCache | null = null;

/**
 * Keyed on the config's own bytes rather than its mtime and size, so an edit
 * that preserves both still rebuilds. A read failure propagates as a
 * `UsageConfigError` instead of resolving to the defaults.
 */
function resolveService(): UsageService {
  const read = configAdapters.readConfigFile(configPath);
  const configText = read.kind === "text" ? read.text : null;
  if (cache !== null && cache.configText === configText) return cache.service;
  const service = createUsageService({
    entries: buildProviderRegistry(loadUsageConfig(configAdapters)),
    configPath,
    adapters: {
      source: sourceAdapters,
      credentials: credentialAdapters,
      readings: readingStore,
      now: () => new Date(),
    },
  });
  cache = { configText, service };
  return service;
}

export function readLimits(input: { refresh: boolean }): Promise<UsageSnapshot> {
  return resolveService().read({ refresh: input.refresh });
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
