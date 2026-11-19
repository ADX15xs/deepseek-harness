# Agent Note: Chat snapshot tail-append fast path

Status: implemented

English | [中文](2026-11-19-chat-tail-append-fast-path.zh.md)

## Problem

A single Turn accumulating many Steps pays per-Step cost proportional to the loaded node count in the Chat snapshot builder: every flush with a new node re-filters and re-sorts the whole visible set under `turnProcessPresentations`, rebuilds the whole location index, and rebuilds the whole Turn rail. The 0.2.2 assembler hotfix removed the Context-replay quadratic in `ui-conversation`, so the builder passes became the dominant remaining cost; the 1600-Step single-Turn probe spent about 5.2–6.3 seconds of projection on the dev machine, with per-Step cost still growing linearly.

## Decision

`ChatSnapshotBuilder.apply` classifies each upsert batch and installs it through a verified tail-append path whenever the classification proves it safe: every structural change is a brand-new node, no `turn-process` upsert escapes the cached control identity, and every appended visible node provably sorts after the presentation tail. Verification reads a per-Turn state map (`controlKey`, `controlAnchorSeq`, `openingInputAnchor`) seeded by the full presentation pass and advanced in place by appends; the opening-input anchor is safe to advance incrementally because appended anchors only grow. The install pushes the appended block into the order, extends `MutableChatLocationIndex` positions and Turn/Step lists, and folds the appended nodes into `MutableTurnNavigationIndex` rail items, which re-derive only when a Turn gains its first rail item or a user input.

Everything the verification cannot prove falls back to the full presentation pass, which also reseeds the state: a structural change to an existing node (kind, anchor, visibility, group, location), a control materializing or changing its opening anchor, a control at the tail, or an appended node sorting before the tail — pulled rank-2 nodes included. `earliestProcessAnchor` is deliberately absent from the state: it feeds only the control's rank -1 placement, and it is not monotone under visibility flips, so tracking it would make the verification lie.

## Alternatives considered

**Constant-factor tuning of the full pass.** Precomputing sort keys would shrink the per-Step constant but keep the quadratic total; at 1600 Steps the tail per-Step cost stays on the same growth curve.

**Fully incremental process presentations, including `earliestProcessAnchor`.** The control's rank -1 placement depends on the earliest process candidate, which visibility flips can lower; maintaining it incrementally would need invalidation on every visibility change. Excluding it from the fast-path state keeps the rare full pass as the single source of truth.

**A persistent order structure to avoid the per-flush array copy.** The copy is linear with a memcpy-scale constant, next to the removed O(N log N) comparator sort; a rope or persistent list would add reader-facing complexity for no measured gain.

## Consequences

Live append flushes cost O(appended) plus one order-array copy; the measured 1600-Step probe dropped from 5.18s to about 3.7–4.0s mounted and from 6.28s to about 3.4–3.5s bare on the same dev machine, with the same behavior tests and recorded-session snapshots passing unchanged. The per-Step cost still grows with the loaded node count through channels this decision does not own: `derivePresentation` scans the whole Turn and per-key process sources republish when the Turn's spec object changes, the legacy slice re-sorts all finalized contributions, `locations.touch` scans Turn membership, and the `ui-conversation` location index still scans boundary-owned seqs per boundary. Browser-side row virtualization remains a separate decision that needs its own browser evidence.
