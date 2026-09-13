// Business logic + data-access for the organizations / RBAC module.
//
// These functions are the service layer behind routes/orgs.ts. They take an
// explicit Supabase client (`db`) plus request-derived primitives, enforce the
// LiTT organization role model, and RETURN typed discriminated results the
// thin route handlers map onto HTTP status codes. They never touch req/res.
//
// Role model (see also backend/src/lib/access.ts):
//   org_owner | workspace_admin — the ADMIN tier: administers the
//            organization (settings, invitations, member roles and removal).
//   editor — content-collaboration tier; no org mutations.
//   viewer — read-only tier; no org mutations.
//   technical_operator — an operational role, orthogonal to the tiers above.
// The vocabulary is closed (mirrored by the organization_memberships CHECK
// and the org_invitations role CHECK). Unlike upstream, an organization role
// grants NOTHING over organization content by itself: there is no implicit
// admin->owner / member->editor mapping onto the org's resources, and content
// access requires explicit per-resource overrides (see the module comment in
// lib/access.ts).
//
// Membership lives in `organization_memberships` (composite primary key,
// `status` active|inactive|revoked) and is never granted directly. An admin
// creates an INVITATION; the row appears only when the invited account
// accepts it — or, once per org, when its creator is recorded as the first
// org_owner. Adding someone to a firm workspace exposes confidential content,
// so it takes the recipient's consent, not just the inviter's intent.
//
// Membership is never destroyed either: removal sets `status = 'revoked'` and
// keeps the row. The organization_memberships_epoch_bump trigger advances the
// organization's authorization_epoch on every membership mutation (the
// single increment site), and organization_memberships_protect_last_owner
// keeps an org administrable by refusing to demote or remove its last active
// org_owner — the service pre-checks mirror that guard so the ordinary case
// is a clean 409 instead of a raw 23514.

import { createServerSupabase } from "./supabase";
import { recordAudit } from "./audit";
import {
    getOrgRole,
    isOrgAdmin,
    isOrgRole,
    normalizeEmail,
    ORG_ROLES,
    type OrgRole,
} from "./access";
import { resolveExplicitInvitationRole } from "./recovery/authorization/onboardingProvisioning";

type Db = ReturnType<typeof createServerSupabase>;

type DbError = { code?: string; message: string } | null;

/** How long a pending invitation stays acceptable. */
export const INVITATION_TTL_DAYS = 14;

/** The closed role vocabulary, spelled out in every role 400 message. */
const ORG_ROLE_LIST = ORG_ROLES.join(", ");

export type InvitationStatus =
    | "pending"
    | "accepted"
    | "declined"
    | "cancelled"
    | "expired";

/**
 * The existence pre-checks in createInvitation race with concurrent inserts;
 * the unique indexes backstop correctness, but a raw 23505 would surface as a
 * 500. Map it onto the same 409 the sequential path returns.
 */
function isUniqueViolation(error: DbError): boolean {
    return error?.code === "23505";
}

/**
 * The organization_memberships_protect_last_owner trigger closes the
 * read-then-act race on last-org_owner protection at the DB level; when it
 * fires, translate its 23514 into the same `last_admin` result the sequential
 * in-process check produces.
 */
function isLastOwnerViolation(error: DbError): boolean {
    return (
        error?.code === "23514" &&
        (error?.message ?? "").includes("at least one owner")
    );
}

export type OrgResult<T> =
    | ({ ok: true } & T)
    | { ok: false; kind: "validation"; detail: string }
    | { ok: false; kind: "forbidden" }
    | { ok: false; kind: "not_found" }
    | { ok: false; kind: "conflict"; detail: string }
    | { ok: false; kind: "last_admin" }
    | { ok: false; kind: "expired" }
    | { ok: false; kind: "db_error"; detail: string };

// ---------------------------------------------------------------------------
// Org CRUD
// ---------------------------------------------------------------------------

export async function listMyOrgs(
    db: Db,
    userId: string,
): Promise<OrgResult<{ orgs: unknown[] }>> {
    const { data: memberships, error } = await db
        .from("organization_memberships")
        .select("organization_id, role")
        .eq("user_id", userId)
        .eq("status", "active");
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    const rows = (memberships ?? []) as {
        organization_id: string;
        role: OrgRole;
    }[];
    const roleByOrg = new Map<string, OrgRole>();
    for (const r of rows) roleByOrg.set(r.organization_id, r.role);
    const orgIds = [...roleByOrg.keys()];
    if (orgIds.length === 0) return { ok: true, orgs: [] };

    const { data: orgs, error: orgsError } = await db
        .from("organizations")
        .select("*")
        .in("id", orgIds);
    if (orgsError)
        return { ok: false, kind: "db_error", detail: orgsError.message };

    // Roster sizes let the UI render "N members" without a second round-trip
    // per org. A revoked/inactive row is not a member of the roster.
    const { data: allMembers } = await db
        .from("organization_memberships")
        .select("organization_id")
        .in("organization_id", orgIds)
        .eq("status", "active");
    const memberCounts = new Map<string, number>();
    for (const row of (allMembers ?? []) as {
        organization_id?: string | null;
    }[]) {
        if (!row.organization_id) continue;
        memberCounts.set(
            row.organization_id,
            (memberCounts.get(row.organization_id) ?? 0) + 1,
        );
    }

    const enriched = ((orgs ?? []) as { id: string }[]).map((o) => ({
        ...o,
        role: roleByOrg.get(o.id) ?? null,
        member_count: memberCounts.get(o.id) ?? 0,
    }));
    return { ok: true, orgs: enriched };
}

export async function createOrg(
    db: Db,
    params: { userId: string; name: unknown },
): Promise<OrgResult<{ org: Record<string, unknown> }>> {
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name)
        return { ok: false, kind: "validation", detail: "name is required" };

    const { data: org, error } = await db
        .from("organizations")
        .insert({ name, created_by: params.userId })
        .select("*")
        .single();
    if (error || !org)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to create organization",
        };

    // The creator is the org's first org_owner. This is the ONLY path besides
    // onboarding's provision_initial_organization that writes
    // organization_memberships without an accepted invitation. The write is a
    // plain insert with explicit role/status — the same shape the
    // provisioning RPC uses — and the table's epoch trigger advances the
    // organization's authorization_epoch exactly once.
    const { error: memberError } = await db
        .from("organization_memberships")
        .insert({
            organization_id: org.id,
            user_id: params.userId,
            role: "org_owner",
            status: "active",
        });
    if (memberError) {
        // Roll back the org so we never leave an org without an owner.
        await db.from("organizations").delete().eq("id", org.id);
        return { ok: false, kind: "db_error", detail: memberError.message };
    }

    return { ok: true, org: { ...org, role: "org_owner", member_count: 1 } };
}

export async function getOrg(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ org: Record<string, unknown> }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };

    const { data: org, error } = await db
        .from("organizations")
        .select("*")
        .eq("id", params.orgId)
        .maybeSingle();
    if (error || !org) return { ok: false, kind: "not_found" };
    return { ok: true, org: { ...org, role } };
}

export async function updateOrg(
    db: Db,
    params: { userId: string; orgId: string; name: unknown },
): Promise<OrgResult<{ org: Record<string, unknown> }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name)
        return { ok: false, kind: "validation", detail: "name is required" };

    const { data: org, error } = await db
        .from("organizations")
        .update({ name, updated_at: new Date().toISOString() })
        .eq("id", params.orgId)
        .select("*")
        .single();
    if (error || !org)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to update organization",
        };
    return { ok: true, org: { ...org, role } };
}

// deleteOrg and listOrgResources (routes: DELETE /orgs/:orgId and
// GET /orgs/:orgId/resources) are deliberately NOT ported in this slice: the
// deletion path is destructive and waits on the retention ADR — an org's
// resources must never become personal data as a side effect of teardown —
// and the resource listing depends on the org-scoped resource tables and
// overrides (projects.org_id, *_org_access_overrides) that LiTT does not have
// yet. The routes answer 405 without touching the database.

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * Decorate membership rows with the profile identity the roster UI needs.
 * user_profiles mirrors auth.users' email precisely so sharing/roster reads
 * never scan the auth schema.
 */
async function attachProfiles(
    db: Db,
    rows: { user_id: string }[],
): Promise<Map<string, { email: string | null; display_name: string | null }>> {
    const byUser = new Map<
        string,
        { email: string | null; display_name: string | null }
    >();
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    if (userIds.length === 0) return byUser;
    const { data } = await db
        .from("user_profiles")
        .select("user_id, email, display_name")
        .in("user_id", userIds);
    for (const p of (data ?? []) as {
        user_id: string;
        email: string | null;
        display_name: string | null;
    }[]) {
        byUser.set(p.user_id, {
            email: p.email ?? null,
            display_name: p.display_name ?? null,
        });
    }
    return byUser;
}

export async function listMembers(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ members: unknown[] }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };

    // The roster is ACTIVE members only: a revoked/inactive row is history,
    // not a person who belongs to the organization.
    const { data, error } = await db
        .from("organization_memberships")
        .select("user_id, role, created_at")
        .eq("organization_id", params.orgId)
        .eq("status", "active");
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    const rows = (data ?? []) as {
        user_id: string;
        role: OrgRole;
        created_at: string;
    }[];
    const profiles = await attachProfiles(db, rows);
    return {
        ok: true,
        members: rows.map((m) => ({
            ...m,
            email: profiles.get(m.user_id)?.email ?? null,
            display_name: profiles.get(m.user_id)?.display_name ?? null,
        })),
    };
}

/**
 * Active org_owners — the role organization_memberships_protect_last_owner
 * singles out (workspace_admin is part of the admin tier for authorization,
 * but the DB guard, and therefore this pre-check, protects org_owner only).
 */
async function countOwners(db: Db, orgId: string): Promise<number> {
    const { data } = await db
        .from("organization_memberships")
        .select("user_id")
        .eq("organization_id", orgId)
        .eq("role", "org_owner")
        .eq("status", "active");
    return ((data ?? []) as unknown[]).length;
}

export async function updateMember(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        targetUserId: string;
        role: unknown;
    },
): Promise<OrgResult<{ member: Record<string, unknown> }>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    // The new role must name a member of the closed LiTT vocabulary; there is
    // no default and no coercion (the error lists the vocabulary back).
    if (!isOrgRole(params.role))
        return {
            ok: false,
            kind: "validation",
            detail: `Role must be one of: ${ORG_ROLE_LIST}`,
        };
    const nextRole = params.role;

    const targetRole = await getOrgRole(params.targetUserId, params.orgId, db);
    if (!targetRole) return { ok: false, kind: "not_found" };

    // Last-org_owner protection: demoting the sole active owner would strand
    // the org with nobody able to invite, remove or re-role anyone. The
    // organization_memberships_protect_last_owner trigger re-checks this at
    // the DB level against read-then-act races; the pre-check below turns the
    // ordinary case into the same clean 409 instead of a raw 23514.
    if (targetRole === "org_owner" && nextRole !== "org_owner") {
        const owners = await countOwners(db, params.orgId);
        if (owners <= 1) return { ok: false, kind: "last_admin" };
    }

    // organization_memberships has no updated_at column: the membership row's
    // provenance is created_at, and the mutation itself is what the epoch
    // trigger records.
    const { data: member, error } = await db
        .from("organization_memberships")
        .update({ role: nextRole })
        .eq("organization_id", params.orgId)
        .eq("user_id", params.targetUserId)
        .select("*")
        .single();
    if (error || !member) {
        if (isLastOwnerViolation(error))
            return { ok: false, kind: "last_admin" };
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to update member",
        };
    }
    // Role changes move real standing (the admin tier decides who can
    // administer the organization), so they belong in the same audit trail
    // the invitation lifecycle already writes to. They grant nothing over
    // content — org roles never inherit onto resources.
    const profiles = await attachProfiles(db, [
        { user_id: params.targetUserId },
    ]);
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.member.role_changed",
        title: profiles.get(params.targetUserId)?.email ?? params.targetUserId,
        detail: {
            org_id: params.orgId,
            target_user_id: params.targetUserId,
            previous_role: targetRole,
            role: nextRole,
        },
    });
    return { ok: true, member };
}

export async function removeMember(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        targetUserId: string;
    },
): Promise<OrgResult<Record<never, never>>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    // A member may remove themselves (leave); removing others needs admin.
    const isSelf = params.actorId === params.targetUserId;
    if (!isSelf && !isOrgAdmin(actorRole))
        return { ok: false, kind: "forbidden" };

    const targetRole = await getOrgRole(params.targetUserId, params.orgId, db);
    if (!targetRole) return { ok: false, kind: "not_found" };

    // Last-org_owner protection: never revoke the sole active owner, not even
    // by their own hand — they must appoint a successor first.
    if (targetRole === "org_owner") {
        const owners = await countOwners(db, params.orgId);
        if (owners <= 1) return { ok: false, kind: "last_admin" };
    }

    // Membership is never DELETEd. Removal is a status change to 'revoked':
    // the row's history survives, and because role/status now differ from the
    // stored values the organization_memberships_epoch_bump trigger fires,
    // advancing the organization's authorization_epoch so every outstanding
    // authorization for this member dies with it.
    const { error } = await db
        .from("organization_memberships")
        .update({ status: "revoked" })
        .eq("organization_id", params.orgId)
        .eq("user_id", params.targetUserId);
    if (error) {
        if (isLastOwnerViolation(error))
            return { ok: false, kind: "last_admin" };
        return { ok: false, kind: "db_error", detail: error.message };
    }
    const profiles = await attachProfiles(db, [
        { user_id: params.targetUserId },
    ]);
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: isSelf ? "org.member.left" : "org.member.removed",
        title: profiles.get(params.targetUserId)?.email ?? params.targetUserId,
        detail: {
            org_id: params.orgId,
            target_user_id: params.targetUserId,
            role: targetRole,
            status: "revoked",
        },
    });
    return { ok: true };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

type InvitationRow = {
    id: string;
    org_id: string;
    email: string;
    role: OrgRole;
    invited_by: string | null;
    status: InvitationStatus;
    expires_at: string;
    created_at: string;
    accepted_at: string | null;
    declined_at: string | null;
    cancelled_at: string | null;
};

function isExpired(row: { status: string; expires_at: string }): boolean {
    return (
        row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now()
    );
}

/**
 * Expiry is evaluated lazily on read rather than by a sweeper job: a pending
 * invitation past its expires_at reports as `expired` and cannot be accepted.
 * The stored status stays 'pending' until someone acts on it, so there is no
 * background writer racing the accept path.
 */
function presentInvitation(row: InvitationRow) {
    return { ...row, status: isExpired(row) ? "expired" : row.status };
}

function invitationExpiry(): string {
    return new Date(
        Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
}

export async function createInvitation(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        email: unknown;
        role: unknown;
    },
): Promise<OrgResult<{ invitation: Record<string, unknown> }>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    const email =
        typeof params.email === "string" ? normalizeEmail(params.email) : null;
    if (!email || !email.includes("@"))
        return {
            ok: false,
            kind: "validation",
            detail: "A valid email address is required",
        };
    const actorEmail = normalizeEmail(params.actorEmail);
    if (actorEmail && actorEmail === email)
        return {
            ok: false,
            kind: "validation",
            detail: "You are already a member of this organization",
        };

    // The role is REQUIRED and must be a member of the closed vocabulary —
    // there is no default, and nothing is coerced. Upstream fell back to
    // 'member' when the role was omitted; LiTT has no such tier, and
    // answering a request for an absent or unknown role with a 201 would
    // invent a quieter role behind the caller's back. Absent, null and
    // out-of-vocabulary roles are all the same 400, with the vocabulary
    // listed back in the message (resolveExplicitInvitationRole is the
    // recovery-layer validator for the closed organization vocabulary).
    const resolvedRole = resolveExplicitInvitationRole({
        scope: "organization",
        role: typeof params.role === "string" ? params.role : null,
    });
    // The scope guard is always true (the scope above is hardcoded), but it
    // narrows the resolution union back to the organization vocabulary.
    if (!resolvedRole.ok || resolvedRole.scope !== "organization")
        return {
            ok: false,
            kind: "validation",
            detail: `Role must be one of: ${ORG_ROLE_LIST}`,
        };
    const role: OrgRole = resolvedRole.role;

    // Someone who already belongs here needs no invitation. Resolved through
    // the mirrored profile email so the check never scans auth.users.
    const { data: profile } = await db
        .from("user_profiles")
        .select("user_id")
        .eq("email", email)
        .maybeSingle();
    const existingUserId = (profile as { user_id?: string } | null)?.user_id;
    if (existingUserId) {
        const existingRole = await getOrgRole(
            existingUserId,
            params.orgId,
            db,
        );
        if (existingRole)
            return {
                ok: false,
                kind: "conflict",
                detail: "That person is already a member of this organization",
            };
    }

    // One live invitation per (org, email). A previously expired one is
    // re-openable: refresh it in place rather than accumulating dead rows.
    const { data: existingInvite } = await db
        .from("org_invitations")
        .select("*")
        .eq("org_id", params.orgId)
        .eq("email", email)
        .eq("status", "pending")
        .maybeSingle();
    const live = existingInvite as InvitationRow | null;
    if (live && !isExpired(live))
        return {
            ok: false,
            kind: "conflict",
            detail: "That email already has a pending invitation",
        };
    if (live) {
        const { data: refreshed, error: refreshError } = await db
            .from("org_invitations")
            .update({
                role,
                invited_by: params.actorId,
                expires_at: invitationExpiry(),
            })
            .eq("id", live.id)
            .select("*")
            .single();
        if (refreshError || !refreshed)
            return {
                ok: false,
                kind: "db_error",
                detail: refreshError?.message ?? "Failed to create invitation",
            };
        await recordAudit(db, {
            userId: params.actorId,
            userEmail: params.actorEmail ?? null,
            action: "org.invite.created",
            title: email,
            detail: { org_id: params.orgId, role, invitation_id: live.id },
        });
        return {
            ok: true,
            invitation: presentInvitation(refreshed as InvitationRow),
        };
    }

    const { data: invitation, error } = await db
        .from("org_invitations")
        .insert({
            org_id: params.orgId,
            email,
            role,
            invited_by: params.actorId,
            status: "pending",
            expires_at: invitationExpiry(),
        })
        .select("*")
        .single();
    if (error || !invitation) {
        if (isUniqueViolation(error))
            return {
                ok: false,
                kind: "conflict",
                detail: "That email already has a pending invitation",
            };
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to create invitation",
        };
    }
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.invite.created",
        title: email,
        detail: {
            org_id: params.orgId,
            role,
            invitation_id: (invitation as { id: string }).id,
        },
    });
    return {
        ok: true,
        invitation: presentInvitation(invitation as InvitationRow),
    };
}

export async function listInvitations(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ invitations: unknown[] }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    // The roster of who has been asked to join is administrative detail.
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const { data, error } = await db
        .from("org_invitations")
        .select("*")
        .eq("org_id", params.orgId)
        .order("created_at", { ascending: false });
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    const rows = (data ?? []) as InvitationRow[];
    const profiles = await attachProfiles(
        db,
        rows
            .filter((r) => r.invited_by)
            .map((r) => ({ user_id: r.invited_by as string })),
    );
    return {
        ok: true,
        invitations: rows.map((r) => ({
            ...presentInvitation(r),
            invited_by_email: r.invited_by
                ? (profiles.get(r.invited_by)?.email ?? null)
                : null,
        })),
    };
}

export async function cancelInvitation(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        invitationId: string;
    },
): Promise<OrgResult<Record<never, never>>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    const { data: invite } = await db
        .from("org_invitations")
        .select("*")
        .eq("id", params.invitationId)
        .eq("org_id", params.orgId)
        .maybeSingle();
    const row = invite as InvitationRow | null;
    if (!row) return { ok: false, kind: "not_found" };
    // A cancelled invitation was withdrawn by an admin, not answered by the
    // recipient — reporting it as "already answered" tells them something
    // untrue about their own actions. It reads as missing instead, which is
    // the branch the client's "may have been cancelled" copy is written for.
    if (row.status === "cancelled") return { ok: false, kind: "not_found" };
    if (row.status !== "pending")
        return {
            ok: false,
            kind: "conflict",
            detail: "That invitation has already been answered",
        };

    const { error } = await db
        .from("org_invitations")
        .update({
            status: "cancelled",
            cancelled_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.invite.cancelled",
        title: row.email,
        detail: { org_id: params.orgId, invitation_id: row.id },
    });
    return { ok: true };
}

export async function resendInvitation(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        invitationId: string;
    },
): Promise<OrgResult<{ invitation: Record<string, unknown> }>> {
    const actorRole = await getOrgRole(params.actorId, params.orgId, db);
    if (!actorRole) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(actorRole)) return { ok: false, kind: "forbidden" };

    const { data: invite } = await db
        .from("org_invitations")
        .select("*")
        .eq("id", params.invitationId)
        .eq("org_id", params.orgId)
        .maybeSingle();
    const row = invite as InvitationRow | null;
    if (!row) return { ok: false, kind: "not_found" };
    // Resending an answered invitation would silently re-open a decision the
    // recipient already made. Only pending ones (expired included) refresh.
    // A cancelled invitation was withdrawn by an admin, not answered by the
    // recipient — reporting it as "already answered" tells them something
    // untrue about their own actions. It reads as missing instead, which is
    // the branch the client's "may have been cancelled" copy is written for.
    if (row.status === "cancelled") return { ok: false, kind: "not_found" };
    if (row.status !== "pending")
        return {
            ok: false,
            kind: "conflict",
            detail: "That invitation has already been answered",
        };

    const { data: refreshed, error } = await db
        .from("org_invitations")
        .update({ expires_at: invitationExpiry() })
        .eq("id", row.id)
        .select("*")
        .single();
    if (error || !refreshed)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to resend invitation",
        };
    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.invite.resent",
        title: row.email,
        detail: { org_id: params.orgId, invitation_id: row.id },
    });
    return {
        ok: true,
        invitation: presentInvitation(refreshed as InvitationRow),
    };
}

/**
 * Invitations addressed to the caller. Matching is by normalized email, which
 * is what makes claim-after-signup work: an invitation created before the
 * recipient had an account is waiting for them the moment their profile
 * carries that address. res.locals.userEmail already arrives lowercased, and
 * normalizeEmail keeps this true even for other callers of the service.
 */
export async function listMyInvitations(
    db: Db,
    params: { userEmail?: string | null },
): Promise<OrgResult<{ invitations: unknown[] }>> {
    const email = normalizeEmail(params.userEmail);
    if (!email) return { ok: true, invitations: [] };

    const { data, error } = await db
        .from("org_invitations")
        .select("*")
        .eq("email", email)
        .eq("status", "pending")
        .order("created_at", { ascending: false });
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    const rows = ((data ?? []) as InvitationRow[]).filter((r) => !isExpired(r));
    if (rows.length === 0) return { ok: true, invitations: [] };

    const orgIds = [...new Set(rows.map((r) => r.org_id))];
    const { data: orgs } = await db
        .from("organizations")
        .select("id, name")
        .in("id", orgIds);
    const nameById = new Map(
        ((orgs ?? []) as { id: string; name: string }[]).map((o) => [
            o.id,
            o.name,
        ]),
    );
    const profiles = await attachProfiles(
        db,
        rows
            .filter((r) => r.invited_by)
            .map((r) => ({ user_id: r.invited_by as string })),
    );
    return {
        ok: true,
        invitations: rows.map((r) => ({
            ...presentInvitation(r),
            org_name: nameById.get(r.org_id) ?? null,
            invited_by_email: r.invited_by
                ? (profiles.get(r.invited_by)?.email ?? null)
                : null,
        })),
    };
}

/** Load an invitation and verify it is this caller's to answer. */
async function loadAnswerableInvitation(
    db: Db,
    params: { userEmail?: string | null; invitationId: string },
): Promise<
    | { ok: true; invitation: InvitationRow }
    | Extract<OrgResult<unknown>, { ok: false }>
> {
    const email = normalizeEmail(params.userEmail);
    const { data } = await db
        .from("org_invitations")
        .select("*")
        .eq("id", params.invitationId)
        .maybeSingle();
    const row = data as InvitationRow | null;
    // An invitation addressed to somebody else is reported as missing rather
    // than forbidden: otherwise the 403/404 split would confirm that a given
    // invitation id exists for some other address.
    if (!row || !email || row.email !== email)
        return { ok: false, kind: "not_found" };
    // A cancelled invitation was withdrawn by an admin, not answered by the
    // recipient — reporting it as "already answered" tells them something
    // untrue about their own actions. It reads as missing instead, which is
    // the branch the client's "may have been cancelled" copy is written for.
    if (row.status === "cancelled") return { ok: false, kind: "not_found" };
    if (row.status !== "pending")
        return {
            ok: false,
            kind: "conflict",
            detail: "That invitation has already been answered",
        };
    if (isExpired(row)) return { ok: false, kind: "expired" };
    return { ok: true, invitation: row };
}

/**
 * LiTT's organization-role order is a chain — org_owner ⊇ workspace_admin ⊇
 * editor ⊇ viewer (admin tier: org_owner | workspace_admin, see isOrgAdmin) —
 * with technical_operator orthogonal to it: an operational role, not a
 * content tier. Acceptance is an offer of access, not an instruction to
 * reduce it (the same "floors, not ceilings" rule strongerRole applies to
 * project grants): the invitation raises the recipient when the offered role
 * is strictly above the one they already hold, and changes nothing
 * otherwise. A pair the order cannot compare (any technical_operator
 * pairing) is left as-is: moving between an orthogonal role and the tier
 * chain is a deliberate act for PATCH /orgs/:orgId/members, where the
 * last-org_owner guard gets a say — not a side effect of consenting to an
 * invitation.
 */
const ACCEPT_ROLE_RANK: Partial<Record<OrgRole, number>> = {
    viewer: 0,
    editor: 1,
    workspace_admin: 2,
    org_owner: 3,
};

function acceptFloorRole(existing: OrgRole, invited: OrgRole): OrgRole {
    const existingRank = ACCEPT_ROLE_RANK[existing];
    const invitedRank = ACCEPT_ROLE_RANK[invited];
    if (existingRank === undefined || invitedRank === undefined)
        return existing;
    return invitedRank > existingRank ? invited : existing;
}

export async function acceptInvitation(
    db: Db,
    params: {
        userId: string;
        userEmail?: string | null;
        invitationId: string;
    },
): Promise<OrgResult<{ org_id: string; role: OrgRole }>> {
    const loaded = await loadAnswerableInvitation(db, params);
    if (!loaded.ok) return loaded;
    const invite = loaded.invitation;

    // Acceptance is one of only two doors through which
    // organization_memberships rows appear (the other is an org's creator).
    // getOrgRole only sees ACTIVE rows, so its result is the floor the
    // invitation is measured against.
    const existing = await getOrgRole(params.userId, invite.org_id, db);
    const effectiveRole: OrgRole = existing
        ? acceptFloorRole(existing, invite.role)
        : invite.role;

    if (!existing) {
        // Same write shape as provision_initial_organization: a plain insert
        // from service_role with explicit role/status, and the
        // organization_memberships_epoch_bump trigger advances the
        // organization's authorization_epoch exactly once for it. There is
        // no accept-specific RPC in this slice (only onboarding has one), and
        // — like upstream — the two writes below (membership, then the
        // invitation status) are not wrapped in a single transaction; the
        // invariant that matters (epoch advances before any later read) is
        // carried by the trigger, not by the pair's atomicity.
        const { error } = await db.from("organization_memberships").insert({
            organization_id: invite.org_id,
            user_id: params.userId,
            role: effectiveRole,
            status: "active",
        });
        if (error) {
            if (!isUniqueViolation(error))
                return { ok: false, kind: "db_error", detail: error.message };
            // A row left behind by removeMember (status revoked/inactive)
            // still occupies the composite primary key. Acceptance must
            // re-activate it rather than leave a revocation in place behind
            // an "accepted" invitation. Role and status change together, so
            // the epoch trigger fires here too.
            const { error: reviveError } = await db
                .from("organization_memberships")
                .update({ role: effectiveRole, status: "active" })
                .eq("organization_id", invite.org_id)
                .eq("user_id", params.userId);
            if (reviveError)
                return {
                    ok: false,
                    kind: "db_error",
                    detail: reviveError.message,
                };
        }
    } else if (effectiveRole !== existing) {
        const { error } = await db
            .from("organization_memberships")
            .update({ role: effectiveRole })
            .eq("organization_id", invite.org_id)
            .eq("user_id", params.userId);
        if (error) return { ok: false, kind: "db_error", detail: error.message };
    }

    const { error: updateError } = await db
        .from("org_invitations")
        .update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("id", invite.id);
    if (updateError)
        return { ok: false, kind: "db_error", detail: updateError.message };

    await recordAudit(db, {
        userId: params.userId,
        userEmail: params.userEmail ?? null,
        action: "org.invite.accepted",
        title: invite.email,
        detail: {
            org_id: invite.org_id,
            // The role now in force, not the one that was offered: an audit
            // trail that records the offer cannot answer "what changed?".
            role: effectiveRole,
            invited_role: invite.role,
            invitation_id: invite.id,
        },
    });
    return { ok: true, org_id: invite.org_id, role: effectiveRole };
}

export async function declineInvitation(
    db: Db,
    params: {
        userId: string;
        userEmail?: string | null;
        invitationId: string;
    },
): Promise<OrgResult<Record<never, never>>> {
    const loaded = await loadAnswerableInvitation(db, params);
    if (!loaded.ok) return loaded;
    const invite = loaded.invitation;

    const { error } = await db
        .from("org_invitations")
        .update({ status: "declined", declined_at: new Date().toISOString() })
        .eq("id", invite.id);
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    await recordAudit(db, {
        userId: params.userId,
        userEmail: params.userEmail ?? null,
        action: "org.invite.declined",
        title: invite.email,
        detail: { org_id: invite.org_id, invitation_id: invite.id },
    });
    return { ok: true };
}
