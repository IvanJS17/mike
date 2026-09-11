import { describe, expect, it } from "vitest";
import { convertDocxHtmlToMarkdown } from "./tabular";

describe("convertDocxHtmlToMarkdown", () => {
    it("preserves documents beyond the converter default input limit", () => {
        const text = "A".repeat(16_777_216) + "tail-sentinel";
        const converted = convertDocxHtmlToMarkdown(`<p>${text}</p>`);
        expect(converted.length).toBe(text.length);
        expect(converted.endsWith("tail-sentinel")).toBe(true);
    });
    it("preserves document structure while decoding entities once", () => {
        expect(
            convertDocxHtmlToMarkdown(
                "<h2>Heading</h2><p><strong>Bold</strong> &amp; &lt;safe&gt;</p><ul><li>Item</li></ul>",
            ),
        ).toBe("## Heading\n\n**Bold** & <safe>\n\n- Item");
    });

    it("does not turn encoded markup into a second HTML parse", () => {
        expect(convertDocxHtmlToMarkdown("<p>&amp;lt;script&amp;gt;</p>")).toBe(
            "&lt;script&gt;",
        );
    });
});
