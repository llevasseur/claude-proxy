---
name: wayfinder
description: >
  Run a wayfinder — a named campaign of related work tracked entirely in markdown under
  docs/plans/, with no GitHub issues. Cuts a per-session base branch, keeps a map of active
  plans, executes each task on a branch based off that branch, and on task completion deletes
  the plan and appends a summary to the map. Invoke on "/wayfinder", "start a wayfinder",
  "add a task to the wayfinder", "complete a task", "close the wayfinder", or when planning a
  multi-task effort that should NOT go through GitHub issues.
---

# wayfinder

A **wayfinder** is a named campaign of related work — several tasks that ship together — tracked
entirely in markdown inside the repo. It exists to plan and execute multi-task efforts **without
GitHub issues or the project board**: fewer moving layers for agents, everything reviewable in a
diff.

**Announce at start:** "I'm using the wayfinder skill." Then state which operation you're running
(start / add task / execute / complete task / close).

---

## Mental model

- One wayfinder = one **base branch** `wayfinder/<slug>` cut from `main`.
- One wayfinder = one **map** file `docs/plans/wayfinder-<slug>.md` that lists its active plans and
  logs its completed tasks.
- Each task = one **plan** file `docs/plans/<slug>-NN-<task-slug>.md` (written with the
  `writing-plans` skill) and one **task branch** `task/<slug>-NN-<task-slug>` cut from the base
  branch. **Every task branch and PR targets the base branch — never `main` directly.**
- Everything under `docs/plans/` for a wayfinder is **ephemeral scaffolding**. The durable record
  of the work is the merged code plus the spec/feature docs in `docs/specs/`, `docs/adrs/`,
  and `docs/features/`. When the wayfinder closes, the map and every plan it created are deleted.

```
main
 └── wayfinder/<slug>              (base branch — accumulates all tasks)
      ├── task/<slug>-01-...       (--base wayfinder/<slug>)
      ├── task/<slug>-02-...       (--base wayfinder/<slug>)
      └── ...                      → one PR wayfinder/<slug> → main at the end
```

---

## Operations

Pick the operation that matches the request. Each is idempotent-friendly: re-read the map first,
act, then regenerate the docs index.

### 1. Start a wayfinder

1. Pick a short kebab-case **slug** (e.g. `auth-revamp`). Confirm it with the user if ambiguous.
2. From an up-to-date `main`, cut the base branch:
   ```bash
   git switch main && git pull --ff-only
   git switch -c wayfinder/<slug>
   ```
3. Create the map at `docs/plans/wayfinder-<slug>.md` using the **Map template** below.
4. Add an instantiated **Agent kickoff prompt** to the map using the template below.
5. Regenerate the docs index (see *Index upkeep*), then report the base branch, map path, and kickoff
   prompt. Keep the prompt plain-language and provider-neutral so it can be pasted into any agent CLI.

Do **not** create GitHub issues, labels, or project-board items. That is the layer this skill
replaces.

#### Agent kickoff prompt

Add this section to a new map after the goal and before **Active tasks**. Replace every placeholder;
do not mention a specific model, provider, agent product, or product-specific slash command.

````markdown
## Agent kickoff prompt

Paste this into an agent CLI from the repository root to begin or resume execution:

```text
Continue the `<slug>` wayfinder in this repository.

Read the repository instructions, the wayfinder skill at <skill-path>, and the campaign map at
docs/plans/wayfinder-<slug>.md. Inspect the live Git and worktree state before making changes.

Execute the next unblocked active task from the map. Read its linked plan completely, create its task
branch from `wayfinder/<slug>`, mark it in progress, and implement only that task. Follow all repository
verification, documentation, commit, and visual-proof requirements. Open a pull request from the task
branch into `wayfinder/<slug>`; never target the default branch and never merge the pull request.

When reporting back, include the task completed, verification results, pull-request link, and any
remaining risks or decisions. Stop after opening the pull request so a human can review it.
```
````

Use the repository-relative location of this skill for `<skill-path>` — in this repo,
`.claude/skills/wayfinder/SKILL.md`. If every active task is blocked, report the blocking dependency
instead of starting unrelated work. If no active tasks remain, report that the campaign is ready for
the close operation.

### 2. Add a task (plan) to the wayfinder

1. Read the map to get the next task number `NN`.
2. Write the plan with the **writing-plans** skill, saving it as `docs/plans/<slug>-NN-<task-slug>.md`
   (pass this exact path so it lands beside the map, not at a dated filename).
3. Add a row to the map's **Active tasks** table: number, task slug, plan link, target branch
   `task/<slug>-NN-<task-slug>`, status `todo`.
4. Regenerate the docs index. Report the new task and its plan path.

### 3. Execute a task

1. Read the task's plan file for full context.
2. Cut the task branch **from the base branch**:
   ```bash
   git switch wayfinder/<slug> && git switch -c task/<slug>-NN-<task-slug>
   ```
3. Mark the task `in-progress` in the map.
4. Implement per the plan. Before finishing, run the repo's verification from the root and confirm it
   passes: `pnpm typecheck && pnpm test && pnpm build` (each runs `-r --if-present` across the
   workspace). Match surrounding code conventions — note `proxy/proxy.mjs` is a zero-dependency Node
   pass-through (built-ins only), `packages/core` is the pure/tested lib, and any `apps/admin`
   frontend change wants a screenshot.
5. Open the PR **against the base branch**, not `main`. Prefer the `/pr` skill; pass the base
   explicitly. Raw fallback:
   ```bash
   gh pr create --base wayfinder/<slug> --head task/<slug>-NN-<task-slug> \
     --title "<task title>" --body "Part of wayfinder <slug>. <summary>"
   ```
   Do not auto-merge — the user reviews every PR.

### 4. Complete a task

Run this after a task's PR merges into the base branch. This is the step that keeps the map honest.

1. Ensure the base branch has the merged work (`git switch wayfinder/<slug> && git pull --ff-only`
   if the PR merged on the remote; otherwise merge the task branch locally).
2. **Delete the plan file:** `git rm docs/plans/<slug>-NN-<task-slug>.md`.
3. **Append a summary** to the map's **Completed** section — a dated, self-contained entry
   describing what was *actually built* (not the original plan): the change, the key files touched,
   any follow-ups or deviations. Use the **Completed entry template** below.
4. **Remove the task's row** from the **Active tasks** table.
5. Regenerate the docs index and commit the map + deletion together on the base branch.

### 5. Close the wayfinder

Run when every task is complete and the durable docs exist.

1. Confirm each completed task produced its durable artifacts: updated/added feature doc in
   `docs/features/`, and any spec/decision docs in `docs/specs/` or `docs/adrs/`. The
   map's Completed log is scaffolding, not the deliverable — the real record must live in those docs
   and the merged code.
2. Open **one** PR from `wayfinder/<slug>` → `main` summarizing the whole campaign (link the map's
   Completed log in the body). Do not auto-merge.
3. **After that PR merges**, delete all wayfinder scaffolding:
   ```bash
   git switch main && git pull --ff-only
   git rm docs/plans/wayfinder-<slug>.md docs/plans/<slug>-*.md 2>/dev/null || true
   ```
   Regenerate the docs index, commit ("chore: retire <slug> wayfinder scaffolding"), and open a
   small follow-up PR (or fold into the campaign PR if not yet merged). Delete the base branch:
   `git branch -d wayfinder/<slug>` and `git push origin --delete wayfinder/<slug>`.

---

## Map template

Write to `docs/plans/wayfinder-<slug>.md`:

```markdown
---
type: reference
title: Wayfinder — <Human Name>
description: Active markdown-tracked campaign; base branch wayfinder/<slug>. Ephemeral — deleted on close.
tags: [wayfinder, planning]
timestamp: YYYY-MM-DD
---

# Wayfinder — <Human Name>

**Slug:** `<slug>`
**Base branch:** `wayfinder/<slug>` (cut from `main`; all task branches and PRs target it)
**Started:** YYYY-MM-DD
**Goal:** <one sentence — what this campaign ships>

> Ephemeral scaffolding. This file and every `docs/plans/<slug>-*.md` plan are deleted when the
> wayfinder closes. Durable output lives in the merged code and the docs/features + docs/specs docs.

## Active tasks

| # | Task | Plan | Branch | Status |
|---|------|------|--------|--------|
| 01 | <task slug> | [<slug>-01-...](<slug>-01-....md) | `task/<slug>-01-...` | todo |

## Completed

<!-- newest first; each entry appended on task completion -->
```

## Completed entry template

Append under the map's **Completed** heading when a task finishes:

```markdown
### <slug>-NN — <task title> · YYYY-MM-DD

**Built:** <what actually shipped, 1–3 sentences>
**Key files:** `path/one.ts`, `path/two.tsx`
**Docs:** <feature/spec doc added or updated, or "none">
**Follow-ups / deviations:** <anything left, or "none">
```

---

## Index upkeep

`docs/plans/` participates in the okq docs index. Any time you add or delete a plan or the map,
regenerate and verify from the repo root:

```bash
okq index --bundle docs           # regenerate listings
okq index --bundle docs --check   # must exit 0 before you consider the step done
```

Commit the regenerated `index.md` alongside the change. Expect churn here — the wayfinder folder is
deliberately fast-moving.

---

## Guardrails

- **Never target `main`** from a task branch — always `--base wayfinder/<slug>`. Only the single
  campaign PR at close targets `main`. (No batch merges onto `main`.)
- **No GitHub issues / project board.** This skill is the replacement for that flow; don't call the
  `github-issues` skill or `gh project` commands as part of a wayfinder.
- **Delete on completion, don't archive.** A completed task's plan is removed and distilled into the
  map's Completed log; the closed wayfinder's map is removed once feature/spec docs carry the record.
- **Base every decision on live git state** (`git rev-parse --abbrev-ref HEAD`), never a stale
  snapshot. Confirm you're on the intended branch before cutting a new one.
- **Do not auto-merge** any PR — the user reviews and approves each one.
