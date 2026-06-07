-- Nodex beta control-plane schema.
-- Backend-only write model: Vercel/Hono uses SUPABASE_SECRET_KEY or
-- SUPABASE_SERVICE_ROLE_KEY. Browser clients should not write these tables
-- directly.

create extension if not exists pgcrypto;

create type public.beta_token_role as enum ('admin', 'tester');
create type public.beta_evidence_result as enum ('pass', 'partial', 'fail', 'not_measured');
create type public.beta_run_status as enum ('ready', 'running', 'completed');
create type public.beta_log_level as enum ('info', 'warn', 'error');
create type public.beta_simulation_source as enum ('sw-cache', 'peer-fetch', 'server-fallback');

create table public.beta_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  token_preview text not null,
  role public.beta_token_role not null,
  label text not null,
  assigned_name text,
  assigned_email text,
  welcome_note text,
  max_sessions integer not null default 1 check (max_sessions between 1 and 20),
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index beta_tokens_role_active_idx on public.beta_tokens (role, active);
create index beta_tokens_assigned_email_idx on public.beta_tokens (assigned_email);

create table public.beta_participants (
  id uuid primary key default gen_random_uuid(),
  participant_id text not null unique,
  room_id text not null unique,
  invite_token_id uuid references public.beta_tokens(id) on delete set null,
  invite_token_hash text,
  invite_token_label text,
  name text not null,
  email text,
  city text,
  country text,
  network_label text,
  consent_to_credit boolean not null default false,
  contribution_note text,
  created_at timestamptz not null default now()
);

create index beta_participants_invite_hash_idx on public.beta_participants (invite_token_hash);
create index beta_participants_created_at_idx on public.beta_participants (created_at);

create table public.beta_sessions (
  id uuid primary key default gen_random_uuid(),
  session_token_hash text not null unique,
  participant_id text not null references public.beta_participants(participant_id) on delete cascade,
  room_id text not null references public.beta_participants(room_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  revoked_at timestamptz
);

create index beta_sessions_participant_idx on public.beta_sessions (participant_id);
create index beta_sessions_active_idx on public.beta_sessions (session_token_hash, expires_at) where revoked_at is null;

create table public.beta_evidence (
  id uuid primary key default gen_random_uuid(),
  evidence_id text not null unique,
  participant_id text not null references public.beta_participants(participant_id) on delete cascade,
  room_id text not null references public.beta_participants(room_id) on delete cascade,
  topology_label text not null,
  result public.beta_evidence_result not null,
  notes text,
  telemetry jsonb not null default '[]'::jsonb,
  storage_pressure jsonb,
  runtime_config jsonb,
  created_at timestamptz not null default now()
);

create index beta_evidence_participant_idx on public.beta_evidence (participant_id);
create index beta_evidence_room_idx on public.beta_evidence (room_id);
create index beta_evidence_created_at_idx on public.beta_evidence (created_at);

create table public.beta_runs (
  id uuid primary key default gen_random_uuid(),
  run_id text not null unique,
  room_id text not null unique,
  status public.beta_run_status not null default 'ready',
  title text,
  scenario text not null,
  data_type text not null,
  node_count integer not null check (node_count between 2 and 50),
  notes text,
  created_by text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index beta_runs_created_at_idx on public.beta_runs (created_at);

create table public.beta_simulations (
  id uuid primary key default gen_random_uuid(),
  simulation_id text not null unique,
  run_id text not null references public.beta_runs(run_id) on delete cascade,
  room_id text not null,
  scenario text not null,
  data_type text not null,
  node_count integer not null,
  request_count integer not null,
  status public.beta_run_status not null default 'completed',
  metrics jsonb not null,
  events jsonb not null default '[]'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now()
);

create index beta_simulations_run_idx on public.beta_simulations (run_id);
create index beta_simulations_created_at_idx on public.beta_simulations (created_at);

create table public.beta_logs (
  id uuid primary key default gen_random_uuid(),
  log_id text not null unique,
  participant_id text,
  room_id text,
  run_id text,
  token_role public.beta_token_role not null,
  level public.beta_log_level not null,
  message text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create index beta_logs_room_idx on public.beta_logs (room_id);
create index beta_logs_run_idx on public.beta_logs (run_id);
create index beta_logs_created_at_idx on public.beta_logs (created_at);

create table public.beta_presence (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  name text not null,
  role public.beta_token_role not null,
  mode text not null default 'solo',
  participant_id text,
  last_seen timestamptz not null default now()
);

create index beta_presence_token_seen_idx on public.beta_presence (token_hash, last_seen desc);
create index beta_presence_recent_idx on public.beta_presence (last_seen desc);

create table public.interceptor_captures (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  seq integer not null,
  iv_b64 text,
  ciphertext_sample text,
  headers jsonb,
  created_at timestamptz not null default now()
);

create index interceptor_captures_created_at_idx on public.interceptor_captures (created_at);
create index interceptor_captures_path_idx on public.interceptor_captures (path);

create table public.product_sequences (
  path text primary key,
  seq integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.beta_tokens enable row level security;
alter table public.beta_participants enable row level security;
alter table public.beta_sessions enable row level security;
alter table public.beta_evidence enable row level security;
alter table public.beta_runs enable row level security;
alter table public.beta_simulations enable row level security;
alter table public.beta_logs enable row level security;
alter table public.beta_presence enable row level security;
alter table public.interceptor_captures enable row level security;
alter table public.product_sequences enable row level security;

revoke all on public.beta_tokens from anon, authenticated;
revoke all on public.beta_participants from anon, authenticated;
revoke all on public.beta_sessions from anon, authenticated;
revoke all on public.beta_evidence from anon, authenticated;
revoke all on public.beta_runs from anon, authenticated;
revoke all on public.beta_simulations from anon, authenticated;
revoke all on public.beta_logs from anon, authenticated;
revoke all on public.beta_presence from anon, authenticated;
revoke all on public.interceptor_captures from anon, authenticated;
revoke all on public.product_sequences from anon, authenticated;

grant select, insert, update, delete on public.beta_tokens to service_role;
grant select, insert, update, delete on public.beta_participants to service_role;
grant select, insert, update, delete on public.beta_sessions to service_role;
grant select, insert, update, delete on public.beta_evidence to service_role;
grant select, insert, update, delete on public.beta_runs to service_role;
grant select, insert, update, delete on public.beta_simulations to service_role;
grant select, insert, update, delete on public.beta_logs to service_role;
grant select, insert, update, delete on public.beta_presence to service_role;
grant select, insert, update, delete on public.interceptor_captures to service_role;
grant select, insert, update, delete on public.product_sequences to service_role;

create or replace view public.beta_ledger as
select
  p.participant_id,
  p.room_id,
  p.name,
  p.email,
  p.city,
  p.country,
  p.network_label,
  p.consent_to_credit,
  p.contribution_note,
  p.invite_token_label,
  p.created_at,
  count(e.id)::integer as evidence_count,
  max(e.created_at) as latest_evidence_at
from public.beta_participants p
left join public.beta_evidence e on e.participant_id = p.participant_id
group by p.id;

grant select on public.beta_ledger to service_role;
