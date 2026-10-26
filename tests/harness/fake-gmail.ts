// A fake Gmail API + Google OAuth, in-process, for tests. Covers what PeetMail uses:
//
//   /oauth/authorize, /oauth/token      Google-style OAuth (PKCE; secret checked if set)
//   GET  /gmail/v1/users/me/profile
//   GET  .../messages?labelIds=&q=after:N&maxResults=&pageToken=
//   GET  .../messages/{id}?format=metadata|full
//   GET  .../messages/{id}/attachments/{attachmentId}
//   POST .../messages/{id}/modify | trash | untrash
//   GET  .../history?startHistoryId=     (404 when older than the kept history)
//   GET/POST .../labels
//
// Control API under /_test (deliver, label, delete, message?id=, state, config).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";

type Json = Record<string, any>;

export const GOOGLE_CLIENT_ID = "1234567890-fake.apps.googleusercontent.com";
export const GOOGLE_CLIENT_SECRET = "GOCSPX-fake-secret";
export const GMAIL_ACCOUNT = { name: "Boris Dragon", email: "boris.dragon@gmail.com" };

export type FakeGmailMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number; // ms
  from: string;
  to: string;
  cc?: string;
  subject: string;
  snippet: string;
  html?: string;
  /** Raw bytes of the html part, for charset tests (overrides html). */
  htmlBytes?: Buffer;
  htmlCharset?: string;
  text?: string;
  attachments?: { filename: string; mimeType: string; data: Buffer; cid?: string }[];
};

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** A small Gmail mailbox, relative to `now`. */
export function defaultGmail(now = Date.now()): FakeGmailMessage[] {
  const h = 3_600_000;
  const me = `${GMAIL_ACCOUNT.name} <${GMAIL_ACCOUNT.email}>`;
  return [
    { id: "g-1", threadId: "g-thread-trip", labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], internalDate: now - 1 * h, from: "Kim Park <kim@friends.example>", to: me, subject: "Ski trip in January", snippet: "Are you still keen? I found a lodge &amp; it&#39;s cheap.", html: "<p>Are you still keen? I found a lodge &amp; it's cheap.</p>" },
    { id: "g-2", threadId: "g-thread-trip", labelIds: ["INBOX", "CATEGORY_PERSONAL"], internalDate: now - 30 * 60_000, from: "Lee Wong <lee@friends.example>", to: me, cc: "\"Park, Kim\" <kim@friends.example>", subject: "Re: Ski trip in January", snippet: "Count me in.", text: "Count me in.\n\nLee" },
    { id: "g-3", threadId: "g-thread-sale", labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], internalDate: now - 3 * h, from: "Gear Shop <deals@gear.example>", to: me, subject: "=?UTF-8?B?V2ludGVyIHNhbGUg4p2E?=", snippet: "Up to 40% off jackets", html: "<p>Up to 40% off jackets</p>" },
    {
      id: "g-4", threadId: "g-thread-photos", labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], internalDate: now - 5 * h, from: "Mum <mum@family.example>", to: me, subject: "Photos from Sunday", snippet: "Here they are, and the plan.",
      html: '<p>Here they are, and the plan.</p><img src="cid:pixel@mum" alt="pixel">',
      attachments: [
        { filename: "pixel.png", mimeType: "image/png", data: PIXEL_PNG, cid: "pixel@mum" },
        { filename: "plan.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4 fake plan") },
      ],
    },
    { id: "g-5", threadId: "g-thread-latin", labelIds: ["INBOX", "CATEGORY_PERSONAL"], internalDate: now - 8 * h, from: "Café Lisboa <ola@cafe.example>", to: me, subject: "Reserva", snippet: "Obrigado pela reserva", htmlBytes: Buffer.from("<p>Caf\xe9 confirmado</p>", "latin1"), htmlCharset: "ISO-8859-1" },
    { id: "g-6", threadId: "g-thread-trip", labelIds: ["SENT"], internalDate: now - 45 * 60_000, from: me, to: "Kim Park <kim@friends.example>", subject: "Re: Ski trip in January", snippet: "Yes! Send me the link.", text: "Yes! Send me the link." },
    { id: "g-7", threadId: "g-thread-old-archived", labelIds: ["CATEGORY_PERSONAL"], internalDate: now - 20 * h, from: "Bank <no-reply@bank.example>", to: me, subject: "Statement ready", snippet: "Your statement is ready", text: "Your statement is ready" },
    { id: "g-8", threadId: "g-thread-ancient", labelIds: ["INBOX"], internalDate: now - 400 * 24 * h, from: "Old Friend <old@friends.example>", to: me, subject: "Long ago", snippet: "Remember this?", text: "Remember this?" },
  ];
}

function payloadOf(m: FakeGmailMessage, format: string): Json {
  const headers = [
    { name: "From", value: m.from },
    { name: "To", value: m.to },
    ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
    { name: "Subject", value: m.subject },
  ];
  const alt: Json[] = [];
  if (m.text) alt.push({ partId: "0.0", mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { size: m.text.length, data: b64u(m.text) } });
  if (m.html || m.htmlBytes) {
    const bytes = m.htmlBytes ?? Buffer.from(m.html!);
    alt.push({ partId: "0.1", mimeType: "text/html", filename: "", headers: [{ name: "Content-Type", value: `text/html; charset=${m.htmlCharset ?? "UTF-8"}` }], body: { size: bytes.length, data: b64u(bytes) } });
  }
  const atts = (m.attachments ?? []).map((a, i) => ({
    partId: String(i + 1),
    mimeType: a.mimeType,
    filename: a.filename,
    headers: [
      ...(a.cid ? [{ name: "Content-ID", value: `<${a.cid}>` }, { name: "Content-Disposition", value: `inline; filename=${a.filename}` }] : [{ name: "Content-Disposition", value: `attachment; filename=${a.filename}` }]),
    ],
    // Like Gmail: attachment ids change between fetches.
    body: { size: a.data.length, attachmentId: `att-${m.id}-${i}-${randomBytes(3).toString("hex")}` },
  }));
  const payload: Json = atts.length
    ? { mimeType: "multipart/mixed", headers, parts: [{ partId: "0", mimeType: "multipart/alternative", parts: alt }, ...atts] }
    : { mimeType: "multipart/alternative", headers, parts: alt };
  if (format === "metadata") {
    // Metadata keeps the structure's top level but no bodies.
    return { mimeType: payload.mimeType, headers };
  }
  return payload;
}

export async function startFakeGmail({ mailbox }: { mailbox?: FakeGmailMessage[] } = {}) {
  const state = {
    messages: new Map<string, FakeGmailMessage>(),
    labels: [] as { id: string; name: string; type: string }[],
    historyId: 1000,
    /** Oldest startHistoryId still answered (older ones get 404, like expired history). */
    minHistory: 0,
    history: [] as Json[],
    codes: new Map<string, { challenge: string; redirectUri: string }>(),
    tokens: new Set<string>(),
    refresh: new Set<string>(),
    config: { requireSecret: true, pageSize: 500 },
    requests: [] as { method: string; path: string; status: number }[],
    /** Writes the app made (modify, trash, label creation). */
    sent: [] as Json[],
  };
  for (const m of mailbox ?? defaultGmail()) state.messages.set(m.id, m);

  function log(entry: Json) {
    state.historyId++;
    state.history.push({ id: String(state.historyId), ...entry });
  }
  function changeLabels(m: FakeGmailMessage, add: string[], remove: string[]) {
    const added = add.filter((l) => !m.labelIds.includes(l));
    const removed = remove.filter((l) => m.labelIds.includes(l));
    m.labelIds = [...m.labelIds.filter((l) => !removed.includes(l)), ...added];
    if (added.length) log({ labelsAdded: [{ message: { id: m.id, threadId: m.threadId }, labelIds: added }] });
    if (removed.length) log({ labelsRemoved: [{ message: { id: m.id, threadId: m.threadId }, labelIds: removed }] });
  }
  const resource = (m: FakeGmailMessage, format: string) => ({
    id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.snippet, internalDate: String(m.internalDate), historyId: String(state.historyId), payload: payloadOf(m, format),
  });

  const server = createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: { message: String(e) } })));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const isHtml = typeof body === "string";
    res.writeHead(status, { "Content-Type": isHtml ? "text/html" : "application/json", ...headers });
    res.end(isHtml ? body : JSON.stringify(body));
  }
  async function readBody(req: IncomingMessage): Promise<Json> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    if (!raw) return {};
    if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
    return JSON.parse(raw);
  }
  const err = (status: number, message: string) => ({ error: { code: status, message, status: "ERROR" } });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", origin);
    const p = url.pathname;
    const method = req.method ?? "GET";
    const reply = (status: number, body: unknown, headers?: Record<string, string>) => {
      if (!p.startsWith("/_test")) state.requests.push({ method, path: p, status });
      send(res, status, body, headers);
    };

    if (p.startsWith("/_test/")) return control(req, url, reply);

    if (p === "/oauth/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== GOOGLE_CLIENT_ID) return reply(400, "<h1>Error 401: invalid_client</h1>");
      if (q.get("code_challenge_method") !== "S256") return reply(400, "<h1>PKCE required</h1>");
      if (q.get("access_type") !== "offline") return reply(400, "<h1>expected access_type=offline</h1>");
      const code = randomBytes(12).toString("base64url");
      state.codes.set(code, { challenge: q.get("code_challenge") ?? "", redirectUri: q.get("redirect_uri") ?? "" });
      const back = new URL(q.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      return reply(302, "", { Location: back.toString() });
    }
    if (p === "/oauth/token" && method === "POST") {
      const f = await readBody(req);
      if (f.client_id !== GOOGLE_CLIENT_ID) return reply(401, { error: "invalid_client", error_description: "The OAuth client was not found." });
      if (state.config.requireSecret && f.client_secret !== GOOGLE_CLIENT_SECRET) return reply(400, { error: "invalid_request", error_description: "client_secret is missing." });
      const issue = () => {
        const access = `g-at-${randomBytes(9).toString("hex")}`;
        const refresh = `g-rt-${randomBytes(9).toString("hex")}`;
        state.tokens.add(access);
        state.refresh.add(refresh);
        const idToken = `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify({ email: GMAIL_ACCOUNT.email, name: GMAIL_ACCOUNT.name }))}.`;
        return { access, refresh, idToken };
      };
      if (f.grant_type === "authorization_code") {
        const entry = state.codes.get(f.code);
        state.codes.delete(f.code);
        if (!entry || entry.redirectUri !== f.redirect_uri) return reply(400, { error: "invalid_grant", error_description: "Bad code" });
        if (createHash("sha256").update(f.code_verifier ?? "").digest("base64url") !== entry.challenge) return reply(400, { error: "invalid_grant", error_description: "PKCE failed" });
        const t = issue();
        return reply(200, { access_token: t.access, refresh_token: t.refresh, expires_in: 3599, id_token: t.idToken, token_type: "Bearer" });
      }
      if (f.grant_type === "refresh_token") {
        if (!state.refresh.has(f.refresh_token)) return reply(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        const t = issue();
        // Google keeps the refresh token on refresh.
        return reply(200, { access_token: t.access, expires_in: 3599, token_type: "Bearer" });
      }
      return reply(400, { error: "unsupported_grant_type" });
    }

    const base = "/gmail/v1/users/me";
    if (!p.startsWith(base)) return reply(404, err(404, "Not found"));
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!state.tokens.has(token)) return reply(401, err(401, "Request had invalid authentication credentials."));
    const rest = p.slice(base.length);

    if (rest === "/profile") return reply(200, { emailAddress: GMAIL_ACCOUNT.email, messagesTotal: state.messages.size, historyId: String(state.historyId) });

    if (rest === "/messages" && method === "GET") {
      const label = url.searchParams.get("labelIds");
      const after = Number((url.searchParams.get("q") ?? "").match(/after:(\d+)/)?.[1] ?? 0) * 1000;
      const size = Math.min(Number(url.searchParams.get("maxResults") ?? 100), state.config.pageSize);
      const all = [...state.messages.values()]
        .filter((m) => (!label || m.labelIds.includes(label)) && m.internalDate > after)
        .sort((a, b) => b.internalDate - a.internalDate);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const page = all.slice(start, start + size);
      return reply(200, {
        ...(page.length ? { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}),
        ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
        resultSizeEstimate: all.length,
      });
    }

    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\/messages\/([^/]+)$/)) && method === "GET") {
      const msg = state.messages.get(m[1]);
      if (!msg) return reply(404, err(404, "Requested entity was not found."));
      return reply(200, resource(msg, url.searchParams.get("format") ?? "full"));
    }
    if ((m = rest.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)$/))) {
      const msg = state.messages.get(m[1]);
      const idx = Number(m[2].split("-").at(-2));
      const a = msg?.attachments?.[idx];
      if (!a) return reply(404, err(404, "Requested entity was not found."));
      return reply(200, { size: a.data.length, data: b64u(a.data) });
    }
    if ((m = rest.match(/^\/messages\/([^/]+)\/(modify|trash|untrash)$/)) && method === "POST") {
      const msg = state.messages.get(m[1]);
      if (!msg) return reply(404, err(404, "Requested entity was not found."));
      const b = await readBody(req);
      if (m[2] === "modify") changeLabels(msg, b.addLabelIds ?? [], b.removeLabelIds ?? []);
      if (m[2] === "trash") changeLabels(msg, ["TRASH"], ["INBOX"]);
      if (m[2] === "untrash") changeLabels(msg, ["INBOX"], ["TRASH"]);
      state.sent.push({ kind: m[2], id: msg.id, add: b.addLabelIds ?? [], remove: b.removeLabelIds ?? [] });
      return reply(200, resource(msg, "minimal"));
    }
    if (rest === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      if (start < state.minHistory) return reply(404, err(404, "Requested entity was not found."));
      return reply(200, { history: state.history.filter((h) => Number(h.id) > start), historyId: String(state.historyId) });
    }
    if (rest === "/labels" && method === "GET") return reply(200, { labels: [{ id: "INBOX", name: "INBOX", type: "system" }, ...state.labels] });
    if (rest === "/labels" && method === "POST") {
      const b = await readBody(req);
      const label = { id: `Label_${state.labels.length + 1}`, name: b.name, type: "user" };
      state.labels.push(label);
      state.sent.push({ kind: "create-label", ...b });
      return reply(200, label);
    }
    reply(404, err(404, `No fake route for ${method} ${rest}`));
  }

  let delivered = 0;
  async function control(req: IncomingMessage, url: URL, reply: (s: number, b: unknown) => void) {
    const route = url.pathname.slice("/_test/".length);
    const b = req.method === "POST" ? await readBody(req) : {};
    switch (route) {
      case "deliver": {
        const id = b.id ?? `g-new-${++delivered}`;
        const msg: FakeGmailMessage = {
          id, threadId: b.threadId ?? `g-thread-new-${delivered}`, labelIds: b.labelIds ?? ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], internalDate: Date.now(),
          from: b.from ?? "Kim Park <kim@friends.example>", to: GMAIL_ACCOUNT.email, subject: b.subject ?? `New ${delivered}`, snippet: b.snippet ?? "Just arrived", text: b.text ?? "Just arrived",
        };
        state.messages.set(id, msg);
        log({ messagesAdded: [{ message: { id, threadId: msg.threadId, labelIds: msg.labelIds } }] });
        return reply(200, { id });
      }
      case "label": {
        const msg = state.messages.get(b.id);
        if (!msg) return reply(404, { error: "no such message" });
        changeLabels(msg, b.add ?? [], b.remove ?? []);
        return reply(200, { labelIds: msg.labelIds });
      }
      case "delete": {
        const msg = state.messages.get(b.id);
        state.messages.delete(b.id);
        if (msg) log({ messagesDeleted: [{ message: { id: msg.id, threadId: msg.threadId } }] });
        return reply(200, {});
      }
      case "expire-history":
        state.minHistory = state.historyId + 1;
        return reply(200, {});
      case "config":
        Object.assign(state.config, b);
        return reply(200, state.config);
      default: {
        const id = url.searchParams.get("id");
        if (route.startsWith("message") && id) {
          const msg = state.messages.get(id);
          return msg ? reply(200, msg) : reply(404, { error: "no such message" });
        }
        reply(404, { error: `unknown control route ${route}` });
      }
    }
  }

  return {
    origin,
    gmailUrl: `${origin}/gmail/v1/users/me`,
    authUrl: `${origin}/oauth`,
    state,
    async control(route: string, body?: Json): Promise<any> {
      const res = await fetch(`${origin}/_test/${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`gmail control ${route}: ${res.status} ${await res.text()}`);
      return res.json();
    },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
