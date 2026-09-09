#!/usr/bin/env node
/**
 * The dashboard sheet's flow-spacing gate.
 *
 * One invariant, and it exists because breaking it is silent. The gap between the
 * page-level blocks a route composes from — `.grid` and `.card` — is declared in
 * `@layer layout`, and `stacks/claude/admin/src/styles.css` declares `components`
 * after `layout`. So a component sheet wins that cascade outright, and a `margin`
 * shorthand written for its bottom value alone resets the top one on the way past:
 * `margin: 0 0 var(--space-10)` on `.usage-note` zeroed the `margin-top` a card
 * stacked under a grid used to get, and the Overview's internet-spend card rendered
 * flush against the usage meters. Nothing failed, nothing warned, and the sheet read
 * correctly in both files.
 *
 * The fix that holds is structural: spacing between two siblings rides the *earlier*
 * one, which is a `.grid` no component sheet styles. This script keeps it there — it
 * fails when a sibling-combinator rule sets a top margin on `.card` or `.grid`, which
 * is the shape a component margin can cancel.
 *
 * Scope is claude's sheet alone, deliberately. codex's `layout/card.css` is a
 * byte-identical mirror carried in by fusion, and rewriting its spacing would be the
 * visual change ADR 0050's boundary forbids; a sibling opting in is its own ticket.
 * Same-class runs like `.nav-group + .nav-group` are untouched by the rule: their
 * subject is neither `.card` nor `.grid`, and no component sheet sets a margin on
 * them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sheetRoot = join(root, 'stacks/claude/admin/src/styles');

/** The layout classes a page's blocks are composed from, and whose spacing this guards. */
const FLOW_CLASSES = ['.card', '.grid'];
/** Longhands and shorthands that can put a top margin on the later sibling. */
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
 * The last compound of a selector — what the rule actually styles. `.grid + .card`
 * styles the card, so the subject is `.card`; `.grid:has(+ .card)` styles the grid,
 * and its `:has()` argument is stripped before the split so the card inside it is not
 * mistaken for the subject.
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
  // around it rather than to the at-rule.
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
    // A selector list is checked part by part: one offending part in a list of five is
    // still the bug, and reading only the last part is how it would be missed.
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
