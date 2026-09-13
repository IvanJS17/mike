-- LiTT sync S3 port of upstream 20260904_01_organization_access.sql; renamed to the merge-time stem 20260910_03 (recovery series).
-- ADAPTED to LiTT invariants; deviations from upstream are marked "LITT:" and specified in
-- forensics/upstream-sync-plan-20260912/S3-DESIGN.md (§1 recortes, §2 decisiones):
--   * org_members is NOT adopted: every reference maps to organization_memberships
--     (closed role vocab, status='active', authorization_epoch).
--   * No role defaults on grants or invitations (explicit roles only).
--   * No implicit org-role -> content grants: membership alone grants NOTHING over content;
--     only explicit project_org_access_overrides / workflow_org_access_overrides grant roles.
--     (Upstream's admin->owner and member->editor mapping is rejected.)
--   * LITT: last-org_owner guard added (organization_memberships_protect_last_owner).
--   * user_id stays NOT NULL and user_id FKs are unchanged (no DROP NOT NULL, no FK re-adds).
--   * Org-aware overview RPCs are deferred (S3.2); this file does not touch them.
--   * Legacy shared_with / allow_edit columns are preserved (backfill-only in 20260910_04).
-- Migration date: 2026-09-04

begin;

set local check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- Access-role helpers (SQL twins of backend/src/lib/access.ts; LiTT vocab).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_access_role(p_chat_id uuid, p_chat_user_id uuid, p_project_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p_project_id is not null then (
      select public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) from public.projects p where p.id = p_project_id
    )
    when p_chat_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.chat_access_grants g
      where g.chat_id = p_chat_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$function$;
revoke all on function public.chat_access_role(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.chat_access_role(uuid, uuid, uuid, uuid, text, text) to service_role;

CREATE OR REPLACE FUNCTION public.cleanup_inherited_direct_grants()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if tg_table_name = 'projects' then
    if new.org_id is not null then
      delete from public.project_access_grants where project_id = new.id;
    end if;
    delete from public.project_org_access_overrides
    where project_id = new.id and org_id is distinct from new.org_id;
  elsif tg_table_name = 'chats' then
    if new.project_id is not null then
      delete from public.chat_access_grants where chat_id = new.id;
    end if;
  elsif tg_table_name = 'tabular_reviews' then
    if new.project_id is not null then
      delete from public.tabular_review_access_grants where tabular_review_id = new.id;
    end if;
  elsif tg_table_name = 'workflows' then
    if new.org_id is not null then
      delete from public.workflow_shares where workflow_id = new.id;
    end if;
    delete from public.workflow_org_access_overrides
    where workflow_id = new.id and org_id is distinct from new.org_id;
  end if;
  return new;
end;
$function$;
revoke all on function public.cleanup_inherited_direct_grants() from public, anon, authenticated;

-- LITT: cleanup_org_admin_access_overrides (upstream, deletes overrides when a member
-- becomes admin — redundant under the implicit admin->owner mapping) is intentionally
-- DROPPED here: with no implicit mapping there is nothing to clean up.

CREATE OR REPLACE FUNCTION public.cleanup_removed_org_member_overrides()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'DELETE' or new.status is distinct from 'active' then
    delete from public.project_org_access_overrides
    where org_id = old.organization_id and user_id = old.user_id;
    delete from public.workflow_org_access_overrides
    where org_id = old.organization_id and user_id = old.user_id;
  end if;
  return coalesce(new, old);
end;
$function$;
revoke all on function public.cleanup_removed_org_member_overrides() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.project_access_role(p_project_id uuid, p_project_user_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p_org_id is not null then (
      select case
        when p_project_user_id::text = p_user_id then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        else null
      end
      from public.organization_memberships m
      left join public.project_org_access_overrides o
        on o.project_id = p_project_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.organization_id = p_org_id
        and m.user_id::text = p_user_id
        and m.status = 'active'
    )
    when p_project_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.project_access_grants g
      where g.project_id = p_project_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$function$;
revoke all on function public.project_access_role(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.project_access_role(uuid, uuid, uuid, text, text) to service_role;

CREATE OR REPLACE FUNCTION public.review_access_role(p_review_id uuid, p_review_user_id uuid, p_project_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p_project_id is not null then (
      select public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) from public.projects p where p.id = p_project_id
    )
    when p_review_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.tabular_review_access_grants g
      where g.tabular_review_id = p_review_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$function$;
revoke all on function public.review_access_role(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.review_access_role(uuid, uuid, uuid, uuid, text, text) to service_role;

CREATE OR REPLACE FUNCTION public.sync_project_child_org_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare parent_org_id uuid;
begin
  if new.project_id is null then return new; end if;
  select p.org_id into parent_org_id
  from public.projects p where p.id = new.project_id for key share;
  if not found then
    raise exception 'Project not found' using errcode = '23503';
  end if;
  new.org_id := parent_org_id;
  return new;
end;
$function$;
revoke all on function public.sync_project_child_org_id() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.validate_direct_access_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare invalid_scope boolean;
begin
  case tg_table_name
    when 'project_access_grants' then
      select p.org_id is not null into invalid_scope
      from public.projects p where p.id = new.project_id for update;
    when 'chat_access_grants' then
      select c.project_id is not null into invalid_scope
      from public.chats c where c.id = new.chat_id for update;
    when 'tabular_review_access_grants' then
      select tr.project_id is not null into invalid_scope
      from public.tabular_reviews tr where tr.id = new.tabular_review_id for update;
    when 'workflow_shares' then
      select w.org_id is not null into invalid_scope
      from public.workflows w where w.id = new.workflow_id for update;
    else
      raise exception 'Unsupported direct access table';
  end case;
  if coalesce(invalid_scope, true) then
    raise exception 'Direct grants are not allowed for organization or inherited content'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;
revoke all on function public.validate_direct_access_scope() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.validate_org_access_override()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare resource_org_id uuid;
declare resource_creator_id uuid;
begin
  case tg_table_name
    when 'project_org_access_overrides' then
      select p.org_id, p.user_id into resource_org_id, resource_creator_id
      from public.projects p where p.id = new.project_id for update;
    when 'workflow_org_access_overrides' then
      select w.org_id, w.user_id into resource_org_id, resource_creator_id
      from public.workflows w where w.id = new.workflow_id for update;
    else
      raise exception 'Unsupported organization override table';
  end case;

  if resource_org_id is null or resource_org_id is distinct from new.org_id then
    raise exception 'Organization override does not match the resource organization'
      using errcode = '23514';
  end if;
  if resource_creator_id = new.user_id then
    raise exception 'The creator is always an owner'
      using errcode = '23514';
  end if;
  perform 1
  from public.organization_memberships m
  where m.organization_id = new.org_id and m.user_id = new.user_id and m.status = 'active'
  for key share;
  if not found then
    raise exception 'Organization access overrides require active membership'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;
revoke all on function public.validate_org_access_override() from public, anon, authenticated;

-- LITT: last-org_owner guard. An organization must always keep at least one active
-- org_owner; demotions, revocations and deletes that would orphan the organization are
-- rejected at the database level (fail-closed). Upstream's equivalent guarded its
-- admin|member model; this is the LiTT closed-vocab counterpart.
CREATE OR REPLACE FUNCTION public.organization_memberships_protect_last_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare remaining_owners integer;
begin
  if old.role = 'org_owner' and old.status = 'active' then
    if tg_op = 'DELETE' or new.role <> 'org_owner' or new.status <> 'active' then
      if tg_op = 'DELETE' then
        if not exists (select 1 from public.organizations where id = old.organization_id) then
          return old; -- organization teardown cascade; nothing left to protect
        end if;
      end if;
      select count(*) into remaining_owners
      from public.organization_memberships
      where organization_id = old.organization_id
        and role = 'org_owner'
        and status = 'active'
        and user_id <> old.user_id;
      if remaining_owners = 0 then
        raise exception 'An organization must keep at least one owner'
          using errcode = '23514';
      end if;
    end if;
  end if;
  return coalesce(new, old);
end;
$function$;
revoke all on function public.organization_memberships_protect_last_owner() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.workflow_access_role(p_workflow_id uuid, p_workflow_user_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p_org_id is not null then (
      select case
        when p_workflow_user_id::text = p_user_id then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        else null
      end
      from public.organization_memberships m
      left join public.workflow_org_access_overrides o
        on o.workflow_id = p_workflow_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.organization_id = p_org_id
        and m.user_id::text = p_user_id
        and m.status = 'active'
    )
    when p_workflow_user_id::text = p_user_id then 'owner'
    else (
      select s.role from public.workflow_shares s
      where s.workflow_id = p_workflow_id
        and coalesce(p_user_email, '') <> ''
        and s.shared_with_email = lower(p_user_email)
      limit 1
    )
  end;
$function$;
revoke all on function public.workflow_access_role(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.workflow_access_role(uuid, uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Direct access grants (personal scope only; explicit roles, no defaults).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_access_grants (id uuid DEFAULT gen_random_uuid() NOT NULL, chat_id uuid NOT NULL, email text NOT NULL, role text NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.chat_access_grants ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_chat_id_email_key' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_chat_id_email_key UNIQUE (chat_id, email);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_chat_id_fkey' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.chats(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_created_by_fkey' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_email_lowercase' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_email_lowercase CHECK (email = lower(email));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_pkey' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_access_grants_role_check' AND conrelid = 'public.chat_access_grants'::regclass) THEN
    ALTER TABLE public.chat_access_grants ADD CONSTRAINT chat_access_grants_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text]));
  END IF;
END $do$;
revoke all on public.chat_access_grants from anon;
revoke all on public.chat_access_grants from authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.chat_access_grants TO service_role;
CREATE INDEX IF NOT EXISTS idx_chat_access_grants_email ON public.chat_access_grants (email);
CREATE INDEX IF NOT EXISTS idx_chat_access_grants_chat ON public.chat_access_grants (chat_id);
DROP TRIGGER IF EXISTS chat_access_grants_scope_guard ON public.chat_access_grants;
CREATE TRIGGER chat_access_grants_scope_guard BEFORE INSERT OR UPDATE ON public.chat_access_grants FOR EACH ROW EXECUTE FUNCTION public.validate_direct_access_scope();

CREATE TABLE IF NOT EXISTS public.project_access_grants (id uuid DEFAULT gen_random_uuid() NOT NULL, project_id uuid NOT NULL, email text NOT NULL, role text NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.project_access_grants ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_created_by_fkey' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_email_lowercase' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_email_lowercase CHECK (email = lower(email));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_pkey' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_project_id_email_key' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_project_id_email_key UNIQUE (project_id, email);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_project_id_fkey' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_access_grants_role_check' AND conrelid = 'public.project_access_grants'::regclass) THEN
    ALTER TABLE public.project_access_grants ADD CONSTRAINT project_access_grants_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text]));
  END IF;
END $do$;
revoke all on public.project_access_grants from anon;
revoke all on public.project_access_grants from authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.project_access_grants TO service_role;
CREATE INDEX IF NOT EXISTS idx_project_access_grants_email ON public.project_access_grants (email);
CREATE INDEX IF NOT EXISTS idx_project_access_grants_project ON public.project_access_grants (project_id);
DROP TRIGGER IF EXISTS project_access_grants_scope_guard ON public.project_access_grants;
CREATE TRIGGER project_access_grants_scope_guard BEFORE INSERT OR UPDATE ON public.project_access_grants FOR EACH ROW EXECUTE FUNCTION public.validate_direct_access_scope();

CREATE TABLE IF NOT EXISTS public.tabular_review_access_grants (id uuid DEFAULT gen_random_uuid() NOT NULL, tabular_review_id uuid NOT NULL, email text NOT NULL, role text NOT NULL, created_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.tabular_review_access_grants ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_created_by_fkey' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_email_lowercase' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_email_lowercase CHECK (email = lower(email));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_pkey' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_role_check' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text]));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_tabular_review_id_email_key' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_tabular_review_id_email_key UNIQUE (tabular_review_id, email);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_review_access_grants_tabular_review_id_fkey' AND conrelid = 'public.tabular_review_access_grants'::regclass) THEN
    ALTER TABLE public.tabular_review_access_grants ADD CONSTRAINT tabular_review_access_grants_tabular_review_id_fkey FOREIGN KEY (tabular_review_id) REFERENCES public.tabular_reviews(id) ON DELETE CASCADE;
  END IF;
END $do$;
revoke all on public.tabular_review_access_grants from anon;
revoke all on public.tabular_review_access_grants from authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tabular_review_access_grants TO service_role;
CREATE INDEX IF NOT EXISTS idx_tabular_review_access_grants_review ON public.tabular_review_access_grants (tabular_review_id);
CREATE INDEX IF NOT EXISTS idx_tabular_review_access_grants_email ON public.tabular_review_access_grants (email);
DROP TRIGGER IF EXISTS tabular_review_access_grants_scope_guard ON public.tabular_review_access_grants;
CREATE TRIGGER tabular_review_access_grants_scope_guard BEFORE INSERT OR UPDATE ON public.tabular_review_access_grants FOR EACH ROW EXECUTE FUNCTION public.validate_direct_access_scope();

-- ---------------------------------------------------------------------------
-- Organization access overrides (explicit per-member roles; 'deny' supported).
-- LITT: membership FK now targets organization_memberships(organization_id, user_id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_org_access_overrides (id uuid DEFAULT gen_random_uuid() NOT NULL, project_id uuid NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, assigned_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.project_org_access_overrides ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_assigned_by_fkey' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_org_id_fkey' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_org_id_user_id_fkey' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_org_id_user_id_fkey FOREIGN KEY (org_id, user_id) REFERENCES public.organization_memberships(organization_id, user_id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_pkey' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_project_id_fkey' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_project_id_user_id_key' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_project_id_user_id_key UNIQUE (project_id, user_id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_org_access_overrides_role_check' AND conrelid = 'public.project_org_access_overrides'::regclass) THEN
    ALTER TABLE public.project_org_access_overrides ADD CONSTRAINT project_org_access_overrides_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text, 'deny'::text]));
  END IF;
END $do$;
revoke all on public.project_org_access_overrides from anon;
revoke all on public.project_org_access_overrides from authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.project_org_access_overrides TO service_role;
CREATE INDEX IF NOT EXISTS idx_project_org_access_overrides_user ON public.project_org_access_overrides (user_id);
DROP TRIGGER IF EXISTS project_org_access_overrides_guard ON public.project_org_access_overrides;
CREATE TRIGGER project_org_access_overrides_guard BEFORE INSERT OR UPDATE ON public.project_org_access_overrides FOR EACH ROW EXECUTE FUNCTION public.validate_org_access_override();

CREATE TABLE IF NOT EXISTS public.workflow_org_access_overrides (id uuid DEFAULT gen_random_uuid() NOT NULL, workflow_id uuid NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL, assigned_by uuid, created_at timestamp with time zone DEFAULT now() NOT NULL, updated_at timestamp with time zone DEFAULT now() NOT NULL);
ALTER TABLE public.workflow_org_access_overrides ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_assigned_by_fkey' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_org_id_fkey' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_org_id_user_id_fkey' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_org_id_user_id_fkey FOREIGN KEY (org_id, user_id) REFERENCES public.organization_memberships(organization_id, user_id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_pkey' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_role_check' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text, 'deny'::text]));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_workflow_id_fkey' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_org_access_overrides_workflow_id_user_id_key' AND conrelid = 'public.workflow_org_access_overrides'::regclass) THEN
    ALTER TABLE public.workflow_org_access_overrides ADD CONSTRAINT workflow_org_access_overrides_workflow_id_user_id_key UNIQUE (workflow_id, user_id);
  END IF;
END $do$;
revoke all on public.workflow_org_access_overrides from anon;
revoke all on public.workflow_org_access_overrides from authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.workflow_org_access_overrides TO service_role;
CREATE INDEX IF NOT EXISTS idx_workflow_org_access_overrides_user ON public.workflow_org_access_overrides (user_id);
DROP TRIGGER IF EXISTS workflow_org_access_overrides_guard ON public.workflow_org_access_overrides;
CREATE TRIGGER workflow_org_access_overrides_guard BEFORE INSERT OR UPDATE ON public.workflow_org_access_overrides FOR EACH ROW EXECUTE FUNCTION public.validate_org_access_override();

-- ---------------------------------------------------------------------------
-- Organization invitations.
-- LITT: role has NO default and is checked against the closed LiTT org vocab;
-- accepts land in organization_memberships (epoch bump via 20260831_01 trigger).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.org_invitations (id uuid DEFAULT gen_random_uuid() NOT NULL, org_id uuid NOT NULL, email text NOT NULL, role text NOT NULL, invited_by uuid, status text DEFAULT 'pending'::text NOT NULL, expires_at timestamp with time zone DEFAULT (now() + '14 days'::interval) NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, accepted_at timestamp with time zone, declined_at timestamp with time zone, cancelled_at timestamp with time zone);
ALTER TABLE public.org_invitations ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_email_lowercase' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_email_lowercase CHECK (email = lower(email));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_invited_by_fkey' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_org_id_fkey' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_pkey' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_pkey PRIMARY KEY (id);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_role_check' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_role_check CHECK (role = ANY (ARRAY['org_owner'::text, 'workspace_admin'::text, 'editor'::text, 'viewer'::text, 'technical_operator'::text]));
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_invitations_status_check' AND conrelid = 'public.org_invitations'::regclass) THEN
    ALTER TABLE public.org_invitations ADD CONSTRAINT org_invitations_status_check CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'cancelled'::text, 'expired'::text]));
  END IF;
END $do$;
revoke all on public.org_invitations from anon;
revoke all on public.org_invitations from authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.org_invitations TO service_role;
CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON public.org_invitations (org_id);
CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON public.org_invitations (email) WHERE status = 'pending'::text;
CREATE UNIQUE INDEX IF NOT EXISTS org_invitations_active_unique ON public.org_invitations (org_id, email) WHERE status = 'pending'::text;

-- ---------------------------------------------------------------------------
-- org_id on the five content tables (+ guards). user_id NOT NULL stays.
-- ---------------------------------------------------------------------------
ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS org_id uuid;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chats_org_requires_project' AND conrelid = 'public.chats'::regclass) THEN
    ALTER TABLE public.chats ADD CONSTRAINT chats_org_requires_project CHECK (org_id IS NULL OR project_id IS NOT NULL);
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chats_org_id_fkey' AND conrelid = 'public.chats'::regclass) THEN
    ALTER TABLE public.chats ADD CONSTRAINT chats_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS idx_chats_org ON public.chats (org_id);
DROP TRIGGER IF EXISTS chats_cleanup_direct_grants ON public.chats;
CREATE TRIGGER chats_cleanup_direct_grants AFTER INSERT OR UPDATE OF project_id, org_id ON public.chats FOR EACH ROW EXECUTE FUNCTION public.cleanup_inherited_direct_grants();
DROP TRIGGER IF EXISTS chats_sync_project_org ON public.chats;
CREATE TRIGGER chats_sync_project_org BEFORE INSERT OR UPDATE OF project_id, org_id ON public.chats FOR EACH ROW EXECUTE FUNCTION public.sync_project_child_org_id();

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS org_id uuid;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_org_id_fkey' AND conrelid = 'public.documents'::regclass) THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS idx_documents_org ON public.documents (org_id);
DROP TRIGGER IF EXISTS documents_sync_project_org ON public.documents;
CREATE TRIGGER documents_sync_project_org BEFORE INSERT OR UPDATE OF project_id, org_id ON public.documents FOR EACH ROW EXECUTE FUNCTION public.sync_project_child_org_id();

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS org_id uuid;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_org_id_fkey' AND conrelid = 'public.projects'::regclass) THEN
    ALTER TABLE public.projects ADD CONSTRAINT projects_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS idx_projects_org ON public.projects (org_id);
DROP TRIGGER IF EXISTS projects_cleanup_direct_grants ON public.projects;
CREATE TRIGGER projects_cleanup_direct_grants AFTER INSERT OR UPDATE OF org_id ON public.projects FOR EACH ROW EXECUTE FUNCTION public.cleanup_inherited_direct_grants();

ALTER TABLE public.tabular_reviews ADD COLUMN IF NOT EXISTS org_id uuid;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_reviews_org_id_fkey' AND conrelid = 'public.tabular_reviews'::regclass) THEN
    ALTER TABLE public.tabular_reviews ADD CONSTRAINT tabular_reviews_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END $do$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tabular_reviews_org_requires_project' AND conrelid = 'public.tabular_reviews'::regclass) THEN
    ALTER TABLE public.tabular_reviews ADD CONSTRAINT tabular_reviews_org_requires_project CHECK (org_id IS NULL OR project_id IS NOT NULL);
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS idx_tabular_reviews_org ON public.tabular_reviews (org_id);
DROP TRIGGER IF EXISTS tabular_reviews_cleanup_direct_grants ON public.tabular_reviews;
CREATE TRIGGER tabular_reviews_cleanup_direct_grants AFTER INSERT OR UPDATE OF project_id, org_id ON public.tabular_reviews FOR EACH ROW EXECUTE FUNCTION public.cleanup_inherited_direct_grants();
DROP TRIGGER IF EXISTS tabular_reviews_sync_project_org ON public.tabular_reviews;
CREATE TRIGGER tabular_reviews_sync_project_org BEFORE INSERT OR UPDATE OF project_id, org_id ON public.tabular_reviews FOR EACH ROW EXECUTE FUNCTION public.sync_project_child_org_id();

ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS org_id uuid;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflows_org_id_fkey' AND conrelid = 'public.workflows'::regclass) THEN
    ALTER TABLE public.workflows ADD CONSTRAINT workflows_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS idx_workflows_org ON public.workflows (org_id);
DROP TRIGGER IF EXISTS workflows_cleanup_direct_grants ON public.workflows;
CREATE TRIGGER workflows_cleanup_direct_grants AFTER INSERT OR UPDATE OF org_id ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.cleanup_inherited_direct_grants();

ALTER TABLE public.workflow_shares ADD COLUMN IF NOT EXISTS role text DEFAULT 'viewer'::text NOT NULL;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_shares_role_check' AND conrelid = 'public.workflow_shares'::regclass) THEN
    ALTER TABLE public.workflow_shares ADD CONSTRAINT workflow_shares_role_check CHECK (role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text]));
  END IF;
END $do$;
DROP TRIGGER IF EXISTS workflow_shares_scope_guard ON public.workflow_shares;
CREATE TRIGGER workflow_shares_scope_guard BEFORE INSERT OR UPDATE ON public.workflow_shares FOR EACH ROW EXECUTE FUNCTION public.validate_direct_access_scope();

-- ---------------------------------------------------------------------------
-- Membership-side guards on organization_memberships (LITT adaptations).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS organization_memberships_cleanup_access_overrides ON public.organization_memberships;
CREATE TRIGGER organization_memberships_cleanup_access_overrides AFTER UPDATE OF status OR DELETE ON public.organization_memberships FOR EACH ROW EXECUTE FUNCTION public.cleanup_removed_org_member_overrides();
DROP TRIGGER IF EXISTS organization_memberships_last_owner_guard ON public.organization_memberships;
CREATE TRIGGER organization_memberships_last_owner_guard BEFORE UPDATE OF role, status OR DELETE ON public.organization_memberships FOR EACH ROW EXECUTE FUNCTION public.organization_memberships_protect_last_owner();

notify pgrst, 'reload schema';

commit;
