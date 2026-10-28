import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { DOC_SLUGS, HELP_PAGES, parseDoc, relativeLinks, resolveLink } from "./docs";

const DIR = "docs/user";
const read = (f: string) => readFileSync(`${DIR}/${f}`, "utf8");

describe("parseDoc", () => {
  it("takes the first heading as the title and leaves the rest", () => {
    expect(parseDoc("x", "<!-- note -->\n# Getting started\n\nHello.\n\n## More")).toEqual({ slug: "x", title: "Getting started", body: "Hello.\n\n## More" });
  });
});

describe("resolveLink", () => {
  it("knows Help pages, the changelog and web links", () => {
    expect(resolveLink("privacy.md")).toEqual({ kind: "page", page: "privacy" });
    expect(resolveLink("./updates.md#stable-and-canary")).toEqual({ kind: "page", page: "updates" });
    expect(resolveLink("../../CHANGELOG.md")).toEqual({ kind: "page", page: "whats-new" });
    expect(resolveLink("https://example.com/x")).toEqual({ kind: "external", url: "https://example.com/x" });
    expect(resolveLink("../PLAN.md")).toEqual({ kind: "none" });
    expect(resolveLink("javascript:alert(1)")).toEqual({ kind: "none" });
  });
});

describe("the real docs", () => {
  it("every doc page exists and has a title", () => {
    for (const slug of DOC_SLUGS) {
      expect(existsSync(`${DIR}/${slug}.md`), `${slug}.md`).toBe(true);
      expect(parseDoc(slug, read(`${slug}.md`)).title, slug).not.toBe(slug);
    }
    expect(DOC_SLUGS.every((s) => (HELP_PAGES as readonly string[]).includes(s))).toBe(true);
  });

  it("every Markdown file in docs/user is a page (or the index)", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
    expect(files.map((f) => f.replace(/\.md$/, "")).sort()).toEqual([...DOC_SLUGS].sort());
  });

  it("every relative link goes to another Help page", () => {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith(".md"))) {
      for (const href of relativeLinks(read(f))) {
        expect(resolveLink(href).kind, `${f}: ${href}`).toBe("page");
      }
    }
  });
});
