-- Step 4: dispatcher-only catalog snapshot. No workflow or inventory writes.
begin;
create function public.bedlink_read_matching_catalog()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t timestamptz := date_trunc('milliseconds',clock_timestamp());
begin
  if auth.uid() is null then
    return bedlink_private.api_error(401,'UNAUTHENTICATED','Authentication required.',t);
  end if;
  -- Hold the checked assignment steady until the short snapshot transaction ends.
  perform 1 from public.staff_memberships
    where user_id=auth.uid() and role='dispatcher' and is_active for share;
  if not found then
    return bedlink_private.api_error(403,'FORBIDDEN','Active dispatcher membership required.',t);
  end if;
  -- Reuse Step 3's database-time snapshot and exact active/unexpired hold counting.
  -- No travel provider runs in this transaction, and no patient rows are projected.
  return public.bedlink_read_availability(null);
end;
$$;
alter function public.bedlink_read_matching_catalog() owner to postgres;
revoke all on function public.bedlink_read_matching_catalog() from public,anon,authenticated,service_role;
grant execute on function public.bedlink_read_matching_catalog() to authenticated;
commit;
