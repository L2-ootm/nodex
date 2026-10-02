-- Atomic presence, publisher messages and commit-ordered cursors. Service role only.
create table if not exists public.nodex_signal_nodes (
  tenant_id text not null, room_id text not null, node_id text not null,
  owner_hash text not null, grant_hash text not null,
  last_seen timestamptz not null default clock_timestamp(),
  primary key (tenant_id, room_id, node_id)
);
create table if not exists public.nodex_signal_messages (
  id bigint generated always as identity primary key,
  tenant_id text not null, room_id text not null, event_id text,
  message jsonb not null, created_at timestamptz not null default clock_timestamp(),
  unique (tenant_id, event_id), check (id <= 9007199254740991),
  check (octet_length(message::text) <= 131072)
);
create index if not exists nodex_signal_messages_room_cursor
  on public.nodex_signal_messages (tenant_id, room_id, id);
alter table public.nodex_signal_nodes enable row level security;
alter table public.nodex_signal_messages enable row level security;
revoke all on public.nodex_signal_nodes, public.nodex_signal_messages from anon, authenticated;

create or replace function public.nodex_signal_command(
  p_operation text, p_tenant text, p_room text, p_node text, p_owner text,
  p_grant_hash text, p_after bigint, p_message jsonb default null, p_event_id text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  node public.nodex_signal_nodes%rowtype;
  peers jsonb;
  batch jsonb;
  filtered jsonb;
  cursor_id bigint;
  duplicate_event boolean := false;
begin
  if p_operation not in ('join','send','poll','leave','seed') or
    p_tenant is null or length(p_tenant) < 1 or length(p_tenant) > 160 or
    p_room is null or length(p_room) < 1 or length(p_room) > 160 or
    p_after < 0 or p_after > 9007199254740991 then
    return jsonb_build_object('error','invalid command','status',400);
  end if;
  -- Serialize short tenant operations so sequence allocation and commit order
  -- cannot invert. This deliberately favors correctness for a bounded pilot.
  perform pg_advisory_xact_lock(hashtextextended('nodex-signal:' || p_tenant, 0));
  delete from public.nodex_signal_nodes where tenant_id=p_tenant and last_seen < clock_timestamp()-interval '45 seconds';
  delete from public.nodex_signal_messages where tenant_id=p_tenant and created_at < clock_timestamp()-interval '60 seconds';
  select * into node from public.nodex_signal_nodes
    where tenant_id=p_tenant and room_id=p_room and node_id=p_node;
  if p_operation='join' then
    if found and (node.owner_hash <> p_owner or node.grant_hash <> p_grant_hash) then
      return jsonb_build_object('error','node already registered','status',409);
    end if;
    insert into public.nodex_signal_nodes (tenant_id,room_id,node_id,owner_hash,grant_hash,last_seen)
      values (p_tenant,p_room,p_node,p_owner,p_grant_hash,clock_timestamp())
      on conflict (tenant_id,room_id,node_id) do update set last_seen=excluded.last_seen;
  elsif p_operation <> 'seed' then
    if node.node_id is null or node.owner_hash <> p_owner or node.grant_hash <> p_grant_hash then
      return jsonb_build_object('error','node grant required','status',403);
    end if;
    if p_operation='leave' then
      delete from public.nodex_signal_nodes where tenant_id=p_tenant and room_id=p_room and node_id=p_node;
      return jsonb_build_object('ok',true);
    end if;
    update public.nodex_signal_nodes set last_seen=clock_timestamp()
      where tenant_id=p_tenant and room_id=p_room and node_id=p_node
      and last_seen < clock_timestamp()-interval '15 seconds';
  end if;
  if p_operation in ('send','seed') then
    if p_message is null or octet_length(p_message::text) > 131072 then
      return jsonb_build_object('error','invalid message','status',400);
    end if;
    if p_operation='send' and not exists(select 1 from public.nodex_signal_nodes
      where tenant_id=p_tenant and room_id=p_room and node_id=p_message->>'to') then
      return jsonb_build_object('error','recipient unavailable','status',409);
    end if;
    if p_event_id is not null and exists(select 1 from public.nodex_signal_messages
      where tenant_id=p_tenant and event_id=p_event_id) then
      duplicate_event := true;
    else
      insert into public.nodex_signal_messages(tenant_id,room_id,event_id,message)
        values(p_tenant,p_room,p_event_id,p_message);
    end if;
    return jsonb_build_object('ok',true,'seeded',p_operation='seed','duplicate',duplicate_event);
  end if;
  select coalesce(jsonb_agg(node_id),'[]'::jsonb) into peers from (
    select node_id from public.nodex_signal_nodes
      where tenant_id=p_tenant and room_id=p_room and node_id<>p_node order by node_id limit 5
  ) active;
  if p_operation='join' then
    select coalesce(max(id),0) into cursor_id from public.nodex_signal_messages where tenant_id=p_tenant;
    return jsonb_build_object('peers',peers,'polite',jsonb_array_length(peers)>0,'after',cursor_id);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'message',message) order by id),'[]'::jsonb),
    coalesce(max(id),p_after) into batch,cursor_id from (
    select id,message from public.nodex_signal_messages
      where tenant_id=p_tenant and room_id in (p_room,'*') and id>p_after order by id limit 100
  ) selected;
  select coalesce(jsonb_agg(item order by (item->>'id')::bigint),'[]'::jsonb) into filtered
    from jsonb_array_elements(batch) item
    where item->'message'->>'type'='GOSSIP_INVALIDATE' or
      (coalesce(item->'message'->>'from','')<>p_node and
      (item->'message'->>'to' is null or item->'message'->>'to'=p_node));
  return jsonb_build_object('peers',peers,'polite',jsonb_array_length(peers)>0,'messages',filtered,'after',cursor_id);
end;
$$;
revoke all on function public.nodex_signal_command(text,text,text,text,text,text,bigint,jsonb,text) from public, anon, authenticated;
grant execute on function public.nodex_signal_command(text,text,text,text,text,text,bigint,jsonb,text) to service_role;
