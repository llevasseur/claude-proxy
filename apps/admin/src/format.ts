const nf = new Intl.NumberFormat('en-US');

export const fmtInt = (n: number): string => nf.format(Math.round(n));
export const fmtUsd = (n: number): string => `$${n.toFixed(n < 1 ? 3 : 2)}`;
export const fmtPct = (n: number, digits = 0): string => `${n.toFixed(digits)}%`;

/** A blended token price, e.g. `$0.73/MTok`. Two decimals: no rate lands below a cent. */
export const fmtUsdPerMTok = (n: number): string => `$${n.toFixed(2)}/MTok`;

/** Token count at axis width, e.g. `12.3M`. `fmtInt`'s grouped digits are too wide for a tick. */
export function fmtTokensShort(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

export function fmtBytes(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

export function deltaLabel(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
}

// Sidecars store timestamps in UTC (ISO 8601); these helpers render them
// in the viewer's system timezone.

/** The viewer's IANA system timezone, e.g. `"America/New_York"`. */
export const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Short zone label for the viewer's current timezone, e.g. `"EDT"`. */
export const LOCAL_TZ_ABBR: string =
  new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')?.value ?? 'local';

// `hourCycle: "h23"` avoids V8's "24:xx" quirk for midnight. Omitting
// `timeZone` makes the formatter use the system zone.
const tsFmt = new Intl.DateTimeFormat('en-US', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function tsParts(iso: string): Record<string, string> | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const out: Record<string, string> = {};
  for (const p of tsFmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** `MM-DD HH:MM:SS` in the viewer's local timezone; echoes the input if unparseable. */
export function fmtLocalTs(iso: string): string {
  const p = tsParts(iso);
  if (!p) return iso;
  return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** `MM-DD HH:MM` in the viewer's local timezone (compact); `"—"` when empty. */
export function fmtLocalTsShort(iso: string): string {
  if (!iso) return '—';
  const p = tsParts(iso);
  if (!p) return iso;
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** `2m` / `3h` / `4d` / `MM-DD` — the age of a timestamp, at chat-list width. */
export function fmtAgeShort(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const p = tsParts(iso);
  return p ? `${p.month}-${p.day}` : iso;
}

/** For a metric where up is worse (cost, tokens): positive delta → "bad". */
export function deltaTone(pct: number): 'up' | 'down' | 'flat' {
  if (Math.abs(pct) < 0.5) return 'flat';
  return pct > 0 ? 'up' : 'down';
}
