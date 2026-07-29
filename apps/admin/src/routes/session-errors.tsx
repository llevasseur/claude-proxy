import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { LinkedSessionError } from "@claude-proxy/core";
import { getSessionErrors } from "../api";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { QueryState } from "../components/QueryState";

/** Per-session drill-down listing every errored tool result, re-linked to its task and tool call. */
export function SessionErrorsPage() {
  const { id } = useParams({ from: "/sessions/$id/errors" });
  const query = useQuery({
    queryKey: ["session-errors", id],
    queryFn: () => getSessionErrors(id),
  });
  const data = query.data;

  return (
    <section>
      <Breadcrumbs>
        <Link to="/sessions" className="link">
          Sessions
        </Link>
        <Link to="/sessions/$id" params={{ id }} className="link mono-break">
          {id}
        </Link>
        <span className="crumb-current">Errors</span>
      </Breadcrumbs>
      <div className="pagehead">
        <h1>Errors</h1>
        <span className="muted">Errored tool results captured in this session</span>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {data && <ErrorsBody errors={data.errors} />}
      </QueryState>
    </section>
  );
}

function ErrorsBody({ errors }: { errors: LinkedSessionError[] }) {
  if (errors.length === 0) {
    return <div className="card empty">No errors recorded in this session.</div>;
  }

  return (
    <>
      <div className="card-head">
        <h2>
          {errors.length} error{errors.length === 1 ? "" : "s"}
        </h2>
      </div>
      <div className="msg-blocks">
        {errors.map((err) => (
          <ErrorEntry key={err.index} error={err} />
        ))}
      </div>
    </>
  );
}

function ErrorEntry({ error }: { error: LinkedSessionError }) {
  return (
    <div id={`error-${error.index}`} className="msg-block error-entry">
      <div className="msg-block-head">
        <span className="msg-block-label">Error #{error.index + 1}</span>
        <span className="msg-badge">error</span>
      </div>
      <div className="error-meta">
        {error.task && (
          <div>
            <span className="error-meta-label">Task</span>
            <span>{error.task}</span>
          </div>
        )}
        <div>
          <span className="error-meta-label">Tool</span>
          {error.tool ? <code className="md-code">{error.tool}</code> : <span className="muted">unknown</span>}
        </div>
      </div>
      <div className="msg-text error-text">{error.text}</div>
      <ErrorTurnLink link={error.link} />
    </div>
  );
}

/**
 * The way into the failed turn itself: the Message details page for the request
 * message that carried this result, reached through the Request breakdown the
 * session already links to. Absent when no captured request still holds the turn —
 * the request may predate a compaction, or have been sent before the error happened.
 */
function ErrorTurnLink({ link }: { link: LinkedSessionError["link"] }) {
  if (!link) {
    return (
      <div className="error-cta-row muted" title="No captured request covers this turn.">
        full turn unavailable
      </div>
    );
  }

  return (
    <div className="error-cta-row">
      <Link
        to="/context/$file/message/$index"
        params={{ file: link.file, index: String(link.messageIndex) }}
        className="error-cta"
      >
        View the full turn · message #{link.messageIndex + 1} →
      </Link>
    </div>
  );
}
