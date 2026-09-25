export class KimiApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "KimiApiError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

/** Map an API error to a human-readable, actionable message. Messages the
 *  client already made friendly ("kimiflare: …" — bad key, out of credits,
 *  moderation block, missing key) pass through; the rest are bucketed by
 *  HTTP status with any embedded JSON stripped. */
export function humanizeApiError(err: KimiApiError): string {
  const { code, httpStatus, message } = err;

  if (message.startsWith("kimiflare: ")) {
    return message.slice("kimiflare: ".length);
  }

  const codeStr = code !== undefined ? ` (code: ${code})` : "";

  if (httpStatus === 429) {
    return `Rate limit hit${codeStr}. Please wait a moment and try again — or pick a less busy model with /model.`;
  }

  if (httpStatus === 400) {
    if (message.includes("invalid escaped character")) {
      return `API rejected request${codeStr} (invalid JSON in conversation history). Run /clear to reset if it persists.`;
    }
    if (message.includes("Invalid model ID")) {
      return message; // already human-friendly
    }
    return `Bad request${codeStr}. The conversation may be too long or contain invalid characters. Run /compact or /clear.`;
  }

  if (httpStatus === 502 || httpStatus === 503) {
    return `No provider could serve this model right now${codeStr}. Try again shortly, or switch models with /model.`;
  }

  if (httpStatus && httpStatus >= 500) {
    return `The model provider is having issues${codeStr}. Please wait a moment and try again.`;
  }

  // Fallback: strip any embedded JSON so we don't dump raw objects to the user
  return message.replace(/\{[\s\S]*?\}/g, "(see logs for details)");
}
