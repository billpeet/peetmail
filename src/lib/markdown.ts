// Markdown from the repo (the changelog, the user docs) as HTML for the app. The content is
// ours, but it still goes through DOMPurify: it's rendered into the app's own page.

import DOMPurify from "dompurify";
import { marked } from "marked";
import { api } from "./api";

/** Web and mail links, in-page anchors, and relative links to other docs (`privacy.md`). */
const SAFE_URL = /^(?:https?:|mailto:|#|(?:\.{1,2}\/)*[\w-]+\.md(?:#[\w-]*)?$)/i;

export function renderMarkdown(md: string, { inline = false } = {}): string {
  const html = (inline ? marked.parseInline(md, { async: false }) : marked.parse(md, { async: false, gfm: true })) as string;
  return DOMPurify.sanitize(html, { ALLOWED_URI_REGEXP: SAFE_URL, FORBID_TAGS: ["style", "img", "iframe", "form"] });
}

/** Click handler for rendered Markdown: links open in the browser, never in the app's window. */
export function openLinksExternally(e: MouseEvent) {
  const a = (e.target as Element | null)?.closest?.("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (/^(https?:|mailto:)/i.test(href)) api.openExternal(href);
}
