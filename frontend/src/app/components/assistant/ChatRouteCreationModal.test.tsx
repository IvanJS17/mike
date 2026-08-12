import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelCatalog } from "@/app/lib/mikeApi";
import { ChatRouteCreationModal } from "./ChatRouteCreationModal";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getModelCatalog: vi.fn(),
}));

const getModelCatalogMock = vi.mocked(getModelCatalog);
const route = {
    provider: "openrouter" as const,
    model: "anthropic/claude-sonnet-4-6",
    credential_ref: "openrouter:v3",
};

beforeEach(() => {
    vi.clearAllMocks();
    getModelCatalogMock.mockResolvedValue({
        routes: [
            {
                ...route,
                source: "live",
                availability: "catalog",
                catalog_available: true,
            },
        ],
        catalogs: [],
    });
});

describe("ChatRouteCreationModal", () => {
    it("requires and confirms one exact route before creating a conversation", async () => {
        const onConfirm = vi.fn();
        const user = userEvent.setup();
        render(
            <ChatRouteCreationModal
                open
                creating={false}
                onConfirm={onConfirm}
                onCancel={vi.fn()}
            />,
        );

        const start = screen.getByRole("button", {
            name: "Start conversation",
        });
        expect(start).toBeDisabled();
        expect(
            screen.getByText(/receive the authorized conversation context/i),
        ).toBeInTheDocument();

        const routeSelect = await screen.findByRole("combobox", {
            name: "Model route",
        });
        await screen.findByRole("option", {
            name: /OpenRouter · anthropic\/claude-sonnet-4-6 · openrouter:v3/,
        });
        await user.selectOptions(
            routeSelect,
            "openrouter|anthropic/claude-sonnet-4-6|openrouter:v3",
        );
        await user.click(start);

        expect(onConfirm).toHaveBeenCalledWith(route);
    });

    it("cannot be closed after chat creation has started", async () => {
        const onCancel = vi.fn();
        const user = userEvent.setup();
        render(
            <ChatRouteCreationModal
                open
                creating
                onConfirm={vi.fn()}
                onCancel={onCancel}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(onCancel).not.toHaveBeenCalled();
    });
});
