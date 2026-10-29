import { describe, expect, it } from "vitest";
import { hasOwnText, startingSignature, withoutSignature, withSignature } from "./signatures";

const sig = { address: "boris@peetmail.test", html: "<p>Boris</p>", replies: false, managed: false };

describe("startingSignature", () => {
  it("goes on new messages, and on replies and forwards only when chosen", () => {
    expect(startingSignature(sig, "new")).toBe("<p>Boris</p>");
    for (const kind of ["reply", "replyAll", "forward"] as const) {
      expect(startingSignature(sig, kind)).toBe("");
      expect(startingSignature({ ...sig, replies: true }, kind)).toBe("<p>Boris</p>");
    }
  });

  it("is never added when the organisation adds one, or there's none", () => {
    expect(startingSignature({ ...sig, managed: true, replies: true }, "new")).toBe("");
    expect(startingSignature(null, "new")).toBe("");
  });
});

describe("the signature block", () => {
  it("goes after the text, with a line to type on when there's none", () => {
    expect(withSignature("", "<p>Boris</p>")).toBe('<p></p><div class="peetmail_signature"><p>Boris</p></div>');
    expect(withSignature("<p>Hi</p>", "<p>Boris</p>")).toBe('<p>Hi</p><div class="peetmail_signature"><p>Boris</p></div>');
    expect(withSignature("<p>Hi</p>", "")).toBe("<p>Hi</p>");
  });

  it("doesn't count as text you've written", () => {
    const html = withSignature("", "<p><strong>Boris</strong></p><p>Peet</p>");
    expect(withoutSignature(html)).toBe("<p></p>");
    expect(hasOwnText(html)).toBe(false);
    expect(hasOwnText(withSignature("<p>Thanks</p>", "<p>Boris</p>"))).toBe(true);
    expect(hasOwnText("<p>&nbsp;</p>")).toBe(false);
  });
});
