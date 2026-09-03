import { describe, expect, it } from "vitest";
import type { UsageTokenBreakdown } from "./history.shared";
import {
  loadPricingTable,
  MODALITY_CAPABILITY_SUFFIX_TOKENS,
  parseCachedRatesPayload,
  parseModelRates,
  priceBreakdown,
  resolveCacheFilePath,
  serializeCachedRatesPayload,
  type ModelRate,
  type PricingAdapters,
} from "./pricing.server";

interface MockFileStore {
  files: Map<string, string>;
  fetchCalls: string[];
  writeCalls: Array<{ path: string; text: string }>;
}

function createMockStore(initialFiles: Record<string, string> = {}): MockFileStore {
  const files = new Map<string, string>();
  for (const [filePath, content] of Object.entries(initialFiles)) {
    files.set(filePath, content);
  }
  return {
    files,
    fetchCalls: [],
    writeCalls: [],
  };
}

interface MockPricingAdaptersOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  store?: MockFileStore;
  fetchJsonImpl?: (url: string) => Promise<unknown>;
  nowDate?: Date;
}

function createMockPricingAdapters(options: MockPricingAdaptersOptions = {}): {
  adapters: PricingAdapters;
  store: MockFileStore;
} {
  const store = options.store ?? createMockStore();
  const env = options.env ?? {};
  const homeDir = options.homeDir ?? "/home/testuser";
  const currentTime = options.nowDate ?? new Date("2026-08-29T12:00:00.000Z");

  const defaultFetchImpl = async (url: string): Promise<unknown> => {
    store.fetchCalls.push(url);
    return {
      "claude-opus-5": {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_read_input_token_cost: 0.0000005,
        cache_creation_input_token_cost: 0.00000625,
        cache_creation_input_token_cost_above_1hr: 0.00001,
      },
      "claude-sonnet-5": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.0000002,
        cache_creation_input_token_cost: 0.0000025,
        cache_creation_input_token_cost_above_1hr: 0.000004,
      },
      "gpt-5.6-terra": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
        cache_creation_input_token_cost: 0.0000025,
      },
      "gpt-5.6-sol": {
        input_cost_per_token: 0.000004,
        output_cost_per_token: 0.00002,
        cache_read_input_token_cost: 0.0000004,
        cache_creation_input_token_cost: 0.000005,
      },
      "gemini-3.7-flash": {
        input_cost_per_token: 0.00000075,
        output_cost_per_token: 0.00000375,
        cache_read_input_token_cost: 0.000000075,
      },
      "openai/gpt-4o": {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.00000125,
      },
      "anthropic/special-legacy": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
    };
  };

  const fetchJson = options.fetchJsonImpl ?? defaultFetchImpl;

  const adapters: PricingAdapters = {
    env,
    homeDir,
    readTextFile(filePath: string): string | null {
      return store.files.get(filePath) ?? null;
    },
    writeTextFile(filePath: string, text: string): void {
      store.files.set(filePath, text);
      store.writeCalls.push({ path: filePath, text });
    },
    fetchJson(url: string): Promise<unknown> {
      return fetchJson(url);
    },
    now(): Date {
      return currentTime;
    },
  };

  return { adapters, store };
}

const SAMPLE_BREAKDOWN: UsageTokenBreakdown = {
  uncachedInputTokens: 1_000_000,
  cachedInputTokens: 2_000_000,
  cacheCreationTokens: 500_000,
  cacheCreationLongTtlTokens: 0,
  outputTokens: 100_000,
  reasoningTokens: 40_000,
  tokens: 3_600_000,
  costUsd: null,
  cacheSavingsUsd: null,
};

describe("Pricing cache path resolution", () => {
  it("resolves default path in ~/.paseo when PASEO_HOME is unset", () => {
    const { adapters } = createMockPricingAdapters({ homeDir: "/home/alice" });
    const expected = "/home/alice/.paseo/usage-limits/model-rates.json";
    expect(resolveCacheFilePath(adapters)).toBe(expected);
  });

  it("resolves path under PASEO_HOME when set", () => {
    const { adapters } = createMockPricingAdapters({
      homeDir: "/home/alice",
      env: { PASEO_HOME: "/custom/paseo/data" },
    });
    const expected = "/custom/paseo/data/usage-limits/model-rates.json";
    expect(resolveCacheFilePath(adapters)).toBe(expected);
  });
});

describe("LiteLLM parsing and serialization", () => {
  it("ignores entries lacking either input or output cost", () => {
    const rawData = {
      "valid-model": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000008,
      },
      "missing-output": {
        input_cost_per_token: 0.000002,
      },
      "missing-input": {
        output_cost_per_token: 0.000008,
      },
      "non-numeric": {
        input_cost_per_token: "free",
        output_cost_per_token: "free",
      },
    };

    const rates = parseModelRates(rawData);
    expect(rates.size).toBe(1);
    expect(rates.has("valid-model")).toBe(true);
    expect(rates.has("missing-output")).toBe(false);
    expect(rates.has("missing-input")).toBe(false);
  });

  it("serializes and round-trips cached payload", () => {
    const rates = new Map<string, ModelRate>([
      [
        "claude-opus-5",
        {
          inputPerToken: 0.000005,
          outputPerToken: 0.000025,
          cacheReadPerToken: 0.0000005,
          cacheWritePerToken: 0.00000625,
          cacheWriteLongTtlPerToken: 0.00001,
        },
      ],
    ]);

    const timestamp = "2026-08-29T10:00:00.000Z";
    const serialized = serializeCachedRatesPayload(timestamp, rates);
    const parsed = parseCachedRatesPayload(serialized);

    expect(parsed).not.toBeNull();
    expect(parsed?.fetchedAt).toBe(timestamp);
    expect(parsed?.rates.get("claude-opus-5")).toEqual(rates.get("claude-opus-5"));
  });

  it("parses long-TTL cache write rate from live-shaped document", () => {
    const rawData = {
      "claude-opus-5": {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_read_input_token_cost: 0.0000005,
        cache_creation_input_token_cost: 0.00000625,
        cache_creation_input_token_cost_above_1hr: 0.00001,
      },
      "model-without-long-ttl": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.0000002,
        cache_creation_input_token_cost: 0.0000025,
      },
    };

    const rates = parseModelRates(rawData);
    const opusRate = rates.get("claude-opus-5");
    expect(opusRate).toBeDefined();
    expect(opusRate?.cacheWritePerToken).toBe(0.00000625);
    expect(opusRate?.cacheWriteLongTtlPerToken).toBe(0.00001);

    const standardRate = rates.get("model-without-long-ttl");
    expect(standardRate).toBeDefined();
    expect(standardRate?.cacheWritePerToken).toBe(0.0000025);
    expect(standardRate?.cacheWriteLongTtlPerToken).toBeNull();
  });

  it("returns null for cached payload written in old shape lacking cacheWriteLongTtlPerToken", () => {
    const oldShapedPayload = JSON.stringify({
      fetchedAt: "2026-08-29T10:00:00.000Z",
      rates: {
        "claude-opus-5": {
          inputPerToken: 0.000005,
          outputPerToken: 0.000025,
          cacheReadPerToken: 0.0000005,
          cacheWritePerToken: 0.00000625,
        },
      },
    });

    const parsed = parseCachedRatesPayload(oldShapedPayload);
    expect(parsed).toBeNull();
  });

  it("returns null for malformed cached payload", () => {
    expect(parseCachedRatesPayload("not-json")).toBeNull();
    expect(parseCachedRatesPayload(JSON.stringify({ fetchedAt: "invalid-date" }))).toBeNull();
    expect(
      parseCachedRatesPayload(
        JSON.stringify({ fetchedAt: "2026-08-29T00:00:00.000Z", rates: "invalid" }),
      ),
    ).toBeNull();
  });
});
describe("loadPricingTable lifecycle and caching", () => {
  it("performs a fresh fetch populating rates and reporting status 'fresh'", async () => {
    const { adapters, store } = createMockPricingAdapters({
      nowDate: new Date("2026-08-29T12:00:00.000Z"),
    });

    const table = await loadPricingTable(adapters);

    expect(table.status).toBe("fresh");
    expect(table.fetchedAt).toBe("2026-08-29T12:00:00.000Z");
    expect(store.writeCalls.length).toBe(1);

    const opusRate = table.rateFor("claude-opus-5");
    expect(opusRate).not.toBeNull();
    expect(opusRate?.inputPerToken).toBe(0.000005);
    expect(opusRate?.outputPerToken).toBe(0.000025);
  });

  it("uses cache younger than 24h reporting status 'cached' with no network fetch", async () => {
    const cachePath = "/home/testuser/.paseo/usage-limits/model-rates.json";
    const cachedTime = "2026-08-29T06:00:00.000Z"; // 6 hours old
    const cachedPayload = serializeCachedRatesPayload(
      cachedTime,
      new Map([
        [
          "cached-test-model",
          {
            inputPerToken: 0.000001,
            outputPerToken: 0.000005,
            cacheReadPerToken: null,
            cacheWritePerToken: null,
            cacheWriteLongTtlPerToken: null,
          },
        ],
      ]),
    );

    const store = createMockStore({ [cachePath]: cachedPayload });
    const { adapters } = createMockPricingAdapters({
      store,
      nowDate: new Date("2026-08-29T12:00:00.000Z"),
    });

    const table = await loadPricingTable(adapters);

    expect(table.status).toBe("cached");
    expect(table.fetchedAt).toBe(cachedTime);
    expect(store.fetchCalls.length).toBe(0);
    expect(table.rateFor("cached-test-model")?.inputPerToken).toBe(0.000001);
  });

  it("refetches when cache is older than 24h (stale)", async () => {
    const cachePath = "/home/testuser/.paseo/usage-limits/model-rates.json";
    const staleTime = "2026-08-27T10:00:00.000Z"; // ~48h old (> 24h TTL)
    const stalePayload = serializeCachedRatesPayload(
      staleTime,
      new Map([
        [
          "stale-model",
          {
            inputPerToken: 0.000001,
            outputPerToken: 0.000002,
            cacheReadPerToken: null,
            cacheWritePerToken: null,
            cacheWriteLongTtlPerToken: null,
          },
        ],
      ]),
    );

    const store = createMockStore({ [cachePath]: stalePayload });
    const { adapters } = createMockPricingAdapters({
      store,
      nowDate: new Date("2026-08-29T12:00:00.000Z"),
    });

    const table = await loadPricingTable(adapters);

    expect(table.status).toBe("fresh");
    expect(table.fetchedAt).toBe("2026-08-29T12:00:00.000Z");
    expect(store.writeCalls.length).toBe(1);
    expect(table.rateFor("claude-opus-5")?.inputPerToken).toBe(0.000005);
  });

  it("falls back to existing cache reporting 'cached' when network fetch fails", async () => {
    const cachePath = "/home/testuser/.paseo/usage-limits/model-rates.json";
    const cachedTime = "2026-08-27T10:00:00.000Z"; // Stale cache
    const cachedPayload = serializeCachedRatesPayload(
      cachedTime,
      new Map([
        [
          "fallback-model",
          {
            inputPerToken: 0.0000033,
            outputPerToken: 0.000011,
            cacheReadPerToken: null,
            cacheWritePerToken: null,
            cacheWriteLongTtlPerToken: null,
          },
        ],
      ]),
    );

    const store = createMockStore({ [cachePath]: cachedPayload });
    const { adapters } = createMockPricingAdapters({
      store,
      nowDate: new Date("2026-08-29T12:00:00.000Z"),
      fetchJsonImpl: async () => {
        throw new Error("HTTP 503 Service Unavailable");
      },
    });

    const table = await loadPricingTable(adapters);

    expect(table.status).toBe("cached");
    expect(table.fetchedAt).toBe(cachedTime);
    expect(table.rateFor("fallback-model")?.inputPerToken).toBe(0.0000033);
  });

  it("reports 'unavailable' with null rates and NEVER throws when fetch fails and no cache exists", async () => {
    const { adapters } = createMockPricingAdapters({
      fetchJsonImpl: async () => {
        throw new Error("Network unreachable");
      },
    });

    let table = null;
    let thrownError: unknown = null;

    try {
      table = await loadPricingTable(adapters);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeNull();
    expect(table).not.toBeNull();
    expect(table?.status).toBe("unavailable");
    expect(table?.fetchedAt).toBeNull();
    expect(table?.rateFor("claude-opus-5")).toBeNull();
    expect(table?.rateFor("any-model")).toBeNull();
  });
});

describe("Model resolution order (Rule 3)", () => {
  it("resolves exact key match (Step 1)", async () => {
    const { adapters } = createMockPricingAdapters();
    const table = await loadPricingTable(adapters);

    const rate = table.rateFor("claude-opus-5");
    expect(rate).not.toBeNull();
    expect(rate?.inputPerToken).toBe(0.000005);
    expect(rate?.outputPerToken).toBe(0.000025);
  });

  it("resolves part after the last slash (Step 2)", async () => {
    const { adapters } = createMockPricingAdapters();
    const table = await loadPricingTable(adapters);

    const anthropicOpus = table.rateFor("anthropic/claude-opus-5");
    expect(anthropicOpus).not.toBeNull();
    expect(anthropicOpus?.inputPerToken).toBe(0.000005);

    const antigravityGemini = table.rateFor("google-antigravity/gemini-3.7-flash");
    expect(antigravityGemini).not.toBeNull();
    expect(antigravityGemini?.inputPerToken).toBe(0.00000075);
  });

  it("resolves vendor-prefixed candidate when base key is absent (Step 3)", async () => {
    const { adapters } = createMockPricingAdapters();
    const table = await loadPricingTable(adapters);

    // "special-legacy" is stored as "anthropic/special-legacy" in the mock table
    const rate = table.rateFor("special-legacy");
    expect(rate).not.toBeNull();
    expect(rate?.inputPerToken).toBe(0.000003);
  });

  it("resolves dated variant to base via longest-prefix match (Step 4)", async () => {
    const { adapters } = createMockPricingAdapters();
    const table = await loadPricingTable(adapters);

    const datedOpus = table.rateFor("claude-opus-5-2026-03-01");
    expect(datedOpus).not.toBeNull();
    expect(datedOpus?.inputPerToken).toBe(0.000005);

    const datedCodexSol = table.rateFor("openai-codex/gpt-5.6-sol-20260401");
    expect(datedCodexSol).not.toBeNull();
    expect(datedCodexSol?.inputPerToken).toBe(0.000004);
  });

  it("resolves unpriced models to release-channel preview key (Step 5)", async () => {
    const customFetchImpl = async () => ({
      "gemini-3-flash-preview": {
        input_cost_per_token: 0.0000005,
        output_cost_per_token: 0.000003,
        cache_read_input_token_cost: 0.00000005,
      },
      "gemini-3-pro-preview": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
      },
      "gemini-3.1-pro-preview": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
      },
    });

    const { adapters } = createMockPricingAdapters({ fetchJsonImpl: customFetchImpl });
    const table = await loadPricingTable(adapters);

    const flashRate = table.rateFor("gemini-3-flash");
    expect(flashRate).not.toBeNull();
    expect(flashRate?.inputPerToken).toBe(0.0000005);
    expect(flashRate?.outputPerToken).toBe(0.000003);
    expect(flashRate?.cacheReadPerToken).toBe(0.00000005);

    const proRate = table.rateFor("gemini-3-pro");
    expect(proRate).not.toBeNull();
    expect(proRate?.inputPerToken).toBe(0.000002);
    expect(proRate?.outputPerToken).toBe(0.000012);
    expect(proRate?.cacheReadPerToken).toBe(0.0000002);

    const pro31Rate = table.rateFor("gemini-3.1-pro");
    expect(pro31Rate).not.toBeNull();
    expect(pro31Rate?.inputPerToken).toBe(0.000002);
    expect(pro31Rate?.outputPerToken).toBe(0.000012);
    expect(pro31Rate?.cacheReadPerToken).toBe(0.0000002);

    const vendorProRate = table.rateFor("google-antigravity/gemini-3-pro");
    expect(vendorProRate).not.toBeNull();
    expect(vendorProRate?.inputPerToken).toBe(0.000002);
    expect(vendorProRate?.outputPerToken).toBe(0.000012);
  });

  it("resolves gemini-3-pro to preview key and never to prior image variants", async () => {
    // Image keys precede preview key in insertion order to fail naive prefix search
    const customFetchImpl = async () => ({
      "gemini-3-pro-image": {
        input_cost_per_token: 0.00005,
        output_cost_per_token: 0.0002,
      },
      "gemini-3-pro-image-preview": {
        input_cost_per_token: 0.00005,
        output_cost_per_token: 0.0002,
      },
      "gemini-3-pro-preview": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
      },
    });

    const { adapters } = createMockPricingAdapters({ fetchJsonImpl: customFetchImpl });
    const table = await loadPricingTable(adapters);

    const resolved = table.rateFor("gemini-3-pro");
    expect(resolved).not.toBeNull();
    expect(resolved?.inputPerToken).toBe(0.000002);
    expect(resolved?.outputPerToken).toBe(0.000012);
    expect(resolved?.cacheReadPerToken).toBe(0.0000002);
    expect(resolved?.inputPerToken).not.toBe(0.00005);
  });

  it("keeps model unpriced when only modality-suffixed candidates exist in the table", async () => {
    const customFetchImpl = async () => ({
      "gemini-3-pro-image": {
        input_cost_per_token: 0.00005,
        output_cost_per_token: 0.0002,
      },
      "gemini-3-pro-image-preview": {
        input_cost_per_token: 0.00005,
        output_cost_per_token: 0.0002,
      },
      "audio-model-audio": {
        input_cost_per_token: 0.00001,
        output_cost_per_token: 0.00005,
      },
      "custom-model-embedding": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000001,
      },
    });

    const { adapters } = createMockPricingAdapters({ fetchJsonImpl: customFetchImpl });
    const table = await loadPricingTable(adapters);

    expect(table.rateFor("gemini-3-pro")).toBeNull();
    expect(table.rateFor("google-antigravity/gemini-3-pro")).toBeNull();
    expect(table.rateFor("audio-model")).toBeNull();
    expect(table.rateFor("custom-model")).toBeNull();
  });
  it("exports required modality and capability suffix tokens", () => {
    const requiredTokens = [
      "image",
      "audio",
      "live",
      "tts",
      "embedding",
      "embed",
      "customtools",
      "vision",
      "realtime",
      "search",
      "moderation",
    ];
    for (const token of requiredTokens) {
      expect(MODALITY_CAPABILITY_SUFFIX_TOKENS).toContain(token);
    }
  });

  it("refuses inexact resolution to modality keys for adversarial queries", async () => {
    const customFetchImpl = async () => ({
      "gemini-3.1-flash-live-preview": {
        input_cost_per_token: 0.0000005,
        output_cost_per_token: 0.000003,
      },
      "vertex_ai/gemini-3-pro-image": {
        input_cost_per_token: 0.00005,
        output_cost_per_token: 0.0002,
      },
      "gemini-3.1-flash-image": {
        input_cost_per_token: 0.0000005,
        output_cost_per_token: 0.000003,
      },
    });

    const { adapters } = createMockPricingAdapters({ fetchJsonImpl: customFetchImpl });
    const table = await loadPricingTable(adapters);

    expect(table.rateFor("gemini-3.1-flash-live")).toBeNull();
    expect(table.rateFor("gemini-3-pro-image-only-fake")).toBeNull();
  });

  it("allows exact matches on modality keys to resolve to their own rates", async () => {
    const customFetchImpl = async () => ({
      "gemini-3-pro-image": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
      },
      "gemini-3.1-flash-image": {
        input_cost_per_token: 0.0000005,
        output_cost_per_token: 0.000003,
      },
      "gemini-3.1-flash-live-preview": {
        input_cost_per_token: 0.0000006,
        output_cost_per_token: 0.0000035,
      },
    });

    const { adapters } = createMockPricingAdapters({ fetchJsonImpl: customFetchImpl });
    const table = await loadPricingTable(adapters);

    const proImage = table.rateFor("gemini-3-pro-image");
    expect(proImage).not.toBeNull();
    expect(proImage?.inputPerToken).toBe(0.000002);
    expect(proImage?.outputPerToken).toBe(0.000012);

    const flashImage = table.rateFor("gemini-3.1-flash-image");
    expect(flashImage).not.toBeNull();
    expect(flashImage?.inputPerToken).toBe(0.0000005);
    expect(flashImage?.outputPerToken).toBe(0.000003);

    const livePreview = table.rateFor("gemini-3.1-flash-live-preview");
    expect(livePreview).not.toBeNull();
    expect(livePreview?.inputPerToken).toBe(0.0000006);
    expect(livePreview?.outputPerToken).toBe(0.0000035);
  });

  it("guards Step 2 (after-last-slash) against selecting modality keys", async () => {
    const customFetchImpl = async () => ({
      "model-image": {
        input_cost_per_token: 0.00001,
        output_cost_per_token: 0.00005,
      },
      "model-tts": {
        input_cost_per_token: 0.000015,
        output_cost_per_token: 0.00006,
      },
      "standard-text": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.00001,
      },
    });

    const { adapters } = createMockPricingAdapters({ fetchJsonImpl: customFetchImpl });
    const table = await loadPricingTable(adapters);

    // Inexact slash queries must be refused
    expect(table.rateFor("vendor/model-image")).toBeNull();
    expect(table.rateFor("vendor/model-tts")).toBeNull();

    // Exact matches must still succeed
    expect(table.rateFor("model-image")?.inputPerToken).toBe(0.00001);
    expect(table.rateFor("model-tts")?.inputPerToken).toBe(0.000015);
    expect(table.rateFor("vendor/standard-text")?.inputPerToken).toBe(0.000002);
  });

  it("guards Step 3 (vendor-prefixed candidates) against selecting modality keys", async () => {
    const customFetchImpl = async () => ({
      "anthropic/model-audio": {
        input_cost_per_token: 0.00002,
        output_cost_per_token: 0.00008,
      },
      "openai/model-vision": {
        input_cost_per_token: 0.00003,
        output_cost_per_token: 0.00012,
      },
      "anthropic/standard-model": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
      },
    });

    const { adapters } = createMockPricingAdapters({ fetchJsonImpl: customFetchImpl });
    const table = await loadPricingTable(adapters);

    // Inexact vendor-prefix queries must be refused
    expect(table.rateFor("model-audio")).toBeNull();
    expect(table.rateFor("model-vision")).toBeNull();

    // Exact matches must still succeed
    expect(table.rateFor("anthropic/model-audio")?.inputPerToken).toBe(0.00002);
    expect(table.rateFor("openai/model-vision")?.inputPerToken).toBe(0.00003);
    expect(table.rateFor("standard-model")?.inputPerToken).toBe(0.000003);
  });

  it("guards Step 4 (longest-prefix match) against selecting modality keys", async () => {
    const customFetchImpl = async () => ({
      "model-image": {
        input_cost_per_token: 0.00005,
        output_cost_per_token: 0.0002,
      },
      "claude-opus-5": {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
      },
    });

    const { adapters } = createMockPricingAdapters({ fetchJsonImpl: customFetchImpl });
    const table = await loadPricingTable(adapters);

    // Inexact prefix shortening onto modality keys must be refused
    expect(table.rateFor("model-image-extra")).toBeNull();
    expect(table.rateFor("model-image-20260801")).toBeNull();

    // Exact modality match succeeds
    expect(table.rateFor("model-image")?.inputPerToken).toBe(0.00005);

    // Non-modality dated variant legitimately resolves to base key
    expect(table.rateFor("claude-opus-5-20260801")?.inputPerToken).toBe(0.000005);
  });

  it("guards Step 5 (release-channel preview suffix) against selecting modality keys", async () => {
    const customFetchImpl = async () => ({
      "gemini-3.1-flash-live-preview": {
        input_cost_per_token: 0.0000005,
        output_cost_per_token: 0.000003,
      },
      "gemini-3-pro-preview": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
      },
    });

    const { adapters } = createMockPricingAdapters({ fetchJsonImpl: customFetchImpl });
    const table = await loadPricingTable(adapters);

    // Inexact preview candidate carrying modality token must be refused
    expect(table.rateFor("gemini-3.1-flash-live")).toBeNull();

    // Exact match on the preview modality key succeeds
    expect(table.rateFor("gemini-3.1-flash-live-preview")?.inputPerToken).toBe(0.0000005);

    // Standard preview resolution succeeds
    const proRate = table.rateFor("gemini-3-pro");
    expect(proRate).not.toBeNull();
    expect(proRate?.inputPerToken).toBe(0.000002);
    expect(proRate?.cacheReadPerToken).toBe(0.0000002);
  });

  it("resolves all real model IDs with exact expected rates", async () => {
    const fullTableFetchImpl = async () => ({
      "claude-haiku-4-5": {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000005,
        cache_read_input_token_cost: 0.0000001,
      },
      "claude-opus-4-8": {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_read_input_token_cost: 0.0000005,
      },
      "claude-opus-5": {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_read_input_token_cost: 0.0000005,
      },
      "claude-sonnet-4-5": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.0000003,
      },
      "claude-sonnet-4-6": {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.0000003,
      },
      "claude-sonnet-5": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.0000002,
      },
      "gemini-2.5-pro": {
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.000000125,
      },
      "gemini-3-flash-preview": {
        input_cost_per_token: 0.0000005,
        output_cost_per_token: 0.000003,
        cache_read_input_token_cost: 0.00000005,
      },
      "gemini-3-pro-preview": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
      },
      "gemini-3.1-pro-preview": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
      },
      "gemini-3.7-flash": {
        input_cost_per_token: 0.00000075,
        output_cost_per_token: 0.00000375,
        cache_read_input_token_cost: 0.000000075,
      },
      "gpt-5.5": {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.00003,
        cache_read_input_token_cost: 0.0000005,
      },
      "gpt-5.6-luna": {
        input_cost_per_token: 0.0000002,
        output_cost_per_token: 0.0000012,
        cache_read_input_token_cost: 0.00000002,
      },
      "gpt-5.6-sol": {
        input_cost_per_token: 0.000004,
        output_cost_per_token: 0.00002,
        cache_read_input_token_cost: 0.0000004,
      },
      "gpt-5.6-terra": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002,
      },
    });

    const { adapters } = createMockPricingAdapters({ fetchJsonImpl: fullTableFetchImpl });
    const table = await loadPricingTable(adapters);

    const expectedRates: Record<string, { input: number; output: number; cacheRead: number }> = {
      "claude-haiku-4-5": { input: 0.000001, output: 0.000005, cacheRead: 0.0000001 },
      "claude-opus-4-8": { input: 0.000005, output: 0.000025, cacheRead: 0.0000005 },
      "claude-opus-5": { input: 0.000005, output: 0.000025, cacheRead: 0.0000005 },
      "claude-sonnet-4-5": { input: 0.000003, output: 0.000015, cacheRead: 0.0000003 },
      "claude-sonnet-4-6": { input: 0.000003, output: 0.000015, cacheRead: 0.0000003 },
      "claude-sonnet-5": { input: 0.000002, output: 0.00001, cacheRead: 0.0000002 },
      "gemini-2.5-pro": { input: 0.00000125, output: 0.00001, cacheRead: 0.000000125 },
      "gemini-3-flash": { input: 0.0000005, output: 0.000003, cacheRead: 0.00000005 },
      "gemini-3-pro": { input: 0.000002, output: 0.000012, cacheRead: 0.0000002 },
      "gemini-3.1-pro": { input: 0.000002, output: 0.000012, cacheRead: 0.0000002 },
      "gemini-3.7-flash": { input: 0.00000075, output: 0.00000375, cacheRead: 0.000000075 },
      "gpt-5.5": { input: 0.000005, output: 0.00003, cacheRead: 0.0000005 },
      "gpt-5.6-luna": { input: 0.0000002, output: 0.0000012, cacheRead: 0.00000002 },
      "gpt-5.6-sol": { input: 0.000004, output: 0.00002, cacheRead: 0.0000004 },
      "gpt-5.6-terra": { input: 0.000002, output: 0.000012, cacheRead: 0.0000002 },
    };

    for (const [modelId, expected] of Object.entries(expectedRates)) {
      const rate = table.rateFor(modelId);
      expect(rate, `Expected rate for ${modelId} to exist`).not.toBeNull();
      expect(rate?.inputPerToken, `Input rate mismatch for ${modelId}`).toBe(expected.input);
      expect(rate?.outputPerToken, `Output rate mismatch for ${modelId}`).toBe(expected.output);
      expect(rate?.cacheReadPerToken, `Cache read rate mismatch for ${modelId}`).toBe(
        expected.cacheRead,
      );
    }
  });

  it("returns null for unresolvable models without guessing unrelated models", async () => {
    const { adapters } = createMockPricingAdapters();
    const table = await loadPricingTable(adapters);

    expect(table.rateFor("unknown-custom-model-999")).toBeNull();
    expect(table.rateFor("")).toBeNull();
    expect(table.rateFor("   ")).toBeNull();
  });
});

describe("Cost and cache savings calculation (Rule 4)", () => {
  const HAND_COMPUTED_RATE: ModelRate = {
    inputPerToken: 0.000003, // $3.00 / 1M
    outputPerToken: 0.000015, // $15.00 / 1M
    cacheReadPerToken: 0.0000003, // $0.30 / 1M
    cacheWritePerToken: 0.00000375, // $3.75 / 1M
    cacheWriteLongTtlPerToken: null,
  };

  it("calculates cost against hand-computed fixture", () => {
    // 1M uncached input * $3/M = $3.00
    // 2M cached input * $0.30/M = $0.60
    // 500k cache creation * $3.75/M = $1.875
    // 100k output * $15/M = $1.50
    // Total expected = $6.975
    // Cache savings: 2M * ($3.00 - $0.30) = $5.40
    const result = priceBreakdown(SAMPLE_BREAKDOWN, HAND_COMPUTED_RATE);

    expect(result.costUsd).toBeCloseTo(6.975, 6);
    expect(result.cacheSavingsUsd).toBeCloseTo(5.4, 6);
  });

  it("falls back to input rate when cacheReadPerToken or cacheWritePerToken is null", () => {
    const rateWithNullCache: ModelRate = {
      inputPerToken: 0.000003,
      outputPerToken: 0.000015,
      cacheReadPerToken: null,
      cacheWritePerToken: null,
      cacheWriteLongTtlPerToken: null,
    };
    // 1M uncached input * $3/M = $3.00
    // 2M cached input * $3/M (fallback) = $6.00
    // 500k cache creation * $3/M (fallback) = $1.50
    // 100k output * $15/M = $1.50
    // Total expected = $12.00
    // Cache savings: 2M * ($3.00 - $3.00) = $0.00
    const result = priceBreakdown(SAMPLE_BREAKDOWN, rateWithNullCache);

    expect(result.costUsd).toBeCloseTo(12.0, 6);
    expect(result.cacheSavingsUsd).toBe(0);
  });

  it("clamps cacheSavingsUsd at zero if cache read cost exceeds input cost", () => {
    const invertedRate: ModelRate = {
      inputPerToken: 0.000002,
      outputPerToken: 0.00001,
      cacheReadPerToken: 0.000005, // higher than input
      cacheWritePerToken: 0.000002,
      cacheWriteLongTtlPerToken: null,
    };
    const result = priceBreakdown(SAMPLE_BREAKDOWN, invertedRate);
    expect(result.cacheSavingsUsd).toBe(0);
  });

  it("never changes cost when reasoningTokens changes (subset of outputTokens)", () => {
    const breakdownA: UsageTokenBreakdown = {
      ...SAMPLE_BREAKDOWN,
      reasoningTokens: 0,
    };
    const breakdownB: UsageTokenBreakdown = {
      ...SAMPLE_BREAKDOWN,
      reasoningTokens: 80_000,
    };

    const costA = priceBreakdown(breakdownA, HAND_COMPUTED_RATE).costUsd;
    const costB = priceBreakdown(breakdownB, HAND_COMPUTED_RATE).costUsd;

    expect(costA).toBeCloseTo(6.975, 6);
    expect(costB).toBeCloseTo(6.975, 6);
    expect(costA).toBe(costB);
  });

  it("returns null costUsd and cacheSavingsUsd when rate is null", () => {
    const result = priceBreakdown(SAMPLE_BREAKDOWN, null);
    expect(result.costUsd).toBeNull();
    expect(result.cacheSavingsUsd).toBeNull();
  });
  it("prices long-TTL cache writes dearer than base rate writes (1.6x)", () => {
    const OPUS_RATE: ModelRate = {
      inputPerToken: 0.000005,
      outputPerToken: 0.000025,
      cacheReadPerToken: 0.0000005,
      cacheWritePerToken: 0.00000625,
      cacheWriteLongTtlPerToken: 0.00001, // 1.6x base write rate
    };

    const baseBreakdown: UsageTokenBreakdown = {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 500_000,
      cacheCreationLongTtlTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      tokens: 500_000,
      costUsd: null,
      cacheSavingsUsd: null,
    };

    const longTtlBreakdown: UsageTokenBreakdown = {
      ...baseBreakdown,
      cacheCreationLongTtlTokens: 500_000,
    };

    const baseCost = priceBreakdown(baseBreakdown, OPUS_RATE).costUsd;
    const longTtlCost = priceBreakdown(longTtlBreakdown, OPUS_RATE).costUsd;

    // 500k * $6.25/M = $3.125
    expect(baseCost).toBeCloseTo(3.125, 6);
    // 500k * $10.00/M = $5.000 (1.6x)
    expect(longTtlCost).toBeCloseTo(5.0, 6);
    if (baseCost !== null && longTtlCost !== null) {
      expect(longTtlCost).toBeGreaterThan(baseCost);
      expect(longTtlCost / baseCost).toBeCloseTo(1.6, 6);
    }
  });

  it("prices everything at the dear rate when longTtl equals cacheCreationTokens", () => {
    const rate: ModelRate = {
      inputPerToken: 0.000002,
      outputPerToken: 0.00001,
      cacheReadPerToken: 0.0000002,
      cacheWritePerToken: 0.0000025,
      cacheWriteLongTtlPerToken: 0.000004,
    };

    const breakdown: UsageTokenBreakdown = {
      uncachedInputTokens: 100_000, // $0.20
      cachedInputTokens: 0,
      cacheCreationTokens: 200_000, // 200k * $4.00/M = $0.80
      cacheCreationLongTtlTokens: 200_000,
      outputTokens: 50_000, // 50k * $10.00/M = $0.50
      reasoningTokens: 0,
      tokens: 350_000,
      costUsd: null,
      cacheSavingsUsd: null,
    };

    const result = priceBreakdown(breakdown, rate);
    expect(result.costUsd).toBeCloseTo(0.2 + 0.8 + 0.5, 6);
  });

  it("matches old behaviour exactly when longTtl is zero (regression guard)", () => {
    const rate: ModelRate = {
      inputPerToken: 0.000005,
      outputPerToken: 0.000025,
      cacheReadPerToken: 0.0000005,
      cacheWritePerToken: 0.00000625,
      cacheWriteLongTtlPerToken: 0.00001,
    };

    const breakdownZeroLongTtl: UsageTokenBreakdown = {
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 2_000_000,
      cacheCreationTokens: 500_000,
      cacheCreationLongTtlTokens: 0,
      outputTokens: 100_000,
      reasoningTokens: 40_000,
      tokens: 3_600_000,
      costUsd: null,
      cacheSavingsUsd: null,
    };

    const expectedCost =
      1_000_000 * 0.000005 + 2_000_000 * 0.0000005 + 500_000 * 0.00000625 + 100_000 * 0.000025;

    const result = priceBreakdown(breakdownZeroLongTtl, rate);
    expect(result.costUsd).toBeCloseTo(expectedCost, 6);
  });

  it("clamps longTtl when it exceeds cacheCreationTokens without producing negative shortTtl", () => {
    const rate: ModelRate = {
      inputPerToken: 0.000005,
      outputPerToken: 0.000025,
      cacheReadPerToken: 0.0000005,
      cacheWritePerToken: 0.00000625,
      cacheWriteLongTtlPerToken: 0.00001,
    };

    const overflowBreakdown: UsageTokenBreakdown = {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 500_000,
      cacheCreationLongTtlTokens: 800_000, // exceeds total cacheCreationTokens
      outputTokens: 0,
      reasoningTokens: 0,
      tokens: 500_000,
      costUsd: null,
      cacheSavingsUsd: null,
    };

    const result = priceBreakdown(overflowBreakdown, rate);
    // Clamped to 500k long-TTL tokens (shortTtl = 0), cost = 500k * $10.00/M = $5.00
    expect(result.costUsd).toBeCloseTo(5.0, 6);
  });

  it("falls back to base write rate when model has no long-TTL price", () => {
    const rateNoLongTtl: ModelRate = {
      inputPerToken: 0.000005,
      outputPerToken: 0.000025,
      cacheReadPerToken: 0.0000005,
      cacheWritePerToken: 0.00000625,
      cacheWriteLongTtlPerToken: null,
    };

    const breakdownWithLongTtl: UsageTokenBreakdown = {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 500_000,
      cacheCreationLongTtlTokens: 500_000,
      outputTokens: 0,
      reasoningTokens: 0,
      tokens: 500_000,
      costUsd: null,
      cacheSavingsUsd: null,
    };

    const result = priceBreakdown(breakdownWithLongTtl, rateNoLongTtl);
    // Falls back to base write rate: 500k * $6.25/M = $3.125
    expect(result.costUsd).toBeCloseTo(3.125, 6);
  });

  it("discards old-shaped cache file in loadPricingTable and fetches fresh rates", async () => {
    const cachePath = "/home/testuser/.paseo/usage-limits/model-rates.json";
    const oldCachePayload = JSON.stringify({
      fetchedAt: "2026-08-29T10:00:00.000Z",
      rates: {
        "claude-opus-5": {
          inputPerToken: 0.000005,
          outputPerToken: 0.000025,
          cacheReadPerToken: 0.0000005,
          cacheWritePerToken: 0.00000625,
        },
      },
    });

    const store = createMockStore({ [cachePath]: oldCachePayload });
    const { adapters } = createMockPricingAdapters({
      store,
      nowDate: new Date("2026-08-29T12:00:00.000Z"),
    });

    const table = await loadPricingTable(adapters);

    // Stale-shaped cache is discarded -> network fetch occurs -> fresh status returned
    expect(table.status).toBe("fresh");
    expect(store.fetchCalls.length).toBe(1);
    expect(table.rateFor("claude-opus-5")?.cacheWriteLongTtlPerToken).toBe(0.00001);
  });
});
