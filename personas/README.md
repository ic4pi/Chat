# Personas

One file per persona: `personas/<id>.md`. Push it (git, GitHub API, any LLM
tool with repo access) and the next deploy serves it — no admin UI needed.

```
---
name: Display Name
description: One line shown in the persona picker.
---
The full system prompt goes here, as plain markdown.
```

- The filename (minus `.md`) is the persona id. Lowercase letters, digits, `-`, `_`.
- A file overrides any KV/admin persona or built-in with the same id.
- Files starting with `_` and `README.md` are ignored.
- Edit or delete the file to change/remove the persona.
