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
import { ACCOUNT, defaultMailbox, makeMessage, type GraphMessage, type Sender } from "./fixtures.ts";

/** The only client ID the fake authority accepts. Anything else never redirects back, like Entra. */
export const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
export const INBOX_ID = "AAMkAGI2-inbox";

const b64url = (buf: Uint8Array) => Buffer.from(buf).toString("base64url");

type Json = Record<string, any>;
type ChangeKind = "upsert" | "partial" | "remove";
type Change = { seq: number; id: string; kind: ChangeKind; fields?: Json };
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
    config: { rejectDeltaFilter: false, expireDelta: false, tokenTtl: 3600, latencyMs: 0, failBody: false } as FakeConfig,
    requests: [] as RequestRecord[],
  };

  const defaults = { count, seed };
  function reset({ count = defaults.count, seed = defaults.seed, messages }: { count?: number; seed?: number; messages?: GraphMessage[] } = {}) {
    state.messages.clear();
    state.changes = [];
    state.sessions.clear();
    state.seq = 0;
    for (const m of messages ?? mailbox ?? defaultMailbox({ count, seed })) state.messages.set(m.id, m);
  }
  reset();

  const server = createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: { message: String(e) } })));
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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

    if (p.startsWith("/_test")) return control(req, res, url);
    if (p.startsWith("/oauth/")) return oauth(req, url, reply);
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
    if (p === "/me") return reply(200, { ...ACCOUNT, userPrincipalName: ACCOUNT.mail });
    if (p === "/me/mailFolders/inbox") return reply(200, { id: INBOX_ID, displayName: "Inbox" });
    if (p === `/me/mailFolders/${INBOX_ID}/messages/delta`) return delta(req, url, reply);

    const m = p.match(/^\/me\/messages\/([^/]+)$/);
    if (m) {
      const msg = state.messages.get(decodeURIComponent(m[1]));
      if (!msg) return graphError(reply, 404, "ErrorItemNotFound", "The specified object was not found in the store.");
      if (state.config.failBody) return graphError(reply, 500, "InternalServerError", "Body fetch failed (test)");
      return reply(200, { id: msg.id, body: msg.body });
    }
    graphError(reply, 404, "NotFound", `No fake route for ${p}`);
  }

  const metadata = ({ body, ...rest }: GraphMessage): Json => rest;

  function delta(req: IncomingMessage, url: URL, reply: Reply) {
    const q = url.searchParams;
    const pageSize = Number(String(req.headers.prefer ?? "").match(/odata\.maxpagesize=(\d+)/)?.[1] ?? 10);
    const deltaUrl = (token: string) => `${origin}/v1.0/me/mailFolders/${INBOX_ID}/messages/delta?$deltatoken=${token}`;

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
      if (state.config.expireDelta) {
        state.config.expireDelta = false;
        return graphError(reply, 410, "SyncStateNotFound", "The sync state generation is not found.");
      }
      const [since, c] = (q.get("$deltatoken") ?? "").split(".");
      cutoff = c ?? "";
      items = changesSince(Number(since), cutoff);
    } else {
      const filter = q.get("$filter");
      if (filter) {
        if (state.config.rejectDeltaFilter) return graphError(reply, 400, "BadRequest", "The query filter is not supported on delta.");
        cutoff = filter.match(/receivedDateTime ge (\S+)/)?.[1] ?? "";
      }
      items = [...state.messages.values()]
        .filter((m) => !cutoff || m.receivedDateTime >= cutoff)
        .sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime))
        .map(metadata);
    }

    const sid = b64url(randomBytes(6));
    const s: Session = { items, pageSize, deltaLink: deltaUrl(`${state.seq}.${cutoff}`) };
    state.sessions.set(sid, s);
    return page(s, sid, 0);

    function page(s: Session, sid: string, offset: number) {
      const slice = s.items.slice(offset, offset + s.pageSize);
      const body: Json = { "@odata.context": `${origin}/v1.0/$metadata#Collection(message)`, value: slice };
      if (offset + s.pageSize < s.items.length) {
        body["@odata.nextLink"] = `${origin}/v1.0/me/mailFolders/${INBOX_ID}/messages/delta?$skiptoken=${sid}:${offset + s.pageSize}`;
      } else {
        body["@odata.deltaLink"] = s.deltaLink;
        state.sessions.delete(sid);
      }
      reply(200, body);
    }
  }

  function changesSince(since: number, cutoff: string): Json[] {
    const latest = new Map<string, { kind: ChangeKind; fields: Json }>();
    for (const c of state.changes) {
      if (c.seq <= since) continue;
      const prev = latest.get(c.id);
      // A partial after an upsert still needs the full object.
      const kind = c.kind === "partial" && prev && prev.kind !== "partial" ? prev.kind : c.kind;
      latest.set(c.id, { kind, fields: { ...(prev?.fields ?? {}), ...(c.fields ?? {}) } });
    }
    const out: Json[] = [];
    for (const [id, c] of latest) {
      const msg = state.messages.get(id);
      if (c.kind === "remove" || !msg) out.push({ id, "@removed": { reason: "deleted" } });
      else if (c.kind === "partial") out.push({ id, ...c.fields });
      else if (!cutoff || msg.receivedDateTime >= cutoff) out.push(metadata(msg));
    }
    return out;
  }

  function change(id: string, kind: ChangeKind, fields?: Json) {
    state.changes.push({ seq: ++state.seq, id, kind, fields });
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
            "POST /_test/deliver {count?, subject?, from?: [name, address], conversationId?, body?: html}",
            "POST /_test/update {id, fields: {isRead?, flag?, subject?...}}",
            "POST /_test/remove {id}",
            "POST /_test/throttle {count?=1, status?=429, retryAfter?=1}",
            "POST /_test/config {rejectDeltaFilter?, expireDelta?, tokenTtl?, latencyMs?, failBody?}",
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
          });
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
      const res = await fetch(`${origin}/_test/${route}`, {
        method: body === undefined && route.match(/^(state|requests)$/) ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined && route.match(/^(state|requests)$/) ? undefined : JSON.stringify(body ?? {}),
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
