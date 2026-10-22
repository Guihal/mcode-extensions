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

## Validate the actual artifacts

Read the current crystal and plan with available read/search tools; use a bounded shell probe
if useful. No separately named artifact-validator tool is required. This direct structural
check is distinct from judging the plan's semantics or the product's behavior.

Check crystal §1/§2/§3 and mode/depth; preserve §1 and §3. A legacy missing depth means standard.
Check PLAN `## Execution shape` (SINGLE/UNITS) and `## Files`: one absolute regular-file path
per `- write:` or `- read:` entry, with backticks when a path contains spaces. New planned write
files may be absent; directories and wildcards do not grant write scope. Only explicit write
entries grant product edits. Trivial/standard uses SINGLE; UNITS requires complex depth.

For UNITS require unique contiguous ids, earlier-id dependencies, the planner's complete unit
fields, exclusive ownership and touchpoints declared in Files. A selected unit must exist and
may write only its declared subset. PENDING/IN_PROGRESS/STALE/PASSED/BLOCKED are progress metadata,
never evidence that a gate passed.

Inspect before dependent work and after relevant edits. Fix only artifacts owned by the role;
return a sourced defect or precise missing prerequisite for other artifacts. State what was
actually checked, not a fabricated tool response. Semantic criteria still come from original
requirements; a structurally valid plan may be wrong.

## Architectural approaches

For architectural tasks (refactor, multi-module, pipeline, data-flow, web/API with an architecture)
the agent EXPLICITLY chooses an architectural approach from the tz-skill catalog and records the
choice in §2/plan: layered (transport/service/domain/repo) · pipeline stages · CLI
(entry+core+adapters) · library (pure core+thin API) · web (components+tokens) ·
refactor-isolation (no observable behaviour change). For code edits >10 lines use the `tz` skill
(TЗ first). The plan never goes beyond crystal §1.

## Reproduced defects and repair authority

Repair change-caused regressions and defects on the requested outcome's mandatory correctness
path within explicit ownership and authorization. Reproduce a suspected violation or establish
it with deciding source evidence, then fix its cause and refresh the relevant observation.
Report the defect, location and actual check. A hypothesis is not an observed bug.

If the necessary correction crosses the plan's ownership or changes a governing decision,
return to the appropriate owner before dependent edits. Critic repairs PLAN and derived §2;
implementation-critic repairs only its product scope. A newly discovered unrelated defect does
not authorize expansion. Destructive, production or security-sensitive actions obey actual
user authorization; do not invent permission or re-request consent already granted.
