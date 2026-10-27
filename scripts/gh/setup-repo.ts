// One-off: applies repository settings, branch rules and autolinks. Run locally:
//   bun run gh:setup-repo
const REQUIRED_CHECKS = ["Conventions", "Lint", "Typecheck", "Test", "Build web"];
const TOPICS = [
  "steganography",
  "image-processing",
  "dct",
  "dwt",
  "qim",
  "lsb",
  "jpeg",
  "bun",
  "typescript",
  "nextjs",
  "monorepo",
  "postgresql",
  "cloudflare-r2",
];

const { nameWithOwner: repo } = (await Bun.$`gh repo view --json nameWithOwner`.quiet().json()) as {
  nameWithOwner: string;
};

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `repos/${repo}${path}`;
  const result = body
    ? await Bun.$`gh api -X ${method} ${url} --input - < ${Buffer.from(JSON.stringify(body))}`.quiet()
    : await Bun.$`gh api -X ${method} ${url}`.quiet();
  const text = result.text();
  return text ? JSON.parse(text) : null;
}

await api("PATCH", "", {
  description:
    "Image steganography web app: hide and recover data using LSB, DCT (Koch–Zhao) and Haar DWT + QIM, with a robustness lab that benchmarks each method against JPEG compression, resizing and blur.",
  has_wiki: false,
  has_projects: true,
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  allow_auto_merge: true,
  allow_update_branch: true,
  delete_branch_on_merge: true,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "BLANK",
});
console.info("✓ settings: squash merge only (PR title), auto-delete branches, auto-merge");

await api("PUT", "/topics", { names: TOPICS });
console.info(`✓ topics: ${TOPICS.join(", ")}`);

const autolinks = (await api("GET", "/autolinks")) as { key_prefix: string }[];
if (!autolinks.some((a) => a.key_prefix === "ST-")) {
  await api("POST", "/autolinks", {
    key_prefix: "ST-",
    url_template: `https://github.com/${repo}/issues/<num>`,
    is_alphanumeric: false,
  });
}
console.info("✓ autolink: ST-<n> → issue #<n>");

await api("PUT", "/vulnerability-alerts");
await api("PUT", "/automated-security-fixes");
console.info("✓ Dependabot alerts and security updates");

const ruleset = {
  name: "main",
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  // Admins may merge their own PR without an approval (useful while working solo), never push directly.
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "required_linear_history" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: ["squash"],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: REQUIRED_CHECKS.map((context) => ({ context })),
      },
    },
  ],
};
const rulesets = (await api("GET", "/rulesets")) as { id: number; name: string }[];
const existing = rulesets.find((r) => r.name === ruleset.name);
await api(existing ? "PUT" : "POST", existing ? `/rulesets/${existing.id}` : "/rulesets", ruleset);
console.info(
  `✓ ruleset on main: PR + 1 approval, squash only, linear history, checks: ${REQUIRED_CHECKS.join(", ")}`,
);
