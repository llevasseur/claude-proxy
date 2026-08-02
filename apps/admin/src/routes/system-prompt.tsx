import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { countLines, estTokens, outlineSystemPrompt, utf8Bytes } from "@claude-proxy/core";
import type { SystemPromptResponse } from "../api";
import { getSystemPrompt, saveSystemPrompt } from "../api";
import { Markdown } from "../components/Markdown";
import { QueryState } from "../components/QueryState";
import { Segmented, type SegmentedOption } from "../components/Segmented";
import { Skeleton, SkeletonStats, SkeletonText } from "../components/Skeleton";
import { fmtBytes, fmtInt, fmtLocalTsShort } from "../format";

/**
 * "System prompt" — `~/.claude/CLAUDE.md`, the device-wide instructions Claude Code
 * loads into every session's system prompt on this machine, and the one page here
 * that writes back to it.
 *
 * A device view, not a traffic one: the proxy never records the system prompt, so
 * the file on disk is the only readable copy. Every byte of it is charged to every
 * request on this device.
 */

const SYSTEM_PROMPT_KEY = ["system-prompt"] as const;

type EditorView = "edit" | "preview";
const EDITOR_VIEWS: readonly SegmentedOption<EditorView>[] = [
  { value: "edit", label: "Edit" },
  { value: "preview", label: "Preview" },
];

export function SystemPromptPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: SYSTEM_PROMPT_KEY, queryFn: getSystemPrompt });
  const prompt = query.data?.prompt;
  const maxBytes = query.data?.maxBytes;

  // null means "untouched" — the editor mirrors the file until the first keystroke,
  // so a refetch can still update it underneath an idle tab.
  const [draft, setDraft] = useState<string | null>(null);
  const [view, setView] = useState<EditorView>("edit");
  const [armedEmpty, setArmedEmpty] = useState(false);
  const [saved, setSaved] = useState<{ modified: string | null; backupPath: string | null } | null>(null);

  const onDisk = prompt?.text ?? "";
  const text = draft ?? onDisk;
  const dirty = draft !== null && draft !== onDisk;

  const bytes = useMemo(() => utf8Bytes(text), [text]);
  const sections = useMemo(() => outlineSystemPrompt(text), [text]);
  const lines = countLines(text);
  const tooLong = maxBytes !== undefined && bytes > maxBytes;
  // Emptying the prompt is unrecoverable from this page, so it takes a second click
  // the way the job delete does.
  const clearsPrompt = text.trim() === "" && onDisk.trim() !== "";

  const save = useMutation({
    mutationFn: () => saveSystemPrompt(text),
    onSuccess: (res) => {
      // The response is a fresh read of the file, so seeding beats refetching.
      client.setQueryData<SystemPromptResponse>(SYSTEM_PROMPT_KEY, { prompt: res.prompt, maxBytes: res.maxBytes });
      setDraft(null);
      setArmedEmpty(false);
      setSaved({ modified: res.prompt.modified, backupPath: res.backupPath });
    },
  });

  const submit = () => {
    if (!dirty || tooLong || save.isPending) return;
    if (clearsPrompt && !armedEmpty) {
      setArmedEmpty(true);
      return;
    }
    save.mutate();
  };

  return (
    <section>
      <div className="pagehead">
        <h1>System prompt</h1>
        <div className="muted">
          The device-wide instructions at <span className="rule-name">{prompt?.path ?? "~/.claude/CLAUDE.md"}</span> —
          loaded into every Claude Code session on this machine.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="leak-note">
          <strong>This page writes to disk.</strong> Saving replaces the file, keeping the previous contents in a{" "}
          <span className="rule-name">.bak</span> beside it. Sessions read it at startup, so a running session keeps the
          text it launched with — the change lands on the next one. Every byte here ships with{" "}
          <em>every request</em> on this device.
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error} skeleton={<SystemPromptSkeleton />}>
        {prompt && (
          <>
            <div className="grid stats">
              <StatTile
                label="Size"
                value={fmtBytes(bytes)}
                sub={dirty ? `${fmtBytes(prompt.bytes)} on disk` : undefined}
              />
              <StatTile label="Est. tokens" value={fmtInt(estTokens(bytes))} sub="per request" />
              <StatTile label="Lines" value={fmtInt(lines)} sub={`${fmtInt(sections.length)} sections`} />
              <StatTile
                label="Modified"
                value={prompt.modified ? fmtLocalTsShort(prompt.modified) : "—"}
                sub={prompt.exists ? undefined : "no file yet"}
              />
            </div>

            {!prompt.exists && (
              <div className="card empty" style={{ marginBottom: 16 }}>
                No <span className="rule-name">{prompt.path}</span> on this device yet — saving creates it.
              </div>
            )}

            <div className="card">
              <div className="card-head">
                <h2>Device system prompt</h2>
                <Segmented options={EDITOR_VIEWS} value={view} onSelect={setView} label="Editor view" />
              </div>

              {view === "edit" ? (
                <textarea
                  className="sysprompt-editor"
                  value={text}
                  spellCheck={false}
                  aria-label="Device system prompt"
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setArmedEmpty(false);
                    setSaved(null);
                  }}
                  onKeyDown={(e) => {
                    // ⌘S / Ctrl-S saves.
                    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
              ) : text.trim() === "" ? (
                <div className="empty">Nothing to preview — the prompt is empty.</div>
              ) : (
                <div className="memory-pretty">
                  <Markdown source={text} />
                </div>
              )}

              <div className="sysprompt-actions">
                <div className="sysprompt-state">
                  {tooLong && maxBytes !== undefined ? (
                    <span className="sysprompt-error">
                      {fmtBytes(bytes)} is over the {fmtBytes(maxBytes)} ceiling — trim it before saving.
                    </span>
                  ) : dirty ? (
                    <span className="muted">Unsaved changes.</span>
                  ) : saved ? (
                    <span className="muted">
                      Saved{saved.modified ? ` at ${fmtLocalTsShort(saved.modified)}` : ""}
                      {saved.backupPath && (
                        <>
                          {" "}
                          — previous contents kept in <span className="rule-name">{saved.backupPath}</span>
                        </>
                      )}
                      .
                    </span>
                  ) : (
                    <span className="muted">In sync with the file.</span>
                  )}
                </div>
                <div className="sysprompt-buttons">
                  <button
                    type="button"
                    className="link"
                    disabled={!dirty || save.isPending}
                    onClick={() => {
                      setDraft(null);
                      setArmedEmpty(false);
                    }}
                  >
                    Revert
                  </button>
                  <button
                    type="button"
                    className={armedEmpty ? "btn-danger armed" : "btn-save"}
                    disabled={!dirty || tooLong || save.isPending}
                    onClick={submit}
                  >
                    {save.isPending
                      ? "Saving…"
                      : armedEmpty
                        ? "Clear the prompt?"
                        : clearsPrompt
                          ? "Save (empties it)"
                          : "Save"}
                  </button>
                </div>
              </div>

              {save.error && <div className="sysprompt-error">Save failed — {(save.error as Error).message}</div>}
            </div>
          </>
        )}
      </QueryState>
    </section>
  );
}

/** Four tiles over the editor card. */
function SystemPromptSkeleton() {
  return (
    <>
      <SkeletonStats count={4} />
      <div className="card">
        <div className="card-head">
          <Skeleton w="22%" h="0.95em" />
          <Skeleton w="7rem" />
        </div>
        <SkeletonText lines={12} />
      </div>
    </>
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
