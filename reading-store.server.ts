import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { UsageReadingSchema } from "./limits.shared";

/**
 * The last good reading per provider, kept on disk. A vendor that is already
 * throttling when the plugin starts leaves nothing in memory to fall back on,
 * and a plugin reload throws memory away, so the seed the surface shows while
 * rate limited has to outlive both. Only what the surface needs is stored: the
 * readings and when they were taken.
 *
 * A cache is never allowed to break the live path, so an unreadable, corrupt or
 * stale-shaped file is treated as empty rather than raised.
 */

const STORE_VERSION = 1;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;

const StoredReadingSchema = z.object({
  fetchedAt: z.string().min(1),
  readings: z.array(UsageReadingSchema),
});

const ReadingStoreFileSchema = z.object({
  version: z.literal(STORE_VERSION),
  providers: z.record(z.string(), StoredReadingSchema),
});

export type StoredReading = z.infer<typeof StoredReadingSchema>;

export interface ReadingStoreAdapters {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  readTextFile(path: string): string | null;
  writeTextFile(path: string, content: string): void;
}

export interface ReadingStoreOptions {
  now?: () => Date;
  retentionMs?: number;
  maxEntries?: number;
}

export interface ReadingStore {
  get(providerId: string): StoredReading | null;
  save(providerId: string, entry: StoredReading): void;
}

export function readingStorePath(adapters: ReadingStoreAdapters): string {
  const paseoHome = adapters.env.PASEO_HOME ?? join(adapters.homeDir, ".paseo");
  return join(paseoHome, "usage-limits", "last-readings.json");
}

/**
 * A test run must never write into the developer's own store: a synthetic entry
 * there is shown back to them as their last known usage, which is exactly what
 * this file exists to display. A test that genuinely wants the on-disk store
 * has to point `PASEO_HOME` at a temp directory, and one that does not should
 * inject its own store, so writing anywhere else from a test fails loudly.
 */
function refuseWriteOutsideTempDuringTests(path: string): void {
  if (process.env.VITEST === undefined) return;
  if (path.startsWith(tmpdir())) return;
  throw new Error(
    `refusing to write the usage reading store to ${path} during a test run: point PASEO_HOME at a temp directory or inject a ReadingStore`,
  );
}

export function createNodeReadingStoreAdapters(): ReadingStoreAdapters {
  return {
    env: process.env,
    homeDir: homedir(),
    readTextFile(path: string): string | null {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // An absent store is the normal first-run state, not a failure.
        return null;
      }
    },
    writeTextFile(path: string, content: string): void {
      refuseWriteOutsideTempDuringTests(path);
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true });
      const temporary = join(directory, `.last-readings.${process.pid}.tmp`);
      writeFileSync(temporary, content, "utf8");
      renameSync(temporary, path);
    },
  };
}

function parseStoreFile(text: string): Record<string, StoredReading> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return {};
  }
  const parsed = ReadingStoreFileSchema.safeParse(document);
  return parsed.success ? parsed.data.providers : {};
}

function prune(
  providers: Map<string, StoredReading>,
  nowMs: number,
  retentionMs: number,
  maxEntries: number,
): Map<string, StoredReading> {
  const live = [...providers].filter(([, entry]) => {
    const fetchedAtMs = Date.parse(entry.fetchedAt);
    if (Number.isNaN(fetchedAtMs)) return false;
    return nowMs - fetchedAtMs <= retentionMs;
  });
  live.sort(([, left], [, right]) => Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt));
  return new Map(live.slice(0, maxEntries));
}

export function createReadingStore(
  adapters: ReadingStoreAdapters,
  options: ReadingStoreOptions = {},
): ReadingStore {
  const now = options.now ?? (() => new Date());
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const path = readingStorePath(adapters);
  let providers: Map<string, StoredReading> | null = null;

  function loaded(): Map<string, StoredReading> {
    if (providers !== null) return providers;
    const text = adapters.readTextFile(path);
    providers = text === null ? new Map() : new Map(Object.entries(parseStoreFile(text)));
    return providers;
  }

  return {
    get(providerId: string): StoredReading | null {
      return loaded().get(providerId) ?? null;
    },
    save(providerId: string, entry: StoredReading): void {
      const current = loaded();
      current.set(providerId, entry);
      const kept = prune(current, now().getTime(), retentionMs, maxEntries);
      providers = kept;
      adapters.writeTextFile(
        path,
        `${JSON.stringify({ version: STORE_VERSION, providers: Object.fromEntries(kept) }, null, 2)}\n`,
      );
    },
  };
}
