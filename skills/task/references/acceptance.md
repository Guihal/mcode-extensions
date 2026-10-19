# Acceptance gate

Read after the implementation gate returns `ok=true`, before the task is called done.

## Acceptance gate

The acceptance gate is the final review step. After the implementation gate passes, MAIN invokes
`product-validator` — an independent acceptance reviewer — to check that the user actually got the
result they asked for, not that the code is "good". Code review and acceptance are different
questions and are asked by different roles.

### Trigger

Full mode only, after the implementation verdict returns `ok=true`. Plan-only and reviewer modes
skip it.

### Call contract

MAIN calls `product-validator` with the crystal path only — exactly `CRYSTAL: <absolute path>`. It
receives no plan, no implementation summary, no diff, no worker/critic results and no prior
verdicts — no path to them, no errand to go read them: the essential user outcomes come from
§1/§2/§3 of the crystal, the delivered product itself is the rest of the evidence. The
product-validator verifies the result independently, hunting for "false completion" — a result
answered by a claim instead of by a run.

The criteria are the product-validator's own: it derives them from §1 of the crystal, the plan and
the result, and closes the list **before** it opens the result. The crystal intentionally has no
acceptance field; MAIN never preloads the product-validator with a checklist.

Every criterion comes back as `{ id, description, result: { status: "pass" | "fail" |
"unavailable", reason? } }`, and each one is carried by an evidence line in `additional` whose
second field opens with a **kind marker**:

- `- <id> :: run: <command> :: <output>` — evidence by execution;
- `- <id> :: read: <path>:<lines> :: <quote>` — evidence by reading, equal in standing to `run:`;
  a file task is proved by the file, not by an invented command;
- `- <id> :: sanity: <command> :: <output>` — the technical run (suite green, file parses, daemon
  starts). It is the sanity minimum, **not** the acceptance.

The marker is mandatory on **every** line of an accepted acceptance, and a verdict whose lines are
all `sanity:` does not close the gate. A counter, a grep count or a filled-in checklist is never
the sole ground for `ok: true`; its place is a `sanity:` line. `fail` and `unavailable` items must
carry a non-empty reason.

### Verdict aggregation

- any `fail` → **FAIL**
- any `unavailable` and no `fail` → **BLOCKED**
- otherwise → **PASS**

### Routing

- **PASS** → finish the task and report.
- **FAIL** → back to the implementation loop with explicit "acceptance failed" feedback: the
  violated criteria and the required fixes. Then a new implementation review, then a fresh
  acceptance round.
- **BLOCKED** → MAIN decides on the spot (no user escalation by default): either start a new
  acceptance round, or finish with an explicit "accept-blocked" line in the final response.
- **BLOCKED with every failing item carrying the rule `unverifiable`** → give the
  product-validator the missing access and run it again, or stop and report to the user. It is
  never counted as a pass.
- The same criterion id failing **twice in a row** points at the plan, not at the code: go back to
  the plan loop (planner with the acceptance verdict as the evidence). That is a change of route,
  not a cap.

### Quote spot-check

Before routing a PASS, MAIN spot-checks each read: for every
`- <id> :: read: <path>:<lines> :: <quote>` line, one `grep -F` with a fragment of the quote
against the named path. A quote that is not in the file makes the verdict unfit for evaluation —
that is a **FAIL of the acceptance and a new round**, not a rejected record.

### From the second acceptance round on, compare the lists

The product-validator arrives fresh each round and never sees the history, so its new list may
simply omit a criterion that was red last time — and a PASS would be issued on a defect nobody
rechecked. Before routing a PASS, MAIN compares the new criteria list with the **red criteria from
the previous round** (`fail` and `unavailable`): a criterion that was red and is absent now means a
new round with an explicit demand to cover it, or an escalation to the user — never a PASS. The
memory lives with MAIN, who routes the rounds; the product-validator stays without history.

### Verifier failure handling

If the product-validator call itself fails (crash, timeout, malformed verdict, empty items):

- retry ONCE with the same inputs;
- on the second failure, record a single synthetic item
  `{ id: "product-validator-self", description: "product-validator failed", result: { status: "unavailable", reason: "<stderr / timeout / parse error>" } }`
  — that yields BLOCKED. Do not escalate to the user by default;
- report the failure honestly in the final response.

Retries do not consume anything. Verifier failure is BLOCKED, never FAIL — a broken reviewer is
not evidence that the work is wrong.

### Budget

One acceptance round per implementation review. On repeated FAIL the cycle continues under the
regular rule: no cap (see [escalation.md](escalation.md)).
