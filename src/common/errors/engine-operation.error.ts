import { HttpException, BadGatewayException } from '@nestjs/common';

/**
 * Client-facing message for an engine operation (send / list / read) that failed with an unexpected,
 * NON-HTTP error thrown by the underlying WhatsApp engine — e.g. a whatsapp-web.js Puppeteer
 * "Evaluation failed: Cannot read properties of undefined" from a WA Web store that isn't fully synced
 * yet (common in the minutes after a fresh link), a dropped web socket, or a primitive string the
 * library throws instead of an Error. The raw engine/browser message is intentionally NOT forwarded to
 * the caller: it leaks library/browser internals (and, for some faults, resolved addresses) and is
 * meaningless to an API consumer. The real detail is logged server-side at the call site.
 */
export const ENGINE_OPERATION_FAILED_MESSAGE =
  'The WhatsApp engine could not complete the request. The session may be reconnecting or the ' +
  'WhatsApp Web client is temporarily out of sync — retry shortly, and restart the session if it persists.';

/**
 * Normalise an error thrown while invoking the WhatsApp engine into a client-facing HTTP error.
 *
 * Domain errors already carry the HTTP status the caller should see — EngineNotReadyError → 409,
 * MessageNotFoundError → 404, an SSRF/plugin-block BadRequest → 400, … — and are (as `HttpException`s)
 * returned unchanged. Anything else is a raw Error/string the engine or its embedded browser threw;
 * left alone it reaches NestJS's default handler as an opaque `500 Internal Server Error` (the
 * "OpenWA API HTTP 500: Internal server error" a downstream integration sees). Map it to a diagnostic
 * `502 Bad Gateway` instead, so the caller gets an actionable, retryable signal that the fault is in
 * the upstream WhatsApp engine, not in their request. Mirrors the auth-timeout → 504 mapping (#733).
 */
export function toEngineClientError(error: unknown): HttpException {
  if (error instanceof HttpException) {
    return error;
  }
  return new BadGatewayException(ENGINE_OPERATION_FAILED_MESSAGE);
}
