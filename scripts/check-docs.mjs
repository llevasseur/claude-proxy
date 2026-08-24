#!/usr/bin/env node
/**
 * The repository's docs gate.
 *
 * Recreated at the root from codex's `stacks/codex/scripts/check-docs.mjs`, which was
 * deleted along with the sibling bundles it walked. ADR 0056 records the three repairs
 * its assertions needed — assert section indexes by file, permit links out to tracked
 * source, derive the section list from what is present — and this script adds the
 * `scope` and bidirectional `superseded-by` assertions on top of them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const docsRoot = join(root, 'docs');

/**
 * Sections whose files are not concepts, so the `scope` assertion skips them.
 *
 * `history/` holds commit maps from the absorbed repositories — data files rather than
 * concepts, which is why okq does not index them either. `wayfinder/` holds a campaign's
 * ephemeral scaffolding, which that campaign's final ticket deletes wholesale.
 */
const NON_CONCEPT_SECTIONS = new Set(['history', 'wayfinder']);

const errors = [];
const markdown = [];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name.endsWith('.md')) markdown.push(path);
  }
}

collect(docsRoot);
markdown.sort();

/** Every path git tracks, absolute, so a link can be checked against the real index. */
const tracked = new Set(
  execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((path) => join(root, path)),
);

/**
 * Blank out fenced blocks and inline code spans.
 *
 * A document that quotes a link form as an example — ADR 0056 quotes `[adrs/](adrs/)` to
 * explain what okq generates — is not linking anywhere, and reading it as a link makes a
 * doc about links unable to describe one. Blanking rather than deleting keeps every
 * remaining offset where it was.
 */
function withoutCode(source) {
  return source
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (span) => span.replace(/./g, ' '));
}

/** Split on blank lines, so a declaration that wraps across lines stays one unit. */
function paragraphs(source) {
  return source.split(/\n\s*\n/);
}

function frontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---/.exec(source);
  if (!match) return null;
  const fields = new Map();
  let key = null;
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) {
      key = pair[1];
      fields.set(key, [pair[2].trim()].filter(Boolean));
    } else if (key && /^\s*-\s+/.test(line)) {
      fields.get(key).push(line.replace(/^\s*-\s+/, '').trim());
    }
  }
  return fields;
}

const unquote = (value) => value.replace(/^["']|["']$/g, '');

// --- Links resolve to something real, inside this repository -----------------------

const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

for (const file of markdown) {
  const prose = withoutCode(readFileSync(file, 'utf8'));
  for (const match of prose.matchAll(linkPattern)) {
    const target = match[1]?.split('#', 1)[0];
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const resolved = resolve(dirname(file), decodeURIComponent(target));
    const where = relative(root, file);

    // Still contained — by the repository rather than by `docs/`. A link that climbs out
    // of the checkout entirely has nothing to resolve against on another machine.
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      errors.push(`${where}: link escapes the repository: ${target}`);
      continue;
    }
    if (!existsSync(resolved)) {
      errors.push(`${where}: unresolved link: ${target}`);
      continue;
    }
    // A directory link is the form okq's generated index emits.
    if (statSync(resolved).isDirectory()) continue;
    if (!tracked.has(resolved)) {
      errors.push(`${where}: link resolves to an untracked file: ${target}`);
    }
  }
}

// --- Every section present carries its own index ------------------------------------

const sections = readdirSync(docsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const section of sections) {
  if (!existsSync(join(docsRoot, section, 'index.md'))) {
    errors.push(`docs/${section}: missing index.md`);
  }
}

// --- Every concept declares which stack it governs ----------------------------------

for (const file of markdown) {
  const section = relative(docsRoot, file).split('/')[0];
  if (NON_CONCEPT_SECTIONS.has(section)) continue;
  const fields = frontmatter(readFileSync(file, 'utf8'));
  // A section index carries no frontmatter and is navigation rather than a concept.
  if (!fields?.has('type')) continue;
  if (!fields.has('scope')) {
    errors.push(`${relative(root, file)}: missing required frontmatter field \`scope\``);
  }
}

// --- Supersession is discoverable from both ends ------------------------------------

const adrsRoot = join(docsRoot, 'adrs');
const adrs = new Map();
if (existsSync(adrsRoot)) {
  for (const name of readdirSync(adrsRoot)) {
    const number = /^(\d{4})-/.exec(name)?.[1];
    if (number) adrs.set(number, name);
  }
}

for (const [number, name] of [...adrs].sort()) {
  const file = join(adrsRoot, name);
  const fields = frontmatter(readFileSync(file, 'utf8'));
  const supersededBy = fields?.get('superseded-by') ?? [];
  for (const raw of supersededBy) {
    const successor = unquote(raw);
    const successorName = adrs.get(successor);
    if (!successorName) {
      errors.push(`docs/adrs/${name}: superseded-by names ${successor}, which is not a record`);
      continue;
    }
    // Bidirectional or it fails: the one-way link is the defect this assertion exists for.
    const successorSource = withoutCode(readFileSync(join(adrsRoot, successorName), 'utf8'));
    const declares = paragraphs(successorSource).some(
      (paragraph) => /supersede/i.test(paragraph) && paragraph.includes(name),
    );
    if (!declares) {
      errors.push(
        `docs/adrs/${successorName}: does not declare that it supersedes ${number}, ` +
          `which names it in \`superseded-by\``,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(
  `checked ${markdown.length} documentation files across ${sections.length} sections`,
);
