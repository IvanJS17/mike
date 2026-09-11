import { describe, expect, it } from "vitest";
import { safeFilePart } from "./rawStreamLog";

describe("safeFilePart", () => {
    it("normalizes invalid runs and trims both filename boundaries", () => {
        expect(safeFilePart("---provider---")).toBe("provider");
        expect(safeFilePart("provider---model")).toBe("provider---model");
        expect(safeFilePart("////")).toBe("");
    });
});
