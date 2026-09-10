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
  onKeyDown,
  firstRef,
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
  onKeyDown?: (event: React.KeyboardEvent) => void;
  firstRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <>
      {RATE_FIELDS.map((field, index) => {
        const invalid = touched[field] === true && errors[field] !== undefined;
        return (
          // biome-ignore lint/a11y/noLabelWithoutControl: the input is the label's own child, which is the association
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
                ref={index === 0 ? firstRef : undefined}
                onChange={(e) => onChange(field, e.target.value)}
                onBlur={() => onBlur(field)}
                onKeyDown={onKeyDown}
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
  const rowFirstRef = useRef<HTMLInputElement>(null);

  const rowRead = useMemo(() => readDraft(rowDraft), [rowDraft]);
  const addRead = useMemo(() => readDraft(addDraft), [addDraft]);

  /** The `Just now` line decays; the state it describes does not. */
  useEffect(() => {
    if (lastEdit === null) return;
    const timer = setTimeout(() => setLastEdit(null), SAVE_STATE_MS);
    return () => clearTimeout(timer);
  }, [lastEdit]);

  useEffect(() => {
    if (rowState.kind !== 'saved') return;
    const timer = setTimeout(() => setRowState(IDLE), SAVE_STATE_MS);
    return () => clearTimeout(timer);
  }, [rowState]);

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

  const openRow = useCallback((record: StoredModelRate) => {
    setEditing(record.model);
    setRowDraft(draftFrom(record.rates));
    setRowTouched({});
    setRowState(IDLE);
    setConfirming(null);
  }, []);

  const closeRow = useCallback(() => {
    setEditing(null);
    setRowDraft(BLANK_DRAFT);
    setRowTouched({});
    setRowState(IDLE);
    setConfirming(null);
  }, []);

  const save = useMutation({
    mutationFn: ({ model, rates }: { model: string; rates: RateRow }) => saveModelRate(model, rates),
  });

  const remove = useMutation({ mutationFn: (model: string) => deleteModelRate(model) });

  const submitRow = useCallback(() => {
    if (editing === null) return;
    setRowTouched({ input: true, output: true, cacheWrite: true, cacheRead: true });
    if (hasErrors(rowRead.errors)) return;
    setRowState({ kind: 'saving' });
    save.mutate(
      { model: editing, rates: rowRead.rates },
      {
        onSuccess: (data) => {
          queryClient.setQueryData(['pricing'], data);
          setRowState({ kind: 'saved', text: 'Saved — history repriced' });
          setLastEdit(`Just now: ${editing} repriced. Every total that includes this model has already moved.`);
          closeRow();
        },
        // The row stays open with the typed values intact: a failed save that also
        // threw the input away would be two failures.
        onError: (cause) => setRowState({ kind: 'failed', text: failureText(cause) }),
      },
    );
  }, [editing, rowRead, save, queryClient, closeRow]);

  const submitAdd = useCallback(() => {
    setAddModelTouched(true);
    setAddTouched({ input: true, output: true, cacheWrite: true, cacheRead: true });
    const nameProblem = checkModelName(
      addModel,
      models.map((m) => m.model),
    );
    if (nameProblem !== null || hasErrors(addRead.errors)) return;
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
      setRowState({ kind: 'saving' });
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
          }, ROW_LEAVE_MS);
        },
        onError: (cause) => setRowState({ kind: 'failed', text: failureText(cause) }),
      });
    },
    [remove, queryClient, closeRow],
  );

  const rowKeys = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitRow();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeRow();
      }
    },
    [submitRow, closeRow],
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
                    {RATE_FIELDS.map((field) => (
                      <th className='num' key={field}>
                        {RATE_FIELD_LABELS[field]}
                      </th>
                    ))}
                    <th>Last edited</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {RATE_FIELDS.map((field) => (
                      <td className='num pricing-rate' key={field}>
                        <RateCell value={fallback.rates[field]} />
                      </td>
                    ))}
                    <td className='muted'>{fallback.updatedAt.slice(0, 10)}</td>
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
                      </th>
                    ))}
                    <th />
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
                            <button type='button' className='btn-quiet' onClick={() => openRow(record)}>
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
                              Escape cancels through the shared key handler instead. */}
                          <div className='pricing-row-form'>
                            <RateFields
                              idPrefix={`row-${key}`}
                              draft={rowDraft}
                              errors={rowRead.errors}
                              touched={rowTouched}
                              labelled
                              readOnly={saving}
                              firstRef={rowFirstRef}
                              onChange={(field, value) => setRowDraft((d) => ({ ...d, [field]: value }))}
                              onBlur={(field) => setRowTouched((t) => ({ ...t, [field]: true }))}
                              onKeyDown={rowKeys}
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
                                <button type='button' className='btn-quiet' onClick={() => setConfirming(null)}>
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
            {/* biome-ignore lint/a11y/noLabelWithoutControl: the input is the label's own child, which is the association */}
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
  return value === null ? <span className='pricing-rate-unset'>not set</span> : <>{formatRate(value)}</>;
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
