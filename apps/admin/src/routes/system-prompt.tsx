import {
  countLines,
  diffSystemPromptText,
  estTokens,
  normalizeSystemPromptText,
  outlineSystemPrompt,
  type SystemPromptDoc,
  utf8Bytes,
} from '@claude-proxy/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { ScrollText } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SystemPromptResponse } from '../api';
import { getSystemPrompt, saveSystemPrompt } from '../api';
import { CodeBlock } from '../components/CodeBlock';
import { Markdown } from '../components/Markdown';
import { QueryState } from '../components/QueryState';
import { Segmented, type SegmentedOption } from '../components/Segmented';
import { Skeleton, SkeletonStats, SkeletonText } from '../components/Skeleton';
import { fmtBytes, fmtInt, fmtLocalTsShort } from '../format';
import { rootRoute } from '../route-root';
import type { NavEntry } from './nav';

/**
 * "System prompt" — `~/.claude/CLAUDE.md`, the device-wide instructions Claude Code
 * loads into every session's system prompt on this machine, and the one page here
 * that writes back to it.
 *
 * A device view, not a traffic one: the proxy never records the system prompt, so
 * the file on disk is the only readable copy. Every byte of it is charged to every
 * request on this device.
 */

const SYSTEM_PROMPT_KEY = ['system-prompt'] as const;

type EditorView = 'edit' | 'preview';
const EDITOR_VIEWS: readonly SegmentedOption<EditorView>[] = [
  { value: 'edit', label: 'Edit' },
  { value: 'preview', label: 'Preview' },
];

export function SystemPromptPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: SYSTEM_PROMPT_KEY, queryFn: getSystemPrompt });
  const prompt = query.data?.prompt;
  const maxBytes = query.data?.maxBytes;

  // null means "untouched" — the editor mirrors the file until the first keystroke,
  // so a refetch can still update it underneath an idle tab.
  const [draft, setDraft] = useState<string | null>(null);
  const [view, setView] = useState<EditorView>('edit');
  const [armedEmpty, setArmedEmpty] = useState(false);
  const [saved, setSaved] = useState<{ modified: string | null; backupPath: string | null } | null>(null);
  // The file's mtime when editing began — the version the confirm step checks the
  // disk against. A background refetch moves `prompt` out from under an idle tab.
  const [editingFrom, setEditingFrom] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SaveConfirm | null>(null);

  const onDisk = prompt?.text ?? '';
  const text = draft ?? onDisk;
  const dirty = draft !== null && draft !== onDisk;

  const bytes = useMemo(() => utf8Bytes(text), [text]);
  const sections = useMemo(() => outlineSystemPrompt(text), [text]);
  const lines = countLines(text);
  const tooLong = maxBytes !== undefined && bytes > maxBytes;
  // Emptying the prompt is unrecoverable from this page, so it takes a second click
  // the way the job delete does.
  const clearsPrompt = text.trim() === '' && onDisk.trim() !== '';

  // Save is a two-step: re-read the file, show what the write would change, then
  // write against the version just read.
  const review = useMutation({
    mutationFn: getSystemPrompt,
    onSuccess: (res) => {
      setConfirm({ disk: res.prompt, editingFrom, proposed: normalizeSystemPromptText(text) });
    },
  });

  const save = useMutation({
    mutationFn: (input: { text: string; expectedModified: string | null }) =>
      saveSystemPrompt(input.text, input.expectedModified),
    onSuccess: (res) => {
      // The response is a fresh read of the file, so seeding beats refetching.
      client.setQueryData<SystemPromptResponse>(SYSTEM_PROMPT_KEY, { prompt: res.prompt, maxBytes: res.maxBytes });
      setDraft(null);
      setArmedEmpty(false);
      setEditingFrom(null);
      setConfirm(null);
      setSaved({ modified: res.prompt.modified, backupPath: res.backupPath });
    },
  });

  const submit = () => {
    if (!dirty || tooLong || save.isPending || review.isPending) return;
    if (clearsPrompt && !armedEmpty) {
      setArmedEmpty(true);
      return;
    }
    save.reset();
    review.mutate();
  };

  const cancelConfirm = () => {
    setConfirm(null);
    save.reset();
  };

  return (
    <section>
      <div className='pagehead'>
        <h1>System prompt</h1>
        <div className='muted'>
          The device-wide instructions at <span className='rule-name'>{prompt?.path ?? '~/.claude/CLAUDE.md'}</span> —
          loaded into every Claude Code session on this machine.
        </div>
      </div>

      <div className='card' style={{ marginBottom: 16 }}>
        <div className='leak-note'>
          <strong>This page writes to disk.</strong> Saving replaces the file, keeping the previous contents in a{' '}
          <span className='rule-name'>.bak</span> beside it. Sessions read it at startup, so a running session keeps the
          text it launched with — the change lands on the next one. Every byte here ships with <em>every request</em> on
          this device.
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<SystemPromptSkeleton />}>
        {prompt && (
          <>
            <div className='grid stats'>
              <StatTile
                label='Size'
                value={fmtBytes(bytes)}
                sub={dirty ? `${fmtBytes(prompt.bytes)} on disk` : undefined}
              />
              <StatTile label='Est. tokens' value={fmtInt(estTokens(bytes))} sub='per request' />
              <StatTile label='Lines' value={fmtInt(lines)} sub={`${fmtInt(sections.length)} sections`} />
              <StatTile
                label='Modified'
                value={prompt.modified ? fmtLocalTsShort(prompt.modified) : '—'}
                sub={prompt.exists ? undefined : 'no file yet'}
              />
            </div>

            {!prompt.exists && (
              <div className='card empty' style={{ marginBottom: 16 }}>
                No <span className='rule-name'>{prompt.path}</span> on this device yet — saving creates it.
              </div>
            )}

            {confirm ? (
              <SaveConfirmCard
                confirm={confirm}
                pending={save.isPending}
                error={save.error}
                rereading={review.isPending}
                onReread={() => review.mutate()}
                onCancel={cancelConfirm}
                onConfirm={() => save.mutate({ text: confirm.proposed, expectedModified: confirm.disk.modified })}
              />
            ) : (
              <div className='card'>
                <div className='card-head'>
                  <h2>Device system prompt</h2>
                  <Segmented options={EDITOR_VIEWS} value={view} onSelect={setView} label='Editor view' />
                </div>

                {view === 'edit' ? (
                  <textarea
                    className='sysprompt-editor'
                    value={text}
                    spellCheck={false}
                    aria-label='Device system prompt'
                    onChange={(e) => {
                      // The first keystroke pins the version being edited from.
                      if (draft === null) setEditingFrom(prompt.modified);
                      setDraft(e.target.value);
                      setArmedEmpty(false);
                      setSaved(null);
                    }}
                    onKeyDown={(e) => {
                      // ⌘S / Ctrl-S saves.
                      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                        e.preventDefault();
                        submit();
                      }
                    }}
                  />
                ) : text.trim() === '' ? (
                  <div className='empty'>Nothing to preview — the prompt is empty.</div>
                ) : (
                  <div className='memory-pretty'>
                    <Markdown source={text} />
                  </div>
                )}

                <div className='sysprompt-actions'>
                  <div className='sysprompt-state'>
                    {tooLong && maxBytes !== undefined ? (
                      <span className='sysprompt-error'>
                        {fmtBytes(bytes)} is over the {fmtBytes(maxBytes)} ceiling — trim it before saving.
                      </span>
                    ) : dirty ? (
                      <span className='muted'>Unsaved changes.</span>
                    ) : saved ? (
                      <span className='muted'>
                        Saved{saved.modified ? ` at ${fmtLocalTsShort(saved.modified)}` : ''}
                        {saved.backupPath && (
                          <>
                            {' '}
                            — previous contents kept in <span className='rule-name'>{saved.backupPath}</span>
                          </>
                        )}
                        .
                      </span>
                    ) : (
                      <span className='muted'>In sync with the file.</span>
                    )}
                  </div>
                  <div className='sysprompt-buttons'>
                    <button
                      type='button'
                      className='link'
                      disabled={!dirty || review.isPending}
                      onClick={() => {
                        setDraft(null);
                        setArmedEmpty(false);
                        setEditingFrom(null);
                      }}>
                      Revert
                    </button>
                    <button
                      type='button'
                      className={armedEmpty ? 'btn-danger armed' : 'btn-save'}
                      disabled={!dirty || tooLong || review.isPending}
                      onClick={submit}>
                      {review.isPending
                        ? 'Comparing…'
                        : armedEmpty
                          ? 'Clear the prompt?'
                          : clearsPrompt
                            ? 'Save (empties it)'
                            : 'Save'}
                    </button>
                  </div>
                </div>

                {review.error && (
                  <div className='sysprompt-error'>Could not read the file to compare — {review.error.message}</div>
                )}
              </div>
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}

/**
 * What the confirm step is deciding about: the file as it was re-read a moment ago,
 * the mtime the editor started from, and the normalized text about to land.
 */
interface SaveConfirm {
  disk: SystemPromptDoc;
  editingFrom: string | null;
  proposed: string;
}

/**
 * The step between pressing Save and the file being replaced: a line diff of the
 * draft against the bytes on disk *now*, not the ones the page loaded with.
 *
 * The staleness check is that same read: when the mtime no longer matches the one
 * editing began from, the card says so and the diff on screen — already taken
 * against the new contents — is the evidence.
 */
function SaveConfirmCard({
  confirm,
  pending,
  error,
  rereading,
  onReread,
  onCancel,
  onConfirm,
}: {
  confirm: SaveConfirm;
  pending: boolean;
  error: Error | null;
  rereading: boolean;
  onReread: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const diff = useMemo(() => diffSystemPromptText(confirm.disk.text, confirm.proposed), [confirm]);
  const source = useMemo(() => diff.lines.map((line) => line.text).join('\n'), [diff]);
  const stale = confirm.disk.modified !== confirm.editingFrom;
  // The server re-checks at write time, so a file that moves between this read and
  // the click still comes back refused, as a 409.
  const movedAgain = error !== null && /changed on disk/.test(error.message);

  const lineClass = (index: number) => {
    switch (diff.lines[index]?.kind) {
      case 'added':
        return 'diff-added';
      case 'removed':
        return 'diff-removed';
      case 'gap':
        return 'diff-gap';
      default:
        return undefined;
    }
  };

  return (
    <div className='card'>
      <div className='card-head'>
        <h2>Review the save</h2>
        <span className='muted'>
          +{fmtInt(diff.added)} −{fmtInt(diff.removed)} lines
        </span>
      </div>

      {stale && (
        <div className='leak-note'>
          <strong>The file changed on disk while you were editing.</strong> Another editor or another agent wrote to{' '}
          <span className='rule-name'>{confirm.disk.path}</span>
          {confirm.disk.modified ? ` at ${fmtLocalTsShort(confirm.disk.modified)}` : ''}. Saving replaces <em>those</em>{' '}
          contents, not the ones this page opened with — which is what the diff below compares against.
        </div>
      )}

      {diff.identical ? (
        <div className='empty'>Nothing to write — the draft already matches the file on disk.</div>
      ) : diff.lines.length === 0 ? (
        <div className='empty'>No line changes — the save only normalizes line endings and trailing whitespace.</div>
      ) : (
        <>
          <CodeBlock source={source} syntax='plain' wrap lineClass={lineClass} />
          {diff.wholeFile && (
            <div className='leak-note' style={{ marginTop: 8 }}>
              Too much changed to line up against the old text — shown as a full replacement rather than an edit.
            </div>
          )}
        </>
      )}

      {error && (
        <div className='sysprompt-error'>
          {movedAgain
            ? 'Refused — the file changed again while you were reviewing it. Re-read it to see what is there now.'
            : `Save failed — ${error.message}`}
        </div>
      )}

      <div className='sysprompt-actions'>
        <div className='sysprompt-state'>
          <span className='muted'>
            {confirm.disk.exists ? (
              <>
                Compared against <span className='rule-name'>{confirm.disk.path}</span> as it is right now.
              </>
            ) : (
              <>
                No file there yet — saving creates <span className='rule-name'>{confirm.disk.path}</span>.
              </>
            )}
          </span>
        </div>
        <div className='sysprompt-buttons'>
          <button type='button' className='link' disabled={pending} onClick={onCancel}>
            Back to the editor
          </button>
          {movedAgain && (
            <button type='button' className='link' disabled={rereading} onClick={onReread}>
              {rereading ? 'Re-reading…' : 'Re-read the file'}
            </button>
          )}
          <button
            type='button'
            className={stale ? 'btn-danger armed' : 'btn-save'}
            disabled={pending || rereading || diff.identical}
            onClick={onConfirm}>
            {pending
              ? 'Saving…'
              : stale
                ? 'Overwrite anyway'
                : confirm.disk.exists
                  ? 'Overwrite the file'
                  : 'Create the file'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Four tiles over the editor card. */
function SystemPromptSkeleton() {
  return (
    <>
      <SkeletonStats count={4} />
      <div className='card'>
        <div className='card-head'>
          <Skeleton w='22%' h='0.95em' />
          <Skeleton w='7rem' />
        </div>
        <SkeletonText lines={12} />
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
  path: '/system-prompt',
  component: SystemPromptPage,
  staticData: { title: 'System prompt' },
});

export const nav = {
  section: 'Device',
  to: '/system-prompt',
  label: 'System prompt',
  hint: 'device',
  exact: false,
  icon: ScrollText,
} as const satisfies NavEntry;
