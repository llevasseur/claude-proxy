import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { RequestToolDetail } from "@claude-proxy/core";
import { getContextTool } from "../api";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { QueryState } from "../components/QueryState";
import { fmtBytes, fmtInt } from "../format";

export function ContextToolPage() {
  const { file, index } = useParams({ from: "/context/$file/tool/$index" });
  const idx = Number(index);
  const query = useQuery({
    queryKey: ["context-tool", file, idx],
    queryFn: () => getContextTool(file, idx),
  });
  const tool = query.data?.tool;

  return (
    <section>
      <Breadcrumbs>
        <Link to="/context" className="link">
          Context size
        </Link>
        <Link to="/context/$file" params={{ file }} className="link">
          Request breakdown
        </Link>
        <span className="crumb-current">Tool #{index}</span>
      </Breadcrumbs>
      <div className="pagehead">
        <h1>Tool #{index}</h1>
      </div>
      <div className="muted" style={{ marginBottom: "0.75rem", wordBreak: "break-all" }}>{file}</div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {tool && <ToolBody tool={tool} />}
      </QueryState>
    </section>
  );
}

function ToolBody({ tool: t }: { tool: RequestToolDetail }) {
  const [view, setView] = useState<"pretty" | "raw">("pretty");

  return (
    <>
      <div className="grid stats">
        <StatTile label="Position" value={`#${t.index}`} sub={`of ${t.toolCount} tools`} />
        <StatTile label="Name" value={t.name} />
        <StatTile label="Size" value={fmtBytes(t.bytes)} sub={`~${fmtInt(t.estTokens)} tokens`} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Tool schema</h2>
          <div className="segmented">
            <button className={view === "pretty" ? "active" : ""} onClick={() => setView("pretty")}>
              Pretty
            </button>
            <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>
              Raw
            </button>
          </div>
        </div>
        {view === "pretty" ? <PrettyTool content={t.content} /> : <pre className="rawjson wrap">{t.content}</pre>}
      </div>
    </>
  );
}

/** A loosely-typed tool schema, since request bodies are untrusted. */
type Schema = Record<string, unknown>;

/**
 * Render the stored tool JSON as readable sections — name, description, and a
 * parameter list drawn from its input schema. Falls back to raw JSON on an
 * unexpected shape.
 */
function PrettyTool({ content }: { content: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return <pre className="rawjson wrap">{content}</pre>;
  }
  if (typeof parsed !== "object" || parsed === null) return <pre className="rawjson wrap">{content}</pre>;

  const tool = parsed as Schema;
  const description = str(tool.description);
  // Anthropic tools carry `input_schema`; be tolerant of a plain `parameters` too.
  const schema = (tool.input_schema ?? tool.parameters) as Schema | undefined;
  const params = paramRows(schema);

  return (
    <div className="msg-blocks">
      <Section label="Name">
        <Prose text={str(tool.name) || "(unnamed)"} />
      </Section>

      {description && (
        <Section label="Description">
          <Prose text={description} />
        </Section>
      )}

      {params.length > 0 ? (
        <Section label="Parameters">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {params.map((p) => (
                <tr key={p.name}>
                  <td>
                    {p.name}
                    {p.required && <span className="msg-badge">required</span>}
                  </td>
                  <td className="muted">{p.type}</td>
                  <td>{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : (
        schema && (
          <Section label="Input schema">
            <pre className="rawjson wrap">{stringify(schema)}</pre>
          </Section>
        )
      )}
    </div>
  );
}

interface ParamRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** Flatten a JSON-schema `properties` map into displayable parameter rows. */
function paramRows(schema: Schema | undefined): ParamRow[] {
  if (!schema || typeof schema !== "object") return [];
  const props = schema.properties;
  if (typeof props !== "object" || props === null) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : []);

  return Object.entries(props as Record<string, unknown>).map(([name, raw]) => {
    const spec = (typeof raw === "object" && raw !== null ? raw : {}) as Schema;
    return {
      name,
      type: schemaType(spec),
      required: required.has(name),
      description: str(spec.description),
    };
  });
}

/** Best-effort human type label for a schema property. */
function schemaType(spec: Schema): string {
  if (typeof spec.type === "string") {
    if (spec.type === "array") {
      const items = (typeof spec.items === "object" && spec.items !== null ? spec.items : {}) as Schema;
      const itemType = typeof items.type === "string" ? items.type : "";
      return itemType ? `array<${itemType}>` : "array";
    }
    return spec.type;
  }
  if (Array.isArray(spec.enum)) return "enum";
  if (Array.isArray(spec.anyOf) || Array.isArray(spec.oneOf)) return "union";
  return "—";
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="msg-block">
      <div className="msg-block-head">
        <span className="msg-block-label">{label}</span>
      </div>
      {children}
    </div>
  );
}

/** Wrapped, newline-preserving prose for text-ish values. */
function Prose({ text }: { text: string }) {
  return <div className="msg-text">{text}</div>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
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
