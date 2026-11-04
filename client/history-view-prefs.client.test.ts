import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearHistoryViewHostEntries,
  createHistoryViewStore,
  effectiveHistoryMetric,
  getHistoryViewHostEntry,
  sanitizeHistoryViewPreferences,
  type HistoryViewPreferences,
  type HistoryViewReadResult,
  type HistoryViewTransport,
  type HistoryViewWriteResult,
} from "./history-view-prefs.client";
import { HISTORY_VIEW_DEFAULTS } from "../shared/history-view.shared";
import { HistoryViewPreferencesSchema } from "../shared/history-view.shared";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve = (_value: T): void => {};
  let reject = (_error: unknown): void => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A settings transport with scripted reads/writes and full call history. */
class FakeTransport implements HistoryViewTransport {
  readCalls = 0;
  writes: Array<{ revision: string; values: HistoryViewPreferences }> = [];
  readQueue: Array<() => Promise<HistoryViewReadResult>> = [];
  writeQueue: Array<
    (revision: string, values: HistoryViewPreferences) => Promise<HistoryViewWriteResult>
  > = [];
  defaultRead: HistoryViewReadResult = { status: "ready", revision: "rev-1", values: {} };
  savedCount = 0;
  activeWrites = 0;
  maxConcurrentWrites = 0;

  async read(): Promise<HistoryViewReadResult> {
    this.readCalls += 1;
    const next = this.readQueue.shift();
    if (next !== undefined) {
      return next();
    }
    return this.defaultRead;
  }

  async write(revision: string, values: HistoryViewPreferences): Promise<HistoryViewWriteResult> {
    this.writes.push({ revision, values });
    this.activeWrites += 1;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.activeWrites);
    try {
      const next = this.writeQueue.shift();
      if (next !== undefined) {
        return await next(revision, values);
      }
      this.savedCount += 1;
      return { status: "saved", revision: `rev-w${this.savedCount}` };
    } finally {
      this.activeWrites -= 1;
    }
  }
}

function ready(revision: string, values: unknown): HistoryViewReadResult {
  return { status: "ready", revision, values };
}

/** Lets every queued microtask in the store's chains run out. */
async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("sanitizeHistoryViewPreferences", () => {
  test("non-objects become defaults", () => {
    for (const value of [null, undefined, "30d", 42, ["24h"]]) {
      expect(sanitizeHistoryViewPreferences(value)).toEqual(HISTORY_VIEW_DEFAULTS);
    }
  });

  test("one obsolete field falls back while valid fields survive", () => {
    expect(
      sanitizeHistoryViewPreferences({
        range: "90d",
        metric: "cost",
        groupBy: "model",
        expandedKeys: ["codex", "claude-code", "codex", "", 42],
      }),
    ).toEqual({
      range: "24h",
      metric: "cost",
      groupBy: "model",
      expandedKeys: ["claude-code", "codex"],
    });
  });

  test("a corrupt expansion list degrades to empty, capped when huge", () => {
    expect(sanitizeHistoryViewPreferences({ expandedKeys: "codex" }).expandedKeys).toEqual([]);
    const many = Array.from({ length: 150 }, (_, index) => `provider-${index}`);
    const capped = sanitizeHistoryViewPreferences({ expandedKeys: many }).expandedKeys;
    expect(capped.length).toBe(100);
    expect([...capped].sort()).toEqual(capped);
  });
});

describe("HistoryViewPreferencesSchema", () => {
  test("an empty document parses to complete defaults", () => {
    expect(HistoryViewPreferencesSchema.parse({})).toEqual(HISTORY_VIEW_DEFAULTS);
  });

  test("schema-level readers degrade one obsolete field, not the document", () => {
    expect(HistoryViewPreferencesSchema.parse({ range: "90d", metric: "cost" })).toEqual({
      ...HISTORY_VIEW_DEFAULTS,
      metric: "cost",
    });
  });
});

describe("effectiveHistoryMetric", () => {
  test("cost without rates displays work; every other combination stands", () => {
    expect(effectiveHistoryMetric("cost", "unavailable")).toBe("work");
    expect(effectiveHistoryMetric("cost", "fresh")).toBe("cost");
    expect(effectiveHistoryMetric("cost", "cached")).toBe("cost");
    expect(effectiveHistoryMetric("work", "unavailable")).toBe("work");
    expect(effectiveHistoryMetric("total", "unavailable")).toBe("total");
  });
});

describe("history view store hydration", () => {
  test("applies stored values when untouched and writes nothing", async () => {
    const transport = new FakeTransport();
    transport.defaultRead = ready("rev-9", {
      range: "30d",
      metric: "cost",
      groupBy: "model",
      expandedKeys: ["codex"],
    });
    const store = createHistoryViewStore({ transport });
    expect(store.getSnapshot().hydrated).toBe(false);
    expect(store.getSnapshot().prefs).toEqual(HISTORY_VIEW_DEFAULTS);

    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    expect(store.getSnapshot().prefs).toEqual({
      range: "30d",
      metric: "cost",
      groupBy: "model",
      expandedKeys: ["codex"],
    });
    await settle();
    expect(transport.writes.length).toBe(0);
  });

  test("a second hydrate call is a no-op", async () => {
    const transport = new FakeTransport();
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    await settle();
    expect(transport.readCalls).toBe(1);
  });

  test("an invalid document stays usable and keeps its revision for recovery", async () => {
    const transport = new FakeTransport();
    transport.defaultRead = { status: "invalid", revision: "rev-bad", error: "cannot parse" };
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    expect(store.getSnapshot().prefs).toEqual(HISTORY_VIEW_DEFAULTS);

    store.update({ range: "7d" });
    await vi.waitFor(() => expect(transport.writes.length).toBe(1));
    expect(transport.writes[0]?.revision).toBe("rev-bad");
    expect(transport.writes[0]?.values.range).toBe("7d");
  });

  test("a failed read keeps defaults and heals on the next change", async () => {
    const transport = new FakeTransport();
    transport.readQueue.push(async () => {
      throw new Error("daemon unreachable");
    });
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    expect(store.getSnapshot().prefs).toEqual(HISTORY_VIEW_DEFAULTS);

    store.update({ range: "7d" });
    await vi.waitFor(() => expect(transport.writes.length).toBe(1));
    expect(transport.readCalls).toBe(2);
    expect(transport.writes[0]?.values.range).toBe("7d");
    expect(store.getSnapshot().saveError).toBeNull();
  });

  test("a persistently failing read surfaces an error that retry clears", async () => {
    const transport = new FakeTransport();
    const failing = async (): Promise<HistoryViewReadResult> => {
      throw new Error("daemon unreachable");
    };
    transport.readQueue.push(failing, failing);
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    store.update({ range: "7d" });
    await vi.waitFor(() => expect(store.getSnapshot().saveError).not.toBeNull());

    store.retry();
    await vi.waitFor(() => expect(transport.writes.length).toBe(1));
    expect(store.getSnapshot().saveError).toBeNull();
  });

  test("reopening retries an initial read failure", async () => {
    const transport = new FakeTransport();
    transport.readQueue.push(async () => {
      throw new Error("temporarily offline");
    });
    transport.defaultRead = ready("rev-2", { range: "30d", metric: "cost" });
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    expect(store.getSnapshot().prefs).toEqual(HISTORY_VIEW_DEFAULTS);

    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().prefs.metric).toBe("cost"));
    expect(store.getSnapshot().prefs.range).toBe("30d");
    expect(transport.readCalls).toBe(2);
    expect(transport.writes).toEqual([]);
  });

  test("read recovery publishes restored fields even when no write is needed", async () => {
    const transport = new FakeTransport();
    const offline = async (): Promise<HistoryViewReadResult> => {
      throw new Error("temporarily offline");
    };
    transport.readQueue.push(offline, offline);
    transport.defaultRead = ready("rev-2", { range: "24h", metric: "cached", groupBy: "model" });
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    store.update({ range: "24h" });
    await vi.waitFor(() => expect(store.getSnapshot().saveError).not.toBeNull());
    store.retry();
    await vi.waitFor(() => expect(store.getSnapshot().prefs.metric).toBe("cached"));
    expect(store.getSnapshot().prefs.groupBy).toBe("model");
    expect(store.getSnapshot().saveError).toBeNull();
    expect(transport.readCalls).toBe(3);
    expect(transport.writes).toEqual([]);
  });
});

describe("history view reload", () => {
  test.each([
    { range: "24h", metric: "work", groupBy: "provider", expandedKeys: ["codex"] },
    { range: "7d", metric: "cached", groupBy: "model", expandedKeys: ["claude-code"] },
    { range: "30d", metric: "total", groupBy: "provider", expandedKeys: [] },
    { range: "7d", metric: "cost", groupBy: "model", expandedKeys: [] },
  ] satisfies HistoryViewPreferences[])(
    "restores $range / $metric / $groupBy in a fresh instance",
    async (view) => {
      let persisted = { ...HISTORY_VIEW_DEFAULTS };
      let revision = 0;
      const transport: HistoryViewTransport = {
        read: async () => ready(String(revision), persisted),
        write: async (_revision, values) => {
          persisted = { ...values, expandedKeys: [...values.expandedKeys] };
          return { status: "saved", revision: String(++revision) };
        },
      };
      const first = createHistoryViewStore({ transport });
      first.hydrate();
      await vi.waitFor(() => expect(first.getSnapshot().hydrated).toBe(true));
      first.update(view);
      await vi.waitFor(() => expect(persisted).toEqual(view));

      const reloaded = createHistoryViewStore({ transport });
      reloaded.hydrate();
      await vi.waitFor(() => expect(reloaded.getSnapshot().hydrated).toBe(true));
      expect(reloaded.getSnapshot().prefs).toEqual(view);
    },
  );
});

describe("history view hydration races", () => {
  test("a slow read never overwrites newer input but lends its revision", async () => {
    const transport = new FakeTransport();
    const gate = deferred<HistoryViewReadResult>();
    transport.readQueue.push(() => gate.promise);
    const store = createHistoryViewStore({ transport });
    store.hydrate();

    store.update({ metric: "cached" });
    expect(store.getSnapshot().prefs.metric).toBe("cached");

    gate.resolve(ready("rev-7", { range: "30d", metric: "work" }));
    await vi.waitFor(() => expect(transport.writes.length).toBe(1));

    // The untouched range takes the stored value; the touched metric stays.
    expect(store.getSnapshot().prefs).toEqual({
      ...HISTORY_VIEW_DEFAULTS,
      range: "30d",
      metric: "cached",
    });
    // No conflict round-trip: the write went out against the adopted revision.
    expect(transport.readCalls).toBe(1);
    expect(transport.writes[0]?.revision).toBe("rev-7");
    expect(transport.writes[0]?.values).toEqual(store.getSnapshot().prefs);
  });

  test("an explicit edit that equals the painted value still persists", async () => {
    const transport = new FakeTransport();
    const gate = deferred<HistoryViewReadResult>();
    transport.readQueue.push(() => gate.promise);
    const store = createHistoryViewStore({ transport });
    store.hydrate();

    // The view paints 24h from defaults; the user explicitly presses 24h.
    store.update({ range: "24h" });
    gate.resolve(ready("rev-3", { range: "30d" }));
    await vi.waitFor(() => expect(transport.writes.length).toBe(1));

    expect(store.getSnapshot().prefs.range).toBe("24h");
    expect(transport.writes[0]?.values.range).toBe("24h");
  });

  test("returning to the stored value before hydration needs no write", async () => {
    const transport = new FakeTransport();
    const gate = deferred<HistoryViewReadResult>();
    transport.readQueue.push(() => gate.promise);
    const store = createHistoryViewStore({ transport });
    store.hydrate();

    store.update({ range: "30d" });
    store.update({ range: "24h" });
    store.update({ range: "30d" });
    gate.resolve(ready("rev-3", { range: "30d" }));
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    await settle();

    expect(store.getSnapshot().prefs.range).toBe("30d");
    expect(transport.writes.length).toBe(0);
  });

  test("expansion toggles before hydration merge with stored expansion", async () => {
    const transport = new FakeTransport();
    const gate = deferred<HistoryViewReadResult>();
    transport.readQueue.push(() => gate.promise);
    const store = createHistoryViewStore({ transport });
    store.hydrate();

    gate.resolve(ready("rev-4", { expandedKeys: ["codex"] }));
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    expect(store.getSnapshot().prefs.expandedKeys).toEqual(["codex"]);

    store.toggleExpanded("codex");
    store.toggleExpanded("claude-code");
    await vi.waitFor(() => expect(transport.writes.length).toBe(1));
    expect(transport.writes[0]?.values.expandedKeys).toEqual(["claude-code"]);
  });
});

describe("history view write pipeline", () => {
  test("rapid input collapses onto one write with the final values", async () => {
    const transport = new FakeTransport();
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    store.update({ range: "7d" });
    store.update({ metric: "cost" });
    store.update({ groupBy: "model" });
    await vi.waitFor(() => expect(transport.writes.length).toBe(1));

    expect(transport.writes[0]?.values).toEqual({
      range: "7d",
      metric: "cost",
      groupBy: "model",
      expandedKeys: [],
    });
    await settle();
    expect(transport.writes.length).toBe(1);
    expect(transport.maxConcurrentWrites).toBe(1);
  });

  test("an edit during a pending write is committed separately, never lost", async () => {
    const transport = new FakeTransport();
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    const first = deferred<HistoryViewWriteResult>();
    transport.writeQueue.push(() => first.promise);
    store.update({ range: "30d" });
    await vi.waitFor(() => expect(transport.writes.length).toBe(1));

    // The second edit lands after the first write started, before it resolves.
    store.update({ metric: "cost" });
    expect(store.getSnapshot().prefs).toEqual({
      ...HISTORY_VIEW_DEFAULTS,
      range: "30d",
      metric: "cost",
    });

    first.resolve({ status: "saved", revision: "rev-2" });
    await vi.waitFor(() => expect(transport.writes.length).toBe(2));

    // The first commit covers exactly what it sent, so the queued flush still
    // sees the newer edit as dirty and writes it against the fresh revision.
    expect(transport.writes[0]?.values).toEqual({ ...HISTORY_VIEW_DEFAULTS, range: "30d" });
    expect(transport.writes[1]?.revision).toBe("rev-2");
    expect(transport.writes[1]?.values).toEqual({
      ...HISTORY_VIEW_DEFAULTS,
      range: "30d",
      metric: "cost",
    });
    expect(store.getSnapshot().saveError).toBeNull();
    await settle();
    expect(transport.writes.length).toBe(2);
  });

  test("writes never overlap even under a burst of edits", async () => {
    const transport = new FakeTransport();
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    for (let index = 0; index < 10; index += 1) {
      store.update({ expandedKeys: [`provider-${index}`] });
    }
    await vi.waitFor(() => expect(store.getSnapshot().saveError).toBeNull());
    await settle();
    expect(transport.maxConcurrentWrites).toBeLessThanOrEqual(1);
    expect(transport.writes[transport.writes.length - 1]?.values.expandedKeys).toEqual([
      "provider-9",
    ]);
  });

  test("a conflict re-reads and retries once with the local values", async () => {
    const transport = new FakeTransport();
    transport.defaultRead = ready("rev-1", {});
    transport.readQueue.push(async () => ready("rev-1", {}));
    transport.readQueue.push(async () => ready("rev-2", { range: "7d" }));
    transport.writeQueue.push(
      async () => ({ status: "conflict", error: "stale revision" }),
      async () => ({ status: "saved", revision: "rev-3" }),
    );
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    store.update({ range: "30d" });
    await vi.waitFor(() => expect(transport.writes.length).toBe(2));

    // The retry uses the fresh revision but keeps the newer local values,
    // never the re-read's.
    expect(transport.writes[1]?.revision).toBe("rev-2");
    expect(transport.writes[1]?.values.range).toBe("30d");
    expect(store.getSnapshot().prefs.range).toBe("30d");
    expect(store.getSnapshot().saveError).toBeNull();
  });

  test("a repeated conflict surfaces an error and the next change retries", async () => {
    const transport = new FakeTransport();
    transport.writeQueue.push(
      async () => ({ status: "conflict", error: "stale" }),
      async () => ({ status: "conflict", error: "stale again" }),
    );
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    store.update({ range: "30d" });
    await vi.waitFor(() => expect(store.getSnapshot().saveError).not.toBeNull());
    expect(transport.writes.length).toBe(2);

    store.update({ metric: "total" });
    await vi.waitFor(() => expect(transport.writes.length).toBe(3));
    expect(store.getSnapshot().saveError).toBeNull();
    expect(transport.writes[2]?.values).toEqual({
      ...HISTORY_VIEW_DEFAULTS,
      range: "30d",
      metric: "total",
    });
  });

  test("a rejected write surfaces an error without retrying", async () => {
    const transport = new FakeTransport();
    transport.writeQueue.push(async () => ({ status: "invalid", error: "bad values" }));
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    store.update({ range: "30d" });
    await vi.waitFor(() => expect(store.getSnapshot().saveError).not.toBeNull());
    await settle();
    expect(transport.writes.length).toBe(1);
  });

  test("a failed write surfaces an error that retry clears", async () => {
    const transport = new FakeTransport();
    transport.writeQueue.push(async () => {
      throw new Error("daemon unreachable");
    });
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    store.update({ range: "30d" });
    await vi.waitFor(() => expect(store.getSnapshot().saveError).not.toBeNull());

    store.retry();
    await vi.waitFor(() => expect(transport.writes.length).toBe(2));
    expect(store.getSnapshot().saveError).toBeNull();
  });

  test("a write resolving after unsubscribe still lands", async () => {
    const transport = new FakeTransport();
    const store = createHistoryViewStore({ transport });
    store.hydrate();
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));

    const gate = deferred<HistoryViewWriteResult>();
    transport.writeQueue.push(() => gate.promise);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.update({ range: "30d" });
    await vi.waitFor(() => expect(transport.writes.length).toBe(1));

    unsubscribe();
    gate.resolve({ status: "saved", revision: "rev-2" });
    await settle();

    expect(store.getSnapshot().saveError).toBeNull();
    expect(store.getSnapshot().prefs.range).toBe("30d");
  });
});

describe("history view host entries", () => {
  beforeEach(() => {
    clearHistoryViewHostEntries();
  });

  test("the same host reuses its store across mounts", async () => {
    const first = getHistoryViewHostEntry("host-a");
    const second = getHistoryViewHostEntry("host-a");
    expect(first.store).toBe(second.store);

    const transport = new FakeTransport();
    transport.defaultRead = ready("rev-1", { range: "30d" });
    first.setTransport(transport);
    first.store.hydrate();
    await vi.waitFor(() => expect(second.store.getSnapshot().hydrated).toBe(true));
    expect(second.store.getSnapshot().prefs.range).toBe("30d");

    // A reopened view reuses the live store: no second read, no clobbering.
    second.store.hydrate();
    await settle();
    expect(transport.readCalls).toBe(1);
  });

  test("a pending write keeps its own host transport across a host switch", async () => {
    const entryA = getHistoryViewHostEntry("host-a");
    const entryB = getHistoryViewHostEntry("host-b");
    expect(entryA.store).not.toBe(entryB.store);

    const transportA = new FakeTransport();
    transportA.defaultRead = ready("ra-1", { range: "30d" });
    const transportB = new FakeTransport();
    transportB.defaultRead = ready("rb-1", { range: "7d" });
    entryA.setTransport(transportA);
    entryB.setTransport(transportB);
    entryA.store.hydrate();
    entryB.store.hydrate();
    await vi.waitFor(() => expect(entryA.store.getSnapshot().hydrated).toBe(true));
    await vi.waitFor(() => expect(entryB.store.getSnapshot().hydrated).toBe(true));

    const gate = deferred<HistoryViewWriteResult>();
    transportA.writeQueue.push(() => gate.promise);
    entryA.store.update({ metric: "cost" });
    await vi.waitFor(() => expect(transportA.writes.length).toBe(1));

    // The other host rebinds its own transport while A's write is pending.
    entryB.setTransport(transportB);
    gate.resolve({ status: "saved", revision: "ra-2" });
    await vi.waitFor(() => expect(entryA.store.getSnapshot().saveError).toBeNull());

    expect(transportB.writes.length).toBe(0);
    expect(entryA.store.getSnapshot().prefs).toEqual({
      range: "30d",
      metric: "cost",
      groupBy: "provider",
      expandedKeys: [],
    });
    expect(entryB.store.getSnapshot().prefs).toEqual({
      range: "7d",
      metric: "work",
      groupBy: "provider",
      expandedKeys: [],
    });
  });
});
