-- Nodex beta security control-plane hardening.
-- Adds operational token lifecycle, auth-attempt evidence, and admin audit events.

alter table public.beta_tokens
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_by text,
  add column if not exists last_used_at timestamptz,
  add column if not exists last_used_ip text,
  add column if not exists last_used_user_agent text,
  add column if not exists use_count integer not null default 0;

create index if not exists beta_tokens_lifecycle_idx
  on public.beta_tokens (active, revoked_at, expires_at);

create table if not exists public.beta_auth_attempts (
  id uuid primary key default gen_random_uuid(),
  token_hash text,
  token_preview text,
  ip_address text,
  user_agent text,
  success boolean not null,
  failure_reason text,
  created_at timestamptz not null default now()
);

create index if not exists beta_auth_attempts_token_time_idx
  on public.beta_auth_attempts (token_hash, created_at desc);

create index if not exists beta_auth_attempts_ip_time_idx
  on public.beta_auth_attempts (ip_address, created_at desc);

create table if not exists public.beta_audit_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  event_type text not null,
  severity public.beta_log_level not null default 'info',
  actor_token_hash text,
  actor_role public.beta_token_role,
  target_type text,
  target_id text,
  ip_address text,
  user_agent text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists beta_audit_events_created_at_idx
  on public.beta_audit_events (created_at desc);

create index if not exists beta_audit_events_type_idx
  on public.beta_audit_events (event_type, created_at desc);

alter table public.beta_auth_attempts enable row level security;
alter table public.beta_audit_events enable row level security;

revoke all on public.beta_auth_attempts from anon, authenticated;
revoke all on public.beta_audit_events from anon, authenticated;

grant select, insert, update, delete on public.beta_auth_attempts to service_role;
grant select, insert, update, delete on public.beta_audit_events to service_role;

