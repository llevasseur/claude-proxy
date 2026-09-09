#!/usr/bin/env node
/**
 * The dashboard sheet's flow-spacing gate: in claude's admin sheet, the gap between a
 * `.grid` and the `.grid` or `.card` stacked under it rides the *earlier* sibling
 * (`.grid:has(+ .card) { margin-bottom: … }`), never a `margin-top` on the later one.
 *
 * `styles.css` declares `components` after `layout`, so a component sheet's `margin`
 * shorthand written for its bottom value alone silently zeroes a layout `margin-top`
 * — `.usage-note`'s `margin: 0 0 var(--space-10)` left the Overview's internet-spend
 * card flush against the usage meters, with nothing failing or warning. No component
 * sheet styles `.grid`, so on the earlier sibling the gap is out of their reach.
 *
 * claude's sheet only: codex's `layout/card.css` is a mirror fusion carried in, and
 * rewriting its spacing is the visual change ADR 0050's boundary forbids. Same-class
 * runs like `.nav-group + .nav-group` are outside the rule — their subject is neither
 * class.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sheetRoot = join(root, 'stacks/claude/admin/src/styles');

/** The layout classes a page's blocks are composed from. */
const FLOW_CLASSES = ['.card', '.grid'];
/** Longhands and shorthands that can set a top margin. */
const TOP_MARGIN = /^\s*(margin-top|margin-block-start|margin-block|margin)\s*:/;

const errors = [];

function cssFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...cssFiles(path));
    else if (entry.endsWith('.css')) found.push(path);
  }
  return found;
}

/**
 * The last compound of a selector — what the rule styles. A `:has()` argument is
 * stripped first, so the `.card` in `.grid:has(+ .card)` is not read as the subject.
 */
function subjectOf(selector) {
  const withoutRelative = selector.replace(/:has\([^)]*\)/g, '');
  const parts = withoutRelative.split(/[+~>\s]+/).filter(Boolean);
  return parts.at(-1) ?? '';
}

/** True when this selector reaches its subject across a sibling combinator. */
function isSiblingSelector(selector) {
  return /[+~]/.test(selector.replace(/:has\([^)]*\)/g, ''));
}

for (const file of cssFiles(sheetRoot)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  // Selector preludes, innermost last. An at-rule (`@layer`, `@container`, `@media`)
  // pushes an empty prelude, so a declaration inside one is attributed to the rule
  // around it.
  const open = [];
  let prelude = '';
  let inComment = false;

  lines.forEach((line, index) => {
    let text = line;
    if (inComment) {
      const end = text.indexOf('*/');
      if (end === -1) return;
      text = text.slice(end + 2);
      inComment = false;
    }
    text = text.replace(/\/\*.*?\*\//g, '');
    const start = text.indexOf('/*');
    if (start !== -1) {
      inComment = true;
      text = text.slice(0, start);
    }

    const selector = open.at(-1) ?? '';
    // Part by part: one offending entry in a list of five is still the bug.
    const offending = selector
      .split(',')
      .map((part) => part.trim())
      .filter(
        (part) =>
          part && isSiblingSelector(part) && FLOW_CLASSES.some((flowClass) => subjectOf(part).includes(flowClass)),
      );
    if (offending.length > 0 && TOP_MARGIN.test(text)) {
      errors.push(
        `${relative(root, file)}:${index + 1}: a top margin on \`${offending.join(', ')}\` — a component sheet's ` +
          '`margin` shorthand overrides it silently, because `components` is declared after `layout`. Put the ' +
          'gap on the earlier sibling instead: `.grid:has(+ .card) { margin-bottom: … }`.',
      );
    }

    for (const char of text) {
      if (char === '{') {
        open.push(prelude.trim().startsWith('@') ? '' : prelude);
        prelude = '';
      } else if (char === '}') {
        open.pop();
        prelude = '';
      } else {
        prelude += char;
      }
    }
    if (text.trim().endsWith(',') || (prelude.trim() && !text.includes('{'))) prelude += ' ';
  });
}

if (errors.length > 0) {
  console.error(`check-css-flow-spacing: ${errors.length} problem(s)\n`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(`check-css-flow-spacing: ok (${cssFiles(sheetRoot).length} files)`);
