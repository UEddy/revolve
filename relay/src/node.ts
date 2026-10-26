// Runs a fetch-style handler on node:http. Only the request's method, path
// and body cross over: client headers (IP forwarding, user agent, cookies)
// never reach the handler, so they cannot leak upstream.

import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY = 64 * 1024;

export function toNode(handler: (req: Request) => Promise<Response>) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(c);
    });
    req.on("error", () => res.destroy());
    req.on("end", async () => {
      if (tooBig) {
        res.writeHead(413, { "content-type": "application/json" }).end('{"error":"body too large"}');
        return;
      }
      try {
        const hasBody = req.method === "POST";
        const out = await handler(
          new Request(new URL(req.url ?? "/", "http://relay.local"), {
            method: req.method,
            headers: hasBody ? { "content-type": "application/json" } : undefined,
            body: hasBody ? Buffer.concat(chunks) : undefined,
          }),
        );
        res.statusCode = out.status;
        out.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await out.arrayBuffer()));
      } catch {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end('{"error":"relay failed"}');
      }
    });
  };
}
