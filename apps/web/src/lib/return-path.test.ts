import { describe, expect, test } from "bun:test";
import { safeReturnPath, signInHref } from "./return-path.ts";

describe("safeReturnPath", () => {
  test.each([
    ["/gallery", "/gallery"],
    ["/lab?run=3#top", "/lab?run=3#top"],
    ["/encode/", "/encode/"],
  ])("keeps %s", (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });

  test.each([
    null,
    undefined,
    "",
    "gallery",
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "https://evil.com",
    "http://localhost/x",
    "javascript:alert(1)",
    "/.//evil.com",
    "/..//evil.com",
    "/./\\evil.com",
    "/%2f%2fevil.com",
    "/%2F/evil.com",
    "/%5cevil.com",
    "/ /evil.com",
    "/\r/evil.com",
    "/sign-in",
    "/sign-in?next=/gallery",
    "/sign-up/",
  ])("falls back to / for %p", (input) => {
    expect(safeReturnPath(input)).toBe("/");
  });
});

describe("signInHref", () => {
  test("encodes the return path", () => {
    expect(signInHref("/lab?a=1&b=2")).toBe("/sign-in?next=%2Flab%3Fa%3D1%26b%3D2");
  });

  test("omits next for the home page and unsafe paths", () => {
    expect(signInHref("/")).toBe("/sign-in");
    expect(signInHref("//evil.com")).toBe("/sign-in");
  });
});
