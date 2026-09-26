import { describe, expect, test } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { LimitAlert } from "../shared/limit-alerts.shared";
import {
  alertPollInterval,
  calloutActions,
  claimAlertToast,
  handoffTargetLabel,
  LIMIT_ALERT_FALLBACK_LABEL,
  LIMIT_ALERT_POLL_MS,
  LIMIT_ALERT_UNKNOWN_PROVIDER,
  limitAlertTimelineData,
  limitAlertToastMessage,
  matchLimitAlert,
  parseResumeAt,
  splitHandoffValue,
} from "./limit-alerts.client";

/** Claude Code's own wording, which names a wall-clock reset in a named zone. */
const CLAUDE_REFUSAL = "You've hit your limit · resets 3pm (Europe/London)";

/** A fixed instant so the parsed reset does not depend on when the suite runs. */
const ANCHOR = new Date("2026-09-10T12:00:00.000Z");

/** 3pm in Europe/London on 2026-09-10 is 14:00Z, and the anchor is 12:00Z. */
const CLAUDE_RESET_ISO = "2026-09-10T14:00:00.000Z";

function errorItem(message: string): AgentTimelineItem {
  return { type: "error", message };
}

function alert(overrides: Partial<LimitAlert> = {}): LimitAlert {
  return {
    id: "alert-1",
    agentId: "agent-1",
    workspaceId: null,
    agentProvider: "claude",
    providerLabel: "Claude",
    usageProviderId: "claude",
    message: CLAUDE_REFUSAL,
    detectedAt: "2026-09-10T12:00:00.000Z",
    resetsAt: CLAUDE_RESET_ISO,
    resetUrl: "https://claude.ai/settings/usage",
    lastUserMessage: null,
    status: "open",
    resume: null,
    handoff: null,
    ...overrides,
  };
}

describe("usage limit detection", () => {
  test("replaces a finished error that names a limit", () => {
    expect(limitAlertTimelineData(errorItem(CLAUDE_REFUSAL), "complete", ANCHOR)).toEqual({
      agentProvider: LIMIT_ALERT_UNKNOWN_PROVIDER,
      providerLabel: LIMIT_ALERT_FALLBACK_LABEL,
      message: CLAUDE_REFUSAL,
      resetsAt: CLAUDE_RESET_ISO,
      // The transformer has no agent context, so the renderer resolves the link.
      resetUrl: null,
    });
  });

  test("leaves a finished error that names no limit to the host", () => {
    expect(
      limitAlertTimelineData(errorItem("The tool exited with code 1"), "complete", ANCHOR),
    ).toBeNull();
  });

  test("leaves a streaming item alone, because its sentence is unfinished", () => {
    expect(limitAlertTimelineData(errorItem(CLAUDE_REFUSAL), "streaming", ANCHOR)).toBeNull();
  });

  test("classifies the assistant message Claude Code writes instead of a failed turn", () => {
    const item: AgentTimelineItem = { type: "assistant_message", text: CLAUDE_REFUSAL };
    const data = limitAlertTimelineData(item, "complete", ANCHOR);
    expect(data?.message).toBe(CLAUDE_REFUSAL);
    expect(data?.resetsAt).toBe(CLAUDE_RESET_ISO);
  });

  test("leaves a context-window complaint alone even though it reads like a limit", () => {
    const item = errorItem("Rate limit reached on the context window");
    expect(limitAlertTimelineData(item, "complete", ANCHOR)).toBeNull();
  });

  test("stamps the balance kind when the wording itself names money", () => {
    const item = errorItem("DeepSeek API error 402: Insufficient Balance");
    const data = limitAlertTimelineData(item, "complete", ANCHOR);
    expect(data?.limitKind).toBe("balance");
    // No URL is readable from a refusal, so the daemon's alert supplies it.
    expect(data?.topUpUrl).toBeUndefined();
  });

  test("leaves the kind to the daemon when the wording names only a window", () => {
    const data = limitAlertTimelineData(errorItem(CLAUDE_REFUSAL), "complete", ANCHOR);
    expect(data?.limitKind).toBeUndefined();
  });
});

describe("callout actions", () => {
  const USAGE_URL = "https://platform.deepseek.com/usage";
  const TOP_UP_URL = "https://platform.deepseek.com/top_up";
  const WINDOW_URL = "https://claude.ai/settings/usage";

  test("offers a top-up instead of a resume when the balance is spent", () => {
    expect(
      calloutActions({
        limitKind: "balance",
        topUpUrl: TOP_UP_URL,
        usageUrl: USAGE_URL,
        status: "open",
      }),
    ).toEqual({ topUp: true, usage: true, resume: false, handoff: true, dismiss: true });
  });

  test("keeps the resume affordance for a window that resets", () => {
    expect(
      calloutActions({ limitKind: "quota", topUpUrl: null, usageUrl: WINDOW_URL, status: "open" }),
    ).toEqual({ topUp: false, usage: true, resume: true, handoff: true, dismiss: true });
  });

  test("keeps the resume affordance while the daemon has not answered yet", () => {
    expect(
      calloutActions({ limitKind: null, topUpUrl: null, usageUrl: null, status: "open" }),
    ).toEqual({ topUp: false, usage: false, resume: true, handoff: true, dismiss: true });
  });

  test("offers no top-up when the vendor publishes no page to buy credit on", () => {
    expect(
      calloutActions({ limitKind: "balance", topUpUrl: null, usageUrl: null, status: "open" }),
    ).toEqual({ topUp: false, usage: false, resume: false, handoff: true, dismiss: true });
  });

  test("shows one button when the usage page is also where credit is bought", () => {
    expect(
      calloutActions({
        limitKind: "balance",
        topUpUrl: USAGE_URL,
        usageUrl: USAGE_URL,
        status: "open",
      }),
    ).toEqual({ topUp: true, usage: false, resume: false, handoff: true, dismiss: true });
  });

  test("drops every action but the usage page once the alert is settled", () => {
    for (const status of ["resumed", "handed_off", "dismissed"] as const) {
      expect(
        calloutActions({ limitKind: "quota", topUpUrl: null, usageUrl: WINDOW_URL, status }),
      ).toEqual({
        topUp: false,
        usage: true,
        resume: false,
        handoff: false,
        dismiss: false,
      });
    }
  });
});

describe("limit alert matching", () => {
  const older = alert({
    id: "older",
    message: "first wording",
    detectedAt: "2026-09-10T10:00:00.000Z",
  });
  const newer = alert({
    id: "newer",
    message: "second wording",
    detectedAt: "2026-09-10T11:00:00.000Z",
  });

  test("prefers the alert whose wording is this item's, whatever its age", () => {
    expect(matchLimitAlert([newer, older], "first wording")?.id).toBe("older");
  });

  test("falls back to the agent's newest alert when the wording is not recorded", () => {
    expect(matchLimitAlert([older, newer], "unrecorded wording")?.id).toBe("newer");
  });

  test("has nothing to match for an agent with no alerts", () => {
    expect(matchLimitAlert(undefined, "any wording")).toBeNull();
    expect(matchLimitAlert([], "any wording")).toBeNull();
  });
});

describe("limit alert polling", () => {
  test("polls while an alert still wants an answer", () => {
    expect(alertPollInterval([alert({ status: "open" })])).toBe(LIMIT_ALERT_POLL_MS);
    expect(alertPollInterval([alert({ status: "resume_scheduled" })])).toBe(LIMIT_ALERT_POLL_MS);
  });

  test("stops once every alert is settled, or none is known yet", () => {
    expect(alertPollInterval([alert({ status: "handed_off" })])).toBe(false);
    expect(alertPollInterval([alert({ status: "resumed" })])).toBe(false);
    expect(alertPollInterval([alert({ status: "dismissed" })])).toBe(false);
    expect(alertPollInterval(undefined)).toBe(false);
  });
});

describe("limit alert toast bookkeeping", () => {
  test("announces each alert once per id", () => {
    const seen = new Set<string>();
    expect(claimAlertToast("alert-a", seen)).toBe(true);
    expect(claimAlertToast("alert-a", seen)).toBe(false);
    expect(claimAlertToast("alert-b", seen)).toBe(true);
  });

  test("remembers through the module's own set, which survives a remount", () => {
    expect(claimAlertToast("module-own-id")).toBe(true);
    expect(claimAlertToast("module-own-id")).toBe(false);
  });

  test("says when the quota returns", () => {
    expect(limitAlertToastMessage("Claude", CLAUDE_RESET_ISO, ANCHOR.getTime())).toBe(
      "Claude usage limit reached, resets in 2h",
    );
    expect(limitAlertToastMessage("Claude", null, ANCHOR.getTime())).toBe(
      "Claude usage limit reached",
    );
  });

  test("says a balance is exhausted, with no reset to promise", () => {
    expect(limitAlertToastMessage("DeepSeek", null, ANCHOR.getTime(), "balance")).toBe(
      "DeepSeek balance exhausted",
    );
    expect(limitAlertToastMessage("DeepSeek", CLAUDE_RESET_ISO, ANCHOR.getTime(), "balance")).toBe(
      "DeepSeek balance exhausted",
    );
  });
});

describe("resume time input", () => {
  const noon = new Date(2026, 8, 10, 12, 0, 0, 0);

  test("takes a bare HH:MM as the next occurrence of that local time", () => {
    const laterToday = new Date(parseResumeAt("15:00", noon) ?? "");
    expect(laterToday.getHours()).toBe(15);
    expect(laterToday.getMinutes()).toBe(0);
    expect(laterToday.getDate()).toBe(noon.getDate());

    const tomorrow = new Date(parseResumeAt("10:00", noon) ?? "");
    expect(tomorrow.getHours()).toBe(10);
    expect(tomorrow.getDate()).toBe(noon.getDate() + 1);
  });

  test("takes an ISO instant", () => {
    expect(parseResumeAt("2026-09-10T18:30:00.000Z", ANCHOR)).toBe("2026-09-10T18:30:00.000Z");
  });

  test("rejects text that names no usable time", () => {
    expect(parseResumeAt("", noon)).toBeNull();
    expect(parseResumeAt("   ", noon)).toBeNull();
    expect(parseResumeAt("soonish", noon)).toBeNull();
    expect(parseResumeAt("25:00", noon)).toBeNull();
    expect(parseResumeAt("12:75", noon)).toBeNull();
  });
});

describe("handoff target values", () => {
  test("splits at the first slash, so a nested model id survives", () => {
    expect(splitHandoffValue("omp/openai-codex/gpt-5.6")).toEqual({
      provider: "omp",
      modelId: "openai-codex/gpt-5.6",
    });
    expect(splitHandoffValue("claude/claude-sonnet-4-5")).toEqual({
      provider: "claude",
      modelId: "claude-sonnet-4-5",
    });
  });

  test("rejects a value that cannot name a model", () => {
    expect(splitHandoffValue(null)).toBeNull();
    expect(splitHandoffValue(undefined)).toBeNull();
    expect(splitHandoffValue("")).toBeNull();
    expect(splitHandoffValue("claude")).toBeNull();
    expect(splitHandoffValue("/model")).toBeNull();
    expect(splitHandoffValue("provider/")).toBeNull();
  });

  test("names a handed-off agent's provider, not the whole model path", () => {
    expect(handoffTargetLabel("omp/openai-codex/gpt-5.6")).toBe("Oh My Pi");
    expect(handoffTargetLabel("claude/claude-sonnet-4-5")).toBe("Claude");
    expect(handoffTargetLabel("antigravity-acp/gemini-3.8-flash")).toBe("Antigravity");
    expect(handoffTargetLabel(null)).toBeNull();
  });
});
