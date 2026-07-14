-- Portable lease-based delivery operations for the sequence invalidation outbox.
create or replace function public.nodex_claim_sequence_outbox(
  p_tenant_id uuid,
  p_worker_id uuid,
  p_limit integer,
  p_lease_seconds integer
)
returns table (
  event_id uuid,
  resource_key text,
  seq bigint,
  sequence_updated_at timestamptz,
  attempts integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_tenant_id is null or p_worker_id is null
    or p_limit not between 1 and 100
    or p_lease_seconds not between 1 and 300 then
    raise exception using errcode = '22023', message = 'invalid outbox claim';
  end if;

  return query
  with candidates as (
    select pending.tenant_id, pending.event_id
    from public.nodex_sequence_outbox as pending
    where pending.tenant_id = p_tenant_id
      and pending.delivered_at is null
      and pending.available_at <= v_now
      and (pending.locked_until is null or pending.locked_until <= v_now)
    order by pending.available_at, pending.created_at, pending.event_id
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update public.nodex_sequence_outbox as pending
    set locked_by = p_worker_id,
        locked_until = v_now + make_interval(secs => p_lease_seconds),
        attempts = pending.attempts + 1
    from candidates
    where pending.tenant_id = candidates.tenant_id
      and pending.event_id = candidates.event_id
    returning pending.event_id, pending.resource_key, pending.seq,
      pending.sequence_updated_at, pending.attempts
  )
  select claimed.event_id, claimed.resource_key, claimed.seq,
    claimed.sequence_updated_at, claimed.attempts
  from claimed
  order by claimed.event_id;
end;
$$;

create or replace function public.nodex_ack_sequence_outbox(
  p_tenant_id uuid,
  p_event_id uuid,
  p_worker_id uuid
)
returns table (acknowledged boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_tenant_id is null or p_event_id is null or p_worker_id is null then
    raise exception using errcode = '22023', message = 'invalid outbox acknowledgement';
  end if;

  return query
  with updated as (
    update public.nodex_sequence_outbox as pending
    set delivered_at = clock_timestamp(),
        locked_by = null,
        locked_until = null,
        last_error = null
    where pending.tenant_id = p_tenant_id
      and pending.event_id = p_event_id
      and pending.locked_by = p_worker_id
      and pending.delivered_at is null
    returning 1
  )
  select exists(select 1 from updated);
end;
$$;

create or replace function public.nodex_retry_sequence_outbox(
  p_tenant_id uuid,
  p_event_id uuid,
  p_worker_id uuid,
  p_delay_ms integer,
  p_error text
)
returns table (retried boolean)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_tenant_id is null or p_event_id is null or p_worker_id is null
    or p_delay_ms not between 0 and 3600000
    or p_error is null or length(p_error) not between 1 and 1024 then
    raise exception using errcode = '22023', message = 'invalid outbox retry';
  end if;

  return query
  with updated as (
    update public.nodex_sequence_outbox as pending
    set available_at = v_now + make_interval(secs => p_delay_ms / 1000.0),
        locked_by = null,
        locked_until = null,
        last_error = p_error
    where pending.tenant_id = p_tenant_id
      and pending.event_id = p_event_id
      and pending.locked_by = p_worker_id
      and pending.delivered_at is null
    returning 1
  )
  select exists(select 1 from updated);
end;
$$;

revoke all on function public.nodex_claim_sequence_outbox(uuid, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.nodex_ack_sequence_outbox(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.nodex_retry_sequence_outbox(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated;

grant execute on function public.nodex_claim_sequence_outbox(uuid, uuid, integer, integer)
  to service_role;
grant execute on function public.nodex_ack_sequence_outbox(uuid, uuid, uuid)
  to service_role;
grant execute on function public.nodex_retry_sequence_outbox(uuid, uuid, uuid, integer, text)
  to service_role;
