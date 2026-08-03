import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { getToolSchema, type ToolSchemaResponse } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { QueryState } from '../components/QueryState';
import { Skeleton, SkeletonMsgBlocks, SkeletonStats } from '../components/Skeleton';
import { fmtBytes, fmtInt, fmtPct } from '../format';

/** How far back bodies are searched for the schema — a search depth, not a filter. */
const LOOKBACK_DAYS = 30;

/** One tool of the fixed prefix, opened up to the JSON that its size is made of. */
export function ToolSchemaPage() {
  const { name } = useParams({ from: '/trends/fixed-prefix/tool/$name' });
  const query = useQuery({
    queryKey: ['tool-schema', name, LOOKBACK_DAYS],
    queryFn: () => getToolSchema(name, LOOKBACK_DAYS),
  });

  return (
    <section>
      <Breadcrumbs>
        <Link to='/trends' className='link'>
          Trends
        </Link>
        <Link to='/trends/$metric' params={{ metric: 'fixed-prefix' }} className='link'>
          Fixed prefix
        </Link>
        <span className='crumb-current mono'>{name}</span>
      </Breadcrumbs>

      <div className='pagehead'>
        <div>
          <h1 className='mono'>{name}</h1>
          <div className='muted'>
            The definition resent with every request that carries this tool, exactly as it goes over the wire.
          </div>
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<ToolSchemaSkeleton />}>
        {query.data && <SchemaBody tool={query.data} />}
      </QueryState>
    </section>
  );
}

function SchemaBody({ tool }: { tool: ToolSchemaResponse }) {
  return (
    <>
      <div className='grid stats'>
        <StatTile
          label='Size'
          value={fmtBytes(tool.bytes)}
          sub={`${fmtPct(tool.shareOfToolBytes * 100, 1)} of all tool bytes`}
        />
        <StatTile label='Per call' value={`${fmtInt(tool.estTokens)} tok`} sub='est., paid on every request' />
        <StatTile
          label='Requests'
          value={fmtInt(tool.requests)}
          sub={`shipped it in the last ${tool.meta.days} days`}
        />
      </div>

      <div className='card'>
        <div className='card-head'>
          <h2>Full schema</h2>
          {tool.file && <span className='muted mono'>{tool.file}</span>}
        </div>
        {tool.schema === null ? (
          <div className='empty'>
            {tool.meta.candidates === 0
              ? `No request in the last ${tool.meta.days} days carried a tool named “${tool.name}”, so nothing on disk describes it.`
              : 'Every captured body that carried this tool has aged out, so only its size is still known.'}
          </div>
        ) : (
          <div className='msg-blocks'>
            <div className='msg-block'>
              <div className='msg-text'>{tool.schema}</div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** Three stat tiles above the schema card, as the loaded page lays them out. */
function ToolSchemaSkeleton() {
  return (
    <>
      <SkeletonStats count={3} />
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='20%' h='0.95em' />
          <Skeleton w='12rem' />
        </div>
        <SkeletonMsgBlocks count={1} lines={16} />
      </div>
    </>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className='card stat'>
      <div className='stat-label'>{label}</div>
      <div className='stat-value'>{value}</div>
      <div className='stat-foot'>{sub && <span className='muted'>{sub}</span>}</div>
    </div>
  );
}
