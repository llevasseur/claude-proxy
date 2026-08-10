import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useParams } from '@tanstack/react-router';
import type { MemoryDetail } from '../api';
import { getMemory } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { Frontmatter, splitFrontmatter } from '../components/Frontmatter';
import { Markdown } from '../components/Markdown';
import { QueryState } from '../components/QueryState';
import { PRETTY_RAW, type PrettyRawView, Segmented } from '../components/Segmented';
import { Skeleton, SkeletonStats, SkeletonText } from '../components/Skeleton';
import { fmtBytes, fmtLocalTsShort } from '../format';
import { rootRoute } from '../route-root';
import { useTransitionState } from '../useTransitionState';

export function MemoryDetailPage() {
  const { project, name } = useParams({ from: '/projects/$project/memory/$name' });
  const query = useQuery({
    queryKey: ['memory', project, name],
    queryFn: () => getMemory(project, name),
  });
  const memory = query.data?.memory;

  return (
    <section>
      <Breadcrumbs>
        <Link to='/projects' className='link'>
          Projects
        </Link>
        <Link to='/projects/$project' params={{ project }} className='link'>
          Project memories
        </Link>
        <span className='crumb-current'>{name}</span>
      </Breadcrumbs>
      <div className='pagehead'>
        <h1>{name}</h1>
      </div>
      <div className='muted mono-break' style={{ marginBottom: '0.75rem' }}>
        {project}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<MemorySkeleton />}>
        {memory && <MemoryBody memory={memory} />}
      </QueryState>
    </section>
  );
}

/** The file's stat tiles and the document card it renders into. */
function MemorySkeleton() {
  return (
    <>
      <SkeletonStats count={3} />
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='18%' h='0.95em' />
          <Skeleton w='7rem' />
        </div>
        <SkeletonText lines={9} />
      </div>
    </>
  );
}

function MemoryBody({ memory }: { memory: MemoryDetail }) {
  const [view, setView, isSwitching] = useTransitionState<PrettyRawView>('pretty');
  const { frontmatter, body } = splitFrontmatter(memory.content);

  return (
    <>
      <div className='grid stats'>
        <StatTile label='Size' value={fmtBytes(memory.bytes)} />
        <StatTile label='Modified' value={fmtLocalTsShort(memory.modified)} />
        {frontmatter?.type && <StatTile label='Type' value={frontmatter.type} />}
      </div>

      <div className='card'>
        <div className='card-head'>
          <h2>Memory</h2>
          <Segmented options={PRETTY_RAW} value={view} onSelect={setView} label='Memory view' busy={isSwitching} />
        </div>
        <div className={isSwitching ? 'is-stale' : undefined}>
          {view === 'pretty' ? (
            <div className='memory-pretty'>
              {frontmatter && <Frontmatter fm={frontmatter} />}
              <Markdown source={body} />
            </div>
          ) : (
            <pre className='rawjson wrap'>{memory.content}</pre>
          )}
        </div>
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

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$project/memory/$name',
  component: MemoryDetailPage,
  staticData: { title: 'Memory' },
});
