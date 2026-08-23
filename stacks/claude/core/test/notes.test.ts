import { describe, expect, it } from 'vitest';
import { type NoteSaveState, parseNoteCreate, parseNoteId, parseNoteUpdate } from '../src/notes.ts';

describe('Notes DTO parsing', () => {
  it('preserves a blank title and Markdown body exactly', () => {
    expect(parseNoteCreate({ title: '', body: '# Heading\n' })).toEqual({ title: '', body: '# Heading\n' });
  });

  it('requires an expected version and at least one changed field', () => {
    expect(parseNoteUpdate({ id: 'note-1', expectedVersion: 2, body: 'next' })).toEqual({
      id: 'note-1',
      expectedVersion: 2,
      body: 'next',
    });
    expect(() => parseNoteUpdate({ id: 'note-1', body: 'next' })).toThrow(/expectedVersion/);
    expect(() => parseNoteUpdate({ id: 'note-1', expectedVersion: 2 })).toThrow(/title or body/);
  });

  it('validates archive and restore ids', () => {
    expect(parseNoteId({ id: 'note-1' })).toBe('note-1');
    expect(() => parseNoteId({ id: '' })).toThrow(/must not be blank/);
  });

  it('models clean, dirty, saving, conflict, and error save states', () => {
    const states: NoteSaveState[] = [
      { status: 'clean', version: 1 },
      { status: 'dirty', version: 1 },
      { status: 'saving', version: 1 },
      {
        status: 'conflict',
        version: 1,
        conflict: {
          conflict: true,
          code: 'stale_version',
          noteId: 'note-1',
          expectedVersion: 1,
          currentVersion: 2,
          attemptedRevisionId: 'revision-2b',
        },
      },
      { status: 'error', version: 1, message: 'offline' },
    ];
    expect(states.map((state) => state.status)).toEqual(['clean', 'dirty', 'saving', 'conflict', 'error']);
  });
});
