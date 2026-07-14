-- Preserve the ensure_rls event trigger while preventing PostgREST roles from
-- invoking its SECURITY DEFINER handler directly.
revoke all on function public.rls_auto_enable() from public, anon, authenticated;

comment on function public.rls_auto_enable() is
  'Internal handler for the ensure_rls event trigger; not callable by API roles.';
