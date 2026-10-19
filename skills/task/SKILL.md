---
name: task
description: Task cycle for MiniMax Code. MAIN frames the task and dispatches isolated roles (planner, critic, worker, implementation-critic, product-validator) through the task tool. Critics repair the plan and the implementation themselves; the product-validator never repairs.
metadata:
  argument-hint: "[--depth=trivial|standard|complex] <task>"
---

# Task cycle

For an empty request show usage. Otherwise preserve the complete requested outcome and all
compatible corrections. Choose the smallest sufficient depth: `trivial` for bounded mechanical work,
`standard` for interacting behavior, `complex` for dependent outcomes or consequential recovery.
Respect an explicit depth; `light` means `trivial`.

This cycle has no machine gates. There is no preplan chain, no quorum, no crystal reviewer and no
plan verifier. The gates that remain are the roles themselves, and they are the ones that repair:
the critic fixes the plan, the implementation-critic fixes the code. The product-validator is the
one exception — it never repairs, it only judges.

## 1. Frame

Read [crystal.md](references/crystal.md) and write the source crystal. Keep §1 (user intent,
verbatim) and §3 (project context) immutable during the cycle; only §2 (agent hypotheses) is
derived advice and may be repaired.

The durable canonical task for the session lives in `mcp__control_task__control_task_set` — call
it when the task definition materially changes. It is not the crystal: the crystal is the
per-cycle source of intent, the control-task is the session-scoped anchor that survives compaction
and restarts.

Set the mode: `full`, `plan-only` or `review-only`. Review-only grants no product edits.

## 2. Plan

Dispatch `planner` with the crystal path. The planner returns a plan artifact — what and how, never
the implementation itself (see [plan-quality.md](references/plan-quality.md)). Save the plan under
`~/plans/<crystal-stem>.md`.

## 3. Plan gate — the critic repairs

Dispatch `critic` with the crystal and the plan. The critic reviews intent fidelity, plan
approach, coverage and executability, and it **repairs** what it finds: the plan artifact is
rewritten in place by the critic, and the verdict says so. A rejected plan returns to the planner
with the critic's feedback; the planner revises and the critic judges the revision again.

The critic is a reviewer, not an author: it may not widen the scope, change §1, or decide that a
requirement is out of scope. It repairs the plan against the crystal, it does not renegotiate it.

## 4. Implement

Dispatch `worker` with the accepted plan and the owned scope. The worker implements and runs the
checks it can. A task that is `trivial` may be implemented by MAIN directly — no dispatch needed.

## 5. Implementation gate — the implementation-critic repairs

Dispatch `implementation-critic` with the plan and the changed files. The implementation-critic
**repairs** the declared product files itself, in the same pass, and records what it repaired. A
defect in the plan, intent or scope is not its to fix: that returns to the critic in step 3.

Any bug that can be reproduced (a command, a test, a scenario that shows the wrong behavior) is
fixed in the same diff, regardless of module or distance from the task — see the reproducible-bug
rule in [plan-quality.md](references/plan-quality.md).

## 6. Acceptance — the product-validator does not repair

Dispatch `product-validator` with the crystal only. It derives its own criteria from §1 of the
crystal, closes the list **before** it opens the result, and verifies the user outcome
independently. It hunts false completion: a result answered by a claim instead of by a run.

The product-validator never edits anything. A FAIL returns to the implementation loop with the
violated criteria and the required fixes; then a new implementation review, then a fresh
acceptance round. A BLOCKED round is a decision for MAIN: another round, or an explicit
"accept-blocked" line in the final response. It is never counted as a pass.

Full contract: [acceptance.md](references/acceptance.md). Verdict format:
[verdict-grammar.md](references/verdict-grammar.md).

## 7. Report

Read [reporting.md](references/reporting.md) and report faithfully: what changed, what was checked
by running it, what stayed unverified and why. A running role is not completion; report unresolved
prerequisites honestly.

## Routing and depth

Read [modes.md](references/modes.md) for which loops run at all, and [escalation.md](references/escalation.md)
for when a task grows. Escalation changes the reviewer set, never the repair semantics: a critic
repairs a plan, an implementation-critic repairs code, a product-validator judges and never repairs.

## What this cycle does not do

- No preplan, no substrate/sketch/mechanism chain, no reviewer quorum.
- No crystal reviewer and no plan verifier.
- No private oracle and no manual MAIN orchestration of the role sequence.
- No `task_pipeline`-style driver: the role dispatch is the `task` tool and the artifacts are files.
