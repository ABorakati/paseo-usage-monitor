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
/** The vendor meters a rolling five hours, so the headline row matches it. */
const SESSION_WINDOW_MS = 5 * HOUR_MS;
const DAY_WINDOW_MS = 24 * HOUR_MS;
const WEEK_WINDOW_MS = 7 * 24 * HOUR_MS;

/** Paseo drives Antigravity through omp, which labels the vendor this way. */
const OMP_ANTIGRAVITY_PROVIDER = "omp-google-antigravity";
const PASEO_CLIENT_LABEL = "Paseo (omp)";
const TOTAL_GROUP_LABEL = "Every client";

const SESSION_LABEL = "Session · last 5h";
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
  /**
   * The headline group's session rows are reported even at zero: "nothing in
   * the last five hours" is the answer somebody glancing at the card wants,
   * and an absent row would read as a broken reader instead.
   */
  headline: boolean;
  sessionTokens: number;
  sessionRequests: number;
  dayTokens: number;
  dayRequests: number;
  /** Null where the client's log reports no cost of its own. */
  weekSpendUsd: number | null;
  weekRequests: number;
}

function totalsFromClient(client: AntigravityClientRows, nowMs: number): ClientTotals {
  const totals: ClientTotals = {
    id: client.id,
    label: client.label,
    headline: false,
    sessionTokens: 0,
    sessionRequests: 0,
    dayTokens: 0,
    dayRequests: 0,
    weekSpendUsd: null,
    weekRequests: 0,
  };
  for (const row of client.rows) {
    const age = nowMs - row.timestampMs;
    if (age < 0 || age > WEEK_WINDOW_MS) continue;
    const tokens = row.uncachedInputTokens + row.cachedInputTokens + row.outputTokens;
    totals.weekRequests += 1;
    if (age > DAY_WINDOW_MS) continue;
    totals.dayTokens += tokens;
    totals.dayRequests += 1;
    if (age > SESSION_WINDOW_MS) continue;
    totals.sessionTokens += tokens;
    totals.sessionRequests += 1;
  }
  return totals;
}

function totalsFromHarness(
  id: string,
  label: string,
  windows: readonly AgentProviderWindow[],
): ClientTotals | null {
  const [session, day, week] = windows;
  if (session === undefined || day === undefined || week === undefined) return null;
  if (week.requests === 0) return null;
  return {
    id,
    label,
    headline: false,
    sessionTokens: session.tokens,
    sessionRequests: session.requests,
    dayTokens: day.tokens,
    dayRequests: day.requests,
    weekSpendUsd: week.costUsd,
    weekRequests: week.requests,
  };
}

/**
 * The headline is every client added up, because the vendor's five-hour pool is
 * shared: what matters is the total in the window, not which tool spent it. The
 * per-client rows below say where it went. With one client the total would
 * restate it, so that client becomes the headline instead.
 */
function withHeadline(clients: readonly ClientTotals[]): ClientTotals[] {
  const [only] = clients;
  if (clients.length === 0) return [];
  if (clients.length === 1 && only !== undefined) return [{ ...only, headline: true }];
  const priced = clients.filter((client) => client.weekSpendUsd !== null);
  const combined: ClientTotals = {
    id: "all",
    label: TOTAL_GROUP_LABEL,
    headline: true,
    sessionTokens: clients.reduce((sum, client) => sum + client.sessionTokens, 0),
    sessionRequests: clients.reduce((sum, client) => sum + client.sessionRequests, 0),
    dayTokens: clients.reduce((sum, client) => sum + client.dayTokens, 0),
    dayRequests: clients.reduce((sum, client) => sum + client.dayRequests, 0),
    // A total that silently drops an unpriced client reads as complete money.
    weekSpendUsd:
      priced.length === clients.length
        ? priced.reduce((sum, client) => sum + (client.weekSpendUsd ?? 0), 0)
        : null,
    weekRequests: clients.reduce((sum, client) => sum + client.weekRequests, 0),
  };
  return [combined, ...clients];
}

interface RowInput {
  id: string;
  label: string;
  group: string;
  amount: number | null;
}

/**
 * Outside the headline, zero is never shown: "Tokens · Today: 0 used" costs a
 * line and says only that the window is empty, which the absent row says
 * better.
 */
function pushAmount(rows: AntigravityUsageRow[], row: RowInput, keepZero = false): void {
  if (row.amount === null) return;
  if (row.amount === 0 && !keepZero) return;
  rows.push(row);
}

/**
 * A window only one client touched needs no breakdown: its per-client row would
 * repeat the headline figure under a second heading. So a metric is broken down
 * only where two or more clients spent inside it.
 */
function contributors(
  clients: readonly ClientTotals[],
  amountOf: (client: ClientTotals) => number | null,
): number {
  return clients.filter((client) => (amountOf(client) ?? 0) > 0).length;
}

function usageRows(totals: readonly ClientTotals[]): AntigravityUsageRows {
  const rows: AntigravityUsageRows = { tokens: [], requests: [], spend: [] };
  const breakdown = totals.filter((client) => !client.headline);
  const splitSession = contributors(breakdown, (client) => client.sessionRequests) > 1;
  const splitDay = contributors(breakdown, (client) => client.dayRequests) > 1;
  // A combined spend is withheld while any client reports none, so the clients
  // that do price themselves have to say so individually or the money vanishes.
  const headlineSpend = totals.find((client) => client.headline)?.weekSpendUsd ?? null;
  const splitSpend =
    headlineSpend === null || contributors(breakdown, (client) => client.weekSpendUsd) > 1;
  for (const client of totals) {
    if (client.headline || splitSession) {
      pushAmount(
        rows.requests,
        {
          id: `${client.id}-requests-session`,
          label: SESSION_LABEL,
          group: client.label,
          amount: client.sessionRequests,
        },
        client.headline,
      );
      pushAmount(
        rows.tokens,
        {
          id: `${client.id}-tokens-session`,
          label: SESSION_LABEL,
          group: client.label,
          amount: client.sessionTokens,
        },
        client.headline,
      );
    }
    if (client.headline || splitDay) {
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
    }
    if (client.headline || splitSpend) {
      pushAmount(rows.spend, {
        id: `${client.id}-spend-week`,
        label: WEEK_LABEL,
        group: client.label,
        amount: client.weekSpendUsd,
      });
    }
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
      [SESSION_WINDOW_MS, DAY_WINDOW_MS, WEEK_WINDOW_MS],
      adapters.history,
    ),
  );
  const used = clients.filter((client) => client.weekRequests > 0);
  return usageRows(withHeadline(paseo === null ? used : [...used, paseo]));
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
