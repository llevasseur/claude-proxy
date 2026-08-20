---
type: plan
title: Bike release 04 — Overview dashboard
description: Deliver one responsive TanStack/Vite overview using claude-proxy's exact visual system.
tags: [planning, dashboard, overview, visual]
timestamp: 2026-08-19
wayfinder: bike-release
task: 04
status: todo
---

# Bike release 04 — Overview dashboard

## Outcome

Ship the Bike user interface: one responsive Overview page with the shared rail,
title shell, live-status treatment, and stat cards for today's input tokens,
output tokens, and cost.

## Dependencies

Tasks 01 and 03. Run only after the server API contract is green.

## Owned paths

This ticket alone owns `apps/admin/index.html`, `apps/admin/src/**`,
`apps/admin/public/**`, and dashboard visual-verification artifacts under
`apps/admin/visual-proof/**`. It may update `apps/admin/README.md`. It MUST NOT
edit workspace manifests, the lockfile, core, proxy, server, or durable
cross-project docs.

## Requirements

- Use React, TanStack Router, TanStack Query, and Vite as configured by task 01.
  Register exactly one application route, `/`, titled `Overview`.
- Reuse the visual system from `claude-proxy` exactly. Copy the applicable token,
  base, shell, card, badge/status, and stat-card CSS from commit
  `cc25696504e724bd78824e639e97a0a1d846abea` without altering token names or
  values. Add only codex-proxy-specific composition rules that use those tokens;
  do not fork the palette, spacing, type, radius, motion, or theme contracts.
- Render the responsive application shell: `codex / proxy` brand, a rail with
  one active Overview station, a mobile drawer/toggle treatment, theme control,
  page title `Overview`, and a compact subtitle stating Today and the active
  report timezone.
- Show a visible system/live treatment derived from the health and SSE state:
  live, reconnecting, stale/degraded, and unavailable. Use accessible text and
  `aria-live`; do not communicate status by color alone.
- Bootstrap from `/api/health` and `/api/summary`, then subscribe to
  `/api/events`. Update visible values without a page refresh. Reconnect with the
  server's event ID/retry contract and periodically refetch as a backstop.
- Render separate stat cards for Input tokens, Output tokens, and Cost. Token
  values use locale-safe integer formatting. Complete cost uses its currency and
  stable precision; unavailable cost says `Unavailable` with the API reason and
  never renders `$0`.
- Provide deliberate empty, loading, error, and no-traffic-yet states without
  layout shift. A server/API failure may not erase the page shell or the last
  known summary.
- Preserve the source system's dark/light initialization before first paint,
  keyboard focus, reduced motion, responsive rail behavior, and semantic
  heading order. Avoid animations that do not explain a state transition.
- Keep Bike to this one page. Do not add history, charts, filters, body capture,
  session inspection, operator workflows, or placeholder nav stations for later
  phases.

## Acceptance criteria

- The app has one route and one nav station, both Overview, with the requested
  title and brand.
- Input tokens, output tokens, and cost render from the server contract and
  update from a real SSE event without reload. Unavailable cost is explicit and
  cannot be mistaken for zero.
- Live, reconnecting, stale/degraded, offline, loading, empty, and populated
  states are accessible and visually stable.
- The copied CSS token values match the pinned claude-proxy files byte-for-byte;
  added CSS uses named tokens for spacing, type, radius, color, and motion.
- At desktop and narrow/mobile widths, the rail/drawer, title, cards, focus
  treatment, light theme, dark theme, and reduced-motion behavior are usable
  without overflow or obscured content.
- The app typechecks and builds with no console errors or failed network requests
  in a healthy local stack.

## Verification

- Run the admin typecheck and production build, then the root check and aggregate
  verifier.
- Compare hashes or a zero diff for the copied pinned style-system files. Grep
  emitted CSS to prove the copied custom properties and added composition rules
  survive the build.
- Start the actual proxy fixture, server, and Vite client; read the bound ports
  from startup output. Confirm the supported browser backend immediately.
- In the browser, capture visual proof at desktop and narrow/mobile widths for
  dark and light themes, populated live data, no-traffic empty state,
  unavailable cost, and disconnected/reconnecting status. Exercise the mobile
  rail in both opening and closing directions and verify keyboard focus.
- Trigger a new fixture response and record that all three stat cards/status
  update through SSE without reloading. Check browser console and network logs.
