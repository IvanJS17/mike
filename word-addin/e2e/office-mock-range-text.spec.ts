import { expect, test } from "@playwright/test";
import { installOfficeMock } from "./support/office-mock";

test("body search ranges expose their exact live text", async ({ page }) => {
  await page.route("https://appsforoffice.microsoft.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "/* office.js stubbed for focused mock test */",
    }),
  );
  await page.addInitScript(installOfficeMock, {
    documentText: "The old clause remains.",
  });
  await page.goto("/taskpane.html");

  const result = await page.evaluate(async () =>
    Word.run(async (context) => {
      const matches = context.document.body.search("old clause", {
        matchCase: true,
      });
      matches.load("items");
      await context.sync();
      const match = matches.items[0];
      if (!match) throw new Error("expected one mock search range");
      match.load("text");
      await context.sync();
      return match.text;
    }),
  );

  expect(result).toBe("old clause");
});
