import { describe, expect, it } from "vitest";
import { docToText, textToHtml, type RichNode } from "./richtext";

const p = (...content: RichNode[]): RichNode => ({ type: "paragraph", content });
const t = (text: string, marks?: RichNode["marks"]): RichNode => ({ type: "text", text, marks });
const br: RichNode = { type: "hardBreak" };
const doc = (...content: RichNode[]): RichNode => ({ type: "doc", content });

describe("textToHtml", () => {
  it("makes a paragraph of every line, blank ones included, escaped", () => {
    expect(textToHtml("Hi <Sam>,\r\n\r\nLine one\nLine two")).toBe("<p>Hi &lt;Sam&gt;,</p><p></p><p>Line one</p><p>Line two</p>");
  });
});

describe("docToText", () => {
  it("is a line per paragraph; an empty paragraph is a blank line", () => {
    expect(docToText(doc(p(t("Hi Sam,")), p(), p(t("Line one"), br, t("Line two"))))).toBe("Hi Sam,\n\nLine one\nLine two");
  });

  it("sets the signature off with a blank line and \"-- \"; an emptied one adds nothing", () => {
    const sig = (...content: RichNode[]): RichNode => ({ type: "signature", content });
    expect(docToText(doc(p(t("Thanks!")), sig(p(t("Boris"), br, t("Peet Software")))))).toBe("Thanks!\n\n-- \nBoris\nPeet Software");
    expect(docToText(doc(p(t("Thanks!")), sig(p())))).toBe("Thanks!\n");
  });

  it("round-trips plain text", () => {
    const text = "Thai on Friday?\n\nB\n";
    const paras = text.split("\n").map((l) => (l ? p(t(l)) : p()));
    expect(docToText(doc(...paras))).toBe(text);
    expect(textToHtml(text)).toBe("<p>Thai on Friday?</p><p></p><p>B</p><p></p>");
  });

  it("ignores formatting but spells out links", () => {
    const link = (href: string) => [{ type: "link", attrs: { href } }];
    expect(docToText(doc(p(t("see "), t("bold", [{ type: "bold" }]), t(" "), t("the plan", link("https://x.com/plan")))))).toBe(
      "see bold the plan <https://x.com/plan>",
    );
    expect(docToText(doc(p(t("https://x.com", link("https://x.com")))))).toBe("https://x.com");
    expect(docToText(doc(p(t("sam@x.com", link("mailto:sam@x.com")))))).toBe("sam@x.com");
  });

  it("writes lists and quotes the way plain-text mail does", () => {
    const item = (...content: RichNode[]): RichNode => ({ type: "listItem", content });
    const text = docToText(
      doc(
        p(t("Agenda:")),
        { type: "bulletList", content: [item(p(t("budget"))), item(p(t("hiring"), br, t("(two roles)")))] },
        { type: "orderedList", attrs: { start: 3 }, content: [item(p(t("third"))), item(p(t("fourth")))] },
        { type: "blockquote", content: [p(t("quoted")), p(), p(t("more"))] },
      ),
    );
    expect(text).toBe("Agenda:\n- budget\n- hiring\n  (two roles)\n3. third\n4. fourth\n> quoted\n>\n> more");
  });

  it("is empty for an empty editor", () => {
    expect(docToText(doc(p()))).toBe("");
  });
});
