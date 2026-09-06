import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicationIntent } from "../sharedContracts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FAILURE_CODES = new Set([
  "drive_upload_outcome_unknown",
  "drive_upload_failed",
  "drive_file_invalid",
  "authorization_revoked",
  "publication_record_failed",
  "drive_cleanup_failed",
]);
const FAILURE = "Drive publication persistence failed";

export const DRIVE_PUBLICATION_RPC_NAMES = Object.freeze({
  begin: "begin_ai_review_drive_publication",
  outcome: "record_ai_review_drive_publication_outcome",
  read: "read_ai_review_drive_publication",
});

type RpcResponse = { data: unknown; error: unknown };

export type DrivePublicationPersistenceClient = Pick<SupabaseClient, "rpc">;

export type DrivePublicationPersistenceContext = {
  actor_user_id: string;
  organization_id: string;
  authorization_epoch: number;
};

export type DrivePublicationIntentDto = PublicationIntent & {
  publication_id: string;
  export_id: string;
  review_id: string;
  execution_id: string;
  matter_id: string;
  project_id: string;
  organization_id: string;
  actor_user_id: string;
  authorization_epoch: number;
  revision: number;
  review_revision: number;
  artifact_document_id: string;
  artifact_document_version_id: string;
  artifact_storage_path: string;
  artifact_size_bytes: number;
  source_document_id: string;
  source_document_version_id: string;
  remote_size_bytes: number | null;
  /** SHA-256 of verified remote bytes, not an opaque provider checksum. */
  remote_checksum: string | null;
  failure_code: string | null;
};

export type DrivePublicationConflict = { disposition: "conflict" };
export type DrivePublicationBeginResult =
  | {
      disposition: "claimed" | "unknown" | "replayed";
      intent: DrivePublicationIntentDto;
    }
  | DrivePublicationConflict;
export type DrivePublicationOutcomeResult =
  | { disposition: "applied" | "replayed"; intent: DrivePublicationIntentDto }
  | DrivePublicationConflict;

export type DrivePublicationPersistence = {
  begin(input: {
    export_id: string;
    review_revision: number;
  }): Promise<DrivePublicationBeginResult>;
  recordOutcome(input: {
    publication_id: string;
    expected_revision: number;
    outcome: "uploaded" | "reconciled" | "failed";
    provider_file_id?: string;
    remote_size_bytes?: number;
    remote_checksum?: string;
  }): Promise<DrivePublicationOutcomeResult>;
  read(
    publication_id: string,
  ): Promise<DrivePublicationIntentDto | null | DrivePublicationConflict>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

function fail(): Error {
  return new Error(FAILURE);
}

const RESULT_KEYS = [
  "disposition",
  "publication_id",
  "export_id",
  "review_id",
  "execution_id",
  "matter_id",
  "project_id",
  "organization_id",
  "actor_user_id",
  "authorization_epoch",
  "matter_folder_id",
  "approved_artifact_sha256",
  "idempotency_key",
  "attempts",
  "outcome",
  "provider_file_id",
  "revision",
  "review_revision",
  "artifact_document_id",
  "artifact_document_version_id",
  "artifact_storage_path",
  "artifact_size_bytes",
  "source_document_id",
  "source_document_version_id",
  "remote_size_bytes",
  "remote_checksum",
  "failure_code",
  "legacy_payload",
] as const;

function parseIntent(value: unknown): DrivePublicationIntentDto {
  if (!record(value) || !exactKeys(value, RESULT_KEYS)) throw fail();
  if (
    !uuid(value.publication_id) ||
    !uuid(value.export_id) ||
    !uuid(value.review_id) ||
    !uuid(value.execution_id) ||
    !uuid(value.matter_id) ||
    !uuid(value.project_id) ||
    !uuid(value.organization_id) ||
    !uuid(value.actor_user_id) ||
    !safeInteger(value.authorization_epoch) ||
    !nonEmpty(value.matter_folder_id) ||
    typeof value.approved_artifact_sha256 !== "string" ||
    !SHA256_RE.test(value.approved_artifact_sha256) ||
    !nonEmpty(value.idempotency_key) ||
    !safeInteger(value.attempts) ||
    !safeInteger(value.revision, 1) ||
    !safeInteger(value.review_revision, 1) ||
    !uuid(value.artifact_document_id) ||
    !uuid(value.artifact_document_version_id) ||
    !nonEmpty(value.artifact_storage_path) ||
    !safeInteger(value.artifact_size_bytes, 1) ||
    !uuid(value.source_document_id) ||
    !uuid(value.source_document_version_id) ||
    (value.provider_file_id !== null && !nonEmpty(value.provider_file_id)) ||
    (value.remote_size_bytes !== null &&
      !safeInteger(value.remote_size_bytes)) ||
    (value.remote_checksum !== null && !nonEmpty(value.remote_checksum)) ||
    (value.failure_code !== null &&
      (!nonEmpty(value.failure_code) ||
        !FAILURE_CODES.has(value.failure_code))) ||
    value.legacy_payload === null ||
    !record(value.legacy_payload) ||
    Object.keys(value.legacy_payload).length !== 0 ||
    typeof value.outcome !== "string" ||
    ![
      "pending",
      "uploaded",
      "unknown_outcome",
      "reconciled",
      "failed",
    ].includes(String(value.outcome))
  ) {
    throw fail();
  }
  const expectedPath = `orgs/${value.organization_id}/matters/${value.matter_id}/projects/${value.project_id}/documents/${value.artifact_document_id}/${value.approved_artifact_sha256}.docx`;
  if (value.artifact_storage_path !== expectedPath) throw fail();
  if (value.outcome === "uploaded" || value.outcome === "reconciled") {
    if (
      !nonEmpty(value.provider_file_id) ||
      value.remote_size_bytes !== value.artifact_size_bytes ||
      value.remote_checksum !== value.approved_artifact_sha256 ||
      value.failure_code !== null
    )
      throw fail();
  }
  if (value.outcome === "failed" && value.failure_code === null) throw fail();
  if (value.outcome === "pending" && value.attempts !== 0) throw fail();
  return Object.freeze({
    matter_folder_id: value.matter_folder_id,
    approved_artifact_sha256: value.approved_artifact_sha256,
    idempotency_key: value.idempotency_key,
    attempts: value.attempts,
    outcome: value.outcome,
    ...(value.provider_file_id === null
      ? {}
      : { provider_file_id: value.provider_file_id }),
    publication_id: value.publication_id,
    export_id: value.export_id,
    review_id: value.review_id,
    execution_id: value.execution_id,
    matter_id: value.matter_id,
    project_id: value.project_id,
    organization_id: value.organization_id,
    actor_user_id: value.actor_user_id,
    authorization_epoch: value.authorization_epoch,
    revision: value.revision,
    review_revision: value.review_revision,
    artifact_document_id: value.artifact_document_id,
    artifact_document_version_id: value.artifact_document_version_id,
    artifact_storage_path: value.artifact_storage_path,
    artifact_size_bytes: value.artifact_size_bytes,
    source_document_id: value.source_document_id,
    source_document_version_id: value.source_document_version_id,
    remote_size_bytes: value.remote_size_bytes,
    remote_checksum: value.remote_checksum,
    failure_code: value.failure_code,
  }) as DrivePublicationIntentDto;
}

function parseResult<T extends string>(
  value: unknown,
  dispositions: readonly T[],
):
  | { disposition: T; intent: DrivePublicationIntentDto }
  | DrivePublicationConflict {
  if (!record(value) || typeof value.disposition !== "string") throw fail();
  if (value.disposition === "conflict") return { disposition: "conflict" };
  if (!dispositions.includes(value.disposition as T)) throw fail();
  return {
    disposition: value.disposition as T,
    intent: parseIntent(value),
  };
}

async function rpc(
  client: DrivePublicationPersistenceClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let response: RpcResponse;
  try {
    response = await client.rpc(name, args);
  } catch {
    throw fail();
  }
  if (!record(response) || response.error != null) throw fail();
  return response.data;
}

export function createDrivePublicationPersistence(options: {
  client: DrivePublicationPersistenceClient;
  context: DrivePublicationPersistenceContext;
}): DrivePublicationPersistence {
  const context = Object.freeze({ ...options.context });
  if (
    !uuid(context.actor_user_id) ||
    !uuid(context.organization_id) ||
    !safeInteger(context.authorization_epoch)
  )
    throw fail();
  const client = options.client;
  const assertContext = (
    intent: DrivePublicationIntentDto,
    mutation: boolean,
  ) => {
    if (
      intent.organization_id !== context.organization_id ||
      (mutation &&
        (intent.actor_user_id !== context.actor_user_id ||
          intent.authorization_epoch !== context.authorization_epoch))
    )
      throw fail();
  };

  return {
    async begin(request) {
      const input = { ...request };
      if (!uuid(input.export_id) || !safeInteger(input.review_revision, 1))
        throw fail();
      const value = await rpc(client, DRIVE_PUBLICATION_RPC_NAMES.begin, {
        p_export_id: input.export_id,
        p_review_revision: input.review_revision,
        p_actor_user_id: context.actor_user_id,
        p_organization_id: context.organization_id,
        p_authorization_epoch: context.authorization_epoch,
      });
      const parsed = parseResult(value, ["claimed", "unknown", "replayed"]);
      if (parsed.disposition !== "conflict") {
        const { intent } = parsed;
        assertContext(intent, true);
        if (
          intent.export_id !== input.export_id ||
          intent.review_revision !== input.review_revision ||
          intent.attempts < 1 ||
          intent.attempts > 3 ||
          (parsed.disposition === "replayed"
            ? !["uploaded", "reconciled"].includes(intent.outcome)
            : intent.outcome !== "unknown_outcome")
        )
          throw fail();
      }
      return parsed;
    },

    async recordOutcome(request) {
      const input = { ...request };
      if (
        !uuid(input.publication_id) ||
        !safeInteger(input.expected_revision, 1) ||
        (input.outcome === "failed" &&
          (input.provider_file_id !== undefined ||
            input.remote_size_bytes !== undefined ||
            input.remote_checksum !== undefined))
      )
        throw fail();
      if (input.outcome !== "failed") {
        if (
          !nonEmpty(input.provider_file_id) ||
          !safeInteger(input.remote_size_bytes) ||
          !nonEmpty(input.remote_checksum)
        )
          throw fail();
      }
      const value = await rpc(client, DRIVE_PUBLICATION_RPC_NAMES.outcome, {
        p_publication_id: input.publication_id,
        p_expected_revision: input.expected_revision,
        p_actor_user_id: context.actor_user_id,
        p_organization_id: context.organization_id,
        p_authorization_epoch: context.authorization_epoch,
        p_outcome: input.outcome,
        p_provider_file_id: input.provider_file_id ?? null,
        p_remote_size_bytes: input.remote_size_bytes ?? null,
        p_remote_checksum: input.remote_checksum ?? null,
        p_failure_code:
          input.outcome === "failed" ? "drive_upload_failed" : null,
      });
      const parsed = parseResult(value, ["applied", "replayed"]);
      if (parsed.disposition !== "conflict") {
        const { intent } = parsed;
        assertContext(intent, true);
        if (
          intent.publication_id !== input.publication_id ||
          intent.outcome !== input.outcome ||
          intent.attempts < 1 ||
          intent.attempts > 3 ||
          intent.failure_code !==
            (input.outcome === "failed" ? "drive_upload_failed" : null) ||
          intent.revision !== input.expected_revision + 1 ||
          (intent.provider_file_id ?? null) !==
            (input.provider_file_id ?? null) ||
          intent.remote_size_bytes !== (input.remote_size_bytes ?? null) ||
          intent.remote_checksum !== (input.remote_checksum ?? null)
        )
          throw fail();
      }
      return parsed;
    },

    async read(publication_id) {
      if (!uuid(publication_id)) throw fail();
      const value = await rpc(client, DRIVE_PUBLICATION_RPC_NAMES.read, {
        p_publication_id: publication_id,
        p_actor_user_id: context.actor_user_id,
        p_organization_id: context.organization_id,
        p_authorization_epoch: context.authorization_epoch,
      });
      if (value === null) return null;
      const parsed = parseResult(value, ["read"]);
      if (parsed.disposition === "conflict") return parsed;
      assertContext(parsed.intent, false);
      if (parsed.intent.publication_id !== publication_id) throw fail();
      return parsed.intent;
    },
  };
}
