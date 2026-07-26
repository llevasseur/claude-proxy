import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SUGGESTION_STATUSES, type SuggestionStatus, type SuggestionStatusRow } from "@claude-proxy/core";
import { markSuggestionStatus } from "../api";
import { fmtLocalTsShort } from "../format";

/**
 * The UI for a suggestion's flag: a badge that says where it stands, and the
 * three-way control that sets it.
 *
 * The flags are keyed `(bucket index, suggestion id)` server-side and the
 * suggestions underneath are recomputed on every load, so nothing here caches a
 * flag locally — a write re-reads the list through the same join that rendered it.
 */

/** Query key prefix every status list shares, so one write can invalidate them all. */
export const SUGGESTION_STATUS_KEY = "suggestion-status";

export const STATUS_LABEL: Record<SuggestionStatus, string> = {
  pending: "Pending",
  done: "Done",
  skipped: "Skipped",
};

/** Acted on either way — the half of the list a "hide resolved" toggle hides. */
export const isResolved = (status: SuggestionStatus): boolean => status !== "pending";

/** Nothing at all while pending: an unflagged suggestion is the ordinary case. */
export function SuggestionStatusBadge({ status }: { status: SuggestionStatus }) {
  if (!isResolved(status)) return null;
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

/**
 * Mark one suggestion. `Pending` is the undo — the server deletes the entry
 * rather than recording a third state, which is why it sits in the same control
 * as the other two rather than off to the side.
 */
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
  const status = row?.status ?? "pending";
  const mark = useMutation({
    mutationFn: (next: SuggestionStatus) => markSuggestionStatus([{ bucket, id, status: next }]),
    // Re-ask rather than patching the row here: the file is the truth, and every
    // list showing this flag should move together.
    onSuccess: () => client.invalidateQueries({ queryKey: [SUGGESTION_STATUS_KEY] }),
  });

  return (
    <div className="suggestion-mark">
      <div className="segmented">
        {SUGGESTION_STATUSES.map((choice) => (
          <button
            key={choice}
            type="button"
            className={status === choice ? "active" : undefined}
            aria-pressed={status === choice}
            disabled={mark.isPending || status === choice}
            onClick={() => mark.mutate(choice)}
          >
            {STATUS_LABEL[choice]}
          </button>
        ))}
      </div>
      {row?.updated && (
        <span className="muted suggestion-mark-when">
          {STATUS_LABEL[status].toLowerCase()} {fmtLocalTsShort(row.updated)}
        </span>
      )}
      {mark.error && <span className="suggestion-mark-error">{(mark.error as Error).message}</span>}
      {row?.note && <div className="suggestion-note">{row.note}</div>}
    </div>
  );
}
