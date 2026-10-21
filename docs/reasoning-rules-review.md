# Reasoning rules: evidence, decisions and delivery

## Current delivery update — 2026-10-21

The existing engine now supports `remind.every_n_tools` and
`remind.send_full_rule`. Rule 70 selects its complete current `body` on every
third completed tool-hook event and on each new input; its body includes
`ОБЯЗАТЕЛЬНО СЛЕДУЙ ДОСЛОВНО ЭТОМУ ПРАВИЛУ`. Startup, child start and
compaction still restore full standing bodies. Per-session tool counts are
independent of prompt counts and protected by a bounded inherited-fd `flock`
through their atomic update. Error results count; corrupt state is preserved
and diagnosed, without suppressing stateless rules.

The archive review and original verification below describe the earlier
151-word, every-tool suffix implementation. The current cadence supersedes
that delivery setting; the substantive reasoning invariant remains intact.

## Scope

This change makes the general reasoning-poison invariant available from the first
decision, after compaction, in child agents, and after every tool result delivered
through the host's `PostToolUse` event. It also
clarifies existing rules using a user-supplied session archive. Prompt content and
delivery are separate properties: proving that a reminder reaches model context
does not prove a reduction in model reasoning, latency or error rate.

The archive contained 95 exported `messages.jsonl` files with 2,940 records:
1,288 assistant, 1,464 tool results, 158 user, 2 compaction summaries and 28 custom
records. Its database manifest reported 3,128 message rows; the exported-record
count is used here without assuming why those representations differ. All sessions
were indexed and selected substantial trajectories and capability probes were read
in sequence. The sample includes deliberate probes, corrections and unfinished
runs, so it is not a representative model benchmark.

Private transcripts, paths, session identifiers, credentials and task artifacts are
not included in this repository. The cases below preserve only the behavior needed
to evaluate the rules.

## Observed failure modes and counterexamples

| Case | Deciding observation | General problem | Boundary preserved by the rule |
| --- | --- | --- | --- |
| A: delayed status | A user requested progress. A tool returned build success and deployment in progress. The agent then issued a command starting with `sleep 270` instead of reporting that status; the operation was aborted and the user asked again. | A supported answer was postponed behind another wait. | A necessary fresh status lookup remains valid. Report the last observed state, then continue the authorized task. The configured wait is not an assertion that all 270 seconds elapsed. |
| B: declared action differs from actual call | The agent announced that it was using the write tool, but emitted a read call. No write call appeared in that probe; a shell had created the file. | Intent and previous explanation hardened into a claim about execution. | An announcement is not execution. The current tool schema and actual returned result establish different properties. |
| C: substituted capability probe | A probe required a named editing mechanism or a missing-tool report. After dispatch failure, the agent produced the desired bytes through a shell replacement and initially called all steps complete. One such run used 83 tool calls. | Matching the final artifact did not establish the mechanism under test. | A shell can be a valid implementation method when the mechanism is not part of the requirement. Follow an explicit probe failure branch instead of silently changing the test. |
| D: disproved premise survives | A latency investigation recognized that intervals between model responses include tool time, then used those intervals again to infer model overhead and generation speed. | Correcting a premise did not invalidate the dependent calculation and final explanation. | More samples do not repair the wrong observable. Report what was measured and the remaining confounding. |
| E: first response becomes an overall verdict | A one-response comparison labeled tool-bearing responses as silent, including responses with text. Later runtime evidence showed an answer after tools, but the report still generalized to no textual answer. | A stage-specific metric was reported as an end-to-end property. | One call can establish a one-call task. It cannot establish unobserved later stages merely by being labeled a benchmark. |

A similar missing-edit probe finished in three calls, preserved the original file
and reported the unavailable mechanism. This is a useful counterexample to the idea
that a missing tool necessarily causes a long investigation. Different prompts and
roles were involved; it is not a controlled estimate of any rule's effect.

Not every additional check in the long sessions was redundant. Some inspected new
libraries, consumers or mutable deployment state, and some repeated verification
after a relevant change. The rules therefore preserve necessary discovery,
validation and justified bounded retries.

The archive also exposed environment facts that prompt text cannot repair, including
missing tool dispatch and a tool response naming a different session's guide-store
target. The latter establishes a response inconsistency, not the cause or the actual
on-disk write. Neither is treated as evidence that the model itself changed another
session's state. An archive ending at a tool result also does not establish abandonment.

## Changes to the existing rules

| Rule | Decision | Reason and limits |
| --- | --- | --- |
| 70: reasoning poison | Preserve the fallible-reasoning invariant; add explicit applicability, observed-action, provenance and dependent-conclusion checks. Deliver a full body on startup/compaction and a 151-word reminder on every input and `PostToolUse` event. | Reuse current evidence instead of repeating discovery. A supported user answer is a ready action too. A result not inspected is unverified, not automatically a failure. Preserve authority, granted permission, real invariants and the complete outcome. |
| 71: user outcome | Add property-preserving fallbacks and stage-specific evidence. Promote the standing text into the startup body. | A workaround must preserve the tested property. Do not generalize an isolated observation to an unobserved broader result. |
| 74: context frontier | Replace maximum-source and repository-closure language with discovery of task-relevant owners, contracts and affected dependencies. | Existing 70/76 and the critic role already permit evidence reuse and bounded reads. One authoritative source can establish its own property; a global requirement still needs systematic coverage. An unavailable graph tool does not block equivalent inspection. |
| 76: execution progress | Add adaptation after errors, bounded capability-probe scope, and prompt answers to direct questions before optional waits. | Real environment-repair tasks may continue diagnosis. Transient errors may justify bounded equivalent retries. Answer from evidence and continue the original task; do not invent a status or drop required gates. |
| 17, 68, 72, 73, 75 | Preserve their substantive instructions and make startup/subagent delivery explicit. Where the old body was only a pointer, promote the existing full text. Correct cadence descriptions. | These are delivery changes, not new behavioral requirements. Existing role exclusions still apply. |
| AGENTS.md | Align the global core with the reviewed evidence, fallback and direct-question distinctions. | This is also available as global context; actual hook delivery is verified separately. |

The change to 74 resolves an instruction conflict. No structured tool call containing
`frontier` was found across the archive, so these observations do **not** establish
that rule 74 caused the loops.

Two independent subagents reviewed every proposed body, reminder and delivery flag,
and the AGENTS.md changes, against archive evidence and counterexamples. Both accepted
the final texts after three substantive corrections:

1. An uninspected result **does not establish success**; it is not proof of failure.
2. An isolated call may satisfy the whole request; the prohibition is unsupported
   generalization to other properties or stages.
3. Adapting to an error may include a justified bounded transient retry; it does not
   require inventing a changed hypothesis for every failure.

The original check on inferred structural necessity remains in the full 70 body.
It applies when the model infers that a structural change is necessary, without
reopening an explicitly authorized requirement. No fixed thinking-token, tool-count
or source-count limit was introduced.

## Delivery contract

The host contract is verified against the official
[`@minimax-ai/code` 0.6.12 package](https://www.npmjs.com/package/@minimax-ai/code/v/0.6.12).
The plugin uses its **MINIMAX-format** hooks, not assumed compatibility with another
agent's similarly named events.

- `SessionStart` accepts `hookSpecificOutput.additionalContext`. Full bodies are
  restored for startup, resume, plugin activation and `source: "compact"`.
- `SubagentStart` supplies child identity and accepts additional context for the
  child. Child tool payloads also carry the type. The MINIMAX serializer strips it
  from restored `SessionStart` payloads, so the engine persists the known identity
  at startup and restores it by session ID for selectors and `send_on_subagent`.
- `UserPromptSubmit` supplies input reminders. `every_n_turns` retains its actual
  legacy meaning: accepted user-prompt events per session. It does not count model
  responses, tools or startup events.
- `PostToolUse` appends `every_tool` context after the original result, including
  execution-error results. It does not replace text/images, change arguments, report a failed
  call as successful, or deduplicate calls in a batch.
- Automatic compaction calls `SessionStart(source=compact)` and creates a model-visible
  custom context message. Manual compaction marks the session for the same startup
  reinjection before its next turn. `PostCompact` itself rejects additional context.

Every-tool reminders are stateless: no turn-counter writes or success-log growth
on that path. Legacy prompt counters use separate hashed session paths and atomic
writes so independent sessions cannot overwrite each other. A corrupt/unwritable
counter cannot fabricate cadence or suppress stateless reminders. Invalid rules and
payloads produce bounded diagnostics without copying prompts, arguments or results.

Rule flags remain configurable. A deliberate custom opt-out is respected, and a
user rule with the same name overrides the bundled default. The shipped set enables
all full bodies at root and child startup. A child-only rule also survives child
resume/compaction even when it is disabled for the main agent, while its saved
identity is available. An unknown, missing or corrupt identity on restore permits
only rules applicable to every role (wildcard, no exclusions, both startup policies
enabled), plus a diagnostic. This preserves the general reasoning-poison reminder
without inventing a main-agent identity. A new session after upgrade establishes
the identity needed for role-specific restoration.

### Events the host does not emit

MiniMax Code 0.6.12 looks up the tool and validates its arguments before its
`beforeToolCall` hook. Unknown names and invalid arguments return an immediate
result. The executor skips `afterToolCall` for such results; permission/hook
rejections and calls left unexecuted by an aborted batch can also bypass it.
Neither adding a `PreToolUse` reminder nor inventing `PostToolUseFailure` would
cover those paths. Exceptions thrown during actual execution do pass through
`afterToolCall` and `PostToolUse`.

The extension therefore guarantees a reminder for each delivered `PostToolUse`
event, not for every rejected model attempt. Startup/input standing guidance is
still available, but a fresh reminder after each early rejection needs an upstream
runtime change. This boundary matters for the missing-tool loops in the archive.

## Verification and practical limits

Run `node --test tests/injection-rules.test.mjs` for the dependency-free suite. It
executes the actual commands from `hooks.json` in isolated directories, including
the shipped rules, malformed input, rule overrides, child opt-outs, compaction,
tool errors, legacy migration and concurrent sessions. CI runs this suite on Node
22 and 24.

The additional host-contract probe executes the official parser, hook runner and
lifecycle using local deterministic tool results. It establishes context delivery
without requesting a model response. It pins both package version and the SHA-256
of the published runtime chunk. A temporary copy exposes its private functions;
the implementation under test is unchanged. Test rule/state directories are isolated.

With Node 22 (22.19 or newer) or Node 24, install the optional host into a temporary directory and run:

```sh
MCODE_PROBE_DIR="$(mktemp -d)"
npm install --prefix "$MCODE_PROBE_DIR" --ignore-scripts --no-audit --no-fund @minimax-ai/code@0.6.12
MCODE_HOST_PACKAGE="$MCODE_PROBE_DIR/node_modules/@minimax-ai/code" \
  node --test tests/mcode-host-contract.test.mjs tests/injection-rules.test.mjs
```

The combined verification passed **22 tests with no skips** on Node 24.19.0:
15 ordinary tests, 6 host-contract subtests, and their enclosing host test. An
independent code review reproduced that result. The host probe exercises normal
startup, restart/resume, automatic and manual compaction, child compaction with the
serializer's missing role field, unknown-identity restoration, batched tool results,
preserved text/images, actual invocation exceptions, and early tool rejections that
bypass hooks. Without `MCODE_HOST_PACKAGE`, the host probe explicitly skips.

The per-tool suffix contains 151 whitespace-separated words, including its heading.
This is a text size, not a claim about the provider's tokenization. Full standing text
is restored at lifecycle boundaries; each ordinary tool result carries only the
compact every-tool reminder.

Actual model compliance, reasoning tokens and elapsed task time remain empirical
properties. A useful follow-up comparison would keep tasks, model/version, effort,
tool availability and initial state fixed, then compare completed requirements,
unsupported claims, repeated ineffective calls, answer delay, token usage and total
time. This change establishes delivery and reviewed semantics; it does not claim
that a prompting change has already achieved a measured speedup.
