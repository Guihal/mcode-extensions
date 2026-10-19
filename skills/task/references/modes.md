# Modes — which loops run at all

Read once at entry, before the crystal.

## Plan-only mode

"plan only" / "just plan" / "only plan" / "plan first" / "no code" / "don't write code":
run the plan loop with the critic gate, skip implementation. The final answer has `### Plan` only
and says `impl: skipped`.

## Reviewer mode

"task as reviewer" / "task for review", or a request to review an existing artifact: no code
unless explicitly asked afterwards; produce review feedback. Gate it like any other artifact when
the review itself is substantial.

## Full mode

Default: crystal → plan → critic gate → implementation → implementation-critic gate → acceptance →
final answer with plan and implementation summary.

Plan-only and reviewer modes never reach the implementation loop or the acceptance gate: there is
no code to write and no result to accept.
