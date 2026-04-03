# Memspec Reality Check

This document validates the current Memspec v0.1 against a real agent memory system: OpenClaw workspace memory used in daily operation.

The goal is simple:

1. Take real memory items from the running system
2. Express them using Memspec's current model
3. Record where fidelity is lost

## Test Set

The examples below come from these real files:

- `MEMORY.md`
- `memory/lessons.md`
- `memory/corrections.jsonl`
- `memory/procedures/*.md`
- `memory/YYYY-MM-DD.md`
- `memory/sessions.jsonl`
- `memory/heartbeat-state.json`

## Clean Fits

### 1. Fact

Source memory:

> B200 Darwin inference is live via sglang on 193.40.152.251:8000

Memspec representation:

```md
---
id: ms_01...
type: fact
state: active
confidence: 0.95
created: 2026-04-03T21:27:00Z
source: therin
tags: [b200, inference, darwin, runtime]
decay_after: 2026-07-02T21:27:00Z
---

# B200 Darwin inference is live

Darwin-35B is serving via sglang on 193.40.152.251:8000 with tool calling enabled.
```

Assessment: fits cleanly.

### 2. Decision

Source memory:

> Native iOS over PWA because WebKit keyboard limitations made the PWA path unacceptable.

Memspec representation:

```md
---
id: ms_01...
type: decision
state: active
confidence: 0.95
created: 2026-02-15T00:00:00Z
source: siim
tags: [ios, product, frontend]
decay_after: never
---

# Native iOS over PWA

We chose native iOS because WebKit keyboard limitations made the PWA path unacceptable.

## Alternatives
PWA was considered and rejected.
```

Assessment: fits cleanly.

### 3. Procedure

Source memory:

> A reusable workflow for weekly curation, with trigger, numbered steps, failure history, and notes.

Memspec representation:

```md
---
id: ms_01...
type: procedure
state: active
confidence: 0.90
created: 2026-04-01T08:00:00Z
source: therin
tags: [procedure, curation, weekly]
decay_after: 2026-06-30T08:00:00Z
---

# Weekly curator workflow

Run the weekly curation pass over recent memory files and update durable memory.

## Context
Used for maintaining long-term memory quality.
```

Assessment: fits cleanly.

## Friction Points

### 1. Rules / Lessons Do Not Fit

Real example:

> Never report "done" without verification output.

This is not a fact, decision, or procedure.

It behaves like a rule:

- durable
- normative
- machine-checkable
- often paired with a `verify:` pattern

Forcing it into `procedure` is a category error. A rule is not a sequence of steps.

Implication: Memspec core is missing a first-class way to represent enforceable guardrails.

### 2. Corrections Need Their Own Durable Shape

Real system behavior:

- record each correction event
- keep recurrence count
- attach a verification pattern
- auto-promote repeated corrections into lessons/rules

Memspec v0.1 supports correction as a transition, but not correction history as an operational memory object.

That means it can say "A corrected B" but not:

- how often the same failure recurred
- when it crossed a promotion threshold
- what verification check prevents recurrence

Implication: the self-correction protocol is too thin for learning systems.

### 3. Current Context Is Not Just Fact

Real example:

- PhD thesis chapter drafting
- Forus quotation automation
- B200 inference work

These are active priorities, not merely truths about the world.

Representing them as `fact` loses important semantics:

- they are retrieval-biased
- they have working-set status
- they decay differently from facts

Implication: current context is a separate memory concern, even if implemented as an extension rather than a core type.

### 4. Daily Logs Are Mixed-Semantic Bundles

Daily logs contain:

- events
- reflections
- verified state snapshots
- pending work
- mini-postmortems
- decisions in formation

Memspec observations are too narrow to represent this well.

Two bad options appear:

1. fragment the day into many tiny items
2. dump mixed semantics into a single observation

Neither is great.

Implication: the spec needs a clearer relationship between session logs and durable memory items.

### 5. Operational State Has No Home

Examples:

- session scoring
- heartbeat last-check state
- automation state files

These are memory-adjacent and often essential, but they are not knowledge items in the Memspec sense.

Implication: Memspec needs to be explicit about what it excludes, or provide a profile/extension for operational memory.

## Overspecification

### 1. "Three Types. No More."

This is clean, but too absolute.

Reality already pressures the model toward at least one additional primitive:

- `rule` or `lesson`

Possibly also:

- `context`
- `checkpoint`

Recommendation: keep 3 types in the core, allow extensions explicitly.

### 2. "No Human Gates"

This works for low-stakes capture.
It breaks down for durable promoted memory.

Selective curation is useful when:

- promoting high-impact lessons
- resolving semantic conflicts
- deciding whether a repeated correction becomes a rule

Recommendation: no human gate for capture, optional human review for promotion.

### 3. ULID-Only Filenames

Good for tooling, not ideal for humans reading repos directly.

Recommendation: require stable IDs in frontmatter, but allow human-readable filenames.

### 4. TTL Defaults As Doctrine

TTL defaults are useful.
Treating them as normative truth is not.

Some decisions are permanent architecture records. Some facts expire in hours.

Recommendation: define defaults, but move permanence/override policy into profiles.

## What This Suggests

Memspec v0.1 is strongest when read as a portable core:

- `fact`
- `decision`
- `procedure`
- file-canonical storage
- lifecycle
- correction protocol
- retrieval contract

The real-world gaps point toward a second layer:

- rule/lesson extension
- richer correction metadata
- current-context handling
- session-log integration guidance
- optional review and promotion controls

## Recommended Direction

Split the concept into two layers:

### Memspec Core

Portable convention for:

- 3 memory types
- file layout
- frontmatter schema
- lifecycle
- explicit correction
- retrieval response contract

### Memspec Extensions

Optional profiles for systems that need stronger semantics:

- rules / lessons
- context / working set
- promotion workflows
- recurrence-based correction learning
- operational memory

This keeps the spec adoptable without pretending that all real memory systems are equally simple.
