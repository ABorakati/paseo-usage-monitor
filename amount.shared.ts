import type { UsageUnit } from "./limits.shared";

/**
 * How one amount reads on a card. Money keeps its cents because a spend of
 * $0.13 is not zero; counts are whole because a third of a token means
 * nothing; and a big count is grouped rather than abbreviated, so 75,039,832
 * stays comparable against 32,652,978 at a glance.
 */
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

export function formatUsageAmount(
  amount: number,
  unit: UsageUnit,
  currency: string | null = null,
): string {
  if (unit === "percent") {
    return Number.isInteger(amount) ? `${amount}%` : `${amount.toFixed(1)}%`;
  }
  if (unit !== "usd") return Math.round(amount).toLocaleString();
  const code = currency === null ? "USD" : currency.toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol === undefined ? `${amount.toFixed(2)} ${code}` : `${symbol}${amount.toFixed(2)}`;
}
