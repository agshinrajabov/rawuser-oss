/**
 * The two workers and the dashboard behind plain HTTP listeners
 * (docs/specs/run-anywhere.md). A worker's `fetch` takes a web Request and
 * gives a web Response; this turns Node's request into the one and writes
 * the other back.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

export interface WorkerLike<E> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> | Response;
}

export interface RequestOptions {
  /** The public address of this listener, as visitors type it; read from the request when unset. */
  origin?: string;
  /** Read the connecting address from the last entry of X-Forwarded-For. Only behind your own proxy. */
  trustProxy?: boolean;
  /** A header your proxy sets, overwriting what a client sent, with the visitor's country as two letters. */
  countryHeader?: string;
  /** The most a request body may hold. */
  maxBody?: number;
}

/** Headers a client must never be believed on: this server sets them itself. */
const OURS_TO_SET = ["cf-connecting-ip", "x-real-ip", "true-client-ip", "cf-ipcountry"];

/**
 * The address the connection came from: the socket's, or the proxy's word
 * for it. A proxy adds the address it saw to the END of X-Forwarded-For;
 * everything before that was sent by the client and can say anything. So
 * the last entry is the one to believe, never the first.
 */
export function connectingAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const all = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const last = all.at(-1);
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function bodyOf(req: IncomingMessage, max: number): Promise<Uint8Array | "too large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return "too large";
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Node's request as the web Request a worker expects. */
export async function toWebRequest(
  req: IncomingMessage,
  options: RequestOptions = {},
): Promise<Request | "too large"> {
  const origin = options.origin ?? `http://${req.headers.host ?? "localhost"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || OURS_TO_SET.includes(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  // The workers read the connecting address from this header, as Cloudflare sets it.
  headers.set("cf-connecting-ip", connectingAddress(req, options.trustProxy ?? false));

  const method = req.method ?? "GET";
  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const read = await bodyOf(req, options.maxBody ?? 4 * 1024 * 1024);
    if (read === "too large") return "too large";
    body = read;
  }
  const request = new Request(new URL(req.url ?? "/", origin), { method, headers, body });

  // Cloudflare tells a worker the country of the connection. Here it is known
  // only if a proxy in front says so, in the header the operator named.
  const named = options.countryHeader
    ? req.headers[options.countryHeader.toLowerCase()]
    : undefined;
  const country = (Array.isArray(named) ? named[0] : named)?.trim().toUpperCase();
  if (country && /^[A-Z]{2}$/.test(country))
    Object.defineProperty(request, "cf", { value: { country }, enumerable: false });
  return request;
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  // Each cookie is its own header; a joined one would not parse.
  const cookies =
    (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

/** What a worker hands to `ctx.waitUntil`, kept alive and counted. */
export function makeContext(log: (line: string) => void = console.error): {
  ctx: ExecutionContext;
  idle: () => Promise<void>;
} {
  const pending = new Set<Promise<unknown>>();
  const ctx = {
    waitUntil(work: Promise<unknown>) {
      const tracked = Promise.resolve(work)
        .catch((e) => log(`[waitUntil] ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    idle: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

/** A listener that hands every request to one worker. */
export function workerServer<E>(
  worker: WorkerLike<E>,
  env: E,
  ctx: ExecutionContext,
  options: RequestOptions = {},
  log: (line: string) => void = console.error,
): Server {
  return createServer(async (req, res) => {
    try {
      const request = await toWebRequest(req, options);
      if (request === "too large") {
        res.writeHead(413, { "content-type": "text/plain" }).end("too large");
        return;
      }
      await writeWebResponse(res, await worker.fetch(request, env, ctx));
    } catch (e) {
      log(`[request] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("error");
    }
  });
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const SITE_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** Which file of a static export answers a path: a status, a file, or a redirect. */
export function staticAnswer(
  root: string,
  pathname: string,
): { status: 200 | 404; file: string } | { status: 308; location: string } | { status: 404 } {
  const base = resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { status: 404 };
  }
  const target = normalize(join(base, decoded));
  // Never a file outside the export, however the path is written.
  if (target !== base && !target.startsWith(base + sep)) return { status: 404 };
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  if (isFile(target)) return { status: 200, file: target };
  if (isFile(join(target, "index.html"))) {
    return decoded.endsWith("/")
      ? { status: 200, file: join(target, "index.html") }
      : { status: 308, location: `${pathname}/` };
  }
  const missing = join(base, "404.html");
  return isFile(missing) ? { status: 404, file: missing } : { status: 404 };
}

/** A listener for the dashboard's static export. */
export function staticServer(root: string): Server {
  return createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, SITE_HEADERS).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const answer = staticAnswer(root, url.pathname);
    if ("location" in answer) {
      res.writeHead(308, { ...SITE_HEADERS, location: answer.location + url.search }).end();
      return;
    }
    if (!("file" in answer)) {
      res.writeHead(404, { ...SITE_HEADERS, "content-type": "text/plain" }).end("not found");
      return;
    }
    const hashed = url.pathname.startsWith("/_next/static/");
    res.writeHead(answer.status, {
      ...SITE_HEADERS,
      "content-type": TYPES[extname(answer.file)] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : readFileSync(answer.file));
  });
}
