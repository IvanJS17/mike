import type { DriveFileMetadata } from "./googleDrive";

export const DRIVE_FORMAT_VERSION = "beta-0.1" as const;
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

export type DriveAppProperties = {
  matter_id: string;
  review_id: string;
  export_id: string;
  sha256: string;
  format_version: typeof DRIVE_FORMAT_VERSION;
};

export type DriveFileVerification =
  | {
      ok: true;
      sizeBytes: number;
      checksum: string;
    }
  | {
      ok: false;
      code: "drive_file_invalid";
    };

export function buildDriveAppProperties(input: {
  matterId: string;
  reviewId: string;
  exportId: string;
  sha256: string;
}): DriveAppProperties {
  return {
    matter_id: input.matterId,
    review_id: input.reviewId,
    export_id: input.exportId,
    sha256: input.sha256,
    format_version: DRIVE_FORMAT_VERSION,
  };
}

export function verifyDriveFile(input: {
  file: DriveFileMetadata;
  parentId: string;
  bytes: Buffer;
  appProperties: DriveAppProperties;
  expectedFileId?: string;
}): DriveFileVerification {
  const { file, parentId, bytes, appProperties, expectedFileId } = input;
  if (
    !file.id.trim() ||
    (expectedFileId !== undefined && file.id !== expectedFileId) ||
    file.parents.length !== 1 ||
    file.parents[0] !== parentId ||
    file.size !== String(bytes.byteLength) ||
    typeof file.md5Checksum !== "string" ||
    !file.md5Checksum.trim()
  ) {
    return { ok: false, code: "drive_file_invalid" };
  }
  for (const [key, expected] of Object.entries(appProperties)) {
    if (file.appProperties[key] !== expected) {
      return { ok: false, code: "drive_file_invalid" };
    }
  }
  return {
    ok: true,
    sizeBytes: bytes.byteLength,
    checksum: file.md5Checksum,
  };
}

export type DrivePublicationFailureCode =
  | "drive_upload_failed"
  | "drive_file_invalid"
  | "authorization_revoked"
  | "publication_record_failed";

export type DrivePublicationStatus = "pending" | "published" | "failed";
