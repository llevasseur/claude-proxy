import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { getPromptSection, type PromptSectionResponse } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { QueryState } from '../components/QueryState';
import { Skeleton, SkeletonMsgBlocks, SkeletonStats } from '../components/Skeleton';
import { fmtBytes, fmtInt, fmtPct } from '../format';

/**
 * The window bodies are looked for in. The text is a property of the prompt
 * rather than of the window, so this is a search depth and not a filter — no
 * control for it.
 */
const LOOKBACK_DAYS = 30;

/** One row of "what it is made of", opened up to the text behind it. */
export function PromptSectionPage() {
  const { hash, index } = useParams({ from: '/trends/avg-system-prompt/$hash/section/$index' });
  const idx = Number(index);
  const query = useQuery({
    queryKey: ['prompt-section', hash, idx],
    queryFn: () => getPromptSection(hash, idx, LOOKBACK_DAYS),
  });
  const section = query.data;

  return (
    <section>
      <Breadcrumbs>
        <Link to='/trends' className='link'>
          Trends
        </Link>
        <Link to='/trends/$metric' params={{ metric: 'avg-system-prompt' }} className='link'>
          Avg system prompt
        </Link>
        <Link to='/trends/avg-system-prompt/$hash' params={{ hash }} className='link mono'>
          {hash.slice(0, 8)}
        </Link>
        <span className='crumb-current'>{section?.heading ?? `Section #${idx + 1}`}</span>
      </Breadcrumbs>

      <div className='pagehead'>
        <div>
          <h1>{section?.heading ?? `Section #${idx + 1}`}</h1>
          <div className='muted'>The text this section of the system prompt spends its bytes on.</div>
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<PromptSectionSkeleton />}>
        {section && <SectionBody section={section} />}
      </QueryState>
    </section>
  );
}

function SectionBody({ section }: { section: PromptSectionResponse }) {
  const blocks = section.blocks.length;
  return (
    <>
      <div className='grid stats'>
        <StatTile
          label='Size'
          value={fmtBytes(section.bytes)}
          sub={`${fmtPct(section.share * 100, 1)} of the prompt`}
        />
        <StatTile label='Depth' value={section.level === 0 ? '—' : `H${section.level}`} sub='heading level' />
        <StatTile
          label='Blocks'
          value={fmtInt(blocks)}
          sub={blocks === 1 ? `block #${section.blocks[0]}` : `blocks ${section.blocks.join(', ')}`}
        />
      </div>

      <div className='card'>
        <div className='card-head'>
          <h2>Full text</h2>
          {section.file && <span className='muted mono'>{section.file}</span>}
        </div>
        {section.parts.length === 0 ? (
          <div className='empty'>
            {section.meta.candidates === 0
              ? `No request in the last ${section.meta.days} days sent this prompt, so its text is not on disk.`
              : 'Every captured body that sent this prompt has aged out, so only its size is still known.'}
          </div>
        ) : (
          <div className='msg-blocks'>
            {section.parts.map((part) => (
              <div className='msg-block' key={part.block}>
                {section.parts.length > 1 && (
                  <div className='msg-block-head'>
                    <span className='msg-block-label'>Block #{part.block}</span>
                    <span className='muted'>{fmtBytes(part.bytes)}</span>
                  </div>
                )}
                <div className='msg-text'>{part.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Three stat tiles above the text card, as the loaded page lays them out. */
function PromptSectionSkeleton() {
  return (
    <>
      <SkeletonStats count={3} />
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='18%' h='0.95em' />
          <Skeleton w='12rem' />
        </div>
        <SkeletonMsgBlocks count={1} lines={12} />
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
