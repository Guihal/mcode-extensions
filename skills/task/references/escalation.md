# Escalation — depth ladder, triggers, no-cap rule

Read when picking depth and whenever a `trivial` task starts to grow.

## Depth

- `trivial` — bounded mechanical work: one file, one obvious change, no design choice. MAIN may
  implement it directly.
- `standard` — interacting behaviour: several files, a design choice, a reviewable result.
- `complex` — dependent outcomes or consequential recovery: several units depend on each other, or
  a failure has to be recovered without losing prior work.

Depth is a floor, not a ceiling: a task that starts `trivial` and grows escalates. Downgrading
mid-task is not a thing.

## Auto-escalate (no judgement needed)

Escalate if ANY of:

- the task description contains keywords from the trigger list (architecture, refactor, pipeline,
  data-flow, security, more than one layer);
- changes a module boundary, ADR, public API or extension hook;
- introduces a new data flow between layers (transport / service / domain / repo / port);
- touches auth, secrets, XSS, CSRF, SQLi, weak crypto, or any security-sensitive surface;
- is a refactor (rewriting without changing observable behaviour).

## Risk escalates, volume does not

A task escalates because it hits a trigger above, never because it feels uncertain or spans several
files. The cost runs both ways: a wrong plan passing an unrepaired critic is a defect, and the
full reviewer set spent on a small local edit is a defect of the same cycle. A `trivial` task still
goes through the acceptance gate (`implementation-critic` → `product-validator`) and through the
no-cap rule below.

### What does NOT escalate

- depth `trivial` AND none of the risk triggers above is hit — however many files the change
  spans, and however unsure it feels.

## Mechanics

Escalation changes the reviewer set, never the repair semantics: the critic still repairs the
plan, the implementation-critic still repairs the code, the product-validator still never repairs.
The crystal, the plan and the verdict files stay where they are.

## No-cap rule

There is no automatic cap on rounds. A cycle continues while it makes progress; it stops when the
acceptance passes, when the user says stop, or when an unresolved prerequisite is reported. A
repeated FAIL on the same criterion twice in a row is a signal to change route (back to the plan),
not a reason to stop.
