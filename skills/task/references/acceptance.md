# Acceptance gate

Read after the implementation gate passes and before declaring full-mode completion.
Acceptance asks whether the user received the requested outcome; implementation review asks
whether the delivered change meets its contracts. Both are required in full mode, including
trivial work. Plan-only and review-only skip this product gate.

## Call and independent criteria

MAIN launches installed product-validator in the background with exactly
`CRYSTAL: <absolute path>`. It receives no PLAN, implementation summary, diff, worker/critic
report, previous criteria or verdict. Do not direct it to those materials later.

The validator derives essential outcomes from CRYSTAL §1 and designated source records,
using §2 only as provisional interpretation. It closes its criteria list before opening the
delivered result. It tests the actual user boundary where available and relevant negative paths;
for a text deliverable, directly reading and assessing the text is a real product observation.
It does not replace missing evidence with confident wording and never edits the subject.

Return the strict JSON object in [verdict-grammar.md](verdict-grammar.md), including a nonempty
criteria array with id, description, result status/reason and actual evidence. A counter,
file presence or a green suite alone cannot close a behavior criterion. State the conditions
of execution/inspection and distinguish a failed behavior from an unavailable check.

## Aggregate and route

- Any criterion fail: FAIL. Route a proven product defect to its authorized repair owner;
  route a plan/intent/ownership defect to critic. Then obtain fresh implementation review
  and a fresh acceptance call with the exact source-only payload.
- No fail but any unavailable: BLOCKED. Obtain the missing evidence/access when authorized
  or report the exact unverified outcome and why. Complete independent authorized work.
  BLOCKED is never a product pass and does not automatically require new user permission.
- Every criterion pass: PASS, subject to MAIN checking deciding evidence and preserved coverage.

Repair owners inspect current source and artifacts themselves. MAIN uses earlier verdicts to
route, not to preload a critic with a preferred explanation. Keep evidence and material source
changes discoverable through legitimate project locators, without adding review history or a
private acceptance oracle to CRYSTAL.

## Preserve unresolved outcomes across rounds

MAIN retains the previously failed or unavailable requirements. The next validator arrives
fresh and never sees that list. Before routing a new PASS, MAIN compares coverage by meaning,
not just identifiers. A previously unresolved requirement missing from the new criteria is
still unresolved: get another independent check from the same source-only input or report the
verification gap. Never accept a disappearing criterion or leak a private checklist to force it.

When the same substantive requirement fails twice, return to the plan/mechanism cause with
source-grounded inspection. This changes the action; it is not a fixed round cap or permission
to lower the criterion. Continue while a discriminating step makes progress.

## Evidence and verifier failure

Spot-check the deciding run/read evidence before routing a PASS. For a quoted file observation,
read the named section or use a targeted exact search; a nonexistent quote invalidates the
verdict, not the product itself. For a runtime claim inspect the actual result and conditions.
Refresh evidence invalidated by a relevant change; do not repeat unrelated valid checks.

If the reviewer itself crashes, times out or produces malformed/empty criteria, retry once
with the same source-only payload. A second verifier failure yields REVIEW_BLOCKED with the
observed failure. It is not proof of a product defect and cannot become a synthetic pass.
One acceptance round follows each completed implementation review; further rounds need the
concrete failure, missing evidence or relevant repair that justifies them.
