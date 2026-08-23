---
name: wayfinder
description: Run a named campaign of related work tracked as markdown plans in the repository rather than on an issue tracker — one base branch, a map of active tasks, one task run per ticket, and a summary appended as each lands.
---

# Wayfinder

A wayfinder is a named campaign of related work — several tasks that ship
together — tracked entirely in markdown inside the repository. It plans and
executes a multi-task effort with no issue tracker and no project board: fewer
layers to keep in sync, and everything reviewable in a diff.

Parse `--unattended`, `--integration <branch>`, `--here`, `--base <branch>`,
`--draft`, and `--add <command prompt,...>`; the remaining text names the
operation and its subject. Every flag but `--unattended` and `--integration`
belongs to the ticket runner and applies only when this run executes a ticket,
because that operation is one invocation of that runner and forwards them
verbatim. The charting operations ignore them.

`--integration <branch>` belongs to this workflow and names the campaign's
**integration branch**: the branch `wayfinder/<slug>` is cut from, and the branch
the campaign's own pull requests target. It is read on the **start** operation
only — that is where the base branch is cut and the map is written — and every
later operation reads the resolved branch **out of the map** rather than
re-deriving it. Absent the flag, the integration branch is the repository default
branch reported by the repository helper's state verb, which is what every
campaign started before this flag existed already used. Neither branch name is
hardcoded: not `main`, and not whatever branch one campaign happens to name.

It governs exactly three things and nothing else — the cut point for
`wayfinder/<slug>`, the target of the planning pull request at start, and the
target of the campaign pull request at close. Ticket pull requests are untouched
by it and still target `wayfinder/<slug>`.

**`--integration` is not `--base`, and `--base` is not it.** `--base` is
forwarded to the ticket runner and names *a ticket's* cut point inside the
campaign; `--integration` names what the *campaign itself* is cut from and merged
into. Naming one never sets the other. A campaign integrating with `release/2.0`
still cuts its tickets from `wayfinder/<slug>`, and a ticket cut from somewhere
unusual with `--base` changes nothing about where the campaign lands. Do not read
either as shorthand for the other, and do not collapse them into one flag.

`--unattended` belongs to this workflow. It authorises the run to merge the pull
requests it opens, and routes ticket execution to `$god` rather than the
stop-at-a-pull-request `$task`. **It must be typed on the invocation that acts.**
No operation infers it — not from a workflow that invoked this one, not from an
earlier operation in the same campaign, and not from the map, which records the
campaign's mode but authorises nothing by itself. The reason is what a campaign
is: it multiplies whatever it authorises, and N unattended merges out of one
invocation is a different risk from one, which is why `$manage` likewise requires
its merge-through delegate to be typed rather than inherited. Absent the flag on
this invocation, this workflow opens pull requests and merges nothing, whatever
the map says.

**One path deliberately puts the flag in front of the next agent to type, and
only one:** the map's own agent kickoff prompt, for a campaign whose map header
records `Unattended: yes`. That prompt is not documentation about the campaign —
it *is* the resume path, the literal text a fresh agent is handed to pick the
campaign back up. A resume that drops the flag silently downgrades the campaign
to stopping at every pull request, and because a long campaign resumes as a
matter of course, an unattended campaign that resumes attended never finishes. So
start records the mode and generates the prompt to carry `--unattended` when it
is set. The flag is still read off the invocation and nowhere else; what this
adds is a prompt that tells the resuming agent to type it. The decision, and the
escalation risk it accepts, are recorded in the repository's decision records at
`docs/adrs/0006-unattended-campaigns-resume-unattended.md`.

`--draft` is refused alongside `--unattended`: `$god` rejects a draft outright,
because a draft cannot merge. Say to run the campaign without
`--unattended` if the tickets are meant to stay in draft.

Announce which of the five operations you picked before acting: start, add task,
execute, complete task, or close — and, when `--unattended` is typed, announce in
the same breath that this run will merge.

Before the first tool call, record this run as a task list whose **last item is
the closing turn**, kept as its own item and left open until nothing else
remains. A compaction carries that list forward; it does not carry these
instructions, so the item is the only surviving record that the run owes an
outcome. Resolve it in the same tool-call turn as the run's last piece of real
work, never as a bookkeeping call after it — a run whose last scheduled action
is that mark ends on it, and the message meant to follow never arrives.

Open each numbered step by naming it in prose as you enter it, so the record of
the run anchors the step it entered instead of inferring it from surrounding
words. Where the workflow declares explicitly numbered steps, state the number
from the heading rather than from a count of steps already finished.

## Mental model

- One wayfinder is one integration branch — the branch the campaign is cut from
  and merged back into. `--integration <branch>` names it at start; absent the
  flag it is the repository default branch from the repository helper's state
  verb. Never hardcode `main`. Whichever it resolves to, start writes it into the
  map and every later operation reads it from there, so an agent resuming from
  the map never re-derives it.
- One wayfinder is one base branch `wayfinder/<slug>`, cut from that integration
  branch.
- One wayfinder is one mode, attended or unattended, fixed at start by whether
  `--unattended` was typed there and written into the map as `Unattended:`. It
  decides one thing only: whether the map's kickoff prompt is generated carrying
  `--unattended`. No operation reads it as authorisation — every merge still
  needs the flag typed on the invocation that performs it.
- One wayfinder is one map file `<plans>/wayfinder-<slug>.md` listing active
  tasks and logging completed ones.
- Each task is one plan file `<plans>/<slug>-NN-<task-slug>.md` and one branch
  `task/<slug>-NN-<task-slug>` cut from the base branch. Every ticket pull
  request targets the base branch, never the default branch.
- `<plans>` is the repository's own plans directory — `docs/plans/` where it has
  one, otherwise whatever its docs convention names. Resolve it once at start
  and record it in the map.
- Everything under `<plans>` is ephemeral scaffolding, on a schedule rather than
  by accident. The durable record is the merged code plus the repository's
  feature, spec, and decision docs. A finished task's plan is marked done where
  it already lives and stays there for the rest of the campaign, so any task can
  still be restarted from what was asked. The campaign's final ticket deletes
  every plan; the map goes when the campaign closes.

Exactly two pull requests legitimately target the integration branch: the
planning pull request at start, and the campaign pull request at close. On a
campaign that never named an integration branch, that branch is the default
branch and this reads exactly as it always did.

## Discovery

Whenever an operation looks at more than one file — the complete and close
operations read the map and every plan beside it — enumerate the paths from one
listing first, then read the whole enumeration in one turn. Never loop one read
per plan, and never re-read a file already in this session's context; locate the
symbol you now want with a single search and pull only the range you still need.
After any compaction boundary or hand-off, re-read the files the next edit pass
will write before editing, because a continuation summary does not satisfy a
file-editing tool's read-before-write precondition.

## Task status vocabulary

A task's status in the map is one of exactly six values and no others. The
vocabulary is deliberately flat — no sub-states and no transitions to memorise —
because its whole job is to tell an agent resuming from the map **why** a task is
not running, and each answer calls for a different action.

- `todo` — never started: no branch, no worktree, no pull request, no history to
  read. Pick it up and execute it.
- `in-progress` — a ticket run is executing it right now. Leave it alone while
  that run is live; where nothing is behind it, read the branch and rewrite the
  row as described under repairing a stale row below. A stale `in-progress` is
  the one row that can freeze a campaign.
- `paused` — deliberately stopped and resumable exactly as it stands. Nothing is
  wrong with it. Pick it back up and carry on from where it stopped.
- `blocked-limit` — stopped mid-run because the usage window or rate limit ran
  out. Nothing is wrong with the work; the clock ran out, not the plan. Resume it
  once the window resets, and until then execute a different task rather than
  waiting on it.
- `rejected` — the user reviewed it and turned it down. Do **not** retry it. It
  needs a new decision from the user, or a rewritten plan. Report it and move on
  to another task.
- `redo` — the work landed but has to be done again differently. Restart it from
  the plan: read the note for what must differ, then execute it as a fresh run.

**Three of those mean the task is stopped, and they are not interchangeable.**
State the difference outright rather than leaving a reader to infer it from the
status names:

- `todo` means **never started**. Nobody attempted it, so there is nothing to
  resume and executing it is the ordinary thing to do.
- `rejected` means **stopped because the user turned it down**. It was attempted,
  reviewed, and refused. Silently retrying it re-does work a human already said
  no to, which is why it is the one status a resuming agent must never act on by
  itself.
- `blocked-limit` means **stopped because the usage window ran out**. It was
  attempted, nothing about it was judged, and it resumes untouched once the
  window resets. No human decision is owed, and treating it like `rejected`
  strands work that is only waiting on a clock.

`paused` sits with `blocked-limit` on that split — attempted, unjudged,
resumable as-is — and differs only in what stopped it: a deliberate choice rather
than a limit.

**Repairing a stale `in-progress` row.** `blocked-limit` is the one status the
run that needs it often cannot write: a run whose usage window ran out mid-ticket
rarely gets another turn to edit the map, so the status meant to survive a hard
stop is the one most likely to be missing, and the row is left on `in-progress`,
reading as live work and freezing the next agent out of it. Unrepaired that
compounds — each successive agent skips the stale row, starts another ticket, and
hits the same wall, until every row reads `in-progress` while nothing at all is
running.

Repairing those rows is therefore a resuming agent's job and comes **before**
picking a task. For each `in-progress` row, establish whether a run is really
behind it: a live worktree, a branch pushed within that run's lifetime, an open
pull request. Where one is, leave it. Where none is, read the branch and rewrite
the row — work in hand and nothing judged becomes `blocked-limit`, with a note
saying the run stopped without recording a status and when the window resets;
nothing worth resuming becomes `todo` with an empty note, because nothing was
really started. Never delete the row, and never leave it on `in-progress` once
you have established no run is behind it. Repair is not execution: repair every
stale row first, then pick a task from the repaired map.

The active-tasks table carries a short free-text **note** beside the status,
because three of the six are useless to a resuming agent without a reason:
`rejected` without the user's objection cannot become a rewritten plan, `redo`
without "differently how" is a re-run of the same thing, and `blocked-limit`
without a reset time makes the next agent guess whether to wait. The note is
required for `rejected`, `blocked-limit`, and `redo` — one clause, not a
paragraph — and empty for `todo`, `in-progress`, and `paused`. A paused task that
needs explaining is really a rejected or a limit-blocked one. That note is the
only column the vocabulary adds: do not add a second, and do not split a status
into sub-states, because a distinction needing more than one word belongs in the
note or in the plan.

## Operations

### 1. Start

1. Pick a short kebab-case slug and confirm it if the request is ambiguous.
2. Resolve the integration branch, once, here: `--integration <branch>` if it was
   typed on this invocation, otherwise the default branch the repository helper
   reports. Do not assume it is `main`, and do not assume it is not. Confirm the
   resolved branch exists on the remote before cutting anything from it — a
   mistyped integration branch is a campaign built on nothing. Announce which
   branch it resolved to and whether that came from the flag or the repository
   default.
3. Cut `wayfinder/<slug>` from the up-to-date integration branch resolved in
   step 2.
4. Write the map from the template below, recording that resolved integration
   branch in the header beside the base branch, and including the agent kickoff
   prompt. The map is the record from here on: no later operation re-reads the
   flag or re-derives the branch from the state verb. Record the campaign's mode
   in the same header — `Unattended: yes` when `--unattended` was typed on *this*
   start invocation, `Unattended: no` when it was not. Resolve it once, here,
   exactly as the integration branch is resolved once here: a campaign's mode is
   a property of how it was started, not of whoever resumes it. It governs one
   thing, which closing block the kickoff prompt is generated with, and a map
   written before this line existed reads as `no`.
5. Create the plans you can specify now with the add-task operation, so the
   tickets land alongside the map.
6. Create the campaign's final ticket here, alongside the rest: a real ticket,
   with a real plan and a real branch, named `<slug>-zz-retire-done-plans` and
   sitting last in the active-tasks table, where the reserved `zz` keeps it
   however many numbered tickets are added later. Its criteria are to delete
   every `<plans>/<slug>-*.md` plan file, its own included, regenerate the docs
   index, and leave the map alone for the close operation to retire. This ticket
   is critical, and it is not optional bookkeeping. Every other plan is
   deliberately kept and marked done for the campaign's whole life, so this
   ticket is the only thing that ever removes any of them: skip it and the
   campaign's scaffolding stays in the repository permanently — a directory of
   done plans belonging to a campaign that ended, owned by nobody, that every
   later reader has to work out is dead.
7. Regenerate the docs index where the repository generates one, then commit the
   map and plans on the base branch.
8. Open the planning pull request with `$pr` while the branch holds only that
   planning commit, so it carries scaffolding and no task code. Its target is the
   integration branch the map now records: the pull-request workflow targets the
   repository default branch by design, so where the map names something else,
   retarget the pull request to that branch as soon as it exists and confirm the
   retarget landed — the same move a ticket pull request gets onto the campaign
   base. By default do not mark it draft and do not merge it — the user reviews
   every pull request, and that default holds for every run without
   `--unattended`. With `--unattended` typed on this invocation, merging the
   planning pull request is authorised once it is green. Either way it must land
   before any ticket branch is cut, so the integration branch carries the plans
   agents read.
9. Report the integration branch, base branch, the campaign's recorded mode, map
   path, planning pull request, and kickoff prompt.

Create no issues, labels, or project-board items — that is the layer this
workflow replaces.

### 2. Add a task

1. Read the map for the next task number.
2. Write the plan to `<plans>/<slug>-NN-<task-slug>.md`, passing that exact path
   so it lands beside the map. Open it with the plan header described below,
   whose `Status: active` line is the marker completion later flips. State
   criteria plainly enough that `$task` can be handed them unedited.
3. Add a row to the map's active-tasks table: number, task slug, plan link,
   branch, status `todo`, note empty. `todo` is the only status this operation
   ever writes, because a freshly added task is by definition one that was never
   started.
4. Regenerate the docs index and report the plan path.

### 3. Execute a task

Ticket execution is an existing workflow, which owns the worktree, bootstrap,
verification, commits, cleanup, and pull request. Do not reimplement any of that
here. Which workflow is the flag's doing and nothing else's: by default `$task`,
which stops at an open, reviewed pull request; under `--unattended` `$god`, which
runs that same pipeline and adds the last mile — conflicts resolved, checks
waited on, the ticket pull request retargeted onto its merge target and merged
there.

Which tasks this operation may pick up is read straight off the status column.
Eligible: `todo` (start it), `paused` (resume it as it stands), `blocked-limit`
(resume it once the window has reset, and otherwise execute a different task
rather than waiting on the clock), and `redo` (restart it from the plan, doing
differently whatever the note names). **`rejected` is never executed here** — the
user turned that ticket down, so it needs a new decision or a rewritten plan
before it is a ticket again; report it and pick another. `in-progress` belongs to
a live run — but only while one is live, so repair any stale `in-progress` row
first, as described in the status vocabulary above, and pick from the repaired
map.

If every active task is blocked, report the blocking dependency rather than
starting unrelated work: a task sitting on `rejected` counts as blocked on a
human, and one on `blocked-limit` as blocked on the clock. "No eligible task" is
not the same as "ready to close" — report the campaign ready to close only when
no active tasks remain at all.

The `zz` plan-retirement ticket is executed last, after every other task has
completed. It is eligible like any other ticket, but running it early deletes the
plans of tasks still to come, so pick it only when nothing else is active.

1. Read the plan in full.
2. Mark the task `in-progress` in the map — the only status this operation writes
   on the way in, whichever of the four eligible statuses the row carried before
   — and clear any note that status left behind.
3. Run the chosen workflow with the campaign base branch as its base and any
   forwarded flags, handing it the plan's criteria. Under `--unattended`, name
   the campaign base branch **twice** — once as `$god`'s cut point and once as
   its merge target (`--base wayfinder/<slug> --into wayfinder/<slug>`). The two
   are independent and neither implies the other; absent the merge target,
   `$god` merges into the default branch. A ticket that cannot be given that
   merge target is a stop, not a merge.
4. The pull-request step targets the default branch by design, so retarget the
   ticket pull request to `wayfinder/<slug>` as soon as it exists, and confirm
   the retarget landed. A ticket left pointing at the default branch is the one
   failure this workflow cannot absorb. Under `--unattended` that retarget
   belongs to `$god` rather than to this workflow: the merge target given in step
   3 is what `$god` retargets the pull request onto before it merges, and a
   retarget attempted from out here would arrive after the merge in any case.
   Confirm from `$god`'s own report that the ticket landed on `wayfinder/<slug>`.
5. By default never merge it — the user reviews every pull request, and that is
   the documented default rather than a limit of the operation. Under
   `--unattended` the ticket merge is authorised and the runner performs it
   against the retargeted base as part of its own run, so nothing is left to
   merge here.
6. If the ticket stops before it lands, write the status that says why. This is
   the operation that records it, and a row left on `in-progress` by a run that
   stopped is what makes dead work read as live to the next agent. The usage
   window or rate limit running out mid-run writes `blocked-limit` with a note
   naming when it resets — nothing is wrong with the work. A deliberate stop that
   is resumable as it stands writes `paused` with an empty note; that is the
   status a pause writes, and a normal event in a long campaign rather than a
   failure. A ticket the user reviewed and turned down writes `rejected` with the
   objection in one clause, and is not re-executed afterwards. Otherwise the
   ticket landed, and the complete operation records it.

### 4. Complete a task

Run after a ticket's pull request merges into the base branch.

1. Confirm the base branch actually carries the merged work.
2. Mark the plan done where it already is: set its header's `Status:` line to
   `done · YYYY-MM-DD`. Do not delete it, do not move it, and do not copy it
   anywhere; the file stays at the exact path the map already links.
3. Append a summary to the map's Completed section describing what was actually
   built rather than what the plan proposed; the deviations are the part worth
   keeping.
4. Remove the task's row from the active-tasks table. A completed task carries no
   status at all — the Completed entry replaces the row rather than joining the
   vocabulary, which is why there is no `done` among the six. The plan file's own
   done marker is a different thing on a different object: the row describes work
   in flight and goes away, the file describes what was asked and stays.
5. Regenerate the docs index and commit the map edit and the plan's status flip
   together.

The plan stays until the campaign's final ticket because the Completed entry and
the plan record different things. The entry records what was built — prose
written afterwards about the outcome. The plan records what was asked: the
criteria, the constraints, the conditions the work had to meet. Only the second
can be handed to a runner again, so a campaign that deletes plans at completion
can re-open a task only from a summary of the very thing it is trying to redo.
Keeping the plan costs one status line and is what makes `redo` an operation
rather than a rewrite.

Re-opening a completed task is the one path that writes `redo`. When work that
already landed has to be done again differently, restore its row to the
active-tasks table with status `redo` and a note naming what must differ, and
leave its Completed entry in place as the record of what shipped the first time.
Its plan is still there, marked done: flip its `Status:` back to `active` and
amend it with whatever must differ this time. `redo` means restart from what was
asked, and the plan is what carries that.

The final `zz` ticket is the one completion with no plan left to mark, since it
deletes every plan in the campaign including its own. Record it with steps 3
through 5, skip step 2, and say so rather than hunting for the file.

### 5. Close

1. Confirm each completed task produced its durable docs in the repository's own
   bundle. The Completed log is scaffolding, not the deliverable.
2. Confirm the campaign's final ticket has landed. This operation expects
   `<slug>-zz-retire-done-plans` to be in the map and executed, because that
   ticket — not this step — is what removes the campaign's plan files. Where it
   exists but has not run, execute it now with the execute operation before
   opening the campaign pull request; where the map never carried it, add it with
   the add-task operation and then execute it. Do not sweep the plans by hand
   here: a deletion performed as a side effect of closing is exactly the
   untracked cleanup this ticket exists to replace, and doing it here would
   quietly make the ticket optional again.
3. Open one pull request from the base branch to the integration branch the map
   records, with `$pr`, summarizing the campaign and linking the Completed log.
   Read that branch from the map's header — do not re-derive it from the state
   verb, and do not assume the campaign integrates with the default branch. The
   pull-request workflow targets the default branch by design, so where the two
   differ, retarget and confirm it landed before merging anything. By default do
   not merge it — the user reviews it. With `--unattended` typed on this
   invocation, merging the campaign pull request is authorised once it is green.
4. After it merges, retire what is left: delete the map, regenerate the index,
   commit as a scaffolding-retirement change, and delete the base branch locally
   and on the remote. The plans are already gone, removed by the final ticket in
   step 2; a plan still standing here means that ticket was skipped, and step 2
   is where to go back to rather than deleting it from under the map.

## Plan header

Every plan opens with a header above its criteria, carrying the task's
identifier, its wayfinder slug, its branch, and a `Status:` line:

```markdown
# <slug>-NN — <task title>

**Wayfinder:** `<slug>`
**Branch:** `task/<slug>-NN-<task-slug>`
**Status:** active
```

`Status:` is the plan file's own marker and takes exactly two values: `active`
while the task is unfinished, and `done · YYYY-MM-DD` once its pull request
merged and the complete operation ran. It is not the map's status column and
shares nothing with that six-value vocabulary — the map's column describes a row
in the table, which a completed task no longer has, while this describes the
file, which a completed task keeps. That is why completion writes `done` here and
still writes no `done` there.

Marking it done in place is the whole mechanism: one file, at one path, in one
state. Nothing is copied into an `archive/` or a `done/` directory, because a
second copy of a plan is a second source of truth and starts drifting from the
first immediately.

## Map template

Write to `<plans>/wayfinder-<slug>.md`, carrying whatever frontmatter the
repository's docs bundle requires:

```markdown
# Wayfinder — <Human Name>

**Slug:** `<slug>`
**Integration branch:** `<resolved integration branch>` (cut from it, merged back into it; the planning and campaign pull requests target it)
**Base branch:** `wayfinder/<slug>` (cut from the integration branch above; every ticket targets it)
**Unattended:** `<yes|no>` (fixed at start by whether `--unattended` was typed there; `yes` means the kickoff prompt resumes this campaign unattended)
**Plans directory:** `<plans>`
**Started:** YYYY-MM-DD
**Goal:** <one sentence — what this campaign ships>

> Ephemeral scaffolding, on a schedule. Every `<slug>-*.md` plan beside this file stays here for
> the campaign's life — marked done once its task lands — so any task can be restarted from what
> was asked. The final ticket `<slug>-zz` deletes them all; this map goes when the wayfinder
> closes. The durable output is the merged code and the repository's feature and spec docs.

## Active tasks

| # | Task | Plan | Branch | Status | Note |
|---|------|------|--------|--------|------|
| 01 | <task slug> | [<slug>-01-...](<slug>-01-....md) | `task/<slug>-01-...` | todo | |
| zz | retire-done-plans | [<slug>-zz-retire-done-plans](<slug>-zz-retire-done-plans.md) | `task/<slug>-zz-retire-done-plans` | todo | Final ticket — deletes every plan. Execute last. |

<!--
Status is exactly one of these six:
  todo          — never started; nothing to resume. Pick it up.
  in-progress   — a ticket run is executing it now. Leave it alone.
  paused        — deliberately stopped, resumable as-is. Pick it back up.
  blocked-limit — the usage window ran out mid-run; nothing is wrong with the
                  work. Resume it once the window resets.
  rejected      — a human reviewed it and turned it down. Do NOT retry it; it
                  needs a new human decision or a rewritten plan.
  redo          — the work landed but must be done again differently. Restart
                  it from the plan.
Note is required for blocked-limit, rejected, and redo; empty for the rest.

The `zz` row is this campaign's final ticket. It always sorts last, it is executed
after every other task, and it deletes every plan in this directory. Do not drop it:
nothing else removes them, so without it they outlive the campaign permanently.
-->

## Completed

<!-- newest first; one entry appended per task completion -->
```

Each completed entry names what shipped in one to three sentences, the key files,
the docs added or updated, and any follow-ups or deviations.

## Agent kickoff prompt

The map carries a plain-language, provider-neutral prompt that any agent CLI can
resume from: read the repository instructions, this workflow, and the map;
inspect live Git and worktree state; execute the next unblocked active task by
running the task workflow against its plan with the campaign base branch as the
base; and retarget the resulting pull request to that base branch. Name no model,
vendor, or product-specific command in that prompt.

The prompt states which statuses are eligible in plain language rather than by
name, so any agent can act on it: a task is eligible when it was never started,
was deliberately paused, was stopped because a usage window ran out and that
window has since reset, or is marked for redoing differently. It says outright
never to re-execute a task a human rejected — report it and pick another — and
that a task already marked in progress belongs to a live run. It also tells the
agent that if it stops before the pull request is open, it must set the status to
say why, with a short note, rather than leaving the task marked in progress.

Because a run stopped by a usage window usually never gets the turn in which it
would have recorded that, the prompt also tells the agent to repair stale rows
before choosing anything: check whether a run is really behind each task marked
in progress — a live worktree, a recently pushed branch, an open pull request —
leave the ones that have one, and for the rest read the branch and rewrite the
status, to stopped-by-usage-window where work is in hand and to never-started
where there is nothing worth resuming. Without that clause a campaign stalls with
every row marked in progress and nothing executing.

The prompt also tells the agent how to treat the campaign's final task — the one
numbered `zz`, which deletes the campaign's plan files. It is executed only once
it is the last active task left: skipped while any other task is still active,
and never treated as done work or dropped from the map, because it is the only
thing that removes the plan files and a campaign that skips it leaves its
scaffolding in the repository permanently.

**The prompt's closing paragraph is generated rather than fixed**, and it is the
only part that differs between an attended campaign and an unattended one. Which
one gets written is read off the map header's `Unattended:` line — that is, off
whether `--unattended` was typed at start.

On `Unattended: no`, the closing paragraph is the reviewed default and the
wording every campaign has always had: stop after opening the pull request so a
human can review it, never merge it, and never leave it targeting the default
branch.

On `Unattended: yes`, the closing paragraph resumes the campaign the way it was
started. It says that the map header records this campaign as unattended, so the
resuming agent types this workflow's `--unattended` flag on the invocation it
runs — which routes the ticket through the merge-through runner that resolves
conflicts, waits for checks, retargets the pull request onto the campaign base
branch, and merges it there. It says outright not to stop at the open pull
request but to carry the ticket through to merged, still never leaving it
targeting the default branch, and to include the merge in what it reports back.

Naming `--unattended` there does not break the prompt's provider-neutrality. The
rule barring model, vendor, and product-specific command names holds in full:
`--unattended` is this *workflow's* own flag, parsed identically wherever the
workflow is installed, so it reads the same in any agent CLI. Do not name the
runner workflows themselves in the prompt — "the merge-through runner" is the
neutral phrasing, and this workflow's own documentation says which one that is.

Everywhere else the kickoff prompt still carries no flag it was not generated
with, and the never-inherited rule is otherwise untouched. This one exception
exists because the prompt *is* the resume path: a campaign that stops at every
pull request when it was started not to never finishes, and a resume is the
ordinary event in a multi-week campaign rather than the exception. The flag is
still read only from the invocation that acts — the map does not authorise
anything, it decides which sentence gets written. The repository's decision
record at `docs/adrs/0006-unattended-campaigns-resume-unattended.md` states the
escalation risk that accepts: a map is a file in the repository, so whoever can
edit it can put the flag in a later resume's hands.

## Guardrails

- Never leave a ticket pull request targeting the default branch. Only the
  planning and campaign pull requests leave `wayfinder/<slug>`, and they target
  the campaign's integration branch rather than the default branch as such.
- The integration branch and `--base` are different things, and conflating them
  is the mistake this guardrail exists to stop. The integration branch is the
  campaign's: what `wayfinder/<slug>` is cut from and what the planning and
  campaign pull requests merge into. `--base` is a ticket's: forwarded verbatim
  to the ticket runner as that one ticket's cut point. Naming one never sets the
  other.
- After start, read the integration branch from the map and nowhere else — not
  from the state verb, not from the flag, not from whichever branch happens to be
  checked out. Re-deriving it is how a campaign resumed by a fresh agent quietly
  retargets itself at the default branch halfway through.
- The status column is the resuming agent's whole briefing, so keep it true. A
  task left on `in-progress` by a run that stopped reads as live work and freezes
  the next agent out of it; a stopped task never given a status reads as `todo`
  and gets silently re-executed. However a ticket run ends short, write the
  status before the run is over — `paused`, `blocked-limit`, or `rejected` — and
  never re-execute a `rejected` one without a new decision from the user. A long
  unattended campaign pausing and resuming is a normal event rather than an
  incident: `paused` and `blocked-limit` are how that is recorded, and neither
  implies anything is wrong with the work.
- Create no issues and touch no project board.
- Mark a finished task's plan done in place rather than archiving it. It is never
  copied into an `archive/` or a `done/` directory: an archived plan is a second
  source of truth that immediately drifts, which is precisely why the marker goes
  in the file rather than the file going somewhere else. It is not deleted at
  completion either — it is kept for the campaign's life so a task can be
  restarted from what was asked, and the campaign's final `zz` ticket is what
  deletes every plan at the end.
- Base every decision on live Git state, never a stale snapshot.
- By default merge nothing — the user reviews and merges each pull request. That
  is the documented default, not a limit of the workflow: `--unattended`, typed
  on the invocation that acts, is the one thing that authorises the planning,
  ticket, and campaign merges. Absent it, every pull request this run opens is
  left open for the user, and a run that merges without the flag typed on it has
  exceeded what it was asked to do. The map's `Unattended: yes` never substitutes
  for the flag: it authorises nothing on its own and no operation reads it as
  authorisation. Its only effect is on generation — it decides which closing
  block the map's kickoff prompt is written with, so the next agent to resume the
  campaign is told to type the flag.
- After start, read the campaign's mode from the map, exactly like the
  integration branch and for the same reason. Do not re-derive it from whether
  the current invocation carries `--unattended`: that flag says what *this run*
  may do, while the map's line says what the *campaign* was started as, and the
  start run's answer to the second is the one that has to survive into every
  session after it.
- Under `--unattended`, exactly three merges are authorised and no more: the
  planning pull request at start, each ticket pull request (performed by `$god`
  into the campaign base branch it was given as its merge target), and the
  campaign pull request at close. The planning and campaign merges land on the
  integration branch the map records, which is the default branch only when the
  campaign named no other — so confirm each of those two pull requests is based
  on that branch before merging it, rather than trusting the base the
  pull-request workflow opened it with. Never merge a pull request this run did not open, never merge one whose
  checks are red, never force-push, and never reach for an administrator
  override — a campaign is exactly where one bad merge is multiplied. Issue a
  merge once and read the resulting state rather than re-issuing it: a merge
  already in progress is a state to inspect, pending required checks are a wait
  to re-issue as an auto-merge, and a stale base is a merge-in of the base branch
  followed by a single retry.
- If the request does not clearly name one of the five operations, ask one
  focused question rather than guessing.
- Issue branch-lifecycle operations — checkout, pull, remote-branch inspection,
  branch deletion — as individual shell calls, with status output and follow-up
  verification in separate read-only calls.
- A refusal of a pull-request merge or a remote-ref deletion is final: surface it
  and carry on with the rest of the work rather than re-expressing the same
  operation, which is refused for the same reason.
- Where more than one account is logged in, a GraphQL-backed write answers with a
  collaborator error when the active account does not own the remote. That is the
  wrong identity, not a permission to request: ask the repository helper which
  account the remote's owner is and select it.

## Closing turn

Every run states its outcome on the way out, and how it states it depends on how
the run was invoked. One mechanic decides all three cases: a message carrying
text and zero tool calls ends the assistant's turn and hands control back to the
user. That is what records an outcome, and it is also what strands a parent
pipeline when a nested run spends one.

Invoked directly by the user, this is the outermost run and it closes in a
text-only turn: one final message carrying text and zero tool calls, sent after
the last tool call returns rather than alongside it. Dispatched as a subagent, it
closes the same way, because its final message is a report to the parent session
rather than a turn in the parent's conversation. Invoked inline by another
workflow as a step of that invoker's own pipeline, it hands back without spending
a text-only turn: the report and the return marker go out as text in the same
message that carries the invoker's next tool call, so the turn continues into the
invoker's next step. A text-only turn there ends the whole assistant turn and
strands every step the invoker still owes.

Write the return marker exactly once, alone on the last line of the message that
hands control back, in all three cases — never weakened, deferred to a later
message, or dropped because the turn continues.

This step is never skipped and never delegated, and every exit routes through it:
the operation completed, nothing to do, a step blocked or refused, or the run
awaiting an answer. Lead with one self-contained line naming which operation ran
and what it changed — the integration branch, the base branch, and the planning
pull request on a start (saying whether the integration branch came from the flag
or the repository default), the
plan path on an add, the ticket pull request on an execute, the map entry on a
complete, the campaign pull request on a close — or what stopped the run.

A compaction boundary is a checkpoint, not an ending — a recap prompt, a
background-task notification, or a session-continuation preamble each mean the
run is still owed its turn, so answer in text alone, say where the run stands,
and restore the closing item if it did not survive. Each side of a boundary
records its own standing, because a run split across two transcripts is two runs
to the record. Every message from the user opens a task, and only a reply
carrying text and no tool call closes it, so answer a mid-run question,
correction, or recap in text before returning to tool calls. A reply to another
session is not that turn either: a message-sending call is still a tool call, so
send the reply, let it return, then close in text alone.
