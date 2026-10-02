-- Public snapshots: payload, version, retry identity and outbox commit together.
alter table public.nodex_sequence_heads add column if not exists payload jsonb;
alter table public.nodex_sequence_commands add column if not exists write_payload jsonb;
alter table public.nodex_sequence_commands add column if not exists expected_version bigint;

create or replace function public.nodex_read_snapshot(p_tenant_id uuid,p_resource_key text)
returns table(seq bigint,updated_at timestamptz,payload jsonb)
language sql security definer set search_path=pg_catalog,public as $$
  select h.seq,h.updated_at,h.payload from public.nodex_sequence_heads h
  where h.tenant_id=p_tenant_id and h.resource_key=p_resource_key;
$$;

create or replace function public.nodex_write_snapshot(
  p_tenant_id uuid,p_resource_key text,p_idempotency_key uuid,
  p_expected_version bigint,p_payload jsonb
) returns table(seq bigint,updated_at timestamptz,event_id uuid,duplicate boolean,conflict boolean)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  command public.nodex_sequence_commands%rowtype;
  head public.nodex_sequence_heads%rowtype;
  inserted integer;
  created_head integer;
  current_version bigint;
  instant timestamptz;
begin
  if p_tenant_id is null or p_idempotency_key is null or p_resource_key is null
    or p_resource_key !~ '^/api/products/[a-zA-Z0-9_-]+$' or length(p_resource_key)>256
    or p_expected_version is null or p_expected_version not between 0 and 9007199254740991
    or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>65536 then
    raise exception using errcode='22023',message='invalid snapshot command';
  end if;
  insert into public.nodex_sequence_commands(tenant_id,idempotency_key,resource_key,write_payload,expected_version)
    values(p_tenant_id,p_idempotency_key,p_resource_key,p_payload,p_expected_version)
    on conflict do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then
    select * into strict command from public.nodex_sequence_commands c
      where c.tenant_id=p_tenant_id and c.idempotency_key=p_idempotency_key;
    if command.resource_key is distinct from p_resource_key
      or command.write_payload is distinct from p_payload
      or command.expected_version is distinct from p_expected_version then
      raise exception using errcode='22023',message='idempotency key reused for a different command';
    end if;
    if command.seq is null then raise exception using errcode='40001',message='incomplete command'; end if;
    return query select command.seq,command.sequence_updated_at,p_idempotency_key,true,false;
    return;
  end if;
  -- An uncommitted placeholder reserves the initially absent row. No reader can
  -- observe it before payload, command and outbox are committed.
  insert into public.nodex_sequence_heads(tenant_id,resource_key,seq,updated_at)
    values(p_tenant_id,p_resource_key,1,clock_timestamp()) on conflict do nothing;
  get diagnostics created_head=row_count;
  select * into strict head from public.nodex_sequence_heads h
    where h.tenant_id=p_tenant_id and h.resource_key=p_resource_key for update;
  current_version:=case when created_head=1 then 0 else head.seq end;
  if current_version<>p_expected_version then
    if created_head=1 then
      delete from public.nodex_sequence_heads h
        where h.tenant_id=p_tenant_id and h.resource_key=p_resource_key;
    end if;
    delete from public.nodex_sequence_commands c
      where c.tenant_id=p_tenant_id and c.idempotency_key=p_idempotency_key;
    return query select current_version,head.updated_at,null::uuid,false,true;
    return;
  end if;
  if current_version=9007199254740991 then
    raise exception using errcode='22003',message='sequence exhausted';
  end if;
  instant:=clock_timestamp();
  update public.nodex_sequence_heads h set seq=current_version+1,updated_at=instant,payload=p_payload
    where h.tenant_id=p_tenant_id and h.resource_key=p_resource_key;
  update public.nodex_sequence_commands c set seq=current_version+1,sequence_updated_at=instant
    where c.tenant_id=p_tenant_id and c.idempotency_key=p_idempotency_key;
  insert into public.nodex_sequence_outbox(tenant_id,event_id,resource_key,seq,sequence_updated_at)
    values(p_tenant_id,p_idempotency_key,p_resource_key,current_version+1,instant);
  return query select current_version+1,instant,p_idempotency_key,false,false;
end;
$$;

-- Idempotency identities cannot be reused across bump and write commands.
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

    if v_existing.resource_key is distinct from p_resource_key or v_existing.write_payload is not null then
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

revoke all on function public.nodex_read_snapshot(uuid,text) from public,anon,authenticated;
revoke all on function public.nodex_write_snapshot(uuid,text,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.nodex_read_snapshot(uuid,text) to service_role;
grant execute on function public.nodex_write_snapshot(uuid,text,uuid,bigint,jsonb) to service_role;
