import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  type ConfigAdapters,
  type ConfigFileRead,
  createNodeConfigAdapters,
  DEFAULT_USAGE_CONFIG,
  loadUsageConfig,
  usageConfigPath,
} from "./config.server";
import { UsageConfigError } from "./errors.server";

const HOME = path.join(path.sep, "home", "tester");

function createAdapters(
  files: Record<string, string>,
  env: NodeJS.ProcessEnv = {},
): ConfigAdapters {
  return {
    env,
    homeDir: HOME,
    readConfigFile: (target) => {
      const text = files[target];
      return text === undefined ? { kind: "missing" } : { kind: "text", text };
    },
  };
}

function createFailingAdapters(error: Error): ConfigAdapters {
  return {
    env: {},
    homeDir: HOME,
    readConfigFile: () => {
      throw error;
    },
  };
}

describe("usageConfigPath", () => {
  test("falls back to ~/.paseo when PASEO_HOME is unset", () => {
    expect(usageConfigPath(createAdapters({}))).toBe(
      path.join(HOME, ".paseo", "usage-limits.json"),
    );
  });

  test("honours PASEO_HOME", () => {
    const custom = path.join(path.sep, "srv", "paseo-home");
    expect(usageConfigPath(createAdapters({}, { PASEO_HOME: custom }))).toBe(
      path.join(custom, "usage-limits.json"),
    );
  });

  test("expands a leading ~ in PASEO_HOME", () => {
    expect(usageConfigPath(createAdapters({}, { PASEO_HOME: "~/paseo-alt" }))).toBe(
      path.join(HOME, "paseo-alt", "usage-limits.json"),
    );
  });

  test("ignores an empty PASEO_HOME", () => {
    expect(usageConfigPath(createAdapters({}, { PASEO_HOME: "" }))).toBe(
      path.join(HOME, ".paseo", "usage-limits.json"),
    );
  });
});

describe("loadUsageConfig", () => {
  test("returns the built-in default only when the file is genuinely missing", () => {
    expect(loadUsageConfig(createAdapters({}))).toEqual(DEFAULT_USAGE_CONFIG);
    expect(DEFAULT_USAGE_CONFIG).toEqual({
      claude: { preset: "claude" },
      codex: { preset: "codex" },
    });
  });

  test("round-trips a valid file", () => {
    const configPath = usageConfigPath(createAdapters({}));
    const config = {
      claude: { preset: "claude", refreshIntervalMs: 600_000 },
      house: {
        label: "House meter",
        readings: [{ kind: "quota", id: "session", label: "Session", unit: "percent" }],
      },
    };
    expect(loadUsageConfig(createAdapters({ [configPath]: JSON.stringify(config) }))).toEqual(
      config,
    );
  });

  test("keeps a deliberately empty config empty instead of falling back", () => {
    const configPath = usageConfigPath(createAdapters({}));
    expect(loadUsageConfig(createAdapters({ [configPath]: "{}" }))).toEqual({});
  });

  test("reads from PASEO_HOME rather than the default path", () => {
    const custom = path.join(path.sep, "srv", "paseo-home");
    const env = { PASEO_HOME: custom };
    const files = {
      [path.join(custom, "usage-limits.json")]: JSON.stringify({ codex: { preset: "codex" } }),
      [path.join(HOME, ".paseo", "usage-limits.json")]: JSON.stringify({
        claude: { preset: "claude" },
      }),
    };
    expect(loadUsageConfig(createAdapters(files, env))).toEqual({ codex: { preset: "codex" } });
  });

  test("propagates a read failure instead of activating the defaults", () => {
    const failure = new UsageConfigError(
      "Usage limits config at /home/tester/.paseo/usage-limits.json could not be read: EACCES: permission denied",
    );
    expect(() => loadUsageConfig(createFailingAdapters(failure))).toThrow(UsageConfigError);
    expect(() => loadUsageConfig(createFailingAdapters(failure))).toThrow(/EACCES/);
  });

  test("throws UsageConfigError naming the path when the JSON is malformed", () => {
    const configPath = usageConfigPath(createAdapters({}));
    const broken = createAdapters({ [configPath]: '{ "claude": ' });
    expect(() => loadUsageConfig(broken)).toThrow(UsageConfigError);
    expect(() => loadUsageConfig(broken)).toThrow(configPath);
  });

  test("throws UsageConfigError when an entry fails the schema", () => {
    const configPath = usageConfigPath(createAdapters({}));
    const incomplete = createAdapters({
      [configPath]: JSON.stringify({ house: { label: "House meter" } }),
    });
    expect(() => loadUsageConfig(incomplete)).toThrow(UsageConfigError);
    expect(() => loadUsageConfig(incomplete)).toThrow(/readings/);
  });

  test("throws UsageConfigError when a provider id is malformed", () => {
    const configPath = usageConfigPath(createAdapters({}));
    const badId = createAdapters({
      [configPath]: JSON.stringify({ "Bad Id": { preset: "claude" } }),
    });
    expect(() => loadUsageConfig(badId)).toThrow(UsageConfigError);
    expect(() => loadUsageConfig(badId)).toThrow(configPath);
  });
});

const scratch = mkdtempSync(path.join(os.tmpdir(), "usage-limits-config-"));
const runningAsRoot = process.getuid?.() === 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function readReal(target: string): ConfigFileRead {
  return createNodeConfigAdapters().readConfigFile(target);
}

describe("createNodeConfigAdapters", () => {
  test("reports the process environment and home directory", () => {
    const adapters = createNodeConfigAdapters();
    expect(adapters.env).toBe(process.env);
    expect(adapters.homeDir).toBe(os.homedir());
  });

  test("reads a file that exists", () => {
    const target = path.join(scratch, "present.json");
    writeFileSync(target, '{"codex":{"preset":"codex"}}');
    expect(readReal(target)).toEqual({ kind: "text", text: '{"codex":{"preset":"codex"}}' });
  });

  test("treats ENOENT as missing", () => {
    expect(readReal(path.join(scratch, "absent.json"))).toEqual({ kind: "missing" });
  });

  test("treats ENOTDIR as missing", () => {
    const file = path.join(scratch, "not-a-directory");
    writeFileSync(file, "x");
    expect(readReal(path.join(file, "usage-limits.json"))).toEqual({ kind: "missing" });
  });

  test("throws rather than defaulting when a directory sits at the config path", () => {
    const target = path.join(scratch, "directory.json");
    mkdirSync(target, { recursive: true });
    expect(() => readReal(target)).toThrow(UsageConfigError);
    expect(() => readReal(target)).toThrow(target);
  });

  test.skipIf(runningAsRoot)("throws naming the path and errno when the file is unreadable", () => {
    const target = path.join(scratch, "locked.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o000);
    expect(() => readReal(target)).toThrow(UsageConfigError);
    expect(() => readReal(target)).toThrow(target);
    expect(() => readReal(target)).toThrow(/EACCES|permission denied/);
    chmodSync(target, 0o600);
  });

  test.skipIf(runningAsRoot)("an unreadable config never yields the default providers", () => {
    const target = path.join(scratch, "locked-load.json");
    writeFileSync(target, JSON.stringify({ codex: { preset: "codex" } }));
    chmodSync(target, 0o000);
    const adapters: ConfigAdapters = {
      ...createNodeConfigAdapters(),
      env: { PASEO_HOME: scratch },
      homeDir: HOME,
    };
    expect(usageConfigPath(adapters)).toBe(path.join(scratch, "usage-limits.json"));
    writeFileSync(path.join(scratch, "usage-limits.json"), "{}");
    chmodSync(path.join(scratch, "usage-limits.json"), 0o000);
    expect(() => loadUsageConfig(adapters)).toThrow(UsageConfigError);
    chmodSync(target, 0o600);
    chmodSync(path.join(scratch, "usage-limits.json"), 0o600);
  });
});
