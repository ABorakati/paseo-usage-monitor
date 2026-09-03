import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { UsageRateLimitedError, UsageSourceError } from "./errors.server";
import type { CredentialAdapters } from "./credentials.server";
import type { UsageSource } from "./limits.shared";
import {
  createNodeSourceAdapters,
  fetchSourceDocument,
  type UsageHttpRequest,
  type UsageSourceAdapters,
} from "./source.server";

const HOME_DIR = "/home/tester";

interface MachineInput {
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>;
}

function createMachine(input: MachineInput = {}): CredentialAdapters & { reads: string[] } {
  const files = input.files ?? {};
  const reads: string[] = [];
  return {
    env: input.env ?? {},
    homeDir: HOME_DIR,
    reads,
    now: () => new Date("2026-08-30T12:00:00.000Z"),
    readTextFile(path: string): string | null {
      reads.push(path);
      return files[path] ?? null;
    },
  };
}

/** A source that reads no file must never reach the filesystem to prove it. */
const NO_FILES: CredentialAdapters = {
  env: {},
  homeDir: HOME_DIR,
  now: () => new Date(),
  readTextFile(): string | null {
    throw new Error("this source must not read a file");
  },
};

/**
 * Exercises the real Node adapter, so the child-process failure modes are the
 * ones Node actually produces rather than a hand-built error object: a timeout
 * and a maxBuffer overflow both set `killed`, and only Node decides which
 * fields come with which.
 */
const STDOUT_LIMIT = 4 * 1024 * 1024;
const NODE = process.execPath;

function nodeCommand(script: string, ...extra: string[]): string[] {
  return [NODE, "-e", script, ...extra];
}

describe("node command source", () => {
  test("parses the JSON a command prints on stdout", async () => {
    const adapters = createNodeSourceAdapters();

    const document = await adapters.runCommand(
      nodeCommand("process.stdout.write(JSON.stringify({ credits: { left: 4 } }))"),
      undefined,
    );

    expect(document).toEqual({ credits: { left: 4 } });
  });

  test("rejects stdout that is not JSON", async () => {
    const adapters = createNodeSourceAdapters();

    await expect(
      adapters.runCommand(nodeCommand('process.stdout.write("not json")'), undefined),
    ).rejects.toThrow(/did not return JSON/);
  });

  test("reports a failing command without naming its argv", async () => {
    const adapters = createNodeSourceAdapters();

    const failure = await adapters
      .runCommand(nodeCommand("process.exit(3)", "--token=super-secret-value"), undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageSourceError);
    expect(String(failure)).toContain("failed");
    expect(String(failure)).not.toContain("super-secret-value");
    expect(String(failure)).not.toContain("timed out");
  });

  test("reports output overflow with the byte ceiling instead of a timeout", async () => {
    const adapters = createNodeSourceAdapters();

    const failure = await adapters
      .runCommand(
        nodeCommand(`process.stdout.write("x".repeat(${STDOUT_LIMIT + 1024}))`),
        undefined,
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageSourceError);
    expect(String(failure)).toContain(`printed more than ${STDOUT_LIMIT} bytes`);
    expect(String(failure)).not.toContain("timed out");
  });

  // Real 15s wait: child_process arms its kill timer on an internal libuv
  // timer that vi.useFakeTimers() does not patch, so advancing a fake clock
  // leaves the child running and never reaches this branch.
  test("reports a command that outruns the request timeout", { timeout: 30_000 }, async () => {
    const adapters = createNodeSourceAdapters();

    const failure = await adapters
      .runCommand(nodeCommand("setTimeout(() => {}, 60_000)"), undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageSourceError);
    expect(String(failure)).toContain("timed out after 15000ms");
    expect(String(failure)).not.toContain("printed more than");
  });
});

/**
 * A real loopback server, because the point of these cases is what the adapter
 * does with an actual `Response`: a rejected token echoed in the body must not
 * reach the error message.
 */
describe("node http source", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    server.close();
    await once(server, "close");
    server = null;
  });

  async function startServer(
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<string> {
    const started = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(body);
    });
    server = started;
    started.listen(0, "127.0.0.1");
    await once(started, "listening");
    const address = started.address();
    if (address === null || typeof address === "string") {
      throw new Error("server did not report a numeric port");
    }
    return `http://127.0.0.1:${address.port}/usage`;
  }

  async function rateLimitFailure(retryAfter: string | null): Promise<UsageRateLimitedError> {
    const url = await startServer(
      429,
      JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited." } }),
      retryAfter === null ? {} : { "retry-after": retryAfter },
    );
    const failure = await createNodeSourceAdapters()
      .fetchJson(request(url))
      .catch((error: unknown) => error);
    if (!(failure instanceof UsageRateLimitedError)) {
      throw new Error(`expected a rate-limit error, got ${String(failure)}`);
    }
    return failure;
  }

  function request(url: string): UsageHttpRequest {
    return { url, method: "GET", headers: { Authorization: "Bearer super-secret-value" } };
  }

  test("parses a JSON response body", async () => {
    const url = await startServer(200, JSON.stringify({ data: { usage: 7 } }));

    const document = await createNodeSourceAdapters().fetchJson(request(url));

    expect(document).toEqual({ data: { usage: 7 } });
  });

  test("reports method, host and status without the response body", async () => {
    const url = await startServer(401, JSON.stringify({ error: "token super-secret-value" }));

    const failure = await createNodeSourceAdapters()
      .fetchJson(request(url))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageSourceError);
    expect(String(failure)).toContain("GET request to 127.0.0.1:");
    expect(String(failure)).toContain("failed with HTTP 401");
    expect(String(failure)).not.toContain("super-secret-value");
    expect(String(failure)).not.toContain("token");
  });

  test("rejects a response body that is not JSON", async () => {
    const url = await startServer(200, "super-secret-value is not json");

    const failure = await createNodeSourceAdapters()
      .fetchJson(request(url))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageSourceError);
    expect(String(failure)).toContain("did not return JSON");
    expect(String(failure)).not.toContain("super-secret-value");
  });

  test("carries the Retry-After seconds a rate-limited vendor sent", async () => {
    const failure = await rateLimitFailure("1495");

    expect(failure.retryAfterMs).toBe(1_495_000);
    expect(failure.message).toContain("GET request to 127.0.0.1:");
    expect(failure.message).toContain("failed with HTTP 429");
    expect(failure.message).not.toContain("rate_limit_error");
  });

  test.each(["0", "-5", "soon", "999999", ""])(
    "ignores an unusable Retry-After of %j",
    async (header) => {
      const failure = await rateLimitFailure(header);

      expect(failure.retryAfterMs).toBeNull();
    },
  );

  test("falls back to the default when no Retry-After arrives", async () => {
    const failure = await rateLimitFailure(null);

    expect(failure.retryAfterMs).toBeNull();
  });

  test("honours an HTTP-date Retry-After in the future", async () => {
    const failure = await rateLimitFailure(new Date(Date.now() + 120_000).toUTCString());

    expect(failure.retryAfterMs).toBeGreaterThan(60_000);
    expect(failure.retryAfterMs).toBeLessThanOrEqual(120_000);
  });

  test("ignores an HTTP-date Retry-After already in the past", async () => {
    const failure = await rateLimitFailure(new Date(Date.now() - 120_000).toUTCString());

    expect(failure.retryAfterMs).toBeNull();
  });
});

/**
 * A probe is dispatched through an injected function, so these cases prove the
 * routing and the failure wording without touching the user's keyring or
 * Google's endpoint.
 */
describe("probe source", () => {
  const PROBE_SOURCE: UsageSource = { kind: "probe", probe: "antigravity" };

  const QUOTA_DOCUMENT = {
    source: "stored-credential",
    fetchedAt: "2026-08-28T19:00:00.000Z",
    buckets: [
      {
        id: "gemini-5h",
        label: "5 hours",
        group: "Gemini Models",
        usedPercent: 9.23,
        resetsAt: "2026-08-28T22:11:00.000Z",
      },
    ],
  };

  function createProbeAdapters(probe: () => Promise<unknown>): {
    adapters: UsageSourceAdapters;
    calls: { http: number; command: number; probe: number };
  } {
    const calls = { http: 0, command: 0, probe: 0 };
    return {
      calls,
      adapters: {
        async fetchJson() {
          calls.http += 1;
          throw new Error("a probe source must not issue an http request");
        },
        async runCommand() {
          calls.command += 1;
          throw new Error("a probe source must not run a command");
        },
        async probeAntigravity() {
          calls.probe += 1;
          return probe();
        },
      },
    };
  }

  test("returns the probe's document without any request or subprocess", async () => {
    const probe = createProbeAdapters(async () => QUOTA_DOCUMENT);

    const document = await fetchSourceDocument(PROBE_SOURCE, probe.adapters, NO_FILES);

    expect(document).toEqual(QUOTA_DOCUMENT);
    expect(probe.calls).toEqual({ http: 0, command: 0, probe: 1 });
  });

  test("wraps a failing probe in a source error naming the probe", async () => {
    const probe = createProbeAdapters(async () => {
      throw new Error("The Antigravity credential is in a locked keyring");
    });

    const failure = await fetchSourceDocument(PROBE_SOURCE, probe.adapters, NO_FILES).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(UsageSourceError);
    expect(String(failure)).toContain(
      "Antigravity probe failed: The Antigravity credential is in a locked keyring",
    );
  });

  // Two probes share one dispatch, so a github-copilot source must reach its
  // own adapter and never the Antigravity one.
  test("dispatches each probe name to its own adapter", async () => {
    const seen: string[] = [];
    const adapters: UsageSourceAdapters = {
      async fetchJson() {
        throw new Error("unreachable");
      },
      async runCommand() {
        throw new Error("unreachable");
      },
      async probeAntigravity() {
        seen.push("antigravity");
        return {};
      },
      async probeGithubCopilot() {
        seen.push("github-copilot");
        return { buckets: [] };
      },
    };

    await fetchSourceDocument({ kind: "probe", probe: "github-copilot" }, adapters, NO_FILES);
    await fetchSourceDocument(PROBE_SOURCE, adapters, NO_FILES);

    expect(seen).toEqual(["github-copilot", "antigravity"]);
  });

  test("labels a missing github-copilot adapter as that provider's failure", async () => {
    const adapters: UsageSourceAdapters = {
      async fetchJson() {
        throw new Error("unreachable");
      },
      async runCommand() {
        throw new Error("unreachable");
      },
      async probeAntigravity() {
        return {};
      },
    };

    const failure = await fetchSourceDocument(
      { kind: "probe", probe: "github-copilot" },
      adapters,
      NO_FILES,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageSourceError);
    expect(String(failure)).toContain("GitHub Copilot probe failed: no probe is available");
  });

  test("reports a missing probe adapter as that provider's failure", async () => {
    const adapters: UsageSourceAdapters = {
      async fetchJson() {
        throw new Error("unreachable");
      },
      async runCommand() {
        throw new Error("unreachable");
      },
    };

    const failure = await fetchSourceDocument(PROBE_SOURCE, adapters, NO_FILES).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(UsageSourceError);
    expect(String(failure)).toContain("Antigravity probe failed: no probe is available");
  });

  test("leaves http and command sources dispatching as before", async () => {
    const seen: string[] = [];
    const adapters: UsageSourceAdapters = {
      async fetchJson(request) {
        seen.push(`http ${request.url}`);
        return { used: 1 };
      },
      async runCommand(command) {
        seen.push(`command ${command.join(" ")}`);
        return { used: 2 };
      },
      async probeAntigravity() {
        seen.push("probe");
        return QUOTA_DOCUMENT;
      },
    };

    const http = await fetchSourceDocument(
      { kind: "http", url: "https://example.test/usage", method: "GET", headers: {} },
      adapters,
      NO_FILES,
    );
    const command = await fetchSourceDocument(
      { kind: "command", command: ["tool", "--json"] },
      adapters,
      NO_FILES,
    );

    expect(http).toEqual({ used: 1 });
    expect(command).toEqual({ used: 2 });
    expect(seen).toEqual(["http https://example.test/usage", "command tool --json"]);
  });

  test("wires the real probe into the node adapters", () => {
    expect(typeof createNodeSourceAdapters().probeAntigravity).toBe("function");
  });
});

describe("file source", () => {
  const UNREACHABLE: UsageSourceAdapters = {
    async fetchJson() {
      throw new Error("a file source must not make a request");
    },
    async runCommand() {
      throw new Error("a file source must not run a command");
    },
    async probeAntigravity() {
      throw new Error("a file source must not run a probe");
    },
  };

  const RATE_LIMITS = {
    five_hour: { utilization: 42, resets_at: "2026-08-30T17:00:00.000Z" },
    seven_day: { utilization: 18, resets_at: "2026-09-04T10:00:00.000Z" },
  };

  const CLAUDE_FILES: UsageSource = {
    kind: "file",
    files: ["${CLAUDE_CONFIG_DIR}/paseo-rate-limits.json", "~/.claude/paseo-rate-limits.json"],
  };

  test("reads the document without a request, a subprocess or a credential", async () => {
    const machine = createMachine({
      files: { [`${HOME_DIR}/.claude/paseo-rate-limits.json`]: JSON.stringify(RATE_LIMITS) },
    });

    const document = await fetchSourceDocument(CLAUDE_FILES, UNREACHABLE, machine);

    expect(document).toEqual(RATE_LIMITS);
  });

  test("skips a candidate whose variable is unset and reads the next one", async () => {
    const machine = createMachine({
      files: { [`${HOME_DIR}/.claude/paseo-rate-limits.json`]: JSON.stringify(RATE_LIMITS) },
    });

    await fetchSourceDocument(CLAUDE_FILES, UNREACHABLE, machine);

    // The override is not in use here, so it costs no read at all rather than
    // reading a path with `${CLAUDE_CONFIG_DIR}` still in it.
    expect(machine.reads).toEqual([`${HOME_DIR}/.claude/paseo-rate-limits.json`]);
  });

  test("prefers the overridden directory when the variable is set", async () => {
    const machine = createMachine({
      env: { CLAUDE_CONFIG_DIR: "/work/claude" },
      files: {
        "/work/claude/paseo-rate-limits.json": JSON.stringify(RATE_LIMITS),
        [`${HOME_DIR}/.claude/paseo-rate-limits.json`]: JSON.stringify({ five_hour: null }),
      },
    });

    const document = await fetchSourceDocument(CLAUDE_FILES, UNREACHABLE, machine);

    expect(document).toEqual(RATE_LIMITS);
    expect(machine.reads).toEqual(["/work/claude/paseo-rate-limits.json"]);
  });

  test("names every candidate and why it did not answer", async () => {
    const machine = createMachine({});

    const failure = await fetchSourceDocument(CLAUDE_FILES, UNREACHABLE, machine).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(UsageSourceError);
    // Both reasons, because they want opposite fixes: set the variable, or run
    // whatever writes the file.
    expect(String(failure)).toContain(
      "${CLAUDE_CONFIG_DIR}/paseo-rate-limits.json (CLAUDE_CONFIG_DIR is not set)",
    );
    expect(String(failure)).toContain(`${HOME_DIR}/.claude/paseo-rate-limits.json (no such file)`);
  });

  test("rejects a file that is not JSON, naming the path it read", async () => {
    const path = `${HOME_DIR}/.claude/paseo-rate-limits.json`;
    const machine = createMachine({ files: { [path]: "not json" } });

    const failure = await fetchSourceDocument(CLAUDE_FILES, UNREACHABLE, machine).catch(
      (error: unknown) => error,
    );

    expect(String(failure)).toContain(`File ${path} did not return JSON`);
  });
});
