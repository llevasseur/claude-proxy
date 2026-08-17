import type {
  Advice,
  AdviceMovement,
  AgentTypeUsage,
  AliasLoadExpectation,
  ApiJsonGetPath,
  ApiQueryValue,
  ApiRouteParam,
  ApiWritePath,
  AuditSidecar,
  BranchLiveness,
  BucketBreakdownSummary,
  BucketJudgementState,
  CliFunctionEntry,
  CommandPatternId,
  CommandRun,
  CommandRunOutcome,
  CommandRunProfile,
  CommandRunTotals,
  CommandStep,
  CommandSummary,
  ContextAggregates,
  ContextEntry,
  HookRow,
  IdeaAreaCounts,
  IdeaClaimRefusal,
  IdeaClaimRequest,
  IdeaComment,
  IdeaEntry,
  IdeaFiling,
  IdeaMark,
  IdeaStatus,
  InterruptionKind,
  JobFileKind,
  JobStateFields,
  JobTreeNode,
  LaunchAlias,
  LaunchAliasPosture,
  LinkedSessionError,
  MainHistoryGraph,
  MixAttribution,
  PatternFrequency,
  PluginRow,
  PromptMixDay,
  PromptRevision,
  ProxyFilterEntry,
  PrSessionLink,
  PullRequestRow,
  RequestBreakdown,
  RequestMessageDetail,
  RequestToolDetail,
  SectionMove,
  SectionShare,
  SessionAgentLink,
  SessionBucket,
  SessionContextPeak,
  SessionMeta,
  SessionNode,
  SessionSuggestion,
  SkimDigest,
  SkimKeyTotals,
  StepReach,
  StoredWirePrompt,
  SuggestionRecurrence,
  SuggestionStatus,
  SuggestionStatusRow,
  SuggestionStatusUpdate,
  SystemPromptDoc,
  TopTool,
  UsageDigest,
  UsageLimitsSnapshot,
  WithheldReport,
} from '@claude-proxy/core';
import { apiRouteUrl } from '@claude-proxy/core';
import { errorMessage, type JsonRecord, readJsonBody } from './json';

// SAFETY: Vite types every key of `import.meta.env` it does not know about through an
// `any` index signature, so this narrows rather than widens. Vite substitutes the literal
// text of `VITE_API_BASE` at build time, leaving exactly two outcomes — the string that
// was in `.env`, or the key absent.
const configuredApiBase = import.meta.env.VITE_API_BASE as string | undefined;

export const API_BASE = configuredApiBase ?? 'http://localhost:8788';

// HTTP envelopes — mirror the shapes returned by the server package.
export interface SummaryResponse {
  digest: UsageDigest;
  advice: Advice[];
  /** Whether each piece of advice's metric moved since the last day that recorded it. */
  movement: AdviceMovement[];
  meta: { date: string; files: number; parseErrors: number };
}
/** The 5-hour / weekly / weekly-Fable meters, as of the newest captured request. */
export interface UsageResponse {
  usage: UsageLimitsSnapshot;
  meta: { files: number; parseErrors: number };
}
export interface TrendsResponse {
  digests: UsageDigest[];
  /** `unfilterableDays` counts days a model filter had to drop — finalized digests cannot be split by model. */
  meta: { days: number; files: number; parseErrors: number; archivedDays: number; unfilterableDays: number };
}
export interface ToolsResponse {
  date: string;
  topTools: TopTool[];
  meta: { files: number; parseErrors: number };
}
/** One prompt swapped for another, with the sections that moved. */
export interface PromptRevisionDetail extends PromptRevision {
  prior: StoredWirePrompt | null;
  current: StoredWirePrompt | null;
  moves: SectionMove[];
}
/** The cohorts behind `avgSystemPromptBytes`, and what moved it day over day. */
export interface PromptMixResponse {
  days: PromptMixDay[];
  attribution: MixAttribution | null;
  revisions: PromptRevisionDetail[];
  /** Present while the newest day is still running, so its mean is incomplete. */
  partial: { date: string; elapsed: number } | null;
  meta: { days: number; files: number; parseErrors: number; archivedDays: number; outlinesFound: number };
}
/** One day a prompt ran, and its slice of that day's mean. */
export interface PromptDayUsage {
  date: string;
  requests: number;
  share: number;
  meanBytes: number;
  contribution: number;
  dayMeanBytes: number;
}
/** One cohort from the mix, opened up into the sections its bytes sit in. */
export interface PromptDetailResponse {
  hash: string;
  label: string;
  models: string[];
  /** null when the prompt ran before the proxy started storing outlines. */
  outline: StoredWirePrompt | null;
  sections: SectionShare[];
  usage: PromptDayUsage[];
  meta: { days: number; files: number; parseErrors: number; archivedDays: number };
}
/** One block's worth of a heading's text, since a heading can repeat across blocks. */
export interface PromptSectionPart {
  block: number;
  bytes: number;
  text: string;
}
/** One row of that breakdown, opened up to the text behind it. */
export interface PromptSectionResponse {
  hash: string;
  heading: string;
  level: number;
  bytes: number;
  share: number;
  blocks: number[];
  /** Empty when no captured body still carries the text. */
  parts: PromptSectionPart[];
  /** The request the text was read back from; null when none survives. */
  file: string | null;
  meta: { days: number; files: number; parseErrors: number; candidates: number };
}
/** One tool of the fixed prefix, opened up to the JSON schema behind its size. */
export interface ToolSchemaResponse {
  name: string;
  /** Pretty-printed wire JSON; null once every captured body has aged out. */
  schema: string | null;
  bytes: number;
  estTokens: number;
  /** Requests in the window that shipped this tool. */
  requests: number;
  /** Share of every tool byte in the window, 0–1. */
  shareOfToolBytes: number;
  /** The request the schema was read back from; null when none survives. */
  file: string | null;
  meta: { days: number; files: number; parseErrors: number; candidates: number };
}
/** The columns `/api/context` orders by. `size` draws the same number as `realInput`. */
export const CONTEXT_SORTS = ['when', 'model', 'realInput', 'systemBytes', 'toolsBytes', 'size'] as const;
export type ContextSort = (typeof CONTEXT_SORTS)[number];
export type ContextSortDir = 'asc' | 'desc';

/** How many thread rows one page carries, matching the server's own default. */
export const CONTEXT_PAGE_SIZE = 100;

/**
 * One thread's row, already reduced to the cells the table draws — its largest
 * request. The thread's own request list stays on the server; the thread page is
 * what asks for it.
 */
export interface ContextThreadRow {
  key: string;
  threadId: string | null;
  /** The peak request's sidecar: what a thread-less row drills into. */
  file: string;
  requestCount: number;
  prompt: string | null;
  firstTimestamp: string;
  lastTimestamp: string;
  models: string[];
  realInput: number;
  systemBytes: number;
  toolsBytes: number;
}
/** One page of thread rows, echoing back the order and slice that selected it. */
export interface ContextPage {
  rows: ContextThreadRow[];
  sort: ContextSort;
  dir: ContextSortDir;
  offset: number;
  limit: number;
  q: string;
  /** Threads in the window, before any search narrowed it. */
  total: number;
  /** Threads the search kept — equal to `total` when there is no search. */
  matched: number;
  /** Threads carrying an opening prompt at all, which is what a search can reach. */
  searchable: number;
}
export interface ContextResponse {
  /** The aggregate over the whole window, so the tiles hold still while a reader pages. */
  summary: ContextAggregates;
  page: ContextPage;
  meta: { days: number; files: number; parseErrors: number };
}
export interface ContextThreadResponse {
  threadId: string;
  /** Every captured request of the thread in the window, oldest first. */
  entries: ContextEntry[];
  prompt: string | null;
  meta: { days: number; files: number; parseErrors: number };
}
/**
 * A drill-down whose captured body retention has evicted. The sidecar is kept, so
 * `retained` still carries the metrics. Discriminate on `evicted` first.
 */
export interface EvictedBodyResponse {
  file: string;
  evicted: true;
  /** The archived day the sidecar sits in; `null` while it is still live. */
  day: string | null;
  /** The server's retention window, so the message can name the real number. */
  retentionDays: number;
  retained: AuditSidecar | null;
}
export interface ContextDetailPresent {
  file: string;
  evicted: false;
  breakdown: RequestBreakdown;
  raw: string;
  truncated: boolean;
}
export type ContextDetailResponse = ContextDetailPresent | EvictedBodyResponse;
export interface ContextMessagePresent {
  file: string;
  evicted: false;
  message: RequestMessageDetail;
}
export type ContextMessageResponse = ContextMessagePresent | EvictedBodyResponse;
export interface ContextToolPresent {
  file: string;
  evicted: false;
  tool: RequestToolDetail;
}
export type ContextToolResponse = ContextToolPresent | EvictedBodyResponse;
export interface SkimResponse {
  date: string;
  skim: SkimDigest;
  meta: { files: number; parseErrors: number; bodiesEvicted: number };
}
export interface SkimTrendResponse {
  digests: SkimDigest[];
  topKeys: SkimKeyTotals[];
  meta: { days: number; files: number; parseErrors: number; bodiesEvicted: number };
}
export interface WithheldResponse {
  settingsPath: string;
  settingsReadable: boolean;
  report: WithheldReport;
  launchAliases: { rcPath: string; rcReadable: boolean; aliases: LaunchAlias[]; posture: LaunchAliasPosture };
  meta: { days: number; files: number; parseErrors: number };
}
/** A named reason this checkout's `main` cannot be pointed back at origin's. */
export interface SyncBlocker {
  reason: 'in-progress-operation' | 'main-in-other-worktree' | 'unpushed-commits';
  detail: string;
}

/** Whether the server's own checkout still agrees with `origin/main`, and what would fix it. */
export interface LocalDivergence {
  repoDir: string;
  localMain: string | null;
  originMain: string | null;
  diverged: boolean;
  /** `origin/main` is behind this checkout — the case a plain `git pull` silently ignores. */
  behind: boolean;
  ahead: string[];
  /** The commits ahead that no pin reaches, i.e. the ones a reset would really lose. */
  unreferenced: string[];
  head: { branch: string | null; detached: boolean };
  plan: 'branch-f' | 'stash-reset' | null;
  blockers: SyncBlocker[];
  /** The only thing in the way is work a sync can save to a ref first. */
  preservable: boolean;
}

export interface MainSlideResponse {
  from: string;
  to: string;
  /** The ref written to keep the old position reachable, or null when one already did. */
  pinned: string | null;
  login: string;
}

export interface MainSyncResponse {
  from: string;
  to: string;
  plan: 'branch-f' | 'stash-reset';
  /** The stash commit, when one was made — kept so a fumbled `stash drop` is recoverable. */
  stashSha: string | null;
  /** Where the pre-reset position was recorded — a local ref, never pushed to origin. */
  recorded: string;
  preservedAt: string | null;
  preservedRemotely: boolean;
  note: string | null;
}

export interface MainHideResponse {
  ref: string;
  /** The line's pin tip, which the marker is named for — not necessarily the row clicked. */
  sha: string;
  hidden: boolean;
}

/** A pull request as the list carries it: everything except the description. */
export type PullRequestListRow = Omit<PullRequestRow, 'body'>;

export interface PullRequestsResponse {
  repo: string | null;
  prs: PullRequestListRow[];
  /** A setup problem phrased for the page (no `gh`, not signed in, no remote). */
  error: string | null;
  /** Sessions that worked on each PR, keyed by number. */
  sessions: Record<number, PrSessionLink[]>;
  /** Where `main` sits, and the pinned lines running beside it. */
  mainHistory: MainHistoryGraph;
  localMain: LocalDivergence;
  /** Why `main` and its pins could not be refreshed, if they could not. */
  refError: string | null;
  meta: { fetchedAt: string; cached: boolean; total: number; limit: number };
}
export interface PullRequestBodyResponse {
  number: number;
  /** Verbatim markdown, or null when it could not be read — `error` says why. */
  body: string | null;
  /** Whether it came off the stored row rather than a fresh `gh pr view`. */
  cached: boolean;
  /** A setup problem phrased for the drawer, as the list's own is. Null on success. */
  error: string | null;
}
export interface ProjectSummary {
  name: string;
  memoryCount: number;
}
export interface ProjectsResponse {
  projects: ProjectSummary[];
  meta: { projectsDir: string; total: number };
}
export interface MemoryFileSummary {
  name: string;
  bytes: number;
  modified: string;
}
export interface ProjectMemoriesResponse {
  project: string;
  files: MemoryFileSummary[];
  meta: { total: number };
}
export interface MemoryDetail {
  project: string;
  name: string;
  content: string;
  bytes: number;
  modified: string;
}
export interface MemoryResponse {
  memory: MemoryDetail;
}
export interface HooksPluginsResponse {
  settingsPath: string;
  settingsReadable: boolean;
  hooks: HookRow[];
  plugins: PluginRow[];
  loadExpectations: AliasLoadExpectation[];
  launchRcPath: string;
  launchRcReadable: boolean;
}
/** The installed CLI bundle a catalogue was resolved against. */
export interface CliBundleInfo {
  path: string | null;
  /** The installed version, which is what the whole catalogue is keyed to. */
  version: string | null;
  exists: boolean;
  bytes: number;
  modified: string | null;
  /** Set when there is no readable bundle — the page's empty state. */
  error: string | null;
}
export interface CliInternalsResponse {
  bundle: CliBundleInfo;
  functions: CliFunctionEntry[];
  meta: { resolved: number; missing: number; durationMs: number | null };
}
export interface CliFunctionResponse {
  bundle: CliBundleInfo;
  function: CliFunctionEntry;
  /** Minified source, verbatim — null when the row did not resolve in this version. */
  source: string | null;
}
/** `~/.claude/CLAUDE.md` — the instructions every session on this device loads. */
export interface SystemPromptResponse {
  prompt: SystemPromptDoc;
  /** Ceiling the save enforces, shown before an over-long edit is refused. */
  maxBytes: number;
}
export interface SystemPromptUpdateResponse extends SystemPromptResponse {
  /** The `.bak` the save left behind, or null when it created the file. */
  backupPath: string | null;
}
/** One `~/.claude/jobs/<id>` directory: what its state file says plus what it holds. */
export interface JobSummary extends JobStateFields {
  id: string;
  stateReadable: boolean;
  files: number;
  bytes: number;
  modified: string;
  /** Newest of `updatedAt` and `modified` — what the listing sorts by. */
  activity: string;
  /**
   * What the transcripts of this job's session are doing, rolled up across the fan-out.
   * `state.json` is the job's own claim and freezes the moment it dies; this does not.
   */
  liveness: BranchLiveness;
  /** How many transcripts that verdict is drawn from; 0 when none matched the session id. */
  threads: number;
}
export interface JobsResponse {
  jobs: JobSummary[];
  meta: {
    jobsDir: string;
    total: number;
    running: number;
    /** Jobs with a transcript still being appended to — observed, not self-reported. */
    live: number;
    husks: number;
    files: number;
    bytes: number;
  };
}
export interface JobResponse {
  job: JobSummary;
  tree: JobTreeNode[];
  meta: { entries: number; truncated: boolean };
}
/** What a delete removed, as the directory read immediately before it went. */
export interface JobDeleteResult {
  id: string;
  path: string;
  files: number;
  bytes: number;
  name: string;
  state: string;
}
export interface JobDeleteResponse {
  deleted: JobDeleteResult;
  /** The listing as it stands after the delete. */
  jobs: JobsResponse;
}
/** One file inside a job directory, as the pretty/raw viewer receives it. */
export interface JobFileDetail {
  id: string;
  path: string;
  name: string;
  kind: JobFileKind;
  bytes: number;
  modified: string;
  encoding: 'utf8' | 'base64';
  content: string;
  mime: string | null;
  truncated: boolean;
  binary: boolean;
  note: string | null;
}
export interface JobFileResponse {
  file: JobFileDetail;
}
export interface SessionSummary extends SessionMeta {
  bytes: number;
  modified: string;
}
export interface SessionsResponse {
  sessions: SessionSummary[];
  meta: { sessionsDir: string; total: number };
}
/** A transcript's steps plus its place in the session's agent tree (parent/subagent links). */
export interface SessionGraphEntry extends SessionSummary, SessionAgentLink {
  nodes: SessionNode[];
  /** Whether this branch is still being written to — `quiet` is busy-or-stalled, not dead. */
  liveness: BranchLiveness;
}
export interface SessionsGraphResponse {
  sessions: SessionGraphEntry[];
  meta: { sessionsDir: string; total: number };
}
/** One branch's liveness verdict with no node stream attached — cheap enough to poll. */
export interface SessionLivenessRow {
  threadId: string;
  sessionId: string | null;
  name: string;
  parentThreadId: string | null;
  agentType: string | null;
  depth: number;
  steps: number;
  liveness: BranchLiveness;
}
export interface SessionsLivenessResponse {
  threads: SessionLivenessRow[];
  meta: {
    at: string;
    quietAfterMs: number;
    total: number;
    running: number;
    quiet: number;
    finished: number;
    unknown: number;
  };
}
/** Node index → the whole text behind that step's truncated one-line gist. Sparse. */
export interface SessionNodeTextsResponse {
  threadId: string;
  texts: Record<number, string>;
}
/** One transcript's steps re-derived from the captured request that holds them untruncated. */
export interface SessionThreadNodes {
  threadId: string;
  /** Sidecar base name of the request the nodes came from — the Request breakdown handle. */
  file: string;
  messageCount: number;
  nodes: SessionNode[];
}
export interface SessionGraphNodesResponse {
  rootThreadId: string;
  threads: SessionThreadNodes[];
  meta: { files: number; parseErrors: number; requestsRead: number; capped: boolean };
}
export interface SessionDetail {
  meta: SessionMeta;
  content: string;
  bytes: number;
  modified: string;
}
export interface SessionResponse {
  session: SessionDetail;
}
export interface SessionErrorsResponse {
  threadId: string;
  meta: SessionMeta;
  errors: LinkedSessionError[];
}
/** The session's largest captured request — the handle for its Request breakdown page. */
export interface SessionBreakdownResponse extends SessionContextPeak {
  threadId: string;
  sessionId: string | null;
  meta: { files: number; parseErrors: number };
}
// The Commands eval page. Records are read defensively throughout: the store is
// append-only and versioned, so a row written by another schema version must degrade
// the page's detail rather than empty it.
/** One installed command's row on `/commands`. */
export interface CommandsResponse {
  commands: CommandSummary[];
  meta: { commandsDir: string; storePath: string; runs: number; installed: number };
}
/**
 * One term `/teach` recorded, as it sits in `logs/concepts.jsonl` — minus the
 * meta-skills the server drops on the way out.
 *
 * Everything below `savedAt` is optional: records written before `/teach` saved
 * research detail do not carry it, and an absent field means "never recorded"
 * rather than "recorded empty". The detail page says nothing where one is
 * missing.
 */
export interface ConceptRow {
  /** The line the record sits on in the store — its address on `/concepts/$ord`. */
  ord: number;
  term: string;
  sentence: string;
  field: string;
  skills: string[];
  /** ISO timestamp. */
  savedAt: string;
  /** Free-form research notes from the run that taught the term. */
  notes?: string;
  tips?: string[];
  sources?: string[];
  /** Skills the run turned up while researching, as opposed to those it applied. */
  surfacedSkills?: string[];
}
/**
 * Which store answered, and its name for the page to show. `storePath` is the
 * hosted store's read URL when the Worker answered, and the local file's path —
 * with the reason it was read instead — when it did not.
 */
export interface ConceptStoreMeta {
  storePath: string;
  store: 'remote' | 'local';
  total: number;
}
export interface ConceptsResponse {
  /** Newest first. */
  concepts: ConceptRow[];
  meta: ConceptStoreMeta;
}
export interface ConceptResponse {
  concept: ConceptRow;
  meta: ConceptStoreMeta;
}
/**
 * A field of a concept the query's words were found in. The table renders the first
 * four; the last four are the record's prose, which it does not.
 */
export type ConceptSearchField =
  | 'term'
  | 'sentence'
  | 'field'
  | 'skills'
  | 'notes'
  | 'tips'
  | 'sources'
  | 'surfacedSkills';
export interface ConceptSearchHit {
  concept: ConceptRow;
  /** bm25 relevance from the hosted store, higher is better; `null` when unranked. */
  score: number | null;
  matchedIn: ConceptSearchField[];
  /** A window of the matching prose, from a field the table never renders. */
  excerpt: string | null;
}
export interface ConceptSearchResponse {
  query: string;
  /** `false` means the local file answered and these are unranked substring matches. */
  ranked: boolean;
  /** Best first when `ranked`, corpus order otherwise. */
  results: ConceptSearchHit[];
  meta: ConceptStoreMeta;
}
/** One run as the command page lists it — no per-turn series, no per-step breakdown. */
export interface CommandRunListItem {
  /** A thread id for a top-level run, `<threadId>~<node>` for one nested inside another. */
  runId: string;
  parentRunId: string | null;
  parentCommand: string | null;
  threadId: string;
  command: string;
  args: string;
  flags: string[];
  prompt: string;
  commandHash: string | null;
  model: string | null;
  started: string | null;
  ended: string | null;
  outcome: CommandRunOutcome;
  interruption: InterruptionKind | null;
  reachedEnd: boolean;
  totals: CommandRunTotals;
  patterns: CommandPatternId[];
  lastStep: string | null;
  meta: CommandRun['meta'];
}
/** Where the command file's content changed between two runs — the scatter's `/sync` marker. */
export interface CommandHashMarker {
  at: string;
  hash: string | null;
  previous: string | null;
}
export interface CommandResponse {
  command: string;
  installed: boolean;
  steps: CommandStep[];
  commandHash: string | null;
  /** The installed command file's markdown, exactly as on disk — null once it is gone. */
  source: string | null;
  flags: string[];
  appliedFlags: string[];
  runs: CommandRunListItem[];
  /** What the filtered runs delegate to, most-used first. Empty for pre-schema-4 records. */
  agentTypes: AgentTypeUsage[];
  stepReach: StepReach[];
  patterns: PatternFrequency[];
  hashMarkers: CommandHashMarker[];
  /** Per-run work and duration, oldest first — the trend, where `runs` is newest first. */
  profile: CommandRunProfile[];
  meta: { totalRuns: number; filteredRuns: number; wallMeasuredRuns: number };
}
export interface CommandRunResponse {
  run: CommandRun;
  patterns: PatternFrequency[];
  suggestions: SessionSuggestion[];
  meta: { transcriptsPresent: number; transcripts: number; requestsAgedOut: boolean };
}

/** Every ten-session window with its suggestions, newest bucket first. */
export interface SessionSuggestionsResponse {
  buckets: SessionBucket[];
  meta: { sessionsDir: string; sessions: number; buckets: number };
}
/** One bucket's drill-down: its suggestions, its sessions, and the request patterns behind them. */
export interface SessionSuggestionBucketResponse {
  bucket: SessionBucket;
  sessions: SessionSummary[];
  breakdown: BucketBreakdownSummary;
  breakdownSuggestions: SessionSuggestion[];
  meta: { files: number; parseErrors: number; requestsMissing: number };
}
/** Every suggestion in the requested buckets with its flag, oldest bucket first. */
export interface SuggestionStatusResponse {
  rows: SuggestionStatusRow[];
  meta: {
    statusFile: string;
    buckets: number[];
    missing: number[];
    counts: Record<SuggestionStatus, number>;
    /** How the returned rows stand against their rules' dated `done`. */
    recurrences: Record<SuggestionRecurrence, number>;
    /** How many buckets are dirty / clean / not-ready, over every bucket that exists. */
    bucketStates: Record<BucketJudgementState, number>;
  };
}
/** The rows a write touched, re-read through the same join the list uses. */
export interface SuggestionStatusUpdateResponse {
  rows: SuggestionStatusRow[];
  meta: { statusFile: string; updated: number; unknown: { bucket: number; id: string }[] };
}
/**
 * The ideas ledger: invented proposals and what a human decided about each one.
 *
 * Deliberately **not** the suggestion flags. A suggestion is counted from
 * transcripts and traces back to the sessions it fired on; an idea is invented and
 * carries only cited evidence plus a recorded sign-off, which is why `accepted` is
 * the one status `/improve` may act on.
 */
export interface IdeasResponse {
  /** Oldest first — the order the ledger was decided in. */
  rows: IdeaEntry[];
  meta: {
    file: string;
    /** Counts over the rows returned. */
    counts: Record<IdeaStatus, number>;
    /**
     * Counts per area over the **whole** ledger, with every seed area present at
     * zero — what the tab strip renders from, so selecting a tab never changes
     * the numbers on the others.
     */
    areas: IdeaAreaCounts;
    /** Entries on the whole ledger, however the view was filtered. */
    total: number;
  };
}
/** The entries a write touched, plus the ledger-wide counts after it. */
export interface IdeasStatusResponse {
  rows: IdeaEntry[];
  meta: {
    file: string;
    updated: string[];
    /** Slugs the ledger does not carry — nothing was written for these. */
    unknown: string[];
    counts: Record<IdeaStatus, number>;
    total: number;
  };
}
/** The entries a claim took, plus the holders that refused the rest. */
export interface IdeasClaimResponse {
  rows: IdeaEntry[];
  meta: {
    file: string;
    claimed: string[];
    /** A live holder is an answer the page shows, not a failed request. */
    refused: IdeaClaimRefusal[];
    unknown: string[];
    counts: Record<IdeaStatus, number>;
    total: number;
  };
}
/** The entries a re-file or a comment touched, plus the ledger-wide area counts. */
export interface IdeasEditResponse {
  rows: IdeaEntry[];
  meta: {
    file: string;
    updated: string[];
    unknown: string[];
    areas: IdeaAreaCounts;
    total: number;
  };
}
export interface FiltersResponse {
  generatedAt: string;
  filters: ProxyFilterEntry[];
}
/** `agent` runs a real Claude Code session and can change the repo; `chat` cannot. */
export type ChatMode = 'chat' | 'agent';
/**
 * The standing answer an agent turn's headless child gives to permission prompts.
 * Mirrors `PERMISSION_MODES` in `server/src/chat.ts`; the server rejects anything else.
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** What an agent turn inherits from the device, for the posture line in the UI. */
export interface ChatAgentConfig {
  cwd: string;
  alias: string;
  aliasFound: boolean;
  rcPath: string;
  rcReadable: boolean;
  flags: {
    disallowedTools: string[];
    settingSources: string[] | null;
    /** The `settings` block of the device's rc file, verbatim — keys the server does not interpret. */
    settingsOverrides: JsonRecord | null;
  };
  permissionMode: string;
}
/** The resolved settings a dashboard-started chat runs with. */
export interface ChatConfigResponse {
  transport: 'cli' | 'api';
  mode: ChatMode;
  agent: ChatAgentConfig | null;
  baseUrl: string;
  model: string;
  maxTokens: number;
  system: string;
  anthropicVersion: string;
  beta: string | null;
  apiKeySet: boolean;
  cliPath: string;
  cliFound: string | null;
  ready: boolean;
  readyHint: string | null;
}
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}
/** One tool an agent turn ran. */
export interface ChatToolUse {
  name: string;
  failed: boolean;
  /** Why it failed, from its `tool_result` — a permission denial says so here. */
  error?: string;
}
/** Why a turn ended early: `timeout` is going quiet, `limit` is outrunning the ceiling. */
export type ChatInterruption = 'stopped' | 'timeout' | 'limit';
/** A chat whose turn is in flight right now, as the server sees it. */
export interface RunningChat {
  /** Also the `session:` a transcript records, which is how a session page matches itself. */
  sessionId: string;
  threadId: string | null;
  mode: ChatMode;
  permissionMode: string | null;
  effectivePermissionMode: string | null;
  startedAt: string;
}
export interface RunningChatsResponse {
  running: RunningChat[];
}
/** The transcript a chat session id became; `threadId` is null until the proxy has written it. */
export interface ChatThreadResponse {
  sessionId: string;
  threadId: string | null;
}
export interface ChatSendResponse {
  session: {
    id: string;
    threadId: string | null;
    model: string;
    createdAt: string;
    transport: 'cli' | 'api';
    mode: ChatMode;
    permissionMode: string | null;
    /** What the child reported it started under; a mismatch means the pin never landed. */
    effectivePermissionMode: string | null;
  };
  reply: string;
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  turns: ChatTurn[];
  tools: ChatToolUse[];
  /** Set when the turn was stopped, went quiet, or hit its ceiling; the reply is the partial one. */
  interrupted: ChatInterruption | null;
}
/**
 * One thing a turn did, pushed while it was doing it. Mirrors `ChatStreamEvent` in
 * `server/src/chat-stream.ts`.
 */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  /** A tool was called; `index` is its place in the turn's finished `tools` list. */
  | { type: 'tool'; index: number; name: string }
  /** That tool answered. A failure carries its `tool_result` text, as the chip does. */
  | { type: 'tool-result'; index: number; failed: boolean; error?: string };
/** One SSE frame off the turn stream: a `snapshot` replaces, an `update` appends. */
export interface ChatStreamFrame {
  sessionId: string;
  /** Which turn of the session these belong to; a change means start over. */
  turn: number;
  active: boolean;
  interrupted: ChatInterruption | null;
  events: ChatStreamEvent[];
  seq: number;
  /** True when the turn outran the server's replay buffer, so the text starts mid-reply. */
  truncated: boolean;
}
/** Where a turn's live account arrives; an `EventSource` path, not a fetch. */
export const chatStreamPath = (sessionId: string) => apiRouteUrl('/api/chat/stream', { sessionId });

export interface HealthResponse {
  ok: boolean;
  logDir: string;
  logDirReadable: boolean;
  sidecarCount: number | null;
}
/** What a stop or an end answers: the session it named, and whether it caught a turn. */
export interface ChatStopResponse {
  sessionId: string;
  stopped: boolean;
}

/**
 * What each declared read answers. `extends Record<ApiJsonGetPath, unknown>` keys it by
 * the manifest's own GET paths: a declared route with no shape here does not compile,
 * and neither does a shape for a path the server does not serve.
 */
interface ApiGetResponses extends Record<ApiJsonGetPath, unknown> {
  '/api/health': HealthResponse;
  '/api/summary': SummaryResponse;
  '/api/trends': TrendsResponse;
  '/api/prompt-mix': PromptMixResponse;
  '/api/prompt': PromptDetailResponse;
  '/api/prompt/section': PromptSectionResponse;
  '/api/tool-schema': ToolSchemaResponse;
  '/api/usage': UsageResponse;
  '/api/tools': ToolsResponse;
  '/api/context': ContextResponse;
  '/api/context/thread': ContextThreadResponse;
  '/api/context/detail': ContextDetailResponse;
  '/api/context/message': ContextMessageResponse;
  '/api/context/tool': ContextToolResponse;
  '/api/projects': ProjectsResponse;
  '/api/projects/memories': ProjectMemoriesResponse;
  '/api/projects/memory': MemoryResponse;
  '/api/jobs': JobsResponse;
  '/api/jobs/job': JobResponse;
  '/api/jobs/file': JobFileResponse;
  '/api/sessions': SessionsResponse;
  '/api/sessions/graph': SessionsGraphResponse;
  '/api/sessions/liveness': SessionsLivenessResponse;
  '/api/sessions/node-text': SessionNodeTextsResponse;
  '/api/sessions/graph/nodes': SessionGraphNodesResponse;
  '/api/sessions/session': SessionResponse;
  '/api/sessions/breakdown': SessionBreakdownResponse;
  '/api/sessions/errors': SessionErrorsResponse;
  '/api/sessions/suggestions': SessionSuggestionsResponse;
  '/api/sessions/suggestions/bucket': SessionSuggestionBucketResponse;
  '/api/sessions/suggestions/status': SuggestionStatusResponse;
  '/api/commands': CommandsResponse;
  '/api/commands/command': CommandResponse;
  '/api/commands/run': CommandRunResponse;
  '/api/concepts': ConceptsResponse;
  '/api/concepts/concept': ConceptResponse;
  '/api/concepts/search': ConceptSearchResponse;
  '/api/ideas': IdeasResponse;
  '/api/chat/config': ChatConfigResponse;
  '/api/chat/running': RunningChatsResponse;
  '/api/chat/thread': ChatThreadResponse;
  '/api/skim': SkimResponse;
  '/api/skim/trend': SkimTrendResponse;
  '/api/withheld': WithheldResponse;
  '/api/pull-requests': PullRequestsResponse;
  '/api/pull-requests/body': PullRequestBodyResponse;
  '/api/hooks-plugins': HooksPluginsResponse;
  '/api/cli-internals': CliInternalsResponse;
  '/api/cli-internals/function': CliFunctionResponse;
  '/api/system-prompt': SystemPromptResponse;
  '/api/filters': FiltersResponse;
}

/**
 * What each declared write answers — a second map rather than one, because
 * `/api/system-prompt` and `/api/sessions/suggestions/status` answer a different shape
 * to a POST than to a GET.
 */
interface ApiPostResponses extends Record<ApiWritePath, unknown> {
  '/api/jobs/delete': JobDeleteResponse;
  '/api/sessions/suggestions/status': SuggestionStatusUpdateResponse;
  '/api/main-history/slide': MainSlideResponse;
  '/api/main-history/sync-local': MainSyncResponse;
  '/api/main-history/hide': MainHideResponse;
  '/api/system-prompt': SystemPromptUpdateResponse;
  '/api/ideas/status': IdeasStatusResponse;
  '/api/ideas/claim': IdeasClaimResponse;
  '/api/ideas/area': IdeasEditResponse;
  '/api/ideas/comment': IdeasEditResponse;
  '/api/chat/sessions': ChatSendResponse;
  '/api/chat/sessions/message': ChatSendResponse;
  '/api/chat/stop': ChatStopResponse;
  '/api/chat/sessions/end': ChatStopResponse;
}

/** Unwrap a response, preferring the server's `{ error }` message over the status. */
async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // `readJsonBody` already answers `undefined` for the non-JSON error bodies the
    // dev server can serve, so the status line stays the fallback message.
    throw new Error(errorMessage(await readJsonBody(res)) ?? `HTTP ${res.status}`);
  }
  // SAFETY: `T` is never chosen here. Both callers below fix it from the manifest map —
  // `ApiGetResponses[P]` / `ApiPostResponses[P]`, keyed by the literal route path the
  // caller declared — so this assertion restates the response contract the server owns
  // for that path rather than a guess made at this line.
  return (await res.json()) as T;
}

/**
 * Read one declared route: the path must be a manifest JSON GET, the query keys must be
 * parameters that route declares, and the answer's type comes off `ApiGetResponses`.
 */
async function read<P extends ApiJsonGetPath>(
  path: P,
  params: Partial<Record<ApiRouteParam<P>, ApiQueryValue>> = {},
): Promise<ApiGetResponses[P]> {
  return unwrap<ApiGetResponses[P]>(await fetch(`${API_BASE}${apiRouteUrl(path, params)}`));
}

/**
 * Write one declared route — the manifest's `cors: 'origin'` POST paths, and only those.
 *
 * `Body` is inferred from the literal each wrapper below passes, so the payload keeps the
 * type it was built with all the way to `JSON.stringify` instead of being flattened here.
 */
async function write<P extends ApiWritePath, Body>(path: P, body: Body): Promise<ApiPostResponses[P]> {
  return unwrap<ApiPostResponses[P]>(
    await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export const getHealth = () => read('/api/health');
export const getSummary = (date?: string) => read('/api/summary', { date });
/** `models` narrows every day to those models; omit it (or pass none) for the whole window. */
export const getTrends = (days: number, models?: readonly string[]) =>
  read('/api/trends', { days, models: models?.length ? models.join(',') : undefined });
export const getPromptMix = (days: number) => read('/api/prompt-mix', { days });
export const getPromptDetail = (hash: string, days: number) => read('/api/prompt', { hash, days });
export const getPromptSection = (hash: string, index: number, days: number) =>
  read('/api/prompt/section', { hash, index, days });
/** Paired with the `/api/usage/stream` SSE subscription, which pushes the same shape. */
export const getUsage = () => read('/api/usage');
export const getTools = (date?: string) => read('/api/tools', { date });
export const getToolSchema = (name: string, days: number) => read('/api/tool-schema', { name, days });
/**
 * One page of the window's threads. The sort, the slice and the prompt search are the
 * server's work, so a month-long window costs a page rather than its whole corpus.
 */
export const getContext = (
  days: number,
  page: { sort: ContextSort; dir: ContextSortDir; offset: number; limit?: number; q?: string },
) =>
  read('/api/context', {
    days,
    sort: page.sort,
    dir: page.dir,
    offset: page.offset,
    limit: page.limit ?? CONTEXT_PAGE_SIZE,
    q: page.q,
  });
export const getContextThread = (threadId: string, days: number) =>
  read('/api/context/thread', { thread: threadId, days });
export const getContextDetail = (file: string) => read('/api/context/detail', { file });
export const getContextMessage = (file: string, index: number) => read('/api/context/message', { file, index });
export const getContextTool = (file: string, index: number) => read('/api/context/tool', { file, index });
export const getProjects = () => read('/api/projects');
export const getProjectMemories = (project: string) => read('/api/projects/memories', { project });
export const getMemory = (project: string, name: string) => read('/api/projects/memory', { project, name });
/** Every background job directory on the device, newest activity first. */
export const getJobs = () => read('/api/jobs');
export const getJob = (id: string) => read('/api/jobs/job', { id });
/** One file from a job directory — `file` is a path relative to that directory. */
export const getJobFile = (id: string, file: string) => read('/api/jobs/file', { id, file });
/** Delete one job directory from `~/.claude/jobs` — no trash, and a running job is refused. */
export const deleteJob = (id: string) => write('/api/jobs/delete', { id });
export const getSessions = () => read('/api/sessions');
export const getSessionsGraph = () => read('/api/sessions/graph');
/** Every branch's liveness verdict, live branches first — the graph payload without the steps. */
export const getSessionsLiveness = () => read('/api/sessions/liveness');
export const getSessionGraphNodes = (id: string) => read('/api/sessions/graph/nodes', { id });
export const getSession = (id: string) => read('/api/sessions/session', { id });
export const getSessionErrors = (id: string) => read('/api/sessions/errors', { id });
export const getSessionNodeTexts = (id: string) => read('/api/sessions/node-text', { id });
export const getSessionBreakdown = (id: string) => read('/api/sessions/breakdown', { id });
export const getCommands = () => read('/api/commands');
/** `flags` narrows which runs are aggregated; it never splits the command into variants. */
export const getCommand = (command: string, flags: readonly string[] = []) =>
  read('/api/commands/command', { name: command, flags: flags.length ? flags.join(',') : undefined });
export const getCommandRun = (threadId: string) => read('/api/commands/run', { id: threadId });

/** Every ten-session window, recomputed server-side on each load — this is the backfill. */
export const getSessionSuggestions = () => read('/api/sessions/suggestions');
export const getSessionSuggestionBucket = (index: number) => read('/api/sessions/suggestions/bucket', { index });
/**
 * The flags on those suggestions. `range` narrows to a bucket, list or span;
 * `recurrences` narrows by how each window stands against its rule's dated `done`.
 */
export const getSuggestionStatus = (
  opts: { range?: string; statuses?: SuggestionStatus[]; recurrences?: SuggestionRecurrence[]; detail?: boolean } = {},
) =>
  read('/api/sessions/suggestions/status', {
    range: opts.range,
    status: opts.statuses?.length ? opts.statuses.join(',') : undefined,
    recurrence: opts.recurrences?.length ? opts.recurrences.join(',') : undefined,
    detail: opts.detail ? '1' : undefined,
  });
/** Record flags. Setting one back to `pending` deletes its entry — that is the undo. */
export const markSuggestionStatus = (updates: SuggestionStatusUpdate[]) =>
  write('/api/sessions/suggestions/status', { updates });
export const getSkim = (date?: string) => read('/api/skim', { date });
export const getSkimTrend = (days: number) => read('/api/skim/trend', { days });
export const getWithheld = (days = 14) => read('/api/withheld', { days });
/** The project's pull requests, read through `gh` on the server — without their bodies. */
export const getPullRequests = () => read('/api/pull-requests');
/** The description of one pull request, asked for when its drawer opens. */
export const getPullRequestBody = (number: number) => read('/api/pull-requests/body', { number });
/**
 * Move `origin/main` to a merged PR's landing commit. `expectedMain` is the sha the page
 * was showing: the server pushes with a lease against it, so a stale page is rejected by
 * GitHub rather than by a check that could race. The commit `main` leaves is pinned first.
 */
export const slideMain = (expectedMain: string, target: string) =>
  write('/api/main-history/slide', { expectedMain, target });
/** Point the server checkout's own `main` back at `origin/main` — what `git pull` will not do. */
export const syncLocalMain = (preserve = false) => write('/api/main-history/sync-local', { preserve });
/** Hide a pinned line from the page, or show it again. The pin itself is never deleted. */
export const setMainLineHidden = (sha: string, hidden: boolean) => write('/api/main-history/hide', { sha, hidden });
export const getHooksPlugins = () => read('/api/hooks-plugins');
/** The catalogued CLI internals, resolved against the bundle installed right now. */
export const getCliInternals = () => read('/api/cli-internals');
/** One catalogued function, with its source read straight out of that bundle. */
export const getCliFunction = (id: string) => read('/api/cli-internals/function', { id });
/** Everything `/teach` has saved, newest first. */
export const getConcepts = () => read('/api/concepts');
/** One saved concept, by the line it sits on in the store. */
export const getConcept = (ord: number) => read('/api/concepts/concept', { ord });
/**
 * The corpus searched by its prose — the notes, tips and sources the table does not
 * render, not only the columns it does. `ranked` says whether bm25 ordered it.
 */
export const searchConcepts = (q: string) => read('/api/concepts/search', { q });
/** The device system prompt as it is on disk — `~/.claude/CLAUDE.md`. */
export const getSystemPrompt = () => read('/api/system-prompt');
/**
 * Overwrite it. The server keeps the previous contents in a `.bak` beside the file.
 * `expectedModified` is the mtime the save is replacing; the server answers 409 when
 * the file no longer carries it. Omit it to write regardless.
 */
export const saveSystemPrompt = (text: string, expectedModified?: string | null) =>
  write('/api/system-prompt', expectedModified === undefined ? { text } : { text, expectedModified });
/** The whole ledger, paired with the `/api/ideas/stream` subscription that pushes the same shape. */
export const getIdeas = () => read('/api/ideas');
/**
 * Adjudicate ideas. The browser may set `accepted`, `rejected`, `proposed` (the
 * undo) and `shipped`; only `claimed` stays off, since a claim names a holder and
 * a mark carries none — that is `claimIdeas`. A `rejected` mark with no note is
 * refused (the reason is what stops the idea being re-proposed) and so is a
 * `shipped` one (the note is the PR url), as is shipping an idea whose status
 * `canShipIdea` does not allow.
 */
export const markIdeas = (marks: IdeaMark[]) => write('/api/ideas/status', { marks });
/**
 * Take an idea under a named holder — the way back from a release, which drops
 * the claim outright. Its own route rather than a `claimed` mark, since a mark
 * carries no holder. A live holder comes back under `meta.refused`, not as an
 * error.
 */
export const claimIdeas = (claims: IdeaClaimRequest[]) => write('/api/ideas/claim', { claims });
/**
 * Re-file ideas under an area. Its own route rather than a field on the mark: a
 * status change must never move an idea between tabs as a side effect. An idea
 * citing `command-gap` cannot leave the Commands area and is refused with 400.
 */
export const fileIdeas = (filings: IdeaFiling[]) => write('/api/ideas/area', { filings });
/** Write the comment on an idea. It replaces the previous one; `''` clears it. */
export const commentIdeas = (comments: IdeaComment[]) => write('/api/ideas/comment', { comments });
export const getFilters = () => read('/api/filters');
export const getChatConfig = () => read('/api/chat/config');
/** Turns in flight — how a session page finds the Stop the starting tab may have lost. */
export const getRunningChats = () => read('/api/chat/running');
/** Which transcript a chat session id became — polled by the page it navigated to. */
export const getChatThread = (sessionId: string) => read('/api/chat/thread', { sessionId });
/** The session id is chosen here, not read off the response, so the first turn is stoppable. */
export const startChat = (
  sessionId: string,
  prompt: string,
  opts: { mode?: ChatMode; permissionMode?: PermissionMode } = {},
) => write('/api/chat/sessions', { sessionId, prompt, ...opts });
export const sendChatMessage = (sessionId: string, prompt: string) =>
  write('/api/chat/sessions/message', { sessionId, prompt });
/** Ends the turn in flight; the send it interrupts resolves with the partial reply. */
export const stopChat = (sessionId: string) => write('/api/chat/stop', { sessionId });
/** Ends the session, so the server stops holding it once the user moves on. */
export const endChat = (sessionId: string) => write('/api/chat/sessions/end', { sessionId });
