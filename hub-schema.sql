-- Context Hub schema for ic4pi/Chat
--
-- Multi-owner. Every row belongs to an owner; an owner is minted server-side
-- on first contact and carried in an HttpOnly cookie (see resolveOwner() in
-- lib/hub.js), so there is no login screen and no accounts to manage. Only
-- the SHA-256 of the cookie secret is stored, so a database dump never
-- yields a usable session token.
--
-- Only serverless functions touch this database, using the service-role key,
-- which bypasses RLS. RLS is still enabled with no policies so that the
-- anon/publishable key can read nothing at all if it is ever exposed in a
-- browser.
--
-- Embeddings are 768-dim (Cloudflare @cf/baai/bge-base-en-v1.5).

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- OWNERS
-- ---------------------------------------------------------------

create table owners (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique,   -- sha256 of the cookie secret
  label        text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index owners_seen_idx on owners (last_seen_at desc);

-- owner_id is NOT NULL on every table below on purpose: a query that forgets
-- to scope should fail loudly on insert rather than quietly write a row that
-- leaks into everyone's memory. `personas` is exempt (an admin-defined shared
-- catalog matched by slug, not user data) and `document_topics` is a pure
-- join guarded by both its foreign keys.

-- ---------------------------------------------------------------
-- THREADS + MESSAGES
-- ---------------------------------------------------------------

create type thread_type as enum ('chat', 'group', 'workspace', 'media');

create table threads (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references owners(id) on delete cascade,
  type          thread_type not null,
  title         text,
  -- seed_prompt is the clean carried-over text, kept OUT of messages so it can
  -- be handed to an image model verbatim with no wrapper prose.
  seed_prompt   text,
  -- The id this chat has in the browser's localStorage. Lets continuous sync
  -- call register() on every turn idempotently instead of creating a thread
  -- each time, and lets a group-suggestion nudge name chats the client can
  -- actually find.
  local_id      text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  last_activity timestamptz not null default now(),
  swept_at      timestamptz
);

create index threads_activity_idx on threads (last_activity desc);
create index threads_sweep_idx on threads (swept_at nulls first, last_activity);
create index threads_owner_idx on threads (owner_id, last_activity desc);
create index threads_owner_sweep_idx on threads (owner_id, swept_at nulls first, last_activity);

-- local_id comes from a browser's localStorage, so it is only ever unique to
-- one device. Unique per OWNER, not globally: a collision between two people
-- would otherwise hand one of them the other's thread.
create unique index threads_owner_local_id_idx
  on threads (owner_id, local_id) where local_id is not null;

create table personas (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique,            -- matches your existing persona ids
  name          text not null,
  system_prompt text not null,
  provider      text not null default 'openrouter',
  model         text not null,
  is_moderator  boolean not null default false,
  created_at    timestamptz not null default now()
);

create table messages (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references owners(id) on delete cascade,
  thread_id  uuid not null references threads(id) on delete cascade,
  role       text not null,             -- user | assistant | resolution
  persona_id uuid references personas(id) on delete set null,
  model_used text,
  round      int,
  content    text not null,
  created_at timestamptz not null default now()
);

create index messages_thread_idx on messages (thread_id, created_at);
create index messages_owner_idx on messages (owner_id);

create or replace function bump_thread_activity() returns trigger as $$
begin
  update threads set last_activity = now() where id = new.thread_id;
  return new;
end;
$$ language plpgsql;

create trigger messages_bump_activity
  after insert on messages
  for each row execute function bump_thread_activity();

-- ---------------------------------------------------------------
-- LINKS — how a thought moves between modules
-- ---------------------------------------------------------------

create type link_relation as enum (
  'promoted_to_workspace',
  'sent_to_media',
  'spawned_group_discussion',
  'compiled_into'
);

create table links (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references owners(id) on delete cascade,
  from_thread_id  uuid not null references threads(id) on delete cascade,
  to_thread_id    uuid not null references threads(id) on delete cascade,
  relation        link_relation not null,
  seed_message_id uuid references messages(id) on delete set null,
  seed_content    text,
  created_at      timestamptz not null default now()
);

create index links_to_idx   on links (to_thread_id);
create index links_from_idx on links (from_thread_id);
create index links_owner_idx on links (owner_id);

-- ---------------------------------------------------------------
-- MEMORY
-- ---------------------------------------------------------------

create table topics (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references owners(id) on delete cascade,
  name         text not null,
  summary      text,
  embedding    vector(768),
  note_count   int not null default 0,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- HNSW, not ivfflat: ivfflat needs training data and gives poor recall when
-- built on an empty table, which is exactly how this ships.
create index topics_embedding_idx on topics
  using hnsw (embedding vector_cosine_ops);
create index topics_seen_idx on topics (last_seen_at desc);
create index topics_owner_idx on topics (owner_id, last_seen_at desc);

create table notes (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references owners(id) on delete cascade,
  topic_id          uuid references topics(id) on delete set null,  -- null = inbox
  content           text not null,
  source_thread_id  uuid references threads(id) on delete set null,
  embedding         vector(768),
  confidence        real not null default 0.5,
  created_at        timestamptz not null default now()
);

create index notes_topic_idx on notes (topic_id, created_at desc);
create index notes_inbox_idx on notes (created_at desc) where topic_id is null;
create index notes_embedding_idx on notes
  using hnsw (embedding vector_cosine_ops);
create index notes_owner_idx on notes (owner_id, topic_id, created_at desc);

-- Keeps topics.note_count accurate. Without this the nudge job's
-- note_count filter never matches and nudges silently never fire.
create or replace function increment_topic_note_count() returns trigger as $$
begin
  update topics
     set note_count = note_count + 1,
         last_seen_at = now()
   where id = new.topic_id;
  return new;
end;
$$ language plpgsql;

create trigger notes_count_topics
  after insert on notes
  for each row when (new.topic_id is not null)
  execute function increment_topic_note_count();

create table memory_facts (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references owners(id) on delete cascade,
  category   text not null,             -- style | preference | project | person
  content    text not null,
  embedding  vector(768),
  confidence real not null default 0.5,
  times_seen int not null default 1,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index memory_facts_cat_idx on memory_facts (category, confidence desc);
create index memory_facts_embedding_idx on memory_facts
  using hnsw (embedding vector_cosine_ops);
create index memory_facts_owner_idx on memory_facts (owner_id, category, confidence desc);

-- ---------------------------------------------------------------
-- RESOLUTIONS + DOCUMENTS + NUDGES
-- ---------------------------------------------------------------

create table resolutions (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references owners(id) on delete cascade,
  thread_id  uuid not null references threads(id) on delete cascade,
  summary    text not null,
  positions  jsonb not null default '[]'::jsonb,
  votes      jsonb not null default '[]'::jsonb,
  decision   text,
  forks      jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index resolutions_thread_idx on resolutions (thread_id);
create index resolutions_owner_idx on resolutions (owner_id);

create type document_type as enum (
  'story_bible', 'outline', 'manuscript', 'memoir', 'mock_textbook',
  'research_journal', 'biography', 'ad_copy', 'business_doc', 'newsletter'
);

create table documents (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references owners(id) on delete cascade,
  type          document_type not null,
  title         text not null,
  outline       jsonb not null default '{}'::jsonb,
  sections      jsonb not null default '[]'::jsonb,
  status        text not null default 'draft',
  built_from_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table document_topics (
  document_id uuid not null references documents(id) on delete cascade,
  topic_id    uuid not null references topics(id) on delete cascade,
  primary key (document_id, topic_id)
);

create index documents_updated_idx on documents (updated_at desc);
create index documents_owner_idx on documents (owner_id, type);

-- Typed nudges let the sweep suggest grouping related chats into a project
-- without the server needing a "project" concept at all — projects stay
-- client-side, same as chats themselves. payload carries the local chat ids
-- for the client to resolve against its own localStorage.
create table nudges (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references owners(id) on delete cascade,
  topic_id   uuid references topics(id) on delete cascade,
  message    text not null,
  nudge_type text not null default 'stale_topic',
  payload    jsonb not null default '{}'::jsonb,
  dismissed  boolean not null default false,
  created_at timestamptz not null default now()
);

create index nudges_open_idx on nudges (created_at desc) where not dismissed;
create index nudges_owner_idx on nudges (owner_id, created_at desc) where not dismissed;

-- ---------------------------------------------------------------
-- Vector match helpers
-- ---------------------------------------------------------------

-- Owner-scoped. Unscoped, a note from one user matched and attached to
-- another user's topic, and fact dedup merged two different people into one
-- row — the deepest of the cross-user leaks.
create or replace function match_topics(
  p_owner_id uuid, p_embedding vector(768), p_threshold real, p_limit int
) returns table (id uuid, name text, similarity real) as $$
  select t.id, t.name, (1 - (t.embedding <=> p_embedding))::real
  from topics t
  where t.owner_id = p_owner_id
    and t.embedding is not null
    and 1 - (t.embedding <=> p_embedding) > p_threshold
  order by t.embedding <=> p_embedding
  limit p_limit;
$$ language sql stable;

create or replace function match_notes(
  p_owner_id uuid, p_topic_id uuid, p_embedding vector(768), p_threshold real, p_limit int
) returns table (id uuid, content text, similarity real) as $$
  select n.id, n.content, (1 - (n.embedding <=> p_embedding))::real
  from notes n
  where n.owner_id = p_owner_id
    and n.topic_id = p_topic_id
    and n.embedding is not null
    and 1 - (n.embedding <=> p_embedding) > p_threshold
  order by n.embedding <=> p_embedding
  limit p_limit;
$$ language sql stable;

-- Used for fact dedup. The previous version used Postgres full-text search
-- against a column with no tsvector index, which silently matched nothing.
create or replace function match_facts(
  p_owner_id uuid, p_category text, p_embedding vector(768), p_threshold real, p_limit int
) returns table (id uuid, content text, times_seen int, confidence real, similarity real) as $$
  select f.id, f.content, f.times_seen, f.confidence,
         (1 - (f.embedding <=> p_embedding))::real
  from memory_facts f
  where f.owner_id = p_owner_id
    and f.category = p_category
    and f.embedding is not null
    and 1 - (f.embedding <=> p_embedding) > p_threshold
  order by f.embedding <=> p_embedding
  limit p_limit;
$$ language sql stable;

-- ---------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------
-- Enabled with NO policies, deliberately. Only serverless functions touch
-- this database and they use the service-role key, which bypasses RLS — so
-- this changes nothing for the app, while guaranteeing the anon and
-- authenticated roles can read nothing at all if the publishable key is ever
-- exposed in a browser.

alter table owners          enable row level security;
alter table threads         enable row level security;
alter table personas        enable row level security;
alter table messages        enable row level security;
alter table links           enable row level security;
alter table topics          enable row level security;
alter table notes           enable row level security;
alter table memory_facts    enable row level security;
alter table resolutions     enable row level security;
alter table documents       enable row level security;
alter table document_topics enable row level security;
alter table nudges          enable row level security;

-- ---------------------------------------------------------------
-- CAMPAIGN HOOKS — opening lines that worked, for the campaign engine
-- ---------------------------------------------------------------
-- Saved from a campaign post the owner marked as a winner. performance is
-- whatever number they reported (CTR %, reply rate…), 1 when they only said
-- it worked. The engine retrieves the relevant ones by embedding, then ranks
-- them by performance.

create table if not exists campaign_hooks (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references owners(id) on delete cascade,
  text        text not null,
  platform    text not null default 'any',
  performance real not null default 1 check (performance >= 0),
  embedding   vector(768),
  created_at  timestamptz not null default now()
);

create index if not exists campaign_hooks_owner_idx on campaign_hooks (owner_id, performance desc);
create index if not exists campaign_hooks_embedding_idx on campaign_hooks
  using hnsw (embedding vector_cosine_ops);

alter table campaign_hooks enable row level security;

create or replace function match_campaign_hooks(
  p_owner_id uuid, p_embedding vector(768), p_threshold real, p_limit int
) returns table (id uuid, text text, platform text, performance real, similarity real) as $$
  select h.id, h.text, h.platform, h.performance, (1 - (h.embedding <=> p_embedding))::real
  from campaign_hooks h
  where h.owner_id = p_owner_id
    and h.embedding is not null
    and 1 - (h.embedding <=> p_embedding) > p_threshold
  order by h.embedding <=> p_embedding
  limit p_limit;
$$ language sql stable;

-- ---------------------------------------------------------------
-- WORKSPACE SETTINGS — coding teams and seat picks, per owner
-- ---------------------------------------------------------------
-- One JSON blob per owner: the chosen team, saved custom teams, role models,
-- orchestrator prefs. Lives here so it survives the browser wiping
-- localStorage (Safari's 7-day rule, "clear site data" on the app storage).

create table if not exists workspace_settings (
  owner_id   uuid primary key references owners(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table workspace_settings enable row level security;

-- ---------------------------------------------------------------
-- LINKED DEVICES + WORKSPACE SESSIONS
-- ---------------------------------------------------------------
-- A one-time code (10 min) lets another browser become the same owner with
-- its own cookie secret. Workspace sessions (chat + files the agent wrote)
-- are kept per owner so a linked device or a wiped browser gets them back;
-- a delete stays as a marker so other devices drop their copy.

create table if not exists owner_devices (
  token_hash  text primary key,
  owner_id    uuid not null references owners(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists owner_devices_owner_idx on owner_devices (owner_id);
alter table owner_devices enable row level security;

create table if not exists device_link_codes (
  code_hash   text primary key,
  owner_id    uuid not null references owners(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
alter table device_link_codes enable row level security;

create table if not exists workspace_sessions (
  owner_id    uuid not null references owners(id) on delete cascade,
  session_id  text not null,
  title       text,
  data        jsonb not null,
  saved_at    bigint not null default 0,
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (owner_id, session_id)
);
alter table workspace_sessions enable row level security;

-- Client workspaces: each client is its own owner row (walled off), reachable
-- only through its parent. The `clients` row shares the owner's id.
alter table owners add column if not exists parent_owner_id uuid references owners(id) on delete cascade;
create table if not exists clients (
  id              uuid primary key references owners(id) on delete cascade,
  parent_owner_id uuid not null references owners(id) on delete cascade,
  name            text not null,
  profile         jsonb not null default '{}'::jsonb,
  archived        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists clients_parent_idx on clients(parent_owner_id);
alter table clients enable row level security;
