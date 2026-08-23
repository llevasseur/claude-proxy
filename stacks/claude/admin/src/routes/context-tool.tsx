import type { RequestToolDetail } from '@claude-proxy/core';
import { useQuery } from '@tanstack/react-query';
import { createRoute, Link, useParams } from '@tanstack/react-router';
import { getContextTool } from '../api';
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

export function ContextToolPage() {
  const { file, index } = useParams({ from: '/context/$file/tool/$index' });
  const idx = Number(index);
  const query = useQuery({
    queryKey: ['context-tool', file, idx],
    queryFn: () => getContextTool(file, idx),
  });
  const data = query.data;
  const tool = data && !data.evicted ? data.tool : undefined;

  return (
    <section>
      <Breadcrumbs>
        <Link to='/context' className='link'>
          Context size
        </Link>
        <Link to='/context/$file' params={{ file }} className='link'>
          Request breakdown
        </Link>
        <span className='crumb-current'>Tool #{index}</span>
      </Breadcrumbs>
      <div className='pagehead'>
        <h1>Tool #{index}</h1>
      </div>
      <div className='muted' style={{ marginBottom: '0.75rem', wordBreak: 'break-all' }}>
        {file}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<ToolSkeleton />}>
        {data?.evicted && <EvictedBody data={data} />}
        {tool && <ToolBody tool={tool} />}
      </QueryState>
    </section>
  );
}

/** Three stat tiles and the schema card, sized for a tool's name, description and parameters. */
function ToolSkeleton() {
  return (
    <>
      <SkeletonStats count={3} />
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='20%' h='0.95em' />
          <Skeleton w='7rem' />
        </div>
        <SkeletonMsgBlocks count={3} lines={4} />
      </div>
    </>
  );
}

function ToolBody({ tool: t }: { tool: RequestToolDetail }) {
  const [view, setView, isSwitching] = useTransitionState<PrettyRawView>('pretty');

  return (
    <>
      <div className='grid stats'>
        <StatTile label='Position' value={`#${t.index}`} sub={`of ${t.toolCount} tools`} />
        <StatTile label='Name' value={t.name} />
        <StatTile label='Size' value={fmtBytes(t.bytes)} sub={`~${fmtInt(t.estTokens)} tokens`} />
      </div>

      <div className='card'>
        <div className='card-head'>
          <h2>Tool schema</h2>
          <Segmented options={PRETTY_RAW} value={view} onSelect={setView} label='Schema view' busy={isSwitching} />
        </div>
        <div className={isSwitching ? 'is-stale' : undefined}>
          {view === 'pretty' ? <PrettyTool content={t.content} /> : <pre className='rawjson wrap'>{t.content}</pre>}
        </div>
      </div>
    </>
  );
}

/**
 * Render the stored tool JSON as readable sections — name, description, and a
 * parameter list drawn from its input schema. Falls back to raw JSON on an
 * unexpected shape.
 *
 * The tool definition is whatever the captured request carried, so it is read through
 * the guards in `../json` rather than a declared shape: an array, a bare string and a
 * JSON-schema object are all things a request has been seen to hold here.
 */
function PrettyTool({ content }: { content: string }) {
  const tool = parseJson(content);
  if (!isJsonRecord(tool)) return <pre className='rawjson wrap'>{content}</pre>;

  const description = textField(tool, 'description') ?? '';
  // Anthropic tools carry `input_schema`; be tolerant of a plain `parameters` too.
  const schema = recordField(tool, 'input_schema') ?? recordField(tool, 'parameters');
  const params = paramRows(schema);

  return (
    <div className='msg-blocks'>
      <Section label='Name'>
        <Prose text={textField(tool, 'name') ?? '(unnamed)'} />
      </Section>

      {description && (
        <Section label='Description'>
          <Prose text={description} />
        </Section>
      )}

      {params.length > 0 ? (
        <Section label='Parameters'>
          <div className='table-scroll'>
            <table className='table'>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {params.map((p) => (
                  <tr key={p.name}>
                    <td>
                      {p.name}
                      {p.required && <span className='msg-badge'>required</span>}
                    </td>
                    <td className='muted'>{p.type}</td>
                    <td>{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : (
        schema && (
          <Section label='Input schema'>
            <pre className='rawjson wrap'>{stringify(schema)}</pre>
          </Section>
        )
      )}
    </div>
  );
}

interface ParamRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** Flatten a JSON-schema `properties` map into displayable parameter rows. */
function paramRows(schema: JsonRecord | undefined): ParamRow[] {
  const props = schema ? recordField(schema, 'properties') : undefined;
  if (!props) return [];
  const listed = schema?.required;
  const required = new Set(isJsonArray(listed) ? listed.filter(isJsonText) : []);

  return Object.entries(props).map(([name, raw]) => {
    const spec = isJsonRecord(raw) ? raw : undefined;
    return {
      name,
      type: schemaType(spec),
      required: required.has(name),
      description: (spec && textField(spec, 'description')) ?? '',
    };
  });
}

/** Best-effort human type label for a schema property. */
function schemaType(spec: JsonRecord | undefined): string {
  if (!spec) return '—';
  const type = textField(spec, 'type');
  if (type) {
    if (type === 'array') {
      const items = recordField(spec, 'items');
      const itemType = items && textField(items, 'type');
      return itemType ? `array<${itemType}>` : 'array';
    }
    return type;
  }
  if (isJsonArray(spec.enum)) return 'enum';
  if (isJsonArray(spec.anyOf) || isJsonArray(spec.oneOf)) return 'union';
  return '—';
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='msg-block'>
      <div className='msg-block-head'>
        <span className='msg-block-label'>{label}</span>
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
  path: '/context/$file/tool/$index',
  component: ContextToolPage,
  staticData: { title: 'Context tool call' },
});
