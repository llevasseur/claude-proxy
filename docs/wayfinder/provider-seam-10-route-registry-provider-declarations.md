# provider-seam-10 — Every route module declares the providers it supports

**Wayfinder:** `provider-seam`
**Branch:** `task/provider-seam-10-route-registry-provider-declarations`
**Status:** done · 2026-08-25

The **data side** of the provider picker. Independent of the spine by file scope — it
touches only claude's admin route modules — so it may run in the first wave. The picker
itself is a later campaign; this lands what it will read.

## Criteria

1. **Every route module declares which providers it supports, as data beside its `nav`**, in
   `stacks/claude/admin/src/routes/`. The registry at `routes/registry.ts` is a
   **hand-written list** of the route modules — there is **no file-based routing and no
   generated route tree** — so a declaration is a field on the module, and the registry is
   the list that collects them.

2. **Model-agnostic pages declare all providers.** Ideas, Concepts, Notes and the rest of
   the agnostic surface are not a provider's data, so per
   [ADR 0041](../adrs/0041-provider-picker-drives-the-navigation.md) they neither disappear
   from the rail nor trigger the redirect.

3. **One source, read by three consumers**: the side rail, the redirect guard, and the docs
   scope filter. Do not create a second list for any of them.

4. **Three things are load-bearing rather than style, and breaking them degrades type
   safety silently:**
   - `ROUTES` and the rail's `STATIONS` stay `as const`. A plain array literal widens to a
     union array, the route tree loses which paths exist, and `<Link to>` and
     `useParams({ from })` silently stop checking.
   - A `nav` stays `as const satisfies NavEntry`, **never** `: NavEntry`. The annotation
     widens `to` to `string` and `<Link to>` stops rejecting a bad path.
   - The import cycle between `registry`, the page files and `route-root` is **deliberate
     and benign** — every edge is read lazily. Do not "fix" it.

5. **Section order stays in `NAV_SECTION_ORDER`** in `stacks/claude/admin/src/routes/nav.ts`,
   and station order stays the registry's own order. A page in no section exports no `nav`.

6. **Remove nothing.** Every page that exists today still exists and still renders. A page a
   provider does not support is **absent from the rail for that provider**, not deleted —
   and per 0041 it is absent rather than greyed out, because a disabled row invites a click
   that cannot work.

7. **`typecheck` is claude's admin's only gate** — it has no test suite — so the type-level
   guarantees in criterion 4 are the verification. Add a type-level assertion that a
   widened `nav` fails to compile if that is expressible.

8. `my-command-tools verify` green.
