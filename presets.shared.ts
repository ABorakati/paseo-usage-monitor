import { USAGE_LOGOS } from "./logos.shared";
import { z } from "zod";
import { type UsageProvider, UsageProviderSchema } from "./limits.shared";

/**
 * Built-in provider definitions. A preset is a pre-filled `UsageProvider`; a
 * user enables one by naming it in `usage-limits.json` and overriding only the
 * fields they care about.
 *
 * Presets split in two. A verified preset points at an endpoint, header set and
 * response shape that have been observed to work. An unverified preset is a
 * template for a vendor that publishes no quota endpoint: it carries an
 * `example.invalid` host so it can never silently hit a guessed URL, and its
 * description says what the user has to supply.
 */

function definePreset(definition: z.input<typeof UsageProviderSchema>): UsageProvider {
  return UsageProviderSchema.parse(definition);
}

const FIVE_HOURS_MS = 18_000_000;
const SEVEN_DAYS_MS = 604_800_000;

/**
 * Shared by the two GLM Coding Plan hosts, which answer the same document.
 * The array carries no label field, so each window is picked out by the
 * `unit` it is expressed in and named here; a window is one element, so the
 * projection keeps the bare label rather than numbering it.
 */
const ZAI_CODING_PLAN_READINGS: z.input<typeof UsageProviderSchema>["readings"] = [
  {
    kind: "quota",
    id: "session",
    label: "Session",
    unit: "percent",
    each: { path: "data.limits", where: { path: "unit", equals: 3 } },
    percentPath: "percentage",
    usedPath: "currentValue",
    limitPath: "usage",
    remainingPath: "remaining",
    // The plan's short window is five hours on every published tier, and the
    // element says so itself as `number: 5` with `unit: 3`.
    window: { label: "Session", resetsAtPath: "nextResetTime", durationMs: FIVE_HOURS_MS },
  },
  {
    kind: "quota",
    id: "weekly",
    label: "Weekly",
    unit: "percent",
    each: { path: "data.limits", where: { path: "unit", equals: 6 } },
    percentPath: "percentage",
    usedPath: "currentValue",
    limitPath: "usage",
    remainingPath: "remaining",
    window: { label: "Weekly", resetsAtPath: "nextResetTime", durationMs: SEVEN_DAYS_MS },
  },
  {
    kind: "quota",
    id: "mcp",
    label: "MCP calls",
    unit: "requests",
    each: { path: "data.limits", where: { path: "type", equals: "TIME_LIMIT" } },
    percentPath: "percentage",
    usedPath: "currentValue",
    limitPath: "usage",
    remainingPath: "remaining",
    // A calendar month, so no fixed durationMs; the vendor's fixture carries
    // no reset time for it either, and the bar then shows counts alone.
    window: { label: "Monthly", resetsAtPath: "nextResetTime" },
  },
];

/**
 * A preset keeps its monogram in the literal below so it still identifies
 * itself if a logo is ever dropped, and `withLogos` upgrades the ones that have
 * real artwork. The logos are CC0 marks rendered to PNG data URIs at
 * build time — see logos.shared.ts — because a plugin client bundle cannot ship
 * image files.
 */
function withLogos(presets: Record<string, UsageProvider>): Record<string, UsageProvider> {
  const resolved: Record<string, UsageProvider> = {};
  for (const [id, preset] of Object.entries(presets)) {
    const logo = USAGE_LOGOS[id];
    resolved[id] = logo === undefined ? preset : { ...preset, icon: { kind: "image", uri: logo } };
  }
  return resolved;
}

const PRESET_DEFINITIONS: Record<string, UsageProvider> = {
  claude: definePreset({
    label: "Claude",
    icon: { kind: "monogram", text: "Cl", color: "#D97706" },
    description: "Claude Code session, weekly and per-model limits over the OAuth usage endpoint",
    // This endpoint was never designed to be polled: Claude Code itself takes
    // quota from rate-limit response headers on ordinary API calls and uses this
    // endpoint only as a seed. Measured live, it answers HTTP 429 with
    // `retry-after: 1495` (~25 minutes), and Paseo's own built-in quota fetcher
    // is a second caller on the same budget. Thirty minutes clears that window
    // for both callers and still resolves a 5-hour bucket.
    refreshIntervalMs: 1_800_000,
    credentials: {
      token: [
        {
          kind: "jsonFile",
          file: "${CLAUDE_CONFIG_DIR}/.credentials.json",
          path: "claudeAiOauth.accessToken",
          expiresAtPath: "claudeAiOauth.expiresAt",
          refreshedBy: "claude",
        },
        {
          kind: "jsonFile",
          file: "~/.claude/.credentials.json",
          path: "claudeAiOauth.accessToken",
          expiresAtPath: "claudeAiOauth.expiresAt",
          refreshedBy: "claude",
        },
      ],
    },
    source: {
      kind: "http",
      url: "https://api.anthropic.com/api/oauth/usage",
      method: "GET",
      headers: {
        Authorization: "Bearer ${token}",
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    readings: [
      {
        kind: "quota",
        id: "session",
        label: "Session",
        unit: "percent",
        percentPath: "five_hour.utilization",
        window: {
          label: "Session",
          resetsAtPath: "five_hour.resets_at",
          durationMs: FIVE_HOURS_MS,
        },
      },
      {
        kind: "quota",
        id: "weekly",
        label: "Weekly",
        unit: "percent",
        percentPath: "seven_day.utilization",
        window: {
          label: "Weekly",
          resetsAtPath: "seven_day.resets_at",
          durationMs: SEVEN_DAYS_MS,
        },
      },
      {
        kind: "quota",
        id: "scoped",
        label: "Weekly",
        unit: "percent",
        each: {
          path: "limits",
          idPath: "kind",
          labelPath: "scope.model.display_name",
          groupPath: "scope.model.display_name",
          // `limits` also carries the session and weekly windows the two
          // readings above already report, and those entries name no model, so
          // projecting them duplicated both numbers under fallback labels.
          // Paseo's own fetcher reconciles the same single kind.
          where: { path: "kind", equals: "weekly_scoped" },
        },
        percentPath: "percent",
        window: {
          label: "Weekly",
          resetsAtPath: "resets_at",
          durationMs: SEVEN_DAYS_MS,
        },
      },
    ],
  }),

  /**
   * The same two windows as `claude`, read from a file instead of over the
   * network. Claude Code passes `rate_limits` to its statusline command on
   * every turn, so a command that writes that object to disk turns the quota
   * into a local document: no token to expire, no 429, and nothing shared with
   * Paseo's own fetcher.
   *
   * The field names are the CLI's own — `utilization` is documented in its
   * statusline schema as "Percentage of the window used, 0-100" and `resets_at`
   * as an ISO 8601 timestamp — which is why they match the endpoint preset
   * above exactly. The CLI sends no per-model limits to a statusline, so this
   * preset reports two readings where `claude` reports three.
   *
   * It carries no credential at all. What it needs instead is the hook
   * installed, which `statusline-hook.sh` and the README cover; until then the
   * card says which paths it looked in.
   */
  "claude-statusline": definePreset({
    label: "Claude",
    icon: { kind: "monogram", text: "Cl", color: "#D97706" },
    description: "Claude Code session and weekly limits, read from its own statusline output",
    // A local file costs a read, so this refreshes as often as the panel asks
    // rather than on the endpoint's thirty-minute budget.
    refreshIntervalMs: 60_000,
    source: {
      kind: "file",
      files: ["${CLAUDE_CONFIG_DIR}/paseo-rate-limits.json", "~/.claude/paseo-rate-limits.json"],
    },
    readings: [
      {
        kind: "quota",
        id: "session",
        label: "Session",
        unit: "percent",
        percentPath: "five_hour.utilization",
        window: {
          label: "Session",
          resetsAtPath: "five_hour.resets_at",
          durationMs: FIVE_HOURS_MS,
        },
      },
      {
        kind: "quota",
        id: "weekly",
        label: "Weekly",
        unit: "percent",
        percentPath: "seven_day.utilization",
        window: {
          label: "Weekly",
          resetsAtPath: "seven_day.resets_at",
          durationMs: SEVEN_DAYS_MS,
        },
      },
    ],
  }),

  codex: definePreset({
    label: "Codex",
    icon: { kind: "monogram", text: "Cx", color: "#10B981" },
    description:
      "Codex session, weekly, code-review and reserve limits, plus banked resets and any prepaid credit balance",
    credentials: {
      // No expiresAtPath: auth.json records `auth_mode`, `last_refresh` and the
      // tokens object, and nothing else. `last_refresh` is when the CLI last
      // refreshed, not when the token dies, so no path here can be honest about
      // expiry and the request has to be spent to learn the token is stale.
      token: [
        {
          kind: "jsonFile",
          file: "${CODEX_HOME}/auth.json",
          path: "tokens.access_token",
          refreshedBy: "codex",
        },
        {
          kind: "jsonFile",
          file: "~/.codex/auth.json",
          path: "tokens.access_token",
          refreshedBy: "codex",
        },
        {
          kind: "jsonFile",
          file: "~/.config/codex/auth.json",
          path: "tokens.access_token",
          refreshedBy: "codex",
        },
      ],
    },
    source: {
      kind: "http",
      url: "https://chatgpt.com/backend-api/wham/usage",
      method: "GET",
      headers: {
        Authorization: "Bearer ${token}",
        Accept: "application/json",
      },
    },
    readings: [
      {
        kind: "quota",
        id: "session",
        label: "Session",
        unit: "percent",
        percentPath: "rate_limit.primary_window.used_percent",
        window: {
          label: "Session",
          resetsAtPath: "rate_limit.primary_window.reset_at",
          durationMs: FIVE_HOURS_MS,
        },
      },
      {
        kind: "quota",
        id: "weekly",
        label: "Weekly",
        unit: "percent",
        percentPath: "rate_limit.secondary_window.used_percent",
        window: {
          label: "Weekly",
          resetsAtPath: "rate_limit.secondary_window.reset_at",
          durationMs: SEVEN_DAYS_MS,
        },
      },
      {
        kind: "quota",
        id: "code-review",
        label: "Code review",
        unit: "percent",
        percentPath: "code_review_rate_limit.primary_window.used_percent",
        window: {
          label: "Session",
          resetsAtPath: "code_review_rate_limit.primary_window.reset_at",
          durationMs: FIVE_HOURS_MS,
        },
      },
      {
        kind: "quota",
        id: "additional",
        label: "Limit",
        unit: "percent",
        each: {
          path: "additional_rate_limits",
          idPath: "limit_name",
          labelPath: "limit_name",
          groupPath: "limit_name",
        },
        percentPath: "rate_limit.primary_window.used_percent",
        // This array mixes 5-hour and weekly buckets, so it carries no durationMs:
        // a fixed window length would draw a pace line that is wrong half the time.
        window: { label: "Window", resetsAtPath: "rate_limit.primary_window.reset_at" },
      },
      {
        kind: "balance",
        id: "credits",
        label: "Credits",
        unit: "usd",
        remainingPath: "credits.balance",
      },
      {
        kind: "balance",
        id: "banked-resets",
        label: "Banked resets",
        unit: "credits",
        remainingPath: "rate_limit_reset_credits.available_count",
      },
    ],
  }),
  cursor: definePreset({
    label: "Cursor",
    icon: { kind: "monogram", text: "Cu", color: "#8B5CF6" },
    description: "Cursor plan spend, limit and remaining balance",
    credentials: {
      token: [
        { kind: "env", variable: "CURSOR_ACCESS_TOKEN" },
        { kind: "env", variable: "CURSOR_TOKEN" },
        { kind: "jsonFile", file: "${CURSOR_HOME}/auth.json", path: "accessToken" },
        { kind: "jsonFile", file: "~/.config/cursor/auth.json", path: "accessToken" },
        { kind: "jsonFile", file: "~/.cursor/auth.json", path: "accessToken" },
      ],
    },
    source: {
      kind: "http",
      url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      method: "POST",
      headers: {
        Authorization: "Bearer ${token}",
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: {},
    },
    readings: [
      {
        kind: "quota",
        id: "plan-usage",
        label: "Plan usage",
        unit: "usd",
        scale: 0.01,
        usedPath: "planUsage.totalSpend",
        limitPath: "planUsage.limit",
        remainingPath: "planUsage.remaining",
        window: {
          label: "Billing cycle",
          resetsAtPath: "billingCycleEnd",
        },
      },
    ],
  }),

  grok: definePreset({
    label: "Grok",
    icon: { kind: "monogram", text: "Gk", color: "#1F2937" },
    description: "Grok CLI monthly credit limit and usage",
    credentials: {
      token: [
        { kind: "env", variable: "GROK_API_KEY" },
        { kind: "env", variable: "GROK_TOKEN" },
        { kind: "jsonFile", file: "${GROK_HOME}/auth.json", path: "access_token" },
        { kind: "jsonFile", file: "~/.grok/auth.json", path: "access_token" },
        { kind: "jsonFile", file: "~/.config/grok/auth.json", path: "access_token" },
      ],
    },
    source: {
      kind: "http",
      url: "https://cli-chat-proxy.grok.com/v1/billing",
      method: "GET",
      headers: {
        Authorization: "Bearer ${token}",
        "X-XAI-Token-Auth": "xai-grok-cli",
        Accept: "application/json",
      },
    },
    readings: [
      {
        kind: "quota",
        id: "monthly-credits",
        label: "Monthly credits",
        unit: "credits",
        usedPath: "config.used.val",
        limitPath: "config.monthlyLimit.val",
      },
    ],
  }),

  deepseek: definePreset({
    label: "DeepSeek",
    icon: { kind: "monogram", text: "DS", color: "#3B82F6" },
    description: "Prepaid API balance",
    credentials: {
      apiKey: [{ kind: "env", variable: "DEEPSEEK_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.deepseek.com/user/balance",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}" },
    },
    readings: [
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        unit: "usd",
        remainingPath: "balance_infos[0].total_balance",
        currencyPath: "balance_infos[0].currency",
      },
      {
        kind: "balance",
        id: "granted",
        label: "Granted",
        unit: "usd",
        remainingPath: "balance_infos[0].granted_balance",
        currencyPath: "balance_infos[0].currency",
      },
    ],
  }),

  "deepseek-rate": definePreset({
    label: "DeepSeek pricing",
    icon: { kind: "lucide", name: "Gauge" },
    description:
      "Which DeepSeek pricing band is in force right now; needs no credential because the schedule is published, not measured",
    // Schedule-only, so there is no source and nothing to fetch. DeepSeek
    // retired the old 16:30–00:30 UTC off-peak window on 24 July 2026: peak is
    // now 01:00–04:00 and 06:00–10:00 UTC on weekdays, and everything else,
    // including the whole weekend, bills at half the peak rate.
    readings: [
      {
        kind: "rate",
        id: "pricing",
        label: "Pricing",
        resolution: {
          via: "schedule",
          schedule: {
            timeZone: "UTC",
            defaultLabel: "Off-peak",
            defaultMultiplier: 1,
            windows: [
              { label: "Peak", start: "01:00", end: "04:00", days: [1, 2, 3, 4, 5], multiplier: 2 },
              { label: "Peak", start: "06:00", end: "10:00", days: [1, 2, 3, 4, 5], multiplier: 2 },
            ],
          },
        },
      },
    ],
  }),

  openrouter: definePreset({
    label: "OpenRouter",
    icon: { kind: "monogram", text: "OR", color: "#6366F1" },
    description:
      "Spend cap on the current API key, not the account; an unlimited key reports no numbers",
    credentials: {
      apiKey: [{ kind: "env", variable: "OPENROUTER_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://openrouter.ai/api/v1/key",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}" },
    },
    readings: [
      {
        kind: "balance",
        id: "credits",
        label: "Key credits",
        unit: "credits",
        remainingPath: "data.limit_remaining",
        totalPath: "data.limit",
      },
    ],
  }),

  "openrouter-credits": definePreset({
    label: "OpenRouter credits",
    icon: { kind: "monogram", text: "OC", color: "#8B5CF6" },
    description:
      "Account-wide credits purchased against credits used, unlike the per-key cap the openrouter preset reads; a 401 here means the account key is not provisioned for the credits endpoint",
    credentials: {
      apiKey: [{ kind: "env", variable: "OPENROUTER_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://openrouter.ai/api/v1/credits",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}" },
    },
    readings: [
      {
        kind: "quota",
        id: "credits",
        label: "Account credits",
        unit: "credits",
        usedPath: "data.total_usage",
        limitPath: "data.total_credits",
      },
    ],
  }),

  novita: definePreset({
    label: "Novita",
    icon: { kind: "monogram", text: "Nv", color: "#06B6D4" },
    description: "Prepaid balance against the account's credit limit, billed in USD",
    credentials: {
      apiKey: [{ kind: "env", variable: "NOVITA_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.novita.ai/openapi/v1/billing/balance/detail",
      method: "GET",
      headers: {
        Authorization: "Bearer ${apiKey}",
        "Content-Type": "application/json",
      },
    },
    readings: [
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        unit: "usd",
        // Amounts arrive as strings in ten-thousandths of a dollar; the vendor
        // doc fixes the rate at 10000 = $1.00.
        scale: 0.0001,
        remainingPath: "availableBalance",
        totalPath: "creditLimit",
      },
    ],
  }),

  deepinfra: definePreset({
    label: "DeepInfra",
    icon: { kind: "monogram", text: "DI", color: "#F59E0B" },
    description: "Prepaid balance, reported by the vendor as a negative number",
    credentials: {
      apiKey: [{ kind: "env", variable: "DEEPINFRA_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.deepinfra.com/payment/checklist",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}" },
    },
    readings: [
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        unit: "usd",
        // The vendor models credit as money owed: "Negative value indicates
        // funds ready-to-spend. Positive value indicates money owed." Inverting
        // turns that into a spendable balance. The response also carries a
        // positive `limit`, deliberately unmapped: the same scale would flip its
        // sign, and a wrong total is worse than no bar.
        scale: -1,
        remainingPath: "stripe_balance",
      },
    ],
  }),

  siliconflow: definePreset({
    label: "SiliconFlow",
    icon: { kind: "monogram", text: "SF", color: "#A855F7" },
    description:
      "Prepaid balance on the international api.siliconflow.com host; the domestic api.siliconflow.cn mirror uses the same shape but may bill in a different currency",
    credentials: {
      apiKey: [{ kind: "env", variable: "SILICONFLOW_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.siliconflow.com/v1/user/info",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}" },
    },
    readings: [
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        unit: "usd",
        remainingPath: "data.totalBalance",
      },
    ],
  }),

  "stepfun-ai": definePreset({
    label: "StepFun",
    icon: { kind: "monogram", text: "St", color: "#0EA5E9" },
    description:
      "Available platform balance on the international api.stepfun.ai host; the response also carries cumulative deposits and grants, which are totals paid in rather than a ceiling, so only the spendable balance is shown",
    credentials: {
      apiKey: [{ kind: "env", variable: "STEPFUN_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.stepfun.ai/v1/accounts",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}", Accept: "application/json" },
    },
    readings: [
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        unit: "usd",
        remainingPath: "balance",
      },
    ],
  }),

  stepfun: definePreset({
    label: "StepFun (CN)",
    icon: { kind: "monogram", text: "SC", color: "#0369A1" },
    description:
      "Available platform balance on the domestic api.stepfun.com host, the same shape as the international one; shown unitless because the domestic account bills in CNY, and a key is issued for one host only",
    credentials: {
      apiKey: [{ kind: "env", variable: "STEPFUN_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.stepfun.com/v1/accounts",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}", Accept: "application/json" },
    },
    readings: [
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        unit: "credits",
        remainingPath: "balance",
      },
    ],
  }),

  "siliconflow-cn": definePreset({
    label: "SiliconFlow (CN)",
    icon: { kind: "monogram", text: "SC", color: "#9333EA" },
    description:
      "Prepaid balance on the domestic api.siliconflow.cn host, the same shape as the international one; the amount is shown unitless because the domestic account bills in CNY",
    credentials: {
      apiKey: [{ kind: "env", variable: "SILICONFLOW_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.siliconflow.cn/v1/user/info",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}" },
    },
    readings: [
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        unit: "credits",
        remainingPath: "data.totalBalance",
      },
    ],
  }),

  moonshot: definePreset({
    label: "Moonshot",
    icon: { kind: "monogram", text: "MS", color: "#14B8A6" },
    description:
      "Moonshot platform balance in USD on the international host; this is the platform key, not the coding-plan key the kimi preset uses, and a domestic .cn key returns 401 here",
    credentials: {
      apiKey: [{ kind: "env", variable: "MOONSHOT_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.moonshot.ai/v1/users/me/balance",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}" },
    },
    readings: [
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        unit: "usd",
        remainingPath: "data.available_balance",
      },
    ],
  }),

  "moonshot-cn": definePreset({
    label: "Moonshot (CN)",
    icon: { kind: "monogram", text: "CN", color: "#F43F5E" },
    description:
      "Moonshot platform balance on the domestic host, which an international key cannot read and vice versa; the amount is shown unitless because the domestic account is understood to bill in CNY and no source confirms the currency the field carries",
    credentials: {
      apiKey: [{ kind: "env", variable: "MOONSHOT_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.moonshot.cn/v1/users/me/balance",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}" },
    },
    readings: [
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        unit: "credits",
        remainingPath: "data.available_balance",
      },
    ],
  }),

  venice: definePreset({
    label: "Venice",
    icon: { kind: "monogram", text: "V", color: "#EC4899" },
    description:
      "DIEM allowance for the current epoch and any USD balance; which one bills depends on the account's consumption currency, so both are shown",
    credentials: {
      apiKey: [{ kind: "env", variable: "VENICE_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.venice.ai/api/v1/billing/balance",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}" },
    },
    readings: [
      {
        kind: "quota",
        id: "diem",
        label: "DIEM epoch",
        unit: "credits",
        remainingPath: "balances.diem",
        limitPath: "diemEpochAllocation",
      },
      {
        kind: "balance",
        id: "usd",
        label: "USD balance",
        unit: "usd",
        remainingPath: "balances.usd",
      },
    ],
  }),

  kimi: definePreset({
    label: "Kimi",
    icon: { kind: "monogram", text: "K", color: "#4F46E5" },
    description: "Kimi coding request allowance for the current window",
    credentials: {
      token: [
        { kind: "env", variable: "KIMI_TOKEN" },
        { kind: "env", variable: "KIMI_API_KEY" },
        {
          kind: "jsonFile",
          file: "${KIMI_CODE_HOME}/credentials/kimi-code.json",
          path: "access_token",
          expiresAtPath: "expires_at",
        },
        {
          kind: "jsonFile",
          file: "~/.kimi-code/credentials/kimi-code.json",
          path: "access_token",
          expiresAtPath: "expires_at",
        },
        {
          kind: "jsonFile",
          file: "~/.kimi/credentials/kimi-code.json",
          path: "access_token",
          expiresAtPath: "expires_at",
        },
      ],
    },
    source: {
      kind: "http",
      url: "https://api.kimi.com/coding/v1/usages",
      method: "GET",
      headers: {
        Authorization: "Bearer ${token}",
        Accept: "application/json",
      },
    },
    readings: [
      {
        kind: "quota",
        id: "usage",
        label: "Coding usage",
        unit: "requests",
        usedPath: "usage.used",
        limitPath: "usage.limit",
        remainingPath: "usage.remaining",
        window: { label: "Window", resetsAtPath: "usage.resetTime" },
      },
    ],
  }),

  minimax: definePreset({
    label: "MiniMax",
    icon: { kind: "monogram", text: "MM", color: "#EA580C" },
    description:
      "Per-model consumption inside rolling interval and weekly windows, not a prepaid balance; this endpoint needs a Token Plan subscription key, which the vendor issues separately from an ordinary pay-as-you-go API key",
    credentials: {
      token: [
        { kind: "env", variable: "MINIMAX_API_KEY" },
        {
          kind: "jsonFile",
          file: "~/.mmx/credentials.json",
          path: "access_token",
          expiresAtPath: "expires_at",
        },
        // A pay-as-you-go API key, not an OAuth token: it carries no expiry.
        { kind: "jsonFile", file: "~/.mmx/config.json", path: "api_key" },
        {
          kind: "jsonFile",
          file: "~/.mmx/config.json",
          path: "oauth.access_token",
          expiresAtPath: "oauth.expires_at",
        },
      ],
    },
    source: {
      kind: "http",
      url: "https://api.minimax.io/v1/token_plan/remains",
      method: "GET",
      headers: {
        Authorization: "Bearer ${token}",
        Accept: "application/json",
      },
    },
    readings: [
      {
        kind: "quota",
        id: "interval",
        label: "Interval",
        unit: "requests",
        each: {
          path: "model_remains",
          idPath: "model_name",
          labelPath: "model_name",
          groupPath: "model_name",
        },
        percentRemainingPath: "current_interval_remaining_percent",
        usedPath: "current_interval_usage_count",
        limitPath: "current_interval_total_count",
        window: { label: "Interval", resetsAtPath: "end_time" },
      },
      {
        kind: "quota",
        id: "weekly",
        label: "Weekly",
        unit: "requests",
        each: {
          path: "model_remains",
          idPath: "model_name",
          labelPath: "model_name",
          groupPath: "model_name",
        },
        percentRemainingPath: "current_weekly_remaining_percent",
        usedPath: "current_weekly_usage_count",
        limitPath: "current_weekly_total_count",
        window: {
          label: "Weekly",
          resetsAtPath: "weekly_end_time",
          durationMs: SEVEN_DAYS_MS,
        },
      },
    ],
  }),

  /**
   * The same route MiniMax serves on its international host, on the mainland
   * one. A key is issued for one host and answers a login failure on the
   * other, so the two are separate presets rather than one with a switch.
   */
  "minimax-cn": definePreset({
    label: "MiniMax (CN)",
    icon: { kind: "monogram", text: "MC", color: "#C2410C" },
    description:
      "Per-model consumption inside rolling interval and weekly windows on the mainland api.minimaxi.com host; needs a Token Plan subscription key issued for that host, and an international key returns a login failure here",
    credentials: {
      token: [
        { kind: "env", variable: "MINIMAX_CN_API_KEY" },
        { kind: "env", variable: "MINIMAX_API_KEY" },
      ],
    },
    source: {
      kind: "http",
      url: "https://api.minimaxi.com/v1/token_plan/remains",
      method: "GET",
      headers: {
        Authorization: "Bearer ${token}",
        Accept: "application/json",
      },
    },
    readings: [
      {
        kind: "quota",
        id: "interval",
        label: "Interval",
        unit: "requests",
        each: {
          path: "model_remains",
          idPath: "model_name",
          labelPath: "model_name",
          groupPath: "model_name",
        },
        percentRemainingPath: "current_interval_remaining_percent",
        usedPath: "current_interval_usage_count",
        limitPath: "current_interval_total_count",
        window: { label: "Interval", resetsAtPath: "end_time" },
      },
      {
        kind: "quota",
        id: "weekly",
        label: "Weekly",
        unit: "requests",
        each: {
          path: "model_remains",
          idPath: "model_name",
          labelPath: "model_name",
          groupPath: "model_name",
        },
        percentRemainingPath: "current_weekly_remaining_percent",
        usedPath: "current_weekly_usage_count",
        limitPath: "current_weekly_total_count",
        window: {
          label: "Weekly",
          resetsAtPath: "weekly_end_time",
          durationMs: SEVEN_DAYS_MS,
        },
      },
    ],
  }),

  /**
   * Z.ai's GLM Coding Plan reports its windows as one `limits` array. Each
   * entry names its window by `unit` (3 = hours, 6 = weeks, 5 = minutes) and
   * `number`, its kind by `type` (`TOKENS_LIMIT` carries only a percentage,
   * `CREDIT_LIMIT` also carries counts, `TIME_LIMIT` is the monthly MCP-call
   * allowance), and its reset as epoch milliseconds. The route is the one the
   * vendor's own usage-query plugin calls; it is documented as that plugin
   * rather than as a reference page, and corroborated by CodexBar's fixtures.
   */
  "zai-coding-plan": definePreset({
    label: "Z.ai Coding Plan",
    icon: { kind: "monogram", text: "Z", color: "#2563EB" },
    description:
      "GLM Coding Plan session and weekly windows plus the monthly MCP-call allowance on the international api.z.ai host; takes the coding-plan API key, and a mainland bigmodel.cn key belongs on the zhipuai-coding-plan preset instead",
    credentials: {
      apiKey: [
        { kind: "env", variable: "Z_AI_API_KEY" },
        { kind: "env", variable: "ZAI_API_KEY" },
        { kind: "env", variable: "GLM_API_KEY" },
      ],
    },
    source: {
      kind: "http",
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
      method: "GET",
      // A key with no Coding Plan gets HTTP 200 and `{"success":false,"msg":
      // "当前用户不存在coding plan"}`, "this user has no coding plan". Without
      // this the document projects to nothing and the card is silently empty.
      failure: {
        path: "success",
        equals: false,
        messagePath: "msg",
        hint: "This key has no GLM Coding Plan subscription. The route reports plan quota only; a pay-as-you-go credit balance has no route to read and is shown in the Z.ai console.",
      },
      headers: {
        Authorization: "Bearer ${apiKey}",
        Accept: "application/json",
        "Accept-Language": "en-US,en",
      },
    },
    readings: ZAI_CODING_PLAN_READINGS,
  }),

  zai: definePreset({
    label: "Z.ai",
    icon: { kind: "monogram", text: "Z", color: "#2563EB" },
    description:
      "GLM Coding Plan session and weekly windows plus the monthly MCP-call allowance on the international api.z.ai host; takes the coding-plan API key, and a mainland bigmodel.cn key belongs on the zhipuai-coding-plan preset instead",
    credentials: {
      apiKey: [
        { kind: "env", variable: "Z_AI_API_KEY" },
        { kind: "env", variable: "ZAI_API_KEY" },
        { kind: "env", variable: "GLM_API_KEY" },
      ],
    },
    source: {
      kind: "http",
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
      method: "GET",
      // A key with no Coding Plan gets HTTP 200 and `{"success":false,"msg":
      // "当前用户不存在coding plan"}`, "this user has no coding plan". Without
      // this the document projects to nothing and the card is silently empty.
      failure: {
        path: "success",
        equals: false,
        messagePath: "msg",
        hint: "This key has no GLM Coding Plan subscription. The route reports plan quota only; a pay-as-you-go credit balance has no route to read and is shown in the Z.ai console.",
      },
      headers: {
        Authorization: "Bearer ${apiKey}",
        Accept: "application/json",
        "Accept-Language": "en-US,en",
      },
    },
    readings: ZAI_CODING_PLAN_READINGS,
  }),

  "zhipuai-coding-plan": definePreset({
    label: "Zhipu Coding Plan",
    icon: { kind: "monogram", text: "ZP", color: "#1D4ED8" },
    description:
      "GLM Coding Plan session and weekly windows plus the monthly MCP-call allowance on the mainland open.bigmodel.cn host; an international z.ai key returns an auth error here",
    credentials: {
      apiKey: [
        { kind: "env", variable: "ZHIPU_API_KEY" },
        { kind: "env", variable: "ZHIPUAI_API_KEY" },
        { kind: "env", variable: "BIGMODEL_API_KEY" },
      ],
    },
    source: {
      kind: "http",
      url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
      method: "GET",
      failure: {
        path: "success",
        equals: false,
        messagePath: "msg",
        hint: "This key has no GLM Coding Plan subscription. The route reports plan quota only; a pay-as-you-go balance has no route to read and is shown in the bigmodel.cn console.",
      },
      headers: {
        Authorization: "Bearer ${apiKey}",
        Accept: "application/json",
        "Accept-Language": "en-US,en",
      },
    },
    readings: ZAI_CODING_PLAN_READINGS,
  }),

  xai: definePreset({
    label: "xAI",
    icon: { kind: "monogram", text: "xA", color: "#171717" },
    description:
      "Prepaid credit for one xAI team over the Management API; this needs a management key plus the team id, not an inference key, and the vendor reports the balance in USD cents as a liability, so credit arrives negative",
    credentials: {
      apiKey: [{ kind: "env", variable: "XAI_MANAGEMENT_API_KEY" }],
      // Not a secret, but the route is per team and the url is the only place
      // to put it. The Usage providers surface stores it like any other name.
      teamId: [{ kind: "env", variable: "XAI_TEAM_ID" }],
    },
    source: {
      kind: "http",
      url: "https://management-api.x.ai/v1/billing/teams/${teamId}/prepaid/balance",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}", Accept: "application/json" },
    },
    readings: [
      {
        kind: "balance",
        id: "prepaid",
        label: "Prepaid credit",
        unit: "usd",
        // `total.val` is a string of USD cents and the docs' own example is
        // "-1000" after a purchase: the team is owed the money, so a credit is
        // negative. Inverting and dividing by a hundred gives dollars in hand.
        scale: -0.01,
        remainingPath: "total.val",
      },
    ],
  }),

  vercel: definePreset({
    label: "Vercel AI Gateway",
    icon: { kind: "monogram", text: "VG", color: "#0A0A0A" },
    description: "Team-wide AI Gateway credit balance in USD, read with an ordinary gateway key",
    credentials: {
      apiKey: [
        { kind: "env", variable: "AI_GATEWAY_API_KEY" },
        { kind: "env", variable: "VERCEL_AI_GATEWAY_API_KEY" },
      ],
    },
    source: {
      kind: "http",
      url: "https://ai-gateway.vercel.sh/v1/credits",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}", Accept: "application/json" },
    },
    readings: [
      {
        kind: "balance",
        id: "credits",
        label: "Credits",
        unit: "usd",
        // The response also carries `total_used`, lifetime spend rather than a
        // starting balance, so it is not a total and is deliberately unmapped.
        remainingPath: "balance",
      },
    ],
  }),

  "nano-gpt": definePreset({
    label: "NanoGPT",
    icon: { kind: "monogram", text: "NG", color: "#16A34A" },
    description:
      "Prepaid USD balance, and any Nano crypto balance held on the account; the vendor's balance route is a POST that takes the key in an x-api-key header",
    credentials: {
      apiKey: [{ kind: "env", variable: "NANOGPT_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://nano-gpt.com/api/check-balance",
      method: "POST",
      headers: { "x-api-key": "${apiKey}", Accept: "application/json" },
    },
    readings: [
      {
        kind: "balance",
        id: "usd",
        label: "Balance",
        unit: "usd",
        remainingPath: "usd_balance",
      },
      {
        kind: "balance",
        id: "nano",
        label: "Nano",
        unit: "credits",
        remainingPath: "nano_balance",
      },
    ],
  }),

  poe: definePreset({
    label: "Poe",
    icon: { kind: "monogram", text: "Po", color: "#7C3AED" },
    description:
      "Points left on the account, plan points and add-on points combined; Poe meters in points rather than currency",
    credentials: {
      apiKey: [{ kind: "env", variable: "POE_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.poe.com/usage/current_balance",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}", Accept: "application/json" },
    },
    readings: [
      {
        kind: "balance",
        id: "points",
        label: "Points",
        unit: "credits",
        remainingPath: "current_point_balance",
      },
    ],
  }),

  synthetic: definePreset({
    label: "Synthetic",
    icon: { kind: "monogram", text: "Sy", color: "#F97316" },
    description:
      "Subscription requests used against the plan's limit; the vendor states that reading this route does not count against it",
    credentials: {
      apiKey: [{ kind: "env", variable: "SYNTHETIC_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.synthetic.new/v2/quotas",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}", Accept: "application/json" },
    },
    readings: [
      {
        kind: "quota",
        id: "subscription",
        label: "Requests",
        unit: "requests",
        usedPath: "subscription.requests",
        limitPath: "subscription.limit",
        // A renewal date but no published period length, so no pace marker.
        window: { label: "Subscription", resetsAtPath: "subscription.renewsAt" },
      },
    ],
  }),

  /**
   * The public Go endpoint and the browser payload use different names for the
   * same windows. CodexBar's public-API fixture records `usage.rolling` with
   * `percent` and `resetsAt`; its parser also accepts `resetInSec`, so both reset
   * forms are declared and the projection keeps the absolute one authoritative.
   */
  "opencode-go": definePreset({
    label: "OpenCode Go",
    icon: { kind: "monogram", text: "OG", color: "#0F766E" },
    description:
      "OpenCode Go rolling five-hour, weekly and monthly subscription usage; this is the Go subscription product, not OpenCode Zen's pay-per-token balance",
    credentials: {
      apiKey: [{ kind: "env", variable: "OPENCODE_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://opencode.ai/zen/go/v1/usage",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}", Accept: "application/json" },
    },
    readings: [
      {
        kind: "quota",
        id: "rolling",
        label: "Rolling",
        unit: "percent",
        percentPath: "usage.rolling.percent",
        window: {
          label: "5 hours",
          resetsAtPath: "usage.rolling.resetsAt",
          resetsInSecPath: "usage.rolling.resetInSec",
          durationMs: FIVE_HOURS_MS,
        },
      },
      {
        kind: "quota",
        id: "weekly",
        label: "Weekly",
        unit: "percent",
        percentPath: "usage.weekly.percent",
        window: {
          label: "Weekly",
          resetsAtPath: "usage.weekly.resetsAt",
          resetsInSecPath: "usage.weekly.resetInSec",
          durationMs: SEVEN_DAYS_MS,
        },
      },
      {
        kind: "quota",
        id: "monthly",
        label: "Monthly",
        unit: "percent",
        percentPath: "usage.monthly.percent",
        // A calendar month has no fixed duration, so the reset time is useful
        // without a pace marker that would be wrong for some billing cycles.
        window: {
          label: "Monthly",
          resetsAtPath: "usage.monthly.resetsAt",
          resetsInSecPath: "usage.monthly.resetInSec",
        },
      },
    ],
  }),

  /**
   * The subscription route is self-scoped and accepts an ordinary API key. Its
   * response may omit a rolling window, where CodexBar makes a second request to
   * `/users/me/quotas`; this declarative source cannot make that fallback call,
   * so it projects only what the subscription response itself carries.
   */
  chutes: definePreset({
    label: "Chutes",
    icon: { kind: "monogram", text: "Ch", color: "#7C3AED" },
    description:
      "Self-scoped subscription usage from an ordinary Chutes API key; the rolling request and monthly credit windows appear when the subscription response carries them",
    credentials: {
      apiKey: [{ kind: "env", variable: "CHUTES_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://api.chutes.ai/users/me/subscription_usage",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}", Accept: "application/json" },
    },
    readings: [
      {
        kind: "quota",
        id: "rolling",
        label: "Rolling",
        unit: "requests",
        usedPath: "rolling_window.requests",
        limitPath: "rolling_window.limit",
        // The response reports the window in minutes, while this schema accepts
        // milliseconds, so omitting duration avoids inventing a fixed period.
        window: { label: "Rolling", resetsAtPath: "rolling_window.reset_at" },
      },
      {
        kind: "quota",
        id: "monthly",
        label: "Monthly",
        unit: "credits",
        usedPath: "monthly.used",
        limitPath: "monthly.limit",
        window: { label: "Monthly", resetsAtPath: "monthly.resets_at" },
      },
    ],
  }),

  /**
   * ZenMux publishes separate subscription-detail and PAYG-balance requests.
   * One declarative source can make only one request, so this preset uses the
   * subscription endpoint and leaves the independently fetched balance out.
   */
  zenmux: definePreset({
    label: "ZenMux",
    icon: { kind: "monogram", text: "ZM", color: "#DC2626" },
    description:
      "Builder Plan five-hour and seven-day flow quotas over the Management API; requires a Management API key, and the separate PAYG balance request is not included",
    credentials: {
      apiKey: [{ kind: "env", variable: "ZENMUX_MANAGEMENT_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://zenmux.ai/api/v1/management/subscription/detail",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}", Accept: "application/json" },
      // The route wraps every answer in `{"success":…,"message":…,"data":…}`
      // and reports refusals in that envelope rather than only by status: a
      // keyless request answers `{"success":false,"message":"API key not
      // provided","data":null}`. A `data: null` body projects to nothing, so
      // without this an account with no Builder Plan would render as an empty
      // card instead of saying why, exactly as the GLM presets would have.
      failure: {
        path: "success",
        equals: false,
        messagePath: "message",
        hint: "This key has no ZenMux Builder Plan subscription, or it is not a Management API key. The pay-as-you-go balance is a separate request this preset does not make.",
      },
    },
    readings: [
      {
        kind: "quota",
        id: "five-hour",
        label: "5 hour",
        unit: "flows",
        usedPath: "data.quota_5_hour.used_flows",
        limitPath: "data.quota_5_hour.max_flows",
        window: {
          label: "5 hours",
          resetsAtPath: "data.quota_5_hour.resets_at",
          durationMs: FIVE_HOURS_MS,
        },
      },
      {
        kind: "quota",
        id: "weekly",
        label: "Weekly",
        unit: "flows",
        usedPath: "data.quota_7_day.used_flows",
        limitPath: "data.quota_7_day.max_flows",
        window: {
          label: "Weekly",
          resetsAtPath: "data.quota_7_day.resets_at",
          durationMs: SEVEN_DAYS_MS,
        },
      },
    ],
  }),

  /**
   * GitHub documents Copilot's premium-request limits but not a route to read
   * them, so this is a probe like Antigravity: the mechanism ships as code in
   * github-copilot-probe.server.ts, which reads the token the Copilot IDE
   * extensions stored and calls the internal endpoint they call on start-up.
   * The probe emits every bucket the response knows, flagged `metered` only
   * when the plan counts it, so the reading filters to the bars that mean
   * something and an unlimited bucket never renders as exhausted.
   */
  "github-copilot": definePreset({
    label: "GitHub Copilot",
    icon: { kind: "monogram", text: "Co", color: "#24292F" },
    description:
      "Unverified: GitHub documents Copilot's request limits but no route to read them, so this reads the user's own Copilot OAuth token and calls the internal endpoint the official IDE extensions call, and may break without notice.",
    unverified: true,
    source: { kind: "probe", probe: "github-copilot" },
    readings: [
      {
        kind: "quota",
        id: "bucket",
        label: "Copilot",
        unit: "requests",
        each: {
          path: "buckets",
          idPath: "id",
          labelPath: "label",
          where: { path: "metered", equals: true },
        },
        remainingPath: "remaining",
        limitPath: "entitlement",
        // The reset is a calendar day, not a timestamp, and months differ in
        // length, so there is no honest durationMs to give.
        window: { label: "Monthly", resetsAtPath: "resetsAt" },
      },
    ],
  }),

  antigravity: definePreset({
    label: "Antigravity",
    icon: { kind: "monogram", text: "AG", color: "#84CC16" },
    description:
      "Unverified: Google publishes no Antigravity quota API, so the percentages read the user's own stored credential and an undocumented endpoint, and may break without notice. That route answers for the consumer plan only, so the rows under it count what each Antigravity client on this machine actually spent, from its own logs.",
    unverified: true,
    source: { kind: "probe", probe: "antigravity" },
    readings: [
      /**
       * Local accounting first, because it is what answers "how much have I
       * used": every Antigravity client on this machine, from the logs each one
       * writes. Requests lead, because a request is the unit Antigravity's own
       * plans are counted in, and `limits: {"requests": N}` in the config turns
       * these rows into real bars. No preset default: an invented allowance
       * would draw a confident wrong percentage.
       */
      {
        kind: "quota",
        id: "requests",
        label: "Requests",
        unit: "requests",
        each: {
          path: "usage.requests",
          idPath: "id",
          labelPath: "label",
          groupPath: "group",
        },
        usedPath: "amount",
      },
      {
        kind: "quota",
        id: "tokens",
        label: "Tokens",
        unit: "tokens",
        each: {
          path: "usage.tokens",
          idPath: "id",
          labelPath: "label",
          groupPath: "group",
        },
        usedPath: "amount",
      },
      {
        kind: "quota",
        id: "spend",
        label: "Spend",
        unit: "usd",
        each: {
          path: "usage.spend",
          idPath: "id",
          labelPath: "label",
          groupPath: "group",
        },
        usedPath: "amount",
      },
      /**
       * The vendor's own pool, last, because it answers for the consumer plan
       * only. Traffic under the user's own Cloud project — which is how Paseo
       * reaches the model — never decrements it, so these bars can read 0%
       * beside a day of heavy use. The label says whose ledger it is.
       */
      {
        kind: "quota",
        id: "bucket",
        label: "Plan pool",
        unit: "percent",
        each: { path: "buckets", idPath: "id", labelPath: "label", groupPath: "group" },
        percentPath: "usedPercent",
        // The probe returns 5-hour and weekly buckets in one array, so there is
        // no single durationMs to give: a fixed length would be wrong for half
        // of them. These bars show a reset time and no pace marker.
        window: { label: "Window", resetsAtPath: "resetsAt" },
      },
    ],
  }),

  "opencode-zen": definePreset({
    label: "OpenCode Zen",
    icon: { kind: "monogram", text: "OZ", color: "#64748B" },
    description:
      "Unverified: a balance endpoint is still an open, unimplemented feature request upstream, so this preset is a template you must repoint at a real endpoint once one ships.",
    unverified: true,
    credentials: {
      apiKey: [{ kind: "env", variable: "OPENCODE_ZEN_API_KEY" }],
    },
    source: {
      kind: "http",
      url: "https://example.invalid/zen/v1/balance",
      method: "GET",
      headers: { Authorization: "Bearer ${apiKey}" },
    },
    readings: [
      {
        kind: "balance",
        id: "balance",
        label: "Balance",
        unit: "usd",
        remainingPath: "balance",
      },
    ],
  }),
};

export const USAGE_PRESETS: Record<string, UsageProvider> = withLogos(PRESET_DEFINITIONS);

export function getUsagePreset(id: string): UsageProvider | null {
  if (!Object.hasOwn(USAGE_PRESETS, id)) return null;
  return USAGE_PRESETS[id] ?? null;
}

export function listUsagePresetIds(): string[] {
  return Object.keys(USAGE_PRESETS);
}
