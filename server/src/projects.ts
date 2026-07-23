import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Default location of Claude Code's per-project state: `~/.claude/projects`. */
export function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Resolve the projects directory: `CLAUDE_PROJECTS` env override, else the default. */
export function resolveProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PROJECTS ? path.resolve(env.CLAUDE_PROJECTS) : defaultProjectsDir();
}

/** Claude Code encodes a project's absolute path into a single directory name by
 * replacing separators with `-` (e.g. `-Users-me-Documents-app`). Names carry no
 * path separators; worktree dirs additionally use `+`. Reject anything else so a
 * URL-supplied project can't escape the projects root. */
const PROJECT_NAME_RE = /^[0-9A-Za-z._+-]+$/;

/** Memory files are flat `*.md` files inside a project's `memory/` dir. No path
 * separators — the name comes from the URL, so traversal must be impossible. */
const MEMORY_FILE_RE = /^[0-9A-Za-z._-]+\.md$/;

/** One project directory plus how many memory files it holds. */
export interface ProjectSummary {
  /** On-disk directory name (also the route param); the encoded project path. */
  name: string;
  /** Number of `*.md` files in the project's `memory/` dir. */
  memoryCount: number;
}

/** One memory file's listing metadata (contents fetched separately). */
export interface MemoryFileSummary {
  /** File name including the `.md` extension (also the route param). */
  name: string;
  bytes: number;
  /** Last-modified time, ISO 8601 (UTC). */
  modified: string;
}

/** A single memory file's full contents. */
export interface MemoryDetail {
  project: string;
  name: string;
  content: string;
  bytes: number;
  modified: string;
}

/** Resolve a project's `memory/` dir, validating the (URL-supplied) name and
 * confirming the resolved path stays directly inside `projectsDir`. */
function resolveMemoryDir(projectsDir: string, project: string): string {
  if (!PROJECT_NAME_RE.test(project)) {
    throw new Error(`invalid project name: ${project}`);
  }
  const projectDir = path.resolve(projectsDir, project);
  if (path.dirname(projectDir) !== path.resolve(projectsDir)) {
    throw new Error(`invalid project name: ${project}`);
  }
  return path.join(projectDir, "memory");
}

/**
 * List every project that has a `memory/` directory, with its memory-file count.
 * Projects without a `memory/` dir are omitted — this view exists to browse
 * memories, so an empty project is just noise. Sorted by count (desc), then name.
 * Throws only if the projects root itself cannot be read.
 */
export async function listProjects(projectsDir: string): Promise<ProjectSummary[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read projects directory ${projectsDir}: ${(err as Error).message}`);
  }

  const projects: ProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const memoryCount = await countMemoryFiles(path.join(projectsDir, entry.name, "memory"));
    if (memoryCount === null) continue; // no memory/ dir
    projects.push({ name: entry.name, memoryCount });
  }

  projects.sort((a, b) => b.memoryCount - a.memoryCount || a.name.localeCompare(b.name));
  return projects;
}

/** Count `*.md` files in a `memory/` dir, or `null` when the dir doesn't exist. */
async function countMemoryFiles(memoryDir: string): Promise<number | null> {
  try {
    const files = await readdir(memoryDir);
    return files.filter((f) => f.endsWith(".md")).length;
  } catch {
    return null;
  }
}

/**
 * List the `*.md` memory files for one project, each with size and mtime.
 * `MEMORY.md` (the index) is pinned first; the rest are alphabetical. Returns an
 * empty list when the project exists but has no `memory/` dir. Throws a labelled
 * error the server maps to 400 (bad name) / 404 (missing project).
 */
export async function listProjectMemories(projectsDir: string, project: string): Promise<MemoryFileSummary[]> {
  const memoryDir = resolveMemoryDir(projectsDir, project);

  let names: string[];
  try {
    names = await readdir(memoryDir);
  } catch {
    // The project dir may exist without a memory/ subdir — treat as empty, but
    // a genuinely missing project should 404.
    try {
      await stat(path.dirname(memoryDir));
      return [];
    } catch {
      throw new Error(`project not found: ${project}`);
    }
  }

  const mdFiles = names.filter((f) => f.endsWith(".md"));
  const files: MemoryFileSummary[] = await Promise.all(
    mdFiles.map(async (name) => {
      const info = await stat(path.join(memoryDir, name));
      return { name, bytes: info.size, modified: info.mtime.toISOString() };
    }),
  );

  files.sort((a, b) => {
    if (a.name === "MEMORY.md") return -1;
    if (b.name === "MEMORY.md") return 1;
    return a.name.localeCompare(b.name);
  });
  return files;
}

/**
 * Read one memory file's full contents. Validates both `project` and `name` and
 * confirms the resolved path stays inside the project's `memory/` dir before
 * touching disk. Throws a labelled error the server maps to 400 (bad name) /
 * 404 (missing file).
 */
export async function readMemory(projectsDir: string, project: string, name: string): Promise<MemoryDetail> {
  const memoryDir = resolveMemoryDir(projectsDir, project);
  if (!MEMORY_FILE_RE.test(name)) {
    throw new Error(`invalid memory file name: ${name}`);
  }
  const full = path.resolve(memoryDir, name);
  if (path.dirname(full) !== path.resolve(memoryDir)) {
    throw new Error(`invalid memory file name: ${name}`);
  }

  let content: string;
  let info: import("node:fs").Stats;
  try {
    [content, info] = await Promise.all([readFile(full, "utf8"), stat(full)]);
  } catch {
    throw new Error(`memory file not found: ${name}`);
  }

  return { project, name, content, bytes: info.size, modified: info.mtime.toISOString() };
}
