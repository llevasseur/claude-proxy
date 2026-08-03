import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import type { SectionShare } from "@claude-proxy/core";
import { getPromptDetail, type PromptDayUsage, type PromptDetailResponse } from "../api";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { QueryState } from "../components/QueryState";
import { DAY_WINDOWS, Segmented } from "../components/Segmented";
import { type SkeletonColumn, SkeletonTableCard } from "../components/Skeleton";
import { fmtBytes, fmtInt, fmtPct } from "../format";
import { REPORT_TZ_ABBR } from "../metrics";
import { useTransitionState } from "../useTransitionState";

const SECTION_COLUMNS: readonly SkeletonColumn[] = [{}, { className: "num" }, { className: "num" }, { className: "num" }];
const USAGE_COLUMNS: readonly SkeletonColumn[] = [
  {},
  { className: "num" },
  { className: "num" },
  { className: "num" },
  { className: "num" },
];

type SortKey = "heading" | "level" | "bytes" | "share";
type SortDir = "asc" | "desc";

/** Direction applied the first time a column becomes the sort key. */
const DEFAULT_DIR: Record<SortKey, SortDir> = { heading: "asc", level: "asc", bytes: "desc", share: "desc" };

/**
 * Signed comparison for a column, ascending. `share` and `bytes` order
 * identically; they are separate keys so clicking one moves the arrow off the
 * other.
 */
function compare(a: SectionShare, b: SectionShare, key: SortKey): number {
  switch (key) {
    case "heading":
      return a.heading.localeCompare(b.heading);
    case "level":
      return a.level - b.level;
    default:
      return a.bytes - b.bytes;
  }
}

/** One system prompt from the mix: the sections its bytes sit in, and the days it ran. */
export function PromptDetailPage() {
  const { hash } = useParams({ from: "/prompts/$hash" });
  const [days, selectDays, isSwitching] = useTransitionState(30);
  const query = useQuery({
    queryKey: ["prompt-detail", hash, days],
    queryFn: () => getPromptDetail(hash, days),
    placeholderData: keepPreviousData,
  });
  const detail = query.data;
  const busy = isSwitching || query.isFetching;

  return (
    <section>
      <Breadcrumbs>
        <Link to="/trends" className="link">
          Trends
        </Link>
        <Link to="/trends/$metric" params={{ metric: "avg-system-prompt" }} className="link">
          Avg system prompt
        </Link>
        <span className="crumb-current mono">{hash.slice(0, 8)}</span>
      </Breadcrumbs>

      <div className="pagehead">
        <div>
          <h1 className="mono">{detail?.label ?? hash.slice(0, 8)}</h1>
          <div className="muted">Every section of this system prompt, largest share of it first.</div>
        </div>
        <Segmented options={DAY_WINDOWS} value={days} onSelect={selectDays} label="Window" busy={busy} />
      </div>

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        skeleton={<PromptDetailSkeleton days={days} />}
        busy={busy}
      >
        {detail && (
          <div className="grid wide-two">
            <div className="card">
              <div className="card-head">
                <h2>What it is made of</h2>
                <span className="muted">click a column to sort</span>
              </div>
              <Preface detail={detail} />
              {detail.outline ? (
                <SectionTable sections={detail.sections} />
              ) : (
                <div className="empty">
                  No stored outline for this prompt — it ran before the proxy started recording them, so only its size
                  is known.
                </div>
              )}
            </div>

            <div className="card">
              <h2>What it does to the mean</h2>
              {detail.usage.length === 0 ? (
                <div className="empty">No request in the last {days} days sent this prompt.</div>
              ) : (
                <UsageTable usage={detail.usage} />
              )}
            </div>
          </div>
        )}
      </QueryState>
    </section>
  );
}

/** The prompt's own size, stated before the table that splits it up. */
function Preface({ detail }: { detail: PromptDetailResponse }) {
  const latest = detail.usage.at(-1);
  const models = detail.models.length > 0 ? detail.models.join(", ") : "no model in this window";
  return (
    <p className="muted mix-note">
      <strong>{fmtBytes(detail.outline?.bytes ?? Math.round(latest?.meanBytes ?? 0))}</strong> on the wire, sent by{" "}
      {models}
      {detail.outline && (
        <>
          {" "}
          across <strong>{fmtInt(detail.outline.blocks.length)}</strong> block
          {detail.outline.blocks.length === 1 ? "" : "s"} and <strong>{fmtInt(detail.sections.length)}</strong> sections
        </>
      )}
      .
      {latest && (
        <>
          {" "}
          On {latest.date} it was <strong>{fmtPct(latest.share * 100)}</strong> of the day's requests and{" "}
          <strong>{fmtBytes(Math.round(latest.contribution))}</strong> of that day's{" "}
          {fmtBytes(Math.round(latest.dayMeanBytes))} mean.
        </>
      )}
    </p>
  );
}

function SectionTable({ sections }: { sections: SectionShare[] }) {
  const [sort, setSort, isSorting] = useTransitionState<{ key: SortKey; dir: SortDir }>({ key: "share", dir: "desc" });
  const max = Math.max(1, ...sections.map((s) => s.bytes));

  const sorted = useMemo(() => {
    const rows = [...sections];
    rows.sort((a, b) => {
      const diff = compare(a, b, sort.key);
      return sort.dir === "asc" ? diff : -diff;
    });
    return rows;
  }, [sections, sort]);

  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] },
    );

  return (
    <table className={isSorting ? "table is-stale" : "table"} aria-busy={isSorting || undefined}>
      <thead>
        <tr>
          <SortHeader label="Section" sortKey="heading" sort={sort} onSort={onSort} />
          <SortHeader label="Depth" sortKey="level" sort={sort} onSort={onSort} className="num" />
          <SortHeader label="Size" sortKey="bytes" sort={sort} onSort={onSort} className="num" />
          <SortHeader label="Share" sortKey="share" sort={sort} onSort={onSort} className="num" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => (
          <tr key={s.heading}>
            <td>
              <span className="section-heading" style={{ paddingLeft: `${Math.max(0, s.level - 1) * 12}px` }}>
                {s.heading}
              </span>
            </td>
            <td className="num muted">{s.level === 0 ? "—" : `H${s.level}`}</td>
            <td className="num">{fmtBytes(s.bytes)}</td>
            <td className="num share-cell">
              <div className="rowbar" style={{ width: `${(s.bytes / max) * 100}%` }} />
              <span>{fmtPct(s.share * 100, 1)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every day of the window this prompt ran, newest first. */
function UsageTable({ usage }: { usage: PromptDayUsage[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Date ({REPORT_TZ_ABBR})</th>
          <th className="num">Requests</th>
          <th className="num">Share</th>
          <th className="num">Size</th>
          <th className="num">Of the mean</th>
        </tr>
      </thead>
      <tbody>
        {[...usage].reverse().map((u) => (
          <tr key={u.date}>
            <td>{u.date}</td>
            <td className="num">{fmtInt(u.requests)}</td>
            <td className="num">{fmtPct(u.share * 100)}</td>
            <td className="num">{fmtBytes(Math.round(u.meanBytes))}</td>
            <td className="num">
              {fmtBytes(Math.round(u.contribution))}{" "}
              <span className="muted">of {fmtBytes(Math.round(u.dayMeanBytes))}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={["sortable", className].filter(Boolean).join(" ")}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(sortKey)}
    >
      {label}
      {active && <span className="sort-arrow">{sort.dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}

/** Mirrors the loaded two-up grid; one usage row per day of the window. */
function PromptDetailSkeleton({ days }: { days: number }) {
  return (
    <div className="grid wide-two">
      <SkeletonTableCard title="What it is made of" columns={SECTION_COLUMNS} rows={12} />
      <SkeletonTableCard title="What it does to the mean" columns={USAGE_COLUMNS} rows={days} />
    </div>
  );
}
