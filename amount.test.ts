import { describe, expect, test } from "vitest";
import { formatUsageAmount } from "./amount.shared";

describe("formatUsageAmount", () => {
  test("keeps cents on money, so a small spend does not read as nothing", () => {
    expect(formatUsageAmount(1.489, "usd")).toBe("$1.49");
    expect(formatUsageAmount(0.126, "usd")).toBe("$0.13");
  });

  test("names a currency the symbol table does not carry", () => {
    expect(formatUsageAmount(12.5, "usd", "jpy")).toBe("12.50 JPY");
  });

  test("groups a large count rather than abbreviating it", () => {
    expect(formatUsageAmount(75_039_832, "tokens")).toBe((75_039_832).toLocaleString());
  });

  test("rounds a count, because a fractional token means nothing", () => {
    expect(formatUsageAmount(261.6, "requests")).toBe("262");
  });

  test("shows a decimal on a percentage only when there is one", () => {
    expect(formatUsageAmount(23, "percent")).toBe("23%");
    expect(formatUsageAmount(23.72, "percent")).toBe("23.7%");
  });
});
