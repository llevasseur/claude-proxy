import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { MemoryFileSummary } from '../api';
import { getProjectMemories } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { HeaderHint } from '../components/HeaderHint';
import { QueryState } from '../components/QueryState';
import { Skeleton, type SkeletonColumn, SkeletonTable } from '../components/Skeleton';
import { fmtBytes, fmtLocalTsShort } from '../format';
import { rootRoute } from '../route-root';
import { useTransitionState } from '../useTransitionState';

/** File name, size, and modified time. */
const MEMORY_COLUMNS: readonly SkeletonColumn[] = [{ cell: '54%' }, { className: 'num' }, { className: 'num' }];

export function ProjectDetailPage() {
  const { project } = useParams({ from: '/projects/$project' });
  const query = useQuery({
    queryKey: ['project-memories', project],
    queryFn: () => getProjectMemories(project),
  });
  const files = query.data?.files;

  return (
    <section>
      <Breadcrumbs>
        <Link to='/projects' className='link'>
          Projects
        </Link>
        <span className='crumb-current'>Project memories</span>
      </Breadcrumbs>
      <div className='pagehead'>
        <h1>Project memories</h1>
      </div>
      <div className='muted mono-break' style={{ marginBottom: '0.75rem' }}>
        {project}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<MemoriesSkeleton />}>
        {!files || files.length === 0 ? (
          <div className='card empty'>This project has no memory files.</div>
        ) : (
          <MemoriesTable project={project} files={files} />
        )}
      </QueryState>
    </section>
  );
}

/** The memories card and the table it holds. */
function MemoriesSkeleton() {
  return (
    <div className='card'>
      <div className='card-head'>
        <Skeleton w='24%' h='0.95em' />
        <Skeleton w='34%' />
      </div>
      <SkeletonTable columns={MEMORY_COLUMNS} rows={7} />
    </div>
  );
}

type SortKey = 'name' | 'bytes' | 'modified';
type SortDir = 'asc' | 'desc';

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR = {
  name: 'asc',
  bytes: 'desc',
  modified: 'desc',
} satisfies Record<SortKey, SortDir>;

/** Signed comparison for a column, ascending. */
function compare(a: MemoryFileSummary, b: MemoryFileSummary, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'modified':
      return a.modified.localeCompare(b.modified);
    default:
      return a.bytes - b.bytes;
  }
}

function MemoriesTable({ project, files }: { project: string; files: MemoryFileSummary[] }) {
  const navigate = useNavigate();
  const [sort, setSort, isSorting] = useTransitionState<{ key: SortKey; dir: SortDir }>({
    key: 'bytes',
    dir: 'desc',
  });

  const sorted = useMemo(() => {
    const rows = [...files];
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === 'asc' ? diff : -diff;
    });
    return rows;
  }, [files, sort]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>
          {files.length} memor{files.length === 1 ? 'y' : 'ies'}
        </h2>
        <span className='muted'>click a column to sort · click a row to read it</span>
      </div>
      <div className='table-scroll'>
        <table className={isSorting ? 'table is-stale' : 'table'} aria-busy={isSorting || undefined}>
          <thead>
            <tr>
              <SortHeader
                label='File'
                sortKey='name'
                sort={sort}
                onSort={onSort}
                hint="The file's name in this project's memory directory. MEMORY.md is the index loaded into context each session; every other file holds one memory."
              />
              <SortHeader
                label='Size'
                sortKey='bytes'
                sort={sort}
                onSort={onSort}
                className='num'
                hint='Bytes of the file on disk, frontmatter included.'
              />
              <SortHeader
                label='Modified'
                sortKey='modified'
                sort={sort}
                onSort={onSort}
                className='num'
                hint="The file's last-modified time on disk, shown in local time."
              />
            </tr>
          </thead>
          <tbody>
            {sorted.map((f) => (
              <tr
                key={f.name}
                className='clickable'
                onClick={() => navigate({ to: '/projects/$project/memory/$name', params: { project, name: f.name } })}>
                <td>
                  <Link
                    to='/projects/$project/memory/$name'
                    params={{ project, name: f.name }}
                    className='link'
                    onClick={(e) => e.stopPropagation()}>
                    {f.name}
                  </Link>
                  {f.name === 'MEMORY.md' && <span className='muted'> · index</span>}
                </td>
                <td className='num'>{fmtBytes(f.bytes)}</td>
                <td className='num muted'>{fmtLocalTsShort(f.modified)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
  hint,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
  hint?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={['sortable', className].filter(Boolean).join(' ')}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(sortKey)}>
      {label}
      {active && <span className='sort-arrow'>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
      {hint && <HeaderHint text={hint} />}
    </th>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$project',
  component: ProjectDetailPage,
  staticData: { title: 'Project' },
});
