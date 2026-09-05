/**
 * The Antigravity card's document: the vendor's own quota buckets, plus what
 * every Antigravity client on this machine actually spent.
 *
 * Both halves are needed because they answer for different ledgers. The quota
 * route reports the consumer Antigravity plan, and a request that runs under
 * the user's own Cloud project — which is how Paseo reaches the model — never
 * decrements it. Observed live: the weekly bucket held 0.7627758 remaining
 * across an hour in which Paseo spent 75M tokens on `google-antigravity`.
 *
 * So usage is counted per client, from the logs each one writes:
 *   - the Antigravity app, the `agy` CLI and the ACP bridge, out of their own
 *     conversation stores (see `antigravity-clients.server.ts`);
 *   - Paseo, out of the omp transcripts the history surface already reads, so
 *     the two surfaces cannot disagree.
 *
 * A client with nothing in the widest window contributes no rows at all, which
 * keeps the card free of zeros for tools the user does not have installed.
 */

import {
  type AntigravityClientAdapters,
  type AntigravityClientRows,
  createNodeAntigravityClientAdapters,
  readAntigravityClientRows,
} from "./antigravity-clients.server";
import { type AntigravityQuota, probeAntigravityQuota } from "./antigravity-probe.server";
import {
  type AgentProviderWindow,
  createNodeHistoryAdapters,
  type HistoryAdapters,
  readAgentProviderWindows,
} from "./history.server";

const HOUR_MS = 60 * 60 * 1000;
const DAY_WINDOW_MS = 24 * HOUR_MS;
const WEEK_WINDOW_MS = 7 * 24 * HOUR_MS;

/** Paseo drives Antigravity through omp, which labels the vendor this way. */
const OMP_ANTIGRAVITY_PROVIDER = "omp-google-antigravity";
const PASEO_CLIENT_LABEL = "Paseo (omp)";
const TOTAL_GROUP_LABEL = "Every client";

const DAY_LABEL = "Today";
const WEEK_LABEL = "Last 7 days";

/** One number on the card: an amount under a client, in the reading's unit. */
export interface AntigravityUsageRow {
  id: string;
  label: string;
  group: string;
  amount: number | null;
}

/**
 * Split by unit rather than by client, because a reading mapping carries one
 * unit for every element it projects.
 */
export interface AntigravityUsageRows {
  tokens: AntigravityUsageRow[];
  requests: AntigravityUsageRow[];
  spend: AntigravityUsageRow[];
}

export interface AntigravityUsage extends AntigravityQuota {
  usage: AntigravityUsageRows;
}

interface ClientTotals {
  id: string;
  label: string;
  dayTokens: number;
  dayRequests: number;
  weekTokens: number;
  /** Null where the client's log reports no cost of its own. */
  weekSpendUsd: number | null;
}

function totalsFromClient(client: AntigravityClientRows, nowMs: number): ClientTotals {
  const totals: ClientTotals = {
    id: client.id,
    label: client.label,
    dayTokens: 0,
    dayRequests: 0,
    weekTokens: 0,
    weekSpendUsd: null,
  };
  for (const row of client.rows) {
    const age = nowMs - row.timestampMs;
    if (age < 0 || age > WEEK_WINDOW_MS) continue;
    const tokens = row.uncachedInputTokens + row.cachedInputTokens + row.outputTokens;
    totals.weekTokens += tokens;
    if (age > DAY_WINDOW_MS) continue;
    totals.dayTokens += tokens;
    totals.dayRequests += 1;
  }
  return totals;
}

function totalsFromHarness(
  id: string,
  label: string,
  windows: readonly AgentProviderWindow[],
): ClientTotals | null {
  const [day, week] = windows;
  if (day === undefined || week === undefined) return null;
  if (week.requests === 0) return null;
  return {
    id,
    label,
    dayTokens: day.tokens,
    dayRequests: day.requests,
    weekTokens: week.tokens,
    weekSpendUsd: week.costUsd,
  };
}

/**
 * The question the card answers first is "how much Antigravity have I used",
 * which is every client added up. The per-client rows below it say where it
 * went. With one client the total would restate that client, so it is omitted.
 */
function combinedTotals(clients: readonly ClientTotals[]): ClientTotals | null {
  if (clients.length < 2) return null;
  const priced = clients.filter((client) => client.weekSpendUsd !== null);
  return {
    id: "all",
    label: TOTAL_GROUP_LABEL,
    dayTokens: clients.reduce((sum, client) => sum + client.dayTokens, 0),
    dayRequests: clients.reduce((sum, client) => sum + client.dayRequests, 0),
    weekTokens: clients.reduce((sum, client) => sum + client.weekTokens, 0),
    // A total that silently drops an unpriced client reads as complete money.
    weekSpendUsd:
      priced.length === clients.length
        ? priced.reduce((sum, client) => sum + (client.weekSpendUsd ?? 0), 0)
        : null,
  };
}

/**
 * Zero is never shown. "Tokens · Today: 0 used" is a row that costs a line and
 * says only that the window is empty, which the absent row says better.
 */
function pushAmount(
  rows: AntigravityUsageRow[],
  row: { id: string; label: string; group: string; amount: number | null },
): void {
  if (row.amount === null || row.amount === 0) return;
  rows.push(row);
}

function usageRows(totals: readonly ClientTotals[]): AntigravityUsageRows {
  const rows: AntigravityUsageRows = { tokens: [], requests: [], spend: [] };
  for (const client of totals) {
    pushAmount(rows.requests, {
      id: `${client.id}-requests-day`,
      label: DAY_LABEL,
      group: client.label,
      amount: client.dayRequests,
    });
    pushAmount(rows.tokens, {
      id: `${client.id}-tokens-day`,
      label: DAY_LABEL,
      group: client.label,
      amount: client.dayTokens,
    });
    pushAmount(rows.tokens, {
      id: `${client.id}-tokens-week`,
      label: WEEK_LABEL,
      group: client.label,
      amount: client.weekTokens,
    });
    pushAmount(rows.spend, {
      id: `${client.id}-spend-week`,
      label: WEEK_LABEL,
      group: client.label,
      amount: client.weekSpendUsd,
    });
  }
  return rows;
}

export interface AntigravityUsageAdapters {
  clients: AntigravityClientAdapters;
  history: HistoryAdapters;
}

/**
 * Every Antigravity client's own accounting, in one set of rows. Exported
 * separately from the probe so the numbers can be read, and tested, without a
 * network call to the vendor.
 */
export function readAntigravityUsageRows(
  adapters: AntigravityUsageAdapters,
): AntigravityUsageRows {
  const nowMs = adapters.history.now().getTime();
  const clients = readAntigravityClientRows(nowMs - WEEK_WINDOW_MS, adapters.clients).map((client) =>
    totalsFromClient(client, nowMs),
  );
  const paseo = totalsFromHarness(
    "paseo",
    PASEO_CLIENT_LABEL,
    readAgentProviderWindows(
      OMP_ANTIGRAVITY_PROVIDER,
      [DAY_WINDOW_MS, WEEK_WINDOW_MS],
      adapters.history,
    ),
  );
  const used = clients.filter((client) => client.weekTokens > 0 || client.dayRequests > 0);
  const spenders = paseo === null ? used : [...used, paseo];
  const combined = combinedTotals(spenders);
  return usageRows(combined === null ? spenders : [combined, ...spenders]);
}

export function createNodeAntigravityUsageAdapters(): AntigravityUsageAdapters {
  return {
    clients: createNodeAntigravityClientAdapters(),
    history: createNodeHistoryAdapters(),
  };
}

/**
 * The quota probe still decides whether this provider is healthy: a keyring
 * with no Antigravity credential is a real failure and has to read as one. The
 * local rows ride along with it rather than replacing it.
 */
export async function probeAntigravityUsage(): Promise<AntigravityUsage> {
  const quota = await probeAntigravityQuota();
  return { ...quota, usage: readAntigravityUsageRows(createNodeAntigravityUsageAdapters()) };
}
