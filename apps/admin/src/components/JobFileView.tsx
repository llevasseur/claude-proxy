import { codeSyntax, formatJsonText, parseJobTimeline, prettifyLog } from '@claude-proxy/core';
import { useMemo, useState } from 'react';
import type { JobFileDetail } from '../api';
import { fmtBytes, fmtLocalTsShort } from '../format';
import { CodeBlock } from './CodeBlock';
import { Markdown } from './Markdown';

/** The two ways to read a file: interpreted for its type, or the bytes on disk. */
type View = 'pretty' | 'raw';

export interface JobFileViewProps {
  file: JobFileDetail;
}

/**
 * One job file, read either way. **Pretty** interprets the file for what it is —
 * re-indented and coloured JSON, a rendered timeline, rendered markdown, a log with
 * its terminal escapes and progress redraws resolved, numbered and coloured source,
 * an inlined image. **Raw** is the bytes as they sit on disk, unwrapped.
 */
export function JobFileView({ file }: JobFileViewProps) {
  const [view, setView] = useState<View>('pretty');

  return (
    <div className='jobview'>
      <div className='jobview-head'>
        <div className='jobview-title'>
          <span className='rule-name jobview-path'>{file.path}</span>
          <span className='jobview-facts'>
            <span className='badge neutral'>{file.kind}</span>
            <span className='muted'>{fmtBytes(file.bytes)}</span>
            <span className='muted'>{fmtLocalTsShort(file.modified)}</span>
          </span>
        </div>
        <div className='segmented'>
          <button type='button' className={view === 'pretty' ? 'active' : ''} onClick={() => setView('pretty')}>
            Pretty
          </button>
          <button type='button' className={view === 'raw' ? 'active' : ''} onClick={() => setView('raw')}>
            Raw
          </button>
        </div>
      </div>

      {file.truncated && (
        <div className='leak-note jobview-note'>
          Only the first {fmtBytes(file.content.length)} of this file was read — both views are cut off at the same
          point.
        </div>
      )}

      {view === 'pretty' ? <Pretty file={file} /> : <Raw file={file} />}
    </div>
  );
}

/** The bytes on disk: no wrapping, no interpretation. Base64 wraps, since an inlined
 * image is one unbroken line that would otherwise scroll off to nowhere. */
function Raw({ file }: { file: JobFileDetail }) {
  if (file.binary) return <div className='empty'>{file.note ?? 'Nothing to show.'}</div>;
  return <pre className={`rawjson${file.encoding === 'base64' ? ' wrap' : ''}`}>{file.content}</pre>;
}

function Pretty({ file }: { file: JobFileDetail }) {
  if (file.binary) return <div className='empty'>{file.note ?? 'Nothing to show.'}</div>;

  if (file.kind === 'image') {
    return (
      <div className='jobview-image'>
        <img src={`data:${file.mime ?? 'image/png'};base64,${file.content}`} alt={file.name} />
      </div>
    );
  }

  if (file.kind === 'markdown')
    return (
      <div className='file-pretty'>
        <Markdown source={file.content} />
      </div>
    );
  if (file.kind === 'json') return <PrettyJson content={file.content} />;
  if (file.kind === 'jsonl') return <PrettyJsonl content={file.content} />;
  if (file.kind === 'log') return <CodeBlock source={prettifyLog(file.content)} syntax='plain' wrap />;
  if (file.kind === 'code') return <CodeBlock source={file.content} syntax={codeSyntax(file.name)} />;
  return <CodeBlock source={file.content} syntax='plain' wrap />;
}

/** JSON re-indented at two spaces and coloured. A file being appended to as it is
 * read can arrive half-written, so a parse failure is said out loud rather than
 * silently falling back. */
function PrettyJson({ content }: { content: string }) {
  const { text, ok } = useMemo(() => formatJsonText(content), [content]);
  return (
    <>
      {!ok && (
        <div className='leak-note jobview-note'>
          This didn't parse as JSON — showing it as-is. A job rewrites its state file live, so a read can land
          mid-write.
        </div>
      )}
      <CodeBlock source={text} syntax='json' />
    </>
  );
}

/**
 * JSON Lines, one record per line. A job's `timeline.jsonl` records `at` / `state` /
 * `detail` / `text`, so those render as a legible timeline; anything else falls back
 * to one coloured record per line.
 */
function PrettyJsonl({ content }: { content: string }) {
  const { entries, skipped } = useMemo(() => parseJobTimeline(content), [content]);
  const isTimeline = entries.some((e) => e.at !== '' || e.state !== '');

  if (!isTimeline) {
    const text = content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => formatJsonText(line).text)
      .join('\n');
    return <CodeBlock source={text} syntax='json' />;
  }

  return (
    <div className='joblog'>
      {skipped > 0 && (
        <div className='leak-note jobview-note'>
          {skipped} line{skipped === 1 ? '' : 's'} didn't parse — the file is appended to live, so its last line can be
          half-written.
        </div>
      )}
      {entries.map((entry) => (
        <div key={entry.line} className='joblog-entry'>
          <div className='joblog-head'>
            <span className='badge neutral'>{entry.state || '—'}</span>
            <span className='muted'>{entry.at ? fmtLocalTsShort(entry.at) : 'no timestamp'}</span>
            <span className='muted joblog-line'>line {entry.line}</span>
          </div>
          {entry.detail && <div className='joblog-detail'>{entry.detail}</div>}
          {entry.text && <div className='msg-text joblog-text'>{entry.text}</div>}
        </div>
      ))}
    </div>
  );
}
