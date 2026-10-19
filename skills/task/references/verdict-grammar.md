# Verdict grammar — reviewer verdicts

Read when a verdict lands and has to be turned into a gate decision.

Every reviewer emits exactly one MD block, last line `<<<VERDICT-END>>>`:

```md
ok: <bool>
phase: <plan|implementation|acceptance>
feedback: |
<empty body when ok=true; otherwise one issue per line in [sev]rule-name @location → fix format>
additional: |
<optional freeform MD; OMIT this key entirely when empty>
```

- `feedback` is empty (or absent) when `ok=true`.
- Exception — the critic's `additional` is always present. It carries the coverage-annotation
  block, so it is non-empty by definition, and the critic writes `additional:` **before**
  `feedback:`. The block's format lives in the role definition, not here. For roles whose
  `additional` is genuinely empty sometimes (`product-validator`) the rule above stands unchanged.
- Severity-gated: `medium` / `high` / `critical` block; `low` / nit are dropped. `ok: false`
  requires at least one `medium`+ issue — a verdict that rejects on nits is malformed.
- Max 8 feedback lines.
- Parser grammar `^\[(medium|high|critical)\]([\w-]+)\s+@(.+?)\s+→\s+(.+)$`.
- An `acceptance` verdict with `ok: true` must carry at least one evidence line in `additional`,
  and the second field of **every** such line opens with a kind marker:

  ```text
  - <criterion id> :: run: <command> :: <its actual output>
  - <criterion id> :: read: <path>:<lines> :: <the quote standing there>
  - <criterion id> :: sanity: <command> :: <its actual output>
  ```

  `read:` is a full-fledged form, equal in standing to `run:` — a task whose result lives in a
  file is proved by the file, not by an invented command. `sanity:` is the technical run (suite
  green, file parses, daemon starts): at least one line must be **not** `sanity:`, because a sanity
  run does not close the acceptance gate.

- Never put the sequence `::` (space colon colon space) inside a field of an evidence line: the
  parser is non-greedy on the second field and the field boundary would move. Inside a quote write
  `::` without spaces, or cut with `…`.

## Parsing reviewer output

Parse the block line by line:

1. Read top-level `ok:` (lowercase `true`/`false`) and `phase:` (echoes the phase asked for).
2. Read the `feedback:` block. It may be **absent**, **present with an empty body** (both mean "no
   blocking issues"; accept when `ok: true`), or **present with content** — then each non-blank
   line, after stripping the leading block indent (typically 2 spaces), must match the grammar
   above. Stop at the next top-level key or EOF.
3. Read `additional:` if present — freeform MD, no required structure.
4. If `ok:`, `phase:` or the feedback grammar is missing or invalid, retry the same reviewer once:

   ```text
   RETRY: Previous verdict was not parseable MD. Overwrite VERDICT_FILE with exactly one
   MD verdict block with top-level keys ok / phase / feedback, plus additional — for a
   critic verdict additional is mandatory and repeats the same coverage annotation, for
   other roles include it when non-empty. Last line <<<VERDICT-END>>>.
   ```

   Re-spawn the same role; a fresh instance of that role, not a different one.
5. If the retry also fails, the gate is **not passed**: report `REVIEW_BLOCKED` and stop. An
   unparseable verdict is a missing verdict — never treat it as approval and never finish the task
   on it.

## Repair semantics

The verdict is not the whole gate. In this cycle the gate outcome depends on what the reviewer did
with the artifact:

- the **critic** repairs the plan itself; a rejected plan means the artifact was rewritten and the
  verdict carries the remaining blocking issues. A plan is not accepted until a critic verdict on
  the current plan says `ok: true`;
- the **implementation-critic** repairs the declared product files itself; its verdict reports what
  it repaired and what still blocks;
- the **product-validator** never repairs. Its verdict alone decides the acceptance gate.
