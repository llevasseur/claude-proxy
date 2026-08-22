export const CORE_PACKAGE = "@ox-alpha-proxy/core";

export function sumTokens(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
