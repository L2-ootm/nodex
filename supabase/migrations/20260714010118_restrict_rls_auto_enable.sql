-- Preserve the ensure_rls event trigger while preventing PostgREST roles from
-- invoking its SECURITY DEFINER handler directly.
-- The handler is provisioned by Supabase, not by this application. A fresh
-- PostgreSQL database may not have it; preserve its restrictions when present.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
    execute $comment$comment on function public.rls_auto_enable() is
      'Internal handler for the ensure_rls event trigger; not callable by API roles.'$comment$;
  end if;
end;
$$;
