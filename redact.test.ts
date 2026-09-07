import { describe, expect, test } from "vitest";
import { redactSecrets } from "./redact.server";

describe("redactSecrets", () => {
  test("masks Bearer tokens", () => {
    const input = "Authorization: Bearer sk-ant-api03-abcdef1234567890xyz";
    const result = redactSecrets(input);
    expect(result).not.toContain("abcdef1234567890");
    expect(result).toBe("Authorization: Bearer sk-...xyz");
  });

  test("masks basic auth passwords in URLs", () => {
    const input = "https://myuser:supersecret123@api.example.com/v1/quota";
    const result = redactSecrets(input);
    expect(result).not.toContain("supersecret123");
    expect(result).toBe("https://myuser:[REDACTED]@api.example.com/v1/quota");
  });

  test("masks sensitive query parameters in URLs", () => {
    const input = "https://gateway.example.com/quota?apiKey=sk-1234567890abcdef&format=json";
    const result = redactSecrets(input);
    expect(result).not.toContain("1234567890abcdef");
    expect(result).toBe("https://gateway.example.com/quota?apiKey=sk-...def&format=json");
  });

  test("deeply redacts sensitive keys in objects", () => {
    const payload = {
      provider: "custom",
      credentials: {
        apiKey: "sk-proj-secrettoken9876543210",
        token: "short",
      },
      nested: [{ message: "failed with key sk-ant-secret1234567890" }],
    };

    const redacted = redactSecrets(payload);
    expect(redacted.credentials.apiKey).toBe("sk-...210");
    expect(redacted.credentials.token).toBe("[REDACTED]");
    expect(redacted.nested[0]?.message).toBe("failed with key sk-...890");
  });

  test("preserves non-sensitive primitives and nulls", () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets("normal error text")).toBe("normal error text");
  });
});
