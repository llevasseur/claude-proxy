import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { PromptCohort, PromptMixDay, MixAttribution } from "@claude-proxy/core";
import { getPromptMix, type PromptRevisionDetail } from "../api";
import { fmtBytes, fmtInt, fmtPct } from "../format";

/** How many cohorts and section movers to show before the tail is folded away. */
const TOP_COHORTS = 8;
const TOP_MOVES = 10;

/** Signed byte delta. */
function fmtDelta(bytes: number): string {
  return `${bytes >= 0 ? "+" : "−"}${fmtBytes(Math.abs(Math.round(bytes)))}`;
}

function tone(bytes: number): string {
  if (Math.round(bytes) === 0) return "flat";
  return bytes > 0 ? "bad" : "good";
}

/**
 * Where the day's mean system-prompt size comes from, and why it moved.
 *
 * The mean is unweighted across a day's requests, so it tracks the traffic mix
 * between prompts as much as the prompts themselves. Everything here works off
 * captured sidecars, so it answers for history as well as for today.
 */
export function PromptMixPanel({ days }: { days: number }) {
  const query = useQuery({
    queryKey: ["prompt-mix", days],
    queryFn: () => getPromptMix(days),
    placeholderData: keepPreviousData,
  });

  const data = query.data;
  if (!data) return null;
  const day = data.days.at(-1);
  if (!day) return null;

  return (
    <div className="grid wide-two">
      <div className="card">
        <div className="card-head">
          <h2>Where the number comes from</h2>
          <span className="muted">click a prompt for its breakdown</span>
        </div>
        <Composition day={day} partial={data.partial} />
        <CohortTable day={day} />
      </div>

      <div className="card">
        <h2>Why it changed</h2>
        {data.attribution ? (
          <Attribution attribution={data.attribution} />
        ) : (
          <div className="empty">Only one day of captured traffic — nothing to compare against yet.</div>
        )}
        {data.revisions.map((r) => (
          <SectionMoves key={`${r.priorHash}-${r.hash}`} revision={r} />
        ))}
      </div>
    </div>
  );
}

/** The one-paragraph answer: an average over N requests, not a sum, plus the median as a control. */
function Composition({ day, partial }: { day: PromptMixDay; partial: { date: string; elapsed: number } | null }) {
  return (
    <p className="muted mix-note">
      The mean of the <strong>{fmtInt(day.requests)}</strong> system prompts sent on {day.date} — one per request, not a
      running total. Half of them were under <strong>{fmtBytes(Math.round(day.medianBytes))}</strong>, so a mean of{" "}
      <strong>{fmtBytes(Math.round(day.meanBytes))}</strong> is being pulled up by the largest cohorts below.
      {day.identifiedShare < 1 && (
        <>
          {" "}
          {fmtPct((1 - day.identifiedShare) * 100)} of requests predate prompt capture and are grouped by model and size
          band instead of by exact prompt.
        </>
      )}
      {partial && (
        <>
          {" "}
          <strong>{day.date} is still in progress</strong> ({fmtPct(partial.elapsed * 100)} elapsed), so its mix can
          still move.
        </>
      )}
    </p>
  );
}

function CohortTable({ day }: { day: PromptMixDay }) {
  const shown = day.cohorts.slice(0, TOP_COHORTS);
  const rest = day.cohorts.slice(TOP_COHORTS);
  const restContribution = rest.reduce((a, c) => a + c.contribution, 0);

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Prompt</th>
          <th className="num">Requests</th>
          <th className="num">Share</th>
          <th className="num">Size</th>
          <th className="num">Of the mean</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((c) => (
          <CohortRow key={c.key} cohort={c} />
        ))}
        {rest.length > 0 && (
          <tr>
            <td className="muted">{rest.length} smaller cohorts</td>
            <td className="num">{fmtInt(rest.reduce((a, c) => a + c.requests, 0))}</td>
            <td className="num">{fmtPct(rest.reduce((a, c) => a + c.share, 0) * 100)}</td>
            <td className="num">—</td>
            <td className="num">{fmtBytes(Math.round(restContribution))}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** A mover carries its cohort key rather than a hash; only identified keys are one. */
function hashOfKey(key: string): string | null {
  return key.startsWith("legacy:") ? null : key;
}

/**
 * A cohort's name, linked to its breakdown when there is one to link to. A
 * legacy cohort is keyed by model and size band rather than by a prompt, so it
 * has no single outline to open.
 */
function CohortLabel({ label, hash }: { label: string; hash: string | null }) {
  if (!hash) {
    return (
      <>
        <span className="mono">{label}</span>
        <span className="muted"> (est.)</span>
      </>
    );
  }
  return (
    <Link to="/prompts/$hash" params={{ hash }} className="link mono">
      {label}
    </Link>
  );
}

function CohortRow({ cohort }: { cohort: PromptCohort }) {
  return (
    <tr>
      <td>
        <CohortLabel label={cohort.label} hash={cohort.hash} />
      </td>
      <td className="num">{fmtInt(cohort.requests)}</td>
      <td className="num">{fmtPct(cohort.share * 100)}</td>
      <td className="num">{fmtBytes(Math.round(cohort.meanBytes))}</td>
      <td className="num">{fmtBytes(Math.round(cohort.contribution))}</td>
    </tr>
  );
}

/**
 * The move split into the only two things that can cause it: traffic shifting
 * between prompts of different sizes, and prompts changing size. The two sum to
 * the whole delta, so a large mix number is proof no prompt grew.
 */
function Attribution({ attribution: a }: { attribution: MixAttribution }) {
  const dominant = Math.abs(a.mixBytes) >= Math.abs(a.sizeBytes) ? "mix" : "size";
  return (
    <>
      <p className="muted mix-note">
        {fmtBytes(Math.round(a.priorMeanBytes))} on {a.priorDate} → {fmtBytes(Math.round(a.meanBytes))} on {a.date}, a
        move of <span className={`delta ${tone(a.deltaBytes)}`}>{fmtDelta(a.deltaBytes)}</span>. Of that,{" "}
        <strong>{fmtDelta(a.mixBytes)}</strong> is traffic shifting between prompts and{" "}
        <strong>{fmtDelta(a.sizeBytes)}</strong> is prompts changing size — so this is mostly{" "}
        {dominant === "mix" ? "a change in what ran, not in what was sent" : "prompts themselves getting bigger"}.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Prompt</th>
            <th className="num">Share</th>
            <th className="num">Mix</th>
            <th className="num">Size</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {a.movers.slice(0, TOP_COHORTS).map((m) => (
            <tr key={m.key}>
              <td>
                <CohortLabel label={m.label} hash={hashOfKey(m.key)} />
              </td>
              <td className="num">
                {fmtPct(m.priorShare * 100)} → {fmtPct(m.share * 100)}
              </td>
              <td className="num">{fmtDelta(m.mixBytes)}</td>
              <td className="num">{fmtDelta(m.sizeBytes)}</td>
              <td className={`num delta ${tone(m.deltaBytes)}`}>{fmtDelta(m.deltaBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Section-level detail for a prompt that was replaced between the two days. */
function SectionMoves({ revision }: { revision: PromptRevisionDetail }) {
  const moves = revision.moves.filter((m) => m.deltaBytes !== 0).slice(0, TOP_MOVES);

  return (
    <div className="mix-revision">
      <h3>
        <span className="mono">{revision.model}</span> changed prompt
      </h3>
      <p className="muted mix-note">
        <span className="mono">{revision.priorHash.slice(0, 8)}</span> ({fmtBytes(Math.round(revision.priorMeanBytes))})
        → <span className="mono">{revision.hash.slice(0, 8)}</span> ({fmtBytes(Math.round(revision.meanBytes))}),{" "}
        <span className={`delta ${tone(revision.deltaBytes)}`}>{fmtDelta(revision.deltaBytes)}</span>.
      </p>
      {moves.length === 0 ? (
        <div className="muted">
          {revision.prior && revision.current
            ? "No section changed size — the difference is outside the headings."
            : "No stored outline for one of these prompts, so the sections cannot be compared."}
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Section</th>
              <th className="num">Before</th>
              <th className="num">After</th>
              <th className="num">Change</th>
            </tr>
          </thead>
          <tbody>
            {moves.map((m) => (
              <tr key={m.heading}>
                <td>{m.heading}</td>
                <td className="num">{m.status === "added" ? "—" : fmtBytes(m.priorBytes)}</td>
                <td className="num">{m.status === "removed" ? "—" : fmtBytes(m.bytes)}</td>
                <td className={`num delta ${tone(m.deltaBytes)}`}>{fmtDelta(m.deltaBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
