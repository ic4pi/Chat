# Agencies

An agency is a list of roles plus a playbook: `agencies/<id>.md`.

```
---
name: Digital Marketing Firm
description: One line.
extends: base                   # shared core: strategist + all_tools
roles: [copywriter, designer]   # added to the base's roles
swap: copywriter=comedy         # optional: role=persona, put a different persona in a seat
add_tools: closer=ads           # optional: role=tool+tool, extra tools for one seat in this agency
---
The playbook: how THIS firm works. Different strategy, same base.
```
Use it: `/agency` lists firms, `/agency marketing` shows seats and tools, `/ask marketing/copywriter | request` talks to a seat (`/ask marketing | goal` goes to the lead). Seats run their own tools but never send/post for real; they hand you the exact command to approve.
