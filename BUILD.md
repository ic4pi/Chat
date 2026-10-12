# Build checklist

Single source of truth for what's built, in progress, and next.
Done = `[x]` + ~~struck through~~. Updated with every change that ships.

**Progress:** 7 / 10 milestones done · see Backlog for what's next

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
- [ ] M10 Music — Humanizer + Mastering coach built; awaiting production check

## Current work

- [x] ~~Music phase 1: `/music` MIDI Humanizer (parse, humanize, piano roll, A/B play, export .mid) + `music-explain` coach mode in /api/assist~~
- [ ] Verify `/music` and `/music/master.html` live on production; set `MUSIC_COACH_MODEL` if not using the default
- [x] ~~Music phase 2: `/music/master.html` genre mastering coach — analysis (LUFS/spectrum/width), description→genre mapping, 6-stage offline chain, level-matched A/B, 3-style compare, teach mode, WAV + recipe export, `master-explain` coach mode~~
- [ ] Music phase 3 (ideas): reference-track EQ matching; chain Humanizer → render → master as one flow; live-input jam partner
- [x] ~~Settings → Tokens section (GitHub + named tokens) — merged #109~~
- [x] ~~Rebuild Workspace bundle so Tokens UI actually ships (was source-only in #109)~~
- [x] ~~Build plan: Plan panel in Workspace, orchestrator reads + maintains it~~
- [ ] Verify Tokens + Plan panel are live on production (owner checking)
- [ ] Use the saved extra tokens (Vercel/Render/Supabase) somewhere — stored only for now

## Done log (newest first)

- ~~Music phase 2: Mastering Coach at /music/master.html~~
- ~~Music phase 1: MIDI Humanizer at /music~~
- ~~Workspace Plan panel + orchestrator-owned build plan~~
- ~~GitHub backup for work in progress~~
- ~~Open/copy/download a file from the file tree~~
- ~~Compare: read a file in either version as a document~~
- ~~Settings → Tokens~~

## Backlog

- [ ] (add items here)
