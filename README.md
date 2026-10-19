# MiniMax Code extensions

Local plugins for [MiniMax Code](https://github.com/MiniMax-AI) (`mcode`) plus the global
`AGENTS.md` that goes with them.

Everything here is published without secrets, sessions, logs or machine-specific state.

## Install

```sh
git clone https://github.com/Guihal/mcode-extensions.git
cp -r mcode-extensions/plugins/* ~/.minimax/plugins/
cp mcode-extensions/AGENTS.md ~/.minimax/AGENTS.md
mcode plugin list --available --marketplace local
```

`~/.minimax/plugins` is the local marketplace directory; a plugin listed as `enabled` there is
loaded on the next session.

## Plugins

| Plugin            | What it does                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `injection-rules` | Injects standing rule bodies at session start and re-injects reminder suffixes on their own cadence. |
| `control-task`    | Durable canonical task anchor: `control_task_set` / `control_task_get` over a per-session file store. |
| `agent-state`     | Reusable guide store: `agent_state_note` and `agent_state_checkpoint` over a per-session file store. |

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
