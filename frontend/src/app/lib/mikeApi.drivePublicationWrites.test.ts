import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    publishDrivePublication,
    reconcileDrivePublication,
    type DrivePublicationWriteResult,
} from "./mikeApi";

const fetchMock = vi.fn();
const payload: DrivePublicationWriteResult = {
    outcome: "uploaded",
    disposition: "uploaded",
    publication: {
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
    },
};

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
        new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("Drive publication write client methods", () => {
    it("publishes with encoded path segments and the exact body", async () => {
        await expect(
            publishDrivePublication("project/id", "execution?id", "export#id", 3),
        ).resolves.toEqual(payload);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(
            "/api/projects/project%2Fid/ai-executions/execution%3Fid/review/drive-publications",
        );
        expect(init.method).toBe("POST");
        expect(init.body).toBe(
            JSON.stringify({ export_id: "export#id", expected_review_revision: 3 }),
        );
        expect(init.cache).toBe("no-store");
        expect(init.headers).toEqual({
            Accept: "application/json",
            "Content-Type": "application/json",
        });
    });

    it("reconciles with an empty body and preserves API errors", async () => {
        await expect(
            reconcileDrivePublication("project/id", "execution?id", "publication#id"),
        ).resolves.toEqual(payload);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(
            "/api/projects/project%2Fid/ai-executions/execution%3Fid/review/drive-publications/publication%23id/reconcile",
        );
        expect(init.method).toBe("POST");
        expect(init.body).toBe("{}");

        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ code: "authorization_revoked", detail: "Authorization revoked." }), {
                status: 403,
                headers: { "Content-Type": "application/json" },
            }),
        );
        await expect(
            reconcileDrivePublication("project-1", "execution-1", "publication-1"),
        ).rejects.toMatchObject({
            status: 403,
            code: "authorization_revoked",
        });
    });
});
