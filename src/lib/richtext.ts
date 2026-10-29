// Conversions between the composer's rich text (Tiptap) and plain text. Each paragraph in
// the editor is a line (Enter starts a new one; an empty one is a blank line), the way
// Gmail's and Outlook's composers work, so plain text maps line for line.

/** The subset of Tiptap's JSON document the composer produces. */
export type RichNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: RichNode[];
};

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text as editor HTML: a paragraph per line. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `<p>${escape(line)}</p>`)
    .join("");
}

function inline(nodes: RichNode[] = []): string {
  return nodes
    .map((n) => {
      if (n.type === "hardBreak") return "\n";
      const text = n.text ?? "";
      const href = n.marks?.find((m) => m.type === "link")?.attrs?.href;
      return typeof href === "string" && href !== text && `mailto:${text}` !== href ? `${text} <${href}>` : text;
    })
    .join("");
}

/** Prefixes the first line with `first` and indents the rest to match. */
const indent = (text: string, first: string) =>
  text.split("\n").map((l, i) => (i ? " ".repeat(first.length) : first) + l).join("\n");

function block(n: RichNode): string {
  switch (n.type) {
    case "paragraph":
    case "heading":
    case "codeBlock":
      return inline(n.content);
    case "horizontalRule":
      return "---";
    case "blockquote":
      return lines(n.content).split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    case "bulletList":
      return (n.content ?? []).map((item) => indent(lines(item.content), "- ")).join("\n");
    case "orderedList": {
      const start = Number(n.attrs?.start ?? 1);
      return (n.content ?? []).map((item, i) => indent(lines(item.content), `${start + i}. `)).join("\n");
    }
    default:
      return n.content ? lines(n.content) : inline([n]);
  }
}

const lines = (nodes: RichNode[] = []) => nodes.map(block).join("\n");

/** The message as plain text: what the text/plain part carries. */
export function docToText(doc: RichNode): string {
  return lines(doc.content);
}
