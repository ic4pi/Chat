# Build checklist

Single source of truth for what's built, in progress, and next.
Done = `[x]` + ~~struck through~~. Updated with every change that ships.

**Progress:** 7 / 9 milestones done · see Backlog for what's next

## Milestones

- [x] ~~M1 Chat — six providers, personas, BYOK, streaming, voice, attachments, web search~~
- [x] ~~M2 Memory — per-owner topics/notes/facts, daily sweep, Remember this chat~~
- [x] ~~M3 Group chat — every persona speaks every round, retries, plain-words trigger~~
- [x] ~~M4 Campaigns — marketing meeting, strategist/editor loop, hook library~~
- [x] ~~M5 Workspace — real VMs, persona orchestrates coder, file tree, diff/push~~
- [x] ~~M6 Coding teams — five presets, saved teams, Compare two builds, settings sync~~
- [x] ~~M7 Cross-device — one-time link code, Chat and Workspace synced live~~
- [ ] M8 Media studio — see README; confirm scope
- [ ] M9 Admin — prompts/config page; confirm scope

## Current work

- [x] ~~Settings → Tokens section (GitHub + named tokens) — merged #109~~
- [x] ~~Rebuild Workspace bundle so Tokens UI actually ships (was source-only in #109)~~
- [x] ~~Build plan: Plan panel in Workspace, orchestrator reads + maintains it~~
- [x] ~~Keep model reasoning viewable ("Thinking" toggle under replies) in Chat + Workspace~~
- [x] ~~Compare: start a blank project or clone a repo (owner/repo works) without leaving the panel~~
- [ ] Verify Tokens + Plan panel are live on production (owner checking)
- [ ] Use the saved extra tokens (Vercel/Render/Supabase) somewhere — stored only for now

- [x] ~~Client workspaces, part 1: walled-off clients (own owner row), profile brief injected into chat/agent/group/campaign, switcher + client page, per-client local data~~
- [x] ~~Client workspaces, part 2: orchestrator asks any persona (ASK blocks), one Run / Don't run card per batch, answers return to the orchestrator~~
- [x] ~~Workspace: Enter sends (Shift+Enter = new line) in the chat box; Compare opens a project on open so either side builds~~
- [ ] Orchestrator ASSIGN/MEETING blocks (hand a persona a task; open a team meeting) under the same single approval
- [x] ~~Workspace runs and checks any stack the coder picks: Preview starts Flask/FastAPI/Python/Express apps (was a directory listing), Auto-test gets a Python/Node smoke so Push unlocks~~
- [ ] Browser-driving marketing agent (own spec; first-job question open)

- [x] ~~Juno persona (supportive comedy-writer friend: assessment step-planning, wins tally, planning-to-doing nudges)~~

## Teams & Production (planned with owner)

- [x] ~~Phase 1a: Teams (Marketing Agency, White-Hat Security) with editable member lists + team prompts~~
- [x] ~~Phase 1b: Group discussion asked in chat opens a meeting popup — team auto-matched, roster/models/rounds (default 3) editable, Start meeting~~
- [ ] Phase 1c: confirm the guerrilla-marketing persona landed in Marketing Agency (7 members) in the live app; Save team
- [x] ~~Phase 2: after a meeting the current persona offers a summary (ends with where the group landed + next steps), optional MP3 saved in the app; persona sees who said what~~
- [ ] Phase 3: orchestrator proposes deliverables from the result and hands them off (Workspace app build, Media promo/video/logo kits)
- [ ] Phase 4: Production module — project profiles, repeatable templates (marketing plan etc.), per-project customization

## Done log (newest first)

- ~~Workspace persona reads files itself (full context + READ: a file on demand) — no more copy/paste~~
- ~~Orchestrator gets the two Compare versions (answers if asked, silent otherwise)~~
- ~~Chat→Workspace re-entry: new chat messages land at the end, not above the build~~
- ~~Export fix (dropped a deleted key) + Workspace sessions included in backup~~
- ~~Workspace Plan panel + orchestrator-owned build plan~~
- ~~GitHub backup for work in progress~~
- ~~Open/copy/download a file from the file tree~~
- ~~Compare: read a file in either version as a document~~
- ~~Settings → Tokens~~

## Backlog

- [ ] (add items here)
