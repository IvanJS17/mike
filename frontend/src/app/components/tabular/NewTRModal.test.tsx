import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NewTRModal } from "./NewTRModal";
import type { Document } from "../shared/types";

// The modal loads workflow templates on open; stub the API so the test is
// hermetic. No other network is touched in project mode.
vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn(async () => []),
    getProject: vi.fn(async () => ({ documents: [] })),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));

const projectDocs = [
    { id: "d1", filename: "A.pdf", status: "ready" } as Document,
    { id: "d2", filename: "B.pdf", status: "ready" } as Document,
];

describe("NewTRModal folder-grouping checkbox", () => {
    beforeEach(() => vi.clearAllMocks());

    it("passes document_grouping 'folder' when the subfolder checkbox is ticked", async () => {
        const user = userEvent.setup();
        const onAdd = vi.fn();
        render(
            <NewTRModal
                open
                onClose={vi.fn()}
                onAdd={onAdd}
                projectDocs={projectDocs}
                projectName="Matter 1"
            />,
        );

        // Step 1: title, then advance to the documents step.
        await user.type(
            screen.getByPlaceholderText(/review/i),
            "Grouped review",
        );
        await user.click(screen.getByRole("button", { name: "Next" }));

        // The grouping checkbox is only offered inside a project context.
        const checkbox = await screen.findByRole("checkbox", {
            name: /same project subfolder as one review row/i,
        });
        expect(checkbox).not.toBeChecked();
        await user.click(checkbox);
        expect(checkbox).toBeChecked();

        await user.click(screen.getByRole("button", { name: "Create" }));

        await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
        // 5th argument is the document grouping.
        expect(onAdd.mock.calls[0][4]).toBe("folder");
    });

    it("defaults to 'document' grouping when the checkbox is left unticked", async () => {
        const user = userEvent.setup();
        const onAdd = vi.fn();
        render(
            <NewTRModal
                open
                onClose={vi.fn()}
                onAdd={onAdd}
                projectDocs={projectDocs}
                projectName="Matter 1"
            />,
        );

        await user.type(
            screen.getByPlaceholderText(/review/i),
            "Plain review",
        );
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Create" }));

        await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
        expect(onAdd.mock.calls[0][4]).toBe("document");
    });
});
