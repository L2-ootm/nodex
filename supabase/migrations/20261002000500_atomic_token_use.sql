-- Diagnostic use counter must not overwrite concurrent revocation or usage.
create or replace function public.beta_record_token_use(p_token_hash text, p_ip text, p_user_agent text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.beta_tokens set use_count = use_count + 1, last_used_at = clock_timestamp(),
    last_used_ip = left(p_ip, 128), last_used_user_agent = left(p_user_agent, 1024)
  where token_hash = p_token_hash and active and revoked_at is null
    and (expires_at is null or expires_at > clock_timestamp());
  return found;
end $$;
revoke all on function public.beta_record_token_use(text,text,text) from public, anon, authenticated;
grant execute on function public.beta_record_token_use(text,text,text) to service_role;
