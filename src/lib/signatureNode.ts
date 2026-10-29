// The composer's signature: a block at the end of the message holding the account's
// signature, edited like the rest of the text. Isolating, so Backspace and Delete at its
// edge don't merge it into what you wrote.
import { Node } from "@tiptap/core";
import { SIGNATURE_CLASS } from "./signatures";

export const SignatureNode = Node.create({
  name: "signature",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: `div.${SIGNATURE_CLASS}` }],
  renderHTML: () => ["div", { class: SIGNATURE_CLASS }, 0],
});
