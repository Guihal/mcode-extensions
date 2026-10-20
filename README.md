# MiniMax Code extensions

Local plugins, rules, skills, agent roles, MCP servers and the global `AGENTS.md` for
[MiniMax Code](https://github.com/MiniMax-AI) (`mcode`).

Everything here is published without secrets, sessions, logs or machine-specific state.

## Install

```sh
git clone https://github.com/Guihal/mcode-extensions.git
mkdir -p ~/.minimax/plugins ~/.minimax/skills ~/.minimax/agents ~/.minimax/rules
cp -r mcode-extensions/plugins/* ~/.minimax/plugins/
cp -r mcode-extensions/skills/* ~/.minimax/skills/
cp -r mcode-extensions/agents/* ~/.minimax/agents/
cp mcode-extensions/AGENTS.md ~/.minimax/AGENTS.md
cp mcode-extensions/rules/* ~/.minimax/rules/
cp mcode-extensions/mcp.example.json ~/.minimax/mcp.json
sed -i "s#<HOME>#$HOME#g" ~/.minimax/mcp.json   # the template ships <HOME> placeholders
mcode plugin list --available --marketplace local
```

`~/.minimax/plugins` is the local marketplace directory; a plugin listed as `enabled` there is
loaded on the next session. MCP servers are read from `~/.minimax/mcp.json` — the file next to
`config.yaml`, not from the project.

## Layout

```
AGENTS.md              global instructions (system prompt, 32 KiB cap)
config.example.yaml    sanitized copy of ~/.minimax/config.yaml
permission.json        global permission rules (v2 format)
mcp.example.json       template for ~/.minimax/mcp.json
rules/                 standing rules injected by injection-rules
skills/task/           task-cycle skill
agents/<name>/         custom subagent roles
plugins/<name>/        local plugin packages
roles-src/             raw role prompts the agents/ dir was generated from
```

A plugin package looks like this:

```
plugins/<name>/.minimax-plugin/plugin.json   manifest
plugins/<name>/hooks/hooks.json               command hooks
plugins/<name>/scripts/*.mjs                  hook and MCP server implementations
```

## Plugins

| Plugin            | What it does                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `injection-rules` | Delivers full standing rules at session/subagent start and after compaction; reminders on each tool result, input or configured prompt cadence. |
| `control-task`    | Durable canonical task anchor: `control_task_set` / `control_task_get` over a per-session file store. |
| `agent-state`     | Reusable guide store: `agent_state_note` and `agent_state_checkpoint` over a per-session file store. |
| `probe-hook`      | Throwaway probe used to verify that plugin hooks, MCP servers and skills load. Disabled by default.  |

### control-task

The canonical task for a session lives in a file, so it survives compaction and a process restart.
`control_task_set` replaces the whole task body; the task is re-injected into every turn by a
companion hook. Use it when the task definition materially changes — a goal change, an added or
removed durable requirement, a corrected source of truth. Ordinary corrections and step-by-step
instructions stay in the conversation.

### agent-state

Reusable micro-skills: procedures, verified environment facts, diagnostic recipes, known failure
modes. The store deliberately refuses task notes and progress reports — the task itself belongs to
`control_task_set`. A hook re-delivers the collected guides into context.

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

To upgrade an existing installation from this checkout:

```sh
cp -r plugins/injection-rules ~/.minimax/plugins/
cp rules/*.json ~/.minimax/rules/
cp AGENTS.md ~/.minimax/AGENTS.md
```

Start a new session so the host loads the expanded hook registration. Copying only the
new rule JSON into a running 0.1.0 plugin does not add its missing tool/subagent hooks.

### Verification

The dependency-free suite executes the commands registered in the installed hook
configuration against isolated rule and state directories:

```sh
node --test tests/injection-rules.test.mjs
```

It covers the shipped rules, startup/resume/compaction, child roles, every tool result,
errors, overrides, malformed input, unavailable storage, and concurrent sessions.
See [the rule review](docs/reasoning-rules-review.md) for the additional offline test
against the official MiniMax Code 0.6.12 parser and lifecycle.

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

User-level MCP servers live in `~/.minimax/mcp.json` — the file next to `config.yaml`, not in the
project. `mcp.example.json` in this repository is the template: copy it, replace `<HOME>` with your
home directory, and fix the paths that are specific to your machine.

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

Two things worth knowing before you write a role:

- **`disallowedTools` does not take effect** for custom agents in `mcode` 0.6.12 — a role with
  `disallowedTools: [write, edit]` still gets `write` and `edit`. To withhold a tool, leave its
  name out of `tools`.
- **Omitting `tools` grants the whole session toolset**, but the runtime defers configured (MCP)
  tools behind its tool-search once their combined schema grows, so a role without an explicit
  list sees a subset of the MCP tools. Every role here therefore carries an explicit list: the
  13 built-ins plus all 120 MCP tools.

The read-only roles (`auditor`, `delegate`, `design-critic`, `design-verifier`,
`evidence-auditor`) leave `write` and `edit` out of that list, so they keep read, search, shell
and full MCP access but cannot change files. `scout`, `preplan-auditor` and `product-validator`
add `write` and keep `edit` out, preserving their original omo tool sets. Everything else lists
all 13 built-ins.

Two further constraints come from the runtime, not from the frontmatter: a subagent never gets
`task`, `task_append`, `todowrite` or `ask_user`, and it cannot spawn subagents of its own.

Known limits of an explicit list: the runtime also exposes MCP servers that are not in
`mcp.json` — an internal task-management server (`mcp__taskmaster__*`) and a second alias of
the FigJam bridge (`mcp__figjam-bridge__*`). Those are missing from the lists, and the number of
reachable MCP tools therefore varies between roughly 99 and 165 depending on which servers came
up in that particular session.

## License

MIT
