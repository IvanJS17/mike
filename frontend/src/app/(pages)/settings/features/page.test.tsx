import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    profile: {
        quickActionsVisible: true,
    },
    updateQuickActionsVisible: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => state,
}));
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/app/lib/mikeApi", () => ({ isMfaRequiredError: () => false }));

import FeaturesPage from "./page";

describe("features settings", () => {
    beforeEach(() => {
        state.profile.quickActionsVisible = true;
        state.updateQuickActionsVisible.mockReset().mockResolvedValue(true);
    });

    it("omits CourtListener research and key controls", () => {
        render(<FeaturesPage />);
        expect(screen.getByText("Quick actions")).toBeInTheDocument();
        expect(
            screen.queryAllByText(/CourtListener|Legal Research|US case law/i),
        ).toHaveLength(0);
        expect(
            screen.queryByPlaceholderText("Token..."),
        ).not.toBeInTheDocument();
        expect(screen.getAllByRole("switch")).toHaveLength(1);
    });

    it("saves quick actions, disables while pending, and reflects the profile", async () => {
        let finish!: (ok: boolean) => void;
        state.updateQuickActionsVisible.mockReturnValue(
            new Promise<boolean>((resolve) => { finish = resolve; }),
        );
        const { rerender } = render(<FeaturesPage />);
        const toggle = screen.getAllByRole("switch")[0];
        expect(toggle).toHaveAttribute("aria-checked", "true");
        fireEvent.click(toggle);
        expect(state.updateQuickActionsVisible).toHaveBeenCalledWith(false);
        expect(toggle).toBeDisabled();
        await act(async () => {
            finish(true);
        });
        state.profile.quickActionsVisible = false;
        rerender(<FeaturesPage />);
        expect(toggle).toBeEnabled();
        expect(toggle).toHaveAttribute("aria-checked", "false");
        fireEvent.click(toggle);
        expect(state.updateQuickActionsVisible).toHaveBeenLastCalledWith(true);
    });

    it("keeps the quick actions failure message and allows retry", async () => {
        state.updateQuickActionsVisible.mockResolvedValueOnce(false);
        render(<FeaturesPage />);
        const toggle = screen.getAllByRole("switch")[0];
        fireEvent.click(toggle);
        expect(
            await screen.findByText("Could not update. Try again."),
        ).toBeInTheDocument();
        expect(toggle).toBeEnabled();
        fireEvent.click(toggle);
        await waitFor(() => expect(toggle).toBeEnabled());
        expect(
            screen.queryByText("Could not update. Try again."),
        ).not.toBeInTheDocument();
    });
});
