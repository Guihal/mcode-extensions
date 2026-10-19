# MiniMax Code extensions

Local plugins, rules, skills, agent roles and the global `AGENTS.md` for
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
mcode plugin list --available --marketplace local
```

`~/.minimax/plugins` is the local marketplace directory; a plugin listed as `enabled` there is
loaded on the next session.

## Layout

```
AGENTS.md              global instructions (system prompt, 32 KiB cap)
config.example.yaml    sanitized copy of ~/.minimax/config.yaml
permission.json        global permission rules (v2 format)
rules/                 standing rules injected by injection-rules
skills/task/           task-cycle skill
agents/<name>/         custom subagent roles
plugins/<name>/        local plugin packages
roles-src/             raw role prompts the agents/ dir was generated from
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

## Layout

```
AGENTS.md
plugins/<name>/.minimax-plugin/plugin.json   manifest
plugins/<name>/hooks/hooks.json               command hooks
plugins/<name>/scripts/*.mjs                  hook and MCP server implementations
```

## License

MIT

## Rules

Standing rules live in `rules/` as JSON files. A rule is injected at session start
(`send_on_start: true`) and re-injected on its own cadence:

```json
{
  "name": "70-my-rule",
  "apply": ["*"],
  "send_on_start": false,
  "body": "short pointer shown at session start",
  "remind": { "every_n_turns": 3, "suffix": "full text re-injected every 3 turns" }
}
```

## Roles

`agents/<name>/agent.md` holds a role contract. Frontmatter accepts `name`, `description`,
`model`, `tools`, `skills` and `x-mavis`. Roles are dispatched with the `task` tool by name.

The task cycle has no machine gates: the critic repairs the plan, the implementation-critic
repairs the code, and the product-validator judges without repairing.
