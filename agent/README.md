# preskill agent skill

`SKILL.md` is a portable Agent Skill file. Copy this folder into the skills
directory your agent reads, or add the file to the agent's instructions.

Examples:

- Claude Code: `~/.claude/skills/preskill/`
- Codex: the skills directory configured for your Codex install
- Cursor: the skills or rules directory configured for your Cursor install

Set `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY` in the environment the agent's
shell uses. The provider is inferred from the key.

The skill calls `npx @vxbe/preskill scan <target> --json`. If you run from a
checkout instead, use
`node /path/to/preskill/dist/cli.js scan <target> --json`.
