-- Context Hub schema for ic4pi/Chat
-- Single-owner app: no user_id, no RLS. Only serverless functions touch this
-- (service-role key). The browser never connects to Postgres directly.
-- Embeddings are 768-dim (Cloudflare @cf/baai/bge-base-en-v1.5).

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- THREADS + MESSAGES
-- ---------------------------------------------------------------

create type thread_type as enum ('chat', 'group', 'workspace', 'media');

create table threads (
  id            uuid primary key default gen_random_uuid(),
  type          thread_type not null,
  title         text,
  -- seed_prompt is the clean carried-over text, kept OUT of messages so it can
  -- be handed to an image model verbatim with no wrapper prose.
  seed_prompt   text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  last_activity timestamptz not null default now(),
  swept_at      timestamptz
);

create index threads_activity_idx on threads (last_activity desc);
create index threads_sweep_idx on threads (swept_at nulls first, last_activity);

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
  thread_id  uuid not null references threads(id) on delete cascade,
  role       text not null,             -- user | assistant | resolution
  persona_id uuid references personas(id) on delete set null,
  model_used text,
  round      int,
  content    text not null,
  created_at timestamptz not null default now()
);

create index messages_thread_idx on messages (thread_id, created_at);

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
  from_thread_id  uuid not null references threads(id) on delete cascade,
  to_thread_id    uuid not null references threads(id) on delete cascade,
  relation        link_relation not null,
  seed_message_id uuid references messages(id) on delete set null,
  seed_content    text,
  created_at      timestamptz not null default now()
);

create index links_to_idx   on links (to_thread_id);
create index links_from_idx on links (from_thread_id);

-- ---------------------------------------------------------------
-- MEMORY
-- ---------------------------------------------------------------

create table topics (
  id           uuid primary key default gen_random_uuid(),
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

create table notes (
  id                uuid primary key default gen_random_uuid(),
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

-- ---------------------------------------------------------------
-- RESOLUTIONS + DOCUMENTS + NUDGES
-- ---------------------------------------------------------------

create table resolutions (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references threads(id) on delete cascade,
  summary    text not null,
  positions  jsonb not null default '[]'::jsonb,
  votes      jsonb not null default '[]'::jsonb,
  decision   text,
  forks      jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index resolutions_thread_idx on resolutions (thread_id);

create type document_type as enum (
  'story_bible', 'outline', 'manuscript', 'memoir', 'mock_textbook',
  'research_journal', 'biography', 'ad_copy', 'business_doc', 'newsletter'
);

create table documents (
  id            uuid primary key default gen_random_uuid(),
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

create table nudges (
  id         uuid primary key default gen_random_uuid(),
  topic_id   uuid references topics(id) on delete cascade,
  message    text not null,
  dismissed  boolean not null default false,
  created_at timestamptz not null default now()
);

create index nudges_open_idx on nudges (created_at desc) where not dismissed;

-- ---------------------------------------------------------------
-- Vector match helpers
-- ---------------------------------------------------------------

create or replace function match_topics(
  p_embedding vector(768), p_threshold real, p_limit int
) returns table (id uuid, name text, similarity real) as $$
  select t.id, t.name, (1 - (t.embedding <=> p_embedding))::real
  from topics t
  where t.embedding is not null
    and 1 - (t.embedding <=> p_embedding) > p_threshold
  order by t.embedding <=> p_embedding
  limit p_limit;
$$ language sql stable;

create or replace function match_notes(
  p_topic_id uuid, p_embedding vector(768), p_threshold real, p_limit int
) returns table (id uuid, content text, similarity real) as $$
  select n.id, n.content, (1 - (n.embedding <=> p_embedding))::real
  from notes n
  where n.topic_id = p_topic_id
    and n.embedding is not null
    and 1 - (n.embedding <=> p_embedding) > p_threshold
  order by n.embedding <=> p_embedding
  limit p_limit;
$$ language sql stable;

-- Used for fact dedup. The previous version used Postgres full-text search
-- against a column with no tsvector index, which silently matched nothing.
create or replace function match_facts(
  p_category text, p_embedding vector(768), p_threshold real, p_limit int
) returns table (id uuid, content text, times_seen int, confidence real, similarity real) as $$
  select f.id, f.content, f.times_seen, f.confidence,
         (1 - (f.embedding <=> p_embedding))::real
  from memory_facts f
  where f.category = p_category
    and f.embedding is not null
    and 1 - (f.embedding <=> p_embedding) > p_threshold
  order by f.embedding <=> p_embedding
  limit p_limit;
$$ language sql stable;
