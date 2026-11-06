import { afterEach, describe, expect, test, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AntigravityQuotaAdapters,
  createNodeAntigravityQuotaAdapters,
  mapQuotaSummary,
  parseAgyUsage,
  probeAntigravityQuota,
} from "./antigravity-probe.server";

const FETCHED_AT = "2026-10-20T07:00:00Z";
// Synthetic agy 1.4.3-shaped quota: no credentials or account data.
const groups = [
  {
    display_name: "Gemini Models",
    buckets: [
      { bucket_id: "gemini-weekly", remaining_fraction: 0.75, reset_time: FETCHED_AT },
      { bucket_id: "gemini-5h", remaining_fraction: 0.5, reset_time: FETCHED_AT },
    ],
  },
  {
    display_name: "Claude and GPT models",
    buckets: [
      { bucket_id: "3p-weekly", remaining_fraction: 1, reset_time: FETCHED_AT },
      { bucket_id: "3p-5h", remaining_fraction: 0, reset_time: FETCHED_AT },
    ],
  },
  {
    display_name: "Gemini 4 Argon",
    buckets: [
      {
        bucket_id: "gemini-argon-wtu-weekly",
        display_name: "Weekly",
        window: "weekly",
        remaining_fraction: 0.25,
        reset_time: FETCHED_AT,
      },
      { bucket_id: "future-pool", remaining_fraction: 0.8, reset_time: "later" },
    ],
  },
];
const stdout = JSON.stringify({ command: { data: { groups } } });

function adapters(output = stdout): AntigravityQuotaAdapters {
  return {
    runCli: vi.fn(async () => output),
    probeKeyring: vi.fn(async () => mapQuotaSummary({}, "legacy", FETCHED_AT)),
    now: () => new Date(FETCHED_AT),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("agy /usage", () => {
  test("maps every pool, including Argon and future IDs, with stable legacy slots", () => {
    const quota = parseAgyUsage(stdout, FETCHED_AT);
    expect(quota.source).toBe("agy /usage");
    expect(quota.buckets.map((bucket) => bucket.id)).toEqual([
      "gemini-5h",
      "gemini-weekly",
      "3p-5h",
      "3p-weekly",
      "gemini-argon-wtu-weekly",
      "future-pool",
    ]);
    expect(quota.buckets.map((bucket) => bucket.usedPercent)).toEqual([
      50,
      25,
      100,
      0,
      75,
      expect.closeTo(20),
    ]);
    expect(quota.buckets[4]).toMatchObject({
      label: "Weekly",
      group: "Gemini 4 Argon",
      resetsAt: FETCHED_AT,
      durationMs: 604_800_000,
    });
    expect(quota.buckets[5]).toMatchObject({ label: "future-pool", resetsAt: null });
    expect(quota.buckets[5]?.durationMs).toBeUndefined();
  });

  test.each(["\x1b[>1;10;0c", "\x1b[?25l\x1b[32m", "\u009b>1;10;0c"])(
    "ignores terminal controls before JSON (%j)",
    (prefix) => {
      expect(parseAgyUsage(`${prefix}\n${stdout}\x1b[0m\n`, FETCHED_AT)).toEqual(
        parseAgyUsage(stdout, FETCHED_AT),
      );
    },
  );

  test("also handles camelCase API data and appends unknown API buckets", () => {
    const data = {
      groups: [
        {
          displayName: "New family",
          buckets: [
            {
              bucketId: "new-week",
              displayName: "New quota",
              remainingFraction: 0.5,
              resetTime: FETCHED_AT,
              window: "7d",
            },
          ],
        },
      ],
    };
    const expected = mapQuotaSummary(data, "agy /usage", FETCHED_AT);
    expect(parseAgyUsage(JSON.stringify({ command: { data } }), FETCHED_AT)).toEqual(expected);
    expect(expected.buckets[4]).toMatchObject({ id: "new-week", usedPercent: 50 });
  });

  test("clamps finite fractions and does not coerce malformed values", () => {
    const output = JSON.stringify({
      command: {
        data: {
          groups: [
            {
              buckets: [
                { id: "a", remaining_fraction: 2 },
                { id: "b", remaining_fraction: -1 },
                { id: "c", remaining_fraction: "0.5" },
                { id: "a", remaining_fraction: 0 },
                null,
                { remaining_fraction: 0.5 },
              ],
            },
          ],
        },
      },
    });
    const buckets = parseAgyUsage(output, FETCHED_AT).buckets.slice(4);
    expect(buckets.map((bucket) => [bucket.id, bucket.usedPercent])).toEqual([
      ["a", 0],
      ["b", 100],
      ["c", null],
    ]);
  });

  test("successful CLI quota never accesses the keyring fallback", async () => {
    const deps = adapters();
    await expect(probeAntigravityQuota(deps)).resolves.toMatchObject({ source: "agy /usage" });
    expect(deps.probeKeyring).not.toHaveBeenCalled();
  });

  test.each([
    "private raw output",
    "{}",
    '{"command":{"data":{"groups":[]}}}',
    JSON.stringify({ command: { data: { groups: [{ buckets: [{ id: "x" }] }] } } }),
  ])("falls back for invalid/unusable CLI output without logging it", async (output) => {
    const deps = adapters(output);
    await expect(probeAntigravityQuota(deps)).resolves.toMatchObject({ source: "legacy" });
    expect(deps.probeKeyring).toHaveBeenCalledOnce();
  });

  test.each(["ENOENT", "timeout", "exit 1", "maxBuffer"])("falls back on %s", async (reason) => {
    const deps = adapters();
    deps.runCli = vi.fn().mockRejectedValue(new Error(`${reason}: private subprocess output`));
    await expect(probeAntigravityQuota(deps)).resolves.toMatchObject({ source: "legacy" });
  });

  test("reports both sources failing without exposing CLI stdout/stderr", async () => {
    const deps = adapters();
    deps.runCli = vi.fn().mockRejectedValue(new Error("private subprocess output"));
    deps.probeKeyring = vi.fn().mockRejectedValue(new Error("no default collection"));
    await expect(probeAntigravityQuota(deps)).rejects.toThrow(
      "agy /usage failed; keyring fallback: no default collection",
    );
  });

  test("a hung CLI is aborted before the legacy fallback", async () => {
    vi.useFakeTimers();
    try {
      const deps = adapters();
      let signal: AbortSignal | undefined;
      deps.runCli = vi.fn((received) => {
        signal = received;
        return new Promise<string>(() => {});
      });
      const result = probeAntigravityQuota(deps);
      await vi.advanceTimersByTimeAsync(9_000);
      await expect(result).resolves.toMatchObject({ source: "legacy" });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Exercise real process execution and argv without touching a real agy login.
  test.skipIf(process.platform === "win32")(
    "runs the configured CLI with exact usage arguments",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "agy-usage-test-"));
      try {
        const binary = join(directory, "fake-agy");
        writeFileSync(
          binary,
          `#!${process.execPath}\nconst expected = ["--print", "/usage", "--output-format", "json"];\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(1);\nprocess.stdout.write(${JSON.stringify("\x1b[>1;10;0c" + stdout)});\n`,
        );
        chmodSync(binary, 0o700);
        vi.stubEnv("ANTIGRAVITY_AGY_PATH", binary);
        const deps = adapters();
        deps.runCli = createNodeAntigravityQuotaAdapters().runCli;
        await expect(probeAntigravityQuota(deps)).resolves.toMatchObject({ source: "agy /usage" });
        expect(deps.probeKeyring).not.toHaveBeenCalled();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
