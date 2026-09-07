/**
 * Every failure a usage provider can produce is one of these. The service
 * turns them into a per-provider error row, so the message is what the user
 * reads: it names the credential, variable, preset or path that needs
 * attention, and never the value it resolved.
 */

function describeSources(tried: readonly string[]): string {
  if (tried.length === 0) return "no sources are configured";
  return tried.join(", ");
}

export class UsageCredentialMissingError extends Error {
  constructor(
    readonly credentialName: string,
    readonly tried: readonly string[],
  ) {
    super(`Credential "${credentialName}" did not resolve from ${describeSources(tried)}`);
    this.name = "UsageCredentialMissingError";
  }
}

export class UsageInterpolationError extends Error {
  constructor(
    template: string,
    readonly variable: string,
  ) {
    super(`Environment variable ${variable} is not set, required by "${template}"`);
    this.name = "UsageInterpolationError";
  }
}

export class UsageSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "UsageSourceError";
    this.status = options?.status ?? null;
  }

  /** The HTTP status, when the failure came from one. Lets a caller branch on
   * a rejected credential without matching text. */
  readonly status: number | null;
}

/**
 * A provider that throttles its own quota endpoint. Anthropic's answers a 429
 * with a real `Retry-After` — 1495 seconds when observed live — so the service
 * waits exactly that long instead of guessing, and keeps the last readings on
 * screen while it waits.
 */
export class UsageRateLimitedError extends UsageSourceError {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UsageRateLimitedError";
  }
}

/**
 * A vendor that answered the request and then said no inside the body. The
 * transport worked and the credential was accepted, so neither of those
 * remedies applies; what the user needs is the vendor's own words and, where
 * the preset knows it, what they mean.
 */
export class UsageVendorError extends UsageSourceError {
  constructor(
    readonly vendorMessage: string | null,
    readonly hint: string | null,
  ) {
    super(
      vendorMessage === null
        ? "The provider reported an error in its response"
        : `The provider reported an error: ${vendorMessage}`,
    );
    this.name = "UsageVendorError";
  }
}

export class UsagePresetUnknownError extends Error {
  constructor(
    providerId: string,
    readonly presetId: string,
  ) {
    super(`Provider "${providerId}" names unknown preset "${presetId}"`);
    this.name = "UsagePresetUnknownError";
  }
}

export class UsageConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UsageConfigError";
  }
}
