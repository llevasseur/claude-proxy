import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SUGGESTION_STATUSES,
  type SuggestionRecurrence,
  type SuggestionStatus,
  type SuggestionStatusRow,
} from '@claude-proxy/core';
import { markSuggestionStatus } from '../api';
import { fmtLocalTsShort } from '../format';

/**
 * The UI for a suggestion's flag: a badge that says where it stands, and the
 * three-way control that sets it. Nothing here caches a flag — the suggestions
 * underneath are recomputed on every load, so a write re-reads the list.
 */

/** Query key prefix every status list shares, so one write can invalidate them all. */
export const SUGGESTION_STATUS_KEY = 'suggestion-status';

export const STATUS_LABEL: Record<SuggestionStatus, string> = {
  pending: 'Pending',
  done: 'Done',
  skipped: 'Skipped',
};

/** Acted on either way — half of what a "hide resolved" toggle hides. */
export const isResolved = (status: SuggestionStatus): boolean => status !== 'pending';

export const RECURRENCE_LABEL: Record<SuggestionRecurrence, string> = {
  none: '',
  historical: 'Pre-fix window',
  mixed: 'Spans the fix',
  regressed: 'Regressed',
};

/** Nothing left to do: acted on, or a frozen window the rule's own `done` postdates. */
export const isSettled = (row: Pick<SuggestionStatusRow, 'status' | 'recurrence'> | undefined): boolean =>
  row ? isResolved(row.status) || row.recurrence === 'historical' : false;

/** Nothing at all while pending — unflagged is the ordinary case. */
export function SuggestionStatusBadge({ status }: { status: SuggestionStatus }) {
  if (!isResolved(status)) return null;
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** Where this window stands against the rule's dated `done`. Silent for `none`. */
export function SuggestionRecurrenceBadge({ row }: { row: Pick<SuggestionStatusRow, 'recurrence' | 'resolved'> }) {
  if (row.recurrence === 'none') return null;
  const when = row.resolved ? fmtLocalTsShort(row.resolved.updated) : '';
  return (
    <span
      className={`badge recurrence-${row.recurrence}`}
      title={when ? `marked done ${when} (bucket ${row.resolved?.bucket})` : undefined}>
      {RECURRENCE_LABEL[row.recurrence]}
    </span>
  );
}

/** Mark one suggestion. `Pending` is the undo — the server deletes the entry. */
export function SuggestionStatusControl({
  bucket,
  id,
  row,
}: {
  bucket: number;
  id: string;
  row: SuggestionStatusRow | undefined;
}) {
  const client = useQueryClient();
  const status = row?.status ?? 'pending';
  const mark = useMutation({
    mutationFn: (next: SuggestionStatus) => markSuggestionStatus([{ bucket, id, status: next }]),
    // Re-ask rather than patch: every list showing this flag moves together.
    onSuccess: () => client.invalidateQueries({ queryKey: [SUGGESTION_STATUS_KEY] }),
  });

  return (
    <div className='suggestion-mark'>
      <div className='segmented'>
        {SUGGESTION_STATUSES.map((choice) => (
          <button
            key={choice}
            type='button'
            className={status === choice ? 'active' : undefined}
            aria-pressed={status === choice}
            disabled={mark.isPending}
            onClick={() => status !== choice && mark.mutate(choice)}>
            {STATUS_LABEL[choice]}
          </button>
        ))}
      </div>
      {row?.updated && (
        <span className='muted suggestion-mark-when'>
          {STATUS_LABEL[status].toLowerCase()} {fmtLocalTsShort(row.updated)}
        </span>
      )}
      {row?.resolved && row.resolved.bucket !== bucket && (
        <span className='muted suggestion-mark-when'>
          {row.recurrence === 'regressed'
            ? `rule marked done in ${row.resolved.bucket} on ${fmtLocalTsShort(row.resolved.updated)} — these sessions came after`
            : `rule marked done in ${row.resolved.bucket} on ${fmtLocalTsShort(row.resolved.updated)}`}
        </span>
      )}
      {mark.error && <span className='suggestion-mark-error'>{(mark.error as Error).message}</span>}
      {row?.note && <div className='suggestion-note'>{row.note}</div>}
    </div>
  );
}
