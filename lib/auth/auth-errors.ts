/**
 * lib/auth/auth-errors.ts
 *
 * The messages shown after a failed sign-in (?auth_error=<code>, set by the
 * auth routes). Pure and dependency-free, so both the root redirect and the
 * Deals page use it.
 *
 * The code comes from the URL, so it only ever selects one of our own
 * messages: anything unknown becomes "server_error", and nothing from the
 * URL is ever echoed back.
 */

export const AUTH_ERROR_MESSAGES = {
  cancelled: "Sign-in was cancelled. You can try again whenever you are ready.",
  invalid_state: "That sign-in attempt expired or was started in another tab. Please try again.",
  verification_failed: "Steam could not confirm that sign-in. Please try again.",
  rate_limited: "Too many sign-in attempts. Wait a minute, then try again.",
  server_error: "We could not finish signing you in. Please try again in a moment.",
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES;

/**
 * One of our codes for any ?auth_error= value, or null when there is none.
 * Repeated parameters use the first value.
 */
export function authErrorCode(raw: string | string[] | undefined): AuthErrorCode | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return null;
  return Object.prototype.hasOwnProperty.call(AUTH_ERROR_MESSAGES, value)
    ? (value as AuthErrorCode)
    : "server_error";
}

/** The message for a ?auth_error= value, or null when there is none. */
export function authErrorMessage(raw: string | string[] | undefined): string | null {
  const code = authErrorCode(raw);
  return code ? AUTH_ERROR_MESSAGES[code] : null;
}
