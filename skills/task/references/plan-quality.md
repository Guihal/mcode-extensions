# Plan quality — what a plan may contain

Read before dispatching `planner`, and when the critic rejects a plan on `plan-no-code`.

## Plan = plan, not code

The plan file is a plan, not the project. It describes **what and how**, never the implementation
itself.

- Plan content: concrete action steps (what to do, in which order) + optional code-free architecture
  docs: ADR (context → decision → consequences) per key decision; module layout (per file/module —
  path, responsibility, interface signatures).
- Forbidden: function bodies, SQL, full snippets, implementation code. Signatures and contracts are
  allowed; implementations are not. Up to 10 lines of code at once are tolerated ONLY as a
  signature/interface illustration — never an implementation.
- If a code file is needed, create it as a real project file at its real path during the
  implementation phase; the plan only references it (path + purpose + interface).
- Order: extract the plan down to concrete actions through the plan gate FIRST; write code only
  after the plan is accepted.

The plan must parse before it is handed off: run the artifact check on the crystal and the plan
after every edit and fix every returned problem. A plan that does not parse is not a deliverable —
quote the check's `ok`, error and hint in the report. Typical defects: a unit touchpoint missing
from `## Files`, UNITS under a crystal that is not `task-depth: complex`, a Files line that is not
`- write: /abs` or `- read: /abs`.

## Architectural approaches

For architectural tasks (refactor, multi-module, pipeline, data-flow, web/API with an architecture)
the agent EXPLICITLY chooses an architectural approach from the tz-skill catalog and records the
choice in §2/plan: layered (transport/service/domain/repo) · pipeline stages · CLI
(entry+core+adapters) · library (pure core+thin API) · web (components+tokens) ·
refactor-isolation (no observable behaviour change). For code edits >10 lines use the `tz` skill
(TЗ first). The plan never goes beyond crystal §1.

## Reproducible bugs are always in scope

While implementing, ANY bug that can be REPRODUCED (a command, test or scenario that shows the
wrong behaviour) is fixed immediately — regardless of module, distance from the task, or an "out of
scope" section in the plan. Out-of-scope is NOT a valid reason to leave it unfixed: (1) search —
inspect the code around what you modify; (2) reproduce — get a command or test that shows the wrong
behaviour; (3) fix — in the same diff, never in a TODO and never "next task"; (4) record — name it
on its own line in the final report and in the bug ledger `~/plans/<crystal-stem>.bugs.md`: what
was wrong, where, how it was fixed, what reproduces it. Such fixes are NEVER scope-creep and
reviewers must not reject them as out-of-scope. A bug that could not be reproduced is a hypothesis:
name it in the report, do not fix it. The only exception is a fix that itself needs a risk-tier
action (DB migration, prod, security perimeter, destructive op) — confirm with the user first.
