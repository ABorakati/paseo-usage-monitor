import { describe, expect, test } from "vitest";
import {
  detectAssistantUsageLimit,
  detectUsageLimit,
  limitKindFor,
  limitKindFromText,
  parseResetInstant,
  resetUrlFor,
  topUpUrlFor,
  usageProviderIdFor,
  VENDORS,
  vendorLabelFor,
} from "./limit-detect.shared";
import { listUsagePresetIds } from "./presets.shared";

const NOW = new Date("2026-09-10T11:00:00.000Z");

/** Agent prose that names numbers and limits as ordinary work, seen in real turns. */
const AGENT_PROSE = [
  "- S9: 402 URLs compared before and after (status + sha256), 0 mismatches.",
  "Tests: 402 passed, 0 failed.",
  "| Put-debit spread | 09.01.2026 | 28.07.2026 | 7 | 43 % | +429 |",
  "seam                     EG-08 TTLock 429, EG-09 IDV",
  "Added retry with backoff when the API returns 429.",
  "The middleware now applies a rate limit of 100 req/min per user.",
  "Fixed the handler so it returns 402 Payment Required for unpaid plans.",
  "Show the user's available credits in the billing page.",
];

/** A Google/Antigravity harness refusal, captured from a real turn. */
const GOOGLE_QUOTA_REFUSAL =
  'Cloud Code Assist API error (429): {"error":{"code":429,"message":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 6h53m44s.","status":"RESOURCE_EXHAUSTED","details":[{"metadata":{"quotaResetTimeStamp":"2026-09-10T18:19:59Z"}}]}}';

/** A Codex refusal, captured from a real turn. It names no reset time. */
const CODEX_QUOTA_REFUSAL =
  "Codex error event: The usage limit has been reached (code=usage_limit_reached)";

const CLAUDE_WORDINGS = [
  "You've hit your limit · resets 3pm (Europe/London)",
  "Claude usage limit reached. Your limit will reset at 3pm (UTC)",
  "API Error: 429 rate_limit_error",
];

/** Claude Code's notices that name the window, as current builds print them. */
const CLAUDE_NAMED_WINDOW_WORDINGS = [
  "You've hit your session limit · resets 7am (Europe/Minsk)",
  "You've hit your weekly limit · resets Sep 14, 5am (Europe/Minsk)",
  "You've hit your Opus limit · resets Sep 14, 5am (Europe/Minsk)",
  "You've hit your Sonnet limit · resets Sep 14, 5am (Europe/Minsk)",
  "You've hit your Fable limit · resets Sep 14, 5am (Europe/Minsk)",
];

const CODEX_WORDINGS = [
  "You've hit your usage limit. Try again at 4:30pm (UTC)",
  "usage_limit_reached",
  "insufficient_quota",
];

const OTHER_VENDOR_WORDINGS = [
  "RESOURCE_EXHAUSTED",
  "Quota exceeded",
  "429 Too Many Requests",
  "Copilot quota exceeded",
  "premium requests exhausted",
  "insufficient balance",
  "credits exhausted",
];

/** The pay-as-you-go vendors, whose refusal is about money rather than a window. */
const API_VENDOR_WORDINGS = [
  "DeepSeek API error 402: Insufficient Balance",
  "OpenRouter error 402: Insufficient credits",
  "Moonshot error: exceeded balance",
  "Moonshot error: account balance is insufficient",
  "账户余额不足，请充值",
  'MiniMax error: {"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}',
  "Z.AI error: balance is insufficient",
  "You have used all available credits",
  "Your team reached its monthly spending limit",
  "HTTP 402 Payment Required",
  "billing hard limit reached",
  "You exceeded your current quota, please check your plan and billing details",
];

describe("detectUsageLimit", () => {
  test("matches the Google refusal and reads its reset instant", () => {
    const detection = detectUsageLimit(GOOGLE_QUOTA_REFUSAL, NOW);
    expect(detection?.resetsAt).toBe("2026-09-10T18:19:59.000Z");
    expect(detection?.message).toContain("Individual quota reached");
  });

  test("reads the vendor sentence out of a pretty-printed envelope", () => {
    const pretty = [
      "Cloud Code Assist API error (429): {",
      '  "error": {',
      '    "code": 429,',
      '    "message": "Individual quota reached. Resets in 6h36m11s.",',
      '    "status": "RESOURCE_EXHAUSTED"',
      "  }",
      "}",
    ].join("\n");
    const detection = detectUsageLimit(pretty, NOW);
    expect(detection?.message).toBe("Individual quota reached. Resets in 6h36m11s.");
    expect(detection?.resetsAt).toBe("2026-09-10T17:36:11.000Z");
  });

  test("matches the Codex refusal, which names no reset", () => {
    const detection = detectUsageLimit(CODEX_QUOTA_REFUSAL, NOW);
    expect(detection).not.toBeNull();
    expect(detection?.resetsAt).toBeNull();
    expect(detection?.message).toContain("usage_limit_reached");
  });

  test("matches every wording the vendors print", () => {
    for (const wording of [
      ...CLAUDE_WORDINGS,
      ...CLAUDE_NAMED_WINDOW_WORDINGS,
      ...CODEX_WORDINGS,
      ...OTHER_VENDOR_WORDINGS,
      ...API_VENDOR_WORDINGS,
    ]) {
      expect(detectUsageLimit(wording, NOW), wording).not.toBeNull();
    }
  });

  test("reads the kind out of a money refusal, and only out of a money refusal", () => {
    for (const wording of API_VENDOR_WORDINGS) {
      expect(limitKindFromText(wording), wording).toBe("balance");
    }
    for (const wording of [
      ...CLAUDE_WORDINGS,
      ...CLAUDE_NAMED_WINDOW_WORDINGS,
      ...CODEX_WORDINGS,
      GOOGLE_QUOTA_REFUSAL,
    ]) {
      expect(limitKindFromText(wording), wording).toBeNull();
    }
  });

  test("reads the reset out of the Claude wordings that carry one", () => {
    expect(detectUsageLimit(CLAUDE_WORDINGS[0] ?? "", NOW)?.resetsAt).toBe(
      "2026-09-10T14:00:00.000Z",
    );
    expect(detectUsageLimit(CLAUDE_WORDINGS[1] ?? "", NOW)?.resetsAt).toBe(
      "2026-09-10T15:00:00.000Z",
    );
  });

  test("reads the reset out of the notices that name the window", () => {
    expect(detectUsageLimit(CLAUDE_NAMED_WINDOW_WORDINGS[0] ?? "", NOW)?.resetsAt).toBe(
      "2026-09-11T04:00:00.000Z",
    );
    expect(detectUsageLimit(CLAUDE_NAMED_WINDOW_WORDINGS[1] ?? "", NOW)?.resetsAt).toBe(
      "2026-09-14T02:00:00.000Z",
    );
  });

  test("leaves Claude Code's spend refusals alone, which have no window to wait for", () => {
    expect(detectUsageLimit("You've hit your monthly spend limit.", NOW)).toBeNull();
    expect(detectUsageLimit("You've hit your usage credit limit.", NOW)).toBeNull();
  });

  test("ignores token and context-window caps that are not quota refusals", () => {
    expect(detectUsageLimit("The context window limit was exceeded.", NOW)).toBeNull();
    expect(detectUsageLimit("Maximum output tokens must be at most 8192.", NOW)).toBeNull();
    expect(detectUsageLimit("The prompt is too long for this model.", NOW)).toBeNull();
    expect(detectUsageLimit("You've hit your context limit.", NOW)).toBeNull();
    expect(detectUsageLimit("You've hit your token limit.", NOW)).toBeNull();
  });

  test("still matches a window notice that follows talk of the context window", () => {
    const reply = [
      "The context window was nearly full, so I compacted it.",
      "You've hit your session limit · resets 7am (Europe/Minsk)",
    ].join("\n");
    expect(detectUsageLimit(reply, NOW)?.message).toBe(
      "You've hit your session limit · resets 7am (Europe/Minsk)",
    );
  });
});

describe("bare numbers", () => {
  test("a 402 or 429 with no status label is not a refusal", () => {
    for (const text of AGENT_PROSE.slice(0, 4)) {
      expect(detectUsageLimit(text, NOW), text).toBeNull();
      expect(limitKindFromText(text), text).toBeNull();
    }
  });

  test("a labelled status code still is", () => {
    for (const text of ["HTTP 429", "status_code: 402", "API error (429): slow down", "code=402"]) {
      expect(detectUsageLimit(text, NOW), text).not.toBeNull();
    }
  });
});

describe("detectAssistantUsageLimit", () => {
  test("matches the notices Claude Code writes as an assistant message", () => {
    for (const wording of CLAUDE_WORDINGS) {
      expect(detectAssistantUsageLimit(wording, NOW), wording).not.toBeNull();
    }
    expect(detectAssistantUsageLimit(CLAUDE_WORDINGS[0] ?? "", NOW)?.resetsAt).toBe(
      "2026-09-10T14:00:00.000Z",
    );
  });

  test("matches a named-window notice written as an assistant message", () => {
    for (const wording of [
      "You've hit your session limit · resets 7am (Europe/Minsk)",
      "You've hit your weekly limit · resets Oct 20, 5am (Europe/Minsk)",
      "You've hit your Opus limit",
    ]) {
      expect(detectAssistantUsageLimit(wording, NOW), wording).not.toBeNull();
    }
  });

  test("leaves the agent's own prose alone", () => {
    for (const text of AGENT_PROSE) {
      expect(detectAssistantUsageLimit(text, NOW), text).toBeNull();
    }
  });

  test("leaves a long report alone even when it quotes a refusal", () => {
    const report = `Summary of the run.\n${"- step done\n".repeat(40)}The worker said: You've hit your limit.`;
    expect(detectAssistantUsageLimit(report, NOW)).toBeNull();
  });
});

describe("parseResetInstant", () => {
  test("reads a relative reset window", () => {
    expect(parseResetInstant("Resets in 2 hours 15 minutes", NOW)).toBe("2026-09-10T13:15:00.000Z");
    expect(parseResetInstant("retry after 45 seconds", NOW)).toBe("2026-09-10T11:00:45.000Z");
  });

  test("reads an ISO instant, and ignores one already past", () => {
    expect(parseResetInstant('"quotaResetTimeStamp":"2026-09-10T18:19:59Z"', NOW)).toBe(
      "2026-09-10T18:19:59.000Z",
    );
    expect(parseResetInstant("2026-09-10T09:00:00Z", NOW)).toBeNull();
  });

  test("reads a wall-clock reset, honouring a named zone", () => {
    expect(parseResetInstant("resets 3pm (Europe/London)", NOW)).toBe("2026-09-10T14:00:00.000Z");
    expect(parseResetInstant("Your limit will reset at 3pm (UTC)", NOW)).toBe(
      "2026-09-10T15:00:00.000Z",
    );
  });

  test("reads a dated reset, with or without the year", () => {
    expect(parseResetInstant("resets Sep 14, 5am (Europe/Minsk)", NOW)).toBe(
      "2026-09-14T02:00:00.000Z",
    );
    expect(parseResetInstant("resets Jan 3, 2027, 5:30pm (UTC)", NOW)).toBe(
      "2027-01-03T17:30:00.000Z",
    );
  });

  test("reads a dated reset at the offset in force on that date", () => {
    // London is on BST (UTC+1) at NOW and on GMT by Oct 30.
    expect(parseResetInstant("resets Oct 30, 9am (Europe/London)", NOW)).toBe(
      "2026-10-30T09:00:00.000Z",
    );
  });

  test("ignores a yearless date that has already passed", () => {
    expect(parseResetInstant("resets Sep 1, 5am (Europe/Minsk)", NOW)).toBeNull();
  });

  test("returns null when the text names no reset", () => {
    expect(parseResetInstant("The usage limit has been reached", NOW)).toBeNull();
  });
});

describe("resetUrlFor", () => {
  test("uses the agent provider's usage page", () => {
    expect(resetUrlFor("claude", null)).toBe("https://claude.ai/settings/usage");
    expect(resetUrlFor("codex", null)).toBe("https://chatgpt.com/codex/settings/usage");
  });

  test("prefers the model vendor's page when a harness runs many vendors", () => {
    expect(resetUrlFor("omp", "openai-codex/gpt-5.6")).toBe(
      "https://chatgpt.com/codex/settings/usage",
    );
    expect(resetUrlFor("omp", "google-antigravity/gemini-3.8-flash")).toBe(
      "https://antigravity.google/",
    );
  });

  test("has nothing to offer an unknown provider", () => {
    expect(resetUrlFor("mystery-harness", null)).toBeNull();
  });
});

describe("usageProviderIdFor", () => {
  test("maps a model vendor onto the usage-monitor preset", () => {
    expect(usageProviderIdFor("omp", "anthropic/claude-sonnet-4.5")).toBe("claude");
    expect(usageProviderIdFor("omp", "openai-codex/gpt-5.6")).toBe("codex");
    expect(usageProviderIdFor("omp", "google-antigravity/gemini-3.8-flash")).toBe("antigravity");
  });

  test("falls back to the agent provider", () => {
    expect(usageProviderIdFor("claude", null)).toBe("claude");
    expect(usageProviderIdFor("antigravity-acp", null)).toBe("antigravity");
  });
});

describe("the vendor table", () => {
  test("resolves every usage-monitor preset to a label and a kind", () => {
    const presetIds = listUsagePresetIds();
    expect(presetIds.length).toBeGreaterThan(30);
    for (const presetId of presetIds) {
      const vendor = VENDORS[presetId];
      expect(vendor, presetId).toBeDefined();
      expect(vendor?.label ?? "", presetId).not.toBe("");
      expect(["quota", "balance"], presetId).toContain(vendor?.kind);
    }
  });

  test("names where credit is bought for every balance vendor that publishes one", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["deepseek/deepseek-flash", "https://platform.deepseek.com/top_up"],
      ["moonshot/kimi-k3", "https://platform.kimi.ai/console/pay"],
      ["openrouter/anthropic/claude-sonnet-4", "https://openrouter.ai/credits"],
      ["anthropic/claude-sonnet-4.5", "https://console.anthropic.com/settings/billing"],
      ["openai/gpt-5.6", "https://platform.openai.com/settings/organization/billing/overview"],
      ["novita/llama-3.3-70b", "https://novita.ai/billing"],
      ["deepinfra/meta-llama/Meta-Llama-3.1-70B-Instruct", "https://deepinfra.com/dash/billing"],
      ["siliconflow/deepseek-ai/DeepSeek-V3", "https://cloud.siliconflow.com/bills"],
      ["siliconflow-cn/Qwen/Qwen3-235B", "https://cloud.siliconflow.cn/bills"],
      ["xai/grok-4", "https://console.x.ai/"],
      ["nano-gpt/gpt-oss-120b", "https://nano-gpt.com/balance"],
      ["poe/gpt-5.6", "https://poe.com/subscription_plans"],
      ["vercel/openai/gpt-5.6", "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway"],
    ];
    for (const [model, url] of cases) {
      expect(topUpUrlFor("omp", model), model).toBe(url);
      expect(limitKindFor("omp", model), model).toBe("balance");
    }
  });

  test("keeps a top-up page for a balance, never for a window", () => {
    for (const presetId of listUsagePresetIds()) {
      const vendor = VENDORS[presetId];
      if (vendor === undefined || vendor.topUpUrl === null) continue;
      expect(vendor.kind, presetId).toBe("balance");
      expect(vendor.usageUrl, presetId).not.toBeNull();
    }
  });

  test("offers no top-up where the window refills on its own", () => {
    for (const agentProvider of ["claude", "codex", "copilot", "cursor", "antigravity-acp"]) {
      expect(topUpUrlFor(agentProvider, null), agentProvider).toBeNull();
      expect(limitKindFor(agentProvider, null), agentProvider).toBe("quota");
    }
  });

  test("reads the vendor out of the model prefix a harness prints", () => {
    expect(usageProviderIdFor("omp", "deepseek/deepseek-flash")).toBe("deepseek");
    expect(usageProviderIdFor("omp", "moonshot/kimi-k3")).toBe("moonshot");
    expect(usageProviderIdFor("omp", "openrouter/anthropic/claude-sonnet-4")).toBe("openrouter");
    expect(usageProviderIdFor("omp", "opencode-go/glm-5")).toBe("opencode-go");
    expect(resetUrlFor("omp", "deepseek/deepseek-flash")).toBe(
      "https://platform.deepseek.com/usage",
    );
  });

  test("reads it out of a single-vendor harness when the model names none", () => {
    expect(vendorLabelFor("claude", null)).toBe("Claude");
    expect(usageProviderIdFor("codex", null)).toBe("codex");
    expect(usageProviderIdFor("copilot", null)).toBe("github-copilot");
    expect(vendorLabelFor("copilot", null)).toBe("GitHub Copilot");
    expect(limitKindFor("copilot", null)).toBe("quota");
  });

  test("says nothing about a vendor it does not know", () => {
    expect(vendorLabelFor("mystery-harness", "mystery/model")).toBeNull();
    expect(limitKindFor("mystery-harness", null)).toBeNull();
    expect(topUpUrlFor("mystery-harness", null)).toBeNull();
    expect(usageProviderIdFor("mystery-harness", null)).toBeNull();
  });
});
