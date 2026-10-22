# Modes — authorized work and required loops

Read at entry. Preserve the user's actual mode and later explicit authorization to continue.
A request to explain or propose does not authorize product edits; already granted execution
permission does not need to be requested again.

## Plan-only

For an explicit plan-only/no-code request: frame → planner → critic, including material plan
repairs and a fresh check. End with the plan and `impl: skipped`. Product files are read-only.

## Review-only

When the requested deliverable is a review: frame → planner → critic for a bounded inspection
plan → implementation-critic with CRYSTAL task-mode review-only. No worker/product repairs and
no product-validator acceptance gate run. Read-only source/probes may establish findings.

A positive review-only verdict means the requested inspection is complete, not that the
subject is correct. Report any sourced subject defects. A missing necessary observation is
blocked. This branch does not apply to the mandatory standalone TASK verification of changes:
that gate judges the product even when the critic has no write permission.

## Full

Frame → planner → critic → implementation → implementation-critic → product-validator → report.
MAIN may implement trivial work directly; all full-mode review and acceptance gates remain.
Critic repairs only PLAN and CRYSTAL §2; implementation-critic repairs only explicit product
write scope; product-validator is read-only. A material repair receives a fresh review.
Every delegated role runs in the background with its exact source-only launch payload.
