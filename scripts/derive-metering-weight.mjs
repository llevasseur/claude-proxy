#!/usr/bin/env node
/**
 * Re-derives the cache-read *metering* weight from captured audit sidecars, and
 * prints the `OBSERVED_5H_WINDOWS` fixture in `packages/core/test/usage-limits.test.ts`
 * so that fixture can be regenerated and audited rather than trusted.
 *
 * Anthropic never publishes the subscription allowance as a token count, so the
 * weight cannot be looked up — it has to be inferred. Every request whose sidecar
 * carries `anthropic-ratelimit-unified-5h-utilization` pairs a weighted token count
 * with Anthropic's own reading of how much of the 5-hour allowance that count
 * consumed, so each *completed* window implies an allowance. One allowance produced
 * them all, so the weight that makes them agree is the measured one.
 *
 * Two independent estimates are printed:
 *
 *   endpoint fit  — one observation per completed window (its last reading). This is
 *                   what the checked-in fixture holds. Few observations, and they are
 *                   near-collinear, so it is weakly identified.
 *   intra-window  — every reading inside each window regressed against the cumulative
 *                   units at that instant. Hundreds of observations per window, so it
 *                   is the stronger evidence, at the cost of assuming the header is a
 *                   plain cumulative counter (it very nearly is; see `--monotonicity`).
 *
 * Usage:
 *   node scripts/derive-metering-weight.mjs [--logs <dir>] [--json] [--monotonicity]
 *
 * `--logs` defaults to `logs/` at the repo root, and its `archive/<date>/` days are
 * read alongside it. Run it against a machine's own retained logs; the numbers in the
 * fixture and in `docs/features/usage-limit-meters.md` are this device's.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const UTIL_HEADER = 'anthropic-ratelimit-unified-5h-utilization';
const RESET_HEADER = 'anthropic-ratelimit-unified-5h-reset';
const WEEK_UTIL_HEADER = 'anthropic-ratelimit-unified-7d-utilization';
const WEEK_RESET_HEADER = 'anthropic-ratelimit-unified-7d-reset';
const WINDOW_MS = 5 * 3600_000;
const WEEK_MS = 7 * 86_400_000;

/** Weights swept when reporting where the fit actually bottoms out. */
const SWEEP = Array.from({ length: 200 }, (_, i) => (i + 1) * 0.001);

/**
 * Reset instants arrive as epoch seconds today, but the proxy's own header parsing
 * also accepts epoch milliseconds and an ISO instant, so accept all three here
 * rather than pinning the script to the spelling in one week's captures.
 */
function parseInstant(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e11 ? n * 1000 : n;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArgs(argv) {
  const opts = { logs: 'logs', json: false, monotonicity: false, outOfSample: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--logs') opts.logs = argv[++i];
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--monotonicity') opts.monotonicity = true;
    else if (argv[i] === '--out-of-sample') opts.outOfSample.push(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return opts;
}

/** Every `*.audit.json` under the live directory and each archived day. */
function auditFiles(logRoot) {
  const dirs = [logRoot];
  const archive = join(logRoot, 'archive');
  let days = [];
  try {
    days = readdirSync(archive).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    // No archive yet — the live directory alone is a valid, narrower sample.
  }
  for (const day of days) dirs.push(join(archive, day));

  const files = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.audit.json')) files.push(join(dir, name));
    }
  }
  return files;
}

/**
 * One record per captured request: when it happened, what it spent, and — when the
 * response carried them — the 5-hour utilization and reset instant it reported.
 *
 * Deduped by sidecar *filename*, because the archive job may copy rather than move
 * and a day can appear in both the live directory and its archive folder.
 */
function loadRecords(logRoot) {
  const seen = new Set();
  const out = [];
  for (const file of auditFiles(logRoot)) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (seen.has(name)) continue;
    seen.add(name);

    let d;
    try {
      d = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // A half-written sidecar is not a data point.
    }
    const at = Date.parse(d.timestamp ?? '');
    if (!Number.isFinite(at)) continue;

    const t = d.tokens ?? {};
    const rl = d.rateLimit ?? null;
    const util = rl ? Number(rl[UTIL_HEADER]) : Number.NaN;
    const resetAt = rl ? parseInstant(rl[RESET_HEADER]) : null;

    out.push({
      at,
      tokens: {
        input: t.input ?? 0,
        output: t.output ?? 0,
        cacheRead: t.cacheRead ?? 0,
        cacheCreation: t.cacheCreation ?? 0,
      },
      util: Number.isFinite(util) ? util : null,
      resetAt,
      weekUtil: rl && Number.isFinite(Number(rl[WEEK_UTIL_HEADER])) ? Number(rl[WEEK_UTIL_HEADER]) : null,
      weekResetAt: rl ? parseInstant(rl[WEEK_RESET_HEADER]) : null,
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * Group the reporting requests into windows by the reset instant they name — that
 * instant *is* the window's identity — and keep only windows that have closed.
 *
 * A window's token count is every captured request in `[reset − 5h, lastReading]`,
 * reporting or not: usage is usage. `util` is the reading at that last reporting
 * request, which is the rule the fixture's comment states.
 */
function windowsFrom(records, now = Date.now()) {
  const byReset = new Map();
  for (const r of records) {
    if (r.util === null || r.resetAt === null) continue;
    if (!byReset.has(r.resetAt)) byReset.set(r.resetAt, []);
    byReset.get(r.resetAt).push(r);
  }

  const windows = [];
  for (const [resetAt, reporting] of [...byReset].sort((a, b) => a[0] - b[0])) {
    if (resetAt > now) continue; // Still filling.
    const opened = resetAt - WINDOW_MS;
    const last = reporting[reporting.length - 1];

    const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let counted = 0;
    for (const r of records) {
      if (r.at < opened || r.at > last.at) continue;
      totals.input += r.tokens.input;
      totals.output += r.tokens.output;
      totals.cacheRead += r.tokens.cacheRead;
      totals.cacheCreation += r.tokens.cacheCreation;
      counted++;
    }

    windows.push({
      opened: new Date(opened).toISOString(),
      resetAt: new Date(resetAt).toISOString(),
      lastReadingAt: new Date(last.at).toISOString(),
      util: last.util,
      readings: reporting.length,
      requests: counted,
      ...totals,
      reporting,
    });
  }
  return windows;
}

/**
 * The same construction for the 7-day allowance, which is what a `USAGE_LIMIT_WEEK`
 * example has to be expressed against. Weekly windows are reported in progress as
 * well as completed — an in-progress one still pairs a count with a reading, and on a
 * device that retains a few weeks it is usually the only one fully on disk.
 *
 * `covered` says whether retained logs reach back to the window's opening instant. An
 * uncovered window undercounts, so its implied ceiling reads too *low*.
 */
function weekWindowsFrom(records, now = Date.now()) {
  const oldest = records.length > 0 ? records[0].at : Number.POSITIVE_INFINITY;
  const byReset = new Map();
  for (const r of records) {
    if (r.weekUtil === null || r.weekResetAt === null) continue;
    if (!byReset.has(r.weekResetAt)) byReset.set(r.weekResetAt, []);
    byReset.get(r.weekResetAt).push(r);
  }

  const out = [];
  for (const [resetAt, reporting] of [...byReset].sort((a, b) => a[0] - b[0])) {
    const opened = resetAt - WEEK_MS;
    const last = reporting[reporting.length - 1];
    if (last.weekUtil <= 0) continue; // Nothing to divide by.

    const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const r of records) {
      if (r.at < opened || r.at > last.at) continue;
      totals.input += r.tokens.input;
      totals.output += r.tokens.output;
      totals.cacheRead += r.tokens.cacheRead;
      totals.cacheCreation += r.tokens.cacheCreation;
    }

    out.push({
      opened: new Date(opened).toISOString(),
      resetAt: new Date(resetAt).toISOString(),
      util: last.weekUtil,
      inProgress: resetAt > now,
      covered: oldest <= opened,
      ...totals,
    });
  }
  return out;
}

const weighted = (w, weight) => w.input + w.output + w.cacheCreation + w.cacheRead * weight;

/** Widest departure from the mean, as a fraction of it — the test's own measure. */
function spread(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.max(...values.map((v) => Math.abs(v - mean) / mean));
}

const impliedCeilings = (windows, weight) => windows.map((w) => weighted(w, weight) / w.util);

/**
 * The share of a window's units that comes from cache reads, at the shipped weight.
 * This is what *identifies* the weight: windows that all sit at the same share
 * constrain it barely at all, however many of them there are.
 */
const cacheShare = (w) => w.cacheRead / (w.input + w.output + w.cacheCreation + w.cacheRead);

/**
 * Regress every reading in one window against the cumulative units at that instant.
 * For a given weight the best allowance is the least-squares fit through the origin,
 * and the residual says how straight the trajectory is — a wrong weight bends it.
 */
function intraWindowFit(windows, records, weight) {
  const perWindow = [];
  for (const w of windows) {
    const opened = Date.parse(w.opened);
    let cum = 0;
    let ri = 0;
    const pts = [];
    const inWindow = records.filter((r) => r.at >= opened && r.at <= Date.parse(w.lastReadingAt));
    for (const r of inWindow) {
      cum += weighted(r.tokens, weight);
      if (r.util !== null && r.resetAt !== null && new Date(r.resetAt).toISOString() === w.resetAt) {
        pts.push({ cum, util: r.util });
        ri++;
      }
    }
    if (ri < 10) continue;
    let sxx = 0;
    let sxy = 0;
    for (const p of pts) {
      sxx += p.cum * p.cum;
      sxy += p.cum * p.util;
    }
    const ceiling = sxx / sxy; // units per unit utilization
    let sq = 0;
    let max = 0;
    for (const p of pts) {
      const resid = p.util - p.cum / ceiling;
      sq += resid * resid;
      max = Math.max(max, Math.abs(resid));
    }
    perWindow.push({ opened: w.opened, points: pts.length, ceiling, rms: Math.sqrt(sq / pts.length), max });
  }
  return perWindow;
}

/**
 * The busiest non-overlapping 5-hour windows on a day that reports **no** headers, as a
 * fraction of the allowance a given weight implies. This is the out-of-sample check: a
 * weight fitted on one week should put a day that actually hit its cap near 100%, and a
 * weight that puts it near 65% is claiming the allowance itself changed between weeks.
 *
 * Windows are reconstructed greedily — the busiest 5 hours anywhere on the day, then the
 * busiest disjoint from it — because without a reset header there is nothing to align to.
 */
function outOfSampleDay(records, day, weight, ceiling, count = 2) {
  const from = Date.parse(`${day}T00:00:00Z`);
  const to = from + 86_400_000;
  const onDay = records.filter((r) => r.at >= from - WINDOW_MS && r.at < to);
  const taken = [];

  for (let n = 0; n < count; n++) {
    let best = null;
    for (const start of onDay) {
      const openAt = start.at;
      if (taken.some((t) => openAt < t.end && openAt + WINDOW_MS > t.start)) continue;
      let units = 0;
      for (const r of onDay) {
        if (r.at < openAt || r.at >= openAt + WINDOW_MS) continue;
        if (taken.some((t) => r.at >= t.start && r.at < t.end)) continue;
        units += weighted(r.tokens, weight);
      }
      if (best === null || units > best.units) best = { start: openAt, end: openAt + WINDOW_MS, units };
    }
    if (best === null || best.units === 0) break;
    taken.push(best);
  }

  return taken.map((t) => ({
    opened: new Date(t.start).toISOString(),
    units: t.units,
    utilization: t.units / ceiling,
  }));
}

/** Where the header steps backwards — evidence it is not a plain running total. */
function monotonicity(windows) {
  return windows.map((w) => {
    let backsteps = 0;
    let worst = 0;
    for (let i = 1; i < w.reporting.length; i++) {
      const delta = w.reporting[i].util - w.reporting[i - 1].util;
      if (delta < 0) {
        backsteps++;
        worst = Math.min(worst, delta);
      }
    }
    return { opened: w.opened, readings: w.reporting.length, backsteps, worst };
  });
}

/** The weight minimising `spread`, and the band of weights within `tol` of it. */
function fitBand(windows, tol) {
  let best = SWEEP[0];
  let bestSpread = Infinity;
  for (const w of SWEEP) {
    const s = spread(impliedCeilings(windows, w));
    if (s < bestSpread) {
      bestSpread = s;
      best = w;
    }
  }
  const within = SWEEP.filter((w) => spread(impliedCeilings(windows, w)) <= bestSpread * (1 + tol));
  return { best, bestSpread, lo: within[0], hi: within[within.length - 1] };
}

const m = (n) => `${(n / 1e6).toFixed(1)}M`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const logRoot = resolve(opts.logs);
  statSync(logRoot); // Fail loudly on a bad --logs rather than reporting an empty sample.

  const records = loadRecords(logRoot);
  const windows = windowsFrom(records);
  if (windows.length === 0) {
    console.error(`No completed 5-hour window reports ${UTIL_HEADER} under ${logRoot}.`);
    process.exit(1);
  }

  const band10 = fitBand(windows, 0.1);
  const band50 = fitBand(windows, 0.5);
  const intra = SWEEP.map((w) => ({
    weight: w,
    rms: intraWindowFit(windows, records, w).reduce((a, f) => a + f.rms, 0),
  }));
  const intraBest = intra.reduce((a, b) => (b.rms < a.rms ? b : a));

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          logRoot,
          records: records.length,
          windows: windows.map(({ reporting: _reporting, ...w }) => w),
          endpointFit: { band10, band50 },
          intraWindowBestWeight: intraBest.weight,
          intraWindowPerWindow: intraWindowFit(windows, records, band10.best),
          monotonicity: monotonicity(windows),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`${records.length} sidecars under ${logRoot}; ${windows.length} completed reporting window(s).\n`);

  console.log('The fixture, as `OBSERVED_5H_WINDOWS` expects it:\n');
  for (const w of windows) {
    console.log(`  {`);
    console.log(`    opened: '${w.opened}',`);
    console.log(`    util: ${w.util},`);
    for (const k of ['input', 'output', 'cacheRead', 'cacheCreation']) {
      console.log(`    ${k}: ${w[k].toLocaleString('en-US').replaceAll(',', '_')},`);
    }
    console.log(`  }, // last reading ${w.lastReadingAt}, ${w.requests} requests, ${w.readings} readings`);
  }

  console.log('\nEndpoint fit — the allowance each window implies:\n');
  console.log('  | weight | implied 5h ceilings | worst departure from mean |');
  console.log('  |--------|---------------------|---------------------------|');
  for (const weight of [0.1, 0.02, band10.best]) {
    const c = impliedCeilings(windows, weight);
    console.log(`  | ${weight.toFixed(3)} | ${c.map(m).join(' / ')} | ${pct(spread(c))} |`);
  }
  console.log(`\n  best fit ${band10.best.toFixed(3)} at ${pct(band10.bestSpread)} spread`);
  console.log(`  within 10% of best: ${band10.lo.toFixed(3)}–${band10.hi.toFixed(3)}`);
  console.log(`  within 50% of best: ${band50.lo.toFixed(3)}–${band50.hi.toFixed(3)}`);

  console.log('\n  cache-read share of units per window (this is what identifies the weight):');
  const shares = windows.map(cacheShare);
  console.log(`    ${shares.map((s) => s.toFixed(4)).join(' / ')}`);
  console.log(`    spread across windows: ${((Math.max(...shares) - Math.min(...shares)) * 100).toFixed(1)}pp`);

  console.log('\nIntra-window fit — every reading against cumulative units:\n');
  console.log(`  best total weight: ${intraBest.weight.toFixed(3)}`);
  for (const weight of [0.1, 0.02, intraBest.weight]) {
    const f = intraWindowFit(windows, records, weight);
    const rms = f.map((x) => pct(x.rms)).join(' / ');
    console.log(`  weight ${weight.toFixed(3)}: rms residual ${rms}`);
  }

  const weeks = weekWindowsFrom(records);
  if (weeks.length > 0) {
    console.log('\n7-day allowance, the same way — what a `USAGE_LIMIT_WEEK` example is against:\n');
    for (const w of weeks) {
      const flags = [w.inProgress ? 'in progress' : 'completed', w.covered ? 'covered' : 'UNCOVERED — reads low'];
      const at = (weight) => `${weight}: ${m(weighted(w, weight))} → ${m(weighted(w, weight) / w.util)}`;
      console.log(`  ${w.opened} util ${w.util} (${flags.join(', ')})`);
      console.log(`    ${at(0.02)}   |   ${at(0.1)}`);
    }
  }

  for (const day of opts.outOfSample) {
    console.log(`\nOut of sample — ${day}, which reports no headers at all:\n`);
    for (const weight of [0.02, 0.1]) {
      const ceilings = impliedCeilings(windows, weight);
      const ceiling = ceilings.reduce((a, b) => a + b, 0) / ceilings.length;
      const found = outOfSampleDay(records, day, weight, ceiling);
      const read = found.map((f) => `${pct(f.utilization)} (${m(f.units)})`).join(' / ');
      console.log(`  weight ${weight.toFixed(3)} against its own ${m(ceiling)} ceiling: ${read || 'no traffic'}`);
    }
  }

  if (opts.monotonicity) {
    console.log('\nHeader monotonicity — a plain running total would never step back:\n');
    for (const r of monotonicity(windows)) {
      console.log(`  ${r.opened}: ${r.backsteps} backstep(s) of ${r.readings} readings, worst ${r.worst.toFixed(2)}`);
    }
  }
}

main();
