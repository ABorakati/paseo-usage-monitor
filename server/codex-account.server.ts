/**
 * The account id carried inside the bearer token itself. The token and the
 * separately resolved `accountId` can come from different harnesses and
 * different accounts, and the backend rejects that mismatch. The JWT payload
 * is the middle base64url segment; the signature is never checked because
 * this only reads a claim. A malformed token yields null instead of throwing,
 * and the token is never logged.
 */
export function accountIdFromToken(token: string): string | null {
  try {
    const segments = token.split(".");
    const payloadSegment = segments[1];
    if (payloadSegment === undefined) return null;
    const payload: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) return null;
    const auth = (payload as Record<string, unknown>)["https://api.openai.com/auth"];
    if (typeof auth !== "object" || auth === null) return null;
    const accountId = (auth as Record<string, unknown>)["chatgpt_account_id"];
    return typeof accountId === "string" && accountId !== "" ? accountId : null;
  } catch {
    return null;
  }
}
