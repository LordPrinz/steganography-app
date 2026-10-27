import { describe, expect, test } from "bun:test";
import {
  BRANCH_PATTERN,
  GENERATED_HEADER,
  HEADER_PATTERN,
  ticketFromBranch,
} from "./conventions.ts";

describe("git conventions", () => {
  test.each([
    "[ST-44] chore: Set user permissions",
    "[ST-1] feat(engine): Add LSB encoder",
    "[ST-120] fix(api)!: Reject oversized uploads",
  ])("accepts header %p", (header) => {
    expect(HEADER_PATTERN.test(header)).toBe(true);
  });

  test.each([
    "chore: Set user permissions",
    "[ST-44] chores: Set user permissions",
    "[ST-44] chore:Set user permissions",
    "[ST-44]chore: Set user permissions",
    "[ST-x] chore: Set user permissions",
    "[ST-44] chore: ok",
  ])("rejects header %p", (header) => {
    expect(HEADER_PATTERN.test(header)).toBe(false);
  });

  test("lets git-generated headers through", () => {
    expect(GENERATED_HEADER.test("Merge branch 'main' into ST-4-x")).toBe(true);
    expect(GENERATED_HEADER.test('Revert "[ST-4] feat: X"')).toBe(true);
  });

  test("validates branch names", () => {
    expect(BRANCH_PATTERN.test("ST-44-set-user-permissions")).toBe(true);
    expect(BRANCH_PATTERN.test("feature/login")).toBe(false);
    expect(BRANCH_PATTERN.test("ST-44-Set-User")).toBe(false);
  });

  test("extracts the ticket from a branch", () => {
    expect(ticketFromBranch("ST-44-set-user-permissions")).toBe("ST-44");
    expect(ticketFromBranch("main")).toBeUndefined();
  });
});
