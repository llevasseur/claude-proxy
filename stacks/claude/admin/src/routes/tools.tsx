import { useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { Wrench } from 'lucide-react';
import { getTools } from '../api';
import { QueryState } from '../components/QueryState';
import { type SkeletonColumn, SkeletonTableCard } from '../components/Skeleton';
import { fmtBytes, fmtInt, fmtPct } from '../format';
import { rootRoute } from '../route-root';
import type { NavEntry } from './nav';
import type { ProviderSupport } from './providers';

/** Tool, three numeric columns, then the share bar. */
const TOOL_COLUMNS: readonly SkeletonColumn[] = [
  { cell: '56%' },
  { className: 'num' },
  { className: 'num' },
  { className: 'num' },
  { className: 'bar-col' },
];

export function ToolsPage() {
  const query = useQuery({ queryKey: ['tools'], queryFn: () => getTools() });
  const tools = query.data?.topTools ?? [];
  const max = Math.max(1, ...tools.map((t) => t.totalBytes));

  return (
    <section>
      <div className='pagehead'>
        <h1>Tool bloat</h1>
        <div className='muted'>{query.data?.date} · ranked by bytes per request payload</div>
      </div>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        skeleton={<SkeletonTableCard columns={TOOL_COLUMNS} rows={10} />}>
        {tools.length === 0 ? (
          <div className='card empty'>No tool data for this day.</div>
        ) : (
          <div className='card'>
            <div className='table-scroll'>
              <table className='table toolbloat'>
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th className='num'>Bytes</th>
                    <th className='num'>~Tokens</th>
                    <th className='num'>% of tools</th>
                    <th className='bar-col'>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.map((t) => (
                    <tr key={t.name}>
                      <td className='tool-name'>{t.name}</td>
                      <td className='num'>{fmtBytes(t.totalBytes)}</td>
                      <td className='num'>{fmtInt(t.estTokens)}</td>
                      <td className='num'>{fmtPct(t.pctOfToolBytes, 1)}</td>
                      <td className='bar-col'>
                        <div className='rowbar' style={{ width: `${(t.totalBytes / max) * 100}%` }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </QueryState>
    </section>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tools',
  component: ToolsPage,
  staticData: { title: 'Tool bloat' },
});

export const nav = {
  section: 'Context',
  to: '/tools',
  label: 'Tool bloat',
  hint: 'context',
  exact: false,
  icon: Wrench,
} as const satisfies NavEntry;

/** Tool-schema bloat measured against the Anthropic request budget. */
export const providers = ['anthropic'] as const satisfies ProviderSupport;
