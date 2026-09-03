import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConfigAdapters, ConfigFileRead } from "./config.server";
import {
  createNodeUsageConfigStoreAdapters,
  listUsagePresetSummaries,
  readUsageConfigState,
  removeUsageProviderEntry,
  testUsageProviderEntry,
  type UsageConfigStoreAdapters,
  usageSecretsPath,
  writeUsageProviderEntry,
} from "./config-store.server";
import { UsageConfigError, UsageSourceError } from "./errors.server";
import {
  createNodeReadingStoreAdapters,
  createReadingStore,
  readingStorePath,
  type ReadingStore,
  type StoredReading,
} from "./reading-store.server";

const TEST_ROOT = mkdtempSync(path.join(os.tmpdir(), "usage-config-store-suite-"));
const HOME = path.join(TEST_ROOT, "home");
const NOW = new Date("2026-08-29T12:00:00.000Z");
const PASEO_HOME = path.join(TEST_ROOT, "paseo-home");
const CONFIG_PATH = path.join(HOME, ".paseo", "usage-limits.json");
const SECRETS_PATH = path.join(HOME, ".paseo", "usage-limits.secrets.json");

beforeEach(() => {
  vi.stubEnv("PASEO_HOME", PASEO_HOME);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(PASEO_HOME, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

interface MemoryStoreOptions {
  failRenameTo?: string;
  sourceDocument?: unknown;
  sourceError?: UsageSourceError;
  readings?: ReadingStore;
}

interface MemoryStore {
  adapters: UsageConfigStoreAdapters;
  files: Map<string, string>;
  modes: Map<string, number>;
}

function createMemoryStore(
  initial: Record<string, string> = {},
  options: MemoryStoreOptions = {},
): MemoryStore {
  const files = new Map(Object.entries(initial));
  const modes = new Map<string, number>();
  let suffix = 0;
  const env: NodeJS.ProcessEnv = {};
  const storedReadings = new Map<string, StoredReading>();
  const readings: ReadingStore = options.readings ?? {
    get(providerId) {
      return storedReadings.get(providerId) ?? null;
    },
    save(providerId, entry) {
      storedReadings.set(providerId, entry);
    },
  };
  const adapters: UsageConfigStoreAdapters = {
    env,
    homeDir: HOME,
    readConfigFile(target): ConfigFileRead {
      const text = files.get(target);
      return text === undefined ? { kind: "missing" } : { kind: "text", text };
    },
    readTextFile(target) {
      return files.get(target) ?? null;
    },
    createDirectory() {},
    writeTextFile(target, text, mode) {
      if (files.has(target)) throw new Error(`EEXIST: ${target}`);
      files.set(target, text);
      modes.set(target, mode);
    },
    renameFile(source, target) {
      if (options.failRenameTo === target) throw new Error(`EEXIST: ${target}`);
      const text = files.get(source);
      if (text === undefined) throw new Error(`ENOENT: ${source}`);
      const mode = modes.get(source);
      files.set(target, text);
      files.delete(source);
      if (mode !== undefined) modes.set(target, mode);
      modes.delete(source);
    },
    removeFile(target) {
      files.delete(target);
      modes.delete(target);
    },
    chmodFile(target, mode) {
      if (!files.has(target)) throw new Error(`ENOENT: ${target}`);
      modes.set(target, mode);
    },
    randomSuffix() {
      suffix += 1;
      return String(suffix);
    },
    source: {
      async fetchJson() {
        if (options.sourceError !== undefined) throw options.sourceError;
        return options.sourceDocument ?? {};
      },
      async runCommand() {
        if (options.sourceError !== undefined) throw options.sourceError;
        return options.sourceDocument ?? {};
      },
      async probeAntigravity() {
        if (options.sourceError !== undefined) throw options.sourceError;
        return options.sourceDocument ?? {};
      },
    },
    credentials: {
      env,
      homeDir: HOME,
      readTextFile(target) {
        return files.get(target) ?? null;
      },
      now: () => NOW,
    },
    readings,
    now: () => new Date("2026-08-28T12:00:00.000Z"),
  };
  return { adapters, files, modes };
}

function parseFile(store: MemoryStore, target: string): unknown {
  const text = store.files.get(target);
  if (text === undefined) throw new Error(`Missing test file ${target}`);
  return JSON.parse(text);
}

describe("usage config state", () => {
  test("derives preset summaries, credential hints, and verification from USAGE_PRESETS", () => {
    const summaries = listUsagePresetSummaries();
    const deepseek = summaries.find((preset) => preset.id === "deepseek");
    const antigravity = summaries.find((preset) => preset.id === "antigravity");

    expect(deepseek).toMatchObject({
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/user/balance",
      credentialNames: ["apiKey"],
      credentialHints: ["env DEEPSEEK_API_KEY"],
      unverified: false,
    });
    expect(antigravity).toEqual({
      id: "antigravity",
      label: "Antigravity",
      description:
        "Unverified: Google publishes no Antigravity quota API, so this reads the user's own stored credential and calls an undocumented endpoint, and may break without notice.",
      unverified: true,
      credentialNames: [],
      credentialHints: [],
      endpoint: "Antigravity probe",
    });
  });

  test("reports stored credential names without returning their values", () => {
    const store = createMemoryStore({
      [CONFIG_PATH]: JSON.stringify({ deepseek: { preset: "deepseek" } }),
      [SECRETS_PATH]: JSON.stringify({ deepseek: { apiKey: "not-returned" } }),
    });
    const state = readUsageConfigState(store.adapters);
    expect(state.storedSecrets).toEqual({ deepseek: ["apiKey"] });
    expect(JSON.stringify(state)).not.toContain("not-returned");
  });
});

describe("writeUsageProviderEntry", () => {
  test("preserves every other configured provider", () => {
    const store = createMemoryStore({
      [CONFIG_PATH]: JSON.stringify({
        claude: { preset: "claude", refreshIntervalMs: 600_000 },
        local: {
          label: "Local",
          readings: [{ kind: "balance", id: "funds", label: "Funds", unit: "usd" }],
        },
      }),
    });
    writeUsageProviderEntry(
      { id: "deepseek", entry: { preset: "deepseek" }, secrets: {} },
      store.adapters,
    );
    expect(parseFile(store, CONFIG_PATH)).toEqual({
      claude: { preset: "claude", refreshIntervalMs: 600_000 },
      local: {
        label: "Local",
        readings: [{ kind: "balance", id: "funds", label: "Funds", unit: "usd" }],
      },
      deepseek: { preset: "deepseek" },
    });
  });

  test("stores a secret and references it after the preset environment source", () => {
    const store = createMemoryStore({ [CONFIG_PATH]: "{}" });
    writeUsageProviderEntry(
      {
        id: "deepseek",
        entry: { preset: "deepseek" },
        secrets: { apiKey: "sk-test-secret" },
      },
      store.adapters,
    );

    expect(parseFile(store, SECRETS_PATH)).toEqual({
      deepseek: { apiKey: "sk-test-secret" },
    });
    expect(parseFile(store, CONFIG_PATH)).toEqual({
      deepseek: {
        preset: "deepseek",
        credentials: {
          apiKey: [
            { kind: "env", variable: "DEEPSEEK_API_KEY" },
            {
              kind: "jsonFile",
              file: SECRETS_PATH,
              path: "deepseek.apiKey",
            },
          ],
        },
      },
    });
  });

  test("creates the real secrets file with mode 0600", () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "usage-config-store-"));
    const config: ConfigAdapters = {
      env: { PASEO_HOME: scratch },
      homeDir: scratch,
      readConfigFile(target) {
        try {
          return { kind: "text", text: readFileSync(target, "utf8") };
        } catch (cause) {
          const code = cause instanceof Error && "code" in cause ? cause.code : null;
          if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
          throw cause;
        }
      },
    };
    try {
      const adapters = createNodeUsageConfigStoreAdapters(config);
      writeUsageProviderEntry(
        {
          id: "deepseek",
          entry: { preset: "deepseek" },
          secrets: { apiKey: "sk-permissions" },
        },
        adapters,
      );
      expect(statSync(usageSecretsPath(adapters)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("an empty secret clears its value and removes the jsonFile source", () => {
    const store = createMemoryStore({ [CONFIG_PATH]: "{}" });
    writeUsageProviderEntry(
      {
        id: "deepseek",
        entry: { preset: "deepseek" },
        secrets: { apiKey: "sk-remove-me" },
      },
      store.adapters,
    );
    writeUsageProviderEntry(
      { id: "deepseek", entry: { preset: "deepseek" }, secrets: { apiKey: "" } },
      store.adapters,
    );

    expect(parseFile(store, SECRETS_PATH)).toEqual({});
    expect(parseFile(store, CONFIG_PATH)).toEqual({
      deepseek: {
        preset: "deepseek",
        credentials: { apiKey: [{ kind: "env", variable: "DEEPSEEK_API_KEY" }] },
      },
    });
  });

  test("preserves an untouched stored secret while editing provider fields", () => {
    const store = createMemoryStore({ [CONFIG_PATH]: "{}" });
    writeUsageProviderEntry(
      {
        id: "deepseek",
        entry: { preset: "deepseek" },
        secrets: { apiKey: "sk-keep-me" },
      },
      store.adapters,
    );
    writeUsageProviderEntry(
      {
        id: "deepseek",
        entry: {
          preset: "deepseek",
          source: {
            kind: "http",
            url: "https://api.deepseek.com/user/balance",
            method: "GET",
            headers: { Authorization: "Bearer ${apiKey}" },
          },
        },
        secrets: {},
      },
      store.adapters,
    );

    expect(readUsageConfigState(store.adapters).storedSecrets).toEqual({
      deepseek: ["apiKey"],
    });
    expect(parseFile(store, CONFIG_PATH)).toMatchObject({
      deepseek: {
        credentials: {
          apiKey: [
            { kind: "env", variable: "DEEPSEEK_API_KEY" },
            { kind: "jsonFile", file: SECRETS_PATH, path: "deepseek.apiKey" },
          ],
        },
      },
    });
  });

  test("rejects invalid ids and half-filled entries before writing", () => {
    const store = createMemoryStore({ [CONFIG_PATH]: "{}" });
    expect(() =>
      writeUsageProviderEntry(
        { id: "Bad Id", entry: { preset: "deepseek" }, secrets: {} },
        store.adapters,
      ),
    ).toThrow(UsageConfigError);
    expect(() =>
      writeUsageProviderEntry(
        { id: "half", entry: { label: "Half" }, secrets: {} },
        store.adapters,
      ),
    ).toThrow(UsageConfigError);
    expect(store.files.get(CONFIG_PATH)).toBe("{}");
  });

  test("leaves the original file complete and removes the temporary file when rename fails", () => {
    const original = JSON.stringify({ claude: { preset: "claude" } });
    const store = createMemoryStore({ [CONFIG_PATH]: original }, { failRenameTo: CONFIG_PATH });
    expect(() =>
      writeUsageProviderEntry(
        { id: "deepseek", entry: { preset: "deepseek" }, secrets: {} },
        store.adapters,
      ),
    ).toThrow(UsageConfigError);
    expect(store.files.get(CONFIG_PATH)).toBe(original);
    expect([...store.files.keys()].filter((target) => target.endsWith(".tmp"))).toEqual([]);
  });
});

describe("removeUsageProviderEntry", () => {
  test("drops the provider and all of its stored secrets", () => {
    const store = createMemoryStore({
      [CONFIG_PATH]: JSON.stringify({
        deepseek: { preset: "deepseek" },
        claude: { preset: "claude" },
      }),
      [SECRETS_PATH]: JSON.stringify({
        deepseek: { apiKey: "gone" },
        claude: { token: "kept" },
      }),
    });
    removeUsageProviderEntry("deepseek", store.adapters);
    expect(parseFile(store, CONFIG_PATH)).toEqual({ claude: { preset: "claude" } });
    expect(parseFile(store, SECRETS_PATH)).toEqual({ claude: { token: "kept" } });
  });
});

describe("testUsageProviderEntry", () => {
  test("returns both DeepSeek balance readings through the one-provider service", async () => {
    const readingAdapters = createNodeReadingStoreAdapters();
    const resolvedStorePath = readingStorePath(readingAdapters);
    const relativeStorePath = path.relative(TEST_ROOT, resolvedStorePath);
    const escapesTestRoot =
      relativeStorePath === ".." || relativeStorePath.startsWith(`..${path.sep}`);
    expect(path.isAbsolute(relativeStorePath)).toBe(false);
    expect(escapesTestRoot).toBe(false);
    const readings = createReadingStore(readingAdapters, {
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });
    const store = createMemoryStore(
      { [CONFIG_PATH]: "{}" },
      {
        sourceDocument: {
          balance_infos: [{ total_balance: "12.34", granted_balance: "2.50", currency: "USD" }],
        },
        readings,
      },
    );
    writeUsageProviderEntry(
      {
        id: "deepseek",
        entry: { preset: "deepseek" },
        secrets: { apiKey: "sk-test-secret" },
      },
      store.adapters,
    );
    await expect(testUsageProviderEntry("deepseek", store.adapters)).resolves.toEqual({
      ok: true,
      message: "Provider returned 2 readings: balance, granted",
      readingCount: 2,
    });
  });

  test("projects the four observed Antigravity probe buckets without a configured credential", async () => {
    const store = createMemoryStore(
      { [CONFIG_PATH]: "{}" },
      {
        sourceDocument: {
          buckets: [
            {
              id: "gemini-5h",
              label: "Session",
              group: "Gemini Models",
              usedPercent: 9.23,
            },
            {
              id: "gemini-weekly",
              label: "Weekly",
              group: "Gemini Models",
              usedPercent: 25.06,
            },
            {
              id: "3p-5h",
              label: "Session",
              group: "Claude and GPT models",
              usedPercent: 0,
            },
            {
              id: "3p-weekly",
              label: "Weekly",
              group: "Claude and GPT models",
              usedPercent: 0,
            },
          ],
        },
      },
    );
    writeUsageProviderEntry(
      { id: "antigravity", entry: { preset: "antigravity" }, secrets: {} },
      store.adapters,
    );

    await expect(testUsageProviderEntry("antigravity", store.adapters)).resolves.toEqual({
      ok: true,
      message:
        "Provider returned 4 readings: bucket-gemini-5h, bucket-gemini-weekly, bucket-3p-5h, bucket-3p-weekly",
      readingCount: 4,
    });
  });

  test("reports a rejected deliberately invalid DeepSeek key without crashing", async () => {
    const store = createMemoryStore(
      { [CONFIG_PATH]: "{}" },
      {
        sourceError: new UsageSourceError("GET request to api.deepseek.com failed with HTTP 401"),
      },
    );
    writeUsageProviderEntry(
      {
        id: "deepseek",
        entry: { preset: "deepseek" },
        secrets: { apiKey: "sk-deliberately-invalid" },
      },
      store.adapters,
    );
    await expect(testUsageProviderEntry("deepseek", store.adapters)).resolves.toEqual({
      ok: false,
      message:
        "The stored credential was rejected (HTTP 401), and no earlier reading is stored yet. Replace the stored key from the Usage providers screen.",
      readingCount: 0,
    });
  });
});
