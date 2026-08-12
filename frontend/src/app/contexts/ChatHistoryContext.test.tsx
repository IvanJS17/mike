import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createChat,
    getModelCatalog,
    listChats,
} from "@/app/lib/mikeApi";
import {
    ChatHistoryProvider,
    useChatHistoryContext,
} from "./ChatHistoryContext";

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    createChat: vi.fn(),
    getModelCatalog: vi.fn(),
    listChats: vi.fn(),
}));

const createChatMock = vi.mocked(createChat);
const getModelCatalogMock = vi.mocked(getModelCatalog);
const listChatsMock = vi.mocked(listChats);

function Harness() {
    const { saveChat } = useChatHistoryContext();
    return (
        <button type="button" onClick={() => void saveChat("project-1")}>
            New chat
        </button>
    );
}

describe("ChatHistoryProvider governed chat creation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listChatsMock.mockResolvedValue([]);
        createChatMock.mockResolvedValue({ id: "chat-1" });
        getModelCatalogMock.mockResolvedValue({
            routes: [
                {
                    provider: "deepseek",
                    model: "deepseek-chat",
                    credential_ref: "deepseek:v2",
                    source: "curated",
                    availability: "catalog",
                    catalog_available: true,
                },
            ],
            catalogs: [],
        });
    });

    it("creates only after the user confirms one exact governed route", async () => {
        const user = userEvent.setup();
        render(
            <ChatHistoryProvider>
                <Harness />
            </ChatHistoryProvider>,
        );

        await user.click(screen.getByRole("button", { name: "New chat" }));
        expect(createChatMock).not.toHaveBeenCalled();

        const select = await screen.findByRole("combobox", {
            name: "Model route",
        });
        await screen.findByRole("option", {
            name: /DeepSeek · deepseek-chat · deepseek:v2/,
        });
        await user.selectOptions(
            select,
            "deepseek|deepseek-chat|deepseek:v2",
        );
        await user.click(
            screen.getByRole("button", { name: "Start conversation" }),
        );

        expect(createChatMock).toHaveBeenCalledWith({
            project_id: "project-1",
            route: {
                provider: "deepseek",
                model: "deepseek-chat",
                credential_ref: "deepseek:v2",
            },
        });
    });
});
