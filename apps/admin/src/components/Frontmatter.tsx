import { Fragment } from 'react';

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  /** All top-level scalar key: value pairs parsed. */
  fields: { key: string; value: string }[];
}

/**
 * Split a leading YAML-ish `--- … ---` frontmatter block off the body. Reads
 * only a shallow subset: top-level `key: value` plus a nested `metadata.type`.
 */
export function splitFrontmatter(content: string) {
  const text = content.replace(/^﻿/, '');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { frontmatter: null, body: text };

  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: null, body: text };

  const block = text.slice(text.indexOf('\n') + 1, end);
  const rest = text.slice(end + 4).replace(/^\r?\n/, '');

  const fields: { key: string; value: string }[] = [];
  let type: string | undefined;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1] ?? '';
    const key = m[2] ?? '';
    const clean = (m[3] ?? '').trim().replace(/^["']|["']$/g, '');
    if (key === 'type' && indent.length > 0) type = clean; // metadata.type
    if (indent.length === 0 && clean) fields.push({ key, value: clean });
  }

  const get = (k: string) => fields.find((f) => f.key === k)?.value;
  return {
    frontmatter: { name: get('name'), description: get('description'), type, fields },
    body: rest,
  };
}

/** A parsed frontmatter block as a definition grid above the document it headed. */
export function Frontmatter({ fm }: { fm: ParsedFrontmatter }) {
  const rows = fm.fields.filter((f) => f.value);
  if (rows.length === 0 && !fm.type) return null;
  return (
    <dl className='fm'>
      {rows.map((f) => (
        <Fragment key={f.key}>
          <dt>{f.key}</dt>
          <dd>{f.value}</dd>
        </Fragment>
      ))}
      {fm.type && (
        <Fragment key='metadata.type'>
          <dt>type</dt>
          <dd>{fm.type}</dd>
        </Fragment>
      )}
    </dl>
  );
}
