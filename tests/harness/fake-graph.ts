// Fake Microsoft identity platform + Graph mail API for tests and offline dev.
// No dependencies. Implements just what PeetMail calls, with real semantics where
// it matters: PKCE verification, token expiry and refresh, delta paging with
// next/delta links, partial and @removed delta items, 429 throttling, 410 resync.
//
// Run standalone:  node tests/harness/fake-graph.ts [--port 4010]
// Control API (JSON): see `controlRoutes` below, or GET /_test for a summary.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  ACCOUNT,
  defaultMailbox,
  FOLDER_IDS,
  makeMessage,
  ME,
  PIXEL_PNG,
  type FolderName,
  type GraphMessage,
  type Sender,
} from "./fixtures.ts";
import { defaultCalendar, makeEvent, type GraphEvent } from "./calendar-fixtures.ts";

/** The only client ID the fake authority accepts. Anything else never redirects back, like Entra. */
export const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
export const INBOX_ID = FOLDER_IDS.inbox;

const FOLDER_NAMES: Record<FolderName, string> = {
  inbox: "Inbox",
  sentitems: "Sent Items",
  archive: "Archive",
  deleteditems: "Deleted Items",
};

const b64url = (buf: Uint8Array) => Buffer.from(buf).toString("base64url");

type Json = Record<string, any>;
type ChangeKind = "upsert" | "partial" | "remove";
type Change = { seq: number; id: string; kind: ChangeKind; fields?: Json; folders: string[] };
type Session = { items: Json[]; pageSize: number; deltaLink: string };
type Reply = (status: number, body: Json | string, headers?: Record<string, string>) => void;

export type RequestRecord = { method: string; path: string; query: string; status: number; at: number };

export type FakeConfig = {
  /** Return 400 for the delta `$filter`, like a tenant that doesn't support it. */
  rejectDeltaFilter: boolean;
  /** Next delta-link request returns 410 SyncStateNotFound (one-shot). */
  expireDelta: boolean;
  /** Access token lifetime in seconds. */
  tokenTtl: number;
  /** Delay added to every Graph response. */
  latencyMs: number;
  /** Message body requests return 500. */
  failBody: boolean;
  /** Every write (PATCH, move, send) fails with this status; 0 = off. */
  failWrites: number;
  /** Next calendar delta-link request returns 410 (one-shot). */
  expireCalendarDelta: boolean;
  /** Message delta leaves out "@odata.type" (the app must rely on meetingMessageType). */
  omitODataType: boolean;
  /** Message delta rejects the derived-type select (eventMessage/meetingMessageType) with 400. */
  rejectMeetingSelect: boolean;
};

export type FakeOptions = { port?: number; mailbox?: GraphMessage[]; count?: number; seed?: number; verbose?: boolean };

export async function startFakeGraph({ port = 0, mailbox, count, seed, verbose = false }: FakeOptions = {}) {
  const state = {
    messages: new Map<string, GraphMessage>(),
    seq: 0,
    changes: [] as Change[],
    sessions: new Map<string, Session>(),
    codes: new Map<string, { challenge: string; redirectUri: string }>(),
    accessTokens: new Map<string, number>(), // token -> expiresAt (ms)
    refreshTokens: new Set<string>(),
    throttle: [] as { status: number; retryAfter: number }[],
    config: { rejectDeltaFilter: false, expireDelta: false, tokenTtl: 3600, latencyMs: 0, failBody: false, failWrites: 0, expireCalendarDelta: false, omitODataType: false, rejectMeetingSelect: false } as FakeConfig,
    requests: [] as RequestRecord[],
    events: new Map<string, GraphEvent>(),
    eventSeq: 0,
    eventChanges: [] as { seq: number; id: string; removed: boolean }[],
    /** Writes the app made: sends, replies, moves, patches. */
    sent: [] as Json[],
  };

  const defaults = { count, seed };
  function reset({ count = defaults.count, seed = defaults.seed, messages }: { count?: number; seed?: number; messages?: GraphMessage[] } = {}) {
    state.messages.clear();
    state.changes = [];
    state.events.clear();
    state.eventChanges = [];
    state.eventSeq = 0;
    for (const e of defaultCalendar()) state.events.set(e.id, e);
    state.sent = [];
    state.sessions.clear();
    state.seq = 0;
    for (const m of messages ?? mailbox ?? defaultMailbox({ count, seed })) state.messages.set(m.id, m);
  }
  reset();

  const server = createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: { message: String(e) } })));
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let replyBytes: (status: number, bytes: Buffer, contentType: string) => void = () => {};

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const isHtml = typeof body === "string";
    res.writeHead(status, { "Content-Type": isHtml ? "text/html" : "application/json", ...headers });
    res.end(isHtml ? body : JSON.stringify(body));
  }

  async function readBody(req: IncomingMessage): Promise<Json> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    if (!raw) return {};
    if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
      return Object.fromEntries(new URLSearchParams(raw));
    }
    return JSON.parse(raw);
  }

  function record(req: IncomingMessage, url: URL, status: number) {
    state.requests.push({ method: req.method ?? "GET", path: url.pathname, query: url.search, status, at: Date.now() });
    if (verbose) console.log(`${status} ${req.method} ${url.pathname}${url.search}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", origin);
    const p = url.pathname;
    const reply: Reply = (status, body, headers) => {
      if (!p.startsWith("/_test")) record(req, url, status);
      send(res, status, body, headers);
    };
    replyBytes = (status, bytes, contentType) => {
      record(req, url, status);
      res.writeHead(status, { "Content-Type": contentType });
      res.end(bytes);
    };

    if (p.startsWith("/_test")) return control(req, res, url);
    if (p.startsWith("/oauth/")) return oauth(req, url, reply);
    if (p.startsWith("/img/")) {
      // Stand-in for a sender's image host (load-images tests).
      record(req, url, 200);
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(Buffer.from(PIXEL_PNG, "base64"));
    }
    if (p.startsWith("/v1.0/")) {
      if (state.config.latencyMs) await new Promise((r) => setTimeout(r, state.config.latencyMs));
      return graph(req, url, reply);
    }
    reply(404, { error: { code: "NotFound", message: p } });
  }

  // ---------- identity platform ----------

  async function oauth(req: IncomingMessage, url: URL, reply: Reply) {
    if (url.pathname === "/oauth/authorize") {
      const q = url.searchParams;
      if (q.get("client_id") !== CLIENT_ID) {
        // Entra shows an error page and never redirects for an unknown application.
        return reply(400, `<h1>AADSTS700016</h1><p>Application with identifier '${q.get("client_id")}' was not found.</p>`);
      }
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
        return reply(400, "<h1>PKCE required</h1>");
      }
      const code = b64url(randomBytes(16));
      const redirectUri = q.get("redirect_uri") ?? "";
      state.codes.set(code, { challenge: q.get("code_challenge") ?? "", redirectUri });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state") ?? "");
      return reply(302, "", { Location: back.toString() });
    }

    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const f = await readBody(req);
      if (f.client_id !== CLIENT_ID) return reply(400, { error: "unauthorized_client", error_description: "bad client" });
      if (f.grant_type === "authorization_code") {
        const entry = state.codes.get(f.code);
        state.codes.delete(f.code);
        if (!entry) return reply(400, { error: "invalid_grant", error_description: "unknown code" });
        if (entry.redirectUri !== f.redirect_uri) return reply(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
        const expected = b64url(createHash("sha256").update(f.code_verifier ?? "").digest());
        if (expected !== entry.challenge) return reply(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return reply(200, issueTokens());
      }
      if (f.grant_type === "refresh_token") {
        if (!state.refreshTokens.has(f.refresh_token)) return reply(400, { error: "invalid_grant", error_description: "refresh token revoked" });
        state.refreshTokens.delete(f.refresh_token); // rotate, like Entra
        return reply(200, issueTokens());
      }
      return reply(400, { error: "unsupported_grant_type" });
    }
    reply(404, { error: "not_found" });
  }

  function issueTokens() {
    const access = `at-${b64url(randomBytes(12))}`;
    const refresh = `rt-${b64url(randomBytes(12))}`;
    state.accessTokens.set(access, Date.now() + state.config.tokenTtl * 1000);
    state.refreshTokens.add(refresh);
    return { token_type: "Bearer", access_token: access, refresh_token: refresh, expires_in: state.config.tokenTtl, scope: "Mail.ReadWrite" };
  }

  // ---------- graph ----------

  function graphError(reply: Reply, status: number, code: string, message: string, headers?: Record<string, string>) {
    reply(status, { error: { code, message } }, headers);
  }

  async function graph(req: IncomingMessage, url: URL, reply: Reply) {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const exp = state.accessTokens.get(token);
    if (!exp || exp < Date.now()) return graphError(reply, 401, "InvalidAuthenticationToken", "Access token has expired or is not yet valid.");

    const t = state.throttle.shift();
    if (t) return graphError(reply, t.status, "TooManyRequests", "Throttled by test", { "Retry-After": String(t.retryAfter) });

    const p = url.pathname.replace(/^\/v1\.0/, "");
    const method = req.method ?? "GET";
    const isWrite = method !== "GET";
    if (isWrite && state.config.failWrites) {
      return graphError(reply, state.config.failWrites, "ErrorInternalServerError", "Write failed (test)");
    }

    if (p === "/me") return reply(200, { ...ACCOUNT, userPrincipalName: ACCOUNT.mail });
    if (p === "/me/calendarView/delta") return calendarDelta(req, url, reply);

    const folder = p.match(/^\/me\/mailFolders\/([^/]+)$/);
    if (folder) {
      const id = folderId(decodeURIComponent(folder[1]));
      if (!id) return graphError(reply, 404, "ErrorFolderNotFound", "Folder not found");
      const name = Object.entries(FOLDER_IDS).find(([, v]) => v === id)![0];
      return reply(200, { id, displayName: FOLDER_NAMES[name as FolderName] });
    }
    const deltaMatch = p.match(/^\/me\/mailFolders\/([^/]+)\/messages\/delta$/);
    if (deltaMatch) {
      const id = folderId(decodeURIComponent(deltaMatch[1]));
      if (!id) return graphError(reply, 404, "ErrorFolderNotFound", "Folder not found");
      return delta(req, url, reply, id);
    }

    if (method === "POST" && p === "/me/sendMail") {
      const b = await readBody(req);
      const m = b.message ?? {};
      sendCopy({ kind: "new", subject: m.subject ?? "", html: m.body?.content ?? "", to: m.toRecipients ?? [], cc: m.ccRecipients ?? [] });
      return reply(202, "");
    }

    const action = p.match(/^\/me\/messages\/([^/]+)\/(reply|replyAll|forward|move)$/);
    if (action && method === "POST") {
      const msg = state.messages.get(decodeURIComponent(action[1]));
      if (!msg) return graphError(reply, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
      const b = await readBody(req);
      if (action[2] === "move") {
        const dest = folderId(b.destinationId ?? "");
        if (!dest) return graphError(reply, 400, "ErrorInvalidIdMalformed", "Bad destinationId");
        const from = msg.parentFolderId;
        msg.parentFolderId = dest;
        change(msg.id, "upsert", undefined, [from, dest]);
        state.sent.push({ kind: "move", messageId: msg.id, destination: b.destinationId });
        return reply(201, metadata(msg));
      }
      const kind = action[2] as "reply" | "replyAll" | "forward";
      const others = (list: GraphMessage["toRecipients"]) => list.filter((r) => r.emailAddress.address !== ACCOUNT.mail);
      const to =
        b.toRecipients ?? b.message?.toRecipients ??
        (kind === "forward" ? [] : kind === "reply" ? [msg.from] : [msg.from, ...others(msg.toRecipients)]);
      const cc = b.message?.ccRecipients ?? (kind === "replyAll" ? others(msg.ccRecipients) : []);
      const prefix = kind === "forward" ? "FW: " : "RE: ";
      sendCopy({
        kind,
        messageId: msg.id,
        conversationId: msg.conversationId,
        subject: prefix + msg.subject.replace(/^(re|fw):\s*/i, ""),
        html: `${b.comment ?? ""}<hr><blockquote>${msg.body.content}</blockquote>`,
        to,
        cc,
      });
      return reply(202, "");
    }

    const eventGet = p.match(/^\/me\/events\/([^/]+)$/);
    if (eventGet && method === "GET") {
      const e = state.events.get(decodeURIComponent(eventGet[1]));
      if (!e) return graphError(reply, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
      return reply(200, fullForm(e));
    }

    const rsvp = p.match(/^\/me\/events\/([^/]+)\/(accept|tentativelyAccept|decline)$/);
    if (rsvp && method === "POST") {
      const e = state.events.get(decodeURIComponent(rsvp[1]));
      if (!e) return graphError(reply, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
      const b = await readBody(req);
      const status = { accept: "accepted", tentativelyAccept: "tentativelyAccepted", decline: "declined" }[rsvp[2]]!;
      e.responseStatus = { response: status, time: new Date().toISOString() };
      eventChange(e.id);
      state.sent.push({ kind: "rsvp", eventId: e.id, response: status, sendResponse: b.sendResponse });
      return reply(202, "");
    }

    const attachmentValue = p.match(/^\/me\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/);
    if (attachmentValue) {
      const msg = state.messages.get(decodeURIComponent(attachmentValue[1]));
      const att = msg?.attachments?.find((a) => a.id === decodeURIComponent(attachmentValue[2]));
      if (!att) return graphError(reply, 404, "ErrorItemNotFound", "Attachment not found");
      return replyBytes(200, Buffer.from(att.contentBytes, "base64"), att.contentType);
    }
    const attachments = p.match(/^\/me\/messages\/([^/]+)\/attachments$/);
    if (attachments) {
      const msg = state.messages.get(decodeURIComponent(attachments[1]));
      if (!msg) return graphError(reply, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
      let list = msg.attachments ?? [];
      if ((url.searchParams.get("$filter") ?? "").includes("isInline eq true")) list = list.filter((a) => a.isInline);
      const select = url.searchParams.get("$select");
      const value = list.map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        ...(select ? Object.fromEntries(Object.entries(a).filter(([k]) => select.split(",").includes(k))) : a),
      }));
      return reply(200, { value });
    }

    const m = p.match(/^\/me\/messages\/([^/]+)$/);
    if (m) {
      const msg = state.messages.get(decodeURIComponent(m[1]));
      if (!msg) return graphError(reply, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
      if (method === "PATCH") {
        const b = await readBody(req);
        const fields: Json = {};
        if ("isRead" in b) fields.isRead = msg.isRead = Boolean(b.isRead);
        if (b.flag?.flagStatus) fields.flag = msg.flag = { flagStatus: b.flag.flagStatus };
        change(msg.id, "partial", fields);
        state.sent.push({ kind: "patch", messageId: msg.id, fields });
        return reply(200, metadata(msg));
      }
      if ((url.searchParams.get("$expand") ?? "").includes("eventMessage/event")) {
        const event = msg.eventId ? state.events.get(msg.eventId) : undefined;
        return reply(200, {
          id: msg.id,
          meetingMessageType: msg.meetingMessageType ?? null,
          meetingRequestType: msg.meetingRequestType ?? null,
          previousStartDateTime: msg.previousStartDateTime ?? null,
          previousEndDateTime: msg.previousEndDateTime ?? null,
          previousLocation: msg.previousLocation ?? null,
          ...(event ? { event: fullForm(event) } : {}),
        });
      }
      if (state.config.failBody) return graphError(reply, 500, "InternalServerError", "Body fetch failed (test)");
      return reply(200, { id: msg.id, body: msg.body });
    }
    graphError(reply, 404, "NotFound", `No fake route for ${method} ${p}`);
  }

  /** Accepts a well-known name or a folder id. */
  function folderId(nameOrId: string): string | undefined {
    if (nameOrId in FOLDER_IDS) return FOLDER_IDS[nameOrId as FolderName];
    return Object.values(FOLDER_IDS).find((v) => v === nameOrId);
  }

  let sentCount = 0;
  /** Puts a copy of something you sent into Sent Items and logs it for assertions. */
  function sendCopy(s: { kind: string; messageId?: string; conversationId?: string; subject: string; html: string; to: Json[]; cc: Json[] }) {
    const id = `msg-sent-new-${++sentCount}`;
    const msg = makeMessage({
      id,
      conversationId: s.conversationId,
      sender: ME,
      to: s.to.map((r) => [r.emailAddress?.name ?? r.emailAddress?.address, r.emailAddress?.address] as Sender),
      folder: "sentitems",
      subject: s.subject,
      receivedAt: Date.now(),
      isRead: true,
      snippet: s.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    });
    msg.ccRecipients = s.cc as GraphMessage["ccRecipients"];
    msg.body = { contentType: "html", content: s.html };
    state.messages.set(id, msg);
    change(id, "upsert");
    state.sent.push({ kind: s.kind, messageId: s.messageId, id, subject: s.subject, html: s.html, to: s.to, cc: s.cc });
  }

  const metadata = (m: GraphMessage): Json => {
    const { body, attachments, eventId, meetingMessageType, meetingRequestType, previousStartDateTime, previousEndDateTime, previousLocation, ...rest } = m;
    return rest;
  };

  /** A message as message delta returns it, honouring the derived-type select and config. */
  function deltaMessage(m: GraphMessage, withMeeting: boolean): Json {
    const out = metadata(m);
    if (withMeeting && m.meetingMessageType) out.meetingMessageType = m.meetingMessageType;
    if (state.config.omitODataType) delete out["@odata.type"];
    return out;
  }

  // ---------- calendar ----------

  /** UTC instant of an event boundary (all-day boundaries are local midnights). */
  const eventInstant = (b: GraphEvent["start"], allDay: boolean) =>
    allDay ? new Date(b.dateTime.slice(0, 19)).toISOString() : `${b.dateTime.slice(0, 19)}Z`;

  function calendarDelta(req: IncomingMessage, url: URL, reply: Reply) {
    const q = url.searchParams;
    const pageSize = Number(String(req.headers.prefer ?? "").match(/odata\.maxpagesize=(\d+)/)?.[1] ?? 10);
    const base = `${origin}/v1.0/me/calendarView/delta`;
    if (q.has("$skiptoken")) {
      const [sid, offset] = (q.get("$skiptoken") ?? "").split(":");
      const s = state.sessions.get(sid);
      if (!s) return graphError(reply, 410, "SyncStateNotFound", "Skip token expired");
      return page(s, sid, Number(offset));
    }
    let items: Json[];
    if (q.has("$deltatoken")) {
      if (state.config.expireCalendarDelta) {
        state.config.expireCalendarDelta = false;
        return graphError(reply, 410, "SyncStateNotFound", "The sync state generation is not found.");
      }
      const since = Number(q.get("$deltatoken"));
      const latest = new Map<string, boolean>();
      for (const c of state.eventChanges) if (c.seq > since) latest.set(c.id, c.removed);
      items = [...latest].map(([id, removed]) => (removed || !state.events.has(id) ? { id, "@removed": { reason: "deleted" } } : deltaForm(state.events.get(id)!)));
    } else {
      const from = q.get("startDateTime") ?? "";
      const to = q.get("endDateTime") ?? "";
      if (!from || !to) return graphError(reply, 400, "ErrorInvalidParameter", "startDateTime and endDateTime are required");
      items = [...state.events.values()]
        .filter((e) =>
          e.type === "seriesMaster"
            ? !e.hiddenFromDelta
            : eventInstant(e.start, e.isAllDay) < to && eventInstant(e.end, e.isAllDay) > from,
        )
        .map(deltaForm);
    }
    const sid = b64url(randomBytes(6));
    const s: Session = { items, pageSize, deltaLink: `${base}?$deltatoken=${state.eventSeq}` };
    state.sessions.set(sid, s);
    return page(s, sid, 0);

    function page(s: Session, sid: string, offset: number) {
      const body: Json = { value: s.items.slice(offset, offset + s.pageSize) };
      if (offset + s.pageSize < s.items.length) body["@odata.nextLink"] = `${base}?$skiptoken=${sid}:${offset + s.pageSize}`;
      else {
        body["@odata.deltaLink"] = s.deltaLink;
        state.sessions.delete(sid);
      }
      reply(200, body);
    }
  }

  /** How calendarView delta presents an event: occurrences bare, everything else in full. */
  function deltaForm(e: GraphEvent): Json {
    if (e.bare) return { id: e.id, type: e.type, ...(e.seriesMasterId ? { seriesMasterId: e.seriesMasterId } : {}), start: e.start, end: e.end };
    return fullForm(e);
  }

  function fullForm({ bare, hiddenFromDelta, ...rest }: GraphEvent): Json {
    return rest;
  }

  function eventChange(id: string, removed = false) {
    state.eventChanges.push({ seq: ++state.eventSeq, id, removed });
  }

  function delta(req: IncomingMessage, url: URL, reply: Reply, folder: string) {
    const q = url.searchParams;
    const select = q.get("$select") ?? "";
    // The select (and so this flag) is baked into next/delta links, like Graph does.
    const withMeeting = select.includes("eventMessage/meetingMessageType") || q.get("meeting") === "1";
    const m = withMeeting ? "&meeting=1" : "";
    if (select.includes("eventMessage/meetingMessageType") && state.config.rejectMeetingSelect) {
      return graphError(reply, 400, "BadRequest", "Derived type properties are not supported in $select on delta.");
    }
    const pageSize = Number(String(req.headers.prefer ?? "").match(/odata\.maxpagesize=(\d+)/)?.[1] ?? 10);
    const base = `${origin}/v1.0/me/mailFolders/${folder}/messages/delta`;

    // Continuing a paging session.
    if (q.has("$skiptoken")) {
      const [sid, offset] = (q.get("$skiptoken") ?? "").split(":");
      const s = state.sessions.get(sid);
      if (!s) return graphError(reply, 410, "SyncStateNotFound", "Skip token expired");
      return page(s, sid, Number(offset));
    }

    let items: Json[];
    let cutoff = "";
    if (q.has("$deltatoken")) {
      if (state.config.expireDelta && folder === FOLDER_IDS.inbox) {
        state.config.expireDelta = false;
        return graphError(reply, 410, "SyncStateNotFound", "The sync state generation is not found.");
      }
      const [since, c] = (q.get("$deltatoken") ?? "").split(".");
      cutoff = c ?? "";
      items = changesSince(folder, Number(since), cutoff, withMeeting);
    } else {
      const filter = q.get("$filter");
      if (filter) {
        if (state.config.rejectDeltaFilter) return graphError(reply, 400, "BadRequest", "The query filter is not supported on delta.");
        cutoff = filter.match(/receivedDateTime ge (\S+)/)?.[1] ?? "";
      }
      items = [...state.messages.values()]
        .filter((m) => m.parentFolderId === folder && (!cutoff || m.receivedDateTime >= cutoff))
        .sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime))
        .map((m) => deltaMessage(m, withMeeting));
    }

    const sid = b64url(randomBytes(6));
    const s: Session = { items, pageSize, deltaLink: `${base}?$deltatoken=${state.seq}.${cutoff}${m}` };
    state.sessions.set(sid, s);
    return page(s, sid, 0);

    function page(s: Session, sid: string, offset: number) {
      const slice = s.items.slice(offset, offset + s.pageSize);
      const body: Json = { "@odata.context": `${origin}/v1.0/$metadata#Collection(message)`, value: slice };
      if (offset + s.pageSize < s.items.length) {
        body["@odata.nextLink"] = `${base}?$skiptoken=${sid}:${offset + s.pageSize}${m}`;
      } else {
        body["@odata.deltaLink"] = s.deltaLink;
        state.sessions.delete(sid);
      }
      reply(200, body);
    }
  }

  /** Delta items for one folder: changed messages still in it, and @removed for ones that left. */
  function changesSince(folder: string, since: number, cutoff: string, withMeeting: boolean): Json[] {
    const latest = new Map<string, { kind: ChangeKind; fields: Json }>();
    for (const c of state.changes) {
      if (c.seq <= since || !c.folders.includes(folder)) continue;
      const prev = latest.get(c.id);
      // A partial after an upsert still needs the full object.
      const kind = c.kind === "partial" && prev && prev.kind !== "partial" ? prev.kind : c.kind;
      latest.set(c.id, { kind, fields: { ...(prev?.fields ?? {}), ...(c.fields ?? {}) } });
    }
    const out: Json[] = [];
    for (const [id, c] of latest) {
      const msg = state.messages.get(id);
      if (c.kind === "remove" || !msg || msg.parentFolderId !== folder) out.push({ id, "@removed": { reason: "deleted" } });
      else if (c.kind === "partial") out.push({ id, ...c.fields });
      else if (!cutoff || msg.receivedDateTime >= cutoff) out.push(deltaMessage(msg, withMeeting));
    }
    return out;
  }

  /** Records a change. `folders` are the folders whose delta should see it (default: the message's current one). */
  function change(id: string, kind: ChangeKind, fields?: Json, folders?: string[]) {
    const current = state.messages.get(id)?.parentFolderId;
    state.changes.push({ seq: ++state.seq, id, kind, fields, folders: folders ?? (current ? [current] : Object.values(FOLDER_IDS)) });
  }

  // ---------- control API ----------

  let delivered = 0;

  async function control(req: IncomingMessage, res: ServerResponse, url: URL) {
    const body = req.method === "POST" ? await readBody(req) : {};
    const ok = (data: unknown = { ok: true }) => send(res, 200, data);
    switch (`${req.method} ${url.pathname}`) {
      case "GET /_test":
        return ok({
          routes: [
            "POST /_test/reset {count?, seed?}",
            "POST /_test/deliver {count?, subject?, from?: [name, address], to?: [[name, address]], cc?, conversationId?, body?: html, folder?, inference?}",
            "POST /_test/update {id, fields: {isRead?, flag?, subject?...}}",
            "POST /_test/remove {id}",
            "POST /_test/throttle {count?=1, status?=429, retryAfter?=1}",
            "POST /_test/move {id, folder: inbox|archive|deleteditems|sentitems}",
            "POST /_test/config {rejectDeltaFilter?, expireDelta?, tokenTtl?, latencyMs?, failBody?, failWrites?: status}",
            "GET  /_test/sent   (writes the app made: send, reply, move, patch, rsvp, event)",
            "POST /_test/event {id, subject?, start?, end? (ISO), allDay?, location?, response?, attendees?: [[name, address]]}   POST /_test/event-remove {id}   GET /_test/event?id=",
            "GET  /_test/message?id=...",
            "POST /_test/expire-tokens",
            "GET  /_test/state",
            "GET  /_test/requests   DELETE /_test/requests",
          ],
          clientId: CLIENT_ID,
        });
      case "POST /_test/reset":
        reset(body);
        state.requests = [];
        return ok();
      case "POST /_test/deliver": {
        const ids = [];
        for (let i = 0; i < (body.count ?? 1); i++) {
          const id = `msg-new-${++delivered}`;
          const msg = makeMessage({
            id,
            conversationId: body.conversationId,
            sender: (body.from as Sender | undefined) ?? ["Sam Carter", "sam.carter@contoso.com"],
            subject: body.subject ?? `New message ${delivered}`,
            receivedAt: Date.now(),
            snippet: body.preview ?? "Just landed in your inbox.",
            folder: body.folder,
            to: body.to as Sender[] | undefined,
          });
          if (body.cc) msg.ccRecipients = (body.cc as Sender[]).map(([name, address]) => ({ emailAddress: { name, address } }));
          if (body.inference) msg.inferenceClassification = body.inference;
          if (body.body) msg.body = { contentType: "html", content: body.body };
          state.messages.set(id, msg);
          change(id, "upsert");
          ids.push(id);
        }
        return ok({ ids });
      }
      case "POST /_test/update": {
        const msg = state.messages.get(body.id);
        if (!msg) return send(res, 404, { error: "no such message" });
        Object.assign(msg, body.fields);
        change(body.id, "partial", body.fields);
        return ok();
      }
      case "POST /_test/move": {
        const msg = state.messages.get(body.id);
        const dest = folderId(body.folder ?? "");
        if (!msg || !dest) return send(res, 404, { error: "no such message or folder" });
        const from = msg.parentFolderId;
        msg.parentFolderId = dest;
        change(msg.id, "upsert", undefined, [from, dest]);
        return ok();
      }
      case "POST /_test/event": {
        // Create or update an event: {id, subject, start, end (ISO), allDay?, location?, response?}
        const existing = state.events.get(body.id);
        const e = makeEvent({
          id: body.id,
          subject: body.subject ?? existing?.subject ?? "New event",
          start: new Date(body.start ?? (existing ? eventInstant(existing.start, existing.isAllDay) : Date.now())),
          end: new Date(body.end ?? (existing ? eventInstant(existing.end, existing.isAllDay) : Date.now() + 3600_000)),
          allDay: body.allDay,
          location: body.location,
          response: body.response,
          attendees: (body.attendees as [string, string][] | undefined)?.map(([name, address]) => ({ name, address })),
        });
        state.events.set(e.id, e);
        eventChange(e.id);
        return ok(e);
      }
      case "POST /_test/event-remove":
        state.events.delete(body.id);
        eventChange(body.id, true);
        return ok();
      case "GET /_test/event": {
        const e = state.events.get(url.searchParams.get("id") ?? "");
        return e ? ok(fullForm(e)) : send(res, 404, { error: "no such event" });
      }
      case "GET /_test/sent":
        return ok(state.sent);
      case "GET /_test/message": {
        const msg = state.messages.get(url.searchParams.get("id") ?? "");
        return msg ? ok(metadata(msg)) : send(res, 404, { error: "no such message" });
      }
      case "POST /_test/remove":
        state.messages.delete(body.id);
        change(body.id, "remove");
        return ok();
      case "POST /_test/throttle":
        for (let i = 0; i < (body.count ?? 1); i++) state.throttle.push({ status: body.status ?? 429, retryAfter: body.retryAfter ?? 1 });
        return ok();
      case "POST /_test/config":
        Object.assign(state.config, body);
        return ok(state.config);
      case "POST /_test/expire-tokens":
        for (const k of state.accessTokens.keys()) state.accessTokens.set(k, 0);
        return ok();
      case "GET /_test/state":
        return ok({ messages: state.messages.size, seq: state.seq, config: state.config, refreshTokens: state.refreshTokens.size });
      case "GET /_test/requests":
        return ok(state.requests);
      case "DELETE /_test/requests":
        state.requests = [];
        return ok();
    }
    send(res, 404, { error: `unknown control route ${req.method} ${url.pathname}` });
  }

  return {
    origin,
    graphUrl: `${origin}/v1.0`,
    authorityUrl: `${origin}/oauth`,
    clientId: CLIENT_ID,
    state,
    /** Calls the control API, e.g. control("deliver", { subject: "Hi" }). */
    async control(route: string, body?: Json): Promise<any> {
      const isGet = body === undefined && /^(state|requests|sent|message\?.*|event\?.*)$/.test(route);
      const res = await fetch(`${origin}/_test/${route}`, {
        method: isGet ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: isGet ? undefined : JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw new Error(`control ${route} failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    /** Graph/OAuth requests received since `since` (index into the log). */
    requestsSince(since = 0): RequestRecord[] {
      return state.requests.slice(since);
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// Standalone mode.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string, fallback: number | undefined) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? Number(process.argv[i + 1]) : fallback;
  };
  const fake = await startFakeGraph({
    port: arg("--port", 4010),
    count: arg("--count", undefined),
    seed: arg("--seed", undefined),
    verbose: process.argv.includes("--verbose"),
  });
  console.log(`fake graph listening on ${fake.origin}`);
  console.log(`  PEETMAIL_GRAPH_URL=${fake.graphUrl}`);
  console.log(`  PEETMAIL_AUTHORITY_URL=${fake.authorityUrl}`);
  console.log(`  client id: ${fake.clientId}`);
}
