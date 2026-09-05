import { describe, expect, test } from "vitest";
import type { AntigravityStepUsage } from "./antigravity-clients.server";
import {
  type AntigravityUsageAdapters,
  type AntigravityUsageRow,
  readAntigravityUsageRows,
} from "./antigravity-usage.server";
import type { HistoryAdapters } from "./history.server";

const NOW = Date.parse("2026-09-04T20:00:00.000Z");
const HOUR_MS = 3_600_000;
const HOME = "/home/tester";
const OMP_DIR = `${HOME}/.omp/agent/sessions/-proj`;

interface Options {
  clientSteps?: Record<string, AntigravityStepUsage[]>;
  ompLines?: string[];
}

/**
 * omp names the vendor once, in a `model_change` line, and every later turn
 * inherits it — which is exactly how a transcript attributes tokens to
 * `google-antigravity` rather than to an unknown provider.
 */
function ompModelChangeLine(timestamp: string): string {
  return JSON.stringify({
    type: "model_change",
    timestamp,
    model: "google-antigravity/gemini-3.8-flash",
  });
}

function ompUsageLine(timestamp: string, tokens: number, costTotal: number | null): string {
  return JSON.stringify({
    type: "message",
    id: `line-${timestamp}-${tokens}`,
    timestamp,
    message: {
      role: "assistant",
      model: "gemini-3.8-flash",
      usage: {
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        ...(costTotal === null ? {} : { cost: { total: costTotal } }),
      },
    },
  });
}

function adapters(options: Options): AntigravityUsageAdapters {
  const norm = (value: string) => value.replace(/\\/g, "/");
  const clientSteps = options.clientSteps ?? {};
  const transcript = (options.ompLines ?? []).join("\n");
  const history: HistoryAdapters = {
    env: {},
    homeDir: HOME,
    listFiles(directory) {
      const wanted = norm(directory);
      const path = `${OMP_DIR}/a.jsonl`;
      const inside = path.startsWith(`${wanted}/`);
      return { files: transcript === "" || !inside ? [] : [path], errors: [] };
    },
    statFile(path) {
      return norm(path) === `${OMP_DIR}/a.jsonl` ? { mtimeMs: NOW, size: transcript.length } : null;
    },
    readTextFile(path) {
      return norm(path) === `${OMP_DIR}/a.jsonl` ? transcript : null;
    },
    readScanCacheFile() {
      return null;
    },
    writeScanCacheFile() {
      // The scan cache is a disk optimisation; these tests assert the numbers.
    },
    pricing: {
      env: {},
      homeDir: HOME,
      readTextFile: () => null,
      writeTextFile: () => undefined,
      fetchJson: async () => null,
      now: () => new Date(NOW),
    },
    now() {
      return new Date(NOW);
    },
  };
  return {
    history,
    clients: {
      homeDir: HOME,
      listStores(directory) {
        const wanted = norm(directory);
        return Object.keys(clientSteps).filter((path) => path.startsWith(wanted));
      },
      readStoreSteps(path, fromMs) {
        return (clientSteps[path] ?? []).filter((row) => row.timestampMs >= fromMs);
      },
      now: () => new Date(NOW),
    },
  };
}

function step(hoursAgo: number, tokens: number): AntigravityStepUsage {
  return {
    timestampMs: NOW - hoursAgo * HOUR_MS,
    uncachedInputTokens: tokens,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

function amountOf(rows: readonly AntigravityUsageRow[], id: string): number | null | undefined {
  return rows.find((row) => row.id === id)?.amount;
}

const CLI_STORE = `${HOME}/.gemini/antigravity-cli/conversations/a.db`;
describe("readAntigravityUsageRows", () => {
  test("counts a native client's tokens into the window each turn falls in", () => {
    const rows = readAntigravityUsageRows(
      adapters({ clientSteps: { [CLI_STORE]: [step(1, 100), step(30, 400), step(200, 999)] } }),
    );
    // The 30-hour-old turn is outside today, and the 200-hour-old one is
    // outside the week, so neither may reach the shorter total.
    expect(amountOf(rows.tokens, "cli-tokens-day")).toBe(100);
    expect(amountOf(rows.tokens, "cli-tokens-week")).toBe(500);
  });

  test("counts requests over the past day only", () => {
    const rows = readAntigravityUsageRows(
      adapters({ clientSteps: { [CLI_STORE]: [step(1, 10), step(23, 10), step(30, 10)] } }),
    );
    expect(amountOf(rows.requests, "cli-requests-day")).toBe(2);
  });

  test("reports no spend row for a client whose log carries no cost", () => {
    const rows = readAntigravityUsageRows(
      adapters({ clientSteps: { [CLI_STORE]: [step(1, 10)] } }),
    );
    expect(rows.spend).toEqual([]);
  });

  test("omits a row whose window is empty instead of reporting a zero", () => {
    const rows = readAntigravityUsageRows(
      adapters({ clientSteps: { [CLI_STORE]: [step(48, 10)] } }),
    );
    // The only turn is older than today, so today's rows have nothing to say.
    expect(rows.requests).toEqual([]);
    expect(rows.tokens.map((row) => row.id)).toEqual(["cli-tokens-week"]);
  });

  test("counts Paseo's own antigravity traffic from the omp transcripts", () => {
    const rows = readAntigravityUsageRows(
      adapters({
        ompLines: [
          ompModelChangeLine("2026-09-03T19:00:00.000Z"),
          ompUsageLine("2026-09-04T19:30:00.000Z", 1000, 0.25),
          ompUsageLine("2026-09-03T19:30:00.000Z", 4000, 0.75),
        ],
      }),
    );
    expect(amountOf(rows.tokens, "paseo-tokens-day")).toBe(1000);
    expect(amountOf(rows.tokens, "paseo-tokens-week")).toBe(5000);
    expect(amountOf(rows.requests, "paseo-requests-day")).toBe(1);
    expect(amountOf(rows.spend, "paseo-spend-week")).toBe(1);
  });

  test("reports no Paseo spend when one turn priced itself and another did not", () => {
    const rows = readAntigravityUsageRows(
      adapters({
        ompLines: [
          ompModelChangeLine("2026-09-04T19:00:00.000Z"),
          ompUsageLine("2026-09-04T19:30:00.000Z", 1000, 0.25),
          ompUsageLine("2026-09-04T19:40:00.000Z", 1000, null),
        ],
      }),
    );
    // A partial sum reads as complete money, so the row is withheld entirely.
    expect(rows.spend).toEqual([]);
  });

  test("leaves out every client with nothing in the widest window", () => {
    const rows = readAntigravityUsageRows(
      adapters({ clientSteps: { [CLI_STORE]: [step(400, 5000)] } }),
    );
    expect(rows).toEqual({ tokens: [], requests: [], spend: [] });
  });

  test("adds every client up, so the card leads with the total", () => {
    const rows = readAntigravityUsageRows(
      adapters({
        clientSteps: { [CLI_STORE]: [step(1, 10)] },
        ompLines: [
          ompModelChangeLine("2026-09-04T19:00:00.000Z"),
          ompUsageLine("2026-09-04T19:30:00.000Z", 1000, 0.25),
        ],
      }),
    );
    expect(rows.requests[0]).toEqual({
      id: "all-requests-day",
      label: "Today",
      group: "Every client",
      amount: 2,
    });
    expect(amountOf(rows.tokens, "all-tokens-day")).toBe(1010);
  });

  test("withholds the combined spend while one client reports no cost", () => {
    const rows = readAntigravityUsageRows(
      adapters({
        // The CLI's own logs carry no cost, so a total would be a partial sum.
        clientSteps: { [CLI_STORE]: [step(1, 10)] },
        ompLines: [
          ompModelChangeLine("2026-09-04T19:00:00.000Z"),
          ompUsageLine("2026-09-04T19:30:00.000Z", 1000, 0.25),
        ],
      }),
    );
    expect(amountOf(rows.spend, "all-spend-week")).toBeUndefined();
    expect(amountOf(rows.spend, "paseo-spend-week")).toBe(0.25);
  });

  test("states no total when one client is the only spender", () => {
    const rows = readAntigravityUsageRows(
      adapters({ clientSteps: { [CLI_STORE]: [step(1, 10)] } }),
    );
    expect(rows.requests.map((row) => row.group)).toEqual(["Antigravity CLI"]);
  });

  test("groups each row under the client that spent it", () => {
    const rows = readAntigravityUsageRows(
      adapters({
        clientSteps: { [CLI_STORE]: [step(1, 10)] },
        ompLines: [
          ompModelChangeLine("2026-09-04T19:00:00.000Z"),
          ompUsageLine("2026-09-04T19:30:00.000Z", 1000, 0.25),
        ],
      }),
    );
    expect(rows.requests.map((row) => row.group)).toEqual([
      "Every client",
      "Antigravity CLI",
      "Paseo (omp)",
    ]);
  });
});
