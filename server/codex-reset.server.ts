import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createCredentialResolver, type CredentialAdapters } from "./credentials.server";
import { UsageConfigError, UsageSourceError } from "./errors.server";
import type { UsageProviderEntry } from "./registry.server";
import type { UsageHttpRequest, UsageSourceAdapters } from "./source.server";
import type {
  CodexBankedResetDetails,
  CodexBankedResetOutcome,
} from "../shared/codex-reset.shared";

const CODEX_BACKEND = "https://chatgpt.com/backend-api";
const RESET_CREDITS_URL = `${CODEX_BACKEND}/wham/rate-limit-reset-credits`;
const CONSUME_RESET_URL = `${RESET_CREDITS_URL}/consume`;

const BackendCreditSchema = z.object({
  id: z.string().min(1),
  reset_type: z.string(),
  status: z.string(),
  granted_at: z.string(),
  expires_at: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

const BackendCreditsSchema = z.object({
  credits: z.array(BackendCreditSchema),
  available_count: z.number().int().nonnegative(),
});

const BackendConsumeSchema = z.object({
  code: z.enum(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
  windows_reset: z.number().int().nonnegative().default(0),
});

export interface CodexBankedResetService {
  read(providerId: string): Promise<CodexBankedResetDetails>;
  consume(input: {
    providerId: string;
    creditId: string | null;
    redeemRequestId: string;
  }): Promise<{ outcome: CodexBankedResetOutcome; windowsReset: number }>;
}

export interface CodexBankedResetServiceInput {
  entries: readonly UsageProviderEntry[];
  source: UsageSourceAdapters;
  credentials: CredentialAdapters;
  createRequestId?: () => string;
}

export function createCodexBankedResetService(
  input: CodexBankedResetServiceInput,
): CodexBankedResetService {
  const createRequestId = input.createRequestId ?? randomUUID;

  function requestFor(
    providerId: string,
    request: Omit<UsageHttpRequest, "headers">,
  ): UsageHttpRequest {
    const entry = input.entries.find((candidate) => candidate.id === providerId);
    if (!entry?.provider) {
      throw new UsageConfigError(`Usage provider "${providerId}" is not configured`);
    }
    if (!entry.provider.supportsBankedReset) {
      throw new UsageConfigError(`Usage provider "${providerId}" does not support banked resets`);
    }
    const resolver = createCredentialResolver(entry.provider.credentials, input.credentials);
    return {
      ...request,
      headers: {
        Authorization: `Bearer ${resolver.resolve("token")}`,
        "ChatGPT-Account-Id": resolver.resolve("accountId"),
        Accept: "application/json",
        ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    };
  }

  async function read(providerId: string): Promise<CodexBankedResetDetails> {
    const document = await input.source.fetchJson(
      requestFor(providerId, { url: RESET_CREDITS_URL, method: "GET" }),
    );
    const parsed = BackendCreditsSchema.safeParse(document);
    if (!parsed.success) {
      throw new UsageSourceError("Codex returned invalid banked reset details");
    }
    const credit = parsed.data.credits.find(
      (candidate) =>
        candidate.status === "available" && candidate.reset_type === "codex_rate_limits",
    );
    return {
      availableCount: parsed.data.available_count,
      credit:
        credit === undefined
          ? null
          : {
              id: credit.id,
              title: credit.title ?? null,
              description: credit.description ?? null,
              grantedAt: credit.granted_at,
              expiresAt: credit.expires_at ?? null,
            },
      redeemRequestId: parsed.data.available_count > 0 ? createRequestId() : null,
    };
  }

  async function consume({
    providerId,
    creditId,
    redeemRequestId,
  }: {
    providerId: string;
    creditId: string | null;
    redeemRequestId: string;
  }): Promise<{ outcome: CodexBankedResetOutcome; windowsReset: number }> {
    const body: Record<string, string> = { redeem_request_id: redeemRequestId };
    if (creditId !== null) body.credit_id = creditId;
    const document = await input.source.fetchJson(
      requestFor(providerId, {
        url: CONSUME_RESET_URL,
        method: "POST",
        body,
      }),
    );
    const parsed = BackendConsumeSchema.safeParse(document);
    if (!parsed.success) {
      throw new UsageSourceError("Codex returned an invalid banked reset result");
    }
    return { outcome: parsed.data.code, windowsReset: parsed.data.windows_reset };
  }

  return { read, consume };
}
