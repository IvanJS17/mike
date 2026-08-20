import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_FIELDS = "id,parents,size,md5Checksum,appProperties";

export type DriveFileMetadata = {
  id: string;
  parents: string[];
  size: string;
  md5Checksum?: string;
  appProperties: Record<string, string>;
};

export type DriveDocxUpload = {
  name: string;
  parentId: string;
  bytes: Buffer;
  mimeType: string;
  appProperties: Record<string, string>;
};

export interface DriveClient {
  uploadDocx(input: DriveDocxUpload): Promise<DriveFileMetadata>;
  getFile(fileId: string): Promise<DriveFileMetadata>;
}

function accessTokenFromConfig(): string {
  const configuredToken = process.env.GOOGLE_DRIVE_ACCESS_TOKEN?.trim() ?? "";
  const configuredFile =
    process.env.GOOGLE_DRIVE_ACCESS_TOKEN_FILE?.trim() ?? "";
  if (configuredToken && configuredFile) {
    throw new Error(
      "Configure exactly one of GOOGLE_DRIVE_ACCESS_TOKEN or GOOGLE_DRIVE_ACCESS_TOKEN_FILE",
    );
  }
  if (configuredToken) return configuredToken;
  if (!configuredFile) {
    throw new Error(
      "Google Drive access token is not configured outside the repository",
    );
  }
  if (!isAbsolute(configuredFile)) {
    throw new Error("GOOGLE_DRIVE_ACCESS_TOKEN_FILE must be an absolute path");
  }

  let raw: string;
  try {
    raw = readFileSync(configuredFile, "utf8").trim();
  } catch {
    throw new Error("Google Drive access token file is unavailable");
  }
  if (!raw) throw new Error("Google Drive access token file is empty");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).access_token === "string" &&
      (parsed as Record<string, string>).access_token.trim()
    ) {
      return (parsed as Record<string, string>).access_token.trim();
    }
  } catch {
    // A secret file may contain only the access token, without JSON metadata.
  }
  return raw;
}

function parseDriveFile(value: unknown): DriveFileMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Google Drive returned invalid file metadata");
  }
  const row = value as Record<string, unknown>;
  const parents = Array.isArray(row.parents)
    ? row.parents.filter(
        (parent): parent is string => typeof parent === "string",
      )
    : [];
  const appProperties =
    row.appProperties &&
    typeof row.appProperties === "object" &&
    !Array.isArray(row.appProperties)
      ? Object.fromEntries(
          Object.entries(row.appProperties).filter(
            ([key, property]) =>
              typeof key === "string" && typeof property === "string",
          ),
        )
      : {};
  const size =
    typeof row.size === "string"
      ? row.size
      : typeof row.size === "number" && Number.isSafeInteger(row.size)
        ? String(row.size)
        : "";
  if (typeof row.id !== "string" || !row.id.trim() || !size) {
    throw new Error("Google Drive returned incomplete file metadata");
  }
  return {
    id: row.id,
    parents,
    size,
    md5Checksum:
      typeof row.md5Checksum === "string" ? row.md5Checksum : undefined,
    appProperties,
  };
}

class GoogleDriveClient implements DriveClient {
  constructor(private readonly accessToken: string) {}

  async uploadDocx(input: DriveDocxUpload): Promise<DriveFileMetadata> {
    const boundary = `mike-${randomUUID()}`;
    const metadata = JSON.stringify({
      name: input.name,
      mimeType: input.mimeType,
      parents: [input.parentId],
      appProperties: input.appProperties,
    });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
        "utf8",
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
        "utf8",
      ),
      input.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);
    const response = await fetch(
      `${DRIVE_UPLOAD_API}?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(DRIVE_FIELDS)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    if (!response.ok) throw new Error("Google Drive upload failed");
    return parseDriveFile(await response.json());
  }

  async getFile(fileId: string): Promise<DriveFileMetadata> {
    if (!fileId.trim()) throw new Error("Google Drive file id is empty");
    const response = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(DRIVE_FIELDS)}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      },
    );
    if (!response.ok)
      throw new Error("Google Drive metadata verification failed");
    return parseDriveFile(await response.json());
  }
}

export function getGoogleDriveClient(): DriveClient {
  return new GoogleDriveClient(accessTokenFromConfig());
}
