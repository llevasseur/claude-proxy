import fs from "node:fs";
import http from "node:http";
import {
  buildContext,
  buildContextDetail,
  buildContextMessage,
  buildContextTool,
  buildMemory,
  buildProjectMemories,
  buildProjects,
  buildSession,
  buildSessionBreakdown,
  buildSessionErrors,
  buildSessions,
  buildSessionGraphNodes,
  buildSessionsGraph,
  buildSessionSuggestionBucket,
  buildSessionSuggestions,
  buildSkim,
  buildSkimTrend,
  buildSummary,
  buildTools,
  buildTrends,
  buildWithheld,
  buildHooksPlugins,
  buildFilters,
} from "./api.js";
import { resolveArchiveDir } from "./archive.js";
import { continueChat, endChat, listRunningChats, resolveChatConfig, startChat, stopChat } from "./chat.js";
import { countSidecarFiles, resolveLogDir } from "./logs.js";
import { resolveProjectsDir } from "./projects.js";
import { resolveSessionFile, resolveSessionsDir } from "./sessions.js";

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? "127.0.0.1"; // localhost-only by default
const LOG_DIR = resolveLogDir();
const ARCHIVE_DIR = resolveArchiveDir();
const PROJECTS_DIR = resolveProjectsDir();

/** Everything but the chat routes is a read-only view of already-captured logs. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

/** The write surface: the only routes that are not read-only GETs. */
const CHAT_ROUTES = new Set(["/api/chat/sessions", "/api/chat/sessions/message", "/api/chat/sessions/end", "/api/chat/stop"]);

/**
 * Origins allowed to POST those routes — the dashboard's dev server by default,
 * overridable with a comma-separated `CHAT_ALLOWED_ORIGINS`.
 *
 * They cannot share the read-only `*`: a POST here can start an agent turn, which runs
 * commands in this checkout. A request that *declares* another origin is refused
 * outright, rather than relying on the browser to withhold the response.
 */
const CHAT_ORIGINS = (process.env.CHAT_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const originAllowed = (origin: string | undefined): boolean => !origin || CHAT_ORIGINS.includes(origin);

function chatCors(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    // The answer depends on the request's origin, so a cache must not reuse it across them.
    vary: "origin",
  };
  if (origin && CHAT_ORIGINS.includes(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}

function send(res: http.ServerResponse, status: number, body: unknown, cors: Record<string, string> = CORS): void {
  res.writeHead(status, { "content-type": "application/json", ...cors });
  res.end(JSON.stringify(body));
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  ...CORS,
};

/** Comment-frame heartbeat interval — keeps proxies/browsers from idling out. */
const SSE_HEARTBEAT_MS = 25_000;

interface SseStream {
  /** File or directory to `fs.watch`; a change re-runs `build` and pushes an update. */
  watchPath: string;
  /** Produce the JSON payload sent as the initial `snapshot` and each `update`. */
  build: () => Promise<unknown>;
  /** Coalesce bursts of fs events within this window (ms) before rebuilding. */
  debounceMs: number;
}

/**
 * Serve one live JSON resource over Server-Sent Events. Sends the current value as
 * a `snapshot` event, then an `update` event (same shape) whenever `watchPath`
 * changes on disk — deduping byte-identical payloads. A comment heartbeat keeps the
 * connection open, and everything is torn down when the client disconnects.
 *
 * The initial build runs *before* the SSE headers, so a build failure surfaces as a
 * normal HTTP error (400/404/500) that `EventSource` reports without reconnecting.
 */
async function serveSse(req: http.IncomingMessage, res: http.ServerResponse, stream: SseStream): Promise<void> {
  let snapshot: unknown;
  try {
    snapshot = await stream.build();
  } catch (err) {
    const msg = (err as Error).message;
    send(res, msg.startsWith("session not found") ? 404 : 500, { error: msg });
    return;
  }

  res.writeHead(200, SSE_HEADERS);
  let lastSent = JSON.stringify(snapshot);
  res.write(`event: snapshot\ndata: ${lastSent}\n\n`);

  let debounce: NodeJS.Timeout | null = null;
  const pushUpdate = () => {
    debounce = null;
    stream
      .build()
      .then((data) => {
        if (res.writableEnded) return;
        const next = JSON.stringify(data);
        if (next === lastSent) return; // spurious fs event or no-op change
        lastSent = next;
        res.write(`event: update\ndata: ${next}\n\n`);
      })
      .catch(() => {
        /* transient read error mid-write — skip this tick; the next change re-reads */
      });
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(stream.watchPath, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(pushUpdate, stream.debounceMs);
    });
    watcher.on("error", () => {}); // watch dropped (e.g. file removed) — snapshot + heartbeat remain
  } catch {
    /* watch unsupported / path missing — client keeps the snapshot, heartbeat holds it open */
  }

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": keep-alive\n\n");
  }, SSE_HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    if (debounce) clearTimeout(debounce);
    watcher?.close();
    watcher = null;
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
}

/** Parse `?days=` as a positive int in [1, 365], default 14. */
function parseDays(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 14;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(raw: string | null): string | undefined {
  return raw && DATE_RE.test(raw) ? raw : undefined;
}

const MAX_BODY_BYTES = 1_000_000;

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > MAX_BODY_BYTES) throw new Error(`request body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (bytes === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Map a chat failure onto a status. */
function chatErrorStatus(msg: string): number {
  if (msg.startsWith("chat session not found")) return 404;
  if (msg.startsWith("chat is not configured")) return 503;
  if (msg.startsWith("chat request") || msg.startsWith("chat cli") || msg.startsWith("claude cli") || msg.startsWith("anthropic stream error")) {
    return 502;
  }
  return 400; // invalid prompt / missing sessionId / malformed body
}

async function serveChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: (body: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const origin = req.headers.origin;
  const cors = chatCors(origin);
  if (!originAllowed(origin)) {
    send(res, 403, { error: `origin not allowed: ${origin}` }, cors);
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, { error: `method not allowed: ${req.method}` }, cors);
    return;
  }
  try {
    send(res, 200, await handler(await readJsonBody(req)), cors);
  } catch (err) {
    const msg = (err as Error).message;
    send(res, chatErrorStatus(msg), { error: msg }, cors);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CHAT_ROUTES.has(url.pathname) ? chatCors(req.headers.origin) : CORS);
    res.end();
    return;
  }

  const date = parseDate(url.searchParams.get("date"));

  try {
    switch (url.pathname) {
      case "/api/health": {
        let sidecarCount: number | null = null;
        let logDirReadable = true;
        try {
          sidecarCount = await countSidecarFiles(LOG_DIR);
        } catch {
          logDirReadable = false;
        }
        send(res, 200, { ok: logDirReadable, logDir: LOG_DIR, logDirReadable, sidecarCount });
        return;
      }
      case "/api/summary":
        send(res, 200, await buildSummary(LOG_DIR, date));
        return;
      case "/api/trends":
        send(res, 200, await buildTrends(LOG_DIR, parseDays(url.searchParams.get("days")), new Date(), ARCHIVE_DIR));
        return;
      case "/api/tools":
        send(res, 200, await buildTools(LOG_DIR, date));
        return;
      case "/api/context":
        send(res, 200, await buildContext(LOG_DIR, parseDays(url.searchParams.get("days"))));
        return;
      case "/api/context/detail": {
        const file = url.searchParams.get("file");
        if (!file) {
          send(res, 400, { error: "missing ?file=" });
          return;
        }
        try {
          send(res, 200, await buildContextDetail(LOG_DIR, file));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid request file name")) send(res, 400, { error: msg });
          else if (msg.startsWith("request file not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/context/message": {
        const file = url.searchParams.get("file");
        if (!file) {
          send(res, 400, { error: "missing ?file=" });
          return;
        }
        const index = Number(url.searchParams.get("index"));
        if (!Number.isInteger(index) || index < 0) {
          send(res, 400, { error: "missing or invalid ?index=" });
          return;
        }
        try {
          send(res, 200, await buildContextMessage(LOG_DIR, file, index));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid request file name")) send(res, 400, { error: msg });
          else if (msg.startsWith("request file not found")) send(res, 404, { error: msg });
          else if (msg.startsWith("message index out of range")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/context/tool": {
        const file = url.searchParams.get("file");
        if (!file) {
          send(res, 400, { error: "missing ?file=" });
          return;
        }
        const index = Number(url.searchParams.get("index"));
        if (!Number.isInteger(index) || index < 0) {
          send(res, 400, { error: "missing or invalid ?index=" });
          return;
        }
        try {
          send(res, 200, await buildContextTool(LOG_DIR, file, index));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid request file name")) send(res, 400, { error: msg });
          else if (msg.startsWith("request file not found")) send(res, 404, { error: msg });
          else if (msg.startsWith("tool index out of range")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/projects":
        send(res, 200, await buildProjects(PROJECTS_DIR));
        return;
      case "/api/projects/memories": {
        const project = url.searchParams.get("project");
        if (!project) {
          send(res, 400, { error: "missing ?project=" });
          return;
        }
        try {
          send(res, 200, await buildProjectMemories(PROJECTS_DIR, project));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid project name")) send(res, 400, { error: msg });
          else if (msg.startsWith("project not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/projects/memory": {
        const project = url.searchParams.get("project");
        const name = url.searchParams.get("name");
        if (!project || !name) {
          send(res, 400, { error: "missing ?project= or ?name=" });
          return;
        }
        try {
          send(res, 200, await buildMemory(PROJECTS_DIR, project, name));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid project name") || msg.startsWith("invalid memory file name")) {
            send(res, 400, { error: msg });
          } else if (msg.startsWith("project not found") || msg.startsWith("memory file not found")) {
            send(res, 404, { error: msg });
          } else throw err;
        }
        return;
      }
      case "/api/sessions":
        send(res, 200, await buildSessions(LOG_DIR));
        return;
      case "/api/sessions/stream":
        await serveSse(req, res, {
          watchPath: resolveSessionsDir(LOG_DIR),
          build: () => buildSessions(LOG_DIR),
          debounceMs: 400,
        });
        return;
      case "/api/sessions/session/stream": {
        const id = url.searchParams.get("id");
        if (!id) {
          send(res, 400, { error: "missing ?id=" });
          return;
        }
        let file: string;
        try {
          file = resolveSessionFile(LOG_DIR, id);
        } catch (err) {
          send(res, 400, { error: (err as Error).message });
          return;
        }
        await serveSse(req, res, { watchPath: file, build: () => buildSession(LOG_DIR, id), debounceMs: 150 });
        return;
      }
      case "/api/sessions/graph":
        send(res, 200, await buildSessionsGraph(LOG_DIR));
        return;
      case "/api/sessions/graph/nodes": {
        const id = url.searchParams.get("id");
        if (!id) {
          send(res, 400, { error: "missing ?id=" });
          return;
        }
        try {
          send(res, 200, await buildSessionGraphNodes(LOG_DIR, id));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid session id")) send(res, 400, { error: msg });
          else if (msg.startsWith("session not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/sessions/session": {
        const id = url.searchParams.get("id");
        if (!id) {
          send(res, 400, { error: "missing ?id=" });
          return;
        }
        try {
          send(res, 200, await buildSession(LOG_DIR, id));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid session id")) send(res, 400, { error: msg });
          else if (msg.startsWith("session not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/sessions/breakdown": {
        const id = url.searchParams.get("id");
        if (!id) {
          send(res, 400, { error: "missing ?id=" });
          return;
        }
        try {
          send(res, 200, await buildSessionBreakdown(LOG_DIR, id));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid session id")) send(res, 400, { error: msg });
          else if (msg.startsWith("session not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/sessions/suggestions":
        send(res, 200, await buildSessionSuggestions(LOG_DIR));
        return;
      case "/api/sessions/suggestions/bucket": {
        const index = Number(url.searchParams.get("index"));
        if (!Number.isInteger(index) || index < 1) {
          send(res, 400, { error: "missing or invalid ?index=" });
          return;
        }
        try {
          send(res, 200, await buildSessionSuggestionBucket(LOG_DIR, index));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("suggestion bucket not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/sessions/errors": {
        const id = url.searchParams.get("id");
        if (!id) {
          send(res, 400, { error: "missing ?id=" });
          return;
        }
        try {
          send(res, 200, await buildSessionErrors(LOG_DIR, id));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid session id")) send(res, 400, { error: msg });
          else if (msg.startsWith("session not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      // The chat routes: the only paths that send a request out through the proxy.
      case "/api/chat/config":
        send(res, 200, await resolveChatConfig());
        return;
      // Which turns are in flight. A read, so it keeps the open CORS the other GETs have;
      // it names running sessions, never their content.
      case "/api/chat/running":
        send(res, 200, { running: listRunningChats() });
        return;
      case "/api/chat/sessions":
        await serveChat(req, res, (body) =>
          startChat(
            {
              prompt: body.prompt,
              model: body.model,
              maxTokens: body.maxTokens,
              system: body.system,
              mode: body.mode,
              // The dashboard names the session up front so it can stop the first turn.
              sessionId: body.sessionId,
              permissionMode: body.permissionMode,
            },
            LOG_DIR,
          ),
        );
        return;
      case "/api/chat/sessions/message":
        await serveChat(req, res, (body) => continueChat({ sessionId: body.sessionId, prompt: body.prompt }, LOG_DIR));
        return;
      // Ends the turn, not the session: the in-flight send returns what it had.
      case "/api/chat/stop":
        await serveChat(req, res, async (body) => stopChat({ sessionId: body.sessionId }));
        return;
      // Ends the session: "New chat" evicts it rather than leaving it resident forever.
      case "/api/chat/sessions/end":
        await serveChat(req, res, async (body) => endChat({ sessionId: body.sessionId }));
        return;
      case "/api/skim":
        send(res, 200, await buildSkim(LOG_DIR, date));
        return;
      case "/api/skim/trend":
        send(res, 200, await buildSkimTrend(LOG_DIR, parseDays(url.searchParams.get("days"))));
        return;
      case "/api/withheld":
        send(res, 200, await buildWithheld(LOG_DIR, parseDays(url.searchParams.get("days"))));
        return;
      case "/api/hooks-plugins":
        send(res, 200, await buildHooksPlugins());
        return;
      case "/api/filters":
        send(res, 200, buildFilters());
        return;
      default:
        send(res, 404, { error: `not found: ${url.pathname}` });
        return;
    }
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`[claude-proxy-server] listening on http://${HOST}:${PORT}`);
  console.log(`[claude-proxy-server] reading audit logs from ${LOG_DIR}`);
  const chat = await resolveChatConfig();
  console.log(
    `[claude-proxy-server] chat sends ${chat.model} through ${chat.baseUrl} over the ${chat.transport} transport` +
      ` in ${chat.mode} mode` +
      (chat.ready ? "" : ` (disabled: ${chat.readyHint})`),
  );
  // Agent mode can write to the repo, so say so at startup rather than only in docs.
  if (chat.mode === "agent" && chat.agent) {
    const { cwd, alias, aliasFound, flags, permissionMode } = chat.agent;
    const mirrors = aliasFound
      ? `mirroring the \`${alias}\` alias${flags.disallowedTools.length ? ` (withholding ${flags.disallowedTools.join(", ")})` : ""}`
      : `no \`${alias}\` alias found — running a bare claude`;
    console.log(`[claude-proxy-server] agent turns run in ${cwd} with tools (${permissionMode} by default, per-session on the form), ${mirrors}`);
  }
});
