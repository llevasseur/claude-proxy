import { useId } from 'react';

/**
 * The `i` beside a column header, and the note it reveals: what the column holds
 * and where the value comes from. A button rather than a span, so the keyboard
 * reaches it and the note is not hover-only.
 */
export function HeaderHint({ text }: { text: string }) {
  const id = useId();
  return (
    <span className='hint'>
      <button
        type='button'
        className='hint-mark'
        aria-label='What this column means'
        aria-describedby={id}
        // Keeps the click off a sortable header, which would re-sort the column.
        onClick={(event) => event.stopPropagation()}>
        i
      </button>
      <span id={id} role='tooltip' className='hint-bubble'>
        {text}
      </span>
    </span>
  );
}
