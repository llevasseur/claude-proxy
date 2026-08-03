import { useId } from 'react';

/**
 * The `i` beside a column header, and the note it reveals: what the column holds
 * and where the value comes from. It hangs off a real button so the keyboard
 * reaches it, and `aria-describedby` ties the note to that button rather than
 * leaving the text to hover alone.
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
        // A sortable header sorts on click, and asking what it means is not that.
        onClick={(event) => event.stopPropagation()}>
        i
      </button>
      <span id={id} role='tooltip' className='hint-bubble'>
        {text}
      </span>
    </span>
  );
}
