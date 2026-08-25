# `@agent-proxy/shared`

The landing site for code that all three stacks converge on. It is **empty on
purpose**, and this campaign promotes nothing into it.

## What it is for

`stacks/claude`, `stacks/codex` and `stacks/ox-alpha` each carry their own copy of
work that is substantially the same idea three times over — session parsing, usage
accounting, the shape of an audit sidecar. Convergence is the point of fusing the
three repositories, but it is not the point of *this* campaign, which moves code
without changing what it does. So the directory exists now and stays empty: a later
campaign that lifts one of those duplications has somewhere to put it that was
agreed on in advance, rather than inventing a location under time pressure and
picking whichever stack's version happened to be open.

## Why it is empty rather than absent

An empty directory would not survive a clone, and a package created at the moment
it is first needed is a package whose name, scope and place in the workspace get
decided as a side effect of some other change. Declaring it here settles those
three things while nothing depends on the answer.

**Promoting something into this package is a deliberate act with its own ticket.**
Three stacks reading one module means a change here can break all three at once,
which is exactly the coupling the stacks currently do not have. Nothing should
arrive here as a drive-by extraction.

## The no-op scripts

`package.json` declares `typecheck`, `test` and `build` that exit 0 rather than
declaring no scripts at all.

The root scripts run `pnpm -r --if-present`, which already tolerates a package with
nothing to run — so for `pnpm verify` these are redundant. They are here for the
bare form: `stacks/ox-alpha/package.json` still runs `pnpm -r typecheck` with no
`--if-present`, inherited from ox's own repository, and `pnpm -r` resolves against
the root workspace, so it reaches this package. Without the scripts, adding this
directory would break a command that worked before the merge — a regression this
campaign creates rather than one it inherits.

Delete them when real code arrives and brings real scripts with it.
