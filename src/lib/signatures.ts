// Signatures in the composer. The signature is part of the message's rich text, a
// `<div class="peetmail_signature">` at the end (the composer's Signature node), so drafts,
// undo send and server drafts carry it like any other text. Pure helpers.
import type { DraftKind, Signature } from "./api";

/** The signature block's class, here, in the composer's editor and in Rust's sanitizer. */
export const SIGNATURE_CLASS = "peetmail_signature";

const BLOCK = new RegExp(`<div class="${SIGNATURE_CLASS}">[\\s\\S]*</div>\\s*$`);

/** The signature HTML for a new message of `kind`, or "" for none. */
export function startingSignature(s: Signature | null, kind: DraftKind): string {
  // The organisation's mail server adds one; a second would show twice.
  if (!s || s.managed) return "";
  return kind === "new" || s.replies ? s.html : "";
}

/** Editor HTML with the signature block after it (an empty line first, to type on). */
export function withSignature(html: string, signature: string): string {
  if (!signature) return html;
  return `${html || "<p></p>"}<div class="${SIGNATURE_CLASS}">${signature}</div>`;
}

/** Editor HTML without its signature block. */
export function withoutSignature(html: string): string {
  return html.replace(BLOCK, "");
}

/** True when editor HTML has text of its own, not counting the signature. */
export function hasOwnText(html: string): boolean {
  return withoutSignature(html).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length > 0;
}
