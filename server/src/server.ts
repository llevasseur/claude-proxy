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
  buildSessionErrors,
  buildSessions,
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
import { countSidecarFiles, resolveLogDir } from "./logs.js";
import { resolveProjectsDir } from "./projects.js";
import { resolveSessionFile, resolveSessionsDir } from "./sessions.js";

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? "127.0.0.1"; // localhost-only by default
const LOG_DIR = resolveLogDir();
const ARCHIVE_DIR = resolveArchiveDir();
const PROJECTS_DIR = resolveProjectsDir();

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
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

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
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
        // Live session list: watch the sessions dir, re-list on any change.
        await serveSse(req, res, {
          watchPath: resolveSessionsDir(LOG_DIR),
          build: () => buildSessions(LOG_DIR),
          debounceMs: 400,
        });
        return;
      case "/api/sessions/session/stream": {
        // Live single transcript: watch the `<id>.md` file, re-read on append.
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

server.listen(PORT, HOST, () => {
  console.log(`[claude-proxy-server] listening on http://${HOST}:${PORT}`);
  console.log(`[claude-proxy-server] reading audit logs from ${LOG_DIR}`);
});
