import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const docsDir = join(root, "docs");

const markdownFiles = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (entry.endsWith(".md")) {
      markdownFiles.push(path);
    }
  }
}
walk(docsDir);

let failed = false;
for (const file of markdownFiles) {
  const content = readFileSync(file, "utf8");
  const links = [...content.matchAll(/\]\(([^)\s]+)(#[^)\s]*)?\)/g)].map((match) => match[1]);
  for (const href of links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
      continue;
    }
    const target = resolve(dirname(file), decodeURIComponent(href.split("?")[0]));
    if (!existsSync(target)) {
      console.error(`${file}: broken link ${href}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log(`docs ok: ${markdownFiles.length} files checked`);
