import { describe, expect, test } from "vitest";
import type { CodexBankedResetDetails } from "../shared/codex-reset.shared";
import type { UsageProviderSnapshot } from "../shared/limits.shared";
import {
  BANKED_RESET_IDLE,
  bankedResetAvailableCount,
  bankedResetOutcomeMessage,
  bankedResetReducer,
} from "./codex-reset.client";

const DETAILS: CodexBankedResetDetails = {
  availableCount: 1,
  credit: {
    id: "RateLimitResetCredit_1",
    title: "One full reset",
    description: null,
    grantedAt: "2026-09-03T12:00:00Z",
    expiresAt: "2026-10-03T12:00:00Z",
  },
  redeemRequestId: "73b51db4-7cc9-4a3e-a0bf-924688484c4c",
};

function provider(supportsBankedReset: boolean, remaining: number): UsageProviderSnapshot {
  return {
    providerId: "codex",
    label: "Codex",
    description: null,
    unverified: false,
    live: false,
    supportsBankedReset,
    status: "ok",
    readings: [
      {
        kind: "balance",
        id: "banked-resets",
        label: "Banked resets",
        group: null,
        unit: "credits",
        remaining,
        total: null,
        percentRemaining: null,
        currency: null,
      },
    ],
    error: null,
    fetchedAt: "2026-09-08T10:00:00Z",
    notice: null,
    authRefreshCommand: null,
    display: {},
    icon: null,
  };
}

describe("Codex banked reset control", () => {
  test("requires both the Codex capability and an available reset", () => {
    expect(bankedResetAvailableCount(provider(true, 2))).toBe(2);
    expect(bankedResetAvailableCount(provider(false, 2))).toBe(0);
    expect(bankedResetAvailableCount(provider(true, 0))).toBe(0);
  });

  test("keeps the prepared id through confirmation and a failed attempt", () => {
    const confirming = bankedResetReducer(BANKED_RESET_IDLE, {
      type: "prepared",
      details: DETAILS,
    });
    const consuming = bankedResetReducer(confirming, { type: "consume" });
    const failed = bankedResetReducer(consuming, { type: "failed", message: "Network failed" });

    expect(confirming.status).toBe("confirming");
    expect(consuming.status).toBe("consuming");
    expect(failed).toMatchObject({
      status: "error",
      details: { redeemRequestId: DETAILS.redeemRequestId },
      message: "Network failed",
    });
  });

  test("reports every backend outcome without hiding a retained reset", () => {
    expect(bankedResetOutcomeMessage("reset", 1)).toBe(
      "Banked reset applied to your Codex limits.",
    );
    expect(bankedResetOutcomeMessage("nothing_to_reset", 0)).toBe(
      "Nothing needed resetting. Your banked reset remains available.",
    );
    expect(bankedResetOutcomeMessage("no_credit", 0)).toBe("No banked reset is available.");
    expect(bankedResetOutcomeMessage("already_redeemed", 0)).toBe(
      "This banked reset was already applied.",
    );
  });
});
