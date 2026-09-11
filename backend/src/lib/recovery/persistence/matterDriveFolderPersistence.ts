import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const FAILURE = "matter Drive folder persistence failed";

export const MATTER_DRIVE_FOLDER_RPC_NAMES = Object.freeze({
  update: "update_matter_drive_folder",
});

type RpcResponse = { data: unknown; error: unknown };

export type MatterDriveFolderPersistenceClient = Pick<SupabaseClient, "rpc">;

export type MatterDriveFolderPersistenceContext = Readonly<{
  actor_user_id: string;
  organization_id: string;
  authorization_epoch: number;
}>;

export type MatterDriveFolderSavedValue = Readonly<{
  matter_id: string;
  project_id: string;
  organization_id: string;
  drive_folder_id: string | null;
}>;

export type MatterDriveFolderPersistence = {
  update(input: {
    matter_id: string;
    project_id: string;
    drive_folder_id: string | null;
  }): Promise<MatterDriveFolderSavedValue>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(): Error {
  return new Error(FAILURE);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isFolderId(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && DRIVE_FOLDER_ID_PATTERN.test(value))
  );
}

function parseSavedValue(value: unknown): MatterDriveFolderSavedValue {
  if (!isRecord(value)) throw fail();
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !== "drive_folder_id,matter_id,organization_id,project_id" ||
    !uuid(value.matter_id) ||
    !uuid(value.project_id) ||
    !uuid(value.organization_id) ||
    !isFolderId(value.drive_folder_id)
  )
    throw fail();
  return {
    matter_id: value.matter_id as string,
    project_id: value.project_id as string,
    organization_id: value.organization_id as string,
    drive_folder_id: value.drive_folder_id,
  };
}

async function callRpc(
  client: MatterDriveFolderPersistenceClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  let response: RpcResponse;
  try {
    response = await client.rpc(MATTER_DRIVE_FOLDER_RPC_NAMES.update, args);
  } catch {
    throw fail();
  }
  if (
    !isRecord(response) ||
    !Object.hasOwn(response, "data") ||
    !Object.hasOwn(response, "error") ||
    response.error != null
  )
    throw fail();
  return response.data;
}

export function createMatterDriveFolderPersistence(options: {
  client: MatterDriveFolderPersistenceClient;
  context: MatterDriveFolderPersistenceContext;
}): MatterDriveFolderPersistence {
  const context = Object.freeze({ ...options.context });
  const client = options.client;
  if (
    !uuid(context.actor_user_id) ||
    !uuid(context.organization_id) ||
    !Number.isSafeInteger(context.authorization_epoch) ||
    context.authorization_epoch < 0
  )
    throw fail();

  return {
    async update(request) {
      const input = { ...request };
      if (
        !uuid(input.matter_id) ||
        !uuid(input.project_id) ||
        !isFolderId(input.drive_folder_id)
      )
        throw fail();
      const saved = parseSavedValue(
        await callRpc(client, {
          p_matter_id: input.matter_id,
          p_project_id: input.project_id,
          p_drive_folder_id: input.drive_folder_id,
          p_actor_user_id: context.actor_user_id,
          p_organization_id: context.organization_id,
          p_authorization_epoch: context.authorization_epoch,
        }),
      );
      if (
        saved.matter_id !== input.matter_id ||
        saved.project_id !== input.project_id ||
        saved.organization_id !== context.organization_id ||
        saved.drive_folder_id !== input.drive_folder_id
      )
        throw fail();
      return saved;
    },
  };
}
