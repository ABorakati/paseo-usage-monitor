import { describe, expect, test } from "vitest";
import {
  type DBusMessage,
  decodeDBusBody,
  decodeDBusMessages,
  encodeDBusMethodCall,
  findOAuthClientMatches,
  isAccessTokenUsable,
  isOAuthCacheFresh,
  mapQuotaSummary,
  parseStoredCredential,
  runPhase,
  startDeadline,
} from "./antigravity-probe.server";

function messageAt(buffer: Buffer, index: number): DBusMessage {
  const message = decodeDBusMessages(buffer).messages[index];
  if (message === undefined) throw new Error(`no message at index ${index}`);
  return message;
}

/**
 * Recorded off this machine's session bus: the reply to `Hello` immediately
 * followed by the `NameAcquired` signal, in one 262-byte read. The second
 * message starts at byte 91, which is not 8-aligned — messages sit back to
 * back with no padding between them, so every alignment has to be measured
 * from the message's own start.
 */
const RECORDED_BUS_READ = Buffer.from(
  "6c0201010b000000010000003d00000006017300060000003a312e34343200000501750001000000" +
    "080167000173000007017300140000006f72672e667265656465736b746f702e4442757300000000" +
    "060000003a312e343432006c0401010b000000020000008d00000001016f00150000002f6f72672f" +
    "667265656465736b746f702f4442757300000002017300140000006f72672e667265656465736b74" +
    "6f702e4442757300000000030173000c0000004e616d654163717569726564000000000601730006" +
    "0000003a312e3434320000080167000173000007017300140000006f72672e667265656465736b74" +
    "6f702e4442757300000000060000003a312e34343200",
  "hex",
);

/** The shape Antigravity / `agy` store, with the token values replaced. */
const STORED_CREDENTIAL = JSON.stringify({
  token: {
    access_token: "ya29.recorded-access-token",
    token_type: "Bearer",
    refresh_token: "1//recorded-refresh-token",
    expiry: "2026-08-26T12:44:50.424987423+01:00",
  },
  auth_method: "consumer",
});

const GEMINI_5H_BUCKET = {
  bucketId: "gemini-5h",
  displayName: "Five Hour Limit Remaining",
  window: "5h",
  resetTime: "2026-08-28T22:11:13Z",
  description:
    "You have used some of your 5-hour limit, it will fully refresh in 4 hours, 19 minutes.",
  remainingFraction: 0.9077114,
};

/**
 * A verbatim `v1internal:retrieveUserQuotaSummary` 200 body, captured while
 * writing this probe. Nothing in it is account-identifying.
 */
const QUOTA_SUMMARY = {
  groups: [
    {
      buckets: [
        {
          bucketId: "gemini-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2026-09-01T20:00:00Z",
          description:
            "You have used some of your weekly limit, it will fully refresh in 4 days, 2 hours.",
          remainingFraction: 0.7494267,
        },
        GEMINI_5H_BUCKET,
      ],
      displayName: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
    },
    {
      buckets: [
        {
          bucketId: "3p-weekly",
          window: "weekly",
          resetTime: "2026-09-04T17:51:48Z",
          remainingFraction: 1,
        },
        {
          bucketId: "3p-5h",
          window: "5h",
          resetTime: "2026-08-28T22:51:48Z",
          remainingFraction: 1,
        },
      ],
      displayName: "Claude and GPT models",
      description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
    },
  ],
};

const FETCHED_AT = "2026-08-28T17:58:28.783Z";
const SOURCE = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

describe("decodeDBusMessages", () => {
  test("splits a recorded read into both of its messages", () => {
    const { messages, rest } = decodeDBusMessages(RECORDED_BUS_READ);
    expect(messages).toHaveLength(2);
    expect(rest).toHaveLength(0);
  });

  test("reads the reply serial and body signature off the recorded Hello reply", () => {
    const reply = messageAt(RECORDED_BUS_READ, 0);
    expect(reply.type).toBe(2);
    expect(reply.replySerial).toBe(1);
    expect(reply.signature).toBe("s");
    expect(decodeDBusBody(reply)).toEqual([":1.442"]);
  });

  test("decodes the second message, which does not start on an 8-byte boundary", () => {
    const signal = messageAt(RECORDED_BUS_READ, 1);
    expect(signal.type).toBe(4);
    expect(signal.replySerial).toBeNull();
    expect(decodeDBusBody(signal)).toEqual([":1.442"]);
  });

  test("holds back a message that has not fully arrived", () => {
    const partial = RECORDED_BUS_READ.subarray(0, 120);
    const { messages, rest } = decodeDBusMessages(partial);
    expect(messages).toHaveLength(1);
    expect(rest).toHaveLength(120 - 91);
  });
});

describe("encodeDBusMethodCall", () => {
  test("round-trips the OpenSession argument pair, variant included", () => {
    const encoded = encodeDBusMethodCall(
      7,
      {
        path: "/org/freedesktop/secrets",
        iface: "org.freedesktop.Secret.Service",
        member: "OpenSession",
        destination: "org.freedesktop.secrets",
      },
      "sv",
      ["plain", { signature: "s", value: "" }],
    );
    const message = messageAt(encoded, 0);
    expect(message.signature).toBe("sv");
    expect(decodeDBusBody(message)).toEqual(["plain", ""]);
  });

  test("round-trips the SearchItems attribute dictionary", () => {
    const encoded = encodeDBusMethodCall(
      8,
      {
        path: "/org/freedesktop/secrets",
        iface: "org.freedesktop.Secret.Service",
        member: "SearchItems",
        destination: "org.freedesktop.secrets",
      },
      "a{ss}",
      [
        [
          ["service", "gemini"],
          ["username", "antigravity"],
        ],
      ],
    );
    expect(decodeDBusBody(messageAt(encoded, 0))).toEqual([
      [
        ["service", "gemini"],
        ["username", "antigravity"],
      ],
    ]);
  });

  test("round-trips a GetSecret reply struct and keeps the value as bytes", () => {
    const payload = Buffer.from(STORED_CREDENTIAL, "utf8");
    const encoded = encodeDBusMethodCall(
      9,
      {
        path: "/org/freedesktop/secrets/collection/login/8",
        iface: "org.freedesktop.Secret.Item",
        member: "GetSecret",
        destination: "org.freedesktop.secrets",
      },
      "(oayays)",
      [["/org/freedesktop/secrets/session/s1", [], [...payload], "text/plain"]],
    );
    const [secret] = decodeDBusBody(messageAt(encoded, 0)) as [unknown[]];
    expect(Buffer.isBuffer(secret[2])).toBe(true);
    expect(String(secret[2])).toBe(STORED_CREDENTIAL);
  });
});

describe("parseStoredCredential", () => {
  test("reads the nested token object Antigravity stores", () => {
    expect(parseStoredCredential(STORED_CREDENTIAL)).toEqual({
      accessToken: "ya29.recorded-access-token",
      refreshToken: "1//recorded-refresh-token",
      expiresAtMs: Date.parse("2026-08-26T12:44:50.424+01:00"),
    });
  });

  test("unwraps the go-keyring base64 envelope other backends add", () => {
    const wrapped = `go-keyring-base64:${Buffer.from(STORED_CREDENTIAL, "utf8").toString("base64")}`;
    expect(parseStoredCredential(wrapped)?.accessToken).toBe("ya29.recorded-access-token");
  });

  test("accepts a flat token object", () => {
    const flat = JSON.stringify({
      access_token: "flat",
      refresh_token: "r",
      expiry: 1_772_366_400,
    });
    expect(parseStoredCredential(flat)).toEqual({
      accessToken: "flat",
      refreshToken: "r",
      expiresAtMs: 1_772_366_400_000,
    });
  });

  test("keeps a refresh-only credential, since the access token can be renewed", () => {
    const refreshOnly = JSON.stringify({ token: { refresh_token: "r" } });
    expect(parseStoredCredential(refreshOnly)).toEqual({
      accessToken: null,
      refreshToken: "r",
      expiresAtMs: null,
    });
  });

  test("rejects a payload carrying neither token", () => {
    expect(parseStoredCredential(JSON.stringify({ token: { token_type: "Bearer" } }))).toBeNull();
  });

  test("rejects a payload that is not JSON", () => {
    expect(parseStoredCredential("not json")).toBeNull();
  });
});

describe("isAccessTokenUsable", () => {
  const expiresAtMs = Date.parse("2026-08-28T12:00:00Z");

  test("accepts a token with time left", () => {
    expect(
      isAccessTokenUsable(
        { accessToken: "t", refreshToken: null, expiresAtMs },
        expiresAtMs - 300_000,
      ),
    ).toBe(true);
  });

  test("rejects a token inside the one-minute margin, before it formally expires", () => {
    expect(
      isAccessTokenUsable(
        { accessToken: "t", refreshToken: null, expiresAtMs },
        expiresAtMs - 30_000,
      ),
    ).toBe(false);
  });

  test("rejects an expired token", () => {
    expect(
      isAccessTokenUsable({ accessToken: "t", refreshToken: null, expiresAtMs }, expiresAtMs + 1),
    ).toBe(false);
  });

  test("accepts a token with no stated expiry rather than refusing to try", () => {
    expect(
      isAccessTokenUsable({ accessToken: "t", refreshToken: null, expiresAtMs: null }, Date.now()),
    ).toBe(true);
  });

  test("rejects an absent token", () => {
    expect(
      isAccessTokenUsable({ accessToken: null, refreshToken: "r", expiresAtMs: null }, Date.now()),
    ).toBe(false);
  });
});

describe("findOAuthClientMatches", () => {
  // Shaped like the real runs of strings in the `agy` binary \u2014 candidates butt
  // straight up against their neighbours \u2014 but the values are invented, so this
  // repository carries no vendor secret.
  const GOOGLE_USERCONTENT = ["apps", "googleusercontent", "com"].join(".");
  const SAMPLE_CLIENT_SECRET_1 = ["GOCSPX", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("-");
  const SAMPLE_CLIENT_SECRET_2 = ["GOCSPX", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6"].join("-");
  const SAMPLE_CLIENT_ID_1 = [
    "123456789012",
    "abcdefghijklmnopqrstuvwxyz012345." + GOOGLE_USERCONTENT,
  ].join("-");
  const SAMPLE_CLIENT_ID_2 = [
    "987654321098",
    "zyxwvutsrqponmlkjihgfedcba543210." + GOOGLE_USERCONTENT,
  ].join("-");

  const BINARY_SLICE = Buffer.from(
    "MODEL_GOOGLE_GEMINI_TRAINING_POLICYhttps://auth.cloud.google/authorize" +
      SAMPLE_CLIENT_SECRET_1 +
      SAMPLE_CLIENT_SECRET_2 +
      "https://cloudcode-pa.googleapis.comnil media at index" +
      SAMPLE_CLIENT_ID_1 +
      "handleProgress" +
      SAMPLE_CLIENT_ID_2,
    "latin1",
  );

  function valuesAt(buffer: Buffer, matches: { offset: number; length: number }[]): string[] {
    return matches.map(({ offset, length }) => buffer.toString("latin1", offset, offset + length));
  }

  test("locates every client id and secret run together in the string table", () => {
    const found = findOAuthClientMatches(BINARY_SLICE);
    expect(valuesAt(BINARY_SLICE, found.clientIds)).toEqual([
      SAMPLE_CLIENT_ID_1,
      SAMPLE_CLIENT_ID_2,
    ]);
    expect(valuesAt(BINARY_SLICE, found.clientSecrets)).toEqual([
      SAMPLE_CLIENT_SECRET_1,
      SAMPLE_CLIENT_SECRET_2,
    ]);
  });

  test("reports offsets relative to the whole file, not the chunk", () => {
    const base = 8 * 1024 * 1024;
    const shifted = findOAuthClientMatches(BINARY_SLICE, base);
    const unshifted = findOAuthClientMatches(BINARY_SLICE);
    expect(shifted.clientSecrets.map((match) => match.offset - base)).toEqual(
      unshifted.clientSecrets.map((match) => match.offset),
    );
    expect(shifted.clientIds.map((match) => match.offset - base)).toEqual(
      unshifted.clientIds.map((match) => match.offset),
    );
  });

  test("ignores a truncated secret", () => {
    expect(findOAuthClientMatches(Buffer.from("GOCSPX-tooshort")).clientSecrets).toEqual([]);
  });

  test("ignores a suffix with no client id in front of it", () => {
    expect(findOAuthClientMatches(Buffer.from("x.apps.googleusercontent.com")).clientIds).toEqual(
      [],
    );
  });

  test("finds nothing in a slice with no OAuth client", () => {
    expect(findOAuthClientMatches(Buffer.from("no credentials here"))).toEqual({
      clientIds: [],
      clientSecrets: [],
    });
  });
});

describe("isOAuthCacheFresh", () => {
  const STAT = { size: 208_183_552, mtimeMs: 1_772_366_400_000 };
  const BINARY = "/home/user/.local/bin/agy";
  const CACHE = {
    version: 1,
    binaryPath: BINARY,
    size: STAT.size,
    mtimeMs: STAT.mtimeMs,
    clientIds: [{ offset: 92_005_391, length: 72 }],
    clientSecrets: [{ offset: 91_425_648, length: 35 }],
  };

  test("accepts a cache written for this exact file", () => {
    expect(isOAuthCacheFresh(CACHE, BINARY, STAT)).toBe(true);
  });

  test("rejects a cache written before the binary was updated", () => {
    expect(isOAuthCacheFresh(CACHE, BINARY, { ...STAT, mtimeMs: STAT.mtimeMs + 1 })).toBe(false);
  });

  test("rejects a cache whose size no longer matches", () => {
    expect(isOAuthCacheFresh(CACHE, BINARY, { ...STAT, size: STAT.size + 1 })).toBe(false);
  });

  test("rejects a cache written for a different install", () => {
    expect(isOAuthCacheFresh(CACHE, "/usr/local/bin/agy", STAT)).toBe(false);
  });

  test("rejects an older cache format", () => {
    expect(isOAuthCacheFresh({ ...CACHE, version: 0 }, BINARY, STAT)).toBe(false);
  });

  test("rejects a cache that found nothing, so an empty result is never reused", () => {
    expect(isOAuthCacheFresh({ ...CACHE, clientSecrets: [] }, BINARY, STAT)).toBe(false);
  });

  test("rejects a corrupt cache", () => {
    expect(isOAuthCacheFresh("not an object", BINARY, STAT)).toBe(false);
  });
});

describe("runPhase", () => {
  test("returns the phase result when it finishes in time", async () => {
    await expect(
      runPhase(startDeadline(1_000), "doing the thing", 500, async () => "done"),
    ).resolves.toBe("done");
  });

  test("names the phase and its budget when the phase hangs", async () => {
    await expect(
      runPhase(
        startDeadline(1_000),
        "reading the credential from the keyring",
        20,
        () => new Promise<never>(() => {}),
      ),
    ).rejects.toThrow("reading the credential from the keyring timed out after 0.0s");
  });

  test("aborts the signal it handed the phase, so a live socket is torn down", async () => {
    const handed: AbortSignal[] = [];
    await expect(
      runPhase(startDeadline(1_000), "fetching the quota summary", 20, (signal) => {
        handed.push(signal);
        return new Promise<never>(() => {});
      }),
    ).rejects.toThrow("timed out");
    expect(handed[0]?.aborted).toBe(true);
  });

  test("caps the phase at what is left of the probe budget, not its own cap", async () => {
    const deadline = startDeadline(30);
    const started = Date.now();
    await expect(
      runPhase(deadline, "refreshing the access token", 10_000, () => new Promise<never>(() => {})),
    ).rejects.toThrow("refreshing the access token timed out");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("refuses to start a phase once the budget is gone, naming it anyway", async () => {
    const spent = startDeadline(-1);
    let ran = false;
    await expect(
      runPhase(spent, "fetching the quota summary", 5_000, async () => {
        ran = true;
        return "unreachable";
      }),
    ).rejects.toThrow("fetching the quota summary never started");
    expect(ran).toBe(false);
  });
});

describe("mapQuotaSummary", () => {
  test("reports the recorded summary as used percentages in a fixed order", () => {
    expect(mapQuotaSummary(QUOTA_SUMMARY, SOURCE, FETCHED_AT)).toEqual({
      source: SOURCE,
      fetchedAt: FETCHED_AT,
      buckets: [
        {
          id: "gemini-5h",
          label: "Session",
          group: "Gemini Models",
          usedPercent: (1 - 0.9077114) * 100,
          resetsAt: "2026-08-28T22:11:13Z",
        },
        {
          id: "gemini-weekly",
          label: "Weekly",
          group: "Gemini Models",
          usedPercent: (1 - 0.7494267) * 100,
          resetsAt: "2026-09-01T20:00:00Z",
        },
        {
          id: "3p-5h",
          label: "Session",
          group: "Claude and GPT models",
          usedPercent: 0,
          resetsAt: "2026-08-28T22:51:48Z",
        },
        {
          id: "3p-weekly",
          label: "Weekly",
          group: "Claude and GPT models",
          usedPercent: 0,
          resetsAt: "2026-09-04T17:51:48Z",
        },
      ],
    });
  });

  test("keeps every bucket slot when the response omits one, so indexes never shift", () => {
    const partial = { groups: [{ displayName: "Gemini Models", buckets: [GEMINI_5H_BUCKET] }] };
    const result = mapQuotaSummary(partial, SOURCE, FETCHED_AT);
    expect(result.buckets.map((bucket) => bucket.id)).toEqual([
      "gemini-5h",
      "gemini-weekly",
      "3p-5h",
      "3p-weekly",
    ]);
    expect(result.buckets[0]?.usedPercent).toBeCloseTo(9.22886, 5);
    expect(result.buckets[1]).toEqual({
      id: "gemini-weekly",
      label: "Weekly",
      group: "Gemini Models",
      usedPercent: null,
      resetsAt: null,
    });
  });

  test("falls back to the built-in group name when the response omits it", () => {
    const noGroupName = { groups: [{ buckets: [{ bucketId: "3p-5h", remainingFraction: 0.5 }] }] };
    expect(mapQuotaSummary(noGroupName, SOURCE, FETCHED_AT).buckets[2]).toEqual({
      id: "3p-5h",
      label: "Session",
      group: "Claude and GPT models",
      usedPercent: 50,
      resetsAt: null,
    });
  });

  test("reports an exhausted bucket as fully used", () => {
    const exhausted = { groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0 }] }] };
    expect(mapQuotaSummary(exhausted, SOURCE, FETCHED_AT).buckets[0]?.usedPercent).toBe(100);
  });

  test("clamps a fraction outside 0..1 instead of emitting a nonsense percentage", () => {
    const odd = { groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 1.4 }] }] };
    expect(mapQuotaSummary(odd, SOURCE, FETCHED_AT).buckets[0]?.usedPercent).toBe(0);
  });

  test("drops a reset time that is not a date", () => {
    const bad = {
      groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.5, resetTime: "soon" }] }],
    };
    expect(mapQuotaSummary(bad, SOURCE, FETCHED_AT).buckets[0]?.resetsAt).toBeNull();
  });

  test("yields four null readings for a payload with no groups at all", () => {
    const result = mapQuotaSummary({ error: { code: 401 } }, SOURCE, FETCHED_AT);
    expect(result.buckets.every((bucket) => bucket.usedPercent === null)).toBe(true);
    expect(result.buckets).toHaveLength(4);
  });
});
