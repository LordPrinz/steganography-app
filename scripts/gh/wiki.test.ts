import { describe, expect, test } from "bun:test";
import { buildWiki, type Doc, pageName, rewriteLinks } from "./wiki.ts";

const REPO = "https://github.com/acme/app";

const docs: Doc[] = [
  {
    path: "README.md",
    content: "# App\n\n- [Design](docs/DESIGN.md)\n- [Contributing](CONTRIBUTING.md#roles)\n",
  },
  { path: "CONTRIBUTING.md", content: "# Contributing\n\nSee [the API](apps/api).\n" },
  {
    path: "docs/DESIGN.md",
    content: "# Design\n\nADRs live in [`adr/`](adr).\n\n```\n[not](a-link.md)\n```\n",
  },
  {
    path: "docs/adr/0001-monorepo-on-bun.md",
    content:
      "# 1. Monorepo on Bun workspaces\n\n- **Status:** accepted\n\nSee [design](../DESIGN.md#goals).\n",
  },
];

const pages = new Map(docs.map((doc) => [doc.path, pageName(doc)]));

describe("wiki", () => {
  test.each([
    ["README.md", "Home"],
    ["CONTRIBUTING.md", "Contributing"],
    ["docs/DESIGN.md", "Design"],
    ["docs/adr/0001-monorepo-on-bun.md", "ADR-0001-Monorepo-on-Bun-workspaces"],
  ])("names %p as %p", (file, name) => {
    expect(pages.get(file)).toBe(name);
  });

  test("points doc links at wiki pages and keeps anchors", () => {
    expect(rewriteLinks("[d](../DESIGN.md#goals)", "docs/adr/0001-x.md", pages, REPO)).toBe(
      "[d](Design#goals)",
    );
    expect(rewriteLinks("[c](/CONTRIBUTING.md)", "docs/DESIGN.md", pages, REPO)).toBe(
      "[c](Contributing)",
    );
  });

  test("points code links at main and leaves external links alone", () => {
    expect(rewriteLinks("[api](apps/api/)", "README.md", pages, REPO)).toBe(
      `[api](${REPO}/blob/main/apps/api)`,
    );
    expect(rewriteLinks("[b](https://bun.com) [g](#goals)", "README.md", pages, REPO)).toBe(
      "[b](https://bun.com) [g](#goals)",
    );
  });

  test("leaves code blocks untouched", () => {
    const design = buildWiki(docs, REPO).find((page) => page.name === "Design");
    expect(design?.content).toContain("[not](a-link.md)");
    expect(design?.content).toContain("[`adr/`](Home#architecture-decision-records)");
  });

  test("builds Home with the ADR index, plus sidebar and footer", () => {
    const wiki = buildWiki(docs, REPO);
    expect(wiki.map((page) => page.name)).toEqual([
      "Home",
      "Contributing",
      "Design",
      "ADR-0001-Monorepo-on-Bun-workspaces",
      "_Sidebar",
      "_Footer",
    ]);
    const home = wiki[0]?.content ?? "";
    expect(home).toContain("[Design](Design)");
    expect(home).toContain("[Contributing](Contributing#roles)");
    expect(home).toContain(
      "| [0001](ADR-0001-Monorepo-on-Bun-workspaces) | Monorepo on Bun workspaces | accepted |",
    );
    expect(wiki[4]?.content).toContain("- [Design](Design)");
  });
});
