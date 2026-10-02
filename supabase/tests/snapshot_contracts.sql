-- Run after migrations on a disposable database. All test writes roll back.
begin;
do $$
declare
  tenant uuid := '00000000-0000-4000-8000-999999999999';
  command uuid := '00000000-0000-4000-8000-999999999998';
  key text := '/api/products/sql-contract';
  result record;
  head record;
begin
  select * into result from public.nodex_write_snapshot(tenant,key,gen_random_uuid(),9,'{}');
  assert result.conflict and result.seq=0,'future write must conflict';
  assert not exists(select 1 from public.nodex_sequence_heads where tenant_id=tenant),'conflict must not create a head';
  select * into result from public.nodex_write_snapshot(tenant,key,command,0,'{"price":18.5}');
  assert result.seq=1 and not result.conflict and not result.duplicate,'initial snapshot';
  select * into head from public.nodex_read_snapshot(tenant,key);
  assert head.payload='{"price":18.5}'::jsonb and head.seq=1,'payload and version read atomically';
  select * into result from public.nodex_write_snapshot(tenant,key,command,0,'{"price":18.5}');
  assert result.duplicate and result.seq=1,'same command must replay';
  begin
    perform public.nodex_write_snapshot(tenant,key,command,0,'{"price":99}');
    raise exception 'different payload was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.nodex_bump_sequence(tenant,key,command);
    raise exception 'write identity was accepted as a bump';
  exception when invalid_parameter_value then null;
  end;
  select * into result from public.nodex_write_snapshot(tenant,key,gen_random_uuid(),0,'{"price":99}');
  assert result.conflict and result.seq=1,'stale write must conflict';
  assert (select count(*) from public.nodex_sequence_outbox where tenant_id=tenant)=1,'only accepted write creates an event';
  perform public.nodex_bump_sequence(tenant,key,gen_random_uuid());
  select * into head from public.nodex_read_snapshot(tenant,key);
  assert head.seq=2 and head.payload='{"price":18.5}'::jsonb,'invalidation preserves payload';
end;
$$;
rollback;
