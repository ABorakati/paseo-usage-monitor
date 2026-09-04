import { USAGE_PRESETS } from "./presets.shared";
import { mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UsageRateLimitedError, UsageSourceError } from "./errors.server";
import { UsageProviderOverridesSchema, type UsageProviderSnapshot } from "./limits.shared";
import { buildProviderRegistry } from "./registry.server";
import {
  createNodeReadingStoreAdapters,
  createReadingStore,
  readingStorePath,
  type ReadingStore,
} from "./reading-store.server";
import { createUsageService, type UsageService } from "./service.server";
import type { UsageHttpRequest, UsageSourceAdapters } from "./source.server";

const CONFIG_PATH = "/home/tester/.paseo/usage-limits.json";
const HOME_DIR = "/home/tester";
const FIXED_NOW = Date.parse("2026-03-01T12:00:00Z");

/**
 * A service built without an injected store falls back to the on-disk one, and
 * that resolves against the live `process.env`. Every test in this file
 * therefore runs with `PASEO_HOME` pointed inside a temp root, and the guard
 * below refuses to let a single test proceed if the store would ever resolve
 * to the developer's real `~/.paseo` — writing synthetic readings there would
 * render to them as their own last known usage.
 */
const TEMP_ROOT = mkdtempSync(join(tmpdir(), "usage-limits-service-"));

function resolvedStorePath(): string {
  return readingStorePath({
    env: process.env,
    homeDir: homedir(),
    readTextFile: () => null,
    writeTextFile: () => {},
  });
}

function guardStorePath(): string {
  const path = resolvedStorePath();
  if (!path.startsWith(TEMP_ROOT)) {
    throw new Error(`the reading store would resolve to ${path}, outside ${TEMP_ROOT}`);
  }
  return path;
}

beforeEach(() => {
  vi.stubEnv("PASEO_HOME", TEMP_ROOT);
  guardStorePath();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface RecordedCommand {
  command: readonly string[];
  cwd: string | undefined;
}

interface FakeSource {
  adapters: UsageSourceAdapters;
  requests: UsageHttpRequest[];
  commands: RecordedCommand[];
}

function createFakeSource(handlers: {
  http?: (request: UsageHttpRequest) => Promise<unknown>;
  command?: (command: readonly string[], cwd: string | undefined) => Promise<unknown>;
}): FakeSource {
  const requests: UsageHttpRequest[] = [];
  const commands: RecordedCommand[] = [];
  return {
    requests,
    commands,
    adapters: {
      async fetchJson(request) {
        requests.push(request);
        if (!handlers.http) throw new Error("this provider must not issue an http request");
        return handlers.http(request);
      },
      async runCommand(command, cwd) {
        commands.push({ command, cwd });
        if (!handlers.command) throw new Error("this provider must not run a command");
        return handlers.command(command, cwd);
      },
    },
  };
}

function createClock(): { now: () => Date; advance: (ms: number) => void } {
  let currentMs = FIXED_NOW;
  return {
    now: () => new Date(currentMs),
    advance: (ms) => {
      currentMs += ms;
    },
  };
}

const STORE_ROOT = "/tmp/usage-limits-service-tests";
const STORE_PATH = `${STORE_ROOT}/usage-limits/last-readings.json`;

interface MemoryReadingStore {
  files: Record<string, string | undefined>;
  store: ReadingStore;
}

function createMemoryReadingStore(
  files: Record<string, string | undefined> = {},
  now: () => Date = () => new Date(FIXED_NOW),
): MemoryReadingStore {
  const norm = (p: string) => p.replace(/\\/g, "/");
  return {
    files,
    store: createReadingStore(
      {
        env: { PASEO_HOME: STORE_ROOT },
        homeDir: HOME_DIR,
        readTextFile: (path) => files[path] ?? files[norm(path)] ?? null,
        writeTextFile: (path, content) => {
          files[path] = content;
          files[norm(path)] = content;
        },
      },
      { now },
    ),
  };
}

function createService(params: {
  overrides: unknown;
  source: FakeSource;
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string | undefined>;
  now?: () => Date;
  store?: ReadingStore;
}): UsageService {
  const files = params.files ?? {};
  const now = params.now ?? (() => new Date(FIXED_NOW));
  const norm = (p: string) => p.replace(/\\/g, "/");
  return createUsageService({
    entries: buildProviderRegistry(UsageProviderOverridesSchema.parse(params.overrides)),
    configPath: CONFIG_PATH,
    adapters: {
      source: params.source.adapters,
      credentials: {
        env: params.env ?? {},
        homeDir: HOME_DIR,
        readTextFile: (path) => files[path] ?? files[norm(path)] ?? null,
        now,
      },
      now,
      readings: params.store ?? createMemoryReadingStore({}, now).store,
    },
  });
}

/** Keeps every assertion typed under `noUncheckedIndexedAccess`. */
function only<T>(items: readonly T[], what: string): T {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error(`expected one ${what}, found none`);
  if (rest.length > 0) throw new Error(`expected one ${what}, found ${items.length}`);
  return first;
}

function providerNamed(providers: readonly UsageProviderSnapshot[], id: string) {
  const found = providers.find((provider) => provider.providerId === id);
  if (!found) throw new Error(`snapshot has no provider "${id}"`);
  return found;
}

const COUNTER_READINGS = [
  { kind: "quota", id: "used", label: "Used", unit: "requests", usedPath: "used" },
];

const WINDOW_READINGS = [
  {
    kind: "quota",
    id: "session",
    label: "Session",
    unit: "requests",
    window: { label: "Session", resetsAtPath: "resets" },
    usedPath: "used",
    limitPath: "limit",
  },
];

const HTTP_SOURCE = { kind: "http", url: "https://example.test/usage" };

describe("usage service", () => {
  test("projects a quota reading with a window and derives the consumed percentage", async () => {
    const source = createFakeSource({
      http: async () => ({ google: { used: 250, limit: 1000, resets: "2026-03-01T17:00:00Z" } }),
    });
    const service = createService({
      source,
      env: { ANTIGRAVITY_TOKEN: "token-value" },
      overrides: {
        antigravity: {
          label: "Antigravity",
          credentials: { API_TOKEN: [{ kind: "env", variable: "ANTIGRAVITY_TOKEN" }] },
          source: {
            kind: "http",
            url: "https://example.test/usage",
            headers: { Authorization: "Bearer ${API_TOKEN}" },
          },
          readings: [
            {
              kind: "quota",
              id: "google-5h",
              label: "5 hours",
              group: "Google models",
              unit: "requests",
              window: { label: "5 hours", resetsAtPath: "google.resets" },
              usedPath: "google.used",
              limitPath: "google.limit",
            },
          ],
        },
      },
    });

    const snapshot = await service.read({ refresh: false });

    expect(snapshot).toEqual({
      configPath: CONFIG_PATH,
      providers: [
        {
          providerId: "antigravity",
          label: "Antigravity",
          description: null,
          unverified: false,
          status: "ok",
          error: null,
          notice: null,
          fetchedAt: "2026-03-01T12:00:00.000Z",
          display: {},
          icon: null,
          readings: [
            {
              kind: "quota",
              id: "google-5h",
              label: "5 hours",
              group: "Google models",
              unit: "requests",
              window: {
                label: "5 hours",
                resetsAt: "2026-03-01T17:00:00Z",
                durationMs: null,
              },
              used: 250,
              limit: 1000,
              remaining: 750,
              percent: 25,
            },
          ],
        },
      ],
    });
    expect(only(source.requests, "request")).toMatchObject({
      url: "https://example.test/usage",
      method: "GET",
      headers: { Authorization: "Bearer token-value" },
    });
  });

  test("reads a balance from numeric strings and reports the percentage still available", async () => {
    const source = createFakeSource({
      http: async () => ({
        balance_infos: [{ currency: "USD", total_balance: "12.50", granted_balance: "50.00" }],
      }),
    });
    const service = createService({
      source,
      overrides: {
        deepseek: {
          label: "DeepSeek",
          source: { kind: "http", url: "https://example.test/balance" },
          readings: [
            {
              kind: "balance",
              id: "balance",
              label: "Balance",
              unit: "usd",
              remainingPath: "balance_infos[0].total_balance",
              totalPath: "balance_infos[0].granted_balance",
              currencyPath: "balance_infos[0].currency",
            },
          ],
        },
      },
    });

    const snapshot = await service.read({ refresh: false });

    expect(only(snapshot.providers, "provider").readings).toEqual([
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        group: null,
        unit: "usd",
        remaining: 12.5,
        total: 50,
        percentRemaining: 25,
        currency: "USD",
      },
    ]);
  });

  test("resolves a schedule-driven rate without issuing any request", async () => {
    const source = createFakeSource({});
    const service = createService({
      source,
      overrides: {
        pricing: {
          label: "DeepSeek pricing",
          readings: [
            {
              kind: "rate",
              id: "band",
              label: "Pricing",
              resolution: {
                via: "schedule",
                schedule: {
                  windows: [{ label: "Off-peak", start: "16:30", end: "00:30", multiplier: 0.5 }],
                },
              },
            },
          ],
        },
      },
    });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider.status).toBe("ok");
    expect(provider.readings).toEqual([
      {
        kind: "rate",
        id: "band",
        label: "Pricing",
        group: null,
        state: "Standard",
        multiplier: 1,
        changesAt: "2026-03-01T16:30:00.000Z",
        detail: null,
      },
    ]);
    expect(source.requests).toHaveLength(0);
    expect(source.commands).toHaveLength(0);
  });

  test("reads the document a command source prints on stdout", async () => {
    const source = createFakeSource({ command: async () => ({ credits: { left: 4 } }) });
    const service = createService({
      source,
      overrides: {
        opencode: {
          label: "OpenCode",
          source: {
            kind: "command",
            command: ["opencode", "usage", "--json"],
            cwd: "/tmp/workspace",
          },
          readings: [
            {
              kind: "balance",
              id: "credits",
              label: "Credits",
              unit: "credits",
              remainingPath: "credits.left",
            },
          ],
        },
      },
    });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider.status).toBe("ok");
    expect(provider.readings).toMatchObject([{ kind: "balance", remaining: 4 }]);
    expect(source.commands).toEqual([
      { command: ["opencode", "usage", "--json"], cwd: "/tmp/workspace" },
    ]);
  });

  test("resolves a credential from a json file into a request header", async () => {
    const source = createFakeSource({ http: async () => ({ used: 1 }) });
    const service = createService({
      source,
      files: { "/home/tester/creds.json": JSON.stringify({ auth: { token: "file-token" } }) },
      overrides: {
        claude: {
          label: "Claude",
          credentials: {
            TOKEN: [
              { kind: "env", variable: "CLAUDE_TOKEN" },
              { kind: "jsonFile", file: "~/creds.json", path: "auth.token" },
            ],
          },
          source: {
            kind: "http",
            url: "https://example.test/usage",
            headers: { Authorization: "Bearer ${TOKEN}" },
          },
          readings: COUNTER_READINGS,
        },
      },
    });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider.status).toBe("ok");
    expect(only(source.requests, "request").headers).toEqual({
      Authorization: "Bearer file-token",
    });
  });

  test("reports every credential source tried when none resolves", async () => {
    const source = createFakeSource({ http: async () => ({ used: 1 }) });
    const service = createService({
      source,
      overrides: {
        vault: {
          label: "Vault",
          credentials: {
            TOKEN: [
              { kind: "env", variable: "VAULT_TOKEN" },
              { kind: "jsonFile", file: "~/vault.json", path: "auth.token" },
            ],
          },
          source: {
            kind: "http",
            url: "https://example.test/usage",
            headers: { Authorization: "Bearer ${TOKEN}" },
          },
          readings: COUNTER_READINGS,
        },
      },
    });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider.status).toBe("error");
    expect(provider.error).toContain("VAULT_TOKEN");
    expect(provider.error).toContain("vault.json");
    expect(provider.readings).toEqual([]);
    expect(source.requests).toHaveLength(0);
  });

  test("carries a display override and a custom icon through to the snapshot", async () => {
    const source = createFakeSource({
      http: async () => ({ balance_infos: [{ currency: "USD", total_balance: "12.34" }] }),
    });
    const service = createService({
      source,
      overrides: {
        deepseek: {
          preset: "deepseek",
          display: {
            order: 3,
            style: "ring",
            value: "remaining",
            icon: { kind: "image", uri: "https://example.com/logo.png" },
          },
        },
      },
    });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider.display).toMatchObject({ order: 3, style: "ring", value: "remaining" });
    expect(provider.icon).toEqual({ kind: "image", uri: "https://example.com/logo.png" });
  });

  test("falls back to the preset's own mark when no override sets one", async () => {
    const source = createFakeSource({
      http: async () => ({ balance_infos: [{ currency: "USD", total_balance: "12.34" }] }),
    });
    const service = createService({ source, overrides: { deepseek: { preset: "deepseek" } } });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    // deepseek ships a real logo, so the preset's own mark is the inlined image.
    expect(provider.icon).toEqual(USAGE_PRESETS.deepseek?.icon ?? null);
    expect(provider.icon).not.toBeNull();
  });

  test("reports an unknown preset as an error row instead of dropping the entry", async () => {
    const source = createFakeSource({});
    const service = createService({ source, overrides: { mystery: { preset: "does-not-exist" } } });

    const snapshot = await service.read({ refresh: false });

    expect(snapshot.providers).toEqual([
      {
        providerId: "mystery",
        label: "mystery",
        description: null,
        unverified: false,
        status: "error",
        readings: [],
        error: 'Unknown preset "does-not-exist"',
        notice: null,
        fetchedAt: null,
        display: {},
        icon: null,
      },
    ]);
  });

  test("reports a half-filled config entry as an error row", () => {
    const entry = only(buildProviderRegistry({ broken: { label: "Broken" } }), "entry");

    expect(entry.id).toBe("broken");
    expect(entry.provider).toBeNull();
    expect(entry.error).toContain("readings");
  });

  test("marks a disabled provider without issuing a request", async () => {
    const source = createFakeSource({});
    const service = createService({
      source,
      overrides: {
        idle: { label: "Idle", enabled: false, source: HTTP_SOURCE, readings: COUNTER_READINGS },
      },
    });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider).toMatchObject({
      providerId: "idle",
      status: "disabled",
      readings: [],
      error: null,
      fetchedAt: null,
    });
    expect(source.requests).toHaveLength(0);
  });

  test("serves a cached snapshot inside the refresh interval", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        return { used: calls };
      },
    });
    const clock = createClock();
    const service = createService({
      source,
      now: clock.now,
      overrides: {
        counter: {
          label: "Counter",
          refreshIntervalMs: 60_000,
          source: HTTP_SOURCE,
          readings: COUNTER_READINGS,
        },
      },
    });

    const first = await service.read({ refresh: false });
    clock.advance(30_000);
    const second = await service.read({ refresh: false });

    expect(calls).toBe(1);
    expect(only(second.providers, "provider")).toEqual(only(first.providers, "provider"));
  });

  test("refetches once the provider's refresh interval has elapsed", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        return { used: calls };
      },
    });
    const clock = createClock();
    const service = createService({
      source,
      now: clock.now,
      overrides: {
        counter: {
          label: "Counter",
          refreshIntervalMs: 60_000,
          source: HTTP_SOURCE,
          readings: COUNTER_READINGS,
        },
      },
    });

    await service.read({ refresh: false });
    clock.advance(90_000);
    const second = await service.read({ refresh: false });

    expect(calls).toBe(2);
    expect(only(second.providers, "provider").readings).toMatchObject([{ used: 2 }]);
  });

  test("redacts a resolved credential out of a provider error", async () => {
    const source = createFakeSource({
      command: async (command) => {
        throw new Error(`Command "${command[0]}" exited with code 1`);
      },
    });
    const service = createService({
      source,
      env: { USAGE_TOOL_PATH: "/opt/vendor-cli-secret-path" },
      overrides: {
        tool: {
          label: "Tool",
          credentials: { TOOL: [{ kind: "env", variable: "USAGE_TOOL_PATH" }] },
          source: { kind: "command", command: ["${TOOL}", "usage", "--json"] },
          readings: COUNTER_READINGS,
        },
      },
    });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider.status).toBe("error");
    expect(provider.error).toContain("<redacted>");
    expect(provider.error).not.toContain("vendor-cli-secret-path");
    expect(only(source.commands, "command").command[0]).toBe("/opt/vendor-cli-secret-path");
  });

  test("refetches after a quota window resets, inside the refresh interval", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        return { used: calls, limit: 10, resets: new Date(FIXED_NOW + 60_000).toISOString() };
      },
    });
    const clock = createClock();
    const service = createService({
      source,
      now: clock.now,
      overrides: {
        claude: {
          label: "Claude",
          refreshIntervalMs: 900_000,
          source: HTTP_SOURCE,
          readings: WINDOW_READINGS,
        },
      },
    });

    await service.read({ refresh: false });
    clock.advance(59_000);
    await service.read({ refresh: false });
    expect(calls).toBe(1);

    clock.advance(2_000);
    const afterReset = await service.read({ refresh: false });

    expect(calls).toBe(2);
    expect(only(afterReset.providers, "provider").readings).toMatchObject([{ used: 2 }]);
  });

  test("honours the full interval when no reading reports a reset", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        return { used: calls };
      },
    });
    const clock = createClock();
    const service = createService({
      source,
      now: clock.now,
      overrides: {
        counter: {
          label: "Counter",
          refreshIntervalMs: 900_000,
          source: HTTP_SOURCE,
          readings: COUNTER_READINGS,
        },
      },
    });

    await service.read({ refresh: false });
    clock.advance(61_000);
    await service.read({ refresh: false });

    expect(calls).toBe(1);
  });

  test("keeps caching when the reported reset is already in the past", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        return { used: calls, limit: 10, resets: "2026-03-01T11:00:00Z" };
      },
    });
    const clock = createClock();
    const service = createService({
      source,
      now: clock.now,
      overrides: {
        stale: {
          label: "Stale",
          refreshIntervalMs: 900_000,
          source: HTTP_SOURCE,
          readings: WINDOW_READINGS,
        },
      },
    });

    await service.read({ refresh: false });
    clock.advance(1_000);
    await service.read({ refresh: false });
    clock.advance(60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(1);

    clock.advance(900_000);
    await service.read({ refresh: false });

    expect(calls).toBe(2);
  });

  test("bypasses the cache when refresh is requested", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        return { used: calls };
      },
    });
    const service = createService({
      source,
      overrides: {
        counter: {
          label: "Counter",
          refreshIntervalMs: 3_600_000,
          source: HTTP_SOURCE,
          readings: COUNTER_READINGS,
        },
      },
    });

    await service.read({ refresh: false });
    const refreshed = await service.read({ refresh: true });

    expect(calls).toBe(2);
    expect(only(refreshed.providers, "provider").readings).toMatchObject([{ used: 2 }]);
  });

  test("shares one request between two concurrent reads", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        await delay(5);
        return { used: calls };
      },
    });
    const service = createService({
      source,
      overrides: {
        counter: { label: "Counter", source: HTTP_SOURCE, readings: COUNTER_READINGS },
      },
    });

    const [first, second] = await Promise.all([
      service.read({ refresh: false }),
      service.read({ refresh: false }),
    ]);

    expect(calls).toBe(1);
    expect(source.requests).toHaveLength(1);
    expect(only(first.providers, "provider")).toEqual(only(second.providers, "provider"));
  });

  test("keeps reading the other providers when one fails", async () => {
    const source = createFakeSource({
      http: async (request) => {
        if (request.url.includes("broken")) throw new Error("upstream exploded");
        return { used: 5, limit: 10 };
      },
    });
    const service = createService({
      source,
      overrides: {
        broken: {
          label: "Broken",
          source: { kind: "http", url: "https://example.test/broken" },
          readings: COUNTER_READINGS,
        },
        alpha: {
          label: "Alpha",
          source: { kind: "http", url: "https://example.test/alpha" },
          readings: [
            {
              kind: "quota",
              id: "used",
              label: "Used",
              unit: "requests",
              usedPath: "used",
              limitPath: "limit",
            },
          ],
        },
      },
    });

    const snapshot = await service.read({ refresh: false });

    expect(snapshot.configPath).toBe(CONFIG_PATH);
    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual(["alpha", "broken"]);
    expect(providerNamed(snapshot.providers, "alpha")).toMatchObject({
      status: "ok",
      error: null,
      readings: [{ percent: 50 }],
    });
    expect(providerNamed(snapshot.providers, "broken")).toMatchObject({
      status: "error",
      error: "upstream exploded",
      readings: [],
      fetchedAt: "2026-03-01T12:00:00.000Z",
    });
  });
});

function clockLabel(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sept",
  "Oct",
  "Nov",
  "Dec",
];

function datedLabel(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getDate()} ${MONTH_LABELS[date.getMonth()] ?? ""} ${clockLabel(epochMs)}`;
}

function rateLimitError(retryAfterMs: number | null): UsageRateLimitedError {
  return new UsageRateLimitedError(
    "GET request to api.anthropic.com failed with HTTP 429",
    retryAfterMs,
  );
}

const THROTTLED_OVERRIDES = {
  claude: {
    label: "Claude",
    refreshIntervalMs: 300_000,
    source: HTTP_SOURCE,
    readings: COUNTER_READINGS,
  },
};

describe("usage service rate limiting", () => {
  test("waits exactly as long as the Retry-After the vendor sent", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        throw rateLimitError(1_495_000);
      },
    });
    const clock = createClock();
    const service = createService({ source, now: clock.now, overrides: THROTTLED_OVERRIDES });

    await service.read({ refresh: false });
    clock.advance(1_494_000);
    await service.read({ refresh: false });
    expect(calls).toBe(1);

    clock.advance(2_000);
    await service.read({ refresh: false });

    expect(calls).toBe(2);
  });

  test("escalates 15, 30 and 60 minutes without a Retry-After, then holds at 60", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        throw rateLimitError(null);
      },
    });
    const clock = createClock();
    const service = createService({ source, now: clock.now, overrides: THROTTLED_OVERRIDES });

    await service.read({ refresh: false });
    clock.advance(14 * 60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(1);

    clock.advance(60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(2);

    clock.advance(29 * 60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(2);
    clock.advance(60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(3);

    clock.advance(59 * 60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(3);
    clock.advance(60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(4);

    clock.advance(59 * 60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(4);
    clock.advance(60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(5);
  });

  test("resets the escalation after a read succeeds", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        if (calls === 2) return { used: 3 };
        throw rateLimitError(null);
      },
    });
    const clock = createClock();
    const service = createService({ source, now: clock.now, overrides: THROTTLED_OVERRIDES });

    await service.read({ refresh: false });
    clock.advance(15 * 60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(2);

    clock.advance(300_000);
    await service.read({ refresh: false });
    expect(calls).toBe(3);

    clock.advance(14 * 60_000);
    await service.read({ refresh: false });
    expect(calls).toBe(3);

    clock.advance(60_000);
    await service.read({ refresh: false });

    expect(calls).toBe(4);
  });

  test("issues no request during a backoff even when a refresh is requested", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        if (calls === 1) return { used: 6 };
        throw rateLimitError(1_495_000);
      },
    });
    const clock = createClock();
    const service = createService({ source, now: clock.now, overrides: THROTTLED_OVERRIDES });

    await service.read({ refresh: false });
    clock.advance(300_000);
    await service.read({ refresh: false });
    expect(calls).toBe(2);

    clock.advance(60_000);
    const refreshed = await service.read({ refresh: true });

    expect(calls).toBe(2);
    expect(source.requests).toHaveLength(2);
    expect(only(refreshed.providers, "provider")).toMatchObject({
      status: "ok",
      readings: [{ used: 6 }],
      notice: `Rate limited by the provider. Showing the reading from ${clockLabel(FIXED_NOW)} and retrying at ${clockLabel(FIXED_NOW + 300_000 + 1_495_000)}.`,
    });
  });

  test("keeps showing the previous readings and their fetch time while rate limited", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        if (calls === 1) return { used: 7 };
        throw rateLimitError(1_800_000);
      },
    });
    const clock = createClock();
    const service = createService({ source, now: clock.now, overrides: THROTTLED_OVERRIDES });

    const fresh = only((await service.read({ refresh: false })).providers, "provider");
    clock.advance(300_000);
    const seeded = only((await service.read({ refresh: false })).providers, "provider");

    expect(calls).toBe(2);
    expect(seeded).toMatchObject({
      status: "ok",
      error: null,
      fetchedAt: fresh.fetchedAt,
      readings: [{ used: 7 }],
      notice: `Rate limited by the provider. Showing the reading from ${clockLabel(FIXED_NOW)} and retrying at ${clockLabel(FIXED_NOW + 300_000 + 1_800_000)}.`,
    });
  });

  test("reports a readable error row when rate limited with nothing stored", async () => {
    const source = createFakeSource({
      http: async () => {
        throw rateLimitError(1_495_000);
      },
    });
    const clock = createClock();
    const service = createService({ source, now: clock.now, overrides: THROTTLED_OVERRIDES });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider).toMatchObject({
      status: "error",
      readings: [],
      notice: null,
      error: `Rate limited by the provider, and no earlier reading is stored yet. Retrying at ${clockLabel(FIXED_NOW + 1_495_000)}.`,
    });
  });

  test("leaves notice null on every snapshot that is not rate limited", async () => {
    const source = createFakeSource({ http: async () => ({ used: 1 }) });
    const service = createService({
      source,
      overrides: {
        counter: { label: "Counter", source: HTTP_SOURCE, readings: COUNTER_READINGS },
        idle: { label: "Idle", enabled: false, source: HTTP_SOURCE, readings: COUNTER_READINGS },
        mystery: { preset: "does-not-exist" },
      },
    });

    const snapshot = await service.read({ refresh: false });

    expect(snapshot.providers.map((provider) => provider.notice)).toEqual([null, null, null]);
  });
});

const CREDENTIAL_FILE = "/home/tester/.claude/.credentials.json";

const CREDENTIAL_FILES = {
  [CREDENTIAL_FILE]: JSON.stringify({ claudeAiOauth: { accessToken: "stale-token-value" } }),
};

const FILE_CREDENTIAL_OVERRIDES = {
  claude: {
    label: "Claude",
    refreshIntervalMs: 300_000,
    credentials: {
      TOKEN: [
        {
          kind: "jsonFile",
          file: "~/.claude/.credentials.json",
          path: "claudeAiOauth.accessToken",
        },
      ],
    },
    source: {
      kind: "http",
      url: "https://example.test/usage",
      headers: { Authorization: "Bearer ${TOKEN}" },
    },
    readings: COUNTER_READINGS,
  },
};

const FILE_REMEDY =
  "Run the CLI that owns ~/.claude/.credentials.json so it refreshes the stored token.";

function transportError(status: number): UsageSourceError {
  return new UsageSourceError(`GET request to api.anthropic.com failed with HTTP ${status}`);
}

describe("usage service credential rejection", () => {
  test("keeps the stored reading and names the file's own remedy on a 401", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        if (calls === 1) return { used: 13 };
        throw transportError(401);
      },
    });
    const clock = createClock();
    const service = createService({
      source,
      now: clock.now,
      files: CREDENTIAL_FILES,
      overrides: FILE_CREDENTIAL_OVERRIDES,
    });

    await service.read({ refresh: false });
    clock.advance(300_000);
    const rejected = only((await service.read({ refresh: false })).providers, "provider");

    expect(calls).toBe(2);
    expect(rejected).toMatchObject({
      status: "ok",
      error: null,
      fetchedAt: "2026-03-01T12:00:00.000Z",
      readings: [{ used: 13 }],
      notice: `The stored credential was rejected (HTTP 401). ${FILE_REMEDY} Showing the reading from ${clockLabel(FIXED_NOW)}.`,
    });
  });

  test("seeds a first-ever rejected read from the persisted file", async () => {
    const yesterday = FIXED_NOW - 24 * 60 * 60 * 1000;
    const stored = {
      version: 1,
      providers: {
        claude: {
          fetchedAt: new Date(yesterday).toISOString(),
          readings: [
            {
              kind: "quota",
              id: "used",
              label: "Used",
              group: null,
              unit: "requests",
              window: null,
              used: 42,
              limit: null,
              remaining: null,
              percent: null,
            },
          ],
        },
      },
    };
    const source = createFakeSource({
      http: async () => {
        throw transportError(401);
      },
    });
    const memory = createMemoryReadingStore({ [STORE_PATH]: JSON.stringify(stored) });
    const service = createService({
      source,
      store: memory.store,
      files: CREDENTIAL_FILES,
      overrides: FILE_CREDENTIAL_OVERRIDES,
    });

    const rejected = only((await service.read({ refresh: false })).providers, "provider");

    expect(rejected).toMatchObject({
      status: "ok",
      error: null,
      readings: [{ kind: "quota", used: 42 }],
      notice: `The stored credential was rejected (HTTP 401). ${FILE_REMEDY} Showing the reading from ${datedLabel(yesterday)}.`,
    });
  });

  /**
   * The live shape of the claude preset: two file sources, the first built from a
   * variable that is not set. The remedy has to walk past that one, because a
   * path that was never expanded names a file that was never there.
   */
  const STALE_CHAIN_OVERRIDES = {
    claude: {
      label: "Claude",
      refreshIntervalMs: 300_000,
      credentials: {
        TOKEN: [
          {
            kind: "jsonFile",
            file: "${CLAUDE_CONFIG_DIR}/.credentials.json",
            path: "claudeAiOauth.accessToken",
            expiresAtPath: "claudeAiOauth.expiresAt",
            refreshedBy: "claude",
          },
          {
            kind: "jsonFile",
            file: "~/.claude/.credentials.json",
            path: "claudeAiOauth.accessToken",
            expiresAtPath: "claudeAiOauth.expiresAt",
            refreshedBy: "claude",
          },
        ],
      },
      source: {
        kind: "http",
        url: "https://example.test/usage",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
      readings: COUNTER_READINGS,
    },
  };
  const EXPIRED_CREDENTIAL_FILES = {
    [CREDENTIAL_FILE]: JSON.stringify({
      claudeAiOauth: {
        accessToken: "stale-token-value",
        expiresAt: FIXED_NOW - 5 * 60 * 60 * 1000,
      },
    }),
  };

  function storedYesterday(): { file: string; label: string } {
    const yesterday = FIXED_NOW - 24 * 60 * 60 * 1000;
    return {
      file: JSON.stringify({
        version: 1,
        providers: {
          claude: {
            fetchedAt: new Date(yesterday).toISOString(),
            readings: [
              {
                kind: "quota",
                id: "used",
                label: "Used",
                group: null,
                unit: "requests",
                window: null,
                used: 42,
                limit: null,
                remaining: null,
                percent: null,
              },
            ],
          },
        },
      }),
      label: datedLabel(yesterday),
    };
  }

  test("an expired token names the command that refreshes it and the file it owns", async () => {
    const stored = storedYesterday();
    const memory = createMemoryReadingStore({ [STORE_PATH]: stored.file });
    const service = createService({
      source: createFakeSource({}),
      store: memory.store,
      files: EXPIRED_CREDENTIAL_FILES,
      overrides: STALE_CHAIN_OVERRIDES,
    });

    const stale = only((await service.read({ refresh: false })).providers, "provider");

    expect(stale).toMatchObject({ status: "ok", error: null, readings: [{ used: 42 }] });
    expect(stale.notice).toContain("Run `claude` so it refreshes ~/.claude/.credentials.json.");
    expect(stale.notice).toContain(`Showing the reading from ${stored.label}.`);
  });

  test("the remedy skips a source whose variable is unset rather than naming its path", async () => {
    const memory = createMemoryReadingStore({ [STORE_PATH]: storedYesterday().file });
    const service = createService({
      source: createFakeSource({}),
      store: memory.store,
      files: EXPIRED_CREDENTIAL_FILES,
      overrides: STALE_CHAIN_OVERRIDES,
    });

    const stale = only((await service.read({ refresh: false })).providers, "provider");

    // The unexpanded path may be listed among what was tried, but never inside
    // the actionable sentence: a `${VAR}` there is a path that does not exist.
    const notice = String(stale.notice);
    const remedy = notice.slice(notice.indexOf("Run `claude`"));
    expect(remedy).toContain("~/.claude/.credentials.json");
    expect(remedy).not.toContain("${");
    // The tried list still says WHY that source was skipped.
    expect(notice).toContain("(CLAUDE_CONFIG_DIR is not set)");
  });

  test("a credential failure is not reported as an unreachable host", async () => {
    const memory = createMemoryReadingStore({ [STORE_PATH]: storedYesterday().file });
    const service = createService({
      source: createFakeSource({}),
      store: memory.store,
      files: EXPIRED_CREDENTIAL_FILES,
      overrides: STALE_CHAIN_OVERRIDES,
    });

    const stale = only((await service.read({ refresh: false })).providers, "provider");

    expect(stale.notice).not.toContain("Could not reach the provider");
    // The remedy ends its own sentence, so nothing appends a second full stop.
    expect(stale.notice).not.toContain("..");
  });

  test("reports an actionable error row when a 401 has nothing stored", async () => {
    const source = createFakeSource({
      http: async () => {
        throw transportError(401);
      },
    });
    const service = createService({
      source,
      files: CREDENTIAL_FILES,
      overrides: FILE_CREDENTIAL_OVERRIDES,
    });

    const rejected = only((await service.read({ refresh: false })).providers, "provider");

    expect(rejected).toMatchObject({
      status: "error",
      notice: null,
      readings: [],
      error: `The stored credential was rejected (HTTP 401), and no earlier reading is stored yet. ${FILE_REMEDY}`,
    });
    expect(rejected.error).not.toContain("failed with HTTP");
  });

  test("treats a 403 exactly as a 401", async () => {
    const source = createFakeSource({
      http: async () => {
        throw transportError(403);
      },
    });
    const service = createService({
      source,
      files: CREDENTIAL_FILES,
      overrides: FILE_CREDENTIAL_OVERRIDES,
    });

    const rejected = only((await service.read({ refresh: false })).providers, "provider");

    expect(rejected).toMatchObject({
      status: "error",
      notice: null,
      error: `The stored credential was rejected (HTTP 403), and no earlier reading is stored yet. ${FILE_REMEDY}`,
    });
  });

  test("names the environment variable when that is where the credential lives", async () => {
    const source = createFakeSource({
      http: async () => {
        throw transportError(401);
      },
    });
    const service = createService({
      source,
      env: { OPENROUTER_KEY: "env-token-value" },
      overrides: {
        openrouter: {
          label: "OpenRouter",
          credentials: { TOKEN: [{ kind: "env", variable: "OPENROUTER_KEY" }] },
          source: {
            kind: "http",
            url: "https://example.test/usage",
            headers: { Authorization: "Bearer ${TOKEN}" },
          },
          readings: COUNTER_READINGS,
        },
      },
    });

    const rejected = only((await service.read({ refresh: false })).providers, "provider");

    expect(rejected.error).toBe(
      "The stored credential was rejected (HTTP 401), and no earlier reading is stored yet. Set a current token in OPENROUTER_KEY.",
    );
  });

  test("leaves a 500 as a plain transport failure", async () => {
    const source = createFakeSource({
      http: async () => {
        throw transportError(500);
      },
    });
    const service = createService({
      source,
      files: CREDENTIAL_FILES,
      overrides: FILE_CREDENTIAL_OVERRIDES,
    });

    const failed = only((await service.read({ refresh: false })).providers, "provider");

    expect(failed).toMatchObject({
      status: "error",
      notice: null,
      error: "GET request to api.anthropic.com failed with HTTP 500",
    });
  });

  test("still reports a 429 through the rate-limit path, not as a rejected credential", async () => {
    const source = createFakeSource({
      http: async () => {
        throw rateLimitError(1_495_000);
      },
    });
    const clock = createClock();
    const service = createService({
      source,
      now: clock.now,
      files: CREDENTIAL_FILES,
      overrides: FILE_CREDENTIAL_OVERRIDES,
    });

    const throttled = only((await service.read({ refresh: false })).providers, "provider");

    expect(throttled.error).toBe(
      `Rate limited by the provider, and no earlier reading is stored yet. Retrying at ${clockLabel(FIXED_NOW + 1_495_000)}.`,
    );
  });
});

describe("usage service reading store", () => {
  test("writes every successful reading to the store", async () => {
    const source = createFakeSource({ http: async () => ({ used: 9 }) });
    const memory = createMemoryReadingStore();
    const service = createService({ source, store: memory.store, overrides: THROTTLED_OVERRIDES });

    await service.read({ refresh: false });

    const written: unknown = JSON.parse(memory.files[STORE_PATH] ?? "null");
    expect(written).toMatchObject({
      version: 1,
      providers: {
        claude: { fetchedAt: "2026-03-01T12:00:00.000Z", readings: [{ kind: "quota", used: 9 }] },
      },
    });
  });

  test("seeds a first-ever rate-limited read from the persisted file", async () => {
    const yesterday = FIXED_NOW - 24 * 60 * 60 * 1000;
    const stored = {
      version: 1,
      providers: {
        claude: {
          fetchedAt: new Date(yesterday).toISOString(),
          readings: [
            {
              kind: "quota",
              id: "used",
              label: "Used",
              group: null,
              unit: "requests",
              window: null,
              used: 42,
              limit: null,
              remaining: null,
              percent: null,
            },
          ],
        },
      },
    };
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        throw rateLimitError(1_495_000);
      },
    });
    const memory = createMemoryReadingStore({ [STORE_PATH]: JSON.stringify(stored) });
    const service = createService({ source, store: memory.store, overrides: THROTTLED_OVERRIDES });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(calls).toBe(1);
    expect(provider).toMatchObject({
      status: "ok",
      error: null,
      fetchedAt: new Date(yesterday).toISOString(),
      readings: [{ kind: "quota", used: 42 }],
      notice: `Rate limited by the provider. Showing the reading from ${datedLabel(yesterday)} and retrying at ${clockLabel(FIXED_NOW + 1_495_000)}.`,
    });
  });

  test("ignores a corrupt store file and still serves live readings", async () => {
    const source = createFakeSource({ http: async () => ({ used: 4 }) });
    const memory = createMemoryReadingStore({ [STORE_PATH]: "{ not json at all" });
    const service = createService({ source, store: memory.store, overrides: THROTTLED_OVERRIDES });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider).toMatchObject({ status: "ok", notice: null, readings: [{ used: 4 }] });
    expect(memory.files[STORE_PATH]).toContain("2026-03-01T12:00:00.000Z");
  });

  test("shows the stored reading with a notice when any fetch fails", async () => {
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        if (calls === 1) return { used: 11 };
        throw new Error("upstream exploded");
      },
    });
    const clock = createClock();
    const service = createService({ source, now: clock.now, overrides: THROTTLED_OVERRIDES });

    await service.read({ refresh: false });
    clock.advance(300_000);
    const degraded = only((await service.read({ refresh: false })).providers, "provider");

    expect(calls).toBe(2);
    expect(degraded).toMatchObject({
      status: "ok",
      error: null,
      fetchedAt: "2026-03-01T12:00:00.000Z",
      readings: [{ used: 11 }],
      notice: `Could not reach the provider: upstream exploded. Showing the reading from ${clockLabel(FIXED_NOW)}.`,
    });
  });

  test("keeps an error row when a failure has nothing stored", async () => {
    const source = createFakeSource({
      http: async () => {
        throw new Error("upstream exploded");
      },
    });
    const service = createService({ source, overrides: THROTTLED_OVERRIDES });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider).toMatchObject({
      status: "error",
      error: "upstream exploded",
      notice: null,
      readings: [],
    });
  });

  test("drops a stored entry past the retention bound on the next write", async () => {
    const ancient = new Date(FIXED_NOW - 8 * 24 * 60 * 60 * 1000).toISOString();
    const stored = {
      version: 1,
      providers: { ancient: { fetchedAt: ancient, readings: [] } },
    };
    const source = createFakeSource({ http: async () => ({ used: 2 }) });
    const memory = createMemoryReadingStore({ [STORE_PATH]: JSON.stringify(stored) });
    const service = createService({ source, store: memory.store, overrides: THROTTLED_OVERRIDES });

    await service.read({ refresh: false });

    expect(memory.files[STORE_PATH]).not.toContain("ancient");
    expect(memory.files[STORE_PATH]).toContain("claude");
  });

  test("survives a reload with the store handlers.server.ts builds", async () => {
    const root = mkdtempSync(join(TEMP_ROOT, "production-store-"));
    vi.stubEnv("PASEO_HOME", root);
    expect(guardStorePath()).toBe(join(root, "usage-limits", "last-readings.json"));
    let calls = 0;
    const source = createFakeSource({
      http: async () => {
        calls += 1;
        if (calls === 1) return { used: 21 };
        throw rateLimitError(1_495_000);
      },
    });
    // The production store keeps its own real-time clock for retention, so a
    // reading dated months ago would be pruned the moment it was written.
    const fetchedAt = new Date();
    const clock = { now: () => fetchedAt };

    function serviceAsProductionBuildsIt(): UsageService {
      return createUsageService({
        entries: buildProviderRegistry(UsageProviderOverridesSchema.parse(THROTTLED_OVERRIDES)),
        configPath: CONFIG_PATH,
        adapters: {
          source: source.adapters,
          credentials: {
            env: {},
            homeDir: HOME_DIR,
            readTextFile: () => null,
            now: clock.now,
          },
          now: clock.now,
          readings: createReadingStore(createNodeReadingStoreAdapters()),
        },
      });
    }

    await serviceAsProductionBuildsIt().read({ refresh: false });
    const reloaded = serviceAsProductionBuildsIt();
    const seeded = only((await reloaded.read({ refresh: false })).providers, "provider");

    expect(readdirSync(join(root, "usage-limits"))).toEqual(["last-readings.json"]);
    expect(seeded).toMatchObject({
      status: "ok",
      readings: [{ used: 21 }],
      fetchedAt: fetchedAt.toISOString(),
    });
    expect(seeded.notice).toContain("Rate limited by the provider. Showing the reading from");
  });
});

/**
 * Observed live: a pay-as-you-go Z.ai key with credit and no Coding Plan is
 * accepted by the quota route and answered, with HTTP 200, by this envelope.
 * Projected as a document it yields no readings at all, which rendered as an
 * empty card and stored an empty reading as if it were a good one.
 */
const NO_CODING_PLAN_ENVELOPE = { code: 500, msg: "当前用户不存在coding plan", success: false };

describe("a vendor that says no inside a 200 response", () => {
  const overrides = { "zai-coding-plan": { preset: "zai-coding-plan" } };
  const env = { Z_AI_API_KEY: "zai-key" };

  test("becomes an error row quoting the vendor and the preset's hint, and stores nothing", async () => {
    const source = createFakeSource({ http: async () => NO_CODING_PLAN_ENVELOPE });
    const memory = createMemoryReadingStore();
    const service = createService({ overrides, env, source, store: memory.store });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider.status).toBe("error");
    expect(provider.readings).toEqual([]);
    expect(provider.error).toBe(
      "The provider reported an error: 当前用户不存在coding plan. This key has no GLM Coding Plan subscription. The route reports plan quota only; a pay-as-you-go credit balance has no route to read and is shown in the Z.ai console.",
    );
    expect(provider.error).not.toContain("zai-key");
    expect(memory.files[STORE_PATH]).toBeUndefined();
  });

  test("keeps a stored reading on screen under the vendor's words", async () => {
    const source = createFakeSource({ http: async () => NO_CODING_PLAN_ENVELOPE });
    const memory = createMemoryReadingStore({
      [STORE_PATH]: JSON.stringify({
        version: 1,
        providers: {
          "zai-coding-plan": {
            fetchedAt: "2026-03-01T09:30:00.000Z",
            readings: [
              {
                kind: "quota",
                id: "session",
                label: "Session",
                group: null,
                unit: "percent",
                window: { label: "Session", resetsAt: null, durationMs: 18_000_000 },
                used: null,
                limit: null,
                remaining: null,
                percent: 25,
              },
            ],
          },
        },
      }),
    });
    const service = createService({ overrides, env, source, store: memory.store });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider.status).toBe("ok");
    expect(provider.readings).toMatchObject([{ id: "session", percent: 25 }]);
    // The reading time prints in the daemon's local clock, so only its shape is pinned.
    expect(provider.notice).toMatch(
      /^The provider reported an error: 当前用户不存在coding plan\. This key has no GLM Coding Plan subscription\..* Showing the reading from \d{2}:\d{2}\.$/,
    );
  });

  // Before the failure declaration existed, the envelope projected to nothing
  // and that nothing was saved as a good reading. It must not be offered back.
  test("an empty stored reading is not offered as a fallback", async () => {
    const source = createFakeSource({ http: async () => NO_CODING_PLAN_ENVELOPE });
    const memory = createMemoryReadingStore({
      [STORE_PATH]: JSON.stringify({
        version: 1,
        providers: {
          "zai-coding-plan": { fetchedAt: "2026-03-01T09:30:00.000Z", readings: [] },
        },
      }),
    });
    const service = createService({ overrides, env, source, store: memory.store });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider.status).toBe("error");
    expect(provider.notice).toBeNull();
    expect(provider.error).toContain("当前用户不存在coding plan");
  });

  test("a document that does not match the failure projects as usual", async () => {
    const source = createFakeSource({
      http: async () => ({
        code: 200,
        success: true,
        data: {
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 25,
              nextResetTime: 1785816000000,
            },
          ],
        },
      }),
    });
    const service = createService({ overrides, env, source });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    expect(provider.status).toBe("ok");
    expect(provider.readings).toMatchObject([{ id: "session", percent: 25 }]);
  });

  test("a hand-written failure without a message path still names the refusal", async () => {
    const source = createFakeSource({ http: async () => ({ status: "0", data: null }) });
    const service = createService({
      source,
      overrides: {
        vendor: {
          label: "Vendor",
          source: { ...HTTP_SOURCE, failure: { path: "status", equals: 0 } },
          readings: COUNTER_READINGS,
        },
      },
    });

    const provider = only((await service.read({ refresh: false })).providers, "provider");

    // A numeric `equals` matches the vendor's numeric string, as amounts do.
    expect(provider.status).toBe("error");
    expect(provider.error).toBe("The provider reported an error in its response.");
  });
});
