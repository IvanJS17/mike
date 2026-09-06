import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    getDrivePublicationStatus,
    type DrivePublicationStatus,
} from "./mikeApi";

const fetchMock = vi.fn();

const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });

const payload: DrivePublicationStatus = {
    publication_id: "publication-1",
    export_id: "export-1",
    execution_id: "execution-1",
    review_revision: 3,
    revision: 2,
    outcome: "uploaded",
    attempts: 1,
    approved_artifact_sha256: "a".repeat(64),
    provider_file_id: "drive-file-1",
    failure_code: null,
};

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(jsonResponse(payload));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("getDrivePublicationStatus", () => {
    it("uses the authenticated GET helper with encoded path segments and preserves the DTO", async () => {
        const result = await getDrivePublicationStatus(
            "project/id",
            "execution?id",
            "publication#id",
        );

        expect(result).toEqual(payload);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(
            "/api/projects/project%2Fid/ai-executions/execution%3Fid/review/drive-publications/publication%23id",
        );
        expect(init.method).toBeUndefined();
        expect(init.body).toBeUndefined();
        expect(init.cache).toBe("no-store");
        expect(init.headers).toEqual({ Accept: "application/json" });
    });

    it("does not rewrite publication outcomes or nullable fields", async () => {
        const pending: DrivePublicationStatus = {
            ...payload,
            outcome: "unknown_outcome",
            provider_file_id: null,
            failure_code: "drive_upload_outcome_unknown",
        };
        fetchMock.mockResolvedValueOnce(jsonResponse(pending));

        await expect(
            getDrivePublicationStatus("project-1", "execution-1", "publication-1"),
        ).resolves.toEqual(pending);
    });
});
