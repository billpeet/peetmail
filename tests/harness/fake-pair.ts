// Two mailboxes behind one Graph URL, for multi-account tests.
//
// The app has a single PEETMAIL_GRAPH_URL / PEETMAIL_AUTHORITY_URL, so a small proxy
// sits in front of two independent fake servers and routes each request:
//   /oauth/authorize    to whichever fake `signInAs()` last picked (default: the first)
//   /oauth/token        by the code / refresh token's prefix ("b-" is the second fake)
//   everything else     by the bearer token's prefix
// Delta and next links point straight at each fake, which checks its own tokens.
//
// The returned object is the first fake (same API as startFakeGraph), with the proxy's
// URLs, plus `second` (the other fake) and `signInAs("a" | "b")`.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startFakeGraph } from "./fake-graph.ts";
import { makeMessage, type GraphMessage, type Sender } from "./fixtures.ts";

export const WORK_ACCOUNT = { displayName: "Boris Dragon", mail: "boris@work.example" };
const WORK_ME: Sender = [WORK_ACCOUNT.displayName, WORK_ACCOUNT.mail];

/** A small work mailbox, interleaved in time with the default one. */
export function workMailbox(now = Date.now()): GraphMessage[] {
  const h = 3_600_000;
  return [
    makeMessage({ id: "work-1", conversationId: "work-conv-contract", sender: ["Legal Team", "legal@work.example"], to: [WORK_ME], subject: "Contract renewal", receivedAt: now - 0.5 * h }),
    makeMessage({ id: "work-2", conversationId: "work-conv-standup", sender: ["Ana Ruiz", "ana@work.example"], to: [WORK_ME], subject: "Standup notes", receivedAt: now - 7 * h, isRead: true }),
    makeMessage({ id: "work-3", conversationId: "work-conv-offsite", sender: ["Ana Ruiz", "ana@work.example"], to: [WORK_ME], subject: "Offsite venue", receivedAt: now - 30 * h }),
  ];
}

export async function startFakePair() {
  const a = await startFakeGraph();
  const b = await startFakeGraph({ prefix: "b-", account: WORK_ACCOUNT, mailbox: workMailbox(), calendar: [] });
  let next: "a" | "b" = "a";

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const path = req.url ?? "/";
    let target = a;
    if (path.startsWith("/oauth/authorize")) {
      target = next === "b" ? b : a;
    } else if (path.startsWith("/oauth/token")) {
      const f = new URLSearchParams(body.toString());
      if ((f.get("code") ?? f.get("refresh_token") ?? "").startsWith("b-")) target = b;
    } else if ((req.headers.authorization ?? "").startsWith("Bearer b-")) {
      target = b;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && !["host", "content-length", "connection"].includes(k)) headers[k] = v;
    }
    try {
      const r = await fetch(target.origin + path, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        redirect: "manual",
      });
      const out: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        if (!["content-encoding", "transfer-encoding", "content-length", "connection"].includes(k)) out[k] = v;
      });
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    ...a,
    graphUrl: `${origin}/v1.0`,
    authorityUrl: `${origin}/oauth`,
    /** The second mailbox's fake (control API, state). */
    second: b,
    /** Which mailbox the next browser sign-in lands in. */
    signInAs(which: "a" | "b") {
      next = which;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await a.close();
      await b.close();
    },
  };
}
