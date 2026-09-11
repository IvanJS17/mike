import type { createServerSupabase } from "../../supabase";
import type {
  InitialOrganizationPersistenceResult,
  OnboardingProvisioningPort,
} from "./onboardingProvisioning";

const ADAPTER_ERROR_MESSAGE = "onboarding write adapter failed";
type Db = ReturnType<typeof createServerSupabase>;

function adapterError(): Error {
  return new Error(ADAPTER_ERROR_MESSAGE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw adapterError();
  return value;
}

function requireEpoch(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw adapterError();
  return value as number;
}

function normalizeRow(value: unknown): InitialOrganizationPersistenceResult {
  if (!isPlainObject(value)) throw adapterError();
  if (value.disposition !== "created" && value.disposition !== "reused") {
    throw adapterError();
  }
  if (value.membership_role !== "org_owner") throw adapterError();
  if (value.membership_status !== "active") throw adapterError();

  const organizationId = requireString(value.organization_id);
  return {
    disposition: value.disposition,
    organization: {
      organization_id: organizationId,
      name: requireString(value.organization_name),
    },
    membership: {
      user_id: requireString(value.membership_user_id),
      organization_id: organizationId,
      role: "org_owner",
      status: "active",
      authorization_epoch: requireEpoch(value.authorization_epoch),
    },
  };
}

async function runRpc(
  db: Db,
  input: { user_id: string; organization_name: string },
): Promise<InitialOrganizationPersistenceResult> {
  let result: unknown;
  try {
    result = await db.rpc("provision_initial_organization", {
      p_user_id: input.user_id,
      p_organization_name: input.organization_name,
    });
  } catch {
    throw adapterError();
  }

  if (
    !isPlainObject(result) ||
    !Object.prototype.hasOwnProperty.call(result, "data") ||
    !Object.prototype.hasOwnProperty.call(result, "error") ||
    result.error !== null ||
    !Array.isArray(result.data) ||
    result.data.length !== 1
  ) {
    throw adapterError();
  }

  try {
    return normalizeRow(result.data[0]);
  } catch {
    throw adapterError();
  }
}

export function createSupabaseOnboardingProvisioningPort(
  db: Db,
): OnboardingProvisioningPort {
  return {
    provisionInitialOrganization: (input) => runRpc(db, input),
  };
}
