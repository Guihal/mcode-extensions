# Existing MiniMax extension ports: behavior and compatibility

This document describes the four existing packages: `control-task`,
`agent-state`, `injection-rules` and `probe-hook`. It distinguishes durable
behavior, model guidance and the limits of MiniMax Code's native hook interface.
Installation and upgrade commands are in the [README](../README.md#install-or-upgrade).

## Supported environment

All owned hook and MCP entrypoints execute with **Bun 1.4.3** on **Linux x64,
little endian, with glibc**, Linux procfs and `/usr/bin/flock` from util-linux.
The version is pinned in [`.bun-version`](../.bun-version). Install/upgrade and
ordinary verification commands also use Bun. The `bun` executable must be on
the host's child-process `PATH`. There are no plugin package dependencies or
automatic system-package installations.

The external **`@minimax-ai/code` 0.6.12 host** declares Node
`>=22.19 <23 || >=24 <27`; its published launcher is unchanged. The offline
native checks exercise Node 22.23.3 and 24.19.0 hosts dispatching actual Bun
plugins. Node 25/26 hosts and running the complete MiniMax CLI under Bun have
not been verified here. `node:` imports inside the plugins use Bun's built-in
compatibility modules, including `node:sqlite`; they do not launch Node.

### Bounded directory reads under Bun

Bun 1.4.3's `fs.Dir` and `Glob` enumerate the full directory before yielding
entries. The shared [directory adapter](../runtime/directory.mjs) therefore
uses a narrow synchronous `bun:ffi` boundary to glibc's `opendir`, `readdir64`
and `closedir`. It copies each record before advancing and releases the stream
on exhaustion, early exit and errors. Storage still opens a safe pinned parent
descriptor first and enforces its 4,096-entry limit; the host's descriptor
inventory uses the same incremental primitive. An unsupported ABI or unavailable
native primitive yields a local unavailable outcome, without an eager fallback
or a requirement to stop unrelated work.

The verified ABI is Linux x64 glibc (tested with glibc 2.39). The adapter checks
the platform and glibc symbol boundary before reading native record fields.
Other libc/architecture combinations are not claimed as supported. Bun's
[official FFI documentation](https://bun.sh/docs/runtime/ffi) marks that API
experimental and advises against production reliance. This release uses only
the tested synchronous libc boundary and pins Bun; the focused regression
checks cover bounds, native errors, descriptor cleanup and pinned-directory
behavior. Future Bun or ABI changes require renewed compatibility checks.

The session metadata adapter depends on this host's internal V2 schema, not a
public session MCP API. A changed host version or unsupported database shape
requires a compatibility review; unavailable metadata cannot authorize parent
guide delivery. The host fixtures verify the unmodified published chunks before
exposing original functions in disposable copies. See the
[native integration fixture](../tests/mcode-ports-host.test.mjs) and
[shared adapter](../runtime/host.mjs).

| Package | Version | Native tools |
| --- | --- | --- |
| `control-task` | 0.2.2 | `control_task_get`, `control_task_set`, `control_task_patch`, optional `control_task_confirm` |
| `agent-state` | 0.2.2 | `agent_state_note`, `agent_state_checkpoint` |
| `injection-rules` | 0.2.1 | Hook delivery; no MCP server |
| `probe-hook` | 0.1.1 | `probe_echo`, disabled through packaged configuration by default |

## Why a tool first returns pending

MiniMax can share one plugin MCP process between independent main sessions and
children. Its raw MCP requests contain a tool name and arguments, without a
trusted calling session. The MCP process's working directory, home, request ID
and a last-active file cannot establish the caller. `agent_id` is also distinct
from `session_id`.

The two stateful plugins therefore validate arguments and return a versioned
`pending_host_commit` receipt. The text explicitly says that it is **not a
successful read or write**. The receipt contains the plugin, operation, UUID,
creation time and digest of validated arguments; it contains no task-body copy
or model-selected session.

The matching native `PostToolUse` hook validates the complete tool name,
host-provided plugin/server/tool metadata, nested error status, receipt shape
and argument digest. It then performs the session operation using the trusted
hook `session_id`, `cwd`, `turn_id` and `tool_use_id`. The result is appended to
that tool's existing content and identifies its operation, receipt and definite
status. The original tool content and standing reminders remain present.

| Observed result | Meaning |
| --- | --- |
| Pending receipt only | No completed read/write is established. The required hook result is missing or unavailable. |
| Definitive committed result | The operation's durable write was confirmed. |
| Rejected or unchanged result | No new requested mutation was admitted; the result gives the relevant reason. |
| Unavailable result | The operation could not establish the required state or capability. Absence is not inferred from an error. |
| Partial or uncertain result | The result names what committed and what remains unresolved; it never erases an earlier commit by calling the whole operation unsuccessful. |

Native `additionalContext` appends text. It cannot replace the initial MCP
result or retroactively change its `isError` flag. Read the matching definitive
text when determining the storage outcome. A direct external MCP client without
these MiniMax hooks receives only pending receipts and cannot use the stateful
tools to retrieve or mutate session files. A hook failure leaves that pending
response visibly unresolved. The transport and envelope contracts are in
[transport.mjs](../runtime/transport.mjs) and [host.mjs](../runtime/host.mjs).

The two memory obligations are to update changed requirements after user input
and save new useful reusable knowledge before compaction. Their reminders do
not add a general completion or confirmation gate. Every storage outcome is
local to that operation. The matching hook runs automatically
within the native tool-result path; the model does not need another call to
confirm it. Pending, rejected, unavailable, partial or uncertain storage never
requires a retry, read-back, repaired store or successful save before continuing
the authorized primary task or finishing the response. Report unresolved
persistence honestly when it matters to the requested outcome.

## Complete task and reconciliation

`taskBody` is ordinary free text representing the **complete durable task**.
It retains the requested outcome; all applicable explicit requirements;
grounded implied requirements with their basis and source; constraints; result
conditions; task-specific rules; and source-of-truth references. An inference
stays identified as an inference. A material unresolved assumption retains its
uncertainty, basis or missing evidence. Repeated agent text does not turn a guess
into a user instruction.

Faithful user acceptance conditions belong in the task. A derived condition can
also belong there when its basis is recorded. Inventing a narrower completion
checklist that ends the requested work early does not. Original user and project
instructions keep their actual priority; the stored agent-written task is
derived advice, not a higher-priority instruction channel.

For example, a fictional import task might contain the following prose. These
labels illustrate distinctions; they are **not** a mandatory taxonomy or schema.

```text
Repair the existing CSV importer for the invoicing workflow.
Explicit requirement: preserve the accepted CSV columns and date format.
Source: the user's import brief, Compatibility section.
Grounded implied requirement: retrying a failed import must not duplicate rows.
Basis: the user requires retry of the same file; source: the brief's Retry section.
Constraint: retain existing imported invoices during the repair.
Result condition: the corrected example imports successfully and an invalid row
has an actionable error, as requested in the brief's Examples section.
Open assumption: examples use UTF-8, but support for other encodings is not yet
established. Confirm the supported encoding contract before relying on it.
```

The model identifies and writes this content. The plugin supplies guidance,
retains the supplied complete body, records raw observations and explicit
optional review decisions, and restores the body and observation counters. It does not extract implied
requirements automatically or use a keyword classifier to decide whether prose
is semantically complete. Valid arguments, a saved fixture and a zero unreviewed-input
counter do not prove model understanding or obedience. The tool guidance and
reconciliation behavior are checked separately in
[control-task tests](../tests/control-task.test.mjs).

### Preserve requirements without mandatory bookkeeping calls

Each actual native `UserPromptSubmit` invocation appends the raw prompt under
the session lock and advances a local `inputRevision`. It does **not** replace
the task body. The delivered reminder explicitly requires updating the durable
task for requirements the user added, changed or canceled. When a clarification changes the durable definition, preserve
earlier requirements and qualifications that still apply and change only what
that clarification changes or cancels. Ordinary steering can carry a real
requirement. If the task remains unchanged, continue without an extra tool call.
An input counter records observations; it does not impose a completion gate.

`control_task_get` is available when the current body or original input is
needed, including after compaction. Its optional `inputFromRevision` and
`inputLimit` request original observations in a bounded range, with exact
locators for retained text. Reading material already available in context is
not a mandatory prerequisite for every edit or following action.

`set` requires only `taskBody`; `reason` is optional on `set`, `patch` and
`confirm`, with omission stored as an empty rationale. Optional
`reviewedInputRevision` states only the observations actually considered.
Omitting it does not silently clear the unreviewed count. `patch` requires
`expectedRevision` and a nonempty list of at most 128 operations.
Its `match`/`after` anchors must select exactly one trimmed line after CRLF
normalization. Missing or ambiguous anchors and stale revisions reject the
whole patch. `add` appends when `after` is omitted. Each accepted material edit
stores a full new task revision. Identical resulting content creates no body
revision, but the same `set` or valid `patch` can record explicitly supplied,
monotonically advanced review coverage. No separate confirmation is needed.
Older coverage cannot reduce progress; future coverage, stale task revisions
and failed patches cannot record review progress. A later concurrent input
remains visible as unreviewed. Optional `confirm` records the unchanged-task
review through the exact current input revision; it does not change the body
and cannot clear observations with a stale or future value. Exact schemas and limits are in
[control-task-core.mjs](../plugins/control-task/scripts/control-task-core.mjs).

The native host omits producer identity, final acceptance and a unique per-input
event identifier. Multiple steering inputs may share one `turn_id`; two
intentional identical inputs can have byte-identical hook payloads. Both are
retained. A replay may conservatively add another observation because the
projection cannot distinguish it from a real repeated input. These counters
describe **observed prompt occurrences**, not an exact-once count of accepted
human messages. SessionStart, compaction and tool-result text never become
synthetic prompt observations.

### Revisions, original locators and unobstructed completion

Task views distinguish current, not set and unavailable. The full canonical
body is delivered when it fits its native envelope and combined-context
allocation. Otherwise the result gives an explicit complete-original body
location and revision. It never silently clips the body or reconstructs it
from a compaction summary.

`#taskRevision=N` and `#inputRevision=N` are logical selectors. Resolve them
through the active arrays or the archive ranges in the canonical file and
`input-locations.json`; they are not array offsets. A stale derived index does
not replace the canonical file as the authority. Original task and prompt text
remain in current records or immutable archive segments.

`control-task` has no Stop/SubagentStop registrations or continuation-budget
machinery. Direct invocation at either unsupported boundary emits nothing.
An unset or unreadable task, an unreviewed input and a failed operation never
force another turn or prevent the next tool or final response. Existing
`checkpoint.json` files are retained unchanged and ignored. This also avoids
the native host's treatment of plain Stop `additionalContext` as a continuation.
The probe's optional Stop logging emits no context, including on failure.

## Reusable guides

`agent_state_note` creates an own guide or edits an existing own guide by exact
`note_id`. Same-title different-content creates retain the established suffix
behavior. File selection and the read/choose/write sequence share one session
lock. An edit cannot target a parent's guide, a path escape, symlink or special
file. `agent_state_checkpoint` uses one stable private
`optional-compatibility-guide.md`; earlier suffixed checkpoint files are
retained during upgrade.

Guide policy covers reusable procedures, verified tool/environment facts,
diagnostic recipes, observed failures and evidenced fixes. It excludes current
task state and progress, and keeps uncertain explanations uncertain. Shape and
file-boundary validation do not semantically classify every note. The policy
and tools are in [agent-state-core.mjs](../plugins/agent-state/scripts/agent-state-core.mjs).

Collection includes own guides and only **shared guides from the verified
current immediate parent**. A sharing declaration must be in the supported
header; a body mentioning `shared: true`, a missing header or an invalid header
does not grant sharing. Siblings, grandparents, private parent notes and other
sessions sharing a workspace are excluded.

The reader obtains the exact child and at most its one parent from
`local_runtime_sessions` with `columnar_version = 3`, using a read-only
transaction. It validates the child's current workspace against trusted hook
`cwd`; the native parent may legitimately have a different workspace. It
validates the safely opened database inode, reads current native columns and
does not scan sessions, parse transcripts or trust compatibility `record_json`.
Unavailable parent metadata preserves own-guide delivery with an explicit
diagnostic and retries later. The original workspace binding remains recorded;
only a matching current native row can establish a later workspace transition.
Guide storage stays keyed by session ID throughout.

Content freshness includes full admitted file content, path/order and sharing
state. A same-length edit or sharing change can therefore refresh delivery.
The plugin hashes admitted files in bounded chunks, including bytes beyond the
delivered prefix. A manually oversized file remains retained with a readable
bounded prefix, original locator and partial/freshness-unavailable status. A
partial collection never becomes a complete cached digest.

Guides restore on session/subagent start, resume and verified successful
compaction. Successful own saves deliver the updated guides without consuming
the ordinary cadence. Completed other-tool events advance the default cadence
of 10; startup and UserPromptSubmit do not. User input can still discover changed
parent guides. Failed compaction does not reset cadence or claim restoration.
The policy and reminders require saving new useful reusable knowledge before
compaction. An ordinary cadence count does not invent knowledge or demand a
save at that exact count. No successful result, read-back or retry is required
before the next task action or final response. Missing or failed delivery stays
local to the extension. See
[delivery logic](../plugins/agent-state/scripts/agent-state-delivery.mjs) and
[guide scenarios](../tests/agent-state.test.mjs).

### Exact pre-compaction saving: host capability limit

An early mandatory instruction and a guaranteed model save immediately before
compaction are different properties. MiniMax0.6.12 accepts `decision: "block"`
at PreCompact as a one-time deferral, but rejects `additionalContext` there.
The automatic compaction caller drops the reason and system message before
provider-context preparation. The model receives its previous messages, and
the next automatic attempt is admitted despite another block. The manual
boundary returns a deferral reason without scheduling a model/tool turn.

The original host parser, actual command hook, compaction-admission method and
provider-context preparation are exercised in
[mcode-host-contract.test.mjs](../tests/mcode-host-contract.test.mjs). This
proves the missing opportunity to request a save, not autonomous model behavior.
Queuing a reminder for the next PostToolUse is too late: the next automatic
compaction can happen before the model sees that result. Rewriting existing
guide bytes also does not capture new knowledge from the full conversation.

The shipped plugin retains the mandatory before-compaction policy on supported
delivery surfaces and installs no ineffective PreCompact blocker. A guaranteed
last-moment save remains unavailable until the host supplies a pre-compaction
model/tool opportunity. The extension does not claim that startup or periodic
reminders establish that guarantee.

## Existing data, failures and retries

`<dataDir>` below is the host's effective native data directory. Stateful hooks
derive it only from the verified `PLUGIN_DATA` shape
`<dataDir>/v2/plugin-data/hooks/<plugin>`. A model cannot choose these paths.

| Data | Preserved/current location |
| --- | --- |
| Canonical task | `<dataDir>/v2/plugin-data/hooks/control-task/control-task/sessions/<id>.json` |
| Task backup, archives and original locator index | The adjacent `<id>/` directory; any old `checkpoint.json` is untouched and ignored |
| Original own guides | `<dataDir>/v2/plugin-data/hooks/agent-state/agent-state/sessions/<id>/*.md` |
| Guide delivery/recovery state and locator index | `.agent-state.json` and `.guide-locators.json` inside the own guide directory |
| Enabled probe metadata | `<dataDir>/v2/plugin-data/hooks/probe-hook/probe.log` and `tool-calls.log` |

The legacy unversioned task record `{sessionId, taskBody, updatedAt}` remains
readable. Before conversion, its exact bytes are preserved by an exclusively
created immutable `legacy.json`. Existing Markdown filenames and bytes remain
until an authorized note edit. Old `active.json` pointers and legacy cadence
files are retained for inspection; active pointers no longer address storage,
and old prompt counts are not reinterpreted as completed-tool counts.

Missing files alone establish absence. Empty, malformed, wrong-version,
identity-mismatched, unsafe or unreadable state is unavailable and is not
silently replaced with an empty store. Such files are preserved for explicit
recovery, with their original location and error code reported. Recovery is
not a precondition for unrelated tools or final reporting. An interrupted
archive/index write keeps the previous canonical state valid or returns an
explicit recovery/partial result.

Storage uses safe regular-file access, bounded reads, fsynced atomic writes and
cross-process kernel flock. Lock acquisition has a two-second deadline and a
2.5-second helper termination limit; ownership releases on descriptor close or
process death, without stale-age lock theft. Failure before a file replacement
is distinguished from uncertain durability after replacement. A committed
guide remains authoritative when a later derived locator/delivery update fails.
See [storage.mjs](../runtime/storage.mjs).

Native PostToolUse callbacks can repeat. Stores retain operation identity and
outcomes under their session lock. They inspect a matching durable completion
or unresolved pending record **before** the 60-second receipt admission deadline
(with five seconds of clock-skew allowance). A known completion returns its
recorded outcome; an interrupted guide save recovers its chosen target/digest
without blindly repeating the mutation. An unknown expired receipt cannot
start new work and does not prove that no earlier invocation ever committed.
A changed operation under a reused trusted tool-use ID is rejected. Unresolved
pending records are never evicted to make room for new mutations.

An unresolved guide write reserves only its target filename. With a usable
journal, another guide can still be saved; automatic new-guide naming skips
reserved filenames. An explicit edit to the same unresolved target returns a
local unavailable result and preserves its bytes and recovery record. An
unreadable or unwriteable journal remains a local storage failure, without
forcing agent continuation or automatically replacing uncertain history.

## Bounds and diagnostic behavior

| Boundary | Limit/behavior |
| --- | --- |
| MCP input | 1 MiB per JSON-RPC line; 64 admitted requests in flight |
| Hook input/output | 1 MiB input; complete emitted JSON line below 60 KiB UTF-8 |
| Native host context | Separate 64 KiB-character merge limit; task/guide allocations reserve room for shipped standing rules |
| Task body | 12,000 JavaScript characters; valid Unicode, no silent truncation |
| Current task/archive storage | 16 MiB per file; at most 64 archive segments per session |
| Guide title/body/checkpoint | 200 title characters; 128 KiB body; 80,000-byte checkpoint |
| Guide collection | 4,096 directory entries; 512 own guides; 1,024 own-plus-parent guides |
| Full guide hashing | 256 KiB per file, 256 MiB per collection event; oversized originals remain partial |
| Retained operation records | At most 1,024 per session; pending mutations remain retained |
| Shared diagnostic logs | Metadata records at most 512 bytes; 128 KiB log plus one `.previous` file |

When all complete guide paths cannot fit the hook envelope, a durable bounded
locator index carries them. That index contains original paths, not summarized
replacement bodies. Limits reject growth before discarding primary task/guide
data. Diagnostics identify event/error codes and safe operation/session/location
metadata without logging prompts, task bodies, tool arguments/results or guide
contents. Diagnostic-write failure does not replace the primary outcome.

## Rule delivery and remaining host limits

All nine shipped standing-rule bodies remain enabled at supported session and
subagent start/restore boundaries. `70-reasoning-poison` also supplies a reminder
on every executed `PostToolUse`, including execution failures, and on every new
input. Delivery appends context while preserving the original text, images and
errors. Rule overrides, apply/exclusion selectors and legacy input-cadence
semantics are preserved. See [the existing rule review](reasoning-rules-review.md)
and [rule tests](../tests/injection-rules.test.mjs).

| Pi purpose / requested property | MiniMax implementation or evidenced limit |
| --- | --- |
| Caller-owned task and guides | Trusted PostToolUse owner; shared MCP transports never select a session |
| Full task with explicit and implied requirements | Free-text authoring guidance, full revisions, raw observations and optional review tracking; no automatic semantic extraction guarantee |
| Atomic patch and unchanged branch | Revision-checked anchored patch; unchanged text needs no follow-up call; optional exact-input confirmation remains compatible |
| Durable original guide recovery | Own files, safe writes, immediate-parent shared collection, content freshness and full originals/locators |
| Repeated guide reminders | Completed-other-tool cadence and successful-save delivery |
| Startup/resume/compact recovery | Available native lifecycle context; successful compact restores originals |
| One ephemeral fresh guide copy per provider call | Unavailable: hooks append conversation context and do not replace every provider/system message |
| Trustworthy near-context-threshold warning | Unavailable: native payloads expose no usable usage/window/reserve facts; no text-length estimate substitutes for them |
| Rich-compaction snapshot priority | No corresponding installed consumer on this hook stack; no unused cache pretends to supply it |
| Exactly-once accepted human-input capture | Unavailable from the native projection; raw observed occurrences are retained conservatively |
| Required memory reminders | Mandatory changed-requirement update after user input; mandatory policy to save new useful knowledge before compaction |
| Exact save opportunity immediately before compaction | Unavailable: native PreCompact deferral does not deliver a model/tool turn; early reminders do not guarantee timing |
| Unobstructed extension use and completion | No task Stop/SubagentStop continuation; review counters and ordinary cadence create no gate; local storage failure leaves other tools and final reporting available |
| Reminder for every rejected tool attempt | Early validation/permission/unknown-tool failures and unexecuted aborted-batch remainder can bypass PostToolUse |
| Model compliance or live installation | Offline persistence/delivery tests do not establish model obedience or installation in a user's running session |

`PostCompact` cannot itself deliver native additional context; automatic and
manual compact restoration use `SessionStart` with compact source. Errors thrown
during tool execution can reach PostToolUse, whereas failures before actual
execution may not. The published raw-MCP `PreToolUse` updatedInput route also
fails second validation, and hook failure is fail-open. It is not used as an
identity bridge. These are host capabilities and limits, not opportunities to
guess session identity or report an unobserved success.

## Verification

From the repository root:

```sh
bun scripts/sync-plugin-runtime.mjs --check
bun scripts/test.mjs
```

The ordinary runner starts each test file in its own serial Bun test process,
with an adequate test-harness timeout; product hook and lock deadlines remain
unchanged. The suite covers bounded transport and storage; original-state
compatibility; task patch/reconciliation/recovery; guide ownership, freshness
and cadence; disabled/enabled probe behavior; copied standalone packages and
exact role tool selections; and existing rule delivery. Tests inspect subprocess
JSON, actual retained files, returned context and bounded logs. The shared test
helper explicitly labels constructed payload/schema fixtures as such.

The separate opt-in check requires the published package and its dependencies
already present at an absolute path:

```sh
MCODE_HOST_PACKAGE=/absolute/path/to/minimax-code-0.6.12/package \
  MCODE_BUN_BINARY="$(command -v bun)" \
  node --test tests/mcode-host-contract.test.mjs tests/mcode-ports-host.test.mjs
```

Those fixtures use actual native package discovery/materialization, MCP
discovery/adapter execution, hook commands, lifecycle/steering/stop routing,
role parsing/capability assembly and skill loading. They preserve the original
Node host code while checking the Bun executable of native MCP children and
Bun runtime metadata captured before the real hook engine imports. They use
isolated data with no provider API. The current
native metadata writer's unavailable `better-sqlite3` binary is not simulated
as a successful live writer: fixtures use actual native codecs/DDL with built-in
SQLite for controlled session rows.

CI installs the pinned Bun and runs the full ordinary suite. The ordinary
runner lists native-host tests as a separate command; they require
`MCODE_HOST_PACKAGE` and the selected Bun binary and are not counted as native
evidence unless actually executed. A local successful run does not establish that GitHub Actions
executed; billing or service availability must be reported from the actual run.
Likewise, fixture bodies prove retention and delivery of supplied content; direct
tool/hook guidance checks prove the shipped policy text is exposed. Neither is
a live-model test of requirement extraction or future behavior.
