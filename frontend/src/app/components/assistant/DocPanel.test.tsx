import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocPanel, DocumentTitleRow } from "./DocPanel";

vi.mock("../shared/views/PdfView", () => ({
    PdfView: () => <div>PDF preview fixture</div>,
}));

describe("DocumentTitleRow", () => {
    it("uses the shared compact title row with a file-type icon", () => {
        const { container } = render(
            <DocumentTitleRow
                document={{
                    document_id: "document-1",
                    title: "agreement.docx",
                    type: "docx",
                    metadata: [],
                    quotes: [],
                    version_id: "version-1",
                    version_number: 1,
                }}
                isReloading={false}
                compactActions={false}
            />,
        );

        const title = screen.getByRole("heading", {
            name: "agreement.docx",
        });
        expect(title).toHaveClass("text-sm", "font-medium");
        expect(title).not.toHaveClass("font-serif");
        expect(
            container.querySelector('img[src*="/icons/file-types/word.svg"]'),
        ).toBeInTheDocument();
    });

    it("uses pill-height source actions when the side panel is minimized", () => {
        render(
            <DocumentTitleRow
                document={{
                    document_id: "document-123",
                    title: "agreement.pdf",
                    type: "pdf",
                    metadata: [],
                    quotes: [],
                    actions: [
                        {
                            type: "download",
                            url: "https://example.invalid/agreement.pdf",
                            label: "Download",
                        },
                        {
                            type: "link",
                            url: "https://example.com/source",
                            label: "Source",
                        },
                    ],
                }}
                isReloading={false}
                compactActions
            />,
        );

        expect(screen.getByRole("link", { name: "Download" })).toHaveClass(
            "h-6",
            "w-6",
        );
        expect(screen.getByRole("link", { name: "Source" })).toHaveClass(
            "h-6",
            "w-6",
        );
    });
});

describe("uploaded document metadata", () => {
    it("uses the same title row for normalized metadata and actions", () => {
        const { container } = render(
            <DocPanel
                compactActions={false}
                mode={{ kind: "document" }}
                document={{
                    document_id: "document-123",
                    title: "agreement.pdf",
                    type: "pdf",
                    metadata: [
                        {
                            label: "Date",
                            value: "2024-01-02",
                            format: "date",
                        },
                    ],
                    actions: [
                        {
                            type: "download",
                            url: "https://example.invalid/agreement.pdf",
                            label: "Download",
                        },
                        {
                            type: "link",
                            url: "https://example.com/source",
                            label: "Link",
                        },
                    ],
                    quotes: [],
                }}
            />,
        );

        const title = screen.getByRole("heading", {
            name: "agreement.pdf",
        });
        expect(title).toHaveClass("text-sm", "font-medium");
        expect(title).not.toHaveClass("font-serif");

        const metadata = screen.getByText("Date: January 2, 2024");
        expect(metadata.parentElement).toHaveClass("w-full");
        expect(metadata.parentElement).not.toBe(title.parentElement);

        expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
            "href",
            "https://example.invalid/agreement.pdf",
        );
        expect(screen.getByRole("link", { name: "Link" })).toHaveAttribute(
            "href",
            "https://example.com/source",
        );
        expect(
            container.querySelector(
                'img[src*="/icons/file-types/pdf.svg"]',
            ),
        ).toHaveClass("h-4", "w-4");
        expect(screen.getByText("PDF preview fixture")).toBeInTheDocument();
    });
});
