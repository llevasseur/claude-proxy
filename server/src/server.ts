import fs from "node:fs";
import http from "node:http";
import {
  isSuggestionRecurrence,
  isSuggestionStatus,
  parseBucketRange,
  parseSuggestionStatusUpdates,
  type SuggestionRecurrence,
  type SuggestionStatus,
} from "@claude-proxy/core";
import {
  buildCommand,
  buildCommandRun,
  buildCommands,
  buildContext,
  buildContextDetail,
  buildContextMessage,
  buildContextTool,
  buildJob,
  buildJobDelete,
  buildJobFile,
  buildJobs,
  buildMemory,
  buildProjectMemories,
  buildProjects,
  buildSession,
  buildSessionBreakdown,
  buildSessionErrors,
  buildSessionNodeTexts,
  buildSessions,
  buildSessionGraphNodes,
  buildSessionsGraph,
  buildSessionSuggestionBucket,
  buildSessionSuggestions,
  buildSuggestionStatus,
  applySuggestionStatus,
  buildSkim,
  buildSkimTrend,
  buildSummary,
  buildTools,
  buildTrends,
  buildUsage,
  buildWithheld,
  buildHooksPlugins,
  buildFilters,
} from "./api.js";
import { resolveArchiveDir } from "./archive.js";
import { reconcileCommandRuns, resolveCommandsDir } from "./command-runs.js";
import { resolveDbPath } from "./db/open.js";
import { dbReadsEnabled, readSource, shadowSource, startSubstrate, stopSubstrate } from "./db/runtime.js";
import type { SidecarSource } from "./db/source.js";
import { shadowCheck, shadowEnabled } from "./parity.js";
import {
  continueChat,
  endChat,
  listRunningChats,
  resolveChatConfig,
  resolveThreadId,
  startChat,
  stopChat,
  UUID_RE,
} from "./chat.js";
import { resolveJobsDir } from "./jobs.js";
import { countSidecarFiles, resolveLogDir } from "./logs.js";
import { resolveProjectsDir } from "./projects.js";
import { resolveSessionFile, resolveSessionsDir } from "./sessions.js";
import { resolveSettingsPath } from "./settings.js";
import { resolveUsageLimits } from "./usage-config.js";

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? "127.0.0.1"; // localhost-only by default
const LOG_DIR = resolveLogDir();
const ARCHIVE_DIR = resolveArchiveDir();
const PROJECTS_DIR = resolveProjectsDir();
const JOBS_DIR = resolveJobsDir();
const USAGE_LIMITS = resolveUsageLimits();
const COMMANDS_DIR = resolveCommandsDir();
const SETTINGS_PATH = resolveSettingsPath();

/**
 * Bring the command-run store up to date, then build.
 *
 * The reconcile pass is the only writer, so concurrent requests — and the SSE watcher
 * firing on the same log change that woke a request — share one in-flight pass rather
 * than racing to append the same records. A failure is swallowed: the store is a cache
 * of the logs, and serving it slightly stale beats 500-ing the page.
 */
let reconciling: Promise<unknown> | null = null;
function reconcileCommands(): Promise<unknown> {
  reconciling ??= reconcileCommandRuns(LOG_DIR, COMMANDS_DIR)
    .catch(() => undefined)
    .finally(() => {
      reconciling = null;
    });
  return reconciling;
}

async function withCommandReconcile<T>(build: () => Promise<T>): Promise<T> {
  await reconcileCommands();
  return build();
}

/**
 * Shadow mode: the response has already been sent; ask the backing it did *not*
 * come from the same question and log any disagreement.
 *
 * Normally that is the file scan checking the substrate, and the substrate
 * checking the files under `DB_READS=0`.
 *
 * Off unless `SHADOW_DB=1`. It cannot change what was served: the send has
 * happened, the comparison is a later tick, and `shadowCheck` swallows its own
 * failures. Callers hand both sides the identical `now`, so a clock tick cannot
 * masquerade as a mismatch.
 */
function shadow<T>(label: string, served: T, build: (source: SidecarSource) => Promise<T>): void {
  const other = shadowSource();
  if (!other) return;
  shadowCheck(label, served, () => build(other), readSource().kind);
}

/** Everything but the chat routes is a read-only view of already-captured logs. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

/** The write surface: the only routes that are not read-only GETs. */
const CHAT_ROUTES = new Set(["/api/chat/sessions", "/api/chat/sessions/message", "/api/chat/sessions/end", "/api/chat/stop"]);

/** The suggestion flags: a GET list under the open read CORS, a POST that writes them. */
const SUGGESTION_STATUS_ROUTE = "/api/sessions/suggestions/status";

/** The one destructive route: removes a `~/.claude/jobs/<id>` directory from disk. */
const JOB_DELETE_ROUTE = "/api/jobs/delete";

/** Paths whose POST goes through the origin-checked write CORS. */
const WRITE_ROUTES = new Set([...CHAT_ROUTES, SUGGESTION_STATUS_ROUTE, JOB_DELETE_ROUTE]);

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
    send(res, /(^|\b)not found:/.test(msg) ? 404 : 500, { error: msg });
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

/**
 * A POST route: the same origin check, method check and JSON body the chat routes
 * have, with the failure→status mapping left to the caller since each write
 * surface fails in its own vocabulary.
 */
async function servePost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: (body: Record<string, unknown>) => Promise<unknown>,
  errorStatus: (msg: string) => number = chatErrorStatus,
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
    send(res, errorStatus(msg), { error: msg }, cors);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, WRITE_ROUTES.has(url.pathname) ? chatCors(req.headers.origin) : CORS);
    res.end();
    return;
  }

  // Everything outside the write allowlist is a read, and the open `*` CORS it answers
  // under is only safe while it stays one. The allowlist gates its own methods inside
  // `servePost`, under the origin-checked CORS instead.
  if (req.method !== "GET" && !WRITE_ROUTES.has(url.pathname)) {
    send(res, 405, { error: `method not allowed: ${req.method}` }, { ...CORS, allow: "GET, OPTIONS" });
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
      case "/api/summary": {
        const now = new Date();
        const summary = await buildSummary(LOG_DIR, date, now, readSource());
        send(res, 200, summary);
        shadow("/api/summary", summary, (source) => buildSummary(LOG_DIR, date, now, source));
        return;
      }
      // Today's digest moves with every captured request, so this follows the log
      // directory rather than any one file.
      case "/api/summary/stream":
        await serveSse(req, res, {
          watchPath: LOG_DIR,
          build: () => buildSummary(LOG_DIR, date, new Date(), readSource()),
          debounceMs: 600,
        });
        return;
      case "/api/trends": {
        const days = parseDays(url.searchParams.get("days"));
        const now = new Date();
        const trends = await buildTrends(LOG_DIR, days, now, ARCHIVE_DIR, readSource());
        send(res, 200, trends);
        shadow("/api/trends", trends, (source) => buildTrends(LOG_DIR, days, now, ARCHIVE_DIR, source));
        return;
      }
      case "/api/usage": {
        const now = new Date();
        const usage = await buildUsage(LOG_DIR, USAGE_LIMITS, now, readSource());
        send(res, 200, usage);
        shadow("/api/usage", usage, (source) => buildUsage(LOG_DIR, USAGE_LIMITS, now, source));
        return;
      }
      // Debounced generously: a busy session writes three files per request and
      // the numbers barely move between them.
      case "/api/usage/stream":
        await serveSse(req, res, {
          watchPath: LOG_DIR,
          build: () => buildUsage(LOG_DIR, USAGE_LIMITS, new Date(), readSource()),
          debounceMs: 600,
        });
        return;
      case "/api/tools": {
        const now = new Date();
        const tools = await buildTools(LOG_DIR, date, now, readSource());
        send(res, 200, tools);
        shadow("/api/tools", tools, (source) => buildTools(LOG_DIR, date, now, source));
        return;
      }
      case "/api/context": {
        const days = parseDays(url.searchParams.get("days"));
        const now = new Date();
        const context = await buildContext(LOG_DIR, days, now, readSource());
        send(res, 200, context);
        shadow("/api/context", context, (source) => buildContext(LOG_DIR, days, now, source));
        return;
      }
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
      // The device's background jobs: `~/.claude/jobs`. Reads are open like their
      // neighbours; the delete below is the one route here that changes the disk.
      case "/api/jobs":
        send(res, 200, await buildJobs(JOBS_DIR));
        return;
      case "/api/jobs/job": {
        const id = url.searchParams.get("id");
        if (!id) {
          send(res, 400, { error: "missing ?id=" });
          return;
        }
        try {
          send(res, 200, await buildJob(JOBS_DIR, id));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid job id")) send(res, 400, { error: msg });
          else if (msg.startsWith("job not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/jobs/file": {
        const id = url.searchParams.get("id");
        const file = url.searchParams.get("file");
        if (!id || !file) {
          send(res, 400, { error: "missing ?id= or ?file=" });
          return;
        }
        try {
          send(res, 200, await buildJobFile(JOBS_DIR, id, file));
        } catch (err) {
          const msg = (err as Error).message;
          if (
            msg.startsWith("invalid job id") ||
            msg.startsWith("invalid job file path") ||
            msg.startsWith("job file is a directory")
          ) {
            send(res, 400, { error: msg });
          } else if (msg.startsWith("job not found") || msg.startsWith("job file not found")) {
            send(res, 404, { error: msg });
          } else throw err;
        }
        return;
      }
      // Removes the directory for real. POST only, and through the origin-checked
      // write CORS rather than the read routes' `*`.
      case JOB_DELETE_ROUTE:
        await servePost(
          req,
          res,
          async (body) => {
            const id = body.id;
            if (typeof id !== "string" || id === "") throw new Error("missing id");
            return buildJobDelete(JOBS_DIR, id);
          },
          (msg) => {
            if (msg.startsWith("job not found")) return 404;
            if (msg.startsWith("job is still running")) return 409;
            return 400; // invalid/missing id, or a symlinked directory
          },
        );
        return;
      case "/api/sessions": {
        const sessions = await buildSessions(LOG_DIR, readSource());
        send(res, 200, sessions);
        shadow("/api/sessions", sessions, (source) => buildSessions(LOG_DIR, source));
        return;
      }
      case "/api/sessions/stream":
        await serveSse(req, res, {
          watchPath: resolveSessionsDir(LOG_DIR),
          build: () => buildSessions(LOG_DIR, readSource()),
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
        await serveSse(req, res, { watchPath: file, build: () => buildSession(LOG_DIR, id, readSource()), debounceMs: 150 });
        return;
      }
      case "/api/sessions/graph": {
        const graph = await buildSessionsGraph(LOG_DIR, readSource());
        send(res, 200, graph);
        shadow("/api/sessions/graph", graph, (source) => buildSessionsGraph(LOG_DIR, source));
        return;
      }
      case "/api/sessions/node-text": {
        const id = url.searchParams.get("id");
        if (!id) {
          send(res, 400, { error: "missing ?id=" });
          return;
        }
        try {
          const texts = await buildSessionNodeTexts(LOG_DIR, id, readSource());
          send(res, 200, texts);
          shadow("/api/sessions/node-text", texts, (source) => buildSessionNodeTexts(LOG_DIR, id, source));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid session id")) send(res, 400, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/sessions/graph/nodes": {
        const id = url.searchParams.get("id");
        if (!id) {
          send(res, 400, { error: "missing ?id=" });
          return;
        }
        try {
          const now = new Date();
          const nodes = await buildSessionGraphNodes(LOG_DIR, id, now, readSource());
          send(res, 200, nodes);
          shadow("/api/sessions/graph/nodes", nodes, (source) => buildSessionGraphNodes(LOG_DIR, id, now, source));
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
          const session = await buildSession(LOG_DIR, id, readSource());
          send(res, 200, session);
          shadow("/api/sessions/session", session, (source) => buildSession(LOG_DIR, id, source));
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
          const now = new Date();
          const breakdown = await buildSessionBreakdown(LOG_DIR, id, now, readSource());
          send(res, 200, breakdown);
          shadow("/api/sessions/breakdown", breakdown, (source) => buildSessionBreakdown(LOG_DIR, id, now, source));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("invalid session id")) send(res, 400, { error: msg });
          else if (msg.startsWith("session not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      // The Commands eval page. Every read reconciles first, so the store is current
      // even on a cold server, and the streams follow a run as it happens.
      case "/api/commands": {
        // The shadow read deliberately skips `withCommandReconcile`: the served
        // read already reconciled, and the store it wrote is what ingest sees.
        const commands = await withCommandReconcile(() => buildCommands(LOG_DIR, COMMANDS_DIR, readSource()));
        send(res, 200, commands);
        shadow("/api/commands", commands, (source) => buildCommands(LOG_DIR, COMMANDS_DIR, source));
        return;
      }
      case "/api/commands/stream":
        await serveSse(req, res, {
          watchPath: LOG_DIR,
          build: () => withCommandReconcile(() => buildCommands(LOG_DIR, COMMANDS_DIR, readSource())),
          debounceMs: 600,
        });
        return;
      case "/api/commands/command":
      case "/api/commands/command/stream": {
        const name = url.searchParams.get("name");
        if (!name) {
          send(res, 400, { error: "missing ?name=" });
          return;
        }
        const flags = (url.searchParams.get("flags") ?? "").split(",").filter(Boolean);
        const build = () => withCommandReconcile(() => buildCommand(LOG_DIR, COMMANDS_DIR, name, flags, readSource()));
        if (url.pathname.endsWith("/stream")) {
          await serveSse(req, res, { watchPath: LOG_DIR, build, debounceMs: 600 });
          return;
        }
        try {
          const command = await build();
          send(res, 200, command);
          shadow("/api/commands/command", command, (source) =>
            buildCommand(LOG_DIR, COMMANDS_DIR, name, flags, source),
          );
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("command not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/commands/run":
      case "/api/commands/run/stream": {
        const id = url.searchParams.get("id");
        if (!id) {
          send(res, 400, { error: "missing ?id=" });
          return;
        }
        const build = () => withCommandReconcile(() => buildCommandRun(LOG_DIR, id, readSource()));
        if (url.pathname.endsWith("/stream")) {
          await serveSse(req, res, { watchPath: LOG_DIR, build, debounceMs: 600 });
          return;
        }
        try {
          const run = await build();
          send(res, 200, run);
          shadow("/api/commands/run", run, (source) => buildCommandRun(LOG_DIR, id, source));
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("command run not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      case "/api/sessions/suggestions": {
        const suggestions = await buildSessionSuggestions(LOG_DIR, readSource());
        send(res, 200, suggestions);
        shadow("/api/sessions/suggestions", suggestions, (source) => buildSessionSuggestions(LOG_DIR, source));
        return;
      }
      case "/api/sessions/suggestions/bucket": {
        const index = Number(url.searchParams.get("index"));
        if (!Number.isInteger(index) || index < 1) {
          send(res, 400, { error: "missing or invalid ?index=" });
          return;
        }
        try {
          const now = new Date();
          const bucket = await buildSessionSuggestionBucket(LOG_DIR, index, now, readSource());
          send(res, 200, bucket);
          shadow("/api/sessions/suggestions/bucket", bucket, (source) =>
            buildSessionSuggestionBucket(LOG_DIR, index, now, source),
          );
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.startsWith("suggestion bucket not found")) send(res, 404, { error: msg });
          else throw err;
        }
        return;
      }
      // The flags on those suggestions: GET lists them, POST records them. The GET is
      // as read-only as its neighbours; the POST writes a file, so it goes through the
      // origin-checked write CORS the chat routes use.
      case SUGGESTION_STATUS_ROUTE: {
        // Anything that isn't the GET goes through the write path, which refuses a
        // method that is neither rather than letting it fall through to the list.
        if (req.method !== "GET") {
          await servePost(
            req,
            res,
            // The flags stay a JSON file; what goes through the seam is the
            // derived half this echoes back — the bucket/suggestion join — so
            // the response cannot describe a different corpus than the GET.
            (body) =>
              applySuggestionStatus(LOG_DIR, parseSuggestionStatusUpdates(body.updates), new Date(), readSource()),
            () => 400,
          );
          return;
        }
        const rangeParam = url.searchParams.get("range");
        const statusParam = url.searchParams.get("status");
        const recurrenceParam = url.searchParams.get("recurrence");
        let buckets: number[] | undefined;
        let statuses: SuggestionStatus[] | undefined;
        let recurrences: SuggestionRecurrence[] | undefined;
        try {
          if (rangeParam) buckets = parseBucketRange(rangeParam);
          if (statusParam) {
            statuses = statusParam.split(",").map((s) => {
              const status = s.trim();
              if (!isSuggestionStatus(status)) throw new Error(`invalid status: ${status}`);
              return status;
            });
          }
          if (recurrenceParam) {
            recurrences = recurrenceParam.split(",").map((s) => {
              const recurrence = s.trim();
              if (!isSuggestionRecurrence(recurrence)) throw new Error(`invalid recurrence: ${recurrence}`);
              return recurrence;
            });
          }
        } catch (err) {
          send(res, 400, { error: (err as Error).message });
          return;
        }
        const detail = url.searchParams.get("detail");
        const filter = {
          buckets,
          statuses,
          recurrences,
          detail: detail === "1" || detail === "true",
        };
        const status = await buildSuggestionStatus(LOG_DIR, filter, readSource());
        send(res, 200, status);
        shadow(SUGGESTION_STATUS_ROUTE, status, (source) => buildSuggestionStatus(LOG_DIR, filter, source));
        return;
      }
      case "/api/sessions/errors": {
        const id = url.searchParams.get("id");
        if (!id) {
          send(res, 400, { error: "missing ?id=" });
          return;
        }
        try {
          const now = new Date();
          const errors = await buildSessionErrors(LOG_DIR, id, now, readSource());
          send(res, 200, errors);
          shadow("/api/sessions/errors", errors, (source) => buildSessionErrors(LOG_DIR, id, now, source));
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
      // The transcript's own id for a chat session id, or null while the proxy has yet to
      // write it. Answers from the sessions dir rather than the in-memory map, so it survives
      // a restart and outlives the turn. Non-blocking — the caller polls.
      case "/api/chat/thread": {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          send(res, 400, { error: "missing ?sessionId=" });
          return;
        }
        if (!UUID_RE.test(sessionId)) {
          send(res, 400, { error: "invalid sessionId: expected a uuid" });
          return;
        }
        send(res, 200, { sessionId, threadId: await resolveThreadId(LOG_DIR, sessionId, 0) });
        return;
      }
      case "/api/chat/sessions":
        await servePost(req, res, (body) =>
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
        await servePost(req, res, (body) => continueChat({ sessionId: body.sessionId, prompt: body.prompt }, LOG_DIR));
        return;
      // Ends the turn, not the session: the in-flight send returns what it had.
      case "/api/chat/stop":
        await servePost(req, res, async (body) => stopChat({ sessionId: body.sessionId }));
        return;
      // Ends the session: "New chat" evicts it rather than leaving it resident forever.
      case "/api/chat/sessions/end":
        await servePost(req, res, async (body) => endChat({ sessionId: body.sessionId }));
        return;
      case "/api/skim": {
        const now = new Date();
        const skim = await buildSkim(LOG_DIR, date, now, readSource());
        send(res, 200, skim);
        shadow("/api/skim", skim, (source) => buildSkim(LOG_DIR, date, now, source));
        return;
      }
      case "/api/skim/trend": {
        const now = new Date();
        const days = parseDays(url.searchParams.get("days"));
        const trend = await buildSkimTrend(LOG_DIR, days, now, readSource());
        send(res, 200, trend);
        shadow("/api/skim/trend", trend, (source) => buildSkimTrend(LOG_DIR, days, now, source));
        return;
      }
      case "/api/withheld": {
        const now = new Date();
        const days = parseDays(url.searchParams.get("days"));
        const withheld = await buildWithheld(LOG_DIR, days, SETTINGS_PATH, now, readSource());
        send(res, 200, withheld);
        shadow("/api/withheld", withheld, (source) => buildWithheld(LOG_DIR, days, SETTINGS_PATH, now, source));
        return;
      }
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
  // The SQLite view of those logs, kept current by a watcher, and what the
  // routes read. Report which side is serving — a substrate that failed to open
  // falls back silently otherwise.
  const substrate = startSubstrate(LOG_DIR, (err) => console.warn(`[claude-proxy-server] ingest: ${err.message}`));
  console.log(
    substrate
      ? `[claude-proxy-server] ingesting into ${resolveDbPath(LOG_DIR)}` +
          (shadowEnabled() ? " (shadow comparison on)" : " (set SHADOW_DB=1 to compare it against the files)")
      : "[claude-proxy-server] sqlite substrate unavailable — serving from the log files only",
  );
  console.log(
    readSource().kind === "db"
      ? "[claude-proxy-server] serving reads from the substrate (set DB_READS=0 to fall back to the file scan)"
      : `[claude-proxy-server] serving reads from the file scan${dbReadsEnabled() ? "" : " (DB_READS=0)"}`,
  );
  // Release the watcher and the WAL handle on the way out.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stopSubstrate();
      process.exit(0);
    });
  }
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
