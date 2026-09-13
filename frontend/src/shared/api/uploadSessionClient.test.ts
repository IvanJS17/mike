import { describe, expect, it } from "vitest";

import { uploadFilesWithSessionCore } from "./uploadSessionClient";

type UploadSessionTransport = Parameters<
    typeof uploadFilesWithSessionCore
>[0]["transport"];

type SessionFileStatus =
    | "pending_upload"
    | "uploaded"
    | "processing"
    | "completed"
    | "error";

function sessionFile(
    status: SessionFileStatus,
    result: unknown = null,
    errorCode: string | null = null,
) {
    return {
        id: "file-1",
        client_id: "client-1",
        filename: "contract.pdf",
        status,
        error_code: errorCode,
        result,
    };
}

describe("uploadFilesWithSessionCore", () => {
    it("creates a session, PUTs the bytes and completes the file", async () => {
        const control: string[] = [];
        const storage: Array<{ url: string; body: unknown; headers: unknown }> =
            [];
        let manifest: unknown;
        const transport: UploadSessionTransport = {
            apiRequest: async <T>(path: string, init?: RequestInit) => {
                control.push(`${init?.method ?? "GET"} ${path}`);
                if (path === "/upload-sessions") {
                    manifest = JSON.parse(String(init?.body));
                    return {
                        session: { id: "s1", status: "pending_upload" },
                        files: [
                            {
                                ...sessionFile("pending_upload"),
                                upload: {
                                    method: "PUT",
                                    url: "https://storage.test/f1",
                                    headers: {
                                        "Content-Type": "application/pdf",
                                    },
                                },
                            },
                        ],
                    } as T;
                }
                if (path === "/upload-sessions/s1/files/file-1/complete") {
                    return {
                        session: { id: "s1", status: "completed" },
                        files: [sessionFile("completed", { id: "doc-1" })],
                    } as T;
                }
                if (path === "/upload-sessions/s1") {
                    return {
                        session: { id: "s1", status: "completed" },
                        files: [sessionFile("completed", { id: "doc-1" })],
                    } as T;
                }
                throw new Error(`Unexpected control request: ${path}`);
            },
            fetchStorage: (async (input: RequestInfo | URL, init?: RequestInit) => {
                storage.push({
                    url: String(input),
                    body: init?.body,
                    headers: init?.headers,
                });
                return new Response(null, { status: 200 });
            }) as typeof fetch,
            shouldRetryControlRequest: () => false,
        };
        const file = new File(["pdf"], "contract.pdf", {
            type: "application/pdf",
        });

        const outcomes = await uploadFilesWithSessionCore<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [{ file, clientId: "client-1" }],
            transport,
        });

        expect(outcomes).toEqual([
            {
                clientId: "client-1",
                filename: "contract.pdf",
                status: "completed",
                result: { id: "doc-1" },
                errorCode: null,
            },
        ]);
        expect(manifest).toMatchObject({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [
                {
                    client_id: "client-1",
                    filename: "contract.pdf",
                    size_bytes: file.size,
                },
            ],
        });
        expect(control).toContain("POST /upload-sessions");
        expect(control).toContain(
            "POST /upload-sessions/s1/files/file-1/complete",
        );
        expect(storage[0]).toMatchObject({
            url: "https://storage.test/f1",
            body: file,
        });
    });

    it("reports an oversized file as its own error without a network call", async () => {
        const transport: UploadSessionTransport = {
            apiRequest: async () => {
                throw new Error("no request expected");
            },
            fetchStorage: (async () => {
                throw new Error("no request expected");
            }) as typeof fetch,
            shouldRetryControlRequest: () => false,
        };
        const file = new File(["pdf"], "huge.pdf");
        Object.defineProperty(file, "size", { value: 120 * 1024 * 1024 });

        const outcomes = await uploadFilesWithSessionCore({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [{ file, clientId: "client-1" }],
            transport,
        });

        expect(outcomes).toEqual([
            {
                clientId: "client-1",
                filename: "huge.pdf",
                status: "error",
                result: null,
                errorCode: "upload_file_too_large",
            },
        ]);
    });
});
