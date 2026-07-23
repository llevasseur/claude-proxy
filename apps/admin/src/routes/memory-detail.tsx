import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { MemoryDetail } from "../api";
import { getMemory } from "../api";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Markdown } from "../components/Markdown";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtLocalTsShort } from "../format";

export function MemoryDetailPage() {
  const { project, name } = useParams({ from: "/projects/$project/memory/$name" });
  const query = useQuery({
    queryKey: ["memory", project, name],
    queryFn: () => getMemory(project, name),
  });
  const memory = query.data?.memory;

  return (
    <section>
      <Breadcrumbs>
        <Link to="/projects" className="link">
          Projects
        </Link>
        <Link to="/projects/$project" params={{ project }} className="link">
          Project memories
        </Link>
        <span className="crumb-current">{name}</span>
      </Breadcrumbs>
      <div className="pagehead">
        <h1>{name}</h1>
      </div>
      <div className="muted mono-break" style={{ marginBottom: "0.75rem" }}>
        {project}
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {memory && <MemoryBody memory={memory} />}
      </QueryState>
    </section>
  );
}

function MemoryBody({ memory }: { memory: MemoryDetail }) {
  const [view, setView] = useState<"pretty" | "raw">("pretty");
  const { frontmatter, body } = splitFrontmatter(memory.content);

  return (
    <>
      <div className="grid stats">
        <StatTile label="Size" value={fmtBytes(memory.bytes)} />
        <StatTile label="Modified" value={fmtLocalTsShort(memory.modified)} />
        {frontmatter?.type && <StatTile label="Type" value={frontmatter.type} />}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Memory</h2>
          <div className="segmented">
            <button className={view === "pretty" ? "active" : ""} onClick={() => setView("pretty")}>
              Pretty
            </button>
            <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>
              Raw
            </button>
          </div>
        </div>
        {view === "pretty" ? (
          <div className="memory-pretty">
            {frontmatter && <Frontmatter fm={frontmatter} />}
            <Markdown source={body} />
          </div>
        ) : (
          <pre className="rawjson wrap">{memory.content}</pre>
        )}
      </div>
    </>
  );
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  /** All top-level scalar key: value pairs parsed. */
  fields: { key: string; value: string }[];
}

/**
 * Split a leading YAML-ish `--- … ---` frontmatter block off the body. Reads
 * only a shallow subset: top-level `key: value` plus a nested `metadata.type`.
 */
function splitFrontmatter(content: string): { frontmatter: ParsedFrontmatter | null; body: string } {
  const text = content.replace(/^﻿/, "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { frontmatter: null, body: text };

  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: text };

  const block = text.slice(text.indexOf("\n") + 1, end);
  const rest = text.slice(end + 4).replace(/^\r?\n/, "");

  const fields: { key: string; value: string }[] = [];
  let type: string | undefined;
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1] ?? "";
    const key = m[2] ?? "";
    const clean = (m[3] ?? "").trim().replace(/^["']|["']$/g, "");
    if (key === "type" && indent.length > 0) type = clean; // metadata.type
    if (indent.length === 0 && clean) fields.push({ key, value: clean });
  }

  const get = (k: string) => fields.find((f) => f.key === k)?.value;
  return {
    frontmatter: { name: get("name"), description: get("description"), type, fields },
    body: rest,
  };
}

function Frontmatter({ fm }: { fm: ParsedFrontmatter }) {
  const rows = fm.fields.filter((f) => f.value);
  if (rows.length === 0 && !fm.type) return null;
  return (
    <dl className="fm">
      {rows.map((f) => (
        <Fragment key={f.key}>
          <dt>{f.key}</dt>
          <dd>{f.value}</dd>
        </Fragment>
      ))}
      {fm.type && (
        <Fragment key="metadata.type">
          <dt>type</dt>
          <dd>{fm.type}</dd>
        </Fragment>
      )}
    </dl>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">{sub && <span className="muted">{sub}</span>}</div>
    </div>
  );
}
