import { USAGE_LOGOS } from "./logos.shared";
import { describe, expect, test } from "vitest";
import {
  USAGE_PROVIDER_ID_PATTERN,
  UsageIconSchema,
  type UsageCredentialSource,
  type UsageProvider,
} from "./limits.shared";
import { USAGE_PRESETS, getUsagePreset, listUsagePresetIds } from "./presets.shared";
import { projectReadings, requiresSourceDocument } from "./readings.server";
import { buildProviderRegistry } from "./registry.server";

const presetEntries = Object.entries(USAGE_PRESETS);

function collectStringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringLeaves);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectStringLeaves);
  }
  return [];
}

function collectSourceStrings(source: UsageProvider["source"]): string[] {
  if (!source) return [];
  if (source.kind === "probe") return [];
  // A file source's `${VAR}` is an environment variable read from this machine,
  // never a credential, so it is not part of the credential invariant below.
  if (source.kind === "file") return [];
  if (source.kind === "command") {
    return source.cwd ? [...source.command, source.cwd] : [...source.command];
  }
  return [source.url, ...Object.values(source.headers), ...collectStringLeaves(source.body)];
}

function referencedVariables(strings: readonly string[]): string[] {
  const names = new Set<string>();
  for (const text of strings) {
    for (const match of text.matchAll(/\$\{([^}]+)\}/g)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names];
}
const VERIFIED_LUCIDE_ICONS = new Set([
  "Bot",
  "Brain",
  "Sparkles",
  "Gauge",
  "Zap",
  "Wind",
  "Waves",
  "Anchor",
  "Atom",
  "Cpu",
  "Boxes",
  "Layers",
  "Coins",
  "Wallet",
  "CircleDollarSign",
  "Rocket",
  "Feather",
  "Flame",
  "Snowflake",
  "Gem",
  "Orbit",
  "Radar",
  "Satellite",
  "Server",
  "Cloud",
  "CloudCog",
  "Component",
  "Puzzle",
  "Blocks",
  "Shapes",
  "Hexagon",
  "Triangle",
  "Circle",
  "Square",
]);

describe("usage presets", () => {
  test("ships a non-empty catalogue", () => {
    expect(presetEntries.length).toBeGreaterThan(0);
    expect(listUsagePresetIds()).toEqual(Object.keys(USAGE_PRESETS));
  });

  test.each(presetEntries)("%s carries materialised schema defaults", (_id, provider) => {
    expect(typeof provider.unverified).toBe("boolean");
    expect(typeof provider.enabled).toBe("boolean");
    expect(typeof provider.refreshIntervalMs).toBe("number");
  });

  test.each(presetEntries)("%s has a well-formed id", (id) => {
    expect(USAGE_PROVIDER_ID_PATTERN.test(id)).toBe(true);
  });

  test.each(presetEntries)(
    "%s declares every variable its source interpolates",
    (_id, provider) => {
      const used = referencedVariables(collectSourceStrings(provider.source));
      const declared = Object.keys(provider.credentials);
      for (const name of used) {
        expect(declared).toContain(name);
      }
    },
  );

  test("a file source reads the machine, never a credential", () => {
    for (const [id, provider] of presetEntries) {
      const source = provider.source;
      if (source?.kind !== "file") continue;
      const declared = Object.keys(provider.credentials);
      for (const name of referencedVariables(source.files)) {
        // A path expanding a declared credential would write a secret into a
        // filename, and would resolve from the wrong lookup besides.
        expect([id, name, declared.includes(name)]).toEqual([id, name, false]);
      }
      // Reading a local document is the whole point: nothing to expire.
      expect([id, declared]).toEqual([id, []]);
    }
  });

  test.each(presetEntries)("%s has unique reading ids", (_id, provider) => {
    const ids = provider.readings.map((reading) => reading.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("an unverified preset never points at a real host", () => {
    for (const [id, provider] of presetEntries) {
      const source = provider.source;
      if (source === undefined) {
        // Schedule-only: nothing is fetched, so there is no host to verify.
        expect([id, requiresSourceDocument(provider.readings)]).toEqual([id, false]);
        expect([id, provider.unverified]).toEqual([id, false]);
        continue;
      }
      if (source.kind === "probe") {
        expect([id, provider.unverified]).toEqual([id, true]);
        continue;
      }
      if (source.kind === "file") {
        // No host is contacted, so there is no guessed endpoint to flag. The
        // shape is the local tool's own, which is what verified means here.
        expect([id, provider.unverified]).toEqual([id, false]);
        continue;
      }
      expect([id, source.kind]).toEqual([id, "http"]);
      const url = source.kind === "http" ? source.url : "";
      expect([id, url.includes("example.invalid")]).toEqual([id, provider.unverified]);
    }
  });

  test("every unverified preset explains itself in its description", () => {
    for (const [, provider] of presetEntries) {
      if (!provider.unverified) continue;
      expect(provider.description).toBeTruthy();
      expect(provider.description).toMatch(/^Unverified: /);
      expect(provider.description).toMatch(/template|without notice/i);
    }
  });

  test("claude polls the throttled Anthropic endpoint every 30 minutes", () => {
    expect(getUsagePreset("claude")?.refreshIntervalMs).toBe(1_800_000);
  });
  describe("preset icons", () => {
    test.each(presetEntries)("%s declares a valid icon", (id, provider) => {
      expect(provider.icon).toBeDefined();
      const parsed = UsageIconSchema.parse(provider.icon);

      if (parsed.kind === "image") {
        // A preset's artwork is inlined, so rendering a card never reaches the
        // network. A remote URL here would fetch from a vendor on every render.
        expect(parsed.uri.startsWith("data:image/png;base64,")).toBe(true);
      } else if (parsed.kind === "monogram") {
        expect(parsed.text.length).toBeGreaterThanOrEqual(1);
        expect(parsed.text.length).toBeLessThanOrEqual(2);
        if (parsed.color !== undefined) {
          expect(parsed.color).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
      } else if (parsed.kind === "lucide") {
        expect(VERIFIED_LUCIDE_ICONS.has(parsed.name)).toBe(true);
      }
    });

    test("every preset declares an icon", () => {
      for (const [id, provider] of presetEntries) {
        expect([id, provider.icon !== undefined]).toEqual([id, true]);
      }
    });

    test("every icon parses under UsageIconSchema", () => {
      for (const [id, provider] of presetEntries) {
        expect([id, UsageIconSchema.safeParse(provider.icon).success]).toEqual([id, true]);
      }
    });

    test("a preset's image icon is inlined, never a remote fetch", () => {
      for (const [id, provider] of presetEntries) {
        if (provider.icon?.kind !== "image") continue;
        expect([id, provider.icon.uri.startsWith("data:image/png;base64,")]).toEqual([id, true]);
      }
    });

    test("every generated logo is claimed by the preset it was generated for", () => {
      for (const [id, uri] of Object.entries(USAGE_LOGOS)) {
        const provider = USAGE_PRESETS[id];
        expect([id, provider?.icon]).toEqual([id, { kind: "image", uri }]);
      }
    });

    test("a preset without a generated logo keeps a drawable mark", () => {
      for (const [id, provider] of presetEntries) {
        if (USAGE_LOGOS[id] !== undefined) continue;
        expect([id, provider.icon?.kind]).toEqual([id, provider.icon?.kind]);
        expect([id, provider.icon?.kind === "image"]).toEqual([id, false]);
      }
    });

    test("every lucide icon name is in the verified set", () => {
      for (const [id, provider] of presetEntries) {
        if (provider.icon?.kind === "lucide") {
          expect([id, VERIFIED_LUCIDE_ICONS.has(provider.icon.name)]).toEqual([id, true]);
        }
      }
    });

    test("monogram icons have 1-2 characters and valid hex color if present", () => {
      for (const [_id, provider] of presetEntries) {
        if (provider.icon?.kind === "monogram") {
          expect(provider.icon.text.length).toBeGreaterThanOrEqual(1);
          expect(provider.icon.text.length).toBeLessThanOrEqual(2);
          if (provider.icon.color !== undefined) {
            expect(provider.icon.color).toMatch(/^#[0-9a-fA-F]{6}$/);
          }
        }
      }
    });
  });

  /**
   * api.anthropic.com answers 429 with retry-after ~1495s, and Paseo's own quota
   * fetcher shares that budget, so no preset may quietly poll it faster again.
   */
  test("no verified preset polls api.anthropic.com faster than 30 minutes", () => {
    const anthropic = presetEntries.filter(([, provider]) => {
      const source = provider.source;
      if (provider.unverified || source?.kind !== "http") return false;
      return new URL(source.url).hostname === "api.anthropic.com";
    });
    expect(anthropic.length).toBeGreaterThan(0);
    for (const [id, provider] of anthropic) {
      expect([id, provider.refreshIntervalMs >= 1_800_000]).toEqual([id, true]);
    }
  });

  test("codex covers every bucket the endpoint exposes", () => {
    const readings = getUsagePreset("codex")?.readings ?? [];
    const quotaIds = readings.filter((reading) => reading.kind === "quota").map((r) => r.id);
    expect(quotaIds).toEqual(["session", "weekly", "code-review", "additional"]);
    expect(readings.filter((reading) => reading.kind === "balance").map((r) => r.id)).toEqual([
      "credits",
      "banked-resets",
    ]);
  });

  test("codex reads reset_at, never the misspelled resets_at", () => {
    const codex = getUsagePreset("codex");
    expect(codex).not.toBeNull();
    for (const reading of codex?.readings ?? []) {
      if (reading.kind !== "quota") continue;
      expect(reading.window?.resetsAtPath).not.toMatch(/resets_at/);
      expect(reading.window?.resetsAtPath ?? "reset_at").toMatch(/reset_at$/);
    }
  });

  test("getUsagePreset resolves known ids and rejects everything else", () => {
    for (const [id, provider] of presetEntries) {
      expect(getUsagePreset(id)).toBe(provider);
    }
    expect(getUsagePreset("no-such-provider")).toBeNull();
    expect(getUsagePreset("")).toBeNull();
    expect(getUsagePreset("toString")).toBeNull();
  });
});

/**
 * Where each credential file an agent CLI owns records its token's expiry.
 * Every jsonFile source in the catalogue must appear here, so a new preset
 * cannot quietly ship a credential the engine will spend a doomed request on:
 * Claude Code's token sat 34 hours past expiry while the card showed nothing
 * but a bare HTTP 401.
 *
 * A `null` records a file reviewed against the real thing and found to carry no
 * expiry at all. Keys are `file` then `path`, unique across the catalogue.
 */
const REVIEWED_EXPIRY_PATHS: Record<string, string | null> = {
  "${CLAUDE_CONFIG_DIR}/.credentials.json claudeAiOauth.accessToken": "claudeAiOauth.expiresAt",
  "~/.claude/.credentials.json claudeAiOauth.accessToken": "claudeAiOauth.expiresAt",
  "${CODEX_HOME}/auth.json tokens.access_token": null,
  "~/.codex/auth.json tokens.access_token": null,
  "~/.config/codex/auth.json tokens.access_token": null,
  "${KIMI_CODE_HOME}/credentials/kimi-code.json access_token": "expires_at",
  "~/.kimi-code/credentials/kimi-code.json access_token": "expires_at",
  "~/.kimi/credentials/kimi-code.json access_token": "expires_at",
  "~/.mmx/credentials.json access_token": "expires_at",
  "~/.mmx/config.json api_key": null,
  "~/.mmx/config.json oauth.access_token": "oauth.expires_at",
  "${CURSOR_HOME}/auth.json accessToken": null,
  "~/.config/cursor/auth.json accessToken": null,
  "~/.cursor/auth.json accessToken": null,
  "${GROK_HOME}/auth.json access_token": null,
  "~/.grok/auth.json access_token": null,
  "~/.config/grok/auth.json access_token": null,
};

type UsageJsonFileCredential = Extract<UsageCredentialSource, { kind: "jsonFile" }>;

interface PresetJsonFileCredential extends UsageJsonFileCredential {
  presetId: string;
  credentialName: string;
}

function jsonFileCredentialsOf(
  presetId: string,
  provider: UsageProvider,
): PresetJsonFileCredential[] {
  const found: PresetJsonFileCredential[] = [];
  for (const [credentialName, sources] of Object.entries(provider.credentials)) {
    for (const source of sources) {
      if (source.kind === "jsonFile") found.push({ ...source, presetId, credentialName });
    }
  }
  return found;
}

function credentialKey(credential: UsageJsonFileCredential): string {
  return `${credential.file} ${credential.path}`;
}

const jsonFileCredentials = presetEntries.flatMap(([id, provider]) =>
  jsonFileCredentialsOf(id, provider),
);

describe("credential files an agent CLI owns declare where they record expiry", () => {
  test("the catalogue's jsonFile sources are exactly the reviewed ones", () => {
    expect(jsonFileCredentials.map(credentialKey).sort()).toEqual(
      Object.keys(REVIEWED_EXPIRY_PATHS).sort(),
    );
  });

  test("each jsonFile source declares its reviewed expiry path", () => {
    for (const credential of jsonFileCredentials) {
      const key = credentialKey(credential);
      expect([key, credential.expiresAtPath ?? null]).toEqual([
        key,
        REVIEWED_EXPIRY_PATHS[key] ?? null,
      ]);
    }
  });

  /** The reported defect: a token 34 hours stale, spent on a request that can only 401. */
  test("every source in claude's chain can be checked for expiry first", () => {
    const sources = getUsagePreset("claude")?.credentials["token"] ?? [];
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const declared = source.kind === "jsonFile" ? source.expiresAtPath : null;
      expect([source.kind, declared]).toEqual(["jsonFile", "claudeAiOauth.expiresAt"]);
    }
  });

  test("an expiry path never points at the secret it guards", () => {
    for (const credential of jsonFileCredentials) {
      if (credential.expiresAtPath === undefined) continue;
      const key = credentialKey(credential);
      expect([key, credential.expiresAtPath === credential.path]).toEqual([key, false]);
    }
  });
});

/**
 * Recorded response shapes for every verified preset, taken from the live
 * endpoints. These exist so a preset's paths are exercised rather than merely
 * re-validated: `definePreset` already parses at import, so a schema assertion
 * here could never fail. Projecting a fixture does fail the moment a path
 * drifts from the shape we confirmed, which is the `resets_at`/`reset_at` bug
 * we shipped once already.
 */
const RESPONSE_FIXTURES: Record<string, unknown> = {
  // `limits` as the live endpoint returns it: the session and weekly windows
  // repeat there, unscoped, alongside the per-model entry. Their percentages
  // deliberately match the top-level ones, which is what made the duplicate
  // readings indistinguishable from the real two.
  claude: {
    five_hour: { utilization: 64, resets_at: "2026-08-28T21:00:00Z" },
    seven_day: { utilization: 10, resets_at: "2026-09-04T16:00:00Z" },
    limits: [
      { kind: "session", percent: 64, resets_at: "2026-08-28T21:00:00Z" },
      { kind: "weekly_all", percent: 10, resets_at: "2026-09-04T16:00:00Z" },
      {
        kind: "weekly_scoped",
        percent: 12,
        resets_at: "2026-09-04T16:00:00Z",
        scope: { model: { display_name: "Opus" } },
      },
    ],
  },
  // What Claude Code hands a statusline command: the same two windows and the
  // same field names as the endpoint above, and nothing else. Its own
  // statusline schema documents `utilization` as "Percentage of the window
  // used, 0-100" and `resets_at` as an ISO 8601 timestamp, and it sends no
  // per-model limits here, which is why this preset reports two readings.
  "claude-statusline": {
    five_hour: { utilization: 64, resets_at: "2026-08-28T21:00:00Z" },
    seven_day: { utilization: 10, resets_at: "2026-09-04T16:00:00Z" },
  },
  codex: {
    rate_limit: {
      primary_window: { used_percent: 42.5, reset_at: 1787953401 },
      secondary_window: { used_percent: 7.5, reset_at: 1788540201 },
    },
    code_review_rate_limit: null,
    additional_rate_limits: [
      {
        limit_name: "gpt-reserve",
        metered_feature: "base_model_inference",
        rate_limit: {
          primary_window: { used_percent: 3, reset_at: 1788540230 },
          secondary_window: null,
        },
      },
    ],
    credits: { has_credits: false, unlimited: false, balance: "0" },
    rate_limit_reset_credits: { available_count: 2 },
  },
  cursor: {
    planUsage: {
      totalSpend: 1500,
      limit: 2000,
      remaining: 500,
    },
    billingCycleEnd: "2026-09-20T00:00:00Z",
  },
  grok: {
    config: {
      monthlyLimit: { val: 500 },
      used: { val: 120 },
    },
  },
  deepseek: {
    is_available: true,
    balance_infos: [
      {
        currency: "USD",
        total_balance: "110.00",
        granted_balance: "10.00",
        topped_up_balance: "100.00",
      },
    ],
  },
  openrouter: { data: { limit: 200, limit_remaining: 50, usage: 150 } },
  kimi: {
    usage: { used: 120, limit: 500, remaining: 380, resetTime: "2026-08-29T00:00:00Z" },
  },
  minimax: {
    model_remains: [
      {
        model_name: "MiniMax-M2",
        current_interval_usage_count: 30,
        current_interval_total_count: 100,
        current_interval_remaining_percent: 70,
        end_time: "2026-08-28T22:00:00Z",
        current_weekly_usage_count: 300,
        current_weekly_total_count: 1000,
        current_weekly_remaining_percent: 70,
        weekly_end_time: "2026-09-04T00:00:00Z",
      },
    ],
  },
  // Schedule-only: it resolves from the clock, so its document is never read.
  "deepseek-rate": null,
  "openrouter-credits": { data: { total_credits: 100, total_usage: 42.5 } },
  novita: {
    availableBalance: "1000000",
    cashBalance: "800000",
    creditLimit: "200000",
    pendingCharges: "0",
    outstandingInvoices: "0",
  },
  deepinfra: { stripe_balance: -42.5, recent: [], limit: 100, suspended: false },
  siliconflow: {
    code: 20000,
    data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88" },
  },
  "siliconflow-cn": {
    code: 20000,
    data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88" },
  },
  // The vendor's own reference example on both hosts.
  "stepfun-ai": {
    object: "account",
    type: "prepaid",
    balance: 12.5,
    total_cash_balance: 0.0,
    total_voucher_balance: 26.0,
  },
  stepfun: {
    object: "account",
    type: "prepaid",
    balance: 12.5,
    total_cash_balance: 0.0,
    total_voucher_balance: 26.0,
  },
  moonshot: {
    code: 0,
    data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
    status: true,
  },
  "moonshot-cn": {
    code: 0,
    data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
    status: true,
  },
  venice: {
    canConsume: true,
    consumptionCurrency: "DIEM",
    balances: { diem: 90.5, usd: 25 },
    diemEpochAllocation: 100,
  },
  // The Management API reference's own example: cents, as strings, negative
  // after a purchase because the team is owed the money.
  xai: {
    changes: [
      {
        teamId: "65c1e471-205f-4566-9c5a-07198bcdf4ce",
        changeOrigin: "PURCHASE",
        topupStatus: "SUCCEEDED",
        amount: { val: "-1000" },
        createTime: "2025-02-24T15:28:02.308840Z",
        paymentProcessor: { kind: "STRIPE" },
      },
    ],
    total: { val: "-2500" },
  },
  vercel: { balance: "95.50", total_used: "4.50" },
  "nano-gpt": {
    usd_balance: "129.46956147",
    nano_balance: "26.71801147",
    nanoDepositAddress: "nano_1gx385nnj7rw67hsksa3pyxwnfr48zu13t35ncjmtnqb9zdebtjhh7ahks34",
  },
  poe: { current_point_balance: 1500 },
  synthetic: { subscription: { limit: 135, requests: 27, renewsAt: "2026-09-21T14:36:14.288Z" } },
  // CodexBar's public-API test fixture uses these names for the response from
  // `/zen/go/v1/usage`; its browser-session fixture is the separate
  // `rollingUsage.usagePercent/resetInSec` shape.
  "opencode-go": {
    usage: {
      rolling: { percent: 17, resetsAt: "2026-08-28T21:00:00.000Z" },
      weekly: { percent: 75, resetsAt: "2026-09-04T16:00:00.000Z" },
      monthly: { percent: 91, resetsAt: "2026-09-28T16:00:00.000Z" },
    },
  },
  // CodexBar's subscription fixture records the two differently metered
  // windows this one self-scoped response can carry.
  chutes: {
    subscription: {
      active: true,
      plan_name: "Pro",
      current_period_end: "2026-07-01T00:00:00Z",
    },
    monthly: { used: 250, limit: 1000, resets_at: "2026-07-01T00:00:00Z", unit: "credits" },
    rolling_window: {
      requests: 40,
      limit: 100,
      window_minutes: 240,
      reset_at: "2026-06-13T18:00:00Z",
      unit: "requests",
    },
  },
  // ZenMux's own Management API example, also recorded in CodexBar's fixture.
  zenmux: {
    success: true,
    data: {
      plan: { tier: "ultra", amount_usd: 200, interval: "month" },
      account_status: "healthy",
      quota_5_hour: {
        usage_percentage: 0.0715,
        resets_at: "2026-08-28T17:00:00.000Z",
        max_flows: 800,
        used_flows: 57.2,
        remaining_flows: 742.8,
      },
      quota_7_day: {
        usage_percentage: 0.0673,
        resets_at: "2026-09-04T16:00:00.000Z",
        max_flows: 6182,
        used_flows: 416.11,
        remaining_flows: 5765.89,
      },
    },
  },
  "minimax-cn": {
    model_remains: [
      {
        model_name: "MiniMax-M2",
        current_interval_usage_count: 30,
        current_interval_total_count: 100,
        current_interval_remaining_percent: 70,
        end_time: "2026-08-28T22:00:00Z",
        current_weekly_usage_count: 300,
        current_weekly_total_count: 1000,
        current_weekly_remaining_percent: 70,
        weekly_end_time: "2026-09-04T00:00:00Z",
      },
    ],
  },
  // CodexBar's recorded Pro-tier document: the two token windows carry only a
  // percentage, the MCP allowance carries counts and no reset time.
  "zai-coding-plan": {
    code: 200,
    msg: "success",
    success: true,
    data: {
      planName: "Pro",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25, nextResetTime: 1785816000000 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 9, nextResetTime: 1786291200000 },
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 224,
          remaining: 776,
          percentage: 22,
          usageDetails: [
            { modelCode: "search-prime", usage: 210 },
            { modelCode: "web-reader", usage: 14 },
          ],
        },
      ],
    },
  },
  zai: {
    code: 200,
    msg: "success",
    success: true,
    data: {
      planName: "Pro",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25, nextResetTime: 1785816000000 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 9, nextResetTime: 1786291200000 },
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 224,
          remaining: 776,
          percentage: 22,
          usageDetails: [
            { modelCode: "search-prime", usage: 210 },
            { modelCode: "web-reader", usage: 14 },
          ],
        },
      ],
    },
  },
  // The Lite tier on the mainland host reports credit counts as well.
  "zhipuai-coding-plan": {
    code: 200,
    msg: "success",
    success: true,
    data: {
      level: "lite",
      limits: [
        {
          type: "CREDIT_LIMIT",
          unit: 3,
          number: 5,
          usage: 2000,
          currentValue: 100,
          remaining: 1900,
          percentage: 5,
          nextResetTime: 1786073946574,
        },
        {
          type: "CREDIT_LIMIT",
          unit: 6,
          number: 1,
          usage: 10000,
          currentValue: 1000,
          remaining: 9000,
          percentage: 10,
          nextResetTime: 1786660486998,
        },
      ],
    },
  },
};

const NOW = new Date("2026-08-28T16:00:00Z");

/** An unlimited OpenRouter key reports null for every credit field. */
const OPENROUTER_UNLIMITED = { data: { limit: null, limit_remaining: null, usage: 1.5 } };

function project(presetId: string, document: unknown = RESPONSE_FIXTURES[presetId]) {
  const provider = getUsagePreset(presetId);
  if (!provider) throw new Error(`No preset "${presetId}"`);
  return projectReadings({ readings: provider.readings, document, now: NOW });
}

function readingById(presetId: string, readingId: string) {
  const found = project(presetId).find((reading) => reading.id === readingId);
  if (!found) throw new Error(`No reading "${readingId}" from preset "${presetId}"`);
  return found;
}

describe("verified presets resolve their recorded responses", () => {
  test("every verified preset has a fixture and every unverified one has none", () => {
    for (const [id, provider] of presetEntries) {
      expect([id, Object.hasOwn(RESPONSE_FIXTURES, id)]).toEqual([id, !provider.unverified]);
    }
  });

  test.each(Object.keys(RESPONSE_FIXTURES))(
    "%s resolves something real from its fixture",
    (presetId) => {
      const readings = project(presetId);
      expect(readings.length).toBeGreaterThan(0);
      const resolved = readings.filter((reading) => {
        if (reading.kind === "quota") return reading.percent !== null || reading.used !== null;
        if (reading.kind === "balance") return reading.remaining !== null;
        return reading.state !== "";
      });
      expect(resolved.length).toBeGreaterThan(0);
    },
  );

  test("claude reports both windows and a scoped per-model bucket", () => {
    const readings = project("claude");
    expect(readings.map((reading) => reading.id)).toEqual([
      "session",
      "weekly",
      "scoped-weekly-scoped",
    ]);
    expect(readingById("claude", "session")).toMatchObject({
      kind: "quota",
      percent: 64,
      window: { label: "Session", resetsAt: "2026-08-28T21:00:00Z", durationMs: 18_000_000 },
    });
    expect(readingById("claude", "weekly")).toMatchObject({
      percent: 10,
      window: { label: "Weekly", resetsAt: "2026-09-04T16:00:00Z", durationMs: 604_800_000 },
    });
    expect(readingById("claude", "scoped-weekly-scoped")).toMatchObject({
      kind: "quota",
      label: "Weekly · Opus",
      group: "Opus",
      percent: 12,
    });
  });

  // The unscoped `limits` entries repeat the session and weekly percentages, so
  // a second bar carrying either number means the scoped projection swallowed
  // them again.
  test("claude never repeats the session or weekly percentage as a scoped bucket", () => {
    const scoped = project("claude").filter((reading) => reading.id.startsWith("scoped-"));
    expect(scoped.map((reading) => reading.kind === "quota" && reading.percent)).toEqual([12]);
  });

  test("codex turns epoch-second reset_at into ISO and reads a string balance", () => {
    expect(readingById("codex", "session")).toMatchObject({
      percent: 42.5,
      window: { label: "Session", resetsAt: "2026-08-28T21:43:21.000Z" },
    });
    expect(readingById("codex", "weekly")).toMatchObject({
      percent: 7.5,
      window: { label: "Weekly", resetsAt: "2026-09-04T16:43:21.000Z" },
    });
    expect(readingById("codex", "additional-gpt-reserve")).toMatchObject({
      label: "Limit · gpt-reserve",
      group: "gpt-reserve",
      percent: 3,
      window: { label: "Window", resetsAt: "2026-09-04T16:43:50.000Z", durationMs: null },
    });
    expect(readingById("codex", "credits")).toMatchObject({ kind: "balance", remaining: 0 });
    expect(readingById("codex", "banked-resets")).toMatchObject({
      kind: "balance",
      remaining: 2,
      unit: "credits",
    });
  });

  test("codex renders an unused code-review bucket as empty, not as zero", () => {
    expect(readingById("codex", "code-review")).toMatchObject({
      percent: null,
      used: null,
      limit: null,
      window: { label: "Session", resetsAt: null },
    });
  });
  test("cursor scales spend from cents to dollars and captures billing cycle", () => {
    expect(readingById("cursor", "plan-usage")).toMatchObject({
      kind: "quota",
      used: 15,
      limit: 20,
      remaining: 5,
      unit: "usd",
      window: { label: "Billing cycle", resetsAt: "2026-09-20T00:00:00Z" },
    });
  });

  test("grok projects monthly credits used against limit", () => {
    expect(readingById("grok", "monthly-credits")).toMatchObject({
      kind: "quota",
      used: 120,
      limit: 500,
      unit: "credits",
    });
  });

  test("deepseek coerces its string amounts and picks up the currency", () => {
    expect(readingById("deepseek", "balance")).toMatchObject({
      kind: "balance",
      remaining: 110,
      currency: "USD",
    });
    expect(readingById("deepseek", "granted")).toMatchObject({ remaining: 10, currency: "USD" });
  });

  test("openrouter derives percent remaining for a key with a credit limit", () => {
    expect(readingById("openrouter", "credits")).toMatchObject({
      kind: "balance",
      unit: "credits",
      remaining: 50,
      total: 200,
      percentRemaining: 25,
    });
  });

  test("openrouter yields no bar at all for an unlimited key", () => {
    const [credits] = project("openrouter", OPENROUTER_UNLIMITED);
    expect(credits).toMatchObject({
      kind: "balance",
      remaining: null,
      total: null,
      percentRemaining: null,
    });
  });

  test("kimi derives a percentage from its request counts", () => {
    expect(readingById("kimi", "usage")).toMatchObject({
      unit: "requests",
      used: 120,
      limit: 500,
      remaining: 380,
      percent: 24,
      window: { label: "Window", resetsAt: "2026-08-29T00:00:00Z", durationMs: null },
    });
  });

  test("minimax inverts remaining-percent and projects one reading per model", () => {
    expect(readingById("minimax", "interval-minimax-m2")).toMatchObject({
      label: "Interval · MiniMax-M2",
      group: "MiniMax-M2",
      used: 30,
      limit: 100,
      percent: 30,
      window: { label: "Interval", resetsAt: "2026-08-28T22:00:00Z" },
    });
    expect(readingById("minimax", "weekly-minimax-m2")).toMatchObject({
      used: 300,
      limit: 1000,
      percent: 30,
      window: { label: "Weekly", resetsAt: "2026-09-04T00:00:00Z", durationMs: 604_800_000 },
    });
  });

  test("openrouter-credits derives remaining and percent from the account pair", () => {
    expect(readingById("openrouter-credits", "credits")).toMatchObject({
      kind: "quota",
      unit: "credits",
      used: 42.5,
      limit: 100,
      remaining: 57.5,
      percent: 42.5,
    });
  });

  test("novita scales ten-thousandths of a dollar into dollars", () => {
    expect(readingById("novita", "balance")).toMatchObject({
      kind: "balance",
      unit: "usd",
      remaining: 100,
      total: 20,
      // The vendor's own sample has available credit above the credit limit, so
      // the percentage legitimately exceeds 100 and must not be clamped here.
      percentRemaining: 500,
    });
  });

  test("deepinfra inverts the vendor's money-owed sign into a spendable balance", () => {
    expect(readingById("deepinfra", "balance")).toMatchObject({
      kind: "balance",
      unit: "usd",
      remaining: 42.5,
      total: null,
      percentRemaining: null,
    });
  });

  test("siliconflow coerces its string total balance", () => {
    expect(readingById("siliconflow", "balance")).toMatchObject({
      kind: "balance",
      unit: "usd",
      remaining: 88.88,
    });
  });

  test("both stepfun hosts read the spendable balance, differing only in unit", () => {
    expect(readingById("stepfun-ai", "balance")).toMatchObject({
      kind: "balance",
      unit: "usd",
      remaining: 12.5,
      total: null,
    });
    expect(readingById("stepfun", "balance")).toMatchObject({
      kind: "balance",
      unit: "credits",
      remaining: 12.5,
      total: null,
    });
    const [international] = getUsagePreset("stepfun-ai")?.readings ?? [];
    const [domestic] = getUsagePreset("stepfun")?.readings ?? [];
    expect(international?.kind === "balance" ? international.remainingPath : "").toBe("balance");
    expect(domestic?.kind === "balance" ? domestic.remainingPath : "").toBe("balance");
  });

  test("both siliconflow hosts read the same field, differing only in unit", () => {
    const cn = getUsagePreset("siliconflow-cn");
    expect(cn?.source?.kind === "http" ? new URL(cn.source.url).hostname : "").toBe(
      "api.siliconflow.cn",
    );
    expect(readingById("siliconflow-cn", "balance")).toMatchObject({
      kind: "balance",
      unit: "credits",
      remaining: 88.88,
    });
  });

  test("both moonshot hosts read the same field, differing only in unit", () => {
    expect(readingById("moonshot", "balance")).toMatchObject({
      kind: "balance",
      unit: "usd",
      remaining: 49.58894,
    });
    expect(readingById("moonshot-cn", "balance")).toMatchObject({
      kind: "balance",
      unit: "credits",
      remaining: 49.58894,
    });
  });

  test("venice reports the DIEM epoch as a quota and USD as a balance", () => {
    expect(readingById("venice", "diem")).toMatchObject({
      kind: "quota",
      unit: "credits",
      remaining: 90.5,
      limit: 100,
      used: 9.5,
      percent: 9.5,
    });
    expect(readingById("venice", "usd")).toMatchObject({
      kind: "balance",
      unit: "usd",
      remaining: 25,
    });
  });

  test("xai turns a cents liability string into dollars of credit", () => {
    expect(readingById("xai", "prepaid")).toMatchObject({
      kind: "balance",
      unit: "usd",
      remaining: 25,
      total: null,
    });
  });

  test("xai interpolates the team id into the route, not only the key", () => {
    const xai = getUsagePreset("xai");
    expect(Object.keys(xai?.credentials ?? {}).sort()).toEqual(["apiKey", "teamId"]);
    expect(xai?.source?.kind === "http" ? xai.source.url : "").toContain("${teamId}");
  });

  test("vercel coerces its string credit balance", () => {
    expect(readingById("vercel", "credits")).toMatchObject({
      kind: "balance",
      unit: "usd",
      remaining: 95.5,
      total: null,
    });
  });

  test("nano-gpt reads both balances from one POST", () => {
    const nano = getUsagePreset("nano-gpt");
    expect(nano?.source?.kind === "http" ? nano.source.method : "").toBe("POST");
    expect(readingById("nano-gpt", "usd")).toMatchObject({ unit: "usd", remaining: 129.46956147 });
    expect(readingById("nano-gpt", "nano")).toMatchObject({
      unit: "credits",
      remaining: 26.71801147,
    });
  });

  test("poe reports points as credits with no ceiling", () => {
    expect(readingById("poe", "points")).toMatchObject({
      kind: "balance",
      unit: "credits",
      remaining: 1500,
      total: null,
      percentRemaining: null,
    });
  });

  test("synthetic derives remaining and percent from requests against the limit", () => {
    expect(readingById("synthetic", "subscription")).toMatchObject({
      kind: "quota",
      unit: "requests",
      used: 27,
      limit: 135,
      remaining: 108,
      percent: 20,
      window: { label: "Subscription", resetsAt: "2026-09-21T14:36:14.288Z", durationMs: null },
    });
  });

  test("opencode-go projects the public API's three percentage windows", () => {
    expect(readingById("opencode-go", "rolling")).toMatchObject({
      kind: "quota",
      unit: "percent",
      percent: 17,
      window: { label: "5 hours", resetsAt: "2026-08-28T21:00:00.000Z", durationMs: 18_000_000 },
    });
    expect(readingById("opencode-go", "weekly")).toMatchObject({
      percent: 75,
      window: { label: "Weekly", resetsAt: "2026-09-04T16:00:00.000Z", durationMs: 604_800_000 },
    });
    expect(readingById("opencode-go", "monthly")).toMatchObject({
      percent: 91,
      window: { label: "Monthly", resetsAt: "2026-09-28T16:00:00.000Z", durationMs: null },
    });
  });

  test("chutes projects request and credit windows from subscription usage", () => {
    expect(readingById("chutes", "rolling")).toMatchObject({
      kind: "quota",
      unit: "requests",
      used: 40,
      limit: 100,
      remaining: 60,
      percent: 40,
      window: { label: "Rolling", resetsAt: "2026-06-13T18:00:00Z", durationMs: null },
    });
    expect(readingById("chutes", "monthly")).toMatchObject({
      unit: "credits",
      used: 250,
      limit: 1000,
      remaining: 750,
      percent: 25,
      window: { label: "Monthly", resetsAt: "2026-07-01T00:00:00Z", durationMs: null },
    });
  });

  test("zenmux derives exact percentages from the recorded flow counts", () => {
    expect(readingById("zenmux", "five-hour")).toMatchObject({
      kind: "quota",
      unit: "flows",
      used: 57.2,
      limit: 800,
      remaining: 742.8,
      percent: 7.2,
      window: { label: "5 hours", resetsAt: "2026-08-28T17:00:00.000Z", durationMs: 18_000_000 },
    });
    expect(readingById("zenmux", "weekly")).toMatchObject({
      unit: "flows",
      used: 416.11,
      limit: 6182,
      remaining: 5765.89,
      percent: 6.7,
      window: { label: "Weekly", resetsAt: "2026-09-04T16:00:00.000Z", durationMs: 604_800_000 },
    });
  });

  // Observed live: a keyless request answers in this envelope rather than by
  // status alone, and a `data: null` body projects to nothing, so the refusal
  // has to be declared or the card renders empty.
  test("zenmux declares where its envelope reports a refusal", () => {
    const source = getUsagePreset("zenmux")?.source;
    expect(source?.kind === "http" ? source.failure : null).toMatchObject({
      path: "success",
      equals: false,
      messagePath: "message",
    });
  });

  test("minimax-cn reads the same document as minimax on the mainland host", () => {
    const cn = getUsagePreset("minimax-cn");
    expect(cn?.source?.kind === "http" ? new URL(cn.source.url).hostname : "").toBe(
      "api.minimaxi.com",
    );
    expect(cn?.readings).toEqual(getUsagePreset("minimax")?.readings);
    expect(readingById("minimax-cn", "interval-minimax-m2")).toMatchObject({
      used: 30,
      limit: 100,
      percent: 30,
    });
  });

  test("zai-coding-plan picks each window out of the limits array by unit", () => {
    const readings = project("zai-coding-plan");
    expect(readings.map((reading) => reading.id)).toEqual(["session", "weekly", "mcp"]);
    expect(readingById("zai-coding-plan", "session")).toMatchObject({
      kind: "quota",
      label: "Session",
      unit: "percent",
      percent: 25,
      used: null,
      limit: null,
      window: { label: "Session", resetsAt: "2026-08-04T04:00:00.000Z", durationMs: 18_000_000 },
    });
    expect(readingById("zai-coding-plan", "weekly")).toMatchObject({
      label: "Weekly",
      percent: 9,
      window: { label: "Weekly", resetsAt: "2026-08-09T16:00:00.000Z", durationMs: 604_800_000 },
    });
    expect(readingById("zai-coding-plan", "mcp")).toMatchObject({
      label: "MCP calls",
      unit: "requests",
      used: 224,
      limit: 1000,
      remaining: 776,
      percent: 22,
      window: { label: "Monthly", resetsAt: null, durationMs: null },
    });
  });

  test("zhipuai-coding-plan reads credit counts alongside the percentage", () => {
    const readings = project("zhipuai-coding-plan");
    expect(readings.map((reading) => reading.id)).toEqual(["session", "weekly"]);
    expect(readingById("zhipuai-coding-plan", "session")).toMatchObject({
      percent: 5,
      used: 100,
      limit: 2000,
      remaining: 1900,
    });
    expect(readingById("zhipuai-coding-plan", "weekly")).toMatchObject({
      percent: 10,
      used: 1000,
      limit: 10000,
      remaining: 9000,
    });
  });

  test("both GLM Coding Plan hosts share one reading set", () => {
    expect(getUsagePreset("zhipuai-coding-plan")?.readings).toEqual(
      getUsagePreset("zai-coding-plan")?.readings,
    );
  });

  test("zai alias matches zai-coding-plan", () => {
    const zai = getUsagePreset("zai");
    const zaiCodingPlan = getUsagePreset("zai-coding-plan");
    expect(zai?.label).toBe("Z.ai");
    expect(zai?.readings).toEqual(zaiCodingPlan?.readings);
    expect(zai?.source).toEqual(zaiCodingPlan?.source);
    expect(zai?.credentials).toEqual(zaiCodingPlan?.credentials);
    expect(zai?.credentials.apiKey).toContainEqual({ kind: "env", variable: "GLM_API_KEY" });
  });
});

function projectRateAt(instant: string) {
  const provider = getUsagePreset("deepseek-rate");
  if (!provider) throw new Error("No deepseek-rate preset");
  const [reading] = projectReadings({
    readings: provider.readings,
    document: null,
    now: new Date(instant),
  });
  if (!reading || reading.kind !== "rate") throw new Error("Expected a rate reading");
  return reading;
}

describe("deepseek-rate resolves the published pricing schedule", () => {
  test("needs no source and no credential", () => {
    const provider = getUsagePreset("deepseek-rate");
    expect(provider?.source).toBeUndefined();
    expect(provider?.credentials).toEqual({});
    expect(requiresSourceDocument(provider?.readings ?? [])).toBe(false);
  });

  test("bills peak on a weekday inside a peak band", () => {
    expect(projectRateAt("2026-09-02T02:00:00Z")).toMatchObject({
      state: "Peak",
      multiplier: 2,
    });
    expect(projectRateAt("2026-09-02T07:00:00Z")).toMatchObject({
      state: "Peak",
      multiplier: 2,
    });
  });

  test("bills off-peak on a weekday outside every peak band", () => {
    expect(projectRateAt("2026-09-02T12:00:00Z")).toMatchObject({
      state: "Off-peak",
      multiplier: 1,
    });
  });

  test("bills off-peak all weekend, even inside peak hours", () => {
    expect(projectRateAt("2026-08-29T02:00:00Z")).toMatchObject({
      state: "Off-peak",
      multiplier: 1,
    });
    expect(projectRateAt("2026-08-30T07:00:00Z")).toMatchObject({
      state: "Off-peak",
      multiplier: 1,
    });
  });
});

/**
 * Recorded output of `probeAntigravityQuota()` from a live run. The probe
 * returns both window lengths in one `buckets` array, keyed by model family,
 * which is what the preset's `each` projection is shaped for.
 */
const ANTIGRAVITY_PROBE = {
  source: "antigravity",
  fetchedAt: "2026-08-28T17:25:40.000Z",
  buckets: [
    {
      id: "gemini-5h",
      label: "Session",
      group: "Gemini Models",
      usedPercent: 9.23,
      resetsAt: "2026-08-28T22:11:13Z",
    },
    {
      id: "gemini-weekly",
      label: "Weekly",
      group: "Gemini Models",
      usedPercent: 25.05733,
      resetsAt: "2026-09-01T20:00:00Z",
    },
    {
      id: "3p-5h",
      label: "Session",
      group: "Claude and GPT models",
      usedPercent: 0,
      resetsAt: "2026-08-28T22:11:13Z",
    },
    {
      id: "3p-weekly",
      label: "Weekly",
      group: "Claude and GPT models",
      usedPercent: 0,
      resetsAt: "2026-09-01T20:00:00Z",
    },
  ],
};

describe("antigravity reads its quota through a probe", () => {
  test("names a probe source and carries no credentials or url", () => {
    const antigravity = getUsagePreset("antigravity");
    expect(antigravity?.source).toEqual({ kind: "probe", probe: "antigravity" });
    expect(antigravity?.credentials).toEqual({});
    expect(antigravity?.refreshIntervalMs).toBeGreaterThanOrEqual(300_000);
  });

  test("stays unverified because the endpoint is undocumented", () => {
    const antigravity = getUsagePreset("antigravity");
    expect(antigravity?.unverified).toBe(true);
    expect(antigravity?.description).toMatch(/without notice/i);
  });

  test("projects the recorded probe output into one reading per bucket", () => {
    const readings = project("antigravity", ANTIGRAVITY_PROBE);
    expect(readings.map((reading) => reading.id)).toEqual([
      "bucket-gemini-5h",
      "bucket-gemini-weekly",
      "bucket-3p-5h",
      "bucket-3p-weekly",
    ]);
    expect(readings[0]).toMatchObject({
      kind: "quota",
      label: "Plan pool · Session",
      group: "Gemini Models",
      unit: "percent",
      percent: 9.2,
      window: { label: "Window", resetsAt: "2026-08-28T22:11:13Z", durationMs: null },
    });
    expect(readings[1]).toMatchObject({
      label: "Plan pool · Weekly",
      group: "Gemini Models",
      percent: 25.1,
      window: { label: "Window", resetsAt: "2026-09-01T20:00:00Z" },
    });
    expect(readings[2]).toMatchObject({
      label: "Plan pool · Session",
      group: "Claude and GPT models",
      percent: 0,
    });
    expect(readings[3]).toMatchObject({
      label: "Plan pool · Weekly",
      group: "Claude and GPT models",
      percent: 0,
    });
  });

  test("an empty probe result yields no readings rather than an empty bar", () => {
    expect(project("antigravity", { source: "antigravity", buckets: [] })).toEqual([]);
  });

  test("projects each client's local usage under its own group", () => {
    // The probe's own buckets answer for the consumer plan only, so a client's
    // token and request counts arrive alongside them, per client.
    const readings = project("antigravity", {
      ...ANTIGRAVITY_PROBE,
      usage: {
        requests: [
          { id: "paseo-requests-day", label: "Today", group: "Paseo (omp)", amount: 600 },
        ],
        tokens: [
          { id: "cli-tokens-day", label: "Today", group: "Antigravity CLI", amount: 32_652_978 },
        ],
        spend: [
          { id: "paseo-spend-week", label: "Last 7 days", group: "Paseo (omp)", amount: 1.489 },
        ],
      },
    });

    // Local accounting leads the card; the vendor's pool bars follow it.
    expect(readings.slice(0, 3)).toMatchObject([
      {
        id: "requests-paseo-requests-day",
        label: "Requests · Today",
        group: "Paseo (omp)",
        unit: "requests",
        used: 600,
        limit: null,
        percent: null,
      },
      {
        id: "tokens-cli-tokens-day",
        label: "Tokens · Today",
        group: "Antigravity CLI",
        unit: "tokens",
        used: 32_652_978,
      },
      {
        id: "spend-paseo-spend-week",
        label: "Spend · Last 7 days",
        group: "Paseo (omp)",
        unit: "usd",
        used: 1.489,
      },
    ]);
  });

  test("adds no local rows when no client on this machine has any", () => {
    expect(project("antigravity", ANTIGRAVITY_PROBE)).toHaveLength(4);
  });

  test("a declared ceiling reaches the requests rows and nothing else", () => {
    const [entry] = buildProviderRegistry({
      antigravity: { preset: "antigravity", limits: { requests: 20 } },
    });
    const limits: Record<string, number | undefined> = {};
    for (const reading of entry?.provider?.readings ?? []) {
      if (reading.kind === "quota") limits[reading.id] = reading.limit;
    }
    expect(limits.requests).toBe(20);
    expect(limits.tokens).toBeUndefined();
    expect(limits.bucket).toBeUndefined();
  });
});

/**
 * Recorded output of `probeGithubCopilotQuota()` for an individual plan: the
 * premium bucket is counted, the chat and completion buckets are unlimited
 * and report a zero entitlement, and the reset is a calendar day.
 */
const GITHUB_COPILOT_PROBE = {
  source: "file /home/tester/.config/github-copilot/hosts.json",
  fetchedAt: "2026-09-02T10:00:00.000Z",
  plan: "individual",
  resetsAt: "2026-10-01",
  buckets: [
    {
      id: "premium",
      label: "Premium requests",
      entitlement: 300,
      remaining: 285,
      percentRemaining: 95,
      metered: true,
      unlimited: false,
      resetsAt: "2026-10-01",
    },
    {
      id: "chat",
      label: "Chat",
      entitlement: 0,
      remaining: 0,
      percentRemaining: 0,
      metered: false,
      unlimited: true,
      resetsAt: "2026-10-01",
    },
    {
      id: "completions",
      label: "Completions",
      entitlement: 0,
      remaining: 0,
      percentRemaining: 0,
      metered: false,
      unlimited: true,
      resetsAt: "2026-10-01",
    },
  ],
};

describe("github-copilot reads its quota through a probe", () => {
  test("names a probe source and carries no credentials or url", () => {
    const copilot = getUsagePreset("github-copilot");
    expect(copilot?.source).toEqual({ kind: "probe", probe: "github-copilot" });
    expect(copilot?.credentials).toEqual({});
  });

  test("stays unverified because the route is undocumented", () => {
    const copilot = getUsagePreset("github-copilot");
    expect(copilot?.unverified).toBe(true);
    expect(copilot?.description).toMatch(/without notice/i);
  });

  // The unlimited buckets report a zero entitlement, so projecting them would
  // draw two bars reading as exhausted on a plan that never counts them.
  test("projects only the metered bucket, deriving used from the entitlement", () => {
    const readings = project("github-copilot", GITHUB_COPILOT_PROBE);
    expect(readings.map((reading) => reading.id)).toEqual(["bucket-premium"]);
    expect(readings[0]).toMatchObject({
      kind: "quota",
      label: "Copilot · Premium requests",
      unit: "requests",
      used: 15,
      limit: 300,
      remaining: 285,
      percent: 5,
      window: { label: "Monthly", resetsAt: "2026-10-01", durationMs: null },
    });
  });

  test("shows every bucket a plan meters, in the probe's order", () => {
    const business = {
      ...GITHUB_COPILOT_PROBE,
      buckets: GITHUB_COPILOT_PROBE.buckets.map((bucket) =>
        bucket.id === "chat"
          ? { ...bucket, entitlement: 50, remaining: 10, metered: true, unlimited: false }
          : bucket,
      ),
    };
    expect(project("github-copilot", business).map((reading) => reading.id)).toEqual([
      "bucket-premium",
      "bucket-chat",
    ]);
  });

  test("an empty probe result yields no readings rather than an empty bar", () => {
    expect(project("github-copilot", { ...GITHUB_COPILOT_PROBE, buckets: [] })).toEqual([]);
  });
});
