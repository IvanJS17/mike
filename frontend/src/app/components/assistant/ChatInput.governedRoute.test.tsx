import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn().mockResolvedValue([]),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
    getModelCatalog: vi.fn(),
}));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

describe("ChatInput governed route", () => {
    it("shows the pinned route and never adds model selection to a message", async () => {
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        const onSubmit = vi.fn();
        const user = userEvent.setup();
        render(
            <ChatInput
                onSubmit={onSubmit}
                onCancel={vi.fn()}
                isLoading={false}
                route={{
                    provider: "openrouter",
                    model: "anthropic/claude-sonnet-4-6",
                    credential_ref: "openrouter:v3",
                }}
            />,
        );

        const route = screen.getByRole("combobox", { name: "Model route" });
        expect(route).toBeDisabled();
        expect(route).toHaveValue(
            "openrouter|anthropic/claude-sonnet-4-6|openrouter:v3",
        );

        await user.type(
            screen.getByPlaceholderText("How can I help?"),
            "Review this clause",
        );
        await user.click(screen.getByRole("button", { name: "Send message" }));

        expect(onSubmit).toHaveBeenCalledWith({
            role: "user",
            content: "Review this clause",
            files: undefined,
            workflow: undefined,
        });
    });
});
