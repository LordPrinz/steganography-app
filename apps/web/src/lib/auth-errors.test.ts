import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "./api.ts";
import { authErrorMessage, formatWait } from "./auth-errors.ts";

describe("authErrorMessage", () => {
  test("401 does not say which field was wrong", () => {
    const message = authErrorMessage(
      new ApiRequestError(401, "invalid_credentials", ""),
      "sign-in",
    );
    expect(message).toBe("Invalid e-mail or password.");
  });

  test("401 after sign-up does not confirm an existing account", () => {
    const message = authErrorMessage(
      new ApiRequestError(401, "invalid_credentials", ""),
      "sign-up",
    );
    expect(message).toContain("If you already have an account");
  });

  test("429 shows the Retry-After wait", () => {
    expect(authErrorMessage(new ApiRequestError(429, "rate_limited", "", 90), "sign-in")).toBe(
      "Too many attempts. Try again in 2 minutes.",
    );
    expect(authErrorMessage(new ApiRequestError(429, "rate_limited", ""), "sign-in")).toContain(
      "few minutes",
    );
  });

  test("network and unknown failures have their own text", () => {
    expect(authErrorMessage(new ApiRequestError(0, "network", ""), "sign-in")).toContain(
      "Could not reach",
    );
    expect(authErrorMessage(new Error("boom"), "sign-in")).toBe("Something went wrong. Try again.");
  });
});

test("formatWait", () => {
  expect(formatWait(1)).toBe("1 second");
  expect(formatWait(59)).toBe("59 seconds");
  expect(formatWait(60)).toBe("1 minute");
  expect(formatWait(61)).toBe("2 minutes");
});
