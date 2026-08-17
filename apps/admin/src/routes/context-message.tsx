import type { RequestMessageDetail } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useParams } from '@tanstack/react-router';
import { getContextMessage } from '../api';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { EvictedBody } from '../components/EvictedBody';
import { QueryState } from '../components/QueryState';
import { PRETTY_RAW, type PrettyRawView, Segmented } from '../components/Segmented';
import { Skeleton, SkeletonMsgBlocks, SkeletonStats } from '../components/Skeleton';
import { fmtBytes, fmtInt } from '../format';
import {
  isJsonArray,
  isJsonRecord,
  isJsonText,
  type JsonRecord,
  type JsonValue,
  parseJson,
  recordField,
  textField,
} from '../json';
import { rootRoute } from '../route-root';
import { useTransitionState } from '../useTransitionState';

export function ContextMessagePage() {
  const { file, index } = useParams({ from: '/context/$file/message/$index' });
  const idx = Number(index);
  const query = useQuery({
    queryKey: ['context-message', file, idx],
    queryFn: () => getContextMessage(file, idx),
  });
  const data = query.data;
  const message = data && !data.evicted ? data.message : undefined;

  return (
    <section>
      <Breadcrumbs>
        <Link to='/context' className='link'>
          Context size
        </Link>
        <Link to='/context/$file' params={{ file }} className='link'>
          Request breakdown
        </Link>
        <span className='crumb-current'>Message #{idx + 1}</span>
      </Breadcrumbs>
      <div className='pagehead'>
        <h1>Message #{idx + 1}</h1>
      </div>
      <div className='muted' style={{ marginBottom: '0.75rem', wordBreak: 'break-all' }}>
        {file}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<MessageSkeleton />}>
        {data?.evicted && <EvictedBody data={data} />}
        {message && <MessageBody file={file} message={message} />}
      </QueryState>
    </section>
  );
}

/** The pager, three stat tiles, and the message card. */
function MessageSkeleton() {
  return (
    <>
      <nav className='pager' aria-hidden>
        <Skeleton w='6rem' />
        <Skeleton w='7rem' />
        <Skeleton w='6rem' />
      </nav>
      <SkeletonStats count={3} />
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='22%' h='0.95em' />
          <Skeleton w='7rem' />
        </div>
        <SkeletonMsgBlocks count={3} lines={5} />
      </div>
    </>
  );
}

function MessageBody({ file, message: m }: { file: string; message: RequestMessageDetail }) {
  const [view, setView, isSwitching] = useTransitionState<PrettyRawView>('pretty');

  return (
    <>
      <MessagePager file={file} index={m.index} messageCount={m.messageCount} />

      <div className='grid stats'>
        <StatTile label='Position' value={`#${m.index + 1}`} sub={`of ${m.messageCount} messages`} />
        <StatTile label='Role' value={m.role} />
        <StatTile label='Size' value={fmtBytes(m.bytes)} sub={`~${fmtInt(m.estTokens)} tokens`} />
      </div>

      <div className='card'>
        <div className='card-head'>
          <h2>Full message</h2>
          <Segmented options={PRETTY_RAW} value={view} onSelect={setView} label='Message view' busy={isSwitching} />
        </div>
        <div className={isSwitching ? 'is-stale' : undefined}>
          {view === 'pretty' ? <PrettyMessage content={m.content} /> : <pre className='rawjson wrap'>{m.content}</pre>}
        </div>
      </div>
    </>
  );
}

/** Previous/Next navigation between adjacent messages in the same request. `index` is 0-based. */
function MessagePager({ file, index, messageCount }: { file: string; index: number; messageCount: number }) {
  const hasPrev = index > 0;
  const hasNext = index < messageCount - 1;

  return (
    <nav className='pager' aria-label='Message navigation'>
      {hasPrev ? (
        <Link to='/context/$file/message/$index' params={{ file, index: String(index - 1) }} className='pager-btn'>
          ‹ Previous
        </Link>
      ) : (
        <button type='button' className='pager-btn' disabled>
          ‹ Previous
        </button>
      )}

      <span className='pager-pos muted'>
        #{index + 1} of {messageCount}
      </span>

      {hasNext ? (
        <Link to='/context/$file/message/$index' params={{ file, index: String(index + 1) }} className='pager-btn'>
          Next ›
        </Link>
      ) : (
        <button type='button' className='pager-btn' disabled>
          Next ›
        </button>
      )}
    </nav>
  );
}

/**
 * Render the stored message JSON as readable content blocks, dropping transport
 * noise (cache_control, thinking signatures, base64 image bytes). Falls back to
 * raw JSON on an unexpected shape.
 *
 * A block is read through the guards in `../json` rather than declared: this is a
 * captured request body, and its blocks carry whatever the client sent — including
 * block types this build has never heard of, which the default arm renders as JSON.
 */
function PrettyMessage({ content }: { content: string }) {
  const parsed = parseJson(content);
  const blocks = toBlocks(isJsonRecord(parsed) ? parsed.content : undefined);
  if (blocks.length === 0) return <pre className='rawjson wrap'>{content}</pre>;

  return (
    <div className='msg-blocks'>
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a message's content blocks are positional and never reorder
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

/**
 * Normalise a message's `content` into an array of blocks. A bare string is the
 * single-text-block shorthand the API accepts; an entry that is neither a string nor an
 * object has no block shape to read, so it is shown as the JSON it is.
 */
function toBlocks(content: JsonValue | undefined): JsonRecord[] {
  if (isJsonText(content)) return [{ type: 'text', text: content }];
  if (isJsonArray(content))
    return content.map((b) => (isJsonRecord(b) ? b : { type: 'text', text: isJsonText(b) ? b : stringify(b) }));
  return [];
}

function BlockView({ block }: { block: JsonRecord }) {
  const type = textField(block, 'type') ?? 'unknown';

  switch (type) {
    case 'text':
      return (
        <Section label='Text'>
          <Prose text={textField(block, 'text') ?? ''} />
        </Section>
      );

    case 'thinking':
      return (
        <Section label='Thinking'>
          <Prose text={textField(block, 'thinking') ?? ''} />
        </Section>
      );

    case 'tool_use':
      return (
        <Section label={`Tool call · ${textField(block, 'name') ?? 'unknown'}`}>
          <pre className='rawjson wrap'>{stringify(block.input)}</pre>
        </Section>
      );

    case 'tool_result': {
      const error = block.is_error === true;
      return (
        <Section label='Tool result' badge={error ? 'error' : undefined}>
          {toBlocks(block.content).map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a tool result's blocks are positional and never reorder
            <BlockView key={i} block={b} />
          ))}
        </Section>
      );
    }

    case 'image': {
      const src = recordField(block, 'source');
      const media = (src && textField(src, 'media_type')) ?? 'image';
      // Base64 is four characters per three bytes, so the decoded size is readable off
      // the string the block carries — which is the whole point of not rendering it.
      const data = src?.data;
      const bytes = isJsonText(data) ? Math.floor((data.length * 3) / 4) : 0;
      return (
        <Section label='Image'>
          <div className='muted'>
            {media}
            {bytes ? ` · ~${fmtBytes(bytes)} (data omitted)` : ''}
          </div>
        </Section>
      );
    }

    default:
      return (
        <Section label={type}>
          <pre className='rawjson wrap'>{stringify(block)}</pre>
        </Section>
      );
  }
}

function Section({ label, badge, children }: { label: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className='msg-block'>
      <div className='msg-block-head'>
        <span className='msg-block-label'>{label}</span>
        {badge && <span className='msg-badge'>{badge}</span>}
      </div>
      {children}
    </div>
  );
}

/** Wrapped, newline-preserving prose for text-ish values. */
function Prose({ text }: { text: string }) {
  return <div className='msg-text'>{text}</div>;
}

function stringify(v: JsonValue | undefined): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
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
  path: '/context/$file/message/$index',
  component: ContextMessagePage,
  staticData: { title: 'Context message' },
});
