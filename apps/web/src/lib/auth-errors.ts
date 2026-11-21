import { ApiRequestError } from "@/lib/api.ts";

export type AuthAction = "sign-in" | "sign-up";

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** What to tell the user when an auth request fails. Never says which of e-mail or password was wrong. */
export function authErrorMessage(error: unknown, action: AuthAction): string {
  if (error instanceof ApiRequestError) {
    switch (error.status) {
      case 0:
        return "Could not reach the server. Check your connection and try again.";
      case 400:
        return action === "sign-up"
          ? "Check the e-mail and password and try again."
          : "Check your e-mail and password and try again.";
      case 401:
        // Registering an e-mail that is already taken looks like a success, so the login that
        // follows is where the user finds out. The text must not confirm that the account exists.
        return action === "sign-up"
          ? "Your account could not be opened with these details. If you already have an account, sign in with its password."
          : "Invalid e-mail or password.";
      case 409:
        return "An account with this e-mail already exists. Sign in instead.";
      case 429:
        return error.retryAfterSeconds
          ? `Too many attempts. Try again in ${formatWait(error.retryAfterSeconds)}.`
          : "Too many attempts. Try again in a few minutes.";
    }
  }
  return "Something went wrong. Try again.";
}
