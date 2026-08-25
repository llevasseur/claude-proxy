// @vitest-environment node
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

// Visual-system contract: the design-token names/values adopted from the
// pinned styles/tokens.css must survive into the *emitted* CSS bundle, and the
// theme, focus, and reduced-motion rules must be present in it. Building here
// (rather than trusting source) is what makes the assertion about the bundle.

const OUT_DIR = join(import.meta.dirname, '..', 'dist-css-test');

// The hook below runs a real vite build: about three seconds alone, past vitest's 10s
// default hook budget under a full `verify` where every package builds at once.
const BUILD_TIMEOUT_MS = 120_000;

let bundleCss = '';

beforeAll(() => {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  // Vite's own config (plugins, proxy) is irrelevant; only the CSS pipeline is.
  execSync('pnpm exec vite build --outDir dist-css-test', {
    cwd: join(import.meta.dirname, '..'),
    stdio: 'ignore',
  });
  const assets = join(OUT_DIR, 'assets');
  const cssFile = readdirSync(assets).find((name) => name.endsWith('.css'));
  expect(cssFile, 'built bundle contains a stylesheet').toBeTruthy();
  // SAFETY: the assertion above establishes the name is present rather than undefined.
  bundleCss = readFileSync(join(assets, cssFile as string), 'utf8');
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

test('emitted CSS keeps the adopted design token names and values', () => {
  const requiredTokens = [
    '--ink:#0e1117',
    '--surface:#151a22',
    '--line:#2a323e',
    '--text:#e9edf3',
    '--muted:#8a95a6',
    '--signal:#4cc6b0',
    '--good:#71d195',
    '--amber:#e8ab5e',
    '--coral:#f0788c',
    '--violet:#9d8cff',
    '--font-mono:',
    '--tracking-label:.08em',
    '--radius-pill:999px',
    '--motion-duration:.18s',
    '--ease-out:',
  ];
  const compacted = bundleCss.replaceAll(' ', '');
  for (const token of requiredTokens) {
    expect(compacted.includes(token), `token ${token} present in emitted bundle`).toBe(true);
  }
});

test('emitted CSS carries theme switching, focus-visible, and reduced-motion rules', () => {
  const compacted = bundleCss.replaceAll(' ', '');
  expect(compacted.includes('color-scheme:lightdark')).toBe(true);
  expect(compacted.includes('prefers-color-scheme')).toBe(true);
  expect(compacted.includes(':focus-visible')).toBe(true);
  expect(compacted.includes('prefers-reduced-motion:reduce')).toBe(true);
});

test('adopted components keep their styled class contracts', () => {
  for (const className of [
    '.car-chart svg rect',
    '.skeleton',
    '.code-block',
    '.inline-code',
    '.breadcrumbs ol',
    '.cost-rate-card input',
    '.car-table th',
    '.primary-nav a',
    '.card',
    '.metrics dd',
  ]) {
    expect(bundleCss.includes(className), `${className} styled in bundle`).toBe(true);
  }
});
