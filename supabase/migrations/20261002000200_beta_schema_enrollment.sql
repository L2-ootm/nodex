-- Reproducible beta schema. Hosted writes use server-side service-role access.
create table if not exists public.beta_tokens (
  id uuid primary key default gen_random_uuid(), token_hash text not null unique,
  token_preview text not null, role text not null check(role in ('tester','admin')),
  label text not null, assigned_name text, assigned_email text, welcome_note text,
  max_sessions integer not null default 1 check(max_sessions between 1 and 20),
  created_at timestamptz not null default now(), created_by text not null,
  active boolean not null default true, expires_at timestamptz, revoked_at timestamptz,
  revoked_by text, last_used_at timestamptz, last_used_ip text, last_used_user_agent text,
  use_count integer not null default 0
);
create table if not exists public.beta_participants (
  participant_id text primary key, room_id text not null,
  invite_token_id uuid references public.beta_tokens(id), invite_token_hash text, invite_token_label text,
  name text not null check(length(name) between 1 and 120), email text, city text,
  country text, network_label text, consent_to_credit boolean not null default false,
  contribution_note text, enrollment_request_id text unique,
  created_at timestamptz not null default now()
);
-- Existing installations retain their rows and gain the idempotency key.
alter table public.beta_participants add column if not exists enrollment_request_id text;
create unique index if not exists beta_enrollment_request_id on public.beta_participants(enrollment_request_id);
create index if not exists beta_participants_invite_hash on public.beta_participants(invite_token_hash);
create table if not exists public.beta_sessions (
  session_token_hash text primary key, participant_id text not null references public.beta_participants(participant_id),
  room_id text not null, created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '14 days', revoked_at timestamptz
);
create table if not exists public.beta_evidence (
  evidence_id text primary key, participant_id text not null references public.beta_participants(participant_id),
  room_id text not null, topology_label text not null,
  result text not null check(result in ('pass','partial','fail','not_measured')),
  notes text, telemetry jsonb not null default '[]', storage_pressure jsonb,
  runtime_config jsonb, lifecycle_signals jsonb not null default '[]', device_hints jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.beta_runs (
  run_id text primary key, room_id text not null, status text not null default 'ready',
  title text, scenario text not null, data_type text not null, node_count integer not null,
  notes text, created_by text not null, created_at timestamptz not null default now()
);
create table if not exists public.beta_simulations (
  simulation_id text primary key, run_id text not null references public.beta_runs(run_id),
  room_id text not null, scenario text not null, data_type text not null, node_count integer not null,
  request_count integer not null, status text not null, metrics jsonb not null, events jsonb not null,
  created_by text not null, created_at timestamptz not null default now()
);
create table if not exists public.beta_logs (
  log_id text primary key, participant_id text, room_id text, run_id text,
  token_role text not null, level text not null, message text not null, details jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.beta_audit_events (
  event_id text primary key, event_type text not null, severity text not null default 'info',
  actor_token_hash text, actor_role text, target_type text, target_id text,
  ip_address text, user_agent text, details jsonb, created_at timestamptz not null default now()
);
create table if not exists public.beta_auth_attempts (
  id uuid primary key default gen_random_uuid(), token_hash text not null, token_preview text not null,
  ip_address text, user_agent text, success boolean not null, failure_reason text,
  created_at timestamptz not null default now()
);
create index if not exists beta_auth_attempt_lookup on public.beta_auth_attempts(token_hash,success,created_at);
create table if not exists public.beta_presence (
  token_hash text not null, room_id text not null default '', name text not null,
  role text not null, mode text not null, participant_id text, last_seen timestamptz not null,
  primary key(token_hash,room_id)
);
do $$ declare t text; begin
  foreach t in array array['beta_tokens','beta_participants','beta_sessions','beta_evidence',
    'beta_runs','beta_simulations','beta_logs','beta_audit_events','beta_auth_attempts','beta_presence'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;

create or replace function public.nodex_beta_enroll(
  p_input jsonb, p_session_hash text, p_request_id text, p_invite_hash text default null,
  p_invite_id uuid default null, p_invite_label text default null, p_max_sessions integer default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  participant public.beta_participants%rowtype;
  invitation public.beta_tokens%rowtype;
  participant_key text;
  limit_count integer;
begin
  if p_request_id is null or length(p_request_id)<>64 or p_session_hash is null or length(p_session_hash)<>64
    or jsonb_typeof(p_input)<>'object' or length(coalesce(p_input->>'name','')) not between 1 and 120 then
    raise exception 'invalid enrollment';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('nodex-enroll:'||coalesce(p_invite_hash,p_request_id),0));
  limit_count := p_max_sessions;
  if p_invite_hash is not null then
    select * into invitation from public.beta_tokens where token_hash=p_invite_hash for update;
    if found then
      if not invitation.active or invitation.revoked_at is not null or
        (invitation.expires_at is not null and invitation.expires_at<=now()) then return null; end if;
      limit_count := invitation.max_sessions;
    end if;
  end if;
  select * into participant from public.beta_participants where enrollment_request_id=p_request_id;
  if found then return to_jsonb(participant); end if;
  if p_invite_hash is not null then
    if limit_count is null or limit_count<1 then return null; end if;
    if (select count(*) from public.beta_participants where invite_token_hash=p_invite_hash)>=limit_count then return null; end if;
  end if;
  participant_key := 'beta-'||replace(gen_random_uuid()::text,'-','');
  insert into public.beta_participants(participant_id,room_id,invite_token_id,invite_token_hash,invite_token_label,
    name,email,city,country,network_label,consent_to_credit,contribution_note,enrollment_request_id)
    values(participant_key,'beta-'||participant_key,p_invite_id,p_invite_hash,p_invite_label,
    p_input->>'name',p_input->>'email',p_input->>'city',p_input->>'country',p_input->>'networkLabel',
    coalesce((p_input->>'consentToCredit')::boolean,false),p_input->>'contributionNote',p_request_id)
    returning * into participant;
  insert into public.beta_sessions(session_token_hash,participant_id,room_id)
    values(p_session_hash,participant.participant_id,participant.room_id);
  return to_jsonb(participant);
end;
$$;
revoke all on function public.nodex_beta_enroll(jsonb,text,text,text,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.nodex_beta_enroll(jsonb,text,text,text,uuid,text,integer) to service_role;
