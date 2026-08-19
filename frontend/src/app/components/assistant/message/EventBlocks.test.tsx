import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSession: vi.fn(),
}));

vi.mock("@/app/lib/supabase", () => ({
    supabase: {
        auth: {
            getSession: mocks.getSession,
        },
    },
}));

import { DocDownloadBlock } from "./EventBlocks";

describe("DocDownloadBlock", () => {
    beforeEach(() => {
        mocks.getSession.mockReset().mockResolvedValue({
            data: { session: { access_token: "jwt-user-1" } },
        });
        vi.stubGlobal("fetch", vi.fn());
        vi.stubGlobal("URL", {
            createObjectURL: vi.fn(() => "blob:download"),
            revokeObjectURL: vi.fn(),
        });
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
            () => {},
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("fetches a chat grant with the bearer and no-store cache policy", async () => {
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockResolvedValue({
            ok: true,
            blob: vi.fn().mockResolvedValue(new Blob(["pdf"])),
        } as unknown as Response);

        render(
            <DocDownloadBlock
                filename="contract.pdf"
                download_url="/download/opaque-grant"
            />,
        );

        fireEvent.click(screen.getAllByRole("button")[1]);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("http://localhost:3001/download/opaque-grant");
        expect(init).toMatchObject({
            cache: "no-store",
            headers: { Authorization: "Bearer jwt-user-1" },
        });
    });
});
