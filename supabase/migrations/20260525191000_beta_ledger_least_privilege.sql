-- Keep beta_ledger read-only even for the backend service role.

revoke all on public.beta_ledger from service_role;
grant select on public.beta_ledger to service_role;
