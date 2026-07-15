const nf = new Intl.NumberFormat("en-US");

export const fmtInt = (n: number): string => nf.format(Math.round(n));
export const fmtUsd = (n: number): string => `$${n.toFixed(n < 1 ? 3 : 2)}`;
export const fmtPct = (n: number, digits = 0): string => `${n.toFixed(digits)}%`;

export function fmtBytes(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

export function deltaLabel(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

/** For a metric where up is worse (cost, tokens): positive delta → "bad". */
export function deltaTone(pct: number): "up" | "down" | "flat" {
  if (Math.abs(pct) < 0.5) return "flat";
  return pct > 0 ? "up" : "down";
}
