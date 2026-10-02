-- Disposable database only; all changes roll back.
begin;
do $$
declare
  invitation uuid := gen_random_uuid();
  tenant uuid := gen_random_uuid();
  worker uuid := gen_random_uuid();
  event uuid;
  result jsonb;
  accepted boolean;
begin
  insert into public.beta_tokens(id,token_hash,token_preview,role,label,created_by)
    values(invitation,repeat('c',64),'synthetic','tester','SQL contract','test');
  perform public.beta_record_token_use(repeat('c',64),null,null);
  perform public.beta_record_token_use(repeat('c',64),null,null);
  assert (select use_count=2 from public.beta_tokens where id=invitation),'uses must accumulate atomically';
  select public.nodex_beta_enroll('{"name":"SQL tester"}',repeat('a',64),repeat('b',64),repeat('c',64),invitation,'SQL contract',1) into result;
  assert result is not null,'active invitation enrolls';
  update public.beta_tokens set active=false,revoked_at=clock_timestamp() where id=invitation;
  assert not public.beta_record_token_use(repeat('c',64),null,null),'revoked use cannot increment';
  select public.nodex_beta_enroll('{"name":"SQL tester"}',repeat('a',64),repeat('b',64),repeat('c',64),invitation,'SQL contract',1) into result;
  assert result is null,'revocation blocks stale authorized enrollment retries';
  assert not has_function_privilege('anon','public.beta_record_token_use(text,text,text)','execute'),'anon must not use service RPC';
  assert not has_function_privilege('authenticated','public.nodex_beta_enroll(jsonb,text,text,text,uuid,text,integer)','execute'),'authenticated role must not enroll via service RPC';

  select event_id into event from public.nodex_bump_sequence(tenant,'/api/products/lease-contract',gen_random_uuid());
  update public.nodex_sequence_outbox set locked_by=worker,locked_until=clock_timestamp()-interval '1 second'
    where tenant_id=tenant and event_id=event;
  select acknowledged into accepted from public.nodex_ack_sequence_outbox(tenant,event,worker);
  assert not accepted,'expired lease cannot acknowledge';
  select retried into accepted from public.nodex_retry_sequence_outbox(tenant,event,worker,0,'late');
  assert not accepted,'expired lease cannot retry';
  update public.nodex_sequence_outbox set locked_until=clock_timestamp()+interval '1 minute'
    where tenant_id=tenant and event_id=event;
  select acknowledged into accepted from public.nodex_ack_sequence_outbox(tenant,event,gen_random_uuid());
  assert not accepted,'foreign lease owner cannot acknowledge';
  select acknowledged into accepted from public.nodex_ack_sequence_outbox(tenant,event,worker);
  assert accepted,'current lease owner can acknowledge';
end $$;
rollback;
