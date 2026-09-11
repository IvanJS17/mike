import { createHash } from "node:crypto";

import {
  authorizeObjectKey,
  buildCanonicalPrefix,
} from "../documents/documentStoragePolicy";
import type { ApprovedArtifactStorage } from "../persistence/approvedArtifactPersistence";
import type {
  DrivePublicationIntentDto,
  DrivePublicationPersistence,
} from "../persistence/drivePublicationPersistence";
import { resolveEgressTarget } from "../sharedContracts";
import type {
  ApprovedArtifactDriveTransport,
  FakeDriveLookupResult,
  FakeDriveRemoteObject,
  FakeDriveUploadInput,
} from "./fakeDrive";

export type { ApprovedArtifactDriveTransport } from "./fakeDrive";
export type PublicationRevalidationPhase =
  | "before_upload"
  | "before_record_outcome";
export type ApprovedArtifactPublicationOptions = {
  persistence: DrivePublicationPersistence;
  storage: Pick<ApprovedArtifactStorage, "getStrict">;
  transport: ApprovedArtifactDriveTransport;
  revalidateAuthorization(input: {
    phase: PublicationRevalidationPhase;
    intent: DrivePublicationIntentDto;
  }): Promise<boolean>;
};
export type ApprovedArtifactPublicationInput = {
  export_id: string;
  review_revision: number;
};
export type ApprovedArtifactReconciliationInput = { publication_id: string };
export type ApprovedArtifactPublicationResult = {
  disposition:
    | "uploaded"
    | "replayed"
    | "reconciled"
    | "failed"
    | "unknown_outcome";
  outcome: DrivePublicationIntentDto["outcome"];
  intent: DrivePublicationIntentDto;
};
export type ApprovedArtifactPublicationService = {
  publish(
    input: ApprovedArtifactPublicationInput,
  ): Promise<ApprovedArtifactPublicationResult>;
  reconcile(
    input: ApprovedArtifactReconciliationInput,
  ): Promise<ApprovedArtifactPublicationResult>;
};

const FAILURE = "approved artifact publication failed";
const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES = [
  "pending",
  "uploaded",
  "unknown_outcome",
  "reconciled",
  "failed",
] as const;

function fail(reason: string): Error {
  return new Error(`${FAILURE}: ${reason}`);
}
const MUTABLE_OUTCOME_FIELDS = new Set([
  "revision",
  "outcome",
  "attempts",
  "provider_file_id",
  "remote_size_bytes",
  "remote_checksum",
  "failure_code",
]);
function sameBinding(
  left: DrivePublicationIntentDto,
  right: DrivePublicationIntentDto,
): boolean {
  return Object.entries(left).every(
    ([key, value]) =>
      MUTABLE_OUTCOME_FIELDS.has(key) || Reflect.get(right, key) === value,
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw fail("invalid artifact bytes");
  return new Uint8Array(value);
}

function validIntent(value: unknown): value is DrivePublicationIntentDto {
  if (!record(value)) return false;
  const stringKeys = [
    "publication_id",
    "export_id",
    "review_id",
    "execution_id",
    "matter_id",
    "project_id",
    "organization_id",
    "actor_user_id",
    "matter_folder_id",
    "approved_artifact_sha256",
    "idempotency_key",
    "artifact_document_id",
    "artifact_document_version_id",
    "artifact_storage_path",
    "source_document_id",
    "source_document_version_id",
  ];
  if (
    stringKeys.some(
      (key) => typeof value[key] !== "string" || value[key].length === 0,
    )
  )
    return false;
  const uuidKeys = [
    "publication_id",
    "export_id",
    "review_id",
    "execution_id",
    "matter_id",
    "project_id",
    "organization_id",
    "actor_user_id",
    "artifact_document_id",
    "artifact_document_version_id",
    "source_document_id",
    "source_document_version_id",
  ];
  if (
    uuidKeys.some((key) => !UUID_RE.test(value[key] as string)) ||
    !SHA256_RE.test(value.approved_artifact_sha256 as string)
  )
    return false;
  if (
    !Number.isSafeInteger(value.artifact_size_bytes) ||
    (value.artifact_size_bytes as number) <= 0 ||
    !Number.isSafeInteger(value.attempts) ||
    (value.attempts as number) < 1 ||
    (value.attempts as number) > 3 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !Number.isSafeInteger(value.review_revision) ||
    (value.review_revision as number) < 1 ||
    !Number.isSafeInteger(value.authorization_epoch) ||
    (value.authorization_epoch as number) < 0 ||
    !(OUTCOMES as readonly unknown[]).includes(value.outcome)
  )
    return false;
  if (
    (value.remote_size_bytes !== null &&
      (!Number.isSafeInteger(value.remote_size_bytes) ||
        (value.remote_size_bytes as number) < 0)) ||
    (value.remote_checksum !== null &&
      (typeof value.remote_checksum !== "string" ||
        !SHA256_RE.test(value.remote_checksum))) ||
    (value.failure_code !== null &&
      (typeof value.failure_code !== "string" ||
        value.failure_code.length === 0))
  )
    return false;
  if (value.outcome === "uploaded" || value.outcome === "reconciled") {
    if (
      typeof value.provider_file_id !== "string" ||
      value.remote_size_bytes !== value.artifact_size_bytes ||
      value.remote_checksum !== value.approved_artifact_sha256 ||
      value.failure_code !== null
    )
      return false;
  }
  if (value.outcome === "failed" && value.failure_code === null) return false;
  const prefix = buildCanonicalPrefix({
    organization_id: value.organization_id as string,
    matter_id: value.matter_id as string,
    project_id: value.project_id as string,
    document_id: value.artifact_document_id as string,
    version_hash: value.approved_artifact_sha256 as string,
    object_prefix: `orgs/${value.organization_id}/matters/${value.matter_id}/projects/${value.project_id}/documents/${value.artifact_document_id}`,
  });
  if (
    !prefix.ok ||
    value.artifact_storage_path !==
      `${prefix.prefix}/${value.approved_artifact_sha256}.docx`
  )
    return false;
  return (
    value.provider_file_id === undefined ||
    (typeof value.provider_file_id === "string" &&
      value.provider_file_id.length > 0)
  );
}
function output(
  outcome: DrivePublicationIntentDto["outcome"],
  intent: DrivePublicationIntentDto,
  disposition: ApprovedArtifactPublicationResult["disposition"] = outcome ===
    "uploaded" ||
  outcome === "reconciled" ||
  outcome === "failed" ||
  outcome === "unknown_outcome"
    ? outcome
    : "unknown_outcome",
): ApprovedArtifactPublicationResult {
  return { disposition, outcome, intent: { ...intent } };
}

function verifyRemote(
  value: unknown,
  intent: DrivePublicationIntentDto,
  expected: Uint8Array,
): FakeDriveRemoteObject | null {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !==
      "bytes,file_id,folder_id,idempotency_key"
  )
    return null;
  if (
    typeof value.file_id !== "string" ||
    value.file_id.length === 0 ||
    value.folder_id !== intent.matter_folder_id ||
    value.idempotency_key !== intent.idempotency_key
  )
    return null;
  let remote: Uint8Array;
  try {
    remote = bytes(value.bytes);
  } catch {
    return null;
  }
  if (
    remote.length !== expected.length ||
    remote.length !== intent.artifact_size_bytes ||
    sha256(remote) !== sha256(expected) ||
    sha256(remote) !== intent.approved_artifact_sha256
  )
    return null;
  return {
    file_id: value.file_id,
    folder_id: value.folder_id,
    idempotency_key: value.idempotency_key,
    bytes: remote,
  };
}
function parseLookup(value: unknown): FakeDriveLookupResult | null {
  if (!record(value) || typeof value.disposition !== "string") return null;
  if (
    (value.disposition === "unknown" ||
      value.disposition === "authoritative_absence") &&
    Object.keys(value).length === 1
  )
    return { disposition: value.disposition };
  if (
    (value.disposition === "found" || value.disposition === "ambiguous") &&
    Array.isArray(value.objects)
  )
    return {
      disposition: value.disposition,
      objects: value.objects,
    } as FakeDriveLookupResult;
  return null;
}
function request(
  intent: DrivePublicationIntentDto,
  artifact: Uint8Array,
): FakeDriveUploadInput {
  return {
    publication_id: intent.publication_id,
    folder_id: intent.matter_folder_id,
    idempotency_key: intent.idempotency_key,
    artifact_sha256: intent.approved_artifact_sha256,
    artifact_size_bytes: intent.artifact_size_bytes,
    bytes: new Uint8Array(artifact),
  };
}

export function createApprovedArtifactPublicationService(
  options: ApprovedArtifactPublicationOptions,
): ApprovedArtifactPublicationService {
  if (
    !record(options) ||
    !record(options.transport) ||
    options.transport.kind !== "fake" ||
    options.transport.host !== "fake" ||
    !resolveEgressTarget("drive", options.transport.host).allowed
  )
    throw fail("only fake Drive transport is allowed");
  if (
    !options.persistence ||
    !options.storage ||
    typeof options.revalidateAuthorization !== "function"
  )
    throw fail("invalid composition");
  const transport = options.transport;
  const revalidate = async (
    phase: PublicationRevalidationPhase,
    intent: DrivePublicationIntentDto,
  ) => {
    try {
      return (
        (await options.revalidateAuthorization({
          phase,
          intent: { ...intent },
        })) === true
      );
    } catch {
      return false;
    }
  };
  const readCommitted = async (
    intent: DrivePublicationIntentDto,
  ): Promise<Uint8Array> => {
    const ownership = {
      organization_id: intent.organization_id,
      matter_id: intent.matter_id,
      project_id: intent.project_id,
      document_id: intent.artifact_document_id,
      version_hash: intent.approved_artifact_sha256,
      object_prefix: `orgs/${intent.organization_id}/matters/${intent.matter_id}/projects/${intent.project_id}/documents/${intent.artifact_document_id}`,
    };
    const authorized = authorizeObjectKey(
      ownership,
      intent.artifact_storage_path,
    );
    if (!authorized.ok) throw fail("non-canonical artifact path");
    let borrowed: Uint8Array | null;
    try {
      borrowed = await options.storage.getStrict(authorized.key);
    } catch {
      throw fail("artifact read failed");
    }
    if (borrowed === null) throw fail("committed artifact missing");
    const artifact = bytes(borrowed);
    if (
      artifact.length !== intent.artifact_size_bytes ||
      sha256(artifact) !== intent.approved_artifact_sha256
    )
      throw fail("committed artifact hash or size mismatch");
    return artifact;
  };
  const recordVerified = async (
    intent: DrivePublicationIntentDto,
    kind: "uploaded" | "reconciled",
    remote: FakeDriveRemoteObject,
  ): Promise<ApprovedArtifactPublicationResult | null> => {
    if (!(await revalidate("before_record_outcome", intent))) return null;
    try {
      const acknowledged = await options.persistence.recordOutcome({
        publication_id: intent.publication_id,
        expected_revision: intent.revision,
        outcome: kind,
        provider_file_id: remote.file_id,
        remote_size_bytes: remote.bytes.length,
        remote_checksum: sha256(remote.bytes),
      });
      if (
        !record(acknowledged) ||
        (acknowledged.disposition !== "applied" &&
          acknowledged.disposition !== "replayed") ||
        !validIntent(acknowledged.intent) ||
        !sameBinding(intent, acknowledged.intent) ||
        acknowledged.intent.outcome !== kind ||
        acknowledged.intent.provider_file_id !== remote.file_id ||
        acknowledged.intent.remote_size_bytes !== remote.bytes.length ||
        acknowledged.intent.remote_checksum !== sha256(remote.bytes)
      )
        return null;
      return output(kind, acknowledged.intent);
    } catch {
      return null;
    }
  };
  const reconcileIntent = async (
    intent: DrivePublicationIntentDto,
  ): Promise<ApprovedArtifactPublicationResult> => {
    let durable: DrivePublicationIntentDto | null = null;
    try {
      const readback = await options.persistence.read(intent.publication_id);
      if (
        readback === null ||
        !validIntent(readback) ||
        !sameBinding(intent, readback)
      )
        return output("unknown_outcome", intent);
      durable = readback;
    } catch {
      return output("unknown_outcome", intent);
    }
    if (durable && durable.outcome === "uploaded")
      return output("uploaded", durable, "replayed");
    if (durable && durable.outcome === "reconciled")
      return output("reconciled", durable, "replayed");
    if (durable) intent = durable;
    let raw: unknown;
    try {
      raw = await transport.find({
        publication_id: intent.publication_id,
        folder_id: intent.matter_folder_id,
        idempotency_key: intent.idempotency_key,
        artifact_sha256: intent.approved_artifact_sha256,
        artifact_size_bytes: intent.artifact_size_bytes,
      });
    } catch {
      return output("unknown_outcome", intent);
    }
    const state = parseLookup(raw);
    if (!state) return output("unknown_outcome", intent);
    if (state.disposition === "found") {
      if (state.objects.length !== 1) return output("unknown_outcome", intent);
      let expected: Uint8Array;
      try {
        expected = await readCommitted(intent);
      } catch {
        return output("unknown_outcome", intent);
      }
      const remote = verifyRemote(state.objects[0], intent, expected);
      if (!remote) return output("unknown_outcome", intent);
      return (
        (await recordVerified(intent, "reconciled", remote)) ??
        output("unknown_outcome", intent)
      );
    }
    if (
      state.disposition !== "authoritative_absence" ||
      !(await revalidate("before_record_outcome", intent))
    )
      return output("unknown_outcome", intent);
    try {
      const acknowledged = await options.persistence.recordOutcome({
        publication_id: intent.publication_id,
        expected_revision: intent.revision,
        outcome: "failed",
      });
      if (
        !record(acknowledged) ||
        (acknowledged.disposition !== "applied" &&
          acknowledged.disposition !== "replayed") ||
        !validIntent(acknowledged.intent) ||
        !sameBinding(intent, acknowledged.intent) ||
        acknowledged.intent.outcome !== "failed"
      )
        return output("unknown_outcome", intent);
      return output("failed", acknowledged.intent);
    } catch {
      return output("unknown_outcome", intent);
    }
  };
  const uploadClaim = async (
    intent: DrivePublicationIntentDto,
  ): Promise<ApprovedArtifactPublicationResult> => {
    const artifact = await readCommitted(intent);
    if (!(await revalidate("before_upload", intent)))
      throw fail("authorization revoked before upload");
    const readback = await options.persistence.read(intent.publication_id);
    const current = record(readback) ? { ...readback } : null;
    if (
      !validIntent(current) ||
      Object.entries(intent).some(
        ([key, value]) => Reflect.get(current, key) !== value,
      )
    )
      throw fail("claim changed before upload");
    let raw: unknown;
    try {
      raw = await transport.upload(request(intent, artifact));
    } catch {
      return reconcileIntent(intent);
    }
    const remote = verifyRemote(raw, intent, artifact);
    if (!remote) return reconcileIntent(intent);
    return (
      (await recordVerified(intent, "uploaded", remote)) ??
      reconcileIntent(intent)
    );
  };
  return {
    async publish(received) {
      const input = record(received) ? { ...received } : received;
      if (
        !record(input) ||
        Object.keys(input).sort().join(",") !== "export_id,review_revision" ||
        typeof input.export_id !== "string" ||
        !UUID_RE.test(input.export_id) ||
        !Number.isSafeInteger(input.review_revision) ||
        input.review_revision < 1
      )
        throw fail("invalid publish input");
      let begun: unknown;
      try {
        begun = await options.persistence.begin({
          export_id: input.export_id,
          review_revision: input.review_revision,
        });
      } catch {
        throw fail("begin acknowledgement invalid");
      }
      if (
        !record(begun) ||
        !["claimed", "unknown", "replayed", "conflict"].includes(
          String(begun.disposition),
        )
      )
        throw fail("begin acknowledgement invalid");
      if (begun.disposition === "conflict") throw fail("publication conflict");
      if (
        !validIntent(begun.intent) ||
        begun.intent.export_id !== input.export_id ||
        begun.intent.review_revision !== input.review_revision
      )
        throw fail("begin intent invalid");
      if (begun.disposition === "replayed")
        return output(begun.intent.outcome, begun.intent, "replayed");
      if (begun.disposition === "unknown") return reconcileIntent(begun.intent);
      if (begun.intent.outcome !== "unknown_outcome")
        throw fail("claim is not unknown");
      return uploadClaim(begun.intent);
    },
    async reconcile(received) {
      const input = record(received) ? { ...received } : received;
      if (
        !record(input) ||
        Object.keys(input).length !== 1 ||
        typeof input.publication_id !== "string" ||
        !UUID_RE.test(input.publication_id)
      )
        throw fail("invalid reconciliation input");
      let readback: unknown;
      try {
        readback = await options.persistence.read(input.publication_id);
      } catch {
        throw fail("read acknowledgement invalid");
      }
      if (
        !readback ||
        (record(readback) && readback.disposition === "conflict") ||
        !validIntent(readback)
      )
        throw fail("publication is not reconcilable");
      if (readback.outcome === "uploaded" || readback.outcome === "reconciled")
        return output(readback.outcome, readback);
      return reconcileIntent(readback);
    },
  };
}
