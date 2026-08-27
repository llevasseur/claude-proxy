---
type: adr
title: The headline counts wire bytes, stored per interface
description: What counts as an internet byte for stacks/net — physical interfaces only, selected at read time over per-(process,interface) raw rows.
tags: [net, collector, storage, interfaces]
timestamp: 2026-08-25
scope: net
decided-by: /dev
ratified: false
wayfinder: internet-spend
grill-round: 1
needs-human: true
---

# The headline counts wire bytes, stored per interface

> **Status: proposed — NOT ratified by a human.** This decision was proposed by
> the `/dev` workflow running unattended and has not been ratified. It defines
> what every headline number in the feature means and commits the raw schema's
> granularity before a human has seen it.

## Context

The griller's question, verbatim:

> Question 1 of ~8 — what does a byte have to have crossed to count as "internet"?
>
> On this machine right now, `nettop -P -L 1` emits one row per process with the `interface` column **empty** — `-P` collapses every interface into a single cumulative per-process counter, including `lo0`. Loopback traffic is therefore inseparable from the totals after the fact. This matters because this Mac runs three proxy stacks whose entire architecture is local processes talking to local ports … If you store the `-P` counters as-is, two things go wrong silently:
> 1. The headline "internet used" number includes every local proxy hop …
> 2. The "agent-process share" secondary series becomes mostly a meter of loopback self-traffic …

and, round 7:

> Question 7 of ~9 — does VPN traffic count once or twice? … Your Q1 mechanism sums cumulative counters across all non-loopback interfaces, so a VPN user's headline number silently reports roughly **double** their real external traffic … which would mean reversing part of your Q1 decision to *keep* an interface column in the raw schema rather than collapsing it at write time. Is that reversal accepted?

## Decision

1. **Loopback never counts.** `lo0` rows are excluded everywhere.
2. **The headline means wire bytes**: only physical network interfaces count.
   The default read-time interface filter matches `en*` (ethernet, Wi-Fi,
   USB/Thunderbolt adapters — macOS names them all `en*`). `utun*`, `awdl0`,
   `llw0`, `bridge0`, `ap1` are excluded by default. This is the ISP-equivalent
   number, which is what "avoid overuse" means against a plan limit enforced at
   the wire. VPN encapsulation overhead counts once; payload never double-counts;
   split tunnels stay correct.
3. **The raw schema stores one row per (process name, pid, interface)** with an
   explicit `interface` column, for every non-loopback interface nettop reports.
   Nothing is collapsed at write time. This amends the scoped column list
   (`timestamp, boot_epoch, process name, pid, bytes_in, bytes_out`) by adding
   `interface`.
4. **Interface-set selection is a read-time pure function** over that column, so
   history re-slices if the operator changes the policy later, and a mid-day VPN
   toggle needs no special handling. The same filter applies uniformly to totals
   and the agent share.
5. Accepted cost: under VPN, wire bytes attribute to the VPN client's process
   name rather than the originating app — a documented distortion of an already
   approximate series.

## Why not the alternatives

- Storing `nettop -P` cumulative totals as-is would count every loopback proxy
  hop several times per request and turn the agent share into a meter of the
  machine talking to itself.
- Summing all non-loopback interfaces doubles a VPN user's apparent usage —
  silently, on the one series that carries no "approximate" label.

## Needs human

The `en*` default follows directly from the stated avoid-overuse intent, but the
schema-granularity commitment (per-interface rows instead of the scoped
collapsed row) is recorded `needs-human: true`: it shapes every stored value
from the first sample onward.
