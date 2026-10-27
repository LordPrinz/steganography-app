import { COMMIT_TYPES, fail, GENERATED_HEADER, HEADER_PATTERN } from "./conventions.ts";

const [messageFile] = Bun.argv.slice(2);
if (!messageFile) fail(["commit-msg: missing message file argument"]);

const header =
  (await Bun.file(messageFile).text())
    .split("\n")
    .find((line) => line.trim() !== "" && !line.startsWith("#")) ?? "";

if (!GENERATED_HEADER.test(header) && !HEADER_PATTERN.test(header)) {
  fail([
    `Invalid commit message: "${header}"`,
    "Expected: [ST-<number>] <type>(<optional scope>): <Description>",
    `Types:    ${COMMIT_TYPES.join(", ")}`,
    "Example:  [ST-44] chore: Set user permissions",
    "Tip: commit from a branch named ST-<number>-… and the prefix is added for you.",
  ]);
}
