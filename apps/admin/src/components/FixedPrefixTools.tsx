import type { UsageDigest } from '@claude-proxy/core';
import { Link } from '@tanstack/react-router';
import { fmtInt, fmtPct } from '../format';

/**
 * The line items inside the fixed prefix, largest first.
 *
 * `Fixed prefix tokens per call` covers tool schemas plus the system prompt
 * together; this is the half of it that is itemised, and rows link to the schema
 * behind the size. Reads the digests the trend page already fetched, so it shows
 * the digest's top-N rather than every tool ever sent.
 */
export function FixedPrefixTools({ digests }: { digests: UsageDigest[] }) {
  const day = digests.at(-1);
  const tools = day?.topTools ?? [];
  const requests = day?.requestCount ?? 0;

  if (!day || tools.length === 0) {
    return (
      <div className='card'>
        <h2>Biggest tool schemas</h2>
        <div className='empty'>No tool definitions captured for this window.</div>
      </div>
    );
  }

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Biggest tool schemas</h2>
        <span className='muted'>{day.date}</span>
      </div>
      <p className='muted mix-note'>
        The itemised half of the prefix. Per call is this tool's tokens divided by the day's{' '}
        <strong>{fmtInt(requests)}</strong> requests — a mean, not a constant, since a subagent ships a narrower tool
        set than the main loop does. Open a row to read the JSON that size is made of.
      </p>
      <table className='table'>
        <thead>
          <tr>
            <th>Tool</th>
            <th className='num'>Per call</th>
            <th className='num'>Share of tool bytes</th>
            <th className='num'>Day total</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((t) => (
            <tr key={t.name}>
              <td>
                <Link className='link mono' to='/trends/fixed-prefix/tool/$name' params={{ name: t.name }}>
                  {t.name}
                </Link>
              </td>
              <td className='num'>{requests > 0 ? `${fmtInt(Math.round(t.estTokens / requests))} tok` : '—'}</td>
              <td className='num'>{fmtPct(t.pctOfToolBytes)}</td>
              <td className='num'>{fmtInt(t.estTokens)} tok</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
