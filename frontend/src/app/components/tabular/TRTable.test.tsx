import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TRTable } from "./TRTable";
import type { TableRow } from "./TRTable";
import type { ColumnConfig, Document, TabularCell } from "../shared/types";

const doc = { id: "doc-1", filename: "report.pdf" } as Document;

const documentRow: TableRow = {
    id: "row-1",
    label: "report.pdf",
    documentId: "doc-1",
    rowId: "row-1",
    rowType: "document",
};

function renderTable(overrides?: {
    rows?: TableRow[];
    documents?: Document[];
    columns?: ColumnConfig[];
    cells?: TabularCell[];
}) {
    return render(
        <TRTable
            loading={false}
            columns={overrides?.columns ?? []}
            documents={overrides?.documents ?? [doc]}
            rows={overrides?.rows ?? [documentRow]}
            cells={overrides?.cells ?? []}
            savingColumn={false}
            savingColumnsConfig={false}
            selectedDocIds={[]}
            onSelectionChange={vi.fn()}
            onExpand={vi.fn()}
            onCitationClick={vi.fn()}
            onUpdateColumn={vi.fn()}
            onDeleteColumn={vi.fn()}
            onAddColumn={vi.fn()}
            onAddDocuments={vi.fn()}
        />,
    );
}

describe("TRTable", () => {
    // The grid here is div-based (no table/columnheader/rowheader roles), so
    // this asserts on rendered content rather than ARIA table semantics.
    it("renders the Document header and a row for each document", () => {
        renderTable();
        expect(screen.getByText("Document")).toBeInTheDocument();
        expect(screen.getByText("report.pdf")).toBeInTheDocument();
        // One select-all checkbox in the header plus one per document row.
        expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    });

    it("renders folder rows and matches their cells by row_id", () => {
        const folderRow: TableRow = {
            id: "row-folder",
            label: "Contracts",
            documentId: null,
            rowId: "row-folder",
            rowType: "folder",
        };
        const columns: ColumnConfig[] = [
            { index: 0, name: "Party", prompt: "p" } as ColumnConfig,
        ];
        // A folder cell carries a row_id and NO document_id — it must still
        // render because the table matches cells to rows by row_id.
        const folderCell = {
            id: "cell-folder",
            review_id: "r1",
            row_id: "row-folder",
            document_id: null,
            column_index: 0,
            content: { summary: "Acme Corp" },
            status: "done",
            created_at: "now",
        } as TabularCell;

        renderTable({
            rows: [folderRow],
            documents: [doc],
            columns,
            cells: [folderCell],
        });

        expect(screen.getByText("Contracts")).toBeInTheDocument();
        expect(screen.getByText("Acme Corp")).toBeInTheDocument();
        // A folder row has no single document, so only the header select-all
        // checkbox is present — no per-row checkbox for the folder row.
        expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    });
});
