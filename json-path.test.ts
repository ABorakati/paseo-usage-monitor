import { describe, expect, test } from "vitest";
import {
  readAtPath,
  readNumberAtPath,
  readStringAtPath,
  readTimestampAtPath,
} from "./json-path.server";

const DOCUMENT = {
  data: {
    usage: { total: 4_200, label: "Session" },
    balance_infos: [{ total_balance: "110.00" }, { total_balance: 7 }],
  },
  reset_seconds: 1_772_366_400,
  reset_millis: 1_772_366_400_000,
  reset_iso: "2026-03-01T12:00:00.000Z",
  ratio: 0.25,
  enabled: true,
};

describe("readAtPath", () => {
  test("walks dot segments", () => {
    expect(readAtPath(DOCUMENT, "data.usage.total")).toBe(4_200);
  });

  test("walks bracket indexes into arrays", () => {
    expect(readAtPath(DOCUMENT, "data.balance_infos[0].total_balance")).toBe("110.00");
  });

  test("yields null for a path that does not resolve", () => {
    expect(readAtPath(DOCUMENT, "data.usage.remaining")).toBeNull();
  });

  test("yields null when a segment descends through a primitive", () => {
    expect(readAtPath(DOCUMENT, "data.usage.total.nested")).toBeNull();
  });

  test("yields null for an index past the end of an array", () => {
    expect(readAtPath(DOCUMENT, "data.balance_infos[9].total_balance")).toBeNull();
  });

  // GitHub Copilot's hosts.json is keyed by hostname, so the key itself holds a
  // dot. A bare `github.com.oauth_token` reads `github` then `com` and finds
  // neither; the quoted bracket form reads the one key that is there.
  test("reads a quoted bracket key that contains a dot", () => {
    const hosts = { "github.com": { oauth_token: "gho_x", user: "octocat" } };
    expect(readAtPath(hosts, '["github.com"].oauth_token')).toBe("gho_x");
    expect(readAtPath(hosts, "['github.com'].user")).toBe("octocat");
    expect(readAtPath(hosts, "github.com.oauth_token")).toBeNull();
  });

  test("unescapes a backslash-escaped quote inside a quoted key", () => {
    expect(readAtPath({ 'a"b': 1 }, '["a\\"b"]')).toBe(1);
  });

  test("still reads a bare bracket index after a quoted key", () => {
    const document = { "x.y": [{ n: 3 }] };
    expect(readAtPath(document, '["x.y"][0].n')).toBe(3);
  });
});

describe("readNumberAtPath", () => {
  test("returns a number verbatim", () => {
    expect(readNumberAtPath(DOCUMENT, "ratio")).toBe(0.25);
  });

  test("coerces a numeric string", () => {
    expect(readNumberAtPath(DOCUMENT, "data.balance_infos[0].total_balance")).toBe(110);
  });

  test("rejects a non-numeric string", () => {
    expect(readNumberAtPath(DOCUMENT, "data.usage.label")).toBeNull();
  });

  test("rejects a boolean", () => {
    expect(readNumberAtPath(DOCUMENT, "enabled")).toBeNull();
  });

  test("rejects an empty string rather than reading it as zero", () => {
    expect(readNumberAtPath({ total: "  " }, "total")).toBeNull();
  });

  test("rejects a non-finite number", () => {
    expect(readNumberAtPath({ total: Number.POSITIVE_INFINITY }, "total")).toBeNull();
  });
});

describe("readStringAtPath", () => {
  test("returns a string verbatim", () => {
    expect(readStringAtPath(DOCUMENT, "data.usage.label")).toBe("Session");
  });

  test("stringifies a finite number", () => {
    expect(readStringAtPath(DOCUMENT, "data.usage.total")).toBe("4200");
  });

  test("rejects a boolean", () => {
    expect(readStringAtPath(DOCUMENT, "enabled")).toBeNull();
  });

  test("yields null for a missing path", () => {
    expect(readStringAtPath(DOCUMENT, "data.token")).toBeNull();
  });
});

describe("readTimestampAtPath", () => {
  test("passes an ISO string through unchanged", () => {
    expect(readTimestampAtPath(DOCUMENT, "reset_iso")).toBe("2026-03-01T12:00:00.000Z");
  });

  test("reads a value below the seconds ceiling as epoch seconds", () => {
    expect(readTimestampAtPath(DOCUMENT, "reset_seconds")).toBe("2026-03-01T12:00:00.000Z");
  });

  test("reads a value above the seconds ceiling as epoch milliseconds", () => {
    expect(readTimestampAtPath(DOCUMENT, "reset_millis")).toBe("2026-03-01T12:00:00.000Z");
  });

  test("rejects an unparseable string", () => {
    expect(readTimestampAtPath({ reset: "whenever" }, "reset")).toBeNull();
  });

  test("rejects a boolean", () => {
    expect(readTimestampAtPath(DOCUMENT, "enabled")).toBeNull();
  });

  test("yields null for a missing path", () => {
    expect(readTimestampAtPath(DOCUMENT, "reset_at")).toBeNull();
  });
});
