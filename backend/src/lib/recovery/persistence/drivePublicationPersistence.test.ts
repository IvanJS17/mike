import { describe, expect, it, vi } from "vitest";

import {
  DRIVE_PUBLICATION_RPC_NAMES,
  createDrivePublicationPersistence,
} from "./drivePublicationPersistence";

const IDS = {
  publication: "11111111-1111-4111-8111-111111111111",
  export: "22222222-2222-4222-8222-222222222222",
  review: "33333333-3333-4333-8333-333333333333",
  execution: "44444444-4444-4444-8444-444444444444",
  matter: "55555555-5555-4555-8555-555555555555",
  project: "66666666-6666-4666-8666-666666666666",
  organization: "77777777-7777-4777-8777-777777777777",
  actor: "88888888-8888-4888-8888-888888888888",
  artifact: "99999999-9999-4999-8999-999999999999",
  artifactVersion: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  source: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  sourceVersion: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
} as const;
const HASH = "a".repeat(64);

function response(overrides: Record<string, unknown> = {}) {
  return {
    disposition: "claimed",
    publication_id: IDS.publication,
    export_id: IDS.export,
    review_id: IDS.review,
    execution_id: IDS.execution,
    matter_id: IDS.matter,
    project_id: IDS.project,
    organization_id: IDS.organization,
    actor_user_id: IDS.actor,
    authorization_epoch: 7,
    matter_folder_id: "drive-folder",
    approved_artifact_sha256: HASH,
    idempotency_key: "approved-export",
    attempts: 1,
    outcome: "unknown_outcome",
    provider_file_id: null,
    revision: 1,
    review_revision: 3,
    artifact_document_id: IDS.artifact,
    artifact_document_version_id: IDS.artifactVersion,
    artifact_storage_path: `orgs/${IDS.organization}/matters/${IDS.matter}/projects/${IDS.project}/documents/${IDS.artifact}/${HASH}.docx`,
    artifact_size_bytes: 42,
    source_document_id: IDS.source,
    source_document_version_id: IDS.sourceVersion,
    remote_size_bytes: null,
    remote_checksum: null,
    failure_code: null,
    legacy_payload: {},
    ...overrides,
  };
}

function makePersistence(data: unknown) {
  const rpc = vi.fn().mockResolvedValue({ data, error: null });
  return {
    rpc,
    persistence: createDrivePublicationPersistence({
      client: { rpc },
      context: {
        actor_user_id: IDS.actor,
        organization_id: IDS.organization,
        authorization_epoch: 7,
      },
    }),
  };
}

describe("Drive publication persistence adapter", () => {
  it("preserves opaque PostgreSQL UUIDs from the supported baseline", async () => {
    const source = "eeeeeeee-0000-0000-0000-000000000007";
    const { persistence } = makePersistence(
      response({ disposition: "read", source_document_id: source }),
    );
    await expect(persistence.read(IDS.publication)).resolves.toMatchObject({
      source_document_id: source,
    });
  });
  it("claims only a validated SQL acknowledgement and sends no artifact authority", async () => {
    const { rpc, persistence } = makePersistence(response());
    const result = await persistence.begin({
      export_id: IDS.export,
      review_revision: 3,
    });
    expect(result.disposition).toBe("claimed");
    if (result.disposition === "claimed") {
      expect(result.intent.outcome).toBe("unknown_outcome");
      expect(result.intent.approved_artifact_sha256).toBe(HASH);
    }
    expect(rpc).toHaveBeenCalledWith(DRIVE_PUBLICATION_RPC_NAMES.begin, {
      p_export_id: IDS.export,
      p_review_revision: 3,
      p_actor_user_id: IDS.actor,
      p_organization_id: IDS.organization,
      p_authorization_epoch: 7,
    });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_storage_path");
    expect(rpc.mock.calls[0][1]).not.toHaveProperty("p_artifact_sha256");
  });

  it("distinguishes an unknown acknowledgement from a replay and never grants a second claim", async () => {
    const unknown = makePersistence(response({ disposition: "unknown" }));
    const unknownResult = await unknown.persistence.begin({
      export_id: IDS.export,
      review_revision: 3,
    });
    expect(unknownResult).toMatchObject({ disposition: "unknown" });

    const replay = makePersistence(
      response({
        disposition: "replayed",
        outcome: "uploaded",
        provider_file_id: "file-1",
        remote_size_bytes: 42,
        remote_checksum: HASH,
        revision: 2,
      }),
    );
    const replayResult = await replay.persistence.begin({
      export_id: IDS.export,
      review_revision: 3,
    });
    expect(replayResult).toMatchObject({ disposition: "replayed" });
  });

  it.each([
    response({ export_id: IDS.review }),
    response({ actor_user_id: IDS.review }),
    response({ authorization_epoch: 8 }),
    response({
      organization_id: IDS.review,
      artifact_storage_path: `orgs/${IDS.review}/matters/${IDS.matter}/projects/${IDS.project}/documents/${IDS.artifact}/${HASH}.docx`,
    }),
    response({ attempts: 0 }),
    response({ attempts: 4 }),
    response({ disposition: "replayed" }),
    response({
      outcome: "uploaded",
      provider_file_id: "file-1",
      remote_size_bytes: 42,
      remote_checksum: HASH,
    }),
  ])(
    "rejects a well-shaped acknowledgement not bound to this begin request",
    async (invalid) => {
      const { persistence } = makePersistence(invalid);
      await expect(
        persistence.begin({ export_id: IDS.export, review_revision: 3 }),
      ).rejects.toThrow("Drive publication persistence failed");
    },
  );

  it("rejects readback for a different publication", async () => {
    const { persistence } = makePersistence(
      response({
        disposition: "read",
        publication_id: IDS.review,
      }),
    );
    await expect(persistence.read(IDS.publication)).rejects.toThrow(
      "Drive publication persistence failed",
    );
  });

  it("returns an identifiable conflict without accepting a legacy evidence row", async () => {
    const { persistence } = makePersistence({ disposition: "conflict" });
    await expect(
      persistence.begin({ export_id: IDS.export, review_revision: 3 }),
    ).resolves.toEqual({ disposition: "conflict" });
  });

  it.each([
    response({ outcome: "pending" }),
    response({ approved_artifact_sha256: "not-a-hash" }),
    response({ legacy_payload: { old: "evidence" } }),
    response({ artifact_storage_path: "foreign/object.docx" }),
  ])("rejects an invalid RPC acknowledgement", async (invalid) => {
    const { persistence } = makePersistence(invalid);
    await expect(
      persistence.begin({ export_id: IDS.export, review_revision: 3 }),
    ).rejects.toThrow("Drive publication persistence failed");
  });

  describe.each(["applied", "replayed"])("%s outcome ACK", (disposition) => {
    it.each([
      { failure_code: "authorization_revoked" },
      { attempts: 0 },
      { attempts: 4 },
    ])(
      "rejects a well-shaped but unbound failed outcome: %j",
      async (overrides) => {
        const { persistence } = makePersistence(
          response({
            disposition,
            outcome: "failed",
            revision: 2,
            failure_code: "drive_upload_failed",
            ...overrides,
          }),
        );
        await expect(
          persistence.recordOutcome({
            publication_id: IDS.publication,
            expected_revision: 1,
            outcome: "failed",
          }),
        ).rejects.toThrow("Drive publication persistence failed");
      },
    );
    it.each(["uploaded", "reconciled"] as const)(
      "rejects %s without a valid claim attempt",
      async (outcome) => {
        const { persistence } = makePersistence(
          response({
            disposition,
            outcome,
            revision: 2,
            attempts: 0,
            provider_file_id: "file",
            remote_size_bytes: 42,
            remote_checksum: HASH,
          }),
        );
        await expect(
          persistence.recordOutcome({
            publication_id: IDS.publication,
            expected_revision: 1,
            outcome,
            provider_file_id: "file",
            remote_size_bytes: 42,
            remote_checksum: HASH,
          }),
        ).rejects.toThrow("Drive publication persistence failed");
      },
    );
  });

  it("records a verified outcome with the same revision boundary and fixed definite failure code", async () => {
    const { rpc, persistence } = makePersistence(
      response({
        disposition: "applied",
        outcome: "failed",
        revision: 2,
        failure_code: "drive_upload_failed",
      }),
    );
    const result = await persistence.recordOutcome({
      publication_id: IDS.publication,
      expected_revision: 1,
      outcome: "failed",
    });
    expect(result).toMatchObject({ disposition: "applied" });
    expect(rpc).toHaveBeenCalledWith(DRIVE_PUBLICATION_RPC_NAMES.outcome, {
      p_publication_id: IDS.publication,
      p_expected_revision: 1,
      p_actor_user_id: IDS.actor,
      p_organization_id: IDS.organization,
      p_authorization_epoch: 7,
      p_outcome: "failed",
      p_provider_file_id: null,
      p_remote_size_bytes: null,
      p_remote_checksum: null,
      p_failure_code: "drive_upload_failed",
    });
  });

  it.each([
    response({ disposition: "read", outcome: { toString: () => "uploaded" } }),
    response({
      disposition: "read",
      outcome: "uploaded",
      provider_file_id: "file",
      remote_size_bytes: 43,
      remote_checksum: HASH,
    }),
    response({
      disposition: "read",
      outcome: "uploaded",
      provider_file_id: "file",
      remote_size_bytes: 42,
      remote_checksum: "b".repeat(64),
    }),
  ])(
    "rejects unverified remote metadata and non-string states",
    async (invalid) => {
      await expect(
        makePersistence(invalid).persistence.read(IDS.publication),
      ).rejects.toThrow();
    },
  );

  it("rehydrates a canonical row through the named read RPC", async () => {
    const { rpc, persistence } = makePersistence(
      response({ disposition: "read" }),
    );
    const result = await persistence.read(IDS.publication);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      publication_id: IDS.publication,
      outcome: "unknown_outcome",
      attempts: 1,
    });
    expect(rpc).toHaveBeenCalledWith(DRIVE_PUBLICATION_RPC_NAMES.read, {
      p_publication_id: IDS.publication,
      p_actor_user_id: IDS.actor,
      p_organization_id: IDS.organization,
      p_authorization_epoch: 7,
    });
  });

  it("fails closed on an RPC error, malformed envelope, or missing read row only as null", async () => {
    const errorRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "secret database detail" },
    });
    const errorPersistence = createDrivePublicationPersistence({
      client: { rpc: errorRpc },
      context: {
        actor_user_id: IDS.actor,
        organization_id: IDS.organization,
        authorization_epoch: 7,
      },
    });
    await expect(errorPersistence.read(IDS.publication)).rejects.toThrow(
      "Drive publication persistence failed",
    );

    const missing = makePersistence(null);
    await expect(missing.persistence.read(IDS.publication)).resolves.toBeNull();
  });
});
