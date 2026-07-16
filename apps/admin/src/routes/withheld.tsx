import { useQuery } from "@tanstack/react-query";
import { getWithheld } from "../api";
import { QueryState } from "../components/QueryState";
import { fmtInt } from "../format";

const WINDOW_DAYS = 14;

/** `2026-07-16T14:35:00.123Z` → `07-16 14:35` (UTC, compact). */
const shortTs = (iso: string): string => (iso ? iso.slice(5, 16).replace("T", " ") : "—");

/**
 * "Not added" — the tools this device withholds from every Claude Code request.
 * A bare tool name in `~/.claude/settings.json` → `permissions.deny` removes that
 * tool's schema from Claude's context entirely, so it never reaches the model
 * (and costs no tokens per turn). This page lists those rules and checks, against
 * recently-routed traffic, that each withheld tool is actually gone.
 */
export function WithheldPage() {
  const query = useQuery({ queryKey: ["withheld", WINDOW_DAYS], queryFn: () => getWithheld(WINDOW_DAYS) });
  const data = query.data;
  const report = data?.report;
  const rules = report?.rules ?? [];
  const stillPresent = report?.rulesStillPresent ?? 0;
  const wasPresent = report?.rulesWasPresent ?? 0;

  return (
    <section>
      <div className="pagehead">
        <h1>Not added</h1>
        <div className="muted">
          Tools withheld device-wide — their schemas never reach the model, saving those tokens every turn.
        </div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        {!data?.settingsReadable ? (
          <div className="card empty">
            Couldn't read device settings at <span className="rule-name">{data?.settingsPath}</span>. Nothing withheld.
          </div>
        ) : rules.length === 0 ? (
          <div className="card empty">
            No schema-stripping deny rules in <span className="rule-name">{data.settingsPath}</span>. Add bare tool
            names to <span className="rule-name">permissions.deny</span> to withhold them device-wide.
          </div>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="muted">
                <strong>{rules.length}</strong> tool rule{rules.length === 1 ? "" : "s"} withheld via{" "}
                <span className="rule-name">{data.settingsPath}</span> · checked against{" "}
                <strong>{fmtInt(report!.requestsSampled)}</strong> request
                {report!.requestsSampled === 1 ? "" : "s"} over the last {data.meta.days} days.{" "}
                {stillPresent > 0 && <span className="badge present">{stillPresent} still present</span>}{" "}
                {wasPresent > 0 && <span className="badge was-present">{wasPresent} was present</span>}{" "}
                {stillPresent === 0 && wasPresent === 0 && <span className="badge absent">all absent</span>}
              </div>
              {(stillPresent > 0 || wasPresent > 0) && (
                <div className="leak-note" style={{ marginTop: 8 }}>
                  <strong>Still present</strong> = the tool was in the most recent captured request, so it's still
                  reaching the model right now (a session that predates the rule is still open, or the name doesn't
                  match — check spelling and settings precedence). <strong>Was present</strong> = only in older
                  requests: pre-config history aging out of the window, not live.
                </div>
              )}
            </div>

            <div className="card">
              <table className="table">
                <thead>
                  <tr>
                    <th>Deny rule</th>
                    <th>Match</th>
                    <th>Status (last {data.meta.days}d)</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.rule}>
                      <td className="rule-name">{r.rule}</td>
                      <td>
                        <span className={`badge ${r.isGlob ? "sev-info" : "neutral"}`}>
                          {r.isGlob ? "glob" : "exact"}
                        </span>
                      </td>
                      <td>
                        {r.status === "absent" ? (
                          <span className="badge absent">absent</span>
                        ) : (
                          <>
                            <span className={`badge ${r.status === "still-present" ? "present" : "was-present"}`}>
                              {r.status === "still-present" ? "still present" : "was present"}
                            </span>{" "}
                            <span className="leak-note">
                              {r.observed.map((t, i) => (
                                <span key={t.name}>
                                  {i > 0 ? ", " : ""}
                                  <span className={r.status === "still-present" ? "present-tool" : "was-tool"}>
                                    {t.name}
                                  </span>{" "}
                                  ×{fmtInt(t.occurrences)} (last seen {shortTs(t.lastSeen)})
                                </span>
                              ))}
                            </span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {report!.scopedRules.length > 0 && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="muted">
                  <strong>Scoped deny rules</strong> (block calls but still send the schema — no token savings):
                </div>
                <ul className="minilist">
                  {report!.scopedRules.map((s) => (
                    <li key={s} className="rule-name">
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </QueryState>
    </section>
  );
}
