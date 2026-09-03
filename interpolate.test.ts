import { describe, expect, test } from "vitest";
import { interpolate, interpolateSource } from "./interpolate.server";
import type { UsageSource } from "./limits.shared";

const SECRETS: Record<string, string | undefined> = {
  CLAUDE_TOKEN: "oauth-value",
  ORG_ID: "org-42",
};

function resolveSecret(name: string): string {
  const value = SECRETS[name];
  if (value === undefined) throw new Error(`unresolved credential ${name}`);
  return value;
}

describe("interpolate", () => {
  test("substitutes every reference in a template", () => {
    expect(interpolate("Bearer ${CLAUDE_TOKEN}/${ORG_ID}", resolveSecret)).toBe(
      "Bearer oauth-value/org-42",
    );
  });

  test("substitutes a repeated reference", () => {
    expect(interpolate("${ORG_ID}:${ORG_ID}", resolveSecret)).toBe("org-42:org-42");
  });

  test("leaves a template without references untouched", () => {
    expect(interpolate("https://api.example.com/v1/usage", resolveSecret)).toBe(
      "https://api.example.com/v1/usage",
    );
  });

  test("leaves a bare dollar sign literal", () => {
    expect(interpolate("balance $5.00 for ${ORG_ID}", resolveSecret)).toBe(
      "balance $5.00 for org-42",
    );
  });

  test("leaves a shell-style reference without braces literal", () => {
    expect(interpolate("$ORG_ID", resolveSecret)).toBe("$ORG_ID");
  });

  test("propagates the resolver's failure", () => {
    expect(() => interpolate("Bearer ${MISSING_TOKEN}", resolveSecret)).toThrow(
      "unresolved credential MISSING_TOKEN",
    );
  });
});

describe("interpolateSource", () => {
  test("expands the url, every header value, and string leaves of the body", () => {
    const source: UsageSource = {
      kind: "http",
      url: "https://api.example.com/orgs/${ORG_ID}/usage",
      method: "POST",
      headers: {
        authorization: "Bearer ${CLAUDE_TOKEN}",
        "content-type": "application/json",
      },
      body: {
        org: "${ORG_ID}",
        buckets: ["${ORG_ID}-weekly", 5, null],
        nested: { token: "${CLAUDE_TOKEN}", limit: 10 },
      },
    };
    expect(interpolateSource(source, resolveSecret)).toStrictEqual({
      kind: "http",
      url: "https://api.example.com/orgs/org-42/usage",
      method: "POST",
      headers: {
        authorization: "Bearer oauth-value",
        "content-type": "application/json",
      },
      body: {
        org: "org-42",
        buckets: ["org-42-weekly", 5, null],
        nested: { token: "oauth-value", limit: 10 },
      },
    });
  });

  test("leaves an http source without a body bodyless", () => {
    const source: UsageSource = {
      kind: "http",
      url: "https://api.example.com/usage",
      method: "GET",
      headers: {},
    };
    expect(interpolateSource(source, resolveSecret)).toStrictEqual({
      kind: "http",
      url: "https://api.example.com/usage",
      method: "GET",
      headers: {},
    });
  });

  test("expands every argv element and the working directory of a command source", () => {
    const source: UsageSource = {
      kind: "command",
      command: ["vendor-cli", "usage", "--org", "${ORG_ID}", "--token", "${CLAUDE_TOKEN}"],
      cwd: "/srv/${ORG_ID}",
    };
    expect(interpolateSource(source, resolveSecret)).toStrictEqual({
      kind: "command",
      command: ["vendor-cli", "usage", "--org", "org-42", "--token", "oauth-value"],
      cwd: "/srv/org-42",
    });
  });

  test("leaves a command source without a working directory unset", () => {
    const source: UsageSource = { kind: "command", command: ["vendor-cli", "usage"] };
    expect(interpolateSource(source, resolveSecret)).toStrictEqual({
      kind: "command",
      command: ["vendor-cli", "usage"],
    });
  });

  test("propagates the resolver's failure from a header", () => {
    const source: UsageSource = {
      kind: "http",
      url: "https://api.example.com/usage",
      method: "GET",
      headers: { authorization: "Bearer ${MISSING_TOKEN}" },
    };
    expect(() => interpolateSource(source, resolveSecret)).toThrow(
      "unresolved credential MISSING_TOKEN",
    );
  });

  test("returns a probe source unchanged and never consults the resolver", () => {
    const source: UsageSource = { kind: "probe", probe: "antigravity" };
    const asked: string[] = [];
    const result = interpolateSource(source, function recordRequest(name: string): string {
      asked.push(name);
      return "unused";
    });
    expect(result).toStrictEqual({ kind: "probe", probe: "antigravity" });
    expect(asked).toEqual([]);
  });

  test("consults the resolver for every reference in an http source", () => {
    const source: UsageSource = {
      kind: "http",
      url: "https://api.example.com/orgs/${ORG_ID}/usage",
      method: "POST",
      headers: { authorization: "Bearer ${CLAUDE_TOKEN}" },
      body: { org: "${ORG_ID}" },
    };
    const asked: string[] = [];
    interpolateSource(source, function recordRequest(name: string): string {
      asked.push(name);
      return resolveSecret(name);
    });
    expect(asked.toSorted()).toEqual(["CLAUDE_TOKEN", "ORG_ID", "ORG_ID"]);
  });
});
