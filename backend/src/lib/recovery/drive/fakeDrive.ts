export type FakeDriveUploadInput = {
  publication_id: string;
  folder_id: string;
  idempotency_key: string;
  artifact_sha256: string;
  artifact_size_bytes: number;
  bytes: Uint8Array;
};

export type FakeDriveLookupInput = {
  publication_id: string;
  folder_id: string;
  idempotency_key: string;
  artifact_sha256: string;
  artifact_size_bytes: number;
};

export type FakeDriveRemoteObject = {
  file_id: string;
  folder_id: string;
  idempotency_key: string;
  bytes: Uint8Array;
};

export type FakeDriveLookupResult =
  | { disposition: "found"; objects: FakeDriveRemoteObject[] }
  | { disposition: "authoritative_absence" }
  | { disposition: "unknown" }
  | { disposition: "ambiguous"; objects: FakeDriveRemoteObject[] };

export type ApprovedArtifactDriveTransport = {
  kind: "fake";
  host: "fake";
  upload(input: FakeDriveUploadInput): Promise<unknown>;
  find(input: FakeDriveLookupInput): Promise<unknown>;
};

export type FakeDrive = ApprovedArtifactDriveTransport & {
  uploadCount: number;
  uploadError: boolean;
  throwAfterStore: boolean;
};

export type FakeDriveOptions = {
  uploadError?: boolean;
  throwAfterStore?: boolean;
  lookup?: "authoritative_absence" | "unknown" | "ambiguous";
  returnedMetadata?: Partial<FakeDriveRemoteObject>;
};

function key(
  input: Pick<FakeDriveLookupInput, "folder_id" | "idempotency_key">,
): string {
  return `${input.folder_id}\u0000${input.idempotency_key}`;
}

function copyObject(object: FakeDriveRemoteObject): FakeDriveRemoteObject {
  return { ...object, bytes: new Uint8Array(object.bytes) };
}

/** A process-local fake only; its remote objects deliberately do not share the persistence map. */
export function createFakeDrive(options: FakeDriveOptions = {}): FakeDrive {
  const objects = new Map<string, FakeDriveRemoteObject>();
  const drive: FakeDrive = {
    kind: "fake",
    host: "fake",
    uploadCount: 0,
    uploadError: options.uploadError ?? false,
    throwAfterStore: options.throwAfterStore ?? false,
    async upload(input) {
      drive.uploadCount += 1;
      if (drive.uploadError)
        throw new Error("fake upload rejected before storage");
      const existing = objects.get(key(input));
      if (existing) {
        if (
          existing.bytes.length !== input.bytes.length ||
          existing.bytes.some((byte, index) => byte !== input.bytes[index])
        )
          throw new Error("fake idempotency conflict");
        return copyObject(existing);
      }
      const object: FakeDriveRemoteObject = {
        file_id: `fake-file-${drive.uploadCount}`,
        folder_id: input.folder_id,
        idempotency_key: input.idempotency_key,
        bytes: new Uint8Array(input.bytes),
        ...options.returnedMetadata,
      };
      objects.set(key(input), copyObject(object));
      if (drive.throwAfterStore) {
        if (drive.throwAfterStore) drive.throwAfterStore = false;
        throw new Error("fake upload outcome unknown");
      }
      return copyObject(object);
    },
    async find(input) {
      if (options.lookup === "unknown")
        return { disposition: "unknown" } satisfies FakeDriveLookupResult;
      if (
        options.lookup === "authoritative_absence" &&
        !objects.has(key(input))
      )
        return {
          disposition: "authoritative_absence",
        } satisfies FakeDriveLookupResult;
      const object = objects.get(key(input));
      if (options.lookup === "ambiguous") {
        return {
          disposition: "ambiguous",
          objects: object ? [copyObject(object), copyObject(object)] : [],
        } satisfies FakeDriveLookupResult;
      }
      return object
        ? ({
            disposition: "found",
            objects: [copyObject(object)],
          } satisfies FakeDriveLookupResult)
        : ({ disposition: "unknown" } satisfies FakeDriveLookupResult);
    },
  };
  return drive;
}
