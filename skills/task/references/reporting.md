# Reporting — the final answer

Read after the acceptance gate returns PASS, or when the cycle stops for any other reason.

## Final response structure

```md
### Plan
<2-4 bullets: what the plan was, where it lives>

### Implementation
<2-4 bullets: what was actually changed, with paths>

### Result
<what the user gets, in their terms>
```

## Rules

- Report only what happened. No role names, no verdicts, no internal routing, no "the reviewer
  approved" theatre. The user sees the outcome, not the process.
- No tool-call dumps, no raw file listings, no commit hashes unless asked.
- A path in the report is clickable evidence that the work exists: link it.
- If acceptance is BLOCKED and the user accepted a blocked result, say so in one plain line:
  "Accepted with unverified: <what>". Never present a blocked result as a completed one.
- If a required step was deferred to the user, say which and why.

## Verification discipline

Distinguish three states and report each honestly:

- **verified** — you ran it and observed the result;
- **unverified** — you could not run it (no access, no environment, too costly); say what would
  verify it;
- **not applicable** — nothing to verify.

Never write "tests pass" for a suite you did not run, "fixed" for a defect you did not reproduce, or
"all good" for a result you did not observe. A build, a typecheck and a green suite prove those
signals and nothing else: the product works only when you exercised the real scenario and watched
it behave.

## Unverified list

If anything stayed unverified, list it explicitly with the reason. Silence here reads as a false
claim of completion.
