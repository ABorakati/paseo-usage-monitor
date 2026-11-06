import { describe, expect, test } from "vitest";
import { probeCodexUsage, type CodexProbeAdapters } from "./codex-probe.server";
import { UsageCredentialMissingError, UsageSourceError } from "./errors.server";
import type { UsageHttpRequest } from "./source.server";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MONTHLY_URL = (accountId: string) =>
  `https://chatgpt.com/backend-api/accounts/${accountId}/spend-controls/current-user/monthly-usage`;

/** A structurally valid JWT whose signature segment is deliberately junk. */
function chatGptJwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "none", typ: "JWT" });
  const payload = encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
  return `${header}.${payload}.not-a-signature`;
}

interface Fakes {
  adapters: CodexProbeAdapters;
  requests: UsageHttpRequest[];
}

function createAdapters(options: {
  credentials: Record<string, string>;
  usage: unknown;
  monthly?: unknown;
  monthlyError?: Error;
}): Fakes {
  const requests: UsageHttpRequest[] = [];
  return {
    requests,
    adapters: {
      async fetchJson(request) {
        requests.push(request);
        if (request.url === USAGE_URL) return options.usage;
        if (options.monthlyError !== undefined) throw options.monthlyError;
        return options.monthly ?? null;
      },
      resolve(name) {
        const value = options.credentials[name];
        if (value !== undefined) return value;
        throw new UsageCredentialMissingError(name, ["a test chain"]);
      },
    },
  };
}

const PERSONAL_USAGE = {
  rate_limit: { primary_window: { used_percent: 20, reset_at: 1_800_000_000 } },
  credits: { has_credits: true, unlimited: false, balance: "1250.5" },
};

const WORKSPACE_USAGE = {
  rate_limit: { primary_window: { used_percent: 20, reset_at: 1_800_000_000 } },
  credits: { has_credits: true, unlimited: false, balance: null },
};

const MONTHLY = {
  balance_unit: "credit",
  effective_monthly_limit: {
    limit: 8000,
    enforcement_mode: "HARD_CAP",
    limit_mode: "amount_credits",
  },
  current_month_usage: 204.36297607421875,
};

describe("codex probe", () => {
  test("reads a prepaid balance without asking the cap route", async () => {
    const token = chatGptJwt("account-from-jwt");
    const fake = createAdapters({
      credentials: { token, accountId: "a-different-account" },
      usage: PERSONAL_USAGE,
    });

    const document = await probeCodexUsage(fake.adapters);

    expect(document).toMatchObject({
      codex_credits: { remaining: 1250.5, used: null, total: null },
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      url: USAGE_URL,
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": "account-from-jwt" },
    });
  });

  // The reported defect: an education account reports has_credits with no
  // amount, while ChatGPT's own usage page shows thousands of credits left.
  test("fills a workspace's monthly allowance when the usage route withholds it", async () => {
    const token = chatGptJwt("account-from-jwt");
    const fake = createAdapters({
      credentials: { token, accountId: "account-from-jwt" },
      usage: WORKSPACE_USAGE,
      monthly: MONTHLY,
    });

    const document = await probeCodexUsage(fake.adapters);

    expect(document).toMatchObject({
      codex_credits: { remaining: null, used: 204.36297607421875, total: 8000 },
    });
    expect(fake.requests.map((request) => request.url)).toEqual([
      USAGE_URL,
      MONTHLY_URL("account-from-jwt"),
    ]);
  });

  test("keeps the usage document when the cap route refuses", async () => {
    const fake = createAdapters({
      credentials: { token: chatGptJwt("account-from-jwt") },
      usage: WORKSPACE_USAGE,
      monthlyError: new UsageSourceError("request failed with HTTP 403", { status: 403 }),
    });

    const document = await probeCodexUsage(fake.adapters);

    expect(document).toMatchObject({
      rate_limit: WORKSPACE_USAGE.rate_limit,
      codex_credits: { remaining: null, used: null, total: null },
    });
  });

  test("does not label a dollar-denominated spend control as credits", async () => {
    const fake = createAdapters({
      credentials: { token: chatGptJwt("account-from-jwt") },
      usage: WORKSPACE_USAGE,
      monthly: { ...MONTHLY, balance_unit: "usd" },
    });

    const document = await probeCodexUsage(fake.adapters);

    expect(document).toMatchObject({ codex_credits: { remaining: null, used: null, total: null } });
  });

  test("leaves unlimited credits without an invented ceiling", async () => {
    const fake = createAdapters({
      credentials: { token: chatGptJwt("account-from-jwt") },
      usage: { credits: { has_credits: true, unlimited: true, balance: null } },
    });

    const document = await probeCodexUsage(fake.adapters);

    expect(document).not.toHaveProperty("codex_credits");
    expect(fake.requests).toHaveLength(1);
  });

  test("falls back to the resolved account id when the token is not a JWT", async () => {
    const fake = createAdapters({
      credentials: { token: "not-a-jwt", accountId: "account-123" },
      usage: WORKSPACE_USAGE,
      monthly: MONTHLY,
    });

    await probeCodexUsage(fake.adapters);

    expect(fake.requests[1]?.url).toBe(MONTHLY_URL("account-123"));
    expect(fake.requests[0]?.headers).toMatchObject({ "ChatGPT-Account-Id": "account-123" });
  });

  test("still renders usage when no account id can be resolved", async () => {
    const fake = createAdapters({
      credentials: { token: "not-a-jwt" },
      usage: WORKSPACE_USAGE,
      monthly: MONTHLY,
    });

    const document = await probeCodexUsage(fake.adapters);

    expect(document).toMatchObject({
      rate_limit: WORKSPACE_USAGE.rate_limit,
      codex_credits: { remaining: null, used: null, total: null },
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers).not.toHaveProperty("ChatGPT-Account-Id");
  });

  test("a missing token stays a credential error, not a probe failure", async () => {
    const fake = createAdapters({ credentials: {}, usage: PERSONAL_USAGE });

    await expect(probeCodexUsage(fake.adapters)).rejects.toBeInstanceOf(
      UsageCredentialMissingError,
    );
  });
});
