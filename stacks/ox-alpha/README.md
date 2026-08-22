# ox-alpha-proxy

A transparent OpenAI Responses proxy with sanitized usage observability, rebuilt
clean-room from the recorded decisions of `codex-proxy`.

Four independently useful outcomes, delivered in order:

1. **Bike** — transparent forwarding plus one live Overview of today's tokens and cost.
2. **Car** — durable history, trends, date ranges, and model/range filters.
3. **Boat** — explicit opt-in body capture with redaction and retention, then inspection.
4. **Plane** — parity with the pinned `claude-proxy` commit.

Read [the roadmap](docs/roadmap/four-rungs-to-plane.md) and
[the decision records](docs/adrs/index.md) before changing anything.
