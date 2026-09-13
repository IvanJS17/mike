-- LiTT sync S3 port of upstream 20260904_02_migrate_legacy_sharing.sql; renamed to the merge-time stem 20260910_04 (recovery series).
-- ADAPTED: the column drops from upstream are deferred (recorte LiTT #7 in S3-DESIGN.md):
-- projects.shared_with, tabular_reviews.shared_with and workflow_shares.allow_edit are
-- preserved; this file only backfills the new grant tables / role column from them.
-- Legacy columns are written by nothing after S3; runtime reads the grants.
-- Migration date: 2026-09-04

begin;

do $migration$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'projects'
      and column_name = 'shared_with'
  ) then
    execute $sql$
      insert into public.project_access_grants (
        project_id, email, role, created_by
      )
      select distinct
        project.id,
        lower(trim(recipient.email)),
        'editor',
        project.user_id
      from public.projects project
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(project.shared_with) = 'array'
            then project.shared_with
          else '[]'::jsonb
        end
      ) recipient(email)
      where trim(recipient.email) <> ''
        and position('@' in recipient.email) > 0
        and project.org_id is null
      on conflict (project_id, email) do nothing
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tabular_reviews'
      and column_name = 'shared_with'
  ) then
    execute $sql$
      insert into public.tabular_review_access_grants (
        tabular_review_id, email, role, created_by
      )
      select distinct
        review.id,
        lower(trim(recipient.email)),
        'editor',
        review.user_id
      from public.tabular_reviews review
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(review.shared_with) = 'array'
            then review.shared_with
          else '[]'::jsonb
        end
      ) recipient(email)
      where review.project_id is null
        and trim(recipient.email) <> ''
        and position('@' in recipient.email) > 0
      on conflict (tabular_review_id, email) do nothing
    $sql$;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'workflow_shares'
      and column_name = 'allow_edit'
  ) then
    execute $sql$
      update public.workflow_shares
      set role = case when allow_edit then 'editor' else 'viewer' end
    $sql$;
  end if;
end;
$migration$;

notify pgrst, 'reload schema';

commit;
