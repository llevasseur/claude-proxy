// Parsing of `nettop -L 1` output and `sysctl -n kern.boottime`. Pure over
// their string inputs — the collector owns the processes that produce them.

export interface NettopRow {
  /**
   * Process name with any trailing `.pid` suffix stripped — or, for a
   * socket-flow row on a build that names no process, the flow tuple itself.
   */
  readonly name: string;
  /** The process pid, or `FLOW_PID` (0) for an attribution-less flow row. */
  readonly pid: number;
  /** Non-loopback interface the counters were reported against (`en0`, `utun3`, ...). */
  readonly interface: string;
  /** Cumulative counter — never a delta (decision internet-spend 001). */
  readonly bytesIn: number;
  /** Cumulative counter — never a delta. */
  readonly bytesOut: number;
}

/** One RFC-4180-ish CSV line: quoted fields may contain commas and doubled quotes. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * `sysctl -n kern.boottime` prints `{ sec = 1756147200, usec = 123456 } ...`;
 * the `sec` field is the boot epoch this stack keys discontinuities on.
 */
export function parseBootTime(output: string): number | null {
  const match = /sec\s*=\s*(\d+)/.exec(output);
  if (!match?.[1]) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * A synthetic pid marking a series whose identity is a socket-flow tuple
 * rather than a process. This macOS build's `nettop -L 1` emits two row kinds:
 * `name.pid` rows whose interface column is EMPTY (per-process totals folding
 * loopback in — rejected by decision internet-spend 001) and interface-bearing
 * socket-flow rows (`tcp4 host:port<->host:443,en0,...`) naming no process.
 * The plan assumed a third shape — `name.pid` WITH an interface — which this
 * build never produces; where an OS does emit it, it parses under its own
 * branch below and attributes bytes to the real process.
 */
export const FLOW_PID = 0;

function parseSeriesField(field: string): { name: string; pid: number } | null {
  // The shape the plan assumed: `launchd.1` carrying an interface.
  const processMatch = /^(.+)\.(\d+)$/.exec(field);
  if (processMatch?.[1] && processMatch[2]) {
    return { name: processMatch[1], pid: Number(processMatch[2]) };
  }
  // The shape this build produces: a stable flow tuple (`tcp4 *:543<->*:*`).
  // Stored under the tuple itself so consecutive batches of a long-lived
  // connection delta correctly; pid 0 marks it as attribution-less wire bytes.
  if (field.trim().length > 0 && /^(tcp|udp)[46]\s/.test(field.trim())) {
    return { name: field.trim(), pid: FLOW_PID };
  }
  return null;
}

/**
 * Parse one `nettop -L 1` snapshot into per-series rows carrying an interface.
 * Drops, per decision internet-spend 001 and the plan: the header line,
 * loopback (`lo0`) rows, rows with no interface (per-process aggregates that
 * still fold loopback in) and rows that name neither a process nor a socket
 * flow. Cumulative counters stay cumulative.
 *
 * Returns null when the payload is structurally unparseable — no recognizable
 * header — so the caller can skip the whole batch.
 */
export function parseNettopCsv(csv: string): NettopRow[] | null {
  const lines = csv
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
  const header = lines[0];
  if (!header) return null;
  const headerFields = parseCsvLine(header);
  if (!headerFields.includes('bytes_in') || !headerFields.includes('bytes_out')) return null;

  const rows: NettopRow[] = [];
  for (let index = 1; index < lines.length; index++) {
    const fields = parseCsvLine(lines[index] ?? '');
    const series = parseSeriesField(fields[1] ?? '');
    if (!series) continue;
    const iface = (fields[2] ?? '').trim();
    if (!iface || iface === 'lo0') continue;
    const bytesIn = Number(fields[4] ?? '');
    const bytesOut = Number(fields[5] ?? '');
    if (!Number.isSafeInteger(bytesIn) || !Number.isSafeInteger(bytesOut)) continue;
    rows.push({ name: series.name, pid: series.pid, interface: iface, bytesIn, bytesOut });
  }
  return rows;
}
