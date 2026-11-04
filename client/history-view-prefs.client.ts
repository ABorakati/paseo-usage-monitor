import { settingsRpc } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  UsageHistoryGroupBy,
  UsageHistoryRange,
  UsageRatesStatus,
} from "../shared/history.shared";
import {
  HISTORY_VIEW_DEFAULTS,
  HistoryViewGroupBySchema,
  HistoryViewMetricSchema,
  HistoryViewRangeSchema,
  historyViewSettings,
  type HistoryViewPreferences,
} from "../shared/history-view.shared";

export type HistoryViewMetric = HistoryViewPreferences["metric"];

export type { HistoryViewPreferences };

/**
 * Stored preference documents tolerate age: one obsolete field falls back to
 * its default while the valid fields survive. A non-object, or a missing
 * field, is just defaults.
 */
export function sanitizeHistoryViewPreferences(value: unknown): HistoryViewPreferences {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const range = HistoryViewRangeSchema.safeParse(record.range);
  const metric = HistoryViewMetricSchema.safeParse(record.metric);
  const groupBy = HistoryViewGroupBySchema.safeParse(record.groupBy);
  return {
    range: range.success ? range.data : HISTORY_VIEW_DEFAULTS.range,
    metric: metric.success ? metric.data : HISTORY_VIEW_DEFAULTS.metric,
    groupBy: groupBy.success ? groupBy.data : HISTORY_VIEW_DEFAULTS.groupBy,
    expandedKeys: sanitizeExpandedKeys(record.expandedKeys),
  };
}

/** Provider keys are handfuls; the cap only bounds a corrupt document. */
const MAX_EXPANDED_KEYS = 100;

function sanitizeExpandedKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") {
      continue;
    }
    seen.add(entry);
    if (seen.size >= MAX_EXPANDED_KEYS) {
      break;
    }
  }
  return [...seen].sort();
}

/**
 * What to plot when the saved metric cannot be answered. A cost view with no
 * rate table falls back to work for display only: the saved choice stays
 * `cost`, so the money view returns on its own when rates load.
 */
export function effectiveHistoryMetric(
  metric: HistoryViewMetric,
  ratesStatus: UsageRatesStatus,
): HistoryViewMetric {
  if (metric === "cost" && ratesStatus === "unavailable") {
    return "work";
  }
  return metric;
}

export type HistoryViewReadResult =
  | { status: "ready"; revision: string; values: unknown }
  | { status: "invalid"; revision: string; error: string };

export type HistoryViewWriteResult =
  | { status: "saved"; revision: string }
  | { status: "conflict"; error: string }
  | { status: "invalid"; error: string };

/** The settings-RPC subset the store needs. Implementations may throw. */
export interface HistoryViewTransport {
  read(): Promise<HistoryViewReadResult>;
  write(revision: string, values: HistoryViewPreferences): Promise<HistoryViewWriteResult>;
}

export interface HistoryViewStoreSnapshot {
  prefs: HistoryViewPreferences;
  /** The initial read has settled; before that defaults may still be replaced. */
  hydrated: boolean;
  /** The last save attempt failed; the next change retries it. */
  saveError: string | null;
}

export type HistoryViewPatch =
  | Partial<HistoryViewPreferences>
  | ((prefs: HistoryViewPreferences) => Partial<HistoryViewPreferences>);

export interface HistoryViewStore {
  getSnapshot(): HistoryViewStoreSnapshot;
  subscribe(listener: () => void): () => void;
  /** Reads once successfully; a later mount retries a failed read. */
  hydrate(): void;
  update(patch: HistoryViewPatch): void;
  toggleExpanded(key: string): void;
  /** Re-runs the write pipeline; a no-op while the last write still holds. */
  retry(): void;
}

function prefsKey(prefs: HistoryViewPreferences): string {
  return JSON.stringify(prefs);
}

type WriteOutcome =
  | { outcome: "saved"; revision: string }
  | { outcome: "conflict" | "rejected" | "failed" };

async function attemptWrite(
  transport: HistoryViewTransport,
  revision: string | null,
  values: HistoryViewPreferences,
): Promise<WriteOutcome> {
  if (revision === null) {
    return { outcome: "failed" };
  }
  let result: HistoryViewWriteResult;
  try {
    result = await transport.write(revision, values);
  } catch {
    return { outcome: "failed" };
  }
  if (result.status === "saved") {
    return { outcome: "saved", revision: result.revision };
  }
  if (result.status === "conflict") {
    return { outcome: "conflict" };
  }
  return { outcome: "rejected" };
}

type HistoryViewField = keyof HistoryViewPreferences;

/**
 * The persistence controller for the history view. One promise chain carries
 * the initial read and every write, so reads and writes never overlap and a
 * late resolution can never reorder earlier work:
 *
 * - Hydration merges: fields the user already touched keep the user's values
 *   while untouched fields take the stored ones, so a slow read neither
 *   overwrites newer input nor discards the saved view over one quick edit.
 *   An explicit edit counts as touched even when it equals the painted value,
 *   and dirt is measured against the hydrated server values, not defaults.
 * - Every write sends the state as of its execution, not its enqueueing, and
 *   commits exactly the values it sent, so rapid input collapses onto the
 *   final values instead of losing them.
 * - A conflict re-reads for a fresh revision and retries once with the same
 *   local values; a second failure surfaces `saveError` and waits for the
 *   next change rather than spinning.
 * - In-flight work is promise-driven, never render-driven, so a save that
 *   resolves after unmount still lands for the next mount.
 */
export function createHistoryViewStore(options: {
  transport: HistoryViewTransport;
}): HistoryViewStore {
  const { transport } = options;
  let prefs = sanitizeHistoryViewPreferences(HISTORY_VIEW_DEFAULTS);
  let revision: string | null = null;
  /** Fields the user set explicitly, even to the value already painted. */
  const touchedFields = new Set<HistoryViewField>();
  let hydrated = false;
  let saveError: string | null = null;
  let lastSynced = prefsKey(prefs);
  let chain: Promise<void> = Promise.resolve();
  let hydrateStarted = false;
  const listeners = new Set<() => void>();
  let snapshot: HistoryViewStoreSnapshot = { prefs, hydrated, saveError };

  const emit = () => {
    snapshot = { prefs, hydrated, saveError };
    for (const listener of listeners) listener();
  };

  /**
   * Adopt a read result. With merging, untouched fields take the stored
   * values while touched fields keep the user's; dirt is then measured
   * against the stored document, so an explicit edit that differs from it
   * still writes. A conflict re-read adopts the revision only: the local
   * values are newer than whatever it carries.
   */
  const adopt = (read: HistoryViewReadResult, merge: boolean) => {
    revision = read.revision;
    if (merge && read.status === "ready") {
      const stored = sanitizeHistoryViewPreferences(read.values);
      lastSynced = prefsKey(stored);
      const merged: HistoryViewPreferences = {
        range: touchedFields.has("range") ? prefs.range : stored.range,
        metric: touchedFields.has("metric") ? prefs.metric : stored.metric,
        groupBy: touchedFields.has("groupBy") ? prefs.groupBy : stored.groupBy,
        expandedKeys: touchedFields.has("expandedKeys") ? prefs.expandedKeys : stored.expandedKeys,
      };
      if (prefsKey(merged) !== prefsKey(prefs)) {
        prefs = merged;
      }
    }
  };

  const commit = (nextRevision: string, written: HistoryViewPreferences) => {
    revision = nextRevision;
    lastSynced = prefsKey(written);
    saveError = null;
    emit();
  };

  const fail = (message: string) => {
    saveError = message;
    emit();
  };

  const safeRead = async (): Promise<HistoryViewReadResult | null> => {
    try {
      return await transport.read();
    } catch {
      return null;
    }
  };

  const runHydrate = async (): Promise<void> => {
    const read = await safeRead();
    if (read !== null) {
      adopt(read, true);
    } else {
      hydrateStarted = false;
    }
    hydrated = true;
    emit();
  };

  const runFlush = async (): Promise<void> => {
    if (revision === null) {
      // The initial read failed, so there is no revision to write against.
      // Re-read first; without one the values stay dirty for the next change.
      const read = await safeRead();
      if (read === null) {
        fail("Could not reach the stored view.");
        return;
      }
      adopt(read, true);
      emit();
    }
    if (prefsKey(prefs) === lastSynced) {
      if (saveError !== null) {
        saveError = null;
        emit();
      }
      return;
    }
    const written = prefs;
    const attempt = await attemptWrite(transport, revision, written);
    if (attempt.outcome === "saved") {
      commit(attempt.revision, written);
      return;
    }
    if (attempt.outcome === "rejected") {
      // The host refused the values themselves; retrying is pointless.
      fail("The stored view rejected these values.");
      return;
    }
    if (attempt.outcome === "failed") {
      fail("Could not save this view.");
      return;
    }
    // Another client won the race: adopt the fresh revision and retry once
    // with the latest local values, which are newer than the re-read.
    const reread = await safeRead();
    if (reread !== null) {
      adopt(reread, false);
    }
    const latest = prefs;
    const retry = await attemptWrite(transport, revision, latest);
    if (retry.outcome === "saved") {
      commit(retry.revision, latest);
    } else {
      fail("Could not save this view.");
    }
  };

  const enqueue = (op: () => Promise<void>) => {
    chain = chain.then(op, op);
  };

  const update = (patch: HistoryViewPatch): void => {
    const partial = typeof patch === "function" ? patch(prefs) : patch;
    for (const field of Object.keys(partial) as HistoryViewField[]) {
      touchedFields.add(field);
    }
    const next = sanitizeHistoryViewPreferences({ ...prefs, ...partial });
    if (prefsKey(next) !== prefsKey(prefs)) {
      prefs = next;
      saveError = null;
      emit();
    }
    // Always re-run the pipeline: an explicit edit that equals the painted
    // value can still differ from the stored one, and only the flush knows.
    enqueue(runFlush);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hydrate: () => {
      if (hydrateStarted) {
        return;
      }
      hydrateStarted = true;
      enqueue(runHydrate);
    },
    update,
    toggleExpanded: (key: string) => {
      if (key === "") {
        return;
      }
      update((current) =>
        current.expandedKeys.includes(key)
          ? { expandedKeys: current.expandedKeys.filter((entry) => entry !== key) }
          : { expandedKeys: [...current.expandedKeys, key] },
      );
    },
    retry: () => {
      enqueue(runFlush);
    },
  };
}

interface HistoryViewHostEntry {
  store: HistoryViewStore;
  setTransport(transport: HistoryViewTransport): void;
}

/**
 * One store per host, shared by every mounted surface on that host. Surfaces
 * therefore share a single write queue and revision — no cross-surface
 * conflicts — and a reopened view reuses the live store instead of racing a
 * stale re-read against the previous mount's pending writes. Entries are
 * never shared across hosts, and each entry's transport holder belongs to its
 * host alone, so a host switch cannot redirect pending writes.
 */
const hostEntries = new Map<
  string,
  { store: HistoryViewStore; holder: { current: HistoryViewTransport } }
>();

function unboundTransport(hostId: string): HistoryViewTransport {
  const missing = async (): Promise<never> => {
    throw new Error(`History view transport for host ${hostId} is not bound.`);
  };
  return { read: missing, write: missing };
}

export function getHistoryViewHostEntry(hostId: string): HistoryViewHostEntry {
  const existing = hostEntries.get(hostId);
  if (existing !== undefined) {
    return {
      store: existing.store,
      setTransport: (transport: HistoryViewTransport) => {
        existing.holder.current = transport;
      },
    };
  }
  const holder = { current: unboundTransport(hostId) };
  const store = createHistoryViewStore({
    transport: {
      read: () => holder.current.read(),
      write: (revision, values) => holder.current.write(revision, values),
    },
  });
  hostEntries.set(hostId, { store, holder });
  return {
    store,
    setTransport: (transport: HistoryViewTransport) => {
      holder.current = transport;
    },
  };
}

/** Tests reset the module entries between cases; production never calls this. */
export function clearHistoryViewHostEntries(): void {
  hostEntries.clear();
}

export interface HistoryViewBinding extends HistoryViewStoreSnapshot {
  setRange(range: UsageHistoryRange): void;
  setMetric(metric: HistoryViewMetric): void;
  setGroupBy(groupBy: UsageHistoryGroupBy): void;
  toggleExpanded(key: string): void;
  retry(): void;
}

/**
 * Binds the host's shared store to one mounted view. The entry's transport
 * holder is refreshed every render because `useRpc` identities may change;
 * the store itself survives, so pending work is never dropped or rerouted.
 */
export function useHistoryViewPreferences(hostId: string): HistoryViewBinding {
  const rpc = useMemo(() => settingsRpc(historyViewSettings.id), []);
  const readSettings = useRpc(rpc.read);
  const writeSettings = useRpc(rpc.write);
  const entry = useMemo(() => getHistoryViewHostEntry(hostId), [hostId]);
  entry.setTransport({
    read: () => readSettings({}),
    write: (revision, values) => writeSettings({ revision, values }),
  });
  const store = entry.store;

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    store.hydrate();
  }, [store]);

  const setRange = useCallback((range: UsageHistoryRange) => store.update({ range }), [store]);
  const setMetric = useCallback((metric: HistoryViewMetric) => store.update({ metric }), [store]);
  const setGroupBy = useCallback(
    (groupBy: UsageHistoryGroupBy) => store.update({ groupBy }),
    [store],
  );
  const toggleExpanded = useCallback((key: string) => store.toggleExpanded(key), [store]);
  const retry = useCallback(() => store.retry(), [store]);

  return { ...snapshot, setRange, setMetric, setGroupBy, toggleExpanded, retry };
}
