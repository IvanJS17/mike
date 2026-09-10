import { Router, type Request, type Response } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { sendInternalError } from "../lib/httpError";
import { createSupabaseTenancyReadPort } from "../lib/recovery/authorization/supabaseTenancyReadPort";
import {
  evaluateInitialAccess,
  recheckFreshAccessViaPort,
} from "../lib/recovery/authorization/tenancyReadPort";
import type { AuthenticatedIdentity } from "../lib/recovery/identity/authStateMatrix";
import { createMatterDriveFolderPersistence } from "../lib/recovery/persistence/matterDriveFolderPersistence";
import {
  buildMatterMembership,
  MATTER_ROLES,
  ORGANIZATION_ROLES,
} from "../lib/recovery/tenancy/tenancyModel";

export const matterSettingsRouter = Router({ mergeParams: true });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const MATTER_OR_ORG_ROLES: ReadonlySet<string> = new Set([
  ...MATTER_ROLES,
  ...ORGANIZATION_ROLES,
]);
const INVALID_FOLDER = {
  code: "invalid_drive_folder_id",
  detail: "Invalid Drive folder ID.",
};

type MatterRow = {
  id: string;
  project_id: string;
  workspace_id: string;
  drive_folder_id: string | null;
  organization_id: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function opaqueNotFound(res: Response) {
  return res.status(404).json({ code: "not_found", detail: "Not found." });
}

function parseRelation(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (Array.isArray(value) && value.length === 1 && isRecord(value[0]))
    return value[0];
  throw new Error("matter Drive folder relation is malformed");
}

function parseMatterRow(value: unknown): MatterRow | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("matter Drive folder row is malformed");
  const workspace = parseRelation(value.workspaces);
  if (
    typeof value.id !== "string" ||
    !UUID_RE.test(value.id) ||
    typeof value.project_id !== "string" ||
    !UUID_RE.test(value.project_id) ||
    typeof value.workspace_id !== "string" ||
    !UUID_RE.test(value.workspace_id) ||
    typeof workspace.organization_id !== "string" ||
    !UUID_RE.test(workspace.organization_id) ||
    (value.drive_folder_id !== null &&
      (typeof value.drive_folder_id !== "string" ||
        !DRIVE_FOLDER_ID_PATTERN.test(value.drive_folder_id)))
  )
    throw new Error("matter Drive folder row is invalid");
  return {
    id: value.id,
    project_id: value.project_id,
    workspace_id: value.workspace_id,
    drive_folder_id: value.drive_folder_id,
    organization_id: workspace.organization_id,
  };
}

async function loadMatter(
  db: ReturnType<typeof createServerSupabase>,
  projectId: string,
  matterId: string,
): Promise<MatterRow | null> {
  let result: unknown;
  try {
    result = await db
      .from("matters")
      .select(
        "id, project_id, workspace_id, drive_folder_id, workspaces!inner(organization_id)",
      )
      .eq("id", matterId)
      .eq("project_id", projectId)
      .maybeSingle();
  } catch {
    throw new Error("matter Drive folder query failed");
  }
  if (
    !isRecord(result) ||
    !Object.prototype.hasOwnProperty.call(result, "data") ||
    !Object.prototype.hasOwnProperty.call(result, "error") ||
    result.error != null
  )
    throw new Error("matter Drive folder query failed");
  const matter = parseMatterRow(result.data);
  if (matter && (matter.id !== matterId || matter.project_id !== projectId))
    return null;
  return matter;
}

function requestIds(
  req: Request,
): { projectId: string; matterId: string } | null {
  const projectId = req.params.projectId;
  const matterId = req.params.matterId;
  if (!UUID_RE.test(projectId) || !UUID_RE.test(matterId)) return null;
  return { projectId: String(projectId), matterId: String(matterId) };
}

async function authorize(
  res: Response,
  projectId: string,
  matterId: string,
  requiresMfa: boolean,
) {
  const identity = resIdentity(res);
  if (!identity) throw new Error("authenticated identity is missing");
  const db = createServerSupabase();
  const matter = await loadMatter(db, projectId, matterId);
  if (!matter) return { kind: "not_found" as const };
  const tenancy = createSupabaseTenancyReadPort(db);
  const access = await evaluateInitialAccess(tenancy, {
    identity,
    organization_id: matter.organization_id,
    matter_id: matterId,
    requiresMfa,
  });
  if (access.kind === "authorization_dependency_failed")
    throw new Error("matter Drive folder authorization failed");
  if (access.decision.outcome === "not_found")
    return { kind: "not_found" as const };
  if (access.decision.outcome === "denied")
    return { kind: "denied" as const, code: access.decision.code };
  const scope = access.decision.scope;
  if (scope.workspace_id !== matter.workspace_id)
    return { kind: "not_found" as const };
  if (
    scope.user_id !== identity.user_id ||
    scope.organization_id !== matter.organization_id ||
    scope.matter_id !== matterId ||
    typeof scope.membership_role !== "string" ||
    !MATTER_OR_ORG_ROLES.has(scope.membership_role) ||
    !Number.isSafeInteger(scope.authorization_epoch) ||
    scope.authorization_epoch < 0
  )
    throw new Error("matter Drive folder authorization scope is invalid");
  // Public-matter read scopes use the organization role; settings edits
  // still require a separate, active, explicit matter-owner membership.
  const rawMembership = await tenancy.getMatterMembership({
    user_id: identity.user_id,
    matter_id: matterId,
  });
  const membership =
    rawMembership === null ? null : buildMatterMembership(rawMembership);
  if (
    membership &&
    (membership.user_id !== identity.user_id ||
      membership.matter_id !== matterId)
  )
    return { kind: "not_found" as const };
  const activeMembership = membership?.status === "active" ? membership : null;
  if (scope.requires_explicit_matter_membership && !activeMembership)
    return { kind: "not_found" as const };
  const settingsRole = activeMembership?.role ?? scope.membership_role;
  return {
    kind: "allow" as const,
    db,
    matter,
    tenancy,
    identity,
    scope,
    settingsRole,
  };
}

function resIdentity(res: Response): AuthenticatedIdentity | null {
  const identity = res.locals.authenticatedIdentity;
  if (!isRecord(identity) || typeof identity.user_id !== "string") return null;
  return identity as unknown as AuthenticatedIdentity;
}

function dto(matter: MatterRow, role: string, canEdit: boolean) {
  return {
    matter_id: matter.id,
    project_id: matter.project_id,
    drive_folder_id: matter.drive_folder_id,
    role,
    can_edit: canEdit,
  };
}

function bodyOf(req: Request): Record<string, unknown> | null {
  return isRecord(req.body) ? req.body : null;
}

function requestedFolder(req: Request): string | null | undefined {
  const body = bodyOf(req);
  if (
    !body ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "drive_folder_id")
  )
    return undefined;
  const value = body.drive_folder_id;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const folder = value.trim();
  return folder === ""
    ? null
    : DRIVE_FOLDER_ID_PATTERN.test(folder)
      ? folder
      : undefined;
}

matterSettingsRouter.get(
  "/:matterId/drive-folder",
  requireAuth,
  async (req, res) => {
    const ids = requestIds(req);
    if (!ids) return opaqueNotFound(res);
    try {
      const access = await authorize(res, ids.projectId, ids.matterId, false);
      if (access.kind !== "allow") return opaqueNotFound(res);
      const current = await loadMatter(access.db, ids.projectId, ids.matterId);
      if (
        !current ||
        current.workspace_id !== access.matter.workspace_id ||
        current.organization_id !== access.matter.organization_id
      )
        return opaqueNotFound(res);
      const fresh = await recheckFreshAccessViaPort(access.tenancy, {
        scope: access.scope,
        identity: access.identity,
        requiresMfa: false,
      });
      if (fresh.kind === "authorization_dependency_failed")
        throw new Error("matter Drive folder fresh authorization failed");
      if (!fresh.result.fresh) return opaqueNotFound(res);
      const role = access.settingsRole;
      return res.json(dto(current, role, role === "matter_owner"));
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);

matterSettingsRouter.patch(
  "/:matterId/drive-folder",
  requireAuth,
  requireMfaIfEnrolled,
  async (req, res) => {
    const ids = requestIds(req);
    if (!ids) return opaqueNotFound(res);
    const driveFolderId = requestedFolder(req);
    if (driveFolderId === undefined)
      return res.status(400).json(INVALID_FOLDER);
    try {
      const access = await authorize(res, ids.projectId, ids.matterId, true);
      if (access.kind === "not_found") return opaqueNotFound(res);
      if (access.kind === "denied")
        return res
          .status(403)
          .json({ code: access.code, detail: "MFA required." });
      if (access.settingsRole !== "matter_owner")
        return res
          .status(403)
          .json({
            code: "matter_owner_required",
            detail: "Only the matter owner can change the Drive folder.",
          });

      const fresh = await recheckFreshAccessViaPort(access.tenancy, {
        scope: access.scope,
        identity: access.identity,
        requiresMfa: true,
      });
      if (fresh.kind === "authorization_dependency_failed")
        throw new Error("matter Drive folder fresh authorization failed");
      if (!fresh.result.fresh)
        return res
          .status(403)
          .json({
            code: "authorization_revoked",
            detail: "Authorization revoked.",
          });

      const persistence = createMatterDriveFolderPersistence({
        client: access.db,
        context: {
          actor_user_id: access.identity.user_id,
          organization_id: access.scope.organization_id,
          authorization_epoch: access.scope.authorization_epoch,
        },
      });
      const saved = await persistence.update({
        matter_id: ids.matterId,
        project_id: ids.projectId,
        drive_folder_id: driveFolderId,
      });
      const updated: MatterRow = {
        ...access.matter,
        drive_folder_id: saved.drive_folder_id,
      };
      return res.json(dto(updated, access.settingsRole, true));
    } catch (error) {
      return sendInternalError(res, error);
    }
  },
);
