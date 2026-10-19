# MiniMax Code extensions

Local plugins, rules, skills, agent roles, MCP servers and the global `AGENTS.md` for
[MiniMax Code](https://github.com/MiniMax-AI) (`mcode`).

Everything here is published without secrets, sessions, logs or machine-specific state.

## Install

```sh
git clone https://github.com/Guihal/mcode-extensions.git
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
| `injection-rules` | Injects standing rule bodies at session start and re-injects reminder suffixes on their own cadence. |
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

Reads rule files from `~/.minimax/rules/` (user rules) and from `rules/` inside the plugin
(bundled rules), and injects them per their own cadence. A rule is a JSON file:

```json
{
  "name": "70-my-rule",
  "apply": ["*"],
  "send_on_start": false,
  "body": "short pointer shown at session start",
  "remind": { "every_n_turns": 3, "suffix": "full text re-injected every 3 turns" }
}
```

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
