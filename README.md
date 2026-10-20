# MiniMax Code extensions

Local plugins, rules, skills, agent roles, MCP servers and the global `AGENTS.md` for
[MiniMax Code](https://github.com/MiniMax-AI) (`mcode`).

Everything here is published without secrets, sessions, logs or machine-specific state.

## Install or upgrade

The existing ports target **MiniMax Code 0.6.12 on Linux**, with util-linux
`/usr/bin/flock` and the host-supported Node range `>=22.19 <23 || >=24 <27`.
Development checks have run on Node 22.23.3 and 24.19.0. The plugins need no npm
install of their own. Check the Node binary that the host will find on `PATH`:

```sh
node --version
/usr/bin/flock --version
```

Clone this repository, or update your existing checkout, then run the upgrade
block **from the checkout root**. It copies complete plugin packages, including
hidden manifests and `scripts/runtime/`, plus the 24 roles, task skill, standing
rules and `AGENTS.md`. It preserves the native `v2/plugin-data` directory and
backs up files that it replaces. Existing `mcp.json`, `config.yaml`, permissions
and credentials are left in place.

The example uses the standard data directory `~/.minimax`; when your host uses
another directory, set `MINIMAX_DATA_DIR` to its actual absolute path before
running it. The current injection-rules user-rule reader uses
`~/.minimax/rules` independently of that data-root setting. Review your own
modified rules and instructions against the backup after an upgrade.

<!-- install-upgrade -->
```sh
(
  set -eu
  mcode_data_dir="${MINIMAX_DATA_DIR:-$HOME/.minimax}"
  mcode_rules_dir="$HOME/.minimax/rules"
  mcode_backup_dir="$mcode_data_dir/extension-backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"

  node scripts/sync-plugin-runtime.mjs --check
  /usr/bin/flock --version
  mkdir -p "$mcode_backup_dir" "$mcode_data_dir/plugins" \
    "$mcode_data_dir/skills" "$mcode_data_dir/agents" "$mcode_rules_dir"
  for mcode_item in plugins skills agents AGENTS.md; do
    if [ -e "$mcode_data_dir/$mcode_item" ]; then
      cp -a "$mcode_data_dir/$mcode_item" "$mcode_backup_dir/"
    fi
  done
  cp -a "$mcode_rules_dir" "$mcode_backup_dir/user-rules"

  cp -a plugins/. "$mcode_data_dir/plugins/"
  cp -a skills/. "$mcode_data_dir/skills/"
  cp -a agents/. "$mcode_data_dir/agents/"
  cp -a rules/. "$mcode_rules_dir/"
  cp AGENTS.md "$mcode_data_dir/AGENTS.md"
)
```

Then **restart MiniMax Code or use its plugin management to rescan and reload
these complete roots**. For a separately imported plugin, reimport the complete
root. Verify the four package versions and start a new session so the expanded
hook registrations and role capabilities are loaded. Copying an individual
script, a role file or a config flag into a running cached plugin does not
establish that both the hook snapshot and the MCP process were refreshed.
The offline host tests exercise native package discovery, materialization and
MCP reload APIs; they do not certify a particular CLI reload command or an
installation in your live session.

Normal installation keeps the diagnostic probe disabled. See
[probe-hook](#probe-hook) for explicit enablement and
[the port contract](docs/existing-ports-contract.md) for state locations,
compatibility, recovery and host limits.

### Optional fresh MCP configuration

The plugins above declare their own MCP servers in their manifests. They do
**not** require replacing your user-level `mcp.json`. The repository's
`mcp.example.json` instead describes optional external services with
machine-specific executable paths.

Only if you want to initialize a **new** user MCP configuration, this separate
command expands the `<HOME>` placeholders and exclusively creates the file;
it refuses to overwrite an existing one. Review the services and local paths
before enabling them. `config.example.yaml` is reference material with redacted
credentials, not an upgrade replacement for your working configuration.

<!-- fresh-mcp-config -->
```sh
MCODE_INSTALL_DATA_DIR="${MINIMAX_DATA_DIR:-$HOME/.minimax}" node --input-type=module <<'NODE'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const directory = process.env.MCODE_INSTALL_DATA_DIR;
const template = JSON.parse(readFileSync('mcp.example.json', 'utf8'));
const rendered = JSON.stringify(template, (_key, value) =>
  typeof value === 'string' ? value.replaceAll('<HOME>', homedir()) : value, 2);
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'mcp.json'), rendered + '\n', { flag: 'wx', mode: 0o600 });
NODE
```

## Layout

```
AGENTS.md              global instructions (system prompt, 32 KiB cap)
config.example.yaml    sanitized copy of ~/.minimax/config.yaml
permission.json        global permission rules (v2 format)
mcp.example.json       template for ~/.minimax/mcp.json
rules/                 standing rules injected by injection-rules
skills/task/           task-cycle skill
agents/<name>/         custom subagent roles
plugins/<name>/        complete local plugin packages
runtime/              canonical shared boundary/storage modules
scripts/              deterministic runtime-copy synchronization
tests/                ordinary and opt-in native-host checks
docs/                 contracts and evidence boundaries
roles-src/             raw role prompts the agents/ dir was generated from
```

A plugin package looks like this:

```
plugins/<name>/.minimax-plugin/plugin.json   manifest
plugins/<name>/hooks/hooks.json               command hooks
plugins/<name>/scripts/*.mjs                  hook and MCP server implementations
plugins/<name>/scripts/runtime/*.mjs          included shared runtime (three plugins)
```

## Plugins

| Plugin            | What it does                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `injection-rules` | Delivers full standing rules at session/subagent start and after compaction; reminders on each tool result, input or configured prompt cadence. |
| `control-task`    | Complete durable task, revisioned `get` / `set` / `patch`, retained raw input and optional review tracking. |
| `agent-state`     | Own reusable guides, verified immediate-parent sharing, content freshness and completed-tool reminders. |
| `probe-hook`      | Packaged default-off diagnostic for hook, MCP and skill loading; enabled logs contain bounded metadata only.  |

### control-task

The complete canonical task survives compaction and process restart. It includes
the intended outcome, explicit requirements and grounded implied requirements
with their basis and source, applicable constraints, result conditions,
task-specific rules and source-of-truth references. Inferences stay identified
as inferences; unresolved assumptions remain tentative with their basis or
missing evidence. Earlier applicable requirements remain in the task when a
new correction arrives. Progress and current execution steps stay in the
conversation. Agent-written task text remains subordinate to original
instructions and their actual priority.

| Tool | Use |
| --- | --- |
| `control_task_get` | Read the task/review revisions and original body; optionally read a bounded range of raw prompt observations or their exact locators. |
| `control_task_set` | Replace the whole task when its durable definition changes, retaining all still-applicable requirements. |
| `control_task_patch` | Apply an atomic, revision-checked set of anchored add/replace/remove edits. |
| `control_task_confirm` | Optional compatibility tool to record an unchanged-task review through the exact current input revision. |

Every native `UserPromptSubmit` occurrence records raw input and delivers an
**obligatory requirement-update reminder**: add, change or remove requirements
in `control-task` as directed by the original message, using `set`/`patch` and
preserving all earlier applicable requirements. Unchanged steering needs no
extra tool call. `reason` and `reviewedInputRevision` are optional; review
tracking is informational and never a completion condition. An identical `set`
or valid unchanged `patch` can record explicitly supplied review coverage in
the same call without creating another task-body revision. An input arriving
later remains visible as unreviewed. The host's projection cannot establish
human provenance, final acceptance or exact-once input delivery; identical
same-turn observations are retained separately.

The plugin has no Stop/SubagentStop handlers and never forces another agent
turn. An unset task, unreviewed input or failed storage operation does not
prevent the next tool call or the final response. Old checkpoint-budget files
are left untouched and ignored.

The initial MCP response is **pending**, including for reads. Only a matching
trusted `PostToolUse` result supplies the definitive operation outcome within
the same tool result, without another confirmation call. If that result is
missing or reports a failure, continue the primary task while keeping the
storage outcome unresolved. A direct
MCP client without MiniMax hooks cannot read or mutate session state. Structural
validation and review counters do not prove that a model understood or recorded
every requirement. Examples and exact recovery semantics are in
[the port contract](docs/existing-ports-contract.md#complete-task-and-reconciliation).

### agent-state

Reusable micro-skills contain procedures, verified environment facts,
diagnostic recipes and observed failure modes. Policy directs the model to
exclude task notes, progress and unsupported explanations. Validation checks
shape, size, ownership and safe file operations; it does not semantically
classify prose or guarantee compliance with that policy.

`agent_state_note` creates or edits an own guide by its exact filename.
`agent_state_checkpoint` maintains one private optional compatibility guide.
Collection includes own files plus **shared guides from a verified current
immediate parent**; it never discovers guides by a common workspace or a last
active-session pointer. Guides restore on supported start/resume/compact
boundaries and refresh after a successful own save or a detected content
change. The default reminder cadence counts 10 completed other-tool events,
not user prompts. The delivered policy requires saving new useful reusable
knowledge **before compaction**. Ordinary cadence reminders reinforce this
obligation; a counter alone does not demand an immediate save or an invented
guide. A failed save does not require a retry or hold up other task actions.

The exact pre-compaction model turn is a **native host limitation in 0.6.12**:
`PreCompact` can defer once, but its reason does not reach the model, and the
next automatic attempt proceeds. The plugin therefore delivers the mandatory
instruction proactively; it cannot guarantee a last-moment save before every
compact. No ineffective PreCompact blocker is installed. The behavior is
exercised in [the native host contract](tests/mcode-host-contract.test.mjs).

Like control-task, a save is pending until its definitive native hook result.
An already committed guide remains committed if a later delivery-index refresh
fails; the result reports that partial outcome and automatic delivery can retry.
No save outcome requires a separate confirmation, read-back or retry before
continuing. An unresolved interrupted write reserves only its own target;
other guides remain writable when the journal is usable. Uncertain target
content and unreadable journals are preserved and produce local errors.

### probe-hook

`plugins/probe-hook/probe.config.json` ships as `{"enabled": false}`. Both
entrypoints resolve this one configuration inside their own complete package.
Missing, invalid or unsafe configuration stays disabled. Disabled mode creates
no diagnostic files; arbitrary environment switches do not enable hooks.

To opt in, change `enabled` to the boolean `true` in the installed/imported
**source plugin root**, then rescan/reload or reimport that complete root and
restart the host as needed. This is necessary for both the immutable hook
snapshot and the MCP process to use the new configuration. Do not edit only a
cached hook snapshot. Set it back to `false` and reload both lanes when finished.
A normal upgrade restores the shipped disabled configuration.

Enabled `probe_echo` returns at most 4,096 characters and the actual metadata-log
write status. Unknown tools and failed appends produce errors, never the OK
marker. Hook and MCP logs use the same verified native plugin data directory,
contain no prompt/tool-body text, and rotate at 128 KiB with one `.previous`
file. The intentionally literal `PROBE_EXPANDED=${PLUGIN_DATA}` environment
probe and unchanged skill-loader marker remain part of the diagnostic.

### injection-rules

Reads rule files from `~/.minimax/rules/` and optional `rules/` inside the plugin.
User rules override bundled defaults by `name`. This repository keeps the shipped rules
in the top-level `rules/` directory, so install **both the plugin and the rule files**.
The engine reloads them on each hook invocation.

All nine shipped rules have full standing bodies enabled at startup and in subagents.
`70-reasoning-poison` also has a compact reminder on **every `PostToolUse` event**,
including execution errors, and on every new input. It preserves the distinction between reasoning
and evidence, invalidates conclusions built on a disproved premise, and treats an
already-supported answer to the user as a ready action.

| Host event | Delivery |
| --- | --- |
| `SessionStart` (`startup`, `resume`, `plugin_activation`, `compact`) | Full applicable standing bodies. Compaction restores the bodies rather than relying on the summary to preserve them. |
| `SubagentStart` | Full bodies for the child role, respecting `apply` and `send_on_subagent`. |
| `UserPromptSubmit` | `every_input` reminders and due `every_n_turns` reminders. |
| `PostToolUse` | `every_tool` reminders, appended as separate context without replacing the tool output. No cadence counter, tool-name restriction or success filter. |

MiniMax Code 0.6.12 restores hooks after both automatic and manual compaction through
`SessionStart` with `source: "compact"`. Its `PostCompact` event cannot accept
`additionalContext`; registering that output there would not restore the rules.

A rule is a JSON file:

```json
{
  "name": "70-my-rule",
  "apply": ["*"],
  "send_on_start": true,
  "send_on_subagent": true,
  "body": "The complete standing requirement, available from the first decision.",
  "remind": {
    "every_input": true,
    "every_tool": true,
    "suffix": "A compact, actionable reminder of that requirement."
  }
}
```

`send_on_start` and `send_on_subagent` default to enabled. Set the relevant flag to
`false` to opt out. A child keeps its subagent policy on resume and compaction.
`apply` accepts `"*"`, exact role names, and exclusions such as `"!critic"`;
role comparisons ignore case. The host supplies `agent_type` for `SubagentStart`
and child tool events, but omits it from restored `SessionStart` payloads. The engine
records known session identities and restores the role by session ID at those
boundaries. An unknown or corrupt identity on restore receives only rules applicable
to every role, with a diagnostic; it cannot safely select role-specific rules.
The main role defaults to `mavis` (`MINIMAX_AGENT_NAME` can override it in direct
invocations). Start a new session after upgrading to establish its identity.

For less frequent input reminders, use
`"remind": { "every_n_turns": 3, "suffix": "..." }`.
The legacy field **counts `UserPromptSubmit` events**, not model responses or tool
calls. `every_input` takes precedence over that cadence. Tool results and compaction
neither advance nor reset it. Counters are isolated per session; the old `turns.json`
is read for migration. A missing session ID or unavailable counter storage skips only
periodic delivery, while stateless input/tool reminders continue.

The reminder reaches the next model inference after a tool result. It does not
interrupt reasoning already in progress, change a selected call's arguments, enforce
an inference-token budget, or make the model obey the instruction. The lifecycle
contract and its coverage limits are documented in [the rule review](docs/reasoning-rules-review.md).

**Host coverage limit:** in 0.6.12, an unknown tool, argument-validation failure,
permission/hook rejection, or an unexecuted remainder of an aborted batch can return
before `PostToolUse`. Those attempts receive no new result reminder from this plugin.
Exceptions thrown during tool execution do reach the hook. Covering every rejected
attempt requires a host change; there is no supported `PostToolUseFailure` event to add.

Use the [complete-root upgrade](#install-or-upgrade) above for rule, hook and
role changes. Copying only new rule JSON into an older running plugin does not
add its missing event registrations.

### Verification

Run every ordinary extension check and generated-copy parity check:

```sh
node scripts/sync-plugin-runtime.mjs --check
node --test tests/*.test.mjs
```

The ordinary suite uses isolated state, actual plugin entrypoint subprocesses,
and constructed hook/session fixtures. CI runs it on Node 22 and 24 without
installing plugin dependencies. The two native-host files are opt-in and are
reported as skipped when their package fixture is absent; those skips are not
native integration evidence.

With an unpacked, unmodified `@minimax-ai/code@0.6.12` package and its dependencies
already available, run the separate offline host checks:

```sh
MCODE_HOST_PACKAGE=/absolute/path/to/minimax-code-0.6.12/package \
  node --test tests/mcode-host-contract.test.mjs tests/mcode-ports-host.test.mjs
```

Those tests checksum the published host, use its original parser, lifecycle,
package materializer, MCP adapter and role capability assembler, and inspect
returned context and isolated durable data. They call no model/provider API.
See [the port contract](docs/existing-ports-contract.md#verification) and
[the earlier rule review](docs/reasoning-rules-review.md) for the evidence limits.

## AGENTS.md

Global instructions, injected into the system prompt of every session (32 KiB cap).

## Skills

| Skill  | Purpose                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| `task` | Task cycle: crystal → plan → critic gate → implementation → implementation-critic gate → acceptance. |

The cycle has no machine gates: no preplan chain, no quorum, no crystal reviewer. The critic
repairs the plan, the implementation-critic repairs the code, and the product-validator judges
without repairing.

## MCP servers

User-level MCP servers live beside the host configuration, normally in
`~/.minimax/mcp.json`. Use the separate [fresh initialization](#optional-fresh-mcp-configuration)
only for a new file; update individual entries in an existing file instead of
replacing it. The native plugin MCP servers are declared in the plugin packages.

| Server                | Transport | What it does                                                      |
| --------------------- | --------- | ----------------------------------------------------------------- |
| `playwright`          | stdio     | Browser automation and web testing via Playwright.                 |
| `web-inspector`       | stdio     | Live DOM/CSS/geometry/network inspection for layout diagnosis.    |
| `browser-inspector`   | stdio     | Puppeteer-based browser inspection.                               |
| `swatchdog`           | http      | Color/swatch analysis connector.                                  |
| `computer-use-linux`  | stdio     | Linux desktop control: screenshots and input.                     |
| `codebase-memory-mcp` | stdio     | Code knowledge graph: search, query, trace, architecture.         |
| `figma-bridge`        | stdio     | Figma Desktop Bridge: components, variables, styles, screenshots. |
| `project-graph`       | stdio     | Project architecture graph status and refresh.                    |

Two things bite when porting a config from another agent runtime:

- **`timeout` is in milliseconds.** A value of `60` is 60 ms, not one minute, and the server's
  `tools/list` is cut off before it answers — the server then shows up with zero tools. Use
  `60000` for a minute.
- **`toolExposure` is not a supported field.** An unknown field makes the whole server entry fail
  validation and it is dropped. `mcp` accepts `type`, `command`, `args`, `env`, `description`,
  `timeout` and `tools` for stdio, plus `type`, `url`, `headers`, `description`, `timeout` and
  `tools` for http.

The `codebase-memory-mcp` and `project-graph` servers resolve their project root from the current
working directory, so they only start in a Git repository.

## Roles

`agents/<name>/agent.md` holds a role contract. Frontmatter accepts `name`, `description`,
`model`, `effort`, `tools`, `disallowedTools`, `mcpServers`, `skills` and `x-mavis`. Roles are
dispatched with the `task` tool by name.

`tools` is a strict allowlist matched by exact tool name. A role that lists `read, bash` gets
exactly those two — nothing else, including MCP tools. There is no wildcard: `mcp__*` matches
nothing, so MCP tools have to be listed one by one as `mcp__<server>__<tool>`.

All 24 existing roles include the four exact control-task names:

```text
mcp__control-task__control_task_get
mcp__control-task__control_task_set
mcp__control-task__control_task_patch
mcp__control-task__control_task_confirm
```

The checked-in lists contain 122 explicitly named MCP tools, with 10, 11 or 13
built-in tools depending on the role. An allowlist makes a tool eligible; the
corresponding server must still load and expose it. Tool availability is not a
fixed count in every session. Restart/reload the role definitions after an
upgrade so child capability assembly sees the new operations.

The read-only role contracts (`auditor`, `delegate`, `design-critic`,
`design-verifier`, `evidence-auditor`) omit the dedicated `write`, `edit` and
`website_deploy` tools. `scout`, `preplan-auditor` and `product-validator` retain
`write` while omitting `edit` and `website_deploy`; their original tool profiles
are preserved. These are **tool selections and behavioral contracts, not a
filesystem security boundary**: Bash and permitted MCP tools can still mutate
files or other state. Enforce actual restrictions through host permissions,
sandboxing and each role's authorized task scope. Do not infer that withholding
`write`/`edit` makes shell access incapable of writing.

## License

MIT
