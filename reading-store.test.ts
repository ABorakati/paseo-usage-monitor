import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { UsageReading } from "./limits.shared";
import {
  createNodeReadingStoreAdapters,
  createReadingStore,
  readingStorePath,
  type ReadingStoreAdapters,
} from "./reading-store.server";

const HOME_DIR = "/home/tester";
const STORE_PATH = "/home/tester/.paseo/usage-limits/last-readings.json";
const FIXED_NOW = new Date("2026-03-01T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Anything in this file that reaches a real filesystem must land inside the
 * temp root, never in the developer's own `~/.paseo`, where a synthetic entry
 * would be shown back to them as their last known usage.
 */
const TEMP_ROOT = mkdtempSync(join(tmpdir(), "usage-limits-store-"));

function guardRealStorePath(): string {
  const path = readingStorePath({
    env: process.env,
    homeDir: homedir(),
    readTextFile: () => null,
    writeTextFile: () => {},
  });
  if (!path.startsWith(TEMP_ROOT)) {
    throw new Error(`the reading store would resolve to ${path}, outside ${TEMP_ROOT}`);
  }
  return path;
}

beforeEach(() => {
  vi.stubEnv("PASEO_HOME", TEMP_ROOT);
  guardRealStorePath();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const READING: UsageReading = {
  kind: "quota",
  id: "session",
  label: "Session",
  group: null,
  unit: "requests",
  window: { label: "Session", resetsAt: null, durationMs: null },
  used: 40,
  limit: 100,
  remaining: 60,
  percent: 40,
};

interface MemoryStore {
  files: Record<string, string | undefined>;
  adapters: ReadingStoreAdapters;
}

function createMemoryAdapters(files: Record<string, string | undefined> = {}): MemoryStore {
  return {
    files,
    adapters: {
      env: {},
      homeDir: HOME_DIR,
      readTextFile: (path) => files[path] ?? null,
      writeTextFile: (path, content) => {
        files[path] = content;
      },
    },
  };
}

function storeFile(entries: Record<string, { fetchedAt: string; readings: UsageReading[] }>) {
  return JSON.stringify({ version: 1, providers: entries });
}

describe("reading store", () => {
  test("puts the file under PASEO_HOME when it is set", () => {
    const memory = createMemoryAdapters();

    expect(readingStorePath({ ...memory.adapters, env: { PASEO_HOME: "/srv/paseo" } })).toBe(
      "/srv/paseo/usage-limits/last-readings.json",
    );
    expect(readingStorePath(memory.adapters)).toBe(STORE_PATH);
  });

  test("reports nothing when the file is absent", () => {
    const memory = createMemoryAdapters();

    const store = createReadingStore(memory.adapters, { now: () => FIXED_NOW });

    expect(store.get("claude")).toBeNull();
  });

  test("round-trips a saved reading through the file", () => {
    const memory = createMemoryAdapters();
    const store = createReadingStore(memory.adapters, { now: () => FIXED_NOW });

    store.save("claude", { readings: [READING], fetchedAt: "2026-03-01T11:00:00.000Z" });

    const reloaded = createReadingStore(createMemoryAdapters(memory.files).adapters, {
      now: () => FIXED_NOW,
    });
    expect(reloaded.get("claude")).toEqual({
      readings: [READING],
      fetchedAt: "2026-03-01T11:00:00.000Z",
    });
  });

  test("ignores a file that is not JSON", () => {
    const memory = createMemoryAdapters({ [STORE_PATH]: "{ not json" });

    const store = createReadingStore(memory.adapters, { now: () => FIXED_NOW });

    expect(store.get("claude")).toBeNull();
  });

  test("ignores a file whose shape no longer matches", () => {
    const memory = createMemoryAdapters({
      [STORE_PATH]: JSON.stringify({
        version: 2,
        providers: { claude: { fetchedAt: "2026-03-01T11:00:00.000Z", readings: [] } },
      }),
    });

    const store = createReadingStore(memory.adapters, { now: () => FIXED_NOW });

    expect(store.get("claude")).toBeNull();
  });

  test("ignores an entry whose readings are not readings", () => {
    const memory = createMemoryAdapters({
      [STORE_PATH]: JSON.stringify({
        version: 1,
        providers: {
          claude: { fetchedAt: "2026-03-01T11:00:00.000Z", readings: [{ kind: "wat" }] },
        },
      }),
    });

    const store = createReadingStore(memory.adapters, { now: () => FIXED_NOW });

    expect(store.get("claude")).toBeNull();
  });

  test("drops an entry older than the retention bound when saving", () => {
    const stale = new Date(FIXED_NOW.getTime() - 8 * DAY_MS).toISOString();
    const memory = createMemoryAdapters({
      [STORE_PATH]: storeFile({ ancient: { fetchedAt: stale, readings: [READING] } }),
    });
    const store = createReadingStore(memory.adapters, { now: () => FIXED_NOW });

    expect(store.get("ancient")).not.toBeNull();
    store.save("claude", { readings: [READING], fetchedAt: FIXED_NOW.toISOString() });

    expect(store.get("ancient")).toBeNull();
    expect(memory.files[STORE_PATH]).not.toContain("ancient");
    expect(store.get("claude")).not.toBeNull();
  });

  test("keeps the newest entries when the cap is reached", () => {
    const memory = createMemoryAdapters();
    const store = createReadingStore(memory.adapters, { now: () => FIXED_NOW, maxEntries: 2 });

    store.save("oldest", { readings: [READING], fetchedAt: "2026-03-01T09:00:00.000Z" });
    store.save("middle", { readings: [READING], fetchedAt: "2026-03-01T10:00:00.000Z" });
    store.save("newest", { readings: [READING], fetchedAt: "2026-03-01T11:00:00.000Z" });

    expect(store.get("oldest")).toBeNull();
    expect(store.get("middle")).not.toBeNull();
    expect(store.get("newest")).not.toBeNull();
  });
});

describe("node reading store adapters", () => {
  function createTempAdapters(): { adapters: ReadingStoreAdapters; root: string } {
    const root = mkdtempSync(join(TEMP_ROOT, "adapters-"));
    const adapters = { ...createNodeReadingStoreAdapters(), env: { PASEO_HOME: root } };
    if (!readingStorePath(adapters).startsWith(TEMP_ROOT)) {
      throw new Error(`refusing to write outside ${TEMP_ROOT}`);
    }
    return { adapters, root };
  }

  test("creates the directory and leaves no partial file behind", () => {
    const { adapters, root } = createTempAdapters();
    const store = createReadingStore(adapters, { now: () => FIXED_NOW });

    store.save("claude", { readings: [READING], fetchedAt: FIXED_NOW.toISOString() });
    store.save("codex", { readings: [READING], fetchedAt: FIXED_NOW.toISOString() });

    const directory = join(root, "usage-limits");
    expect(readdirSync(directory)).toEqual(["last-readings.json"]);
    const written: unknown = JSON.parse(
      readFileSync(join(directory, "last-readings.json"), "utf8"),
    );
    expect(written).toMatchObject({ version: 1, providers: { claude: {}, codex: {} } });
  });

  test("reads back what a previous process wrote", () => {
    const { adapters, root } = createTempAdapters();
    createReadingStore(adapters, { now: () => FIXED_NOW }).save("claude", {
      readings: [READING],
      fetchedAt: "2026-03-01T11:00:00.000Z",
    });

    const reopened = createReadingStore(adapters, { now: () => FIXED_NOW });

    expect(existsSync(join(root, "usage-limits", "last-readings.json"))).toBe(true);
    expect(reopened.get("claude")).toEqual({
      readings: [READING],
      fetchedAt: "2026-03-01T11:00:00.000Z",
    });
  });

  test("treats an unreadable path as an empty store", () => {
    const adapters = {
      ...createNodeReadingStoreAdapters(),
      env: { PASEO_HOME: join(TEMP_ROOT, "absent-root") },
    };

    const store = createReadingStore(adapters, { now: () => FIXED_NOW });

    expect(store.get("claude")).toBeNull();
  });

  test("refuses to write outside the temp directory during a test run", () => {
    const adapters = {
      ...createNodeReadingStoreAdapters(),
      env: { PASEO_HOME: join(homedir(), ".paseo") },
    };
    const store = createReadingStore(adapters, { now: () => FIXED_NOW });

    expect(() =>
      store.save("claude", { readings: [READING], fetchedAt: FIXED_NOW.toISOString() }),
    ).toThrow(/refusing to write the usage reading store/);
    expect(readingStorePath(adapters)).toBe(
      join(homedir(), ".paseo", "usage-limits", "last-readings.json"),
    );
  });
});
