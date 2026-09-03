import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type ConfigAdapters,
  createNodeConfigAdapters,
  loadUsageConfig,
  usageConfigPath,
} from "./config.server";
import { createNodeCredentialAdapters, type CredentialAdapters } from "./credentials.server";
import { UsageConfigError } from "./errors.server";
import type { UsageConfigState, UsagePresetSummary, UsageProviderWrite } from "./config.shared";
import {
  USAGE_PROVIDER_ID_PATTERN,
  type UsageCredentialSource,
  type UsageProviderOverride,
  type UsageProviderOverrides,
  type UsageSource,
  UsageProviderOverrideSchema,
} from "./limits.shared";
import { getUsagePreset, listUsagePresetIds, USAGE_PRESETS } from "./presets.shared";
import {
  createNodeReadingStoreAdapters,
  createReadingStore,
  type ReadingStore,
} from "./reading-store.server";
import { buildProviderRegistry } from "./registry.server";
import { createUsageService } from "./service.server";
import { createNodeSourceAdapters, type UsageSourceAdapters } from "./source.server";

const StoredSecretsSchema = z.record(z.string(), z.record(z.string(), z.string()));

type StoredSecrets = z.infer<typeof StoredSecretsSchema>;

export interface UsageConfigStoreAdapters extends ConfigAdapters {
  readTextFile(target: string): string | null;
  createDirectory(target: string): void;
  writeTextFile(target: string, text: string, mode: number): void;
  renameFile(source: string, target: string): void;
  removeFile(target: string): void;
  chmodFile(target: string, mode: number): void;
  randomSuffix(): string;
  source: UsageSourceAdapters;
  credentials: CredentialAdapters;
  readings: ReadingStore;
  now(): Date;
}

function readOptionalFile(target: string): string | null {
  try {
    return readFileSync(target, "utf8");
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : null;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw cause;
  }
}

export function createNodeUsageConfigStoreAdapters(
  config: ConfigAdapters = createNodeConfigAdapters(),
): UsageConfigStoreAdapters {
  const credentialDefaults = createNodeCredentialAdapters();
  const readingDefaults = createNodeReadingStoreAdapters();
  return {
    ...config,
    readTextFile: readOptionalFile,
    createDirectory(target) {
      mkdirSync(target, { recursive: true, mode: 0o700 });
    },
    writeTextFile(target, text, mode) {
      writeFileSync(target, text, { encoding: "utf8", mode, flag: "wx" });
    },
    renameFile: renameSync,
    removeFile(target) {
      rmSync(target, { force: true });
    },
    chmodFile: chmodSync,
    randomSuffix: randomUUID,
    source: createNodeSourceAdapters(),
    credentials: {
      ...credentialDefaults,
      env: config.env,
      homeDir: config.homeDir,
    },
    readings: createReadingStore({
      ...readingDefaults,
      env: config.env,
      homeDir: config.homeDir,
    }),
    now: () => new Date(),
  };
}

export function usageSecretsPath(adapters: ConfigAdapters): string {
  return path.join(path.dirname(usageConfigPath(adapters)), "usage-limits.secrets.json");
}

function describeCredentialSource(source: UsageCredentialSource): string {
  if (source.kind === "env") return `env ${source.variable}`;
  return `file ${source.file}#${source.path}`;
}

function describeEndpoint(source: UsageSource | undefined): string | null {
  if (source === undefined || source.kind === "command") return null;
  if (source.kind === "http") return source.url;
  if (source.kind === "file") {
    // A hint is read before anything expands, so prefer a candidate that reads
    // the same on screen as on disk over one naming a variable.
    return source.files.find((file) => !file.includes("${")) ?? source.files[0] ?? null;
  }
  const name = source.probe.replaceAll("-", " ");
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} probe`;
}

export function listUsagePresetSummaries(): UsagePresetSummary[] {
  return listUsagePresetIds().map((id) => {
    const preset = USAGE_PRESETS[id];
    if (preset === undefined) {
      throw new UsageConfigError(`Built-in usage preset "${id}" is unavailable`);
    }
    const credentialNames = Object.keys(preset.credentials);
    const credentialHints = Object.values(preset.credentials).flatMap((sources) =>
      sources.map(describeCredentialSource),
    );
    const endpoint = describeEndpoint(preset.source);
    return {
      id,
      label: preset.label,
      description: preset.description ?? null,
      unverified: preset.unverified,
      credentialNames,
      credentialHints,
      endpoint,
    };
  });
}

function readStoredSecrets(adapters: UsageConfigStoreAdapters): StoredSecrets {
  const target = usageSecretsPath(adapters);
  let text: string | null;
  try {
    text = adapters.readTextFile(target);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new UsageConfigError(`Usage limits secrets at ${target} could not be read: ${detail}`, {
      cause,
    });
  }
  if (text === null) return {};

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new UsageConfigError(`Usage limits secrets at ${target} are not valid JSON`, { cause });
  }
  const parsed = StoredSecretsSchema.safeParse(document);
  if (!parsed.success) {
    throw new UsageConfigError(`Usage limits secrets at ${target} have an invalid structure`);
  }
  return parsed.data;
}

function listStoredSecretNames(secrets: StoredSecrets): Record<string, string[]> {
  const stored: Record<string, string[]> = {};
  for (const [providerId, values] of Object.entries(secrets)) {
    const names = Object.entries(values)
      .filter(([, value]) => value.length > 0)
      .map(([name]) => name);
    if (names.length > 0) stored[providerId] = names;
  }
  return stored;
}

export function readUsageConfigState(adapters: UsageConfigStoreAdapters): UsageConfigState {
  const secrets = readStoredSecrets(adapters);
  return {
    configPath: usageConfigPath(adapters),
    secretsPath: usageSecretsPath(adapters),
    providers: loadUsageConfig(adapters),
    presets: listUsagePresetSummaries(),
    storedSecrets: listStoredSecretNames(secrets),
  };
}

function validateProviderWrite(input: UsageProviderWrite): UsageProviderOverride {
  if (!USAGE_PROVIDER_ID_PATTERN.test(input.id)) {
    throw new UsageConfigError(
      `Usage provider id "${input.id}" must start with a lowercase letter and contain only lowercase letters, numbers, or hyphens`,
    );
  }
  const parsed = UsageProviderOverrideSchema.safeParse(input.entry);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`)
      .join("; ");
    throw new UsageConfigError(`Usage provider "${input.id}" is invalid — ${detail}`);
  }
  const hasCompleteDefinition =
    parsed.data.label !== undefined && parsed.data.readings !== undefined;
  if (parsed.data.preset === undefined && !hasCompleteDefinition) {
    throw new UsageConfigError(
      `Usage provider "${input.id}" needs either a preset or both a label and at least one reading`,
    );
  }
  return parsed.data;
}

function isSameSource(left: UsageCredentialSource, right: UsageCredentialSource): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "env" && right.kind === "env") return left.variable === right.variable;
  if (left.kind === "jsonFile" && right.kind === "jsonFile") {
    return left.file === right.file && left.path === right.path;
  }
  return false;
}

function storedSource(
  providerId: string,
  name: string,
  secretsPath: string,
): UsageCredentialSource {
  return { kind: "jsonFile", file: secretsPath, path: `${providerId}.${name}` };
}

function withoutSource(
  sources: readonly UsageCredentialSource[],
  source: UsageCredentialSource,
): UsageCredentialSource[] {
  return sources.filter((candidate) => !isSameSource(candidate, source));
}

function uniqueSources(sources: readonly UsageCredentialSource[]): UsageCredentialSource[] {
  const unique: UsageCredentialSource[] = [];
  for (const source of sources) {
    if (!unique.some((candidate) => isSameSource(candidate, source))) unique.push(source);
  }
  return unique;
}

function withSecretSources(
  providerId: string,
  entry: UsageProviderOverride,
  currentEntry: UsageProviderOverride | undefined,
  secretValues: Record<string, string>,
  secretsPath: string,
): UsageProviderOverride {
  const credentials = { ...entry.credentials };
  const preset = entry.preset === undefined ? null : getUsagePreset(entry.preset);

  for (const [name, value] of Object.entries(secretValues)) {
    const stored = storedSource(providerId, name, secretsPath);
    if (value === "") {
      const configured = credentials[name] ?? currentEntry?.credentials?.[name] ?? [];
      const remaining = withoutSource(configured, stored);
      if (remaining.length === 0) delete credentials[name];
      else credentials[name] = remaining;
      continue;
    }

    const effective =
      credentials[name] ?? currentEntry?.credentials?.[name] ?? preset?.credentials[name] ?? [];
    const presetEnvironment = (preset?.credentials[name] ?? []).filter(
      (source) => source.kind === "env",
    );
    const remaining = withoutSource(effective, stored);
    credentials[name] = uniqueSources([...presetEnvironment, ...remaining, stored]);
  }

  if (Object.keys(credentials).length === 0) {
    const { credentials: omitted, ...withoutCredentials } = entry;
    void omitted;
    return withoutCredentials;
  }
  return { ...entry, credentials };
}

function updateSecrets(
  current: StoredSecrets,
  providerId: string,
  values: Record<string, string>,
): StoredSecrets {
  const next = { ...current };
  const provider = { ...next[providerId] };
  for (const [name, value] of Object.entries(values)) {
    if (value === "") delete provider[name];
    else provider[name] = value;
  }
  if (Object.keys(provider).length === 0) delete next[providerId];
  else next[providerId] = provider;
  return next;
}

function serialize(document: object): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function atomicWrite(
  target: string,
  text: string,
  mode: number,
  adapters: UsageConfigStoreAdapters,
): void {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${adapters.randomSuffix()}.tmp`,
  );
  adapters.createDirectory(directory);
  try {
    adapters.writeTextFile(temporary, text, mode);
    adapters.chmodFile(temporary, mode);
    adapters.renameFile(temporary, target);
  } catch (cause) {
    try {
      adapters.removeFile(temporary);
    } catch {
      // The original write error is the actionable failure.
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new UsageConfigError(`Usage limits file at ${target} could not be written: ${detail}`, {
      cause,
    });
  }
}

function writeConfig(providers: UsageProviderOverrides, adapters: UsageConfigStoreAdapters): void {
  atomicWrite(usageConfigPath(adapters), serialize(providers), 0o600, adapters);
}

function writeSecrets(secrets: StoredSecrets, adapters: UsageConfigStoreAdapters): void {
  atomicWrite(usageSecretsPath(adapters), serialize(secrets), 0o600, adapters);
}

export function writeUsageProviderEntry(
  input: UsageProviderWrite,
  adapters: UsageConfigStoreAdapters,
): UsageConfigState {
  const validated = validateProviderWrite(input);
  const providers = loadUsageConfig(adapters);
  const secrets = readStoredSecrets(adapters);
  const credentialValues = { ...secrets[input.id], ...input.secrets };
  const entry = withSecretSources(
    input.id,
    validated,
    providers[input.id],
    credentialValues,
    usageSecretsPath(adapters),
  );
  const nextProviders = { ...providers, [input.id]: entry };
  const nextSecrets = updateSecrets(secrets, input.id, input.secrets);

  if (Object.keys(input.secrets).length > 0) writeSecrets(nextSecrets, adapters);
  writeConfig(nextProviders, adapters);
  return readUsageConfigState(adapters);
}

export function removeUsageProviderEntry(
  id: string,
  adapters: UsageConfigStoreAdapters,
): UsageConfigState {
  if (!USAGE_PROVIDER_ID_PATTERN.test(id)) {
    throw new UsageConfigError(`Usage provider id "${id}" is invalid`);
  }
  const providers = loadUsageConfig(adapters);
  const nextProviders: UsageProviderOverrides = {};
  for (const [providerId, entry] of Object.entries(providers)) {
    if (providerId !== id) nextProviders[providerId] = entry;
  }
  const secrets = readStoredSecrets(adapters);
  const nextSecrets = { ...secrets };
  delete nextSecrets[id];

  writeConfig(nextProviders, adapters);
  writeSecrets(nextSecrets, adapters);
  return readUsageConfigState(adapters);
}

export interface UsageProviderTestResult {
  ok: boolean;
  message: string;
  readingCount: number;
}

export async function testUsageProviderEntry(
  id: string,
  adapters: UsageConfigStoreAdapters,
): Promise<UsageProviderTestResult> {
  const providers = loadUsageConfig(adapters);
  const entry = providers[id];
  if (entry === undefined) {
    throw new UsageConfigError(`Usage provider "${id}" is not configured`);
  }
  const entries = buildProviderRegistry({ [id]: entry });
  const service = createUsageService({
    entries,
    configPath: usageConfigPath(adapters),
    adapters: {
      source: adapters.source,
      credentials: adapters.credentials,
      readings: adapters.readings,
      now: adapters.now,
    },
  });
  const snapshot = await service.read({ refresh: true });
  const provider = snapshot.providers[0];
  if (provider === undefined) {
    return { ok: false, message: `Usage provider "${id}" returned no status`, readingCount: 0 };
  }
  const readingCount = provider.readings.length;
  if (provider.status === "ok" && provider.notice === null) {
    const names = provider.readings.map((reading) => reading.id).join(", ");
    const detail = names === "" ? "" : `: ${names}`;
    const noun = readingCount === 1 ? "reading" : "readings";
    return {
      ok: true,
      message: `Provider returned ${readingCount} ${noun}${detail}`,
      readingCount,
    };
  }
  if (provider.status === "disabled") {
    return { ok: false, message: "Provider is disabled", readingCount };
  }
  return {
    ok: false,
    message: provider.error ?? provider.notice ?? "Provider test failed",
    readingCount,
  };
}
