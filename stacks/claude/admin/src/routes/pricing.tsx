import {
  checkModelName,
  modelNameProblemMessage,
  normalizeModelKey,
  parseRateField,
  RATE_FIELD_LABELS,
  RATE_FIELDS,
  type RateField,
  type RateRow,
  rateProblemMessage,
  type StoredModelRate,
} from '@agent-proxy/claude-core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { AlertTriangle, Check, CircleDollarSign } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteModelRate, getRateTable, saveModelRate } from '../api';
import { HeaderHint } from '../components/HeaderHint';
import { QueryState } from '../components/QueryState';
import { rootRoute } from '../route-root';
import type { NavEntry } from './nav';
import type { ProviderSupport } from './providers';

/**
 * Pricing — the operator's surface over the rate table.
 *
 * This is where a human types in the rates for a model the catalogue has never
 * seen, so the **form is the product**: four validated fields per model, a visible
 * save state, and no JSON anywhere on the page.
 *
 * Three decisions from the records govern what is and is not here, and each one is
 * visible in the markup rather than only in a comment.
 *
 * [ADR 0044](../../../../../docs/adrs/0044-every-model-gets-a-price-row.md) — a row
 * for every model, keyed by an **exact** match, and **no effective dating**. There is
 * one current rate per model, so nothing on this page takes a date, shows a history,
 * or offers a version timeline. `updatedAt` is displayed as a note about the last
 * edit; nothing resolves against it.
 *
 * [ADR 0065](../../../../../docs/adrs/0065-cost-is-resolved-at-read-time.md) — cost is
 * worked out from this table on every read and stored nowhere. So an edit here
 * reprices the **whole corpus** immediately, last month included. That is the page's
 * standing note rather than a modal, because it is true on every visit: a warning
 * dismissed once is a warning nobody reads the second time.
 *
 * [ADR 0020](../../../../../docs/adrs/0020-unavailable-incomplete-cost.md) — a `null`
 * rate is **not configured**, which is not a rate of zero. Zero is a real price for a
 * genuinely free bucket; `null` on a bucket that consumed tokens makes the whole cost
 * unavailable. The page keeps the two apart everywhere: `not set` is prose in the UI
 * face, `0.00` is a number in the mono face, and a blank field means the first.
 */

/** How long a `saved` state stays up before decaying. Time, not motion — reduced motion does not shorten it. */
const SAVE_STATE_MS = 3000;

/** Long enough for the row-enter and row-leave animations in `pricing.css` to play out. */
const ROW_ENTER_MS = 400;
const ROW_LEAVE_MS = 200;

/** What a form is doing, and what it has to say about it. */
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; text: string }
  | { kind: 'failed'; text: string };

const IDLE: SaveState = { kind: 'idle' };

/** The four fields as text, which is what an input holds. */
type RateDraft = Record<RateField, string>;

const BLANK_DRAFT = { input: '', output: '', cacheWrite: '', cacheRead: '' } satisfies RateDraft;

/**
 * A stored rate as an input's value.
 *
 * `null` becomes the empty string, which is exactly what the operator types to mean
 * not configured — the round trip is lossless in both directions, and `0` stays `0`.
 */
function draftFrom(rates: RateRow) {
  return {
    input: rates.input === null ? '' : String(rates.input),
    output: rates.output === null ? '' : String(rates.output),
    cacheWrite: rates.cacheWrite === null ? '' : String(rates.cacheWrite),
    cacheRead: rates.cacheRead === null ? '' : String(rates.cacheRead),
  } satisfies RateDraft;
}

/**
 * A rate for reading, never for editing.
 *
 * Two decimals at least so a column of them lines up, six at most because that is
 * what the table stores; trailing zeros past the second are dropped so a precise
 * rate stays readable.
 */
function formatRate(value: number): string {
  const fixed = value.toFixed(6).replace(/(\.\d\d)0+$/, '$1');
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '.00') : fixed;
}

/** The error for each field the operator has touched, keyed by field. */
type FieldErrors = Partial<Record<RateField, string>>;

/**
 * Validate the whole draft.
 *
 * Every field is parsed, not just up to the first bad one: the operator should see
 * all four messages at once rather than fixing one and discovering the next.
 * A field that did not parse contributes `null` to the row, which is only ever read
 * when `errors` is empty.
 */
function readDraft(draft: RateDraft) {
  const parsed = {
    input: parseRateField(draft.input),
    output: parseRateField(draft.output),
    cacheWrite: parseRateField(draft.cacheWrite),
    cacheRead: parseRateField(draft.cacheRead),
  };
  const errors: FieldErrors = {};
  for (const field of RATE_FIELDS) {
    const one = parsed[field];
    if (!one.ok) errors[field] = rateProblemMessage(one.problem);
  }
  const rates: RateRow = {
    input: parsed.input.ok ? parsed.input.value : null,
    output: parsed.output.ok ? parsed.output.value : null,
    cacheWrite: parsed.cacheWrite.ok ? parsed.cacheWrite.value : null,
    cacheRead: parsed.cacheRead.ok ? parsed.cacheRead.value : null,
  };
  return { rates, errors };
}

function hasErrors(errors: FieldErrors): boolean {
  return RATE_FIELDS.some((field) => errors[field] !== undefined);
}

/** The four inputs. One component, used in a table row and in the add card. */
function RateFields({
  idPrefix,
  draft,
  errors,
  touched,
  labelled,
  readOnly,
  onChange,
  onBlur,
  registerField,
}: {
  idPrefix: string;
  draft: RateDraft;
  errors: FieldErrors;
  touched: Partial<Record<RateField, boolean>>;
  /** Whether the fields carry visible labels; in a table the column header is the label. */
  labelled: boolean;
  readOnly: boolean;
  onChange: (field: RateField, value: string) => void;
  onBlur: (field: RateField) => void;
  /** Lets the page focus a named field — the first one on open, the first bad one on a refused submit. */
  registerField?: (field: RateField, element: HTMLInputElement | null) => void;
}) {
  return (
    <>
      {RATE_FIELDS.map((field) => {
        const invalid = touched[field] === true && errors[field] !== undefined;
        return (
          <label className='pricing-field' key={field}>
            <span className={labelled ? 'pricing-field-label' : 'sr-only'}>{RATE_FIELD_LABELS[field]}</span>
            <span className='pricing-field-input'>
              <span className='pricing-field-unit' aria-hidden>
                $
              </span>
              <input
                // `text` rather than `number`: a number input silently drops what it
                // cannot parse, so the operator never sees the thing we want to name.
                type='text'
                inputMode='decimal'
                autoComplete='off'
                spellCheck={false}
                readOnly={readOnly}
                value={draft[field]}
                placeholder='not set'
                aria-invalid={invalid}
                aria-describedby={`${idPrefix}-note${invalid ? ` ${idPrefix}-${field}-error` : ''}`}
                ref={(element) => registerField?.(field, element)}
                onChange={(e) => onChange(field, e.target.value)}
                onBlur={() => onBlur(field)}
              />
              <span className='pricing-field-unit' aria-hidden>
                /MTok
              </span>
            </span>
            <span className='pricing-field-error' id={`${idPrefix}-${field}-error`} role='alert'>
              {invalid ? errors[field] : ''}
            </span>
          </label>
        );
      })}
    </>
  );
}

/** The one sentence that teaches the null-versus-zero rule, rendered wherever fields are. */
function FieldNote({ id }: { id: string }) {
  return (
    <span className='pricing-field-note' id={id}>
      Blank leaves a bucket not set — any request that used it is unpriced. Enter 0 for a bucket that is genuinely free.
    </span>
  );
}

/** The save state, in the slot that is always rendered so nothing shifts when it lands. */
function SaveStatus({ state }: { state: SaveState }) {
  return (
    <>
      <span className='pricing-row-status' role='status'>
        {state.kind === 'saving' ? (
          <>
            <span className='pricing-spinner' aria-hidden />
            Saving…
          </>
        ) : null}
        {state.kind === 'saved' ? (
          <>
            <Check size={14} aria-hidden />
            {state.text}
          </>
        ) : null}
        {state.kind === 'failed' ? (
          <>
            <AlertTriangle size={14} aria-hidden />
            {state.text}
          </>
        ) : null}
      </span>
      {/* Success is polite; a failure interrupts, because it is the one a reader must not miss. */}
      {state.kind === 'failed' ? (
        <span className='sr-only' role='alert'>
          {state.text}
        </span>
      ) : null}
    </>
  );
}

/** Which class the form's state paints with. */
function stateClass(state: SaveState): string {
  if (state.kind === 'saving') return 'is-saving';
  if (state.kind === 'saved') return 'is-saved';
  if (state.kind === 'failed') return 'is-failed';
  return '';
}

/**
 * Which row should take focus once `model` is deleted: the next one, else the
 * previous one, else nothing because the table is about to be empty.
 */
function neighbourOf(models: readonly StoredModelRate[], model: string): string | null {
  const index = models.findIndex((m) => m.model === model);
  if (index === -1) return null;
  return models[index + 1]?.model ?? models[index - 1]?.model ?? null;
}

/** A rate in prose rather than in a column: `not set` reads as the word it is. */
function rateWord(value: number | null): string {
  return value === null ? 'not set' : formatRate(value);
}

/** Which of the four rates an edit actually moved. */
function changedFields(before: RateRow, after: RateRow): RateField[] {
  return RATE_FIELDS.filter((field) => before[field] !== after[field]);
}

/**
 * What the edit moved, named.
 *
 * The page's standing note warns that history reprices; this is the half that says
 * what *did*. "Repriced" alone would leave an operator who mistyped one field
 * unable to tell from the page which one they had just changed.
 */
function describeChange(model: string, before: RateRow, after: RateRow): string {
  const changed = changedFields(before, after);
  const moved = 'Every total that includes this model has already moved.';
  const [only] = changed;
  if (changed.length === 1 && only !== undefined) {
    const label = RATE_FIELD_LABELS[only].toLowerCase();
    return `Just now: ${model} ${label} ${rateWord(before[only])} → ${rateWord(after[only])}. ${moved}`;
  }
  return `Just now: ${model} — ${changed.length} rates changed. ${moved}`;
}

function failureText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return `Not saved — ${message}. Your edits are still here.`;
}

export function PricingPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['pricing'], queryFn: getRateTable });
  const table = query.data;
  const models = useMemo(() => table?.models ?? [], [table]);
  const fallback = table?.fallback ?? null;

  /** The model whose row is open for editing; one at a time. */
  const [editing, setEditing] = useState<string | null>(null);
  const [rowDraft, setRowDraft] = useState<RateDraft>(BLANK_DRAFT);
  const [rowTouched, setRowTouched] = useState<Partial<Record<RateField, boolean>>>({});
  const [rowState, setRowState] = useState<SaveState>(IDLE);
  const [confirming, setConfirming] = useState<string | null>(null);

  const [addModel, setAddModel] = useState('');
  const [addDraft, setAddDraft] = useState<RateDraft>(BLANK_DRAFT);
  const [addTouched, setAddTouched] = useState<Partial<Record<RateField, boolean>>>({});
  const [addModelTouched, setAddModelTouched] = useState(false);
  const [addState, setAddState] = useState<SaveState>(IDLE);

  /** What the last edit moved, reported under the standing note for a few seconds. */
  const [lastEdit, setLastEdit] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const addModelRef = useRef<HTMLInputElement>(null);
  /** The open row's four inputs, so a refused submit can focus the one that is wrong. */
  const fieldRefs = useRef(new Map<RateField, HTMLInputElement>());
  /** The same, for the add card's own four. */
  const addFieldRefs = useRef(new Map<RateField, HTMLInputElement>());
  /** Each row's Edit button, so focus has somewhere to return to when a row closes. */
  const editButtons = useRef(new Map<string, HTMLButtonElement>());

  const rowRead = useMemo(() => readDraft(rowDraft), [rowDraft]);
  const addRead = useMemo(() => readDraft(addDraft), [addDraft]);

  /** The `Just now` line decays; the state it describes does not. */
  useEffect(() => {
    if (lastEdit === null) return;
    const timer = setTimeout(() => setLastEdit(null), SAVE_STATE_MS);
    return () => clearTimeout(timer);
  }, [lastEdit]);

  useEffect(() => {
    if (addState.kind !== 'saved') return;
    const timer = setTimeout(() => setAddState(IDLE), SAVE_STATE_MS);
    return () => clearTimeout(timer);
  }, [addState]);

  useEffect(() => {
    if (entering === null) return;
    const timer = setTimeout(() => setEntering(null), ROW_ENTER_MS);
    return () => clearTimeout(timer);
  }, [entering]);

  /**
   * Open a row for editing.
   *
   * One row at a time, and a row with typed changes is not abandoned silently:
   * opening another while this one is dirty is refused, and says so in the status
   * slot the operator is already looking at.
   */
  const openRow = useCallback(
    (record: StoredModelRate) => {
      if (editing !== null && editing !== record.model) {
        const current = models.find((m) => m.model === editing)?.rates;
        if (current !== undefined && changedFields(current, rowRead.rates).length > 0) {
          setRowState({ kind: 'failed', text: 'Save or cancel this row first.' });
          fieldRefs.current.get('input')?.focus();
          return;
        }
      }
      setEditing(record.model);
      setRowDraft(draftFrom(record.rates));
      setRowTouched({});
      setRowState(IDLE);
      setConfirming(null);
    },
    [editing, models, rowRead],
  );

  /**
   * Leave edit mode, clearing the state slot with it.
   *
   * A save deliberately does **not** call this from its success handler: the slot
   * lives inside the open row, so closing it there would unmount the confirmation
   * before it rendered and a save would look like nothing happened. The decay
   * effect below closes the row instead, once `Saved` has been up long enough.
   */
  const closeRow = useCallback(() => {
    const closed = editing;
    setEditing(null);
    setRowDraft(BLANK_DRAFT);
    setRowTouched({});
    setRowState(IDLE);
    setConfirming(null);
    // Focus came from that row's Edit button and the fields are about to unmount,
    // so hand it back there rather than dropping it on <body>. One frame later,
    // because the read-mode button does not exist until this render commits.
    if (closed !== null) {
      requestAnimationFrame(() => editButtons.current.get(closed)?.focus());
    }
  }, [editing]);

  /** Opening a row moves focus into it — the Edit button that had focus is now gone. */
  useEffect(() => {
    if (editing === null) return;
    fieldRefs.current.get('input')?.focus();
  }, [editing]);

  /**
   * A saved row decays and then closes, in that order.
   *
   * Only the `saved` state is on a clock. A `failed` one stays until the operator
   * retries, cancels, or edits a field — a failure that cleared itself would end up
   * looking exactly like a success. Declared after `closeRow` because the dependency
   * array is evaluated during render, not after it.
   */
  useEffect(() => {
    if (rowState.kind !== 'saved') return;
    const timer = setTimeout(() => closeRow(), SAVE_STATE_MS);
    return () => clearTimeout(timer);
  }, [rowState, closeRow]);

  const save = useMutation({
    mutationFn: ({ model, rates }: { model: string; rates: RateRow }) => saveModelRate(model, rates),
  });

  const remove = useMutation({ mutationFn: (model: string) => deleteModelRate(model) });

  const submitRow = useCallback(() => {
    if (editing === null) return;
    setRowTouched({ input: true, output: true, cacheWrite: true, cacheRead: true });
    if (hasErrors(rowRead.errors)) {
      // Focus the first field that is wrong rather than only marking it. The button
      // stays enabled on purpose — a disabled one refuses without saying why.
      const firstBad = RATE_FIELDS.find((field) => rowRead.errors[field] !== undefined);
      if (firstBad !== undefined) fieldRefs.current.get(firstBad)?.focus();
      return;
    }
    const before = models.find((m) => m.model === editing)?.rates;
    // A Save that changes nothing is a close, not a write. Issuing it would announce
    // a repricing that did not happen, and the note above would be a lie.
    if (before !== undefined && changedFields(before, rowRead.rates).length === 0) {
      closeRow();
      return;
    }
    setRowState({ kind: 'saving' });
    save.mutate(
      { model: editing, rates: rowRead.rates },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(['pricing'], data);
          setRowState({ kind: 'saved', text: 'Saved — history repriced' });
          // The row stays open carrying that confirmation; the decay effect above
          // closes it once it has been up long enough to read. Closing here would
          // unmount the status slot and make a save look like nothing happened.
          setLastEdit(
            before === undefined ? `Just now: ${editing} repriced.` : describeChange(editing, before, rowRead.rates),
          );
        },
        // The row stays open with the typed values intact: a failed save that also
        // threw the input away would be two failures.
        onError: (cause) => setRowState({ kind: 'failed', text: failureText(cause) }),
      },
    );
  }, [editing, rowRead, models, save, queryClient, closeRow]);

  const submitAdd = useCallback(() => {
    setAddModelTouched(true);
    setAddTouched({ input: true, output: true, cacheWrite: true, cacheRead: true });
    const nameProblem = checkModelName(
      addModel,
      models.map((m) => m.model),
    );
    if (nameProblem !== null) {
      addModelRef.current?.focus();
      return;
    }
    if (hasErrors(addRead.errors)) {
      const firstBad = RATE_FIELDS.find((field) => addRead.errors[field] !== undefined);
      if (firstBad !== undefined) addFieldRefs.current.get(firstBad)?.focus();
      return;
    }
    const model = addModel.trim();
    setAddState({ kind: 'saving' });
    save.mutate(
      { model, rates: addRead.rates },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(['pricing'], data);
          setAddState({ kind: 'saved', text: `Added ${model}` });
          setLastEdit(`Just now: added ${model}. Its records no longer fall to the fallback.`);
          setEntering(normalizeModelKey(model));
          setAddModel('');
          setAddDraft(BLANK_DRAFT);
          setAddTouched({});
          setAddModelTouched(false);
          addModelRef.current?.focus();
        },
        onError: (cause) => setAddState({ kind: 'failed', text: failureText(cause) }),
      },
    );
  }, [addModel, addRead, models, save, queryClient]);

  const confirmDelete = useCallback(
    (model: string) => {
      // Dismiss the confirm before the request goes out. Leaving it up would keep
      // the status slot unmounted, so a delete that failed would show the operator
      // the same Delete/Keep prompt and no message at all.
      setConfirming(null);
      setRowState({ kind: 'saving' });
      const nextFocus = neighbourOf(models, model);
      remove.mutate(model, {
        onSuccess: (data) => {
          // Fade the row, then commit the new table, so the list reflows once
          // rather than snapping a row out from under the pointer.
          setLeaving(normalizeModelKey(model));
          setLastEdit(
            data.fallback === null
              ? `Just now: removed ${model}. Its records are now unpriced.`
              : `Just now: removed ${model}. Its records now fall to the fallback.`,
          );
          setTimeout(() => {
            queryClient.setQueryData(['pricing'], data);
            setLeaving(null);
            closeRow();
            // The row that had focus is gone, so hand it to its neighbour rather
            // than letting it fall to <body>.
            const target = nextFocus === null ? addModelRef.current : (editButtons.current.get(nextFocus) ?? null);
            target?.focus();
          }, ROW_LEAVE_MS);
        },
        onError: (cause) => setRowState({ kind: 'failed', text: failureText(cause) }),
      });
    },
    [remove, queryClient, closeRow, models],
  );

  /**
   * The row's keyboard path: Enter saves, Escape cancels.
   *
   * While the delete confirm is up both answer the confirm instead — Escape is
   * Keep, and Enter is left to the focused button rather than firing a save behind
   * the question.
   */
  const rowKeys = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (confirming !== null) setConfirming(null);
        else closeRow();
        return;
      }
      if (event.key !== 'Enter' || confirming !== null) return;
      event.preventDefault();
      submitRow();
    },
    [submitRow, closeRow, confirming],
  );

  const unsetCount = models.filter((m) => RATE_FIELDS.some((f) => m.rates[f] === null)).length;
  const addNameProblem = checkModelName(
    addModel,
    models.map((m) => m.model),
  );
  const saving = rowState.kind === 'saving';

  return (
    <section>
      <div className='pagehead'>
        <h1>Pricing</h1>
        <div className='muted'>
          One current rate per model, in US dollars per million tokens. Nothing here is stored against a request — every
          cost on the dashboard is worked out from this table when it is read.
        </div>
      </div>

      <div className='card pricing-ledger-note'>
        <strong>Editing a rate reprices the whole history.</strong> Cost is resolved from this table at read time and
        stored nowhere, so a change here moves every total on every page — last month's included. Correcting a typo will
        make yesterday's numbers move; that is the design, not a fault.
        {lastEdit === null ? null : <span className='pricing-ledger-note-last'>{lastEdit}</span>}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        <div className='card'>
          <h2>Fallback</h2>
          <div className='muted pricing-blurb'>
            The rates a model gets when it has no row of its own. A cost priced this way carries the stamp{' '}
            <span className='rule-name'>fallback:{table?.proxy ?? 'claude'}</span>. Without one, those models are
            unpriced rather than free.
          </div>
          {fallback === null ? (
            <div className='pricing-absent'>No fallback declared. Models without a row of their own are unpriced.</div>
          ) : (
            <div className='table-scroll'>
              <table className='table pricing-table'>
                <thead>
                  <tr>
                    {/* No date column, deliberately. `updatedAt` is a note about when a
                        row was last touched, and putting it in the table beside the rates
                        would read as the date the rate applies from — the effective dating
                        ADR 0044 rules out. Nothing resolves against it, so nothing shows it. */}
                    {RATE_FIELDS.map((field) => (
                      <th className='num' key={field}>
                        {RATE_FIELD_LABELS[field]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {RATE_FIELDS.map((field) => (
                      <td className='num pricing-rate' key={field}>
                        <RateCell value={fallback.rates[field]} />
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className='card'>
          <div className='card-head'>
            <h2>Models</h2>
            <span className='muted'>
              {models.length} models{unsetCount > 0 ? ` · ${unsetCount} with a rate not set` : ''}
            </span>
          </div>
          {models.length === 0 ? (
            <div className='empty'>
              No models priced yet. Every request is falling to the fallback
              {fallback === null ? ', and none is declared, so every request is unpriced' : ''}. Add the first model
              below.
            </div>
          ) : (
            <div className='table-scroll'>
              <table className='table pricing-table'>
                <thead>
                  <tr>
                    <th>Model</th>
                    {RATE_FIELDS.map((field) => (
                      <th className='num' key={field}>
                        {RATE_FIELD_LABELS[field]}
                        {/* The unit and the null-versus-zero rule, said once where the
                            columns start — in read mode there are no fields to carry it. */}
                        {field === 'input' ? (
                          <HeaderHint text='US dollars per million tokens. "not set" means the bucket has no rate, so any request that used it is unpriced; 0 means the bucket is free.' />
                        ) : null}
                      </th>
                    ))}
                    <th>
                      <span className='sr-only'>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((record) => {
                    const key = normalizeModelKey(record.model);
                    const isEditing = editing === record.model;
                    const partial = RATE_FIELDS.some((f) => record.rates[f] === null);
                    const classes = [
                      isEditing ? 'is-editing' : '',
                      partial ? 'is-partial' : '',
                      entering === key ? 'is-entering' : '',
                      leaving === key ? 'is-leaving' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    if (!isEditing) {
                      return (
                        <tr className={classes} key={record.model}>
                          <td className='pricing-model'>{record.model}</td>
                          {RATE_FIELDS.map((field) => (
                            <td className='num pricing-rate' key={field}>
                              <RateCell value={record.rates[field]} />
                            </td>
                          ))}
                          <td className='pricing-actions'>
                            <button
                              type='button'
                              className='btn-quiet'
                              ref={(element) => {
                                if (element === null) editButtons.current.delete(record.model);
                                else editButtons.current.set(record.model, element);
                              }}
                              onClick={() => openRow(record)}>
                              Edit
                            </button>
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr className={classes} key={record.model}>
                        <td className='pricing-model'>{record.model}</td>
                        <td className={`pricing-edit-cell ${stateClass(rowState)}`} colSpan={RATE_FIELDS.length + 1}>
                          {/* Not a <form>: one cannot span table cells. Enter saves and
                              Escape cancels through the shared key handler instead, which
                              sits on this wrapper rather than on the inputs so it also
                              fires from Save, Cancel, Delete and the confirm's buttons. */}
                          {/* biome-ignore lint/a11y/noStaticElementInteractions: this is a keyboard shortcut over a group of real controls — every input and button inside is focusable and operable on its own, and the handler only adds Enter/Escape. Putting it on the inputs instead is what left Escape dead on the buttons. */}
                          <div className='pricing-row-form' onKeyDown={rowKeys}>
                            <RateFields
                              idPrefix={`row-${key}`}
                              draft={rowDraft}
                              errors={rowRead.errors}
                              touched={rowTouched}
                              labelled
                              readOnly={saving}
                              registerField={(field, element) => {
                                if (element === null) fieldRefs.current.delete(field);
                                else fieldRefs.current.set(field, element);
                              }}
                              onChange={(field, value) => setRowDraft((d) => ({ ...d, [field]: value }))}
                              onBlur={(field) => setRowTouched((t) => ({ ...t, [field]: true }))}
                            />
                            <FieldNote id={`row-${key}-note`} />
                            {confirming === record.model ? (
                              <fieldset className='pricing-confirm' aria-label='Confirm delete'>
                                Remove {record.model}?{' '}
                                {fallback === null
                                  ? 'Its records become unpriced.'
                                  : 'Its records fall to the fallback.'}
                                <button
                                  type='button'
                                  className='btn-primary pricing-confirm-yes'
                                  onClick={() => confirmDelete(record.model)}>
                                  Delete
                                </button>
                                {/* Focus lands on the safe answer: deleting takes a
                                    deliberate move, and Escape is Keep. */}
                                <button
                                  type='button'
                                  className='btn-quiet'
                                  ref={(element) => element?.focus()}
                                  onClick={() => setConfirming(null)}>
                                  Keep
                                </button>
                              </fieldset>
                            ) : (
                              <span className='pricing-actions'>
                                <SaveStatus state={rowState} />
                                <button type='button' className='btn-primary' disabled={saving} onClick={submitRow}>
                                  Save
                                </button>
                                <button type='button' className='btn-quiet' onClick={closeRow}>
                                  Cancel
                                </button>
                                <button
                                  type='button'
                                  className='btn-quiet pricing-danger'
                                  disabled={saving}
                                  onClick={() => setConfirming(record.model)}>
                                  Delete
                                </button>
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className='card'>
          <h2>Add a model</h2>
          <div className='muted pricing-blurb'>
            Exact match on the model name, case-insensitive. A row prices that model and no other — nothing is matched
            by family or prefix, so <span className='rule-name'>claude-opus-5-20260101</span> does not take the rates of{' '}
            <span className='rule-name'>claude-opus-5</span>.
          </div>
          <form
            className={`pricing-row-form pricing-row-form-add ${stateClass(addState)}`}
            onSubmit={(e) => {
              e.preventDefault();
              submitAdd();
            }}>
            <label className='pricing-field pricing-model-input'>
              <span className='pricing-field-label'>Model</span>
              <span className='pricing-field-input'>
                <input
                  type='text'
                  autoComplete='off'
                  spellCheck={false}
                  ref={addModelRef}
                  value={addModel}
                  placeholder='claude-opus-5'
                  aria-invalid={addModelTouched && addNameProblem !== null}
                  aria-describedby='add-model-error'
                  onChange={(e) => setAddModel(e.target.value)}
                  onBlur={() => setAddModelTouched(true)}
                />
              </span>
              <span className='pricing-field-error' id='add-model-error' role='alert'>
                {addModelTouched && addNameProblem !== null ? modelNameProblemMessage(addNameProblem) : ''}
              </span>
            </label>
            <RateFields
              idPrefix='add'
              draft={addDraft}
              errors={addRead.errors}
              touched={addTouched}
              labelled
              readOnly={addState.kind === 'saving'}
              registerField={(field, element) => {
                if (element === null) addFieldRefs.current.delete(field);
                else addFieldRefs.current.set(field, element);
              }}
              onChange={(field, value) => setAddDraft((d) => ({ ...d, [field]: value }))}
              onBlur={(field) => setAddTouched((t) => ({ ...t, [field]: true }))}
            />
            <FieldNote id='add-note' />
            <span className='pricing-actions'>
              <SaveStatus state={addState} />
              <button type='submit' className='btn-primary' disabled={addState.kind === 'saving'}>
                Add model
              </button>
            </span>
          </form>
        </div>
      </QueryState>
    </section>
  );
}

/**
 * One rate, read-only.
 *
 * The whole null-versus-zero rule in one component: a number is a number in the mono
 * face, and `not set` is a word in the UI face. Rendering the absence as `0.00`, or
 * as an empty cell, are the two mistakes ADR 0020 exists to prevent.
 */
function RateCell({ value }: { value: number | null }) {
  return value === null ? <span className='pricing-rate-unset'>not set</span> : formatRate(value);
}

export const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/pricing',
  component: PricingPage,
  staticData: { title: 'Pricing' },
});

export const nav = {
  section: 'Dashboard',
  to: '/pricing',
  label: 'Pricing',
  hint: 'rates',
  exact: false,
  icon: CircleDollarSign,
} as const satisfies NavEntry;

/** The rate table is this proxy's own: each stack prices its corpus and declares its own fallback. */
export const providers = ['anthropic'] as const satisfies ProviderSupport;
