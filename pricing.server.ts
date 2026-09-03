import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { UsageRatesStatus, UsageTokenBreakdown } from "./history.shared";

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PricingAdapters {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  readTextFile(path: string): string | null;
  writeTextFile(path: string, text: string): void;
  fetchJson(url: string): Promise<unknown>;
  now(): Date;
}

export function createNodePricingAdapters(): PricingAdapters {
  return {
    env: process.env,
    homeDir: os.homedir(),
    readTextFile(filePath: string): string | null {
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        return null;
      }
    },
    writeTextFile(filePath: string, text: string): void {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, text, "utf-8");
    },
    async fetchJson(url: string): Promise<unknown> {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch rates from ${url}: HTTP ${response.status} ${response.statusText}`,
        );
      }
      return await response.json();
    },
    now(): Date {
      return new Date();
    },
  };
}

export interface ModelRate {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number | null;
  cacheWritePerToken: number | null;
  cacheWriteLongTtlPerToken: number | null;
}

export interface PricingTable {
  status: UsageRatesStatus;
  fetchedAt: string | null;
  rateFor(model: string): ModelRate | null;
}

export interface CachedRatesPayload {
  fetchedAt: string;
  rates: Record<string, ModelRate>;
}

export const CachedRatesPayloadSchema = z.object({
  fetchedAt: z.string().refine((val) => !Number.isNaN(Date.parse(val)), {
    message: "Invalid ISO date string",
  }),
  rates: z.record(
    z.string(),
    z.object({
      inputPerToken: z.number(),
      outputPerToken: z.number(),
      cacheReadPerToken: z.number().nullable(),
      cacheWritePerToken: z.number().nullable(),
      cacheWriteLongTtlPerToken: z.number().nullable(),
    }),
  ),
});

export function resolveCacheFilePath(adapters: PricingAdapters): string {
  const customHome = adapters.env["PASEO_HOME"];
  if (customHome && customHome.trim().length > 0) {
    return path.join(customHome.trim(), "usage-limits", "model-rates.json");
  }
  return path.join(adapters.homeDir, ".paseo", "usage-limits", "model-rates.json");
}

export function parseModelRates(data: unknown): Map<string, ModelRate> {
  const rates = new Map<string, ModelRate>();
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return rates;
  }

  for (const [key, rawEntry] of Object.entries(data)) {
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      continue;
    }

    const inputCost =
      "input_cost_per_token" in rawEntry ? rawEntry.input_cost_per_token : undefined;
    const outputCost =
      "output_cost_per_token" in rawEntry ? rawEntry.output_cost_per_token : undefined;

    if (typeof inputCost !== "number" || !Number.isFinite(inputCost)) {
      continue;
    }
    if (typeof outputCost !== "number" || !Number.isFinite(outputCost)) {
      continue;
    }

    const cacheReadCost =
      "cache_read_input_token_cost" in rawEntry ? rawEntry.cache_read_input_token_cost : undefined;
    const cacheCreationCost =
      "cache_creation_input_token_cost" in rawEntry
        ? rawEntry.cache_creation_input_token_cost
        : undefined;
    const cacheCreationLongTtlCost =
      "cache_creation_input_token_cost_above_1hr" in rawEntry
        ? rawEntry.cache_creation_input_token_cost_above_1hr
        : undefined;

    const cacheReadPerToken =
      typeof cacheReadCost === "number" && Number.isFinite(cacheReadCost) ? cacheReadCost : null;

    const cacheWritePerToken =
      typeof cacheCreationCost === "number" && Number.isFinite(cacheCreationCost)
        ? cacheCreationCost
        : null;

    const cacheWriteLongTtlPerToken =
      typeof cacheCreationLongTtlCost === "number" && Number.isFinite(cacheCreationLongTtlCost)
        ? cacheCreationLongTtlCost
        : null;

    rates.set(key, {
      inputPerToken: inputCost,
      outputPerToken: outputCost,
      cacheReadPerToken,
      cacheWritePerToken,
      cacheWriteLongTtlPerToken,
    });
  }

  return rates;
}

export function parseCachedRatesPayload(
  text: string,
): { fetchedAt: string; rates: Map<string, ModelRate> } | null {
  try {
    const rawParsed: unknown = JSON.parse(text);
    const parseResult = CachedRatesPayloadSchema.safeParse(rawParsed);
    if (!parseResult.success) {
      return null;
    }

    const { fetchedAt, rates: rawRates } = parseResult.data;
    const rates = new Map<string, ModelRate>();
    for (const [key, rate] of Object.entries(rawRates)) {
      rates.set(key, rate);
    }

    return { fetchedAt, rates };
  } catch {
    return null;
  }
}

export function serializeCachedRatesPayload(
  fetchedAt: string,
  rates: Map<string, ModelRate>,
): string {
  const ratesRecord: Record<string, ModelRate> = {};
  for (const [key, rate] of rates.entries()) {
    ratesRecord[key] = rate;
  }
  const payload: CachedRatesPayload = {
    fetchedAt,
    rates: ratesRecord,
  };
  return JSON.stringify(payload, null, 2);
}

const VENDOR_PREFIXES: readonly string[] = ["anthropic/", "openai/", "gemini/", "vertex_ai/"];
const RELEASE_CHANNEL_SUFFIXES: readonly string[] = ["-preview"];

/**
 * Modality and capability suffix tokens that must never be selected by an
 * inexact match.
 *
 * An inexact match (such as longest-prefix shortening, vendor prefixing, or
 * release-channel suffix expansion) must never cross a modality boundary:
 * pricing an audio, image, embedding, or live model with text rates (or vice
 * versa) causes silent mispricing. A wrong rate is worse than no rate.
 */
export const MODALITY_CAPABILITY_SUFFIX_TOKENS: readonly string[] = [
  "image",
  "audio",
  "live",
  "tts",
  "embedding",
  "embeddings",
  "embed",
  "customtools",
  "vision",
  "realtime",
  "search",
  "moderation",
  "rerank",
  "reranker",
  "transcription",
  "translation",
  "speech",
  "stt",
  "video",
];

const MODALITY_CAPABILITY_SUFFIX_LOOKUP: Record<string, true> = Object.fromEntries(
  MODALITY_CAPABILITY_SUFFIX_TOKENS.map((token) => [token.toLowerCase(), true]),
);

function hasModalityOrCapabilitySuffix(key: string): boolean {
  const tokens = key.toLowerCase().split(/[-_/:.]/);
  for (const token of tokens) {
    if (MODALITY_CAPABILITY_SUFFIX_LOOKUP[token] === true) {
      return true;
    }
  }
  return false;
}

const DELIMITER_CHARS: Record<string, true> = {
  "-": true,
  _: true,
  "@": true,
  ".": true,
  ":": true,
};

export function createModelRateResolver(
  rates: Map<string, ModelRate>,
): (model: string) => ModelRate | null {
  const knownKeys = Array.from(rates.keys());

  return function rateFor(model: string): ModelRate | null {
    const raw = model.trim();
    if (raw.length === 0) {
      return null;
    }

    // Step 1: Exact key match (unrestricted - user explicitly requested this exact model)
    const exactRate = rates.get(raw);
    if (exactRate !== undefined) {
      return exactRate;
    }

    // Step 2: Part after the last slash
    const lastSlashIndex = raw.lastIndexOf("/");
    const afterSlash = lastSlashIndex !== -1 ? raw.slice(lastSlashIndex + 1) : null;
    if (afterSlash !== null && afterSlash.length > 0) {
      if (!hasModalityOrCapabilitySuffix(afterSlash)) {
        const afterSlashRate = rates.get(afterSlash);
        if (afterSlashRate !== undefined) {
          return afterSlashRate;
        }
      }
    }

    // Step 3: Standard vendor-prefixed candidates
    const baseName = afterSlash !== null && afterSlash.length > 0 ? afterSlash : raw;
    for (const prefix of VENDOR_PREFIXES) {
      const vendorCandidate = `${prefix}${baseName}`;
      if (!hasModalityOrCapabilitySuffix(vendorCandidate)) {
        const vendorRate = rates.get(vendorCandidate);
        if (vendorRate !== undefined) {
          return vendorRate;
        }
      }
    }

    // Step 4: Longest-prefix match against known keys so dated variants resolve to base
    const prefixCandidates: string[] = [raw];
    if (afterSlash !== null && afterSlash.length > 0 && afterSlash !== raw) {
      prefixCandidates.push(afterSlash);
    }
    for (const prefix of VENDOR_PREFIXES) {
      prefixCandidates.push(`${prefix}${baseName}`);
    }

    let matchedRate: ModelRate | null = null;
    let longestMatchLength = 0;

    for (const candidate of prefixCandidates) {
      for (const knownKey of knownKeys) {
        if (hasModalityOrCapabilitySuffix(knownKey)) {
          continue;
        }
        if (candidate.startsWith(knownKey)) {
          const suffixIndex = knownKey.length;
          if (candidate.length === suffixIndex) {
            if (knownKey.length > longestMatchLength) {
              matchedRate = rates.get(knownKey) ?? null;
              longestMatchLength = knownKey.length;
            }
          } else {
            const nextChar = candidate[suffixIndex];
            if (nextChar !== undefined && DELIMITER_CHARS[nextChar] === true) {
              if (knownKey.length > longestMatchLength) {
                matchedRate = rates.get(knownKey) ?? null;
                longestMatchLength = knownKey.length;
              }
            }
          }
        }
      }
    }

    if (matchedRate !== null) {
      return matchedRate;
    }

    // Step 5: Explicit release-channel suffixes (e.g. -preview)
    // When a model is unpriced because the pricing table lists it only under an active preview
    // channel (e.g. "gemini-3-pro" -> "gemini-3-pro-preview"), try exact release-channel suffixes.
    //
    // A wrong rate is worse than no rate: we NEVER use generic prefix matching here. Generic prefix
    // matching would match modality variants like "gemini-3-pro-image" or "gemini-3-pro-image-preview",
    // mispricing text tokens at image rates. Only explicit, pure release-channel suffixes are allowed.
    for (const suffix of RELEASE_CHANNEL_SUFFIXES) {
      const exactSuffixCandidate = `${raw}${suffix}`;
      if (!hasModalityOrCapabilitySuffix(exactSuffixCandidate)) {
        const exactSuffixRate = rates.get(exactSuffixCandidate);
        if (exactSuffixRate !== undefined) {
          return exactSuffixRate;
        }
      }

      if (afterSlash !== null && afterSlash.length > 0 && afterSlash !== raw) {
        const afterSlashSuffixCandidate = `${afterSlash}${suffix}`;
        if (!hasModalityOrCapabilitySuffix(afterSlashSuffixCandidate)) {
          const afterSlashSuffixRate = rates.get(afterSlashSuffixCandidate);
          if (afterSlashSuffixRate !== undefined) {
            return afterSlashSuffixRate;
          }
        }
      }

      for (const prefix of VENDOR_PREFIXES) {
        const vendorSuffixCandidate = `${prefix}${baseName}${suffix}`;
        if (!hasModalityOrCapabilitySuffix(vendorSuffixCandidate)) {
          const vendorSuffixRate = rates.get(vendorSuffixCandidate);
          if (vendorSuffixRate !== undefined) {
            return vendorSuffixRate;
          }
        }
      }
    }

    return null;
  };
}

export async function loadPricingTable(adapters: PricingAdapters): Promise<PricingTable> {
  const cachePath = resolveCacheFilePath(adapters);
  const cachedText = adapters.readTextFile(cachePath);
  const cached = cachedText !== null ? parseCachedRatesPayload(cachedText) : null;

  if (cached !== null) {
    const cachedTime = new Date(cached.fetchedAt).getTime();
    const currentTime = adapters.now().getTime();
    const ageMs = currentTime - cachedTime;

    if (ageMs >= 0 && ageMs < CACHE_TTL_MS) {
      return {
        status: "cached",
        fetchedAt: cached.fetchedAt,
        rateFor: createModelRateResolver(cached.rates),
      };
    }
  }

  try {
    const json = await adapters.fetchJson(LITELLM_PRICES_URL);
    const rates = parseModelRates(json);

    if (rates.size === 0) {
      throw new Error("No valid model rates found in fetched JSON payload");
    }

    const fetchedAt = adapters.now().toISOString();
    try {
      adapters.writeTextFile(cachePath, serializeCachedRatesPayload(fetchedAt, rates));
    } catch {
      // Disk write failure must not fail the in-memory load
    }

    return {
      status: "fresh",
      fetchedAt,
      rateFor: createModelRateResolver(rates),
    };
  } catch {
    if (cached !== null) {
      return {
        status: "cached",
        fetchedAt: cached.fetchedAt,
        rateFor: createModelRateResolver(cached.rates),
      };
    }

    return {
      status: "unavailable",
      fetchedAt: null,
      rateFor: () => null,
    };
  }
}

export function priceBreakdown(
  breakdown: UsageTokenBreakdown,
  rate: ModelRate | null,
): { costUsd: number | null; cacheSavingsUsd: number | null } {
  if (rate === null) {
    return { costUsd: null, cacheSavingsUsd: null };
  }
  // When cacheReadPerToken is null, fall back to the input rate for cache reads
  const cacheReadRate =
    rate.cacheReadPerToken !== null ? rate.cacheReadPerToken : rate.inputPerToken;

  // When cacheWritePerToken is null, fall back to the input rate for cache writes
  const cacheWriteRate =
    rate.cacheWritePerToken !== null ? rate.cacheWritePerToken : rate.inputPerToken;

  // When cacheWriteLongTtlPerToken is null, fall back to the base cache write rate
  const cacheWriteLongTtlRate =
    rate.cacheWriteLongTtlPerToken !== null ? rate.cacheWriteLongTtlPerToken : cacheWriteRate;

  // Guard the subtraction: if longTtl exceeds cacheCreationTokens, treat the whole category as long-TTL
  const totalCacheCreation = breakdown.cacheCreationTokens;
  const rawLongTtl = breakdown.cacheCreationLongTtlTokens;

  const longTtlTokens = Math.min(Math.max(0, rawLongTtl), totalCacheCreation);
  const shortTtlTokens = totalCacheCreation - longTtlTokens;

  const cacheWriteCost = shortTtlTokens * cacheWriteRate + longTtlTokens * cacheWriteLongTtlRate;

  const costUsd =
    breakdown.uncachedInputTokens * rate.inputPerToken +
    breakdown.cachedInputTokens * cacheReadRate +
    cacheWriteCost +
    breakdown.outputTokens * rate.outputPerToken;
  const cacheSavingsUsd = Math.max(
    0,
    breakdown.cachedInputTokens * (rate.inputPerToken - cacheReadRate),
  );

  return {
    costUsd,
    cacheSavingsUsd,
  };
}
