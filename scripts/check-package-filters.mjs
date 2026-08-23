#!/usr/bin/env node
//
// Every pnpm filter argument in this repository must name a scoped package.
//
// This gate exists because pnpm fails open. A filter that matches no package is
// answered with a warning and exit 0 — the command "succeeds" and does nothing.
// So a stale package name in a workflow, a launchd plist, a doc, or a runtime
// string is invisible to every other gate we run: typecheck only sees import
// specifiers, and 29 of this rename's 184 sites are not TypeScript at all. The
// absence of a failure could never prove those sites were migrated, which is why
// this asserts the property directly rather than trusting a sweep. See
// docs/adrs/0055-the-rename-covers-every-non-import-reference.md.
//
// It reads tracked files only, via `git ls-files`, which is also what keeps
// node_modules and the log store out of the walk without an ignore list.
//
// It covers executable surfaces — source, scripts, package.json, workflows,
// .plist files, and AGENTS.md — and not records of what was measured. See
// UNSCANNED_DIRECTORIES below and
// docs/adrs/0057-the-filter-gate-covers-invocations-not-records.md.
//
// Usage: node scripts/check-package-filters.mjs
// Exit 0 when every filter argument is scoped, 1 otherwise.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The flag is spelled in a regex rather than as plain text so this file does not
// trip its own check when it scans itself.
const FILTER_ARG = /--filter(?:\s+|=)(?:['"`])?([^\s'"`,)\]}]+)/g;

// Extensions worth reading. TypeScript is here for completeness, but the reason
// the gate exists is the rest of the list: markdown, workflow YAML, shell, and
// the launchd plist that runs the retention job.
const SCANNED = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.md', '.json', '.yaml', '.yml', '.sh', '.plist']);

// Generated, and rewritten wholesale by pnpm — nothing here is a filter argument
// anyone typed.
const SKIPPED_FILES = new Set(['pnpm-lock.yaml']);

// The gate covers invocations, not records of what was measured: an ADR or a
// wayfinder plan quoting a broken command verbatim is the evidence, not a
// defect, and rewriting it to pass silently corrupts the record — it already
// happened once, to five sentences of ADR 0055. See
// docs/adrs/0057-the-filter-gate-covers-invocations-not-records.md.
//
// This narrows *where* the gate looks, not what it catches: a bare unscoped
// name still fails anywhere else, including every other directory under docs/,
// and AGENTS.md stays in scope deliberately — that file is not documentation
// here but the instruction every future agent reads.
const UNSCANNED_DIRECTORIES = ['docs/adrs/', 'docs/wayfinder/'];

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/**
 * Decide whether a filter argument names an unscoped package.
 *
 * Anything that is not a bare npm-style name is left alone: a path selector, a
 * documentation placeholder like `<pkg>`, a shell variable, a glob. Those are all
 * legitimate things to write after the flag, and flagging them would train people
 * to ignore this gate.
 */
function isUnscopedPackageName(raw) {
  // pnpm's dependency selectors decorate the name without changing which
  // package it is: `...pkg`, `pkg...`, `^pkg`, `pkg^`, `!pkg`.
  const name = raw
    .replace(/^\.{3}/, '')
    .replace(/\.{3}$/, '')
    .replace(/^\^/, '')
    .replace(/\^$/, '')
    .replace(/^!/, '');

  if (!name) return false;
  if (name.startsWith('@')) return false; // already scoped
  if (name.startsWith('.') || name.startsWith('/')) return false; // path selector

  return /^[a-z0-9][a-z0-9._-]*$/.test(name);
}

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean);

const findings = [];

for (const relative of tracked) {
  if (SKIPPED_FILES.has(relative)) continue;
  if (UNSCANNED_DIRECTORIES.some((directory) => relative.startsWith(directory))) continue;
  if (!SCANNED.has(path.extname(relative))) continue;

  let contents;
  try {
    contents = readFileSync(path.join(repoRoot, relative), 'utf8');
  } catch {
    continue; // unreadable or vanished between listing and reading
  }
  if (!contents.includes('--filter')) continue;

  const lines = contents.split('\n');
  for (const [index, line] of lines.entries()) {
    FILTER_ARG.lastIndex = 0;
    let match = FILTER_ARG.exec(line);
    while (match !== null) {
      if (isUnscopedPackageName(match[1])) {
        findings.push({
          file: relative,
          line: index + 1,
          name: match[1],
          text: line.trim(),
        });
      }
      match = FILTER_ARG.exec(line);
    }
  }
}

if (findings.length === 0) {
  console.log(`package filters: every filter argument in ${tracked.length} tracked files names a scoped package`);
  process.exit(0);
}

const byName = new Map();
for (const finding of findings) {
  byName.set(finding.name, (byName.get(finding.name) ?? 0) + 1);
}

console.error(`package filters: ${findings.length} filter argument(s) name an unscoped package.`);
console.error('pnpm answers a filter that matches nothing with a warning and exit 0, so each of');
console.error('these is a command that will silently do nothing.\n');

for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}  ${finding.text}`);
}

console.error('\nby package name:');
for (const [name, count] of [...byName].sort((a, b) => b[1] - a[1])) {
  console.error(`  ${count.toString().padStart(4)}  ${name}`);
}

process.exit(1);
