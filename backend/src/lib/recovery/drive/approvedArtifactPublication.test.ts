import { createHash } from "node:crypto";

import { Document, Packer, Paragraph } from "docx";
import { describe, expect, it, vi } from "vitest";

import type {
  DrivePublicationBeginResult,
  DrivePublicationIntentDto,
  DrivePublicationOutcomeResult,
  DrivePublicationPersistence,
} from "../persistence/drivePublicationPersistence";
import {
  createApprovedArtifactPublicationService,
  type ApprovedArtifactDriveTransport,
} from "./approvedArtifactPublication";
import { createFakeDrive } from "./fakeDrive";

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

type Outcome = DrivePublicationIntentDto["outcome"];

function cloneIntent(
  intent: DrivePublicationIntentDto,
): DrivePublicationIntentDto {
  return { ...intent };
}

class MemoryPublicationPersistence implements DrivePublicationPersistence {
  intent: DrivePublicationIntentDto | null = null;
  beginCalls = 0;
  recordCalls = 0;
  readCalls = 0;
  loseNextRecordAcknowledgement = false;

  async begin(input: {
    export_id: string;
    review_revision: number;
  }): Promise<DrivePublicationBeginResult> {
    this.beginCalls += 1;
    if (!this.intent) {
      this.intent = makeIntent();
      return { disposition: "claimed", intent: cloneIntent(this.intent) };
    }
    if (
      this.intent.outcome === "uploaded" ||
      this.intent.outcome === "reconciled"
    ) {
      return { disposition: "replayed", intent: cloneIntent(this.intent) };
    }
    if (this.intent.outcome === "failed" && this.intent.attempts < 3) {
      this.intent = {
        ...this.intent,
        outcome: "unknown_outcome",
        attempts: this.intent.attempts + 1,
        revision: this.intent.revision + 1,
      };
      return { disposition: "claimed", intent: cloneIntent(this.intent) };
    }
    if (
      this.intent.export_id !== input.export_id ||
      this.intent.review_revision !== input.review_revision
    )
      return { disposition: "conflict" };
    return { disposition: "unknown", intent: cloneIntent(this.intent) };
  }

  async recordOutcome(input: {
    publication_id: string;
    expected_revision: number;
    outcome: "uploaded" | "reconciled" | "failed";
    provider_file_id?: string;
    remote_size_bytes?: number;
    remote_checksum?: string;
  }): Promise<DrivePublicationOutcomeResult> {
    this.recordCalls += 1;
    if (
      !this.intent ||
      this.intent.publication_id !== input.publication_id ||
      this.intent.revision !== input.expected_revision
    )
      return { disposition: "conflict" };
    const next: DrivePublicationIntentDto = {
      ...this.intent,
      revision: this.intent.revision + 1,
      outcome: input.outcome,
      provider_file_id: input.provider_file_id,
      remote_size_bytes: input.remote_size_bytes ?? null,
      remote_checksum: input.remote_checksum ?? null,
      failure_code: input.outcome === "failed" ? "drive_upload_failed" : null,
    };
    this.intent = next;
    if (this.loseNextRecordAcknowledgement) {
      this.loseNextRecordAcknowledgement = false;
      throw new Error("acknowledgement lost");
    }
    return { disposition: "applied", intent: cloneIntent(next) };
  }

  async read(publicationId: string): Promise<DrivePublicationIntentDto | null> {
    this.readCalls += 1;
    return this.intent?.publication_id === publicationId
      ? cloneIntent(this.intent)
      : null;
  }
}

let artifactBytes: Uint8Array;

async function realDocx(): Promise<Uint8Array> {
  if (!artifactBytes) {
    artifactBytes = new Uint8Array(
      await Packer.toBuffer(
        new Document({
          sections: [{ children: [new Paragraph("approved report")] }],
        }),
      ),
    );
  }
  return new Uint8Array(artifactBytes);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeIntent(
  overrides: Partial<DrivePublicationIntentDto> = {},
): DrivePublicationIntentDto {
  const bytes = artifactBytes ?? new Uint8Array([1]);
  const sha = hash(bytes);
  return {
    matter_folder_id: "matter-folder",
    approved_artifact_sha256: sha,
    idempotency_key: "approved-export",
    attempts: 1,
    outcome: "unknown_outcome",
    publication_id: IDS.publication,
    export_id: IDS.export,
    review_id: IDS.review,
    execution_id: IDS.execution,
    matter_id: IDS.matter,
    project_id: IDS.project,
    organization_id: IDS.organization,
    actor_user_id: IDS.actor,
    authorization_epoch: 7,
    revision: 1,
    review_revision: 3,
    artifact_document_id: IDS.artifact,
    artifact_document_version_id: IDS.artifactVersion,
    artifact_storage_path: `orgs/${IDS.organization}/matters/${IDS.matter}/projects/${IDS.project}/documents/${IDS.artifact}/${sha}.docx`,
    artifact_size_bytes: bytes.length,
    source_document_id: IDS.source,
    source_document_version_id: IDS.sourceVersion,
    remote_size_bytes: null,
    remote_checksum: null,
    failure_code: null,
    ...overrides,
  };
}

function storage(bytes: Uint8Array) {
  return { getStrict: vi.fn(async () => new Uint8Array(bytes)) };
}

function service(
  persistence: DrivePublicationPersistence,
  bytes: Uint8Array,
  transport: ApprovedArtifactDriveTransport,
  revalidate = vi.fn(async () => true),
) {
  return createApprovedArtifactPublicationService({
    persistence,
    storage: storage(bytes),
    transport,
    revalidateAuthorization: revalidate,
  });
}

describe("approved artifact publication orchestration", () => {
  it("rejects a claim changed during final authorization before any upload", async () => {
    const content = await realDocx();
    const persistence = new MemoryPublicationPersistence();
    const drive = createFakeDrive();
    const authorize = vi.fn(async () => {
      persistence.intent = {
        ...persistence.intent!,
        matter_folder_id: "changed-folder",
      };
      return true;
    });
    await expect(
      service(persistence, content, drive, authorize).publish({
        export_id: IDS.export,
        review_revision: 3,
      }),
    ).rejects.toThrow();
    expect(drive.uploadCount).toBe(0);
  });

  it("snapshots the request revision once", async () => {
    const content = await realDocx();
    const persistence = new MemoryPublicationPersistence();
    let reads = 0;
    await expect(
      service(persistence, content, createFakeDrive()).publish({
        export_id: IDS.export,
        get review_revision() {
          return ++reads === 1 ? 3 : 4;
        },
      }),
    ).resolves.toMatchObject({ outcome: "uploaded" });
    expect(reads).toBe(1);
  });

  it("does not let the fake hide or overwrite an existing remote object", async () => {
    const content = await realDocx();
    const intent = makeIntent();
    const drive = createFakeDrive({ lookup: "authoritative_absence" });
    const input = {
      publication_id: intent.publication_id,
      folder_id: intent.matter_folder_id,
      idempotency_key: intent.idempotency_key,
      artifact_sha256: hash(content),
      artifact_size_bytes: content.length,
      bytes: content,
    };
    const original = await drive.upload(input);
    await expect(drive.find(input)).resolves.toMatchObject({
      disposition: "found",
      objects: [original],
    });
    const changed = new Uint8Array([...content, 1]);
    await expect(
      drive.upload({
        ...input,
        bytes: changed,
        artifact_sha256: hash(changed),
        artifact_size_bytes: changed.length,
      }),
    ).rejects.toThrow();
    await expect(drive.find(input)).resolves.toMatchObject({
      disposition: "found",
      objects: [original],
    });
  });
  it("uploads once, replays, and rehydrates through persistence in a new service instance", async () => {
    const bytes = await realDocx();
    const persistence = new MemoryPublicationPersistence();
    const drive = createFakeDrive();
    await expect(
      service(persistence, bytes, drive).publish({
        export_id: IDS.export,
        review_revision: 3,
      }),
    ).resolves.toMatchObject({ outcome: "uploaded" });
    await expect(
      service(persistence, bytes, drive).publish({
        export_id: IDS.export,
        review_revision: 3,
      }),
    ).resolves.toMatchObject({ disposition: "replayed", outcome: "uploaded" });
    expect(drive.uploadCount).toBe(1);
    expect(persistence.beginCalls).toBe(2);
  });

  it("allows only one concurrent durable claim", async () => {
    const bytes = await realDocx();
    const persistence = new MemoryPublicationPersistence();
    const drive = createFakeDrive({ lookup: "unknown" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revalidate = vi.fn(async () => {
      await gate;
      return true;
    });
    const first = service(persistence, bytes, drive, revalidate).publish({
      export_id: IDS.export,
      review_revision: 3,
    });
    const second = service(persistence, bytes, drive).publish({
      export_id: IDS.export,
      review_revision: 3,
    });
    await expect(second).resolves.toMatchObject({ outcome: "unknown_outcome" });
    release();
    await expect(first).resolves.toMatchObject({ outcome: "uploaded" });
    expect(drive.uploadCount).toBe(1);
  });

  it("does not upload when authorization is revoked after the byte read", async () => {
    const bytes = await realDocx();
    const persistence = new MemoryPublicationPersistence();
    const drive = createFakeDrive();
    const revalidate = vi.fn(async () => false);
    await expect(
      service(persistence, bytes, drive, revalidate).publish({
        export_id: IDS.export,
        review_revision: 3,
      }),
    ).rejects.toThrow("authorization");
    expect(drive.uploadCount).toBe(0);
  });

  it("rejects changed committed bytes and does not trust malformed returned metadata", async () => {
    const bytes = await realDocx();
    const persistence = new MemoryPublicationPersistence();
    const changed = storage(new Uint8Array([...bytes, 1]));
    const drive = createFakeDrive();
    const invalidStorageService = createApprovedArtifactPublicationService({
      persistence,
      storage: changed,
      transport: drive,
      revalidateAuthorization: vi.fn(async () => true),
    });
    await expect(
      invalidStorageService.publish({
        export_id: IDS.export,
        review_revision: 3,
      }),
    ).rejects.toThrow("artifact");
    expect(drive.uploadCount).toBe(0);

    const malformed = createFakeDrive({
      returnedMetadata: { folder_id: "wrong-folder" },
    });
    const second = new MemoryPublicationPersistence();
    await expect(
      service(second, bytes, malformed).publish({
        export_id: IDS.export,
        review_revision: 3,
      }),
    ).resolves.toMatchObject({ outcome: "unknown_outcome" });
    expect(second.recordCalls).toBe(0);
  });

  it("reconciles an upload that throws after the fake remote stores it without reuploading", async () => {
    const bytes = await realDocx();
    const persistence = new MemoryPublicationPersistence();
    const drive = createFakeDrive({ throwAfterStore: true });
    await expect(
      service(persistence, bytes, drive).publish({
        export_id: IDS.export,
        review_revision: 3,
      }),
    ).resolves.toMatchObject({ outcome: "reconciled" });
    expect(drive.uploadCount).toBe(1);
    expect(persistence.recordCalls).toBe(1);
  });

  it("reads and reconciles after DB acknowledgement loss", async () => {
    const bytes = await realDocx();
    const persistence = new MemoryPublicationPersistence();
    persistence.loseNextRecordAcknowledgement = true;
    const drive = createFakeDrive();
    await expect(
      service(persistence, bytes, drive).publish({
        export_id: IDS.export,
        review_revision: 3,
      }),
    ).resolves.toMatchObject({ disposition: "replayed", outcome: "uploaded" });
    expect(drive.uploadCount).toBe(1);
    expect(persistence.recordCalls).toBe(1);
    expect(persistence.readCalls).toBeGreaterThan(0);
  });

  it("records authoritative absence as failed, then permits only the bounded retry", async () => {
    const bytes = await realDocx();
    const persistence = new MemoryPublicationPersistence();
    const drive = createFakeDrive({
      uploadError: true,
      lookup: "authoritative_absence",
    });
    await expect(
      service(persistence, bytes, drive).publish({
        export_id: IDS.export,
        review_revision: 3,
      }),
    ).resolves.toMatchObject({ outcome: "failed" });
    drive.uploadError = false;
    await expect(
      service(persistence, bytes, drive).publish({
        export_id: IDS.export,
        review_revision: 3,
      }),
    ).resolves.toMatchObject({ outcome: "uploaded" });
    expect(drive.uploadCount).toBe(2);
  });

  it.each(["unknown", "ambiguous"] as const)(
    "does not retry %s absence",
    async (lookup) => {
      const bytes = await realDocx();
      const persistence = new MemoryPublicationPersistence();
      const drive = createFakeDrive({ uploadError: true, lookup });
      await expect(
        service(persistence, bytes, drive).publish({
          export_id: IDS.export,
          review_revision: 3,
        }),
      ).resolves.toMatchObject({ outcome: "unknown_outcome" });
      await expect(
        service(persistence, bytes, drive).publish({
          export_id: IDS.export,
          review_revision: 3,
        }),
      ).resolves.toMatchObject({ outcome: "unknown_outcome" });
      expect(drive.uploadCount).toBe(1);
    },
  );

  it("rejects every non-fake transport at construction", async () => {
    const bytes = await realDocx();
    expect(() =>
      service(new MemoryPublicationPersistence(), bytes, {
        kind: "real",
        host: "drive.google.com",
      } as never),
    ).toThrow("fake");
  });
});
