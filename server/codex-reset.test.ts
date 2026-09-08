import { describe, expect, test, vi } from "vitest";
import { UsageProviderOverridesSchema } from "../shared/limits.shared";
import { createCodexBankedResetService } from "./codex-reset.server";
import { buildProviderRegistry } from "./registry.server";
import type { UsageHttpRequest } from "./source.server";

const HOME_DIR = "/home/tester";
const AUTH_PATH = `${HOME_DIR}/.codex/auth.json`;
const TOKEN = "codex-access-token";
const ACCOUNT_ID = "account-123";
const REDEEM_REQUEST_ID = "73b51db4-7cc9-4a3e-a0bf-924688484c4c";

function createService(options: {
  response: unknown;
  preset?: string;
  requests?: UsageHttpRequest[];
}) {
  const requests = options.requests ?? [];
  const entries = buildProviderRegistry(
    UsageProviderOverridesSchema.parse({ codex: { preset: options.preset ?? "codex" } }),
  );
  return createCodexBankedResetService({
    entries,
    source: {
      async fetchJson(request) {
        requests.push(request);
        return options.response;
      },
      runCommand: vi.fn(),
    },
    credentials: {
      env: {},
      homeDir: HOME_DIR,
      readTextFile(path) {
        return path === AUTH_PATH
          ? JSON.stringify({ tokens: { access_token: TOKEN, account_id: ACCOUNT_ID } })
          : null;
      },
      now: () => new Date("2026-09-08T10:00:00Z"),
    },
    createRequestId: () => REDEEM_REQUEST_ID,
  });
}

describe("Codex banked reset service", () => {
  test("reads an available reset and prepares one stable redemption id", async () => {
    const requests: UsageHttpRequest[] = [];
    const service = createService({
      requests,
      response: {
        available_count: 2,
        credits: [
          {
            id: "RateLimitResetCredit_1",
            reset_type: "codex_rate_limits",
            status: "available",
            granted_at: "2026-09-03T12:00:00Z",
            expires_at: "2026-10-03T12:00:00Z",
            title: "One full reset",
            description: "Refreshes both Codex windows",
          },
        ],
      },
    });

    await expect(service.read("codex")).resolves.toEqual({
      availableCount: 2,
      credit: {
        id: "RateLimitResetCredit_1",
        title: "One full reset",
        description: "Refreshes both Codex windows",
        grantedAt: "2026-09-03T12:00:00Z",
        expiresAt: "2026-10-03T12:00:00Z",
      },
      redeemRequestId: REDEEM_REQUEST_ID,
    });
    expect(requests).toEqual([
      {
        url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        method: "GET",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "ChatGPT-Account-Id": ACCOUNT_ID,
          Accept: "application/json",
        },
      },
    ]);
  });

  test("consumes the selected credit with the prepared redemption id", async () => {
    const requests: UsageHttpRequest[] = [];
    const service = createService({
      requests,
      response: { code: "reset", windows_reset: 1 },
    });

    await expect(
      service.consume({
        providerId: "codex",
        creditId: "RateLimitResetCredit_1",
        redeemRequestId: REDEEM_REQUEST_ID,
      }),
    ).resolves.toEqual({ outcome: "reset", windowsReset: 1 });
    expect(requests[0]).toMatchObject({
      url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "ChatGPT-Account-Id": ACCOUNT_ID,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: {
        credit_id: "RateLimitResetCredit_1",
        redeem_request_id: REDEEM_REQUEST_ID,
      },
    });
  });

  test("never exposes the mutation for a non-Codex preset", async () => {
    const requests: UsageHttpRequest[] = [];
    const service = createService({ requests, preset: "claude", response: {} });

    await expect(service.read("codex")).rejects.toThrow(
      'Usage provider "codex" does not support banked resets',
    );
    expect(requests).toEqual([]);
  });

  test("fails closed when Codex changes the consume response", async () => {
    const service = createService({ response: { success: true } });

    await expect(
      service.consume({
        providerId: "codex",
        creditId: null,
        redeemRequestId: REDEEM_REQUEST_ID,
      }),
    ).rejects.toThrow("Codex returned an invalid banked reset result");
  });
});
