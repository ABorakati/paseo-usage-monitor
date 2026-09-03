import { describe, expect, test } from "vitest";
import {
  createCredentialResolver,
  expandPath,
  type CredentialAdapters,
} from "./credentials.server";
import { UsageCredentialMissingError, UsageInterpolationError } from "./errors.server";
import type { UsageCredentials, UsageCredentialSource } from "./limits.shared";

const HOME_DIR = "/home/tester";

const CLAUDE_CREDENTIALS_PATH = `${HOME_DIR}/.claude/.credentials.json`;

const CODEX_CREDENTIALS_PATH = `${HOME_DIR}/.codex/auth.json`;

const NOW = new Date("2026-08-29T12:00:00.000Z");

const NOW_MS = NOW.getTime();

const HOUR_MS = 60 * 60 * 1000;

const ACCESS_TOKEN = "sk-ant-oat01-abcdefgh";

interface StubAdapters extends CredentialAdapters {
  reads: string[];
}

interface StubAdaptersInput {
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string | undefined>;
  now?: Date;
}

function createStubAdapters(input: StubAdaptersInput): StubAdapters {
  const files = input.files ?? {};
  const reads: string[] = [];
  return {
    env: input.env ?? {},
    homeDir: HOME_DIR,
    reads,
    now(): Date {
      return input.now ?? NOW;
    },
    readTextFile(path: string): string | null {
      reads.push(path);
      return files[path] ?? null;
    },
  };
}

function captureError<T extends Error>(expected: new (...args: never[]) => T, run: () => void): T {
  try {
    run();
  } catch (error) {
    if (error instanceof expected) return error;
    throw error;
  }
  throw new Error(`the call under test did not throw ${expected.name}`);
}

const CLAUDE_FILE_SOURCE: UsageCredentialSource = {
  kind: "jsonFile",
  file: "~/.claude/.credentials.json",
  path: "claudeAiOauth.accessToken",
};

const CHAINED_CREDENTIALS: UsageCredentials = {
  CLAUDE_TOKEN: [CLAUDE_FILE_SOURCE, { kind: "env", variable: "ANTHROPIC_API_KEY" }],
};

describe("expandPath", () => {
  test("expands a bare tilde to the home directory", () => {
    expect(expandPath("~", createStubAdapters({}))).toBe(HOME_DIR);
  });

  test("expands a leading tilde segment", () => {
    expect(expandPath("~/.codex/auth.json", createStubAdapters({}))).toBe(
      `${HOME_DIR}/.codex/auth.json`,
    );
  });

  test("leaves a tilde inside the path alone", () => {
    expect(expandPath("/srv/~backup/auth.json", createStubAdapters({}))).toBe(
      "/srv/~backup/auth.json",
    );
  });

  test("expands an environment variable", () => {
    const adapters = createStubAdapters({ env: { XDG_CONFIG_HOME: "/cfg" } });
    expect(expandPath("${XDG_CONFIG_HOME}/codex/auth.json", adapters)).toBe("/cfg/codex/auth.json");
  });

  test("names the unset variable instead of expanding it to nothing", () => {
    const error = captureError(UsageInterpolationError, () => {
      expandPath("${XDG_CONFIG_HOME}/codex/auth.json", createStubAdapters({}));
    });
    expect(error.variable).toBe("XDG_CONFIG_HOME");
    expect(error.message).toContain("XDG_CONFIG_HOME");
  });

  test("treats an empty environment variable as unset", () => {
    const adapters = createStubAdapters({ env: { CODEX_HOME: "" } });
    const error = captureError(UsageInterpolationError, () => {
      expandPath("${CODEX_HOME}/auth.json", adapters);
    });
    expect(error.variable).toBe("CODEX_HOME");
  });
});

describe("createCredentialResolver", () => {
  test("resolves an environment credential", () => {
    const adapters = createStubAdapters({ env: { KIMI_TOKEN: "kimi-value" } });
    const credentials: UsageCredentials = {
      KIMI_TOKEN: [{ kind: "env", variable: "KIMI_TOKEN" }],
    };
    expect(createCredentialResolver(credentials, adapters).resolve("KIMI_TOKEN")).toBe(
      "kimi-value",
    );
  });

  test("reads a nested json path out of a credential file", () => {
    const adapters = createStubAdapters({
      files: {
        [CLAUDE_CREDENTIALS_PATH]: JSON.stringify({
          claudeAiOauth: { accessToken: "oauth-value", expiresAt: 1_772_366_400_000 },
        }),
      },
    });
    const resolver = createCredentialResolver(CHAINED_CREDENTIALS, adapters);
    expect(resolver.resolve("CLAUDE_TOKEN")).toBe("oauth-value");
    expect(adapters.reads).toEqual([CLAUDE_CREDENTIALS_PATH]);
  });

  test("falls back to the next source when the credential file is missing", () => {
    const adapters = createStubAdapters({ env: { ANTHROPIC_API_KEY: "env-value" } });
    const resolver = createCredentialResolver(CHAINED_CREDENTIALS, adapters);
    expect(resolver.resolve("CLAUDE_TOKEN")).toBe("env-value");
    expect(adapters.reads).toEqual([CLAUDE_CREDENTIALS_PATH]);
  });

  test("skips a credential file whose json path is absent", () => {
    const adapters = createStubAdapters({
      env: { ANTHROPIC_API_KEY: "env-value" },
      files: { [CLAUDE_CREDENTIALS_PATH]: JSON.stringify({ claudeAiOauth: {} }) },
    });
    expect(createCredentialResolver(CHAINED_CREDENTIALS, adapters).resolve("CLAUDE_TOKEN")).toBe(
      "env-value",
    );
  });

  test("skips a credential file that does not contain json", () => {
    const adapters = createStubAdapters({
      env: { ANTHROPIC_API_KEY: "env-value" },
      files: { [CLAUDE_CREDENTIALS_PATH]: "not json at all" },
    });
    expect(createCredentialResolver(CHAINED_CREDENTIALS, adapters).resolve("CLAUDE_TOKEN")).toBe(
      "env-value",
    );
  });

  test("skips a source whose file path references an unset variable", () => {
    const adapters = createStubAdapters({ env: { ANTHROPIC_API_KEY: "env-value" } });
    const credentials: UsageCredentials = {
      CLAUDE_TOKEN: [
        { kind: "jsonFile", file: "${CODEX_HOME}/auth.json", path: "tokens.access_token" },
        { kind: "env", variable: "ANTHROPIC_API_KEY" },
      ],
    };
    expect(createCredentialResolver(credentials, adapters).resolve("CLAUDE_TOKEN")).toBe(
      "env-value",
    );
    expect(adapters.reads).toEqual([]);
  });

  test("treats a blank environment variable as a failed source", () => {
    const adapters = createStubAdapters({ env: { KIMI_TOKEN: "   ", FALLBACK: "fallback-value" } });
    const credentials: UsageCredentials = {
      KIMI_TOKEN: [
        { kind: "env", variable: "KIMI_TOKEN" },
        { kind: "env", variable: "FALLBACK" },
      ],
    };
    expect(createCredentialResolver(credentials, adapters).resolve("KIMI_TOKEN")).toBe(
      "fallback-value",
    );
  });

  test("trims the trailing newline a shell export leaves on an environment token", () => {
    const adapters = createStubAdapters({ env: { KIMI_TOKEN: "kimi-value\n" } });
    const credentials: UsageCredentials = {
      KIMI_TOKEN: [{ kind: "env", variable: "KIMI_TOKEN" }],
    };
    expect(createCredentialResolver(credentials, adapters).resolve("KIMI_TOKEN")).toBe(
      "kimi-value",
    );
  });

  test("trims whitespace surrounding a token read out of a credential file", () => {
    const adapters = createStubAdapters({
      files: {
        [CLAUDE_CREDENTIALS_PATH]: JSON.stringify({
          claudeAiOauth: { accessToken: " oauth-value\n" },
        }),
      },
    });
    expect(createCredentialResolver(CHAINED_CREDENTIALS, adapters).resolve("CLAUDE_TOKEN")).toBe(
      "oauth-value",
    );
  });

  test("reads a credential once and reuses the resolved value", () => {
    const adapters = createStubAdapters({
      files: {
        [CLAUDE_CREDENTIALS_PATH]: JSON.stringify({ claudeAiOauth: { accessToken: "oauth" } }),
      },
    });
    const resolver = createCredentialResolver(CHAINED_CREDENTIALS, adapters);
    expect(resolver.resolve("CLAUDE_TOKEN")).toBe("oauth");
    expect(resolver.resolve("CLAUDE_TOKEN")).toBe("oauth");
    expect(adapters.reads).toEqual([CLAUDE_CREDENTIALS_PATH]);
  });

  test("lists every source tried and no resolved value when the chain fails", () => {
    const adapters = createStubAdapters({
      files: {
        [CLAUDE_CREDENTIALS_PATH]: JSON.stringify({
          claudeAiOauth: { refreshToken: "sk-secret-refresh" },
        }),
      },
    });
    const credentials: UsageCredentials = {
      CLAUDE_TOKEN: [{ kind: "env", variable: "KIMI_TOKEN" }, CLAUDE_FILE_SOURCE],
    };
    const resolver = createCredentialResolver(credentials, adapters);
    const error = captureError(UsageCredentialMissingError, () => {
      resolver.resolve("CLAUDE_TOKEN");
    });
    expect(error.credentialName).toBe("CLAUDE_TOKEN");
    expect(error.tried).toEqual([
      "env KIMI_TOKEN",
      "file ~/.claude/.credentials.json#claudeAiOauth.accessToken",
    ]);
    expect(error.message).toContain("env KIMI_TOKEN");
    expect(error.message).toContain("file ~/.claude/.credentials.json#claudeAiOauth.accessToken");
    expect(error.message).not.toContain("sk-secret-refresh");
  });

  test("reports an undeclared credential instead of reading the environment", () => {
    const adapters = createStubAdapters({ env: { CLAUDE_TOKEN: "env-value" } });
    const error = captureError(UsageCredentialMissingError, () => {
      createCredentialResolver({}, adapters).resolve("CLAUDE_TOKEN");
    });
    expect(error.tried).toEqual([]);
    expect(error.message).toContain("CLAUDE_TOKEN");
  });
});

describe("a place that exists and holds no token", () => {
  test("reads as signed out rather than as a missing file", () => {
    const adapters = createStubAdapters({
      files: {
        [`${HOME_DIR}/.claude/.credentials.json`]: JSON.stringify({
          claudeAiOauth: { accessToken: "   " },
        }),
      },
    });
    const error = captureError(UsageCredentialMissingError, () => {
      createCredentialResolver({ TOKEN: [CLAUDE_FILE_SOURCE] }, adapters).resolve("TOKEN");
    });

    expect(error.message).toContain("(no token stored)");
  });

  test("says nothing extra when the file is genuinely absent", () => {
    const adapters = createStubAdapters({});
    const error = captureError(UsageCredentialMissingError, () => {
      createCredentialResolver({ TOKEN: [CLAUDE_FILE_SOURCE] }, adapters).resolve("TOKEN");
    });

    expect(error.message).not.toContain("no token stored");
  });

  test("an exported but blank variable reads the same way", () => {
    const adapters = createStubAdapters({ env: { ANTHROPIC_API_KEY: "" } });
    const error = captureError(UsageCredentialMissingError, () => {
      createCredentialResolver(
        { TOKEN: [{ kind: "env", variable: "ANTHROPIC_API_KEY" }] },
        adapters,
      ).resolve("TOKEN");
    });

    expect(error.message).toContain("env ANTHROPIC_API_KEY (no token stored)");
  });
});

describe("a source whose variable is not set", () => {
  const TEMPLATED_SOURCE: UsageCredentialSource = {
    kind: "jsonFile",
    file: "${CLAUDE_CONFIG_DIR}/.credentials.json",
    path: "claudeAiOauth.accessToken",
  };

  test("names the variable rather than a path that was never built", () => {
    const adapters = createStubAdapters({});
    const error = captureError(UsageCredentialMissingError, () => {
      createCredentialResolver({ TOKEN: [TEMPLATED_SOURCE] }, adapters).resolve("TOKEN");
    });

    // "file X does not resolve" would send the user looking for a file. The
    // variable is unset, so that path never existed to be missing.
    expect(error.message).toContain("(CLAUDE_CONFIG_DIR is not set)");
  });

  test("is distinguished from a file that is genuinely absent", () => {
    const adapters = createStubAdapters({ env: { CLAUDE_CONFIG_DIR: "/cfg" } });
    const error = captureError(UsageCredentialMissingError, () => {
      createCredentialResolver({ TOKEN: [TEMPLATED_SOURCE] }, adapters).resolve("TOKEN");
    });

    expect(error.message).not.toContain("is not set");
  });

  test("keeps walking the chain to a source whose path is real", () => {
    const adapters = createStubAdapters({
      files: { [`${HOME_DIR}/.claude/.credentials.json`]: claudeCredentialsFile(undefined) },
    });

    const resolved = createCredentialResolver(
      { TOKEN: [TEMPLATED_SOURCE, CLAUDE_FILE_SOURCE] },
      adapters,
    ).resolve("TOKEN");

    expect(resolved).toBe(ACCESS_TOKEN);
  });
});

const CLAUDE_EXPIRING_SOURCE: UsageCredentialSource = {
  kind: "jsonFile",
  file: "~/.claude/.credentials.json",
  path: "claudeAiOauth.accessToken",
  expiresAtPath: "claudeAiOauth.expiresAt",
};

const CLAUDE_EXPIRING_DESCRIPTION = "file ~/.claude/.credentials.json#claudeAiOauth.accessToken";

function claudeCredentialsFile(expiresAt: unknown): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: ACCESS_TOKEN, expiresAt } });
}

function describeExpiredClaudeSource(expiresAt: unknown): string {
  const adapters = createStubAdapters({
    files: { [CLAUDE_CREDENTIALS_PATH]: claudeCredentialsFile(expiresAt) },
  });
  const error = captureError(UsageCredentialMissingError, () => {
    createCredentialResolver({ CLAUDE_TOKEN: [CLAUDE_EXPIRING_SOURCE] }, adapters).resolve(
      "CLAUDE_TOKEN",
    );
  });
  expect(error.message).not.toContain(ACCESS_TOKEN);
  return error.tried[0] ?? "";
}

describe("createCredentialResolver credential expiry", () => {
  test("resolves a credential whose expiry is still ahead", () => {
    const adapters = createStubAdapters({
      files: { [CLAUDE_CREDENTIALS_PATH]: claudeCredentialsFile(NOW_MS + HOUR_MS) },
    });
    expect(
      createCredentialResolver({ CLAUDE_TOKEN: [CLAUDE_EXPIRING_SOURCE] }, adapters).resolve(
        "CLAUDE_TOKEN",
      ),
    ).toBe(ACCESS_TOKEN);
  });

  test("skips an expired source so the next one in the chain wins", () => {
    const adapters = createStubAdapters({
      env: { ANTHROPIC_API_KEY: "env-value" },
      files: { [CLAUDE_CREDENTIALS_PATH]: claudeCredentialsFile(NOW_MS - 34 * HOUR_MS) },
    });
    const credentials: UsageCredentials = {
      CLAUDE_TOKEN: [CLAUDE_EXPIRING_SOURCE, { kind: "env", variable: "ANTHROPIC_API_KEY" }],
    };
    expect(createCredentialResolver(credentials, adapters).resolve("CLAUDE_TOKEN")).toBe(
      "env-value",
    );
    expect(adapters.reads).toEqual([CLAUDE_CREDENTIALS_PATH]);
  });

  test("describes every source as expired when the whole chain has gone stale", () => {
    const adapters = createStubAdapters({
      files: {
        [CLAUDE_CREDENTIALS_PATH]: claudeCredentialsFile(NOW_MS - 34 * HOUR_MS),
        [CODEX_CREDENTIALS_PATH]: JSON.stringify({
          tokens: { access_token: "codex-token-value", expires_at: NOW_MS - 80 * HOUR_MS },
        }),
      },
    });
    const credentials: UsageCredentials = {
      CLAUDE_TOKEN: [
        CLAUDE_EXPIRING_SOURCE,
        {
          kind: "jsonFile",
          file: "~/.codex/auth.json",
          path: "tokens.access_token",
          expiresAtPath: "tokens.expires_at",
        },
      ],
    };
    const error = captureError(UsageCredentialMissingError, () => {
      createCredentialResolver(credentials, adapters).resolve("CLAUDE_TOKEN");
    });
    expect(error.tried).toEqual([
      `${CLAUDE_EXPIRING_DESCRIPTION} (expired 1d ago)`,
      "file ~/.codex/auth.json#tokens.access_token (expired 3d ago)",
    ]);
    expect(error.message).toContain("(expired 1d ago)");
    expect(error.message).not.toContain(ACCESS_TOKEN);
    expect(error.message).not.toContain("codex-token-value");
  });

  test("reads an epoch-milliseconds expiry", () => {
    expect(describeExpiredClaudeSource(NOW_MS - 5 * HOUR_MS)).toBe(
      `${CLAUDE_EXPIRING_DESCRIPTION} (expired 5h ago)`,
    );
  });

  test("reads an epoch-seconds expiry", () => {
    expect(describeExpiredClaudeSource((NOW_MS - 5 * HOUR_MS) / 1000)).toBe(
      `${CLAUDE_EXPIRING_DESCRIPTION} (expired 5h ago)`,
    );
  });

  test("reads an iso string expiry", () => {
    expect(describeExpiredClaudeSource(new Date(NOW_MS - 5 * HOUR_MS).toISOString())).toBe(
      `${CLAUDE_EXPIRING_DESCRIPTION} (expired 5h ago)`,
    );
  });

  test("reports an age of a day or more in whole days", () => {
    expect(describeExpiredClaudeSource(NOW_MS - 34 * HOUR_MS)).toBe(
      `${CLAUDE_EXPIRING_DESCRIPTION} (expired 1d ago)`,
    );
  });

  test("counts an expiry exactly equal to now as expired", () => {
    expect(describeExpiredClaudeSource(NOW_MS)).toBe(
      `${CLAUDE_EXPIRING_DESCRIPTION} (expired 0m ago)`,
    );
  });

  test("reports an age under an hour in minutes", () => {
    expect(describeExpiredClaudeSource(NOW_MS - 7 * 60 * 1000)).toBe(
      `${CLAUDE_EXPIRING_DESCRIPTION} (expired 7m ago)`,
    );
  });

  test("treats an absent expiry field as no expiry", () => {
    const adapters = createStubAdapters({
      files: { [CLAUDE_CREDENTIALS_PATH]: claudeCredentialsFile(undefined) },
    });
    expect(
      createCredentialResolver({ CLAUDE_TOKEN: [CLAUDE_EXPIRING_SOURCE] }, adapters).resolve(
        "CLAUDE_TOKEN",
      ),
    ).toBe(ACCESS_TOKEN);
  });

  test("treats an unparseable expiry value as no expiry", () => {
    const adapters = createStubAdapters({
      files: { [CLAUDE_CREDENTIALS_PATH]: claudeCredentialsFile("whenever") },
    });
    expect(
      createCredentialResolver({ CLAUDE_TOKEN: [CLAUDE_EXPIRING_SOURCE] }, adapters).resolve(
        "CLAUDE_TOKEN",
      ),
    ).toBe(ACCESS_TOKEN);
  });

  test("treats an expiry path that resolves to nothing as no expiry", () => {
    const adapters = createStubAdapters({
      files: {
        [CLAUDE_CREDENTIALS_PATH]: JSON.stringify({
          claudeAiOauth: { accessToken: ACCESS_TOKEN, expiresAt: null },
        }),
      },
    });
    const credentials: UsageCredentials = {
      CLAUDE_TOKEN: [{ ...CLAUDE_EXPIRING_SOURCE, expiresAtPath: "claudeAiOauth.notARealField" }],
    };
    expect(createCredentialResolver(credentials, adapters).resolve("CLAUDE_TOKEN")).toBe(
      ACCESS_TOKEN,
    );
  });

  test("leaves an env source undecorated when a sibling file source expired", () => {
    const adapters = createStubAdapters({
      files: { [CLAUDE_CREDENTIALS_PATH]: claudeCredentialsFile(NOW_MS - 34 * HOUR_MS) },
    });
    const credentials: UsageCredentials = {
      CLAUDE_TOKEN: [CLAUDE_EXPIRING_SOURCE, { kind: "env", variable: "ANTHROPIC_API_KEY" }],
    };
    const error = captureError(UsageCredentialMissingError, () => {
      createCredentialResolver(credentials, adapters).resolve("CLAUDE_TOKEN");
    });
    expect(error.tried).toEqual([
      `${CLAUDE_EXPIRING_DESCRIPTION} (expired 1d ago)`,
      "env ANTHROPIC_API_KEY",
    ]);
  });

  test("uses the injected clock rather than the wall clock", () => {
    const adapters = createStubAdapters({
      now: new Date(NOW_MS - 48 * HOUR_MS),
      files: { [CLAUDE_CREDENTIALS_PATH]: claudeCredentialsFile(NOW_MS - 34 * HOUR_MS) },
    });
    expect(
      createCredentialResolver({ CLAUDE_TOKEN: [CLAUDE_EXPIRING_SOURCE] }, adapters).resolve(
        "CLAUDE_TOKEN",
      ),
    ).toBe(ACCESS_TOKEN);
  });
});

describe("UsageCredentialResolver.redact", () => {
  test("replaces a resolved token inside a longer message", () => {
    const adapters = createStubAdapters({ env: { KIMI_TOKEN: "sk-live-abcdefgh" } });
    const resolver = createCredentialResolver(
      { KIMI_TOKEN: [{ kind: "env", variable: "KIMI_TOKEN" }] },
      adapters,
    );
    resolver.resolve("KIMI_TOKEN");
    expect(resolver.redact('401 from vendor: {"rejected":"sk-live-abcdefgh"}')).toBe(
      '401 from vendor: {"rejected":"<redacted>"}',
    );
  });

  test("leaves text untouched before anything is resolved", () => {
    const adapters = createStubAdapters({ env: { KIMI_TOKEN: "sk-live-abcdefgh" } });
    const resolver = createCredentialResolver(
      { KIMI_TOKEN: [{ kind: "env", variable: "KIMI_TOKEN" }] },
      adapters,
    );
    expect(resolver.redact("Request to api.moonshot.ai failed: sk-live-abcdefgh")).toBe(
      "Request to api.moonshot.ai failed: sk-live-abcdefgh",
    );
  });

  test("replaces every occurrence of the same resolved token", () => {
    const adapters = createStubAdapters({ env: { KIMI_TOKEN: "sk-live-abcdefgh" } });
    const resolver = createCredentialResolver(
      { KIMI_TOKEN: [{ kind: "env", variable: "KIMI_TOKEN" }] },
      adapters,
    );
    resolver.resolve("KIMI_TOKEN");
    expect(resolver.redact("sk-live-abcdefgh echoed as sk-live-abcdefgh")).toBe(
      "<redacted> echoed as <redacted>",
    );
  });

  test("replaces both values in full when one resolved value contains another", () => {
    const adapters = createStubAdapters({
      env: { LONG_TOKEN: "supersecrettoken", SHORT_TOKEN: "supersecret" },
    });
    const resolver = createCredentialResolver(
      {
        LONG_TOKEN: [{ kind: "env", variable: "LONG_TOKEN" }],
        SHORT_TOKEN: [{ kind: "env", variable: "SHORT_TOKEN" }],
      },
      adapters,
    );
    resolver.resolve("LONG_TOKEN");
    resolver.resolve("SHORT_TOKEN");
    const scrubbed = resolver.redact("sent supersecrettoken, retried with supersecret");
    expect(scrubbed).toBe("sent <redacted>, retried with <redacted>");
    expect(scrubbed).not.toContain("supersecret");
  });

  test("never replaces the credential's name", () => {
    const adapters = createStubAdapters({ env: { CLAUDE_TOKEN: "sk-live-abcdefgh" } });
    const resolver = createCredentialResolver(
      { CLAUDE_TOKEN: [{ kind: "env", variable: "CLAUDE_TOKEN" }] },
      adapters,
    );
    resolver.resolve("CLAUDE_TOKEN");
    expect(resolver.redact("CLAUDE_TOKEN was rejected")).toBe("CLAUDE_TOKEN was rejected");
  });

  test("leaves a value shorter than the redaction floor alone", () => {
    const adapters = createStubAdapters({ env: { TINY_TOKEN: "abc1234" } });
    const resolver = createCredentialResolver(
      { TINY_TOKEN: [{ kind: "env", variable: "TINY_TOKEN" }] },
      adapters,
    );
    expect(resolver.resolve("TINY_TOKEN")).toBe("abc1234");
    expect(resolver.redact("vendor said abc1234 is not a token")).toBe(
      "vendor said abc1234 is not a token",
    );
  });

  test("redacts a token resolved out of a credential file", () => {
    const adapters = createStubAdapters({
      files: {
        [CLAUDE_CREDENTIALS_PATH]: JSON.stringify({
          claudeAiOauth: { accessToken: "sk-ant-oat01-abcdefgh" },
        }),
      },
    });
    const resolver = createCredentialResolver(CHAINED_CREDENTIALS, adapters);
    resolver.resolve("CLAUDE_TOKEN");
    expect(resolver.redact("invalid header value: sk-ant-oat01-abcdefgh")).toBe(
      "invalid header value: <redacted>",
    );
  });
});
