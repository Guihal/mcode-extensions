---
name: task
description: Task cycle for MiniMax Code. MAIN frames the task and dispatches isolated roles (planner, critic, worker, implementation-critic, product-validator) through the task tool. Critics repair the plan and the implementation themselves; the product-validator never repairs.
metadata:
  argument-hint: "[--depth=trivial|standard|complex] <task>"
---

# Task cycle

For an empty request show usage. Otherwise preserve the complete requested outcome and all
compatible corrections. Read [modes.md](references/modes.md) and
[escalation.md](references/escalation.md); choose the smallest sufficient depth. Respect an
explicit depth; `light` means `trivial`. Full mode includes plan review, implementation review
and independent product acceptance at every depth. MAIN may implement trivial work directly.

MAIN routes this cycle through the real MiniMax `task` tool. There is no separate driver,
preplan chain, quorum, crystal-reviewer, plan-verifier or undeclared artifact-checking tool.
Critics repair their owned artifacts; the product-validator only judges the product.

## Dispatch and isolation

Read the current task schema. Use the exact installed `agent_name`, `description`, `prompt`,
and **run_in_background: true**. Use the supported `agent:<name>` qualifier when needed to
select the custom role rather than a colliding builtin. Do not override model/effort without
applicable authorization. Read completed results through the actual task-output interface;
a pending role is not a passed gate.

The prompt contains only the exact lines below. Descriptions are neutral role/task labels.
Pass no implementation defence, predicted verdict, worker report or previous review. Sources
and necessary locators live in the artifacts; each critic derives its criteria independently.

| Role | Exact prompt |
| --- | --- |
| planner, critic | `CRYSTAL: <absolute path>` then `PLAN: <absolute path>` |
| worker, implementation-critic | The same two lines; append `UNIT: U<n>` only for one UNITS leaf |
| product-validator | `CRYSTAL: <absolute path>` only |

These are fresh, isolated leaf calls: no inherited task dialog or nested role dispatch. Use
real installed roles, not a general-purpose agent described as one. If a required role or
capability is absent, state that gate's exact limitation and continue independent authorized
work; an ad-hoc check is not a native role pass. Existing source-backed authorization persists.

## 1. Frame

Read [crystal.md](references/crystal.md) and write the source crystal. Keep §1 (user intent,
verbatim) and §3 (project context) immutable during the cycle; only §2 (agent hypotheses) is
derived advice and may be repaired by the critic. Never insert review history or private
acceptance criteria into source artifacts.

The durable canonical task uses `mcp__control-task__control_task_set` or
`mcp__control-task__control_task_patch`; update it when the task definition materially changes. It is distinct from the per-cycle crystal. Unchanged
input needs no fabricated update; storage bookkeeping is not an extra workflow gate.
Set `task-mode` to full, plan-only or review-only.

## 2. Plan

Allocate the absolute PLAN path under `~/plans/<crystal-stem>.md` before dispatch. Read
[plan-quality.md](references/plan-quality.md), then launch planner with both paths. It writes
what and how in that file and returns JSON status, not implementation or the plan body.
The planner owns the initial draft; the critic owns later plan and §2 repairs.

## 3. Plan gate — the critic repairs

Launch critic with CRYSTAL and PLAN. It first derives the task from original sources, then
checks coverage and executability and repairs proven defects in PLAN or CRYSTAL §2. It cannot
change §1/§3, widen user scope, edit product files or renegotiate requirements.

Read the JSON result using [verdict-grammar.md](references/verdict-grammar.md). A material
repair is followed by a fresh critic on the current artifacts with the same exact payload.
Proceed only after a completed positive review of the current plan with no new material repair.
An unresolved source decision or environment gap is reported precisely, never treated as pass.
Plan-only ends here. Review-only follows its branch in modes.md.

## 4. Implement

Launch worker with CRYSTAL, the accepted PLAN and optional UNIT selector. It implements its
owned files and checks the real behavior. MAIN may do bounded trivial implementation directly;
that exception changes the author, not the later gates. Keep independent unit writes disjoint
and observe declared dependency/integration boundaries.

Repair change-caused regressions and defects on the requested outcome's mandatory correctness
path within granted ownership. A required cross-owner or plan change returns to the appropriate
owner with source evidence available in the project; a finding does not create new authority.
Unrelated work does not expand the task. The worker never dispatches its own critic.

## 5. Implementation gate — the implementation-critic repairs

Launch implementation-critic with CRYSTAL and PLAN, not a handed-down changed-file list;
append UNIT only for an assigned leaf. It discovers the actual subject and dependencies and
repairs proven defects in its explicit product scope. Intent, plan or ownership defects return
to the critic; the implementation-critic cannot edit CRYSTAL or PLAN.

After a material repair, MAIN launches a fresh implementation-critic with the same source
payload. Its `repairs` report is routing information for MAIN, not input to the next reviewer.
A completed positive review of the current result advances to acceptance. Mandatory standalone
verification outside this skill uses the role's `TASK: <absolute path>` contract; it does not
create a second task-cycle review or fictional crystal/plan.

## 6. Acceptance — the product-validator does not repair

Read [acceptance.md](references/acceptance.md). Launch product-validator with CRYSTAL only.
It fixes its source-derived criteria before observing the result, verifies the user's outcome,
and returns JSON criteria with evidence. It never edits the product or other task artifacts.

FAIL returns to the appropriate repair owner, then fresh implementation review and acceptance.
A repeated failed requirement points to its plan/mechanism cause, not a reason to lower the bar.
BLOCKED names the missing prerequisite; MAIN obtains available evidence or reports the exact
unverified outcome while completing independent authorized work. It is never a pass.

## 7. Report

Read [reporting.md](references/reporting.md). Report actual changes, runs, observations and
unverified properties. Role launch, source inspection, hook delivery and native model behavior
are distinct evidence. End once the full outcome and required gates are satisfied; repeat work
only for a relevant change, contradiction, unresolved requirement or explicit gate.

MAIN owns retries and source-grounded routing. Continue while a discriminating action makes
progress; do not repeat an unchanged failed attempt or conceal an unresolved prerequisite.
There is no fixed automatic repair-round cap and no hidden scheduler.
