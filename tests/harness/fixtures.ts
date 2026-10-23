// Deterministic mailbox fixtures for the fake Graph server.
// Dates are relative to `now` so "today" rows always exist; content is seeded so
// screenshots stay stable between runs.

export type Sender = [name: string, address: string];

export type GraphMessage = {
  id: string;
  conversationId: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  toRecipients: { emailAddress: { name: string; address: string } }[];
  ccRecipients: { emailAddress: { name: string; address: string } }[];
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  flag: { flagStatus: "flagged" | "notFlagged" | "complete" };
  hasAttachments: boolean;
  importance: string;
  inferenceClassification: string;
  body: { contentType: "html" | "text"; content: string };
};

type Variant = "default" | "newsletter" | "hostile" | "quoted" | "plain";

const SENDERS: Sender[] = [
  ["Sam Carter", "sam.carter@contoso.com"],
  ["Priya Nair", "priya@fabrikam.io"],
  ["GitHub", "noreply@github.com"],
  ["Linear", "notifications@linear.app"],
  ["Mum", "mum@outlook.com"],
  ["Jordan Lee", "jordan.lee@contoso.com"],
  ["Stripe", "receipts@stripe.com"],
  ["Hannah Okafor", "hannah@northwind.dev"],
  ["Calendar", "calendar-noreply@contoso.com"],
  ["The Beetroot Weekly", "hello@beetroot.news"],
];

const SUBJECTS = [
  "Q4 planning doc, first pass",
  "Re: Beetroot supplier contract",
  "[peetmail] CI failed on main",
  "Your receipt from Stripe #4471-2210",
  "Lunch Friday?",
  "Design review notes",
  "Invoice overdue: October",
  "Weekend plans",
  "Offsite agenda (draft)",
  "This week in beetroot: 12 recipes",
  "Can you review my PR?",
  "Flight itinerary: SYD to MEL",
  "Quarterly security training reminder",
  "Photos from Saturday",
  "Re: Re: API rate limits",
];

const SNIPPETS = [
  "Had a look at the numbers and I think we can make the timeline work if we drop the second milestone.",
  "Quick one: are you free for 15 minutes this afternoon to go through the open questions?",
  "Attached is the latest version. Main changes are in section 3, everything else is formatting.",
  "Thanks for sending this over. I've left a few comments inline, nothing blocking.",
  "Reminder that this is due by end of week. Let me know if anything is unclear.",
  "Here's the summary from today's call, plus the action items we agreed on.",
];

/** Small seeded PRNG (mulberry32) so fixtures are identical on every run. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, list: T[]): T => list[Math.floor(r() * list.length)];
const addr = ([name, address]: Sender) => ({ emailAddress: { name, address } });
const ME: Sender = ["Boris Dragon", "boris@peetmail.test"];

function htmlBody(subject: string, snippet: string, variant: Variant): string {
  switch (variant) {
    case "newsletter":
      return `<table width="100%" bgcolor="#f4efe6" cellpadding="24"><tr><td align="center">
        <h1 style="color:#7a1f3d;font-family:Georgia,serif">The Beetroot Weekly</h1>
        <img src="https://tracker.example/pixel.gif" width="1" height="1" alt="">
        <img src="https://images.example/hero.jpg" alt="Roasted beetroot" width="480">
        <p style="font-size:16px">${snippet}</p>
        <a href="https://beetroot.news/recipes" style="background:#7a1f3d;color:#fff;padding:10px 18px;text-decoration:none">Read the recipes</a>
      </td></tr></table>`;
    case "hostile":
      return `<p>${snippet}</p>
        <script>window.__pwned = true; alert("xss")</script>
        <img src="x" onerror="window.__pwned = true">
        <a href="javascript:window.__pwned=true">click me</a>
        <iframe src="https://evil.example"></iframe>`;
    case "quoted":
      return `<p>${snippet}</p><p>Cheers,<br>Sam</p>
        <blockquote><p>On Tue, Boris wrote:</p><p>Sounds good, let's lock it in.</p></blockquote>`;
    default:
      return `<div style="font-family:Segoe UI,sans-serif"><p>Hi Boris,</p><p>${snippet}</p>
        <p>More detail at <a href="https://example.com/doc/${encodeURIComponent(subject)}">the doc</a>.</p>
        <p>Thanks!</p></div>`;
  }
}

/**
 * Builds the default mailbox: ~120 conversations over ~120 days, some multi-message
 * threads, unread, flagged and attachment variety, plus a few special messages
 * tests can target by id:
 *   msg-hostile     HTML with scripts/handlers that must be stripped
 *   msg-newsletter  remote images that must be blocked
 *   msg-plain       text/plain body
 *   conv-thread-*   conversation with 4 messages
 */
export function defaultMailbox({ now = Date.now(), count = 160, seed = 42 }: { now?: number; count?: number; seed?: number } = {}): GraphMessage[] {
  const r = rng(seed);
  const messages: GraphMessage[] = [];
  const HOUR = 3600_000;

  const special: { id: string; conv: string; sender: Sender; subject: string; variant: Variant; ageH: number; isRead: boolean }[] = [
    { id: "msg-hostile", conv: "conv-hostile", sender: SENDERS[7], subject: "Weird formatting in this one", variant: "hostile", ageH: 0.5, isRead: false },
    { id: "msg-newsletter", conv: "conv-newsletter", sender: SENDERS[9], subject: "This week in beetroot: 12 recipes", variant: "newsletter", ageH: 2, isRead: false },
    { id: "msg-plain", conv: "conv-plain", sender: SENDERS[4], subject: "Weekend plans", variant: "plain", ageH: 5, isRead: true },
  ];
  for (const s of special) {
    messages.push(makeMessage({
      id: s.id, conversationId: s.conv, sender: s.sender, subject: s.subject,
      receivedAt: now - s.ageH * HOUR, isRead: s.isRead, variant: s.variant, snippet: SNIPPETS[0],
    }));
  }

  // One long thread so the reader's collapse/expand logic has something to chew on.
  for (let i = 0; i < 4; i++) {
    messages.push(makeMessage({
      id: `msg-thread-${i}`, conversationId: "conv-thread-1", sender: i % 2 ? SENDERS[0] : SENDERS[5],
      subject: i ? "Re: Offsite agenda (draft)" : "Offsite agenda (draft)",
      receivedAt: now - (30 - i * 6) * HOUR, isRead: i < 3, variant: i === 3 ? "quoted" : "default",
      snippet: SNIPPETS[i % SNIPPETS.length],
    }));
  }

  for (let i = 0; messages.length < count; i++) {
    const sender = pick(r, SENDERS);
    const subject = pick(r, SUBJECTS);
    // Skewed towards recent mail, like a real inbox.
    const ageH = 8 + Math.pow(r(), 2) * 24 * 120;
    messages.push(makeMessage({
      id: `msg-${String(i).padStart(4, "0")}`,
      conversationId: r() < 0.15 && i > 0 ? `conv-${String(i - 1).padStart(4, "0")}` : `conv-${String(i).padStart(4, "0")}`,
      sender, subject, receivedAt: now - ageH * HOUR,
      isRead: r() > 0.25 || ageH > 24 * 14,
      isFlagged: r() < 0.06,
      hasAttachments: r() < 0.12,
      importance: r() < 0.05 ? "high" : "normal",
      variant: sender[0].includes("Weekly") ? "newsletter" : r() < 0.2 ? "quoted" : "default",
      snippet: pick(r, SNIPPETS),
    }));
  }
  return messages;
}

export type MessageSpec = {
  id: string;
  conversationId?: string;
  sender: Sender;
  subject: string;
  receivedAt: number;
  isRead?: boolean;
  isFlagged?: boolean;
  hasAttachments?: boolean;
  importance?: string;
  variant?: Variant;
  snippet?: string;
};

export function makeMessage({
  id, conversationId, sender, subject, receivedAt, isRead = false, isFlagged = false,
  hasAttachments = false, importance = "normal", variant = "default", snippet = SNIPPETS[1],
}: MessageSpec): GraphMessage {
  const plain = variant === "plain";
  return {
    id,
    conversationId: conversationId ?? `conv-${id}`,
    subject,
    from: addr(sender),
    toRecipients: [addr(ME)],
    ccRecipients: [],
    receivedDateTime: new Date(receivedAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
    bodyPreview: snippet.slice(0, 120),
    isRead,
    flag: { flagStatus: isFlagged ? "flagged" : "notFlagged" },
    hasAttachments,
    importance,
    inferenceClassification: "focused",
    body: plain
      ? { contentType: "text", content: `Hey love,\n\n${snippet}\n\n<not a tag> & see you Sunday.\nMum` }
      : { contentType: "html", content: htmlBody(subject, snippet, variant) },
  };
}

export const ACCOUNT = { displayName: ME[0], mail: ME[1] };
