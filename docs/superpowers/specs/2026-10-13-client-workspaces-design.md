# Client workspaces — design

Status: awaiting owner review. No code written yet.

## Goal

Run the app like an agency. Each client gets a walled-off workspace with its own
profile, chats, memory, campaigns and hooks. Choosing a client once makes chat,
team meetings, campaigns and Workspace work for that client. The orchestrator
sits above the clients and talks directly to every persona inside whichever
client is active. The owner gives one approval per run, not per action.

## Non-goals (version one)

- Brand-kit files and logos (Media will take these later).
- Copying items between clients.
- Sharing a client with other people or team members.
- Billing, usage reports per client.
- The browser operator (separate spec; it will plug into this one).

## 1. Data

- `owners` gains `parent_owner_id uuid null references owners(id) on delete cascade`.
- New table `clients`:
  - `id uuid primary key references owners(id) on delete cascade` (the client's own owner row)
  - `parent_owner_id uuid not null references owners(id) on delete cascade`
  - `name text not null`
  - `profile jsonb not null default '{}'` — `{ voice, audience, offer, facts[], links[], dos[], donts[] }`
  - `archived boolean not null default false`, `created_at`, `updated_at`
  - Row level security enabled, same as the other hub tables.
- A client's owner row gets a random `token_hash` nobody holds, so no cookie can ever
  resolve to it directly. It is reachable only through its parent.
- The owner's existing data is untouched and is the "Personal" space. No migration.

## 2. The wall

- `resolveOwner(req, res)` in `lib/hub.js` is the single place the server decides
  whose data a request touches. It is used by `api/campaign.js`, `api/group-chat.js`,
  `api/social-post.js` and `api/hub/[route].js`.
- New behaviour: if the request carries `X-Client-Id`, look the client up where
  `clients.id = header AND clients.parent_owner_id = <cookie owner>`.
  - Found: return the client's `id` as the owner for this request.
  - Not found or archived: throw, and the route answers 403. It never falls back to
    the personal owner.
- `/api/chat` and `/api/agent-chat` do not resolve an owner today. They get the same
  header handling so the client brief can be added there too.
- Nothing else changes in the queries. Every table is already scoped by `owner_id`,
  so each client's rows are separate by construction. A query that forgets to scope
  cannot leak across clients.
- Linking a device (`adoptOwner`) already makes the new browser the same parent owner,
  so all clients come with it.

## 3. The client brief

- A `clientBrief(profile)` helper builds a short block: name, voice, audience, offer,
  facts, do and don't rules.
- When a client is active, the server adds the block to the system prompt in chat,
  group meetings, campaigns and Workspace orchestration.
- The campaign editor also receives the profile facts as claims it may rely on.

## 4. What the owner sees

- A client switcher in the top bar: Personal, each client, "+ New client".
- The active client's name is shown in a colored label on every screen.
- The active client id is kept in `localStorage` and sent as `X-Client-Id`.
- A client page edits the profile, archives the client, or deletes it. Deleting
  removes the client's owner row and, by cascade, all its data, after a typed
  confirmation of the client's name.
- Browser-held data is separated per client: chats carry a `clientId`, the sidebar
  lists only the active client's chats, and Workspace sessions sync per client because
  they sync per owner.

## 5. Orchestrator direct line to personas

- Inside the active client the orchestrator is given the roster: each persona's name,
  role, model and assigned task, plus the team prompt.
- It can emit structured blocks, parsed by the client the same way `<<<BRIEF>>>` and
  `<<<PLAN>>>` are today:
  - `<<<ASK persona="Name">>> question <<<END>>>` — one persona answers, the answer is
    returned to the orchestrator labeled with the persona's name.
  - `<<<ASSIGN persona="Name">>> task and deliverable <<<END>>>` — the same, with a
    named deliverable.
  - `<<<MEETING team="Name" rounds="3">>> topic <<<END>>>` — the existing meeting flow.
- Each persona keeps a thread per client, so it remembers what it was asked.
- Every call runs inside the active client's wall and receives that client's brief.

## 6. One approval per run

- Before anything runs, the orchestrator shows one run plan card: the ordered list of
  asks, assigns and meetings, the personas and models involved, and the number of model
  calls. The card has two buttons, Run and Don't run.
- After Run, the whole plan executes with no further prompts. It does only what the card
  lists. If something unlisted is needed, it stops and reports.
- Hard cap: the plan's model-call count, shown on the card. Exceeding it stops the run.
- A Stop button ends a running plan. A log records every call and result.

## Tests

- Unit: `resolveOwner` rejects a client that is not the caller's, archived clients,
  and malformed ids, and never returns the personal owner on failure.
- Integration: with two clients, data written under client A is not readable under
  client B or under Personal, and the parent owner's own data is unchanged.
- Parser: `ASK`, `ASSIGN`, `MEETING` blocks, including malformed ones, never run
  anything outside the approved plan.
- Browser: switching clients swaps the chat list, the label and the profile; deleting a
  client removes its chats.

## Risks and open items

- Deleting a client deletes its data permanently. Mitigation: archive first, typed
  confirmation to delete.
- Persona calls multiply cost. Mitigation: the call count and cap on the run plan.
- Group chats and campaigns created before this change belong to Personal. No data moves.
