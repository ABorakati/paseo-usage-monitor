import { describe, expect, test } from "vitest";
import {
  type AntigravityClientAdapters,
  type AntigravityStepUsage,
  decodeStepUsage,
  readAntigravityClientRows,
} from "./antigravity-clients.server";

const SECONDS = 1_788_544_995;

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 127) {
    bytes.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
}

function field(number: number, value: number): number[] {
  return [...varint(number * 8), ...varint(value)];
}

function message(number: number, body: readonly number[]): number[] {
  return [...varint(number * 8 + 2), ...varint(body.length), ...body];
}

interface UsageFields {
  uncachedInput?: number;
  output?: number;
  cachedInput?: number;
  /** The two parts field 3 is split into; omitted means the row carries none. */
  outputParts?: readonly [number, number];
}

/**
 * A steps.metadata blob in the shape live stores were read in: field 1 is the
 * step's timestamp, field 9 the generation's usage.
 */
function stepBlob(usage: UsageFields, seconds: number = SECONDS): Uint8Array {
  const body = [
    ...field(1, usage.uncachedInput ?? 0),
    ...field(2, usage.uncachedInput ?? 0),
    ...field(3, usage.output ?? 0),
    ...field(5, usage.cachedInput ?? 0),
    ...(usage.outputParts === undefined
      ? []
      : [...field(9, usage.outputParts[0]), ...field(10, usage.outputParts[1])]),
  ];
  return new Uint8Array([
    ...message(1, [...field(1, seconds), ...field(2, 946_402_400)]),
    ...message(9, body),
  ]);
}

describe("decodeStepUsage", () => {
  test("reads the step's time and the three token categories", () => {
    const step = decodeStepUsage(
      stepBlob({ uncachedInput: 8442, output: 1424, cachedInput: 77_562, outputParts: [1346, 78] }),
    );
    expect(step).toEqual({
      timestampMs: SECONDS * 1000,
      uncachedInputTokens: 8442,
      cachedInputTokens: 77_562,
      outputTokens: 1424,
    });
  });

  test("drops a row whose output does not equal its two parts", () => {
    // The identity is the only evidence that field 3 is an output count, so a
    // blob that breaks it is a different schema and must not be reported.
    expect(decodeStepUsage(stepBlob({ output: 1424, outputParts: [1346, 79] }))).toBeNull();
  });

  test("keeps a row that carries no output split", () => {
    const step = decodeStepUsage(stepBlob({ uncachedInput: 12, output: 0 }));
    expect(step?.outputTokens).toBe(0);
  });

  test("ignores a step with no usage block, such as a tool call", () => {
    const blob = new Uint8Array([...message(1, [...field(1, SECONDS)]), ...message(4, field(2, 7))]);
    expect(decodeStepUsage(blob)).toBeNull();
  });

  test("rejects a counter sitting where the clock should be", () => {
    expect(decodeStepUsage(stepBlob({ output: 0 }, 1319))).toBeNull();
  });

  test("returns null for a truncated blob instead of throwing", () => {
    const full = stepBlob({ uncachedInput: 500, output: 10 });
    expect(decodeStepUsage(full.subarray(0, full.length - 3))).toBeNull();
  });
});

function fakeAdapters(stores: Record<string, AntigravityStepUsage[]>): AntigravityClientAdapters {
  return {
    homeDir: "/home/tester",
    listStores(directory) {
      const wanted = directory.replace(/\\/g, "/");
      return Object.keys(stores).filter((path) => path.startsWith(wanted));
    },
    readStoreSteps(path, fromMs) {
      return (stores[path] ?? []).filter((row) => row.timestampMs >= fromMs);
    },
    now() {
      return new Date(SECONDS * 1000);
    },
  };
}

function usageRow(timestampMs: number): AntigravityStepUsage {
  return {
    timestampMs,
    uncachedInputTokens: 10,
    cachedInputTokens: 20,
    outputTokens: 5,
  };
}

describe("readAntigravityClientRows", () => {
  test("names each client that has rows and leaves out the ones that do not", () => {
    const clients = readAntigravityClientRows(
      0,
      fakeAdapters({
        "/home/tester/.gemini/antigravity-cli/conversations/a.db": [usageRow(1000)],
        "/home/tester/.gemini/antigravity/conversations/b.db": [],
      }),
    );
    expect(clients.map((client) => client.label)).toEqual(["Antigravity CLI"]);
    expect(clients[0]?.rows).toHaveLength(1);
  });

  test("merges every store a client wrote", () => {
    const clients = readAntigravityClientRows(
      0,
      fakeAdapters({
        "/home/tester/.gemini/antigravity/conversations/a.db": [usageRow(1000)],
        "/home/tester/.gemini/antigravity/conversations/b.db": [usageRow(2000), usageRow(3000)],
      }),
    );
    expect(clients[0]?.rows).toHaveLength(3);
  });
});
