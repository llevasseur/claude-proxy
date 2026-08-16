import type { NoteMetadata, NotePage, NoteVersionConflict } from '@claude-proxy/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { Archive, ArchiveRestore, FilePlus2, NotebookPen, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  archiveNote,
  createNote,
  getNote,
  listNotes,
  NotesApiError,
  noteConflict,
  restoreNote,
  searchNotes,
  updateNote,
} from '../notes-api';
import { rootRoute } from '../route-root';
import { useLiveQuery } from '../useLiveQuery';
import type { NavEntry } from './nav';

const ACTIVE_KEY = ['notes', 'active'] as const;
const AUTOSAVE_MS = 700;

export interface NotesSearch {
  note?: string;
  archived?: boolean;
}

interface Draft {
  id: string;
  version: number;
  title: string;
  body: string;
  dirty: boolean;
  state: 'idle' | 'saving' | 'saved' | 'error' | 'offline' | 'conflict';
  message?: string;
  conflict?: NoteVersionConflict;
  remoteVersion?: number;
}

function useDebounced(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

function sortNotes(notes: NoteMetadata[]): NoteMetadata[] {
  return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}

function noteTitle(title: string): string {
  return title.trim() || 'Untitled';
}

function stamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function NotesPage() {
  const search = useSearch({ from: '/notes' });
  const navigate = useNavigate({ from: '/notes' });
  const client = useQueryClient();
  const [filter, setFilter] = useState('');
  const queryText = useDebounced(filter.trim(), 250);
  const archived = search.archived === true;
  const listKey = archived ? (['notes', 'archived'] as const) : ACTIVE_KEY;
  const live = useLiveQuery<NotePage>('/api/notes/stream?limit=50&archived=false', ACTIVE_KEY, !archived && !queryText);
  const firstPage = useQuery({ queryKey: listKey, queryFn: () => listNotes({ archived }) });
  const found = useQuery({
    queryKey: ['notes', 'search', queryText],
    queryFn: () => searchNotes(queryText),
    enabled: queryText.length > 0,
  });
  const [more, setMore] = useState<NoteMetadata[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const initialSelection = useRef(false);
  const seenSelectedInList = useRef<string | null>(null);

  const page = queryText ? found.data : firstPage.data;
  useEffect(() => {
    setMore([]);
    setNextCursor(page?.nextCursor ?? null);
    setMoreError(null);
  }, [page]);

  const notes = useMemo(() => {
    const byId = new Map<string, NoteMetadata>();
    for (const note of [...(page?.notes ?? []), ...more]) byId.set(note.id, note);
    return sortNotes([...byId.values()]);
  }, [page, more]);

  const select = (id?: string) => {
    void navigate({ search: { note: id, archived: archived || undefined }, replace: false });
  };

  useEffect(() => {
    if (initialSelection.current || search.note || notes.length === 0) return;
    initialSelection.current = true;
    void navigate({ search: { note: notes[0]?.id, archived: archived || undefined }, replace: true });
  }, [search.note, notes, navigate, archived]);

  const selected = useQuery({
    queryKey: ['notes', 'note', search.note],
    queryFn: () => getNote(search.note!),
    enabled: Boolean(search.note),
    retry: (count, error) => !(error instanceof NotesApiError && error.status === 404) && count < 1,
  });
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    const note = selected.data;
    if (!note) return;
    setDraft((current) => {
      if (current?.id === note.id && current.dirty) {
        return note.version > current.version
          ? { ...current, remoteVersion: note.version, state: 'conflict' }
          : current;
      }
      return {
        id: note.id,
        version: note.version,
        title: note.title,
        body: note.body,
        dirty: false,
        state: 'idle',
      };
    });
  }, [selected.data]);

  useEffect(() => {
    if (!search.note) setDraft(null);
  }, [search.note]);

  const selectedMeta = notes.find((note) => note.id === search.note);
  useEffect(() => {
    if (selectedMeta && search.note) seenSelectedInList.current = search.note;
  }, [selectedMeta, search.note]);

  useEffect(() => {
    if (!selectedMeta || !draft || selectedMeta.version <= draft.version) return;
    if (draft.dirty || draft.state === 'saving') {
      setDraft((current) =>
        current?.id === draft.id ? { ...current, remoteVersion: selectedMeta.version, state: 'conflict' } : current,
      );
    } else {
      seenSelectedInList.current = null;
      void client.invalidateQueries({ queryKey: ['notes', 'note', draft.id] });
    }
  }, [selectedMeta, draft, client]);

  useEffect(() => {
    if (
      queryText ||
      !page ||
      !draft ||
      seenSelectedInList.current !== draft.id ||
      selectedMeta ||
      draft.state === 'conflict'
    ) {
      return;
    }
    if (draft.dirty || draft.state === 'saving') {
      setDraft((current) =>
        current?.id === draft.id
          ? { ...current, state: 'conflict', message: 'This note left the current list while you were editing.' }
          : current,
      );
    } else {
      seenSelectedInList.current = null;
      void client.invalidateQueries({ queryKey: ['notes', 'note', draft.id] });
    }
  }, [queryText, page, draft, selectedMeta, client]);

  const refreshLists = () => {
    void client.invalidateQueries({ queryKey: ['notes'] });
  };
  const save = useMutation({
    mutationFn: (value: Draft) =>
      updateNote({ id: value.id, expectedVersion: value.version, title: value.title, body: value.body }),
    onMutate: () => setDraft((current) => (current ? { ...current, state: 'saving', message: undefined } : current)),
    onSuccess: ({ note }, sent) => {
      client.setQueryData(['notes', 'note', note.id], note);
      setDraft((current) => {
        if (!current || current.id !== note.id) return current;
        const changedSinceSend = current.title !== sent.title || current.body !== sent.body;
        return {
          ...current,
          version: note.version,
          dirty: changedSinceSend,
          state: changedSinceSend ? 'idle' : 'saved',
          remoteVersion: undefined,
          conflict: undefined,
        };
      });
      refreshLists();
    },
    onError: (error) => {
      const conflict = noteConflict(error);
      setDraft((current) =>
        current
          ? {
              ...current,
              dirty: true,
              state: conflict ? 'conflict' : navigator.onLine ? 'error' : 'offline',
              conflict: conflict ?? undefined,
              remoteVersion: conflict?.currentVersion ?? current.remoteVersion,
              message: conflict ? undefined : (error as Error).message,
            }
          : current,
      );
    },
  });

  useEffect(() => {
    if (!draft?.dirty || draft.state !== 'idle') return;
    const timer = window.setTimeout(() => save.mutate(draft), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, save.mutate]);

  useEffect(() => {
    if (draft?.state !== 'saved') return;
    const timer = window.setTimeout(
      () => setDraft((current) => (current?.state === 'saved' ? { ...current, state: 'idle' } : current)),
      1_600,
    );
    return () => window.clearTimeout(timer);
  }, [draft?.state]);

  useEffect(() => {
    const resume = () =>
      setDraft((current) =>
        current?.state === 'offline' ? { ...current, state: 'idle', message: undefined } : current,
      );
    window.addEventListener('online', resume);
    return () => window.removeEventListener('online', resume);
  }, []);

  const create = useMutation({
    mutationFn: () => createNote({ title: '', body: '' }),
    onSuccess: ({ note }) => {
      refreshLists();
      void navigate({ search: { note: note.id }, replace: false });
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) => archiveNote(id),
    onSuccess: ({ note }) => {
      client.setQueryData(['notes', 'note', note.id], note);
      refreshLists();
      setDraft((current) => (current?.id === note.id ? { ...current, dirty: false, state: 'idle' } : current));
    },
  });
  const restore = useMutation({
    mutationFn: (id: string) => restoreNote(id),
    onSuccess: ({ note }) => {
      client.setQueryData(['notes', 'note', note.id], note);
      refreshLists();
      void navigate({ search: { note: note.id }, replace: false });
    },
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'n') return;
      event.preventDefault();
      if (!create.isPending) create.mutate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [create]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = queryText
        ? await searchNotes(queryText, nextCursor)
        : await listNotes({ cursor: nextCursor, archived });
      setMore((current) => [...current, ...next.notes]);
      setNextCursor(next.nextCursor);
    } catch (error) {
      setMoreError((error as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const changeDraft = (field: 'title' | 'body', value: string) => {
    setDraft((current) =>
      current ? { ...current, [field]: value, dirty: true, state: navigator.onLine ? 'idle' : 'offline' } : current,
    );
  };
  const acceptRemote = async () => {
    if (!draft) return;
    const remote = await client.fetchQuery({ queryKey: ['notes', 'note', draft.id], queryFn: () => getNote(draft.id) });
    setDraft({
      id: remote.id,
      version: remote.version,
      title: remote.title,
      body: remote.body,
      dirty: false,
      state: 'idle',
    });
  };
  const retryLatest = () => {
    setDraft((current) =>
      current?.remoteVersion
        ? {
            ...current,
            version: current.remoteVersion,
            remoteVersion: undefined,
            conflict: undefined,
            state: 'idle',
            dirty: true,
          }
        : current,
    );
  };

  const listError = queryText ? found.error : firstPage.error;
  return (
    <section className='notes-shell'>
      <aside className='notes-list-pane' aria-label='Notes'>
        <header className='notes-list-head'>
          <div>
            <span className='notes-eyebrow'>Activity</span>
            <h1>Notes</h1>
          </div>
          <button
            type='button'
            className='notes-icon-button'
            onClick={() => create.mutate()}
            disabled={create.isPending}
            aria-label='Create note'
            title='New note (⌘N)'>
            <FilePlus2 size={18} aria-hidden />
          </button>
        </header>

        <label className='notes-search'>
          <Search size={15} aria-hidden />
          <input
            type='search'
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={archived ? 'Search active notes from Recent' : 'Search notes'}
            aria-label='Search notes'
            disabled={archived}
          />
        </label>

        <fieldset className='notes-view-switch'>
          <legend className='visually-hidden'>Note view</legend>
          <button
            type='button'
            className={!archived ? 'is-active' : undefined}
            aria-pressed={!archived}
            onClick={() => void navigate({ search: { note: undefined }, replace: false })}>
            Recent
          </button>
          <button
            type='button'
            className={archived ? 'is-active' : undefined}
            aria-pressed={archived}
            onClick={() => {
              setFilter('');
              void navigate({ search: { note: undefined, archived: true }, replace: false });
            }}>
            Archived
          </button>
          {!archived && !queryText ? <span className={`notes-live is-${live}`}>{live}</span> : null}
        </fieldset>

        <div className='notes-list' aria-busy={firstPage.isLoading || found.isLoading}>
          {(firstPage.isLoading || found.isLoading) && <p className='notes-list-state'>Loading notes…</p>}
          {listError && <p className='notes-list-state is-error'>Notes unavailable: {listError.message}</p>}
          {!listError && page && notes.length === 0 && (
            <p className='notes-list-state'>
              {queryText ? 'No notes match this search.' : archived ? 'No archived notes.' : 'No notes yet.'}
            </p>
          )}
          {notes.map((note) => (
            <button
              key={note.id}
              type='button'
              className={`notes-row${note.id === search.note ? ' is-active' : ''}`}
              aria-current={note.id === search.note ? 'page' : undefined}
              onClick={() => select(note.id)}>
              <span className='notes-row-top'>
                <strong>{noteTitle(note.title)}</strong>
                <time dateTime={note.updatedAt}>{stamp(note.updatedAt)}</time>
              </span>
              <span className='notes-row-excerpt'>{note.excerpt || 'Empty note'}</span>
            </button>
          ))}
          {nextCursor && (
            <button type='button' className='notes-more' onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load older notes'}
            </button>
          )}
          {moreError && <p className='notes-list-state is-error'>{moreError}</p>}
        </div>
      </aside>

      <main className='notes-editor-pane'>
        {!search.note ? (
          <div className='notes-empty'>
            <NotebookPen size={28} aria-hidden />
            <h2>{archived ? 'Choose an archived note' : 'Choose a note'}</h2>
            <p>{archived ? 'Archived notes remain restorable.' : 'Select a note or create a new one with ⌘N.'}</p>
          </div>
        ) : selected.error ? (
          <div className='notes-empty is-error'>
            <p>Could not open this note: {selected.error.message}</p>
          </div>
        ) : selected.isLoading || !draft || draft.id !== search.note ? (
          <div className='notes-empty'>
            <p>Opening note…</p>
          </div>
        ) : (
          <NoteEditor
            key={draft.id}
            draft={draft}
            archived={Boolean(selected.data?.archivedAt)}
            pendingAction={archive.isPending || restore.isPending}
            onTitle={(value) => changeDraft('title', value)}
            onBody={(value) => changeDraft('body', value)}
            onArchive={() => archive.mutate(draft.id)}
            onRestore={() => restore.mutate(draft.id)}
            onUseRemote={() => void acceptRemote()}
            onRetryLatest={retryLatest}
            onRetrySave={() => save.mutate(draft)}
          />
        )}
      </main>
    </section>
  );
}

function NoteEditor({
  draft,
  archived,
  pendingAction,
  onTitle,
  onBody,
  onArchive,
  onRestore,
  onUseRemote,
  onRetryLatest,
  onRetrySave,
}: {
  draft: Draft;
  archived: boolean;
  pendingAction: boolean;
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
  onArchive: () => void;
  onRestore: () => void;
  onUseRemote: () => void;
  onRetryLatest: () => void;
  onRetrySave: () => void;
}) {
  const stateLabel: Record<Draft['state'], string> = {
    idle: draft.dirty ? 'Waiting to save' : 'All changes saved',
    saving: 'Saving…',
    saved: 'Saved',
    error: draft.message ? `Save failed: ${draft.message}` : 'Save failed',
    offline: 'Offline — draft kept on this page',
    conflict: 'Conflict — draft kept on this page',
  };
  return (
    <article className='notes-editor'>
      {(draft.state === 'conflict' || draft.remoteVersion) && (
        <div className='notes-conflict' role='alert'>
          <div>
            <strong>This note changed elsewhere.</strong>
            <span>Your draft is still here. Keep it and retry from the latest version, or load the remote copy.</span>
          </div>
          <div className='notes-conflict-actions'>
            <button type='button' onClick={onRetryLatest} disabled={!draft.remoteVersion && !draft.conflict}>
              Keep my draft
            </button>
            <button type='button' onClick={onUseRemote}>
              Use remote
            </button>
          </div>
        </div>
      )}
      <header className='notes-editor-head'>
        <span className={`notes-save-state is-${draft.state}`} role='status' aria-live='polite'>
          {stateLabel[draft.state]}
        </span>
        {(draft.state === 'error' || draft.state === 'offline') && (
          <button type='button' className='notes-retry-button' onClick={onRetrySave}>
            Retry save
          </button>
        )}
        <button
          type='button'
          className='notes-archive-button'
          onClick={archived ? onRestore : onArchive}
          disabled={pendingAction || draft.dirty || draft.state === 'saving'}>
          {archived ? <ArchiveRestore size={15} aria-hidden /> : <Archive size={15} aria-hidden />}
          {archived ? 'Restore' : 'Archive'}
        </button>
      </header>
      <label className='notes-title-label'>
        <span className='visually-hidden'>Title</span>
        <input
          className='notes-title'
          value={draft.title}
          onChange={(event) => onTitle(event.target.value)}
          placeholder='Untitled'
          disabled={archived}
        />
      </label>
      <label className='notes-body-label'>
        <span className='visually-hidden'>Markdown body</span>
        <textarea
          className='notes-body'
          value={draft.body}
          onChange={(event) => onBody(event.target.value)}
          placeholder='Write in Markdown…'
          disabled={archived}
          spellCheck
        />
      </label>
      <footer className='notes-editor-foot'>
        <span>Markdown</span>
        <span>version {draft.version}</span>
      </footer>
    </article>
  );
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notes',
  component: NotesPage,
  staticData: { title: 'Notes' },
  validateSearch: (value: Record<string, unknown>): NotesSearch => ({
    note: typeof value.note === 'string' && value.note ? value.note : undefined,
    archived: value.archived === true || value.archived === 'true' ? true : undefined,
  }),
});

export const nav = {
  section: 'Activity',
  to: '/notes',
  label: 'Notes',
  hint: 'markdown',
  exact: true,
  icon: NotebookPen,
} as const satisfies NavEntry;
