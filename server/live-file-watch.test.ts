import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import {
  createLiveFileWatcher,
  createNodeLiveFileWatchAdapters,
  type LiveFileWatcher,
} from "./live-file-watch.server";

const roots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "usage-live-watch-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createWatcher(): { changes: string[][]; watcher: LiveFileWatcher } {
  const changes: string[][] = [];
  const watcher = createLiveFileWatcher({
    adapters: createNodeLiveFileWatchAdapters(),
    onChanged(providerIds) {
      changes.push([...providerIds]);
    },
    debounceMs: 100,
  });
  return { changes, watcher };
}

test("reports the provider whose file changed", async () => {
  const root = createRoot();
  const target = join(root, "paseo-rate-limits.json");
  const { changes, watcher } = createWatcher();
  watcher.sync([{ providerId: "claude", path: target }]);
  try {
    writeFileSync(target, "{}");
    await vi.waitFor(() => expect(changes).toEqual([["claude"]]), { timeout: 5000 });
  } finally {
    watcher.close();
  }
});

test("ignores writes to files no provider reads", async () => {
  const root = createRoot();
  const target = join(root, "paseo-rate-limits.json");
  const { changes, watcher } = createWatcher();
  watcher.sync([{ providerId: "claude", path: target }]);
  try {
    writeFileSync(join(root, "unrelated.json"), "{}");
    await delay(400);
    expect(changes).toEqual([]);
  } finally {
    watcher.close();
  }
});

test("coalesces rapid writes into one report", async () => {
  const root = createRoot();
  const target = join(root, "paseo-rate-limits.json");
  const { changes, watcher } = createWatcher();
  watcher.sync([{ providerId: "claude", path: target }]);
  try {
    writeFileSync(target, "{}");
    writeFileSync(target, "{}");
    writeFileSync(target, "{}");
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0), { timeout: 5000 });
    await delay(400);
    expect(changes).toEqual([["claude"]]);
  } finally {
    watcher.close();
  }
});

test("re-attaches when the target set changes", async () => {
  const root = createRoot();
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  const { changes, watcher } = createWatcher();
  watcher.sync([{ providerId: "first", path: first }]);
  watcher.sync([{ providerId: "second", path: second }]);
  try {
    writeFileSync(first, "{}");
    await delay(400);
    expect(changes).toEqual([]);

    writeFileSync(second, "{}");
    await vi.waitFor(() => expect(changes).toEqual([["second"]]), { timeout: 5000 });
  } finally {
    watcher.close();
  }
});

test("does nothing when the directory does not exist", () => {
  const { watcher } = createWatcher();
  try {
    expect(() =>
      watcher.sync([
        { providerId: "claude", path: join(tmpdir(), "usage-live-watch-absent", "a.json") },
      ]),
    ).not.toThrow();
  } finally {
    watcher.close();
  }
});
