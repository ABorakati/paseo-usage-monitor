import { describe, expect, test } from "vitest";
import {
  type GithubCopilotProbeAdapters,
  GithubCopilotProbeError,
  copilotConfigDir,
  mapCopilotUser,
  probeGithubCopilotQuota,
  readTokenFromCredentialFile,
  resolveCopilotToken,
} from "./github-copilot-probe.server";

const HOME = "/home/tester";
const NOW = new Date("2026-09-02T10:00:00.000Z");

/**
 * What the Copilot extensions receive from `copilot_internal/user` on an
 * individual plan: the unlimited buckets report a zero entitlement, and the
 * reset is a calendar day. Nothing in it is account-identifying.
 */
const USER_DOCUMENT = {
  copilot_plan: "individual",
  access_type_sku: "copilot_standalone_seat_quota",
  chat_enabled: true,
  assigned_date: "2024-01-01T00:00:00.000Z",
  quota_reset_date: "2026-10-01",
  quota_snapshots: {
    chat: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: true },
    completions: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: true },
    premium_interactions: {
      entitlement: 300,
      remaining: 285,
      percent_remaining: 95,
      unlimited: false,
      overage_permitted: false,
      overage_count: 0,
    },
  },
};

function createAdapters(options: {
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>;
  status?: number;
  document?: unknown;
  fetchError?: Error;
}): {
  adapters: GithubCopilotProbeAdapters;
  requests: { url: string; headers: Record<string, string> }[];
} {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  return {
    requests,
    adapters: {
      env: options.env ?? {},
      homeDir: HOME,
      readTextFile: (path) => options.files?.[path] ?? null,
      async fetchJson(url, headers) {
        requests.push({ url, headers });
        if (options.fetchError) throw options.fetchError;
        return { status: options.status ?? 200, document: options.document ?? USER_DOCUMENT };
      },
      now: () => NOW,
    },
  };
}

describe("copilot credential files", () => {
  test("lives under ~/.config unless XDG_CONFIG_HOME says otherwise", () => {
    expect(copilotConfigDir({ env: {}, homeDir: HOME })).toBe(`${HOME}/.config/github-copilot`);
    expect(copilotConfigDir({ env: { XDG_CONFIG_HOME: "/xdg" }, homeDir: HOME })).toBe(
      "/xdg/github-copilot",
    );
  });

  test("reads the token under the bare hostname key", () => {
    const hosts = JSON.stringify({ "github.com": { user: "octocat", oauth_token: "gho_hosts" } });
    expect(readTokenFromCredentialFile(hosts)).toBe("gho_hosts");
  });

  // Newer extension builds key apps.json by hostname plus their OAuth app id,
  // which differs per build, so only the hostname prefix is relied on.
  test("reads the token under a hostname-and-app-id key", () => {
    const apps = JSON.stringify({
      "github.com:Iv1.b507a08c87ecfe98": { user: "octocat", oauth_token: "gho_apps" },
    });
    expect(readTokenFromCredentialFile(apps)).toBe("gho_apps");
  });

  test("ignores other hosts, malformed JSON and an empty token", () => {
    expect(
      readTokenFromCredentialFile(JSON.stringify({ "ghe.example": { oauth_token: "x" } })),
    ).toBeNull();
    expect(readTokenFromCredentialFile("{not json")).toBeNull();
    expect(
      readTokenFromCredentialFile(JSON.stringify({ "github.com": { oauth_token: "" } })),
    ).toBeNull();
  });
});

describe("resolveCopilotToken", () => {
  const hostsPath = `${HOME}/.config/github-copilot/hosts.json`;
  const appsPath = `${HOME}/.config/github-copilot/apps.json`;

  test("prefers the environment override, so an exported token still wins", () => {
    const { adapters } = createAdapters({
      env: { COPILOT_GITHUB_TOKEN: " gho_env " },
      files: { [hostsPath]: JSON.stringify({ "github.com": { oauth_token: "gho_hosts" } }) },
    });
    expect(resolveCopilotToken(adapters)).toEqual({
      token: "gho_env",
      origin: "env COPILOT_GITHUB_TOKEN",
    });
  });

  test("falls through hosts.json to apps.json", () => {
    const { adapters } = createAdapters({
      files: { [appsPath]: JSON.stringify({ "github.com:Iv1.x": { oauth_token: "gho_apps" } }) },
    });
    expect(resolveCopilotToken(adapters)).toEqual({
      token: "gho_apps",
      origin: `file ${appsPath}`,
    });
  });

  test("names every place it looked when nothing is stored, without a secret", () => {
    const { adapters } = createAdapters({
      files: { [hostsPath]: JSON.stringify({ "ghe.example": { oauth_token: "gho_other" } }) },
    });
    const failure = (() => {
      try {
        resolveCopilotToken(adapters);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(GithubCopilotProbeError);
    const message = String(failure);
    expect(message).toContain("COPILOT_GITHUB_TOKEN (not set)");
    expect(message).toContain(`${hostsPath} (no github.com token stored)`);
    expect(message).toContain(`${appsPath} (no such file)`);
    expect(message).not.toContain("gho_other");
  });
});

describe("mapCopilotUser", () => {
  test("emits every known bucket in order, metering only the counted ones", () => {
    const quota = mapCopilotUser(USER_DOCUMENT, "file hosts.json", NOW.toISOString());
    expect(quota).toMatchObject({
      source: "file hosts.json",
      fetchedAt: "2026-09-02T10:00:00.000Z",
      plan: "individual",
      resetsAt: "2026-10-01",
    });
    expect(quota.buckets.map((bucket) => [bucket.id, bucket.metered, bucket.unlimited])).toEqual([
      ["premium", true, false],
      ["chat", false, true],
      ["completions", false, true],
    ]);
    expect(quota.buckets[0]).toMatchObject({
      label: "Premium requests",
      entitlement: 300,
      remaining: 285,
      percentRemaining: 95,
      resetsAt: "2026-10-01",
    });
  });

  test("keeps an absent bucket in place, unmetered and empty", () => {
    const quota = mapCopilotUser(
      { quota_snapshots: { premium_interactions: { entitlement: 50, remaining: 20 } } },
      "env",
      NOW.toISOString(),
    );
    expect(quota.buckets.map((bucket) => bucket.id)).toEqual(["premium", "chat", "completions"]);
    expect(quota.buckets[1]).toMatchObject({ metered: false, entitlement: null, remaining: null });
    expect(quota.plan).toBeNull();
    expect(quota.resetsAt).toBeNull();
  });

  test("rejects an unparseable reset date rather than passing it through", () => {
    const quota = mapCopilotUser({ quota_reset_date: "soon" }, "env", NOW.toISOString());
    expect(quota.resetsAt).toBeNull();
  });
});

describe("probeGithubCopilotQuota", () => {
  test("sends the extension's headers with the token and maps the reply", async () => {
    const { adapters, requests } = createAdapters({ env: { COPILOT_GITHUB_TOKEN: "gho_env" } });
    const quota = await probeGithubCopilotQuota(adapters);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.github.com/copilot_internal/user");
    expect(requests[0]?.headers).toMatchObject({
      Authorization: "token gho_env",
      "Editor-Version": "vscode/1.98.1",
      "X-Github-Api-Version": "2025-04-01",
    });
    expect(quota.buckets[0]).toMatchObject({ id: "premium", remaining: 285 });
  });

  test("names the origin of a rejected token and never the token itself", async () => {
    const { adapters } = createAdapters({ env: { COPILOT_GITHUB_TOKEN: "gho_env" }, status: 401 });
    const failure = await probeGithubCopilotQuota(adapters).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GithubCopilotProbeError);
    expect(String(failure)).toContain(
      "rejected the Copilot token from env COPILOT_GITHUB_TOKEN (HTTP 401)",
    );
    expect(String(failure)).not.toContain("gho_env");
  });

  test("reports an unreachable endpoint and an unexpected status distinctly", async () => {
    const unreachable = createAdapters({
      env: { COPILOT_GITHUB_TOKEN: "gho_env" },
      fetchError: new Error("getaddrinfo ENOTFOUND"),
    });
    await expect(probeGithubCopilotQuota(unreachable.adapters)).rejects.toThrow(
      "could not reach the Copilot endpoint: getaddrinfo ENOTFOUND",
    );
    const teapot = createAdapters({ env: { COPILOT_GITHUB_TOKEN: "gho_env" }, status: 418 });
    await expect(probeGithubCopilotQuota(teapot.adapters)).rejects.toThrow("returned HTTP 418");
  });
});
