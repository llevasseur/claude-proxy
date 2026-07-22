import { useQuery } from "@tanstack/react-query";
import { getWithheld } from "../api";
import { QueryState } from "../components/QueryState";
import { fmtInt, fmtLocalTsShort, LOCAL_TZ_ABBR } from "../format";

const WINDOW_DAYS = 14;

/**
 * "Not added" — the tools this device withholds from every Claude Code request.
 * Three mechanisms strip a tool's schema so it never reaches the model (and costs
 * no tokens per turn), and this page reports all three:
 *   - a bare tool name in `~/.claude/settings.json` → `permissions.deny`,
 *   - a boolean `disable*` setting (e.g. `disableWorkflows` → the Workflow tool), and
 *   - a `claude*` shell launch alias passing `--disallowedTools`.
 * The first two are checked against recently-routed traffic to confirm the tool is
 * gone; launch aliases are declarative (their flags never reach the proxy).
 */
export function WithheldPage() {
  const query = useQuery({ queryKey: ["withheld", WINDOW_DAYS], queryFn: () => getWithheld(WINDOW_DAYS) });
  const data = query.data;
  const report = data?.report;
  const rules = report?.rules ?? [];
  const disableSchema = report?.disableSchema ?? [];
  const scopedRules = report?.scopedRules ?? [];
  const stillPresent = report?.rulesStillPresent ?? 0;
  const wasPresent = report?.rulesWasPresent ?? 0;
  const disableStillPresent = report?.disableStillPresent ?? 0;
  const disableWasPresent = report?.disableWasPresent ?? 0;
  const nothingWithheld = rules.length === 0 && disableSchema.length === 0 && scopedRules.length === 0;
  const launch = data?.launchAliases;
  const launchAliases = launch?.aliases ?? [];
  const posture = launch?.posture;
  const postureCols = posture?.columns ?? [];
  const postureAliases = posture?.aliases ?? [];

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
        ) : nothingWithheld ? (
          <div className="card empty">
            No schema-stripping deny rules or <span className="rule-name">disable*</span> settings in{" "}
            <span className="rule-name">{data.settingsPath}</span>. Add bare tool names to{" "}
            <span className="rule-name">permissions.deny</span>, or turn on a <span className="rule-name">disable*</span>{" "}
            setting, to withhold tools device-wide.
          </div>
        ) : (
          <>
            {rules.length > 0 && (
              <>
                <div className="card" style={{ marginBottom: 16 }}>
                  <div className="muted">
                    <strong>{rules.length}</strong> deny rule{rules.length === 1 ? "" : "s"} withheld via{" "}
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
                                      ×{fmtInt(t.occurrences)} (last seen {fmtLocalTsShort(t.lastSeen)} {LOCAL_TZ_ABBR})
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
              </>
            )}

            {disableSchema.length > 0 && (
              <div className="card" style={{ marginTop: rules.length > 0 ? 16 : 0 }}>
                <div className="muted">
                  <strong>{disableSchema.length}</strong> disable setting{disableSchema.length === 1 ? "" : "s"}{" "}
                  withhold{disableSchema.length === 1 ? "s" : ""} tool schemas via{" "}
                  <span className="rule-name">{data.settingsPath}</span> · checked against{" "}
                  <strong>{fmtInt(report!.requestsSampled)}</strong> request
                  {report!.requestsSampled === 1 ? "" : "s"} over the last {data.meta.days} days.{" "}
                  {disableStillPresent > 0 && (
                    <span className="badge present">{disableStillPresent} still present</span>
                  )}{" "}
                  {disableWasPresent > 0 && <span className="badge was-present">{disableWasPresent} was present</span>}{" "}
                  {disableStillPresent === 0 && disableWasPresent === 0 && (
                    <span className="badge absent">all absent</span>
                  )}
                </div>
                <div className="leak-note" style={{ marginTop: 8 }}>
                  Boolean <span className="rule-name">disable*</span> settings drop a tool's schema from every request —
                  the same token savings as a bare deny rule, but with no{" "}
                  <span className="rule-name">permissions.deny</span> entry. Toggling one off restores the tool.
                </div>
                <table className="table" style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>Disable setting</th>
                      <th>Withholds</th>
                      <th>Status (last {data.meta.days}d)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {disableSchema.map((d) => (
                      <tr key={d.key}>
                        <td className="rule-name">{d.key}</td>
                        <td>
                          {d.tools.map((t, i) => (
                            <span key={t}>
                              {i > 0 ? ", " : ""}
                              <span className="rule-name">{t}</span>
                            </span>
                          ))}
                        </td>
                        <td>
                          {d.status === "absent" ? (
                            <span className="badge absent">absent</span>
                          ) : (
                            <>
                              <span className={`badge ${d.status === "still-present" ? "present" : "was-present"}`}>
                                {d.status === "still-present" ? "still present" : "was present"}
                              </span>{" "}
                              <span className="leak-note">
                                {d.observed.map((t, i) => (
                                  <span key={t.name}>
                                    {i > 0 ? ", " : ""}
                                    <span className={d.status === "still-present" ? "present-tool" : "was-tool"}>
                                      {t.name}
                                    </span>{" "}
                                    ×{fmtInt(t.occurrences)} (last seen {fmtLocalTsShort(t.lastSeen)} {LOCAL_TZ_ABBR})
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
            )}

            {scopedRules.length > 0 && (
              <div className="card" style={{ marginTop: 16 }}>
                <div className="muted">
                  <strong>Scoped deny rules</strong> (block calls but still send the schema — no token savings):
                </div>
                <ul className="minilist">
                  {scopedRules.map((s) => (
                    <li key={s} className="rule-name">
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {launch && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="muted">
              <strong>Launch aliases</strong> — <span className="rule-name">claude*</span> shell aliases and their{" "}
              <em>net effective</em> tool posture, read from <span className="rule-name">{launch.rcPath}</span>. Each
              cell is <strong>on</strong> (schema reaches the model) or <strong>off</strong> (withheld), computed from
              how the alias's <span className="rule-name">--disallowedTools</span>,{" "}
              <span className="rule-name">--setting-sources</span>, and <span className="rule-name">--settings</span>{" "}
              flags compose with this device's deny list.
            </div>
            <div className="leak-note" style={{ marginTop: 8 }}>
              Computed, not traffic-verified: launch flags never reach the proxy, so — unlike deny rules — this is
              derived from settings precedence rather than checked against captured requests (which alias started a
              session isn't visible to the proxy). Note that <span className="rule-name">--setting-sources</span> that
              drops the <span className="rule-name">user</span> source stops the whole device{" "}
              <span className="rule-name">settings.json</span> from loading, so its deny list, plugins, and hooks all
              fall away — see each alias's note.
            </div>
            {!launch.rcReadable ? (
              <div className="leak-note" style={{ marginTop: 8 }}>
                Couldn't read <span className="rule-name">{launch.rcPath}</span>.
              </div>
            ) : launchAliases.length === 0 ? (
              <div className="leak-note" style={{ marginTop: 8 }}>
                No <span className="rule-name">claude*</span> launch aliases found in{" "}
                <span className="rule-name">{launch.rcPath}</span>.
              </div>
            ) : postureCols.length > 0 ? (
              <table className="table" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>Alias</th>
                    {postureCols.map((c) => (
                      <th key={c} className="rule-name">
                        {c}
                      </th>
                    ))}
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {postureAliases.map((a) => (
                    <tr key={a.name}>
                      <td className="rule-name">{a.name}</td>
                      {postureCols.map((c) => (
                        <td key={c}>
                          {a.cells[c] ? (
                            <span className="badge absent">off</span>
                          ) : (
                            <span className="badge present">on</span>
                          )}
                        </td>
                      ))}
                      <td>
                        {a.userSettingsLoaded ? (
                          <span className="muted">user settings loaded</span>
                        ) : (
                          <>
                            <span className="badge was-present">skips user settings</span>
                            {a.alsoReenabled.length > 0 && (
                              <span className="leak-note" title={a.alsoReenabled.join(", ")}>
                                {" "}
                                also re-enables {a.alsoReenabled.slice(0, 3).join(", ")}
                                {a.alsoReenabled.length > 3 ? ` +${a.alsoReenabled.length - 3} more` : ""}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="table" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>Alias</th>
                    <th>Withholds (effective)</th>
                  </tr>
                </thead>
                <tbody>
                  {postureAliases.map((a) => (
                    <tr key={a.name}>
                      <td className="rule-name">{a.name}</td>
                      <td>
                        {a.withheld.length === 0 ? (
                          <span className="muted">nothing</span>
                        ) : (
                          a.withheld.map((t, i) => (
                            <span key={t}>
                              {i > 0 ? ", " : ""}
                              <span className="rule-name">{t}</span>
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </QueryState>
    </section>
  );
}
