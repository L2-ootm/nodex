-- Tenant-scoped monotonic sequence authority with idempotent commands and a
-- transactional invalidation outbox. Apply and backfill before application cutover.

create table if not exists public.nodex_sequence_heads (
  tenant_id uuid not null,
  resource_key text not null,
  seq bigint not null,
  updated_at timestamptz not null,
  primary key (tenant_id, resource_key),
  constraint nodex_sequence_resource_valid check (
    length(resource_key) between 1 and 2048 and left(resource_key, 5) = '/api/'
  ),
  constraint nodex_sequence_safe_integer check (seq between 1 and 9007199254740991)
);

create table if not exists public.nodex_sequence_commands (
  tenant_id uuid not null,
  idempotency_key uuid not null,
  resource_key text not null,
  seq bigint,
  sequence_updated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, idempotency_key),
  constraint nodex_sequence_command_result_complete check (
    (seq is null and sequence_updated_at is null) or
    (seq is not null and sequence_updated_at is not null)
  ),
  constraint nodex_sequence_command_safe_integer check (
    seq is null or seq between 1 and 9007199254740991
  )
);

create table if not exists public.nodex_sequence_outbox (
  tenant_id uuid not null,
  event_id uuid not null,
  resource_key text not null,
  seq bigint not null,
  sequence_updated_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  available_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  locked_by uuid,
  locked_until timestamptz,
  delivered_at timestamptz,
  last_error text,
  primary key (tenant_id, event_id),
  constraint nodex_sequence_outbox_version unique (tenant_id, resource_key, seq),
  constraint nodex_sequence_outbox_safe_integer check (seq between 1 and 9007199254740991),
  constraint nodex_sequence_outbox_attempts_valid check (attempts >= 0)
);

create index if not exists nodex_sequence_outbox_pending_idx
  on public.nodex_sequence_outbox (available_at, created_at)
  where delivered_at is null;

alter table public.nodex_sequence_heads enable row level security;
alter table public.nodex_sequence_commands enable row level security;
alter table public.nodex_sequence_outbox enable row level security;

revoke all on public.nodex_sequence_heads from public, anon, authenticated;
revoke all on public.nodex_sequence_commands from public, anon, authenticated;
revoke all on public.nodex_sequence_outbox from public, anon, authenticated;

create or replace function public.nodex_read_sequence(
  p_tenant_id uuid,
  p_resource_key text
)
returns table (seq bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_tenant_id is null or p_resource_key is null
    or length(p_resource_key) not between 1 and 2048
    or left(p_resource_key, 5) <> '/api/' then
    raise exception using errcode = '22023', message = 'invalid sequence read';
  end if;

  return query
  select heads.seq, heads.updated_at
  from public.nodex_sequence_heads as heads
  where heads.tenant_id = p_tenant_id
    and heads.resource_key = p_resource_key;
end;
$$;

create or replace function public.nodex_bump_sequence(
  p_tenant_id uuid,
  p_resource_key text,
  p_idempotency_key uuid
)
returns table (
  seq bigint,
  updated_at timestamptz,
  event_id uuid,
  duplicate boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_inserted integer;
  v_existing public.nodex_sequence_commands%rowtype;
  v_seq bigint;
  v_updated_at timestamptz;
begin
  if p_tenant_id is null or p_idempotency_key is null or p_resource_key is null
    or length(p_resource_key) not between 1 and 2048
    or left(p_resource_key, 5) <> '/api/' then
    raise exception using errcode = '22023', message = 'invalid sequence command';
  end if;

  insert into public.nodex_sequence_commands (
    tenant_id, idempotency_key, resource_key, created_at
  ) values (
    p_tenant_id, p_idempotency_key, p_resource_key, v_now
  )
  on conflict do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select * into strict v_existing
    from public.nodex_sequence_commands
    where tenant_id = p_tenant_id
      and idempotency_key = p_idempotency_key;

    if v_existing.resource_key is distinct from p_resource_key then
      raise exception using errcode = '22023', message = 'idempotency key reused for another resource';
    end if;
    if v_existing.seq is null or v_existing.sequence_updated_at is null then
      raise exception using errcode = '40001', message = 'incomplete sequence command';
    end if;

    return query select
      v_existing.seq,
      v_existing.sequence_updated_at,
      p_idempotency_key,
      true;
    return;
  end if;

  insert into public.nodex_sequence_heads as heads (
    tenant_id, resource_key, seq, updated_at
  ) values (
    p_tenant_id, p_resource_key, 1, v_now
  )
  on conflict (tenant_id, resource_key) do update
    set seq = heads.seq + 1,
        updated_at = v_now
    where heads.seq < 9007199254740991
  returning heads.seq, heads.updated_at
  into v_seq, v_updated_at;

  if not found then
    raise exception using errcode = '22003', message = 'JavaScript-safe sequence space exhausted';
  end if;

  insert into public.nodex_sequence_outbox (
    tenant_id, event_id, resource_key, seq, sequence_updated_at, created_at, available_at
  ) values (
    p_tenant_id, p_idempotency_key, p_resource_key, v_seq, v_updated_at, v_now, v_now
  );

  update public.nodex_sequence_commands as commands
  set seq = v_seq,
      sequence_updated_at = v_updated_at
  where commands.tenant_id = p_tenant_id
    and commands.idempotency_key = p_idempotency_key;

  return query select v_seq, v_updated_at, p_idempotency_key, false;
end;
$$;

revoke all on function public.nodex_read_sequence(uuid, text) from public, anon, authenticated;
revoke all on function public.nodex_bump_sequence(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.nodex_read_sequence(uuid, text) to service_role;
grant execute on function public.nodex_bump_sequence(uuid, text, uuid) to service_role;

comment on table public.nodex_sequence_heads is
  'Authoritative tenant/resource sequence. Never accept a client-supplied sequence value.';
comment on table public.nodex_sequence_commands is
  'Idempotency records retained for at least the complete retry horizon.';
comment on table public.nodex_sequence_outbox is
  'Transactional invalidation outbox; delivery retries preserve tenant, event_id, resource and seq.';
