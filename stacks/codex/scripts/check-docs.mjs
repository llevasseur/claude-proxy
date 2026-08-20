import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const docsRoot = join(root, 'docs');
const markdown = [];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name.endsWith('.md')) markdown.push(path);
  }
}

collect(docsRoot);
const errors = [];
const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

for (const file of markdown) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(linkPattern)) {
    const target = match[1]?.split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = resolve(dirname(file), decodeURIComponent(target));
    if (!resolved.startsWith(docsRoot) || !existsSync(resolved)) {
      errors.push(`${relative(root, file)}: unresolved link ${target}`);
    }
  }
}

const rootIndex = readFileSync(join(docsRoot, 'index.md'), 'utf8');
for (const section of ['adrs', 'features', 'specs', 'roadmap']) {
  if (!rootIndex.includes(`(${section}/index.md)`)) errors.push(`docs/index.md: missing ${section} index`);
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`checked ${markdown.length} documentation files`);
