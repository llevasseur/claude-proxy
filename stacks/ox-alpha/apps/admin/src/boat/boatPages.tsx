import { keepPreviousData, type UseQueryResult, useQuery } from "@tanstack/react-query";
import { type ReactNode, useId } from "react";
import {
  DEFAULT_INSPECTION_LIMIT,
  fetchErrors,
  fetchHealth,
  fetchInspectionDay,
  fetchInspectionMessages,
  fetchInspectionSessions,
  fetchInspectionToolCalls,
  fetchInspectionTools,
  fetchPromptAnalysis,
  fetchPromptListings,
  fetchPromptMix,
  fetchPromptSections,
  fetchSessionBreakdown,
  fetchSessionDetail,
  type InspectionPage,
  type MessageRecord,
  type PromptListingRecord,
} from "../api";
import { formatTimestamp } from "../car/format";
import { Breadcrumbs } from "../ui/Breadcrumbs";
import { MarkdownText } from "../ui/Markdown";

// Boat inspection pages. Every surface degrades visibly: when the server has
// capture disabled the page explains that Boat capture is off instead of
// rendering a bare empty table.

export const BOAT_OFF_TEXT =
  "Boat capture is off. Set CAPTURE_BODIES=true on the proxy and server to record redacted request and response bodies for inspection.";

function useCaptureEnabled(): Readonly<{
  loading: boolean;
  enabled: boolean | null;
}> {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    retry: false,
    refetchInterval: 10_000,
  });
  if (health.isLoading) return { loading: true, enabled: null };
  return { loading: false, enabled: health.data?.capture.enabled ?? null };
}

interface PageShellProps {
  readonly title: string;
  readonly subtitle: string;
  readonly testIdPrefix: string;
  readonly captureEnabled: boolean;
  readonly loading: boolean;
  readonly error: boolean;
  readonly empty: boolean;
  readonly emptyText: string;
  readonly children: ReactNode;
}

function PageShell({
  title,
  subtitle,
  testIdPrefix,
  captureEnabled,
  loading,
  error,
  empty,
  emptyText,
  children,
}: PageShellProps) {
  const titleId = useId();
  return (
    <section className="car-page" aria-labelledby={titleId}>
      <header className="pagehead">
        <div className="pagehead-title">
          <h1 id={titleId}>{title}</h1>
          <div className="muted">{subtitle}</div>
        </div>
      </header>
      {!captureEnabled && (
        <output className="card notice" data-testid={`${testIdPrefix}-no-capture`}>
          {BOAT_OFF_TEXT}
        </output>
      )}
      {error && (
        <div
          className="card notice notice--error"
          role="alert"
          data-testid={`${testIdPrefix}-error`}
        >
          The local API could not be reached. The page will retry automatically.
        </div>
      )}
      {loading && (
        <p className="card muted" aria-live="polite" data-testid={`${testIdPrefix}-loading`}>
          Loading…
        </p>
      )}
      {empty && (
        <div className="card empty car-empty" data-testid={`${testIdPrefix}-empty`}>
          <strong>No captured data.</strong>
          <span>{emptyText}</span>
        </div>
      )}
      {!loading && !empty && children}
    </section>
  );
}

function PaginatedTable<T>({
  page,
  onPageChange,
}: {
  readonly page: InspectionPage<T>;
  readonly onPageChange: (offset: number) => void;
}) {
  const limit = page.limit ?? DEFAULT_INSPECTION_LIMIT;
  return (
    <nav className="car-pagination" aria-label="Inspection pages">
      <button
        type="button"
        onClick={() => onPageChange(Math.max(0, page.offset - limit))}
        disabled={page.offset === 0}
      >
        Previous
      </button>
      <span className="muted">
        Showing {page.total === 0 ? 0 : page.offset + 1}–{page.offset + page.records.length} of{" "}
        {page.total}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(page.nextOffset ?? page.offset)}
        disabled={page.nextOffset === null}
      >
        Next
      </button>
    </nav>
  );
}

interface BoatPageProps<T> {
  readonly title: string;
  readonly subtitle: string;
  readonly testIdPrefix: string;
  readonly emptyText: string;
  readonly query: UseQueryResult<InspectionPage<T>>;
  readonly children: (records: readonly T[]) => ReactNode;
}

function BoatListPage<T>({
  title,
  subtitle,
  testIdPrefix,
  emptyText,
  query,
  children,
}: BoatPageProps<T>) {
  const capture = useCaptureEnabled();
  return (
    <PageShell
      title={title}
      subtitle={subtitle}
      testIdPrefix={testIdPrefix}
      captureEnabled={capture.enabled !== false}
      loading={query.isPending || capture.loading}
      error={query.isError}
      empty={
        !query.isPending &&
        !query.isError &&
        query.data !== undefined &&
        query.data.records.length === 0
      }
      emptyText={emptyText}
    >
      {children(query.data?.records ?? [])}
    </PageShell>
  );
}

export function BoatContextPage({
  date,
  offset = 0,
  onSearchChange,
}: {
  readonly date?: string;
  readonly offset?: number;
  readonly onSearchChange: (patch: Record<string, unknown>) => void;
}) {
  const query = useQuery({
    queryKey: ["inspection-day", date ?? null, offset],
    queryFn: () => fetchInspectionDay(date, DEFAULT_INSPECTION_LIMIT, offset),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10_000,
  });
  return (
    <BoatListPage
      title="Context"
      subtitle={`Captured exchanges on ${date ?? "the latest report day"}`}
      query={query}
      testIdPrefix="boat-context"
      emptyText="No captures exist for this report day. Captures appear here once opted-in traffic flows through the proxy."
    >
      {(records) => (
        <div className="card car-table-card">
          <table className="car-table" data-testid="boat-context-table">
            <thead>
              <tr>
                <th scope="col">Captured</th>
                <th scope="col">Record</th>
                <th scope="col">Session</th>
                <th scope="col">Model</th>
                <th scope="col">Messages</th>
                <th scope="col">Tools</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.recordId}>
                  <td>{formatTimestamp(record.capturedAt)}</td>
                  <td className="car-cell-mono">
                    <a href={`#/boat/messages?recordId=${encodeURIComponent(record.recordId)}`}>
                      {record.recordId}
                    </a>
                    {" · "}
                    <a href={`#/boat/prompt?recordId=${encodeURIComponent(record.recordId)}`}>
                      prompt
                    </a>
                  </td>
                  <td className="car-cell-mono">{record.sessionId}</td>
                  <td>{record.model ?? "—"}</td>
                  <td>{record.messageCount}</td>
                  <td>
                    {record.toolCount} / {record.toolCallCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {query.data && (
            <PaginatedTable
              page={query.data}
              onPageChange={(next) => onSearchChange({ offset: next })}
            />
          )}
        </div>
      )}
    </BoatListPage>
  );
}

export function BoatMessagesPage({ recordId }: { readonly recordId?: string }) {
  const query = useQuery({
    queryKey: ["inspection-messages", recordId ?? ""],
    queryFn: () => fetchInspectionMessages(recordId ?? "", DEFAULT_INSPECTION_LIMIT, 0),
    enabled: recordId !== undefined,
    retry: false,
    refetchInterval: 10_000,
  });
  return (
    <BoatListPage
      title="Messages"
      subtitle={`Request and response turns of capture ${recordId ?? "—"}`}
      query={query}
      testIdPrefix="boat-messages"
      emptyText="Pick a captured exchange from the context page to inspect its messages."
    >
      {(records) => <MessageList records={records} />}
    </BoatListPage>
  );
}

function MessageList({ records }: { readonly records: readonly MessageRecord[] }) {
  return (
    <ol className="card" data-testid="boat-message-list">
      {records.map((message, index) => (
        <li key={`${message.recordId}-${index}`}>
          <span className="muted">
            {message.role ?? message.itemType ?? "item"} · {message.recordId}
          </span>
          <MarkdownText text={message.text} />
        </li>
      ))}
    </ol>
  );
}

export function BoatPromptPage({ recordId }: { readonly recordId?: string }) {
  const analysis = useQuery({
    queryKey: ["inspection-prompt", recordId ?? ""],
    queryFn: () => fetchPromptAnalysis(recordId ?? ""),
    enabled: recordId !== undefined,
    retry: false,
  });
  const sections = useQuery({
    queryKey: ["inspection-prompt-sections", recordId ?? ""],
    queryFn: () => fetchPromptSections(recordId ?? ""),
    enabled: recordId !== undefined,
    retry: false,
  });
  const capture = useCaptureEnabled();
  const titleId = useId();
  return (
    <section className="car-page" aria-labelledby={titleId}>
      <header className="pagehead">
        <div className="pagehead-title">
          <h1 id={titleId}>Prompt analysis</h1>
          <div className="muted">Shape of one captured request — never its body text</div>
        </div>
      </header>
      {!capture.loading && capture.enabled === false && (
        <output className="card notice" data-testid="boat-prompt-no-capture">
          {BOAT_OFF_TEXT}
        </output>
      )}
      {analysis.isError && (
        <div className="card notice notice--error" role="alert" data-testid="boat-prompt-error">
          That capture could not be read. It may have been deleted by retention.
        </div>
      )}
      {analysis.data && (
        <dl className="card" data-testid="boat-prompt-analysis">
          <dt>Model</dt>
          <dd>{analysis.data.model ?? "—"}</dd>
          <dt>Instructions present</dt>
          <dd>{analysis.data.instructionsPresent ? "yes" : "no"}</dd>
          <dt>Input messages</dt>
          <dd>{analysis.data.inputMessageCount}</dd>
          <dt>Tools declared</dt>
          <dd>{analysis.data.toolCount}</dd>
          <dt>Estimated input tokens (~4 chars/token)</dt>
          <dd>{analysis.data.estimatedInputTokens}</dd>
        </dl>
      )}
      {sections.data && sections.data.sections.length > 0 && (
        <div className="card car-table-card" data-testid="boat-prompt-sections">
          <table className="car-table">
            <caption className="sr-only">Prompt sections by size</caption>
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">Role</th>
                <th scope="col">Chars</th>
              </tr>
            </thead>
            <tbody>
              {sections.data.sections.map((section) => (
                <tr
                  key={
                    section.kind === "instructions" ? "instructions" : `message-${section.index}`
                  }
                >
                  <td>
                    {section.kind === "instructions" ? "instructions" : `input #${section.index}`}
                  </td>
                  <td>{section.role ?? "—"}</td>
                  <td>{section.chars}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function BoatToolsPage() {
  const query = useQuery({
    queryKey: ["inspection-tools"],
    queryFn: () => fetchInspectionTools(DEFAULT_INSPECTION_LIMIT, 0),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10_000,
  });
  return (
    <BoatListPage
      title="Tool schemas"
      subtitle="Function tools declared across captured requests"
      testIdPrefix="boat-tools"
      query={query}
      emptyText="No tool schemas in captures yet. Tools appear once capturing requests declare them."
    >
      {(records) => (
        <div className="card car-table-card">
          <table className="car-table" data-testid="boat-tools-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Description</th>
                <th scope="col">Schema</th>
              </tr>
            </thead>
            <tbody>
              {records.map((tool, index) => (
                <tr key={`${tool.recordId}-${tool.name}-${index}`}>
                  <td className="car-cell-mono">{tool.name}</td>
                  <td>{tool.type}</td>
                  <td>{tool.description ?? "—"}</td>
                  <td className="car-cell-mono">{tool.schemaJson}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BoatListPage>
  );
}

export function BoatToolCallsPage() {
  const query = useQuery({
    queryKey: ["inspection-tool-calls"],
    queryFn: () => fetchInspectionToolCalls(DEFAULT_INSPECTION_LIMIT, 0),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10_000,
  });
  return (
    <BoatListPage
      title="Tool calls"
      subtitle="Function calls extracted from captured responses"
      testIdPrefix="boat-tool-calls"
      query={query}
      emptyText="No tool calls in captured responses yet."
    >
      {(records) => (
        <div className="card car-table-card">
          <table className="car-table" data-testid="boat-tool-calls-table">
            <thead>
              <tr>
                <th scope="col">Captured</th>
                <th scope="col">Call</th>
                <th scope="col">Arguments</th>
              </tr>
            </thead>
            <tbody>
              {records.map((call, index) => (
                <tr key={`${call.recordId}-${call.callId ?? index}`}>
                  <td>{formatTimestamp(call.capturedAt)}</td>
                  <td className="car-cell-mono">
                    {call.name}
                    {call.callId && ` (${call.callId})`}
                  </td>
                  <td className="car-cell-mono">{call.argumentsText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BoatListPage>
  );
}

export function BoatSessionsPage() {
  const query = useQuery({
    queryKey: ["inspection-sessions"],
    queryFn: () => fetchInspectionSessions(DEFAULT_INSPECTION_LIMIT, 0),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10_000,
  });
  return (
    <BoatListPage
      title="Sessions"
      subtitle="Captures grouped by derived session identifier"
      testIdPrefix="boat-sessions"
      query={query}
      emptyText="No session groups derivable from captures yet."
    >
      {(records) => (
        <div className="card car-table-card">
          <table className="car-table" data-testid="boat-sessions-table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Captures</th>
                <th scope="col">First seen</th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {records.map((group) => (
                <tr key={group.sessionId}>
                  <td className="car-cell-mono">
                    <a href={`#/boat/sessions/detail?id=${encodeURIComponent(group.sessionId)}`}>
                      {group.sessionId}
                    </a>
                  </td>
                  <td>{group.captureCount}</td>
                  <td>{formatTimestamp(group.firstCapturedAt)}</td>
                  <td>{formatTimestamp(group.lastCapturedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BoatListPage>
  );
}

export function BoatPromptMixPage() {
  const mix = useQuery({
    queryKey: ["inspection-prompt-mix"],
    queryFn: () => fetchPromptMix(),
    retry: false,
    refetchInterval: 10_000,
  });
  const capture = useCaptureEnabled();
  const titleId = useId();
  const data = mix.data;
  return (
    <section className="car-page" aria-labelledby={titleId}>
      <header className="pagehead">
        <div className="pagehead-title">
          <h1 id={titleId}>Prompt mix</h1>
          <div className="muted">
            {data ? `Prompt traffic on ${data.date}, decomposed into cohorts` : "Prompt traffic"}
          </div>
        </div>
      </header>
      {!capture.loading && capture.enabled === false && (
        <output className="card notice" data-testid="boat-prompt-mix-no-capture">
          {BOAT_OFF_TEXT}
        </output>
      )}
      {mix.isError && (
        <div className="card notice notice--error" role="alert" data-testid="boat-prompt-mix-error">
          The prompt mix could not be read. The page will retry automatically.
        </div>
      )}
      {mix.isLoading && (
        <p className="card muted" aria-live="polite" data-testid="boat-prompt-mix-loading">
          Loading…
        </p>
      )}
      {data && data.cohorts.length > 0 && (
        <div className="card car-table-card" data-testid="boat-prompt-mix">
          <table className="car-table">
            <thead>
              <tr>
                <th scope="col">Cohort</th>
                <th scope="col">Requests</th>
                <th scope="col">Share</th>
                <th scope="col">Mean chars</th>
                <th scope="col">Models</th>
              </tr>
            </thead>
            <tbody>
              {data.cohorts.map((cohort) => (
                <tr key={cohort.key}>
                  <td className="car-cell-mono">
                    {cohort.identified && cohort.hash ? (
                      <a href={`#/boat/prompts?hash=${encodeURIComponent(cohort.hash)}`}>
                        {cohort.label}
                      </a>
                    ) : (
                      cohort.label
                    )}
                  </td>
                  <td>{cohort.requests}</td>
                  <td>{Math.round(cohort.share * 100)}%</td>
                  <td>{Math.round(cohort.meanChars)}</td>
                  <td>{cohort.models.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.cohorts.length === 0 && !capture.loading && capture.enabled !== false && (
        <div className="card empty car-empty" data-testid="boat-prompt-mix-empty">
          <strong>No prompt traffic.</strong>
          <span>No captures exist for the latest report day.</span>
        </div>
      )}
    </section>
  );
}

export function BoatPromptsPage({ hash }: { readonly hash?: string }) {
  const query = useQuery({
    queryKey: ["inspection-prompts", hash ?? null],
    queryFn: () => fetchPromptListings(undefined, hash),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10_000,
  });
  return (
    <BoatListPage
      title={hash ? `Prompts · ${hash.slice(0, 12)}` : "Prompts"}
      subtitle="Captured requests grouped by their instructions hash"
      testIdPrefix="boat-prompts"
      query={query}
      emptyText="No captured prompts match this view yet."
    >
      {(records: readonly PromptListingRecord[]) => (
        <div className="card car-table-card">
          <table className="car-table" data-testid="boat-prompts-table">
            <thead>
              <tr>
                <th scope="col">Captured</th>
                <th scope="col">Record</th>
                <th scope="col">Model</th>
                <th scope="col">Instructions hash</th>
                <th scope="col">Sections</th>
              </tr>
            </thead>
            <tbody>
              {records.map((entry) => (
                <tr key={entry.recordId}>
                  <td>{formatTimestamp(entry.capturedAt)}</td>
                  <td className="car-cell-mono">
                    <a href={`#/boat/prompt?recordId=${encodeURIComponent(entry.recordId)}`}>
                      {entry.recordId}
                    </a>
                  </td>
                  <td>{entry.model ?? "—"}</td>
                  <td className="car-cell-mono">{entry.instructionsHash ?? "—"}</td>
                  <td>{entry.sectionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BoatListPage>
  );
}

export function BoatSessionDetailPage({ id }: { readonly id?: string }) {
  const detail = useQuery({
    queryKey: ["session-detail", id ?? ""],
    queryFn: () => fetchSessionDetail(id ?? ""),
    enabled: id !== undefined,
    retry: false,
    refetchInterval: 10_000,
  });
  const breakdown = useQuery({
    queryKey: ["session-breakdown", id ?? ""],
    queryFn: () => fetchSessionBreakdown(id ?? ""),
    enabled: id !== undefined,
    retry: false,
    refetchInterval: 10_000,
  });
  const capture = useCaptureEnabled();
  const titleId = useId();
  const data = detail.data;
  return (
    <section className="car-page" aria-labelledby={titleId}>
      <Breadcrumbs
        crumbs={[
          { label: "Context", href: "#/boat" },
          { label: "Sessions", href: "#/boat/sessions" },
          { label: id ?? "Session" },
        ]}
      />
      <header className="pagehead">
        <div className="pagehead-title">
          <h1 id={titleId}>Session {id ?? "—"}</h1>
          <div className="muted">Captures and per-model activity of one session</div>
        </div>
      </header>
      {!capture.loading && capture.enabled === false && (
        <output className="card notice" data-testid="boat-session-detail-no-capture">
          {BOAT_OFF_TEXT}
        </output>
      )}
      {detail.isError && (
        <div
          className="card notice notice--error"
          role="alert"
          data-testid="boat-session-detail-error"
        >
          That session could not be read. It may have been deleted by retention.
        </div>
      )}
      {detail.isLoading && (
        <p className="card muted" aria-live="polite" data-testid="boat-session-detail-loading">
          Loading…
        </p>
      )}
      {breakdown.data && breakdown.data.captures > 0 && (
        <dl className="card" data-testid="boat-session-breakdown">
          <dt>Captures</dt>
          <dd>{breakdown.data.captures}</dd>
          <dt>Models</dt>
          <dd>
            {breakdown.data.models
              .map((entry) => `${entry.model} × ${entry.requests}`)
              .join(", ") || "—"}
          </dd>
          <dt>Hours</dt>
          <dd>
            {breakdown.data.hours.map((entry) => `${entry.hour} × ${entry.captures}`).join(", ") ||
              "—"}
          </dd>
        </dl>
      )}
      {data && data.records.length > 0 && (
        <div className="card car-table-card" data-testid="boat-session-detail-table">
          <table className="car-table">
            <thead>
              <tr>
                <th scope="col">Captured</th>
                <th scope="col">Record</th>
                <th scope="col">Model</th>
                <th scope="col">Messages</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((record) => (
                <tr key={record.recordId}>
                  <td>{formatTimestamp(record.capturedAt)}</td>
                  <td className="car-cell-mono">
                    <a href={`#/boat/messages?recordId=${encodeURIComponent(record.recordId)}`}>
                      {record.recordId}
                    </a>
                  </td>
                  <td>{record.model ?? "—"}</td>
                  <td>{record.messageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail.data &&
        detail.data.records.length === 0 &&
        !capture.loading &&
        capture.enabled !== false && (
          <div className="card empty car-empty" data-testid="boat-session-detail-empty">
            <strong>No captures in this session.</strong>
            <span>Its captures may have expired under the retention policy.</span>
          </div>
        )}
    </section>
  );
}

export function BoatErrorsPage() {
  const errors = useQuery({
    queryKey: ["inspection-errors"],
    queryFn: fetchErrors,
    retry: false,
    refetchInterval: 30_000,
  });
  const titleId = useId();
  const data = errors.data;
  return (
    <section className="car-page" aria-labelledby={titleId}>
      <Breadcrumbs crumbs={[{ label: "Context", href: "#/boat" }, { label: "Errors" }]} />
      <header className="pagehead">
        <div className="pagehead-title">
          <h1 id={titleId}>Errors</h1>
          <div className="muted">Rejected sidecars and unreadable captures</div>
        </div>
      </header>
      {errors.isError && (
        <div className="card notice notice--error" role="alert" data-testid="boat-errors-error">
          The error listing could not be read. The page will retry automatically.
        </div>
      )}
      {errors.isLoading && !errors.isError && (
        <p className="card muted" aria-live="polite" data-testid="boat-errors-loading">
          Loading…
        </p>
      )}
      {data !== undefined &&
        (data.rejectedSidecars.length === 0 && data.unreadableCaptures === 0 ? (
          <div className="card empty car-empty" data-testid="boat-errors-empty">
            <strong>No ingest errors.</strong>
            <span>Every final sidecar ingested cleanly; every capture parsed.</span>
          </div>
        ) : (
          <div className="card car-table-card" data-testid="boat-errors-table">
            <table className="car-table">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Detected</th>
                </tr>
              </thead>
              <tbody>
                {data.rejectedSidecars.map((entry) => (
                  <tr key={entry.filename}>
                    <td className="car-cell-mono">{entry.filename}</td>
                    <td>{entry.reason}</td>
                    <td>{formatTimestamp(entry.rejectedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
