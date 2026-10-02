-- Expired leases cannot acknowledge or reschedule an event.
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
      and pending.locked_until > clock_timestamp()
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
      and pending.locked_until > clock_timestamp()
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
