# Source crystal

MAIN writes the original intent once, before dispatching the planner. Use absolute paths and a
unique filename under `~/plans/`.

```md
# Task crystal — <slug>
> crystal-rev: 1
> task-depth: trivial|standard|complex
> depth-reason: <observed impact or uncertainty>
> task-mode: full|plan-only|review-only

## 1. User intent (verbatim)
<All relevant original messages and compatible corrections, chronologically; quote verbatim with safe code fences.>

## 2. Agent hypotheses
<Outcome, scope, constraints and material open questions, each traced to §1 or a verified governing source.>

## 3. Project context
<Source locators, repository roots and explicitly designated documents with provenance.>
```

§1 is immutable during a cycle. Append new user statements only for a new cycle with a new unique
crystal. Never rewrite earlier quotations. Use longer fences when messages contain code fences.

§2 is derived advice, not authority. Preserve quantified scope such as all/every/where applicable
with its conditions; discovered files are coverage, never a replacement for that rule. Keep coverage
OPEN until the relevant universe is exhausted with evidence. Scope exclusions require a governing
exclusion or proven independence.

Do not pre-solve the task or copy private success criteria into the crystal. User-specified
architecture, tools, paths and budgets remain legitimate sourced constraints. Locators and document
titles alone do not establish authority or current completeness.

The critic checks source fidelity before the plan and may repair §2 itself. It cannot change §1 or
project requirements. Contradictory original requirements remain visible and produce a decision
blocker. No reviewer history or pass claims go into the crystal.

The crystal and the durable session anchor are different things: the crystal is this cycle's
source of intent, the control-task is the session-scoped canonical task that survives compaction
and restarts. Do not merge them.
