-- Additive: lists abandoned attachment rows so a sweeper can remove them. Never returns 'ready' rows.
-- 'pending' = intent created but never finalised; 'deleting'/'delete_failed' = an interrupted or failed removal.
begin;
create or replace function public.wiz_attachment_list_abandoned(p_older_than_seconds integer, p_limit integer) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_older_than_seconds is null or p_older_than_seconds < 3600 or p_limit is null or p_limit < 1 or p_limit > 100 then
    perform public.wiz_fail('invalid_request');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', x.user_id, 'id', x.id) order by x.created_at, x.id)
    from (select a.user_id, a.id, a.created_at from public.wiz_attachments a
          where a.state in ('pending', 'deleting', 'delete_failed')
            and a.created_at < now() - make_interval(secs => p_older_than_seconds)
          order by a.created_at, a.id limit p_limit) x), '[]'::jsonb);
end $$;
revoke all on function public.wiz_attachment_list_abandoned(integer, integer) from public, anon, authenticated;
grant execute on function public.wiz_attachment_list_abandoned(integer, integer) to service_role;
commit;
