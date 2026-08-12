import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelCatalog, type ModelRoute } from "@/app/lib/mikeApi";
import { GovernedModelRouteSelect } from "./GovernedModelRouteSelect";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getModelCatalog: vi.fn(),
}));

const getModelCatalogMock = vi.mocked(getModelCatalog);
const route: ModelRoute = {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    credential_ref: "deepseek:v2",
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

describe("GovernedModelRouteSelect", () => {
    it("requires an explicit catalog route and returns the exact selection", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(
            <GovernedModelRouteSelect
                value={null}
                onChange={onChange}
                locked={false}
            />,
        );

        const select = await screen.findByRole("combobox", {
            name: "Model route",
        });
        expect(select).toHaveValue("");
        expect(screen.getByText(/DeepSeek · deepseek-v4-flash · deepseek:v2/)).toBeInTheDocument();

        await user.selectOptions(
            select,
            "deepseek|deepseek-v4-flash|deepseek:v2",
        );

        expect(onChange).toHaveBeenCalledWith(route);
    });

    it("shows a pinned route without fetching or allowing changes", async () => {
        render(
            <GovernedModelRouteSelect
                value={route}
                onChange={vi.fn()}
                locked
            />,
        );

        const select = screen.getByRole("combobox", { name: "Model route" });
        expect(select).toBeDisabled();
        expect(select).toHaveValue("deepseek|deepseek-v4-flash|deepseek:v2");
        await waitFor(() => expect(getModelCatalogMock).not.toHaveBeenCalled());
    });
});
