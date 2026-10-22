# Verdict grammar — one JSON contract

Read when a role returns. The installed roles and this skill use a single strict JSON object,
without Markdown fences, YAML verdicts, phase/additional blocks or sentinel lines.

## Common fields

- `ok`: boolean. True means the role's assigned outcome is established under its mode.
- `class`: kebab-case string; `none` for success, `blocked` for missing necessary evidence or
  capability, otherwise a sourced defect class such as `plan-defect` or `behavior-broken`.
- `feedback`: array of strings. A negative verdict contains at least one `[HARD]` or `[BLOCKED]`
  entry. HARD identifies source, location/evidence, material consequence and necessary fix;
  BLOCKED identifies the property, attempted check and missing prerequisite. At most eight
  blocking entries; combine a shared cause without hiding a material obligation.
- `repairs`: optional array of `{path, change}` for actual repairs. Empty/absent means none.
  Reviewers never disguise a repair as an unchanged positive review.
- `criteria`: required only for product-validator, with the format below.

Compact actual evidence may appear in positive feedback. Advisory style preferences do not
block and are omitted. With HARD and BLOCKED findings together use a defect class; otherwise
an unresolved evidence gap uses blocked. Missing evidence does not prove a product defect.

For normal implementation verification, including read-only standalone TASK review, true
requires no known material defect or required verification gap. Task-cycle review-only is the
explicit exception: the requested outcome is a review, so a completed inspection can have
ok true/class none while its feedback describes subject defects. MAIN must report those
findings and must not interpret that review-only result as product acceptance.

## Acceptance criteria

Product-validator additionally returns a nonempty `criteria` array. Each item contains:

- `id`: stable descriptive identifier for one essential outcome;
- `description`: the source-derived property;
- `result`: `{status: "pass"|"fail"|"unavailable", reason?}`; fail/unavailable requires a
  concrete nonempty reason;
- `evidence`: array of concise strings with `[A..E][happy|negative]`, the actual run/read
  locator and observed result or quote. Evidence levels are defined in the role contract.

The validator closes its own list before inspecting the result. A genuine product observation,
including direct semantic reading when text is the product, establishes a criterion. File
counts, grep hits or a green suite alone do not. Do not invent runtime criteria for prose.
Any fail yields ok false and a defect class; otherwise any unavailable yields ok false/class
blocked; only all pass allows ok true/class none. Required evidence must remain applicable
after the last relevant change.

## Parse and route

1. Parse actual JSON; check common field types and acceptance criteria when applicable.
2. Check consistency of ok/class, required negative findings and per-criterion aggregation.
   A well-formed object is necessary but does not prove the product claim.
3. Inspect deciding evidence before consequential reliance. MAIN keeps repair reports and
   unresolved outcomes locally for routing; never forward verdicts to a fresh reviewer.
4. If a role crashes, times out or returns malformed JSON/criteria, retry once as a fresh
   call with the same exact artifact payload. Do not add a suggested verdict. After a second
   failure report REVIEW_BLOCKED and the observed reason; it is not a passed gate.
5. A material repair requires a fresh reviewer of the current artifact. No repeat is required
   for harmless cosmetic changes or unchanged evidence. A successful implementation review
   is followed by independent product acceptance in full mode.

No validator service or machine driver is implied by this grammar. MAIN checks and routes
the actual returned data through available tools. The product-validator never repairs;
critic owns PLAN and CRYSTAL §2; implementation-critic owns only authorized product files.
