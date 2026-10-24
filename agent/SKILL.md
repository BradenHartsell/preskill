---
name: preskill
description: Check an AI agent Skill before installing or enabling it. Use when the user asks to add, install, enable, or try a Skill, or before writing a Skill into a skills directory.
---

# Check a Skill before installing it

Before you add, install, enable, or run a Skill, scan it:

```bash
npx @vxbe/preskill scan "<target>" --json
```

The target is a local folder, a `.zip`, a GitHub URL, or a raw `SKILL.md` URL.

The scanner reads `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY` from the environment. If neither is set, ask the user to set one. Never print the key, put it in a prompt, or commit it.

Use the exit code and the JSON:

- `0`, verdict `safe`: continue with the install.
- `1`, verdict `flagged`: show every flagged question, its reason, and the files it named. Ask the user before installing. Do not install unless the user says yes.
- `2`, verdict `refused`: show the refusal reasons and stop.
- Any other error: stop and show the error.

A missing key, a network error, or a timeout is not a pass. Do not install a Skill the scanner could not check.
