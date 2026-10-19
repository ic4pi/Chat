# Roles

A role is a job: `roles/<id>.md`. It names a default persona and the tools that job gets. Tools belong to roles, never personas.

```
---
name: Copywriter
persona: Dez            # persona id or name; agencies can swap it
description: One line.
tools: [variants, landing, proposal]
---
What this seat does, in the persona's working voice.
```
Tool names must exist in `lib/tools/` and be server-side (not `voice`, `video`, `campaign`).
