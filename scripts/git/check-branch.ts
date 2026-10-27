import { BRANCH_PATTERN, currentBranch, fail, UNTICKETED_BRANCHES } from "./conventions.ts";

const branch = Bun.argv[2] ?? (await currentBranch());
if (!UNTICKETED_BRANCHES.has(branch) && !BRANCH_PATTERN.test(branch)) {
  fail([
    `Invalid branch name: "${branch}"`,
    "Expected: ST-<number>-short-kebab-description (e.g. ST-44-set-user-permissions)",
    "Create it from the issue: gh issue develop <number> --name ST-<number>-… --checkout",
  ]);
}
