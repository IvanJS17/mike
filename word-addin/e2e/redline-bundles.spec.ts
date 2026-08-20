import { createHash } from "node:crypto";
import { test, expect } from "./support/fixtures";
import type { Addin } from "./support/fixtures";

const TOKEN = "test-jwt";
const DOCX_SHA256 =
  "adef4eeb365871c7d8ae7b7cbeb087585a80d586946c610ed824a42d88e65a79";
const DOCUMENT = "Source A. Source B.";

const EXECUTION = {
  id: "execution-1",
  status: "succeeded" as const,
  error_class: null,
  matter_id: "matter-1",
  project_id: "project-1",
  document_id: "document-1",
  document_version_id: "source-version-1",
  document_content_sha256: DOCX_SHA256,
  created_at: "2026-08-19T12:00:00.000Z",
  started_at: "2026-08-19T12:00:01.000Z",
  finished_at: "2026-08-19T12:01:00.000Z",
  output_id: "output-1",
  receipt_id: "receipt-1",
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function action(
  actionId: string,
  original: string,
  replacement: string,
  extra: Record<string, unknown> = {}
) {
  return {
    action_id: actionId,
    item_id: `${actionId}-item`,
    review_item_id: `${actionId}-item`,
    citation_id: `${actionId}-citation`,
    source_document_version_id: "source-version-1",
    page: 1,
    start: 0,
    end: original.length,
    before_text_sha256: sha256(original),
    replacement_text: replacement,
    reviewer_user_id: "reviewer-1",
    timestamp: "2026-08-19T12:05:00.000Z",
    ...extra,
  };
}

function makeBundle(
  actions: Record<string, unknown>[],
  overrides: Record<string, unknown> = {}
) {
  const canonical = {
    bundle_version: "beta-0.1",
    revision: 1,
    matter_id: "matter-1",
    review_id: "review-1",
    execution_id: "execution-1",
    source_document_version_id: "source-version-1",
    source_document_sha256: DOCX_SHA256,
    receipt_id: "receipt-1",
    receipt_version: "beta-0.1",
    receipt_sha256: "b".repeat(64),
    actions,
  };
  return {
    id: "bundle-1",
    bundle_version: "beta-0.1",
    revision: 1,
    review_id: "review-1",
    execution_id: "execution-1",
    matter_id: "matter-1",
    project_id: "project-1",
    source_document_version_id: "source-version-1",
    source_document_sha256: DOCX_SHA256,
    receipt_id: "receipt-1",
    receipt_sha256: "b".repeat(64),
    actions_count: actions.length,
    bundle_sha256: sha256(canonicalJson(canonical)),
    canonical_json: canonical,
    actor_user_id: "reviewer-1",
    created_at: "2026-08-19T12:06:00.000Z",
    ...overrides,
  };
}

async function gotoActions(addin: Addin): Promise<void> {
  await addin.gotoTaskpane({ token: TOKEN, documentText: DOCUMENT });
  await addin.expectAuthedShell();
  await addin.page.getByRole("tab", { name: "Actions" }).click();
  await expect(
    addin.page.getByRole("button", { name: "Load approved redlines" })
  ).toBeVisible();
}

async function mockExecutionPicker(
  addin: Addin,
  bundle: unknown,
  opts: { bundleStatus?: number } = {}
): Promise<void> {
  await addin.mockApiJson("GET", "**/projects", [
    { id: "project-1", name: "Matter project" },
  ]);
  await addin.mockApiJson(
    "GET",
    "**/projects/project-1/ai-executions",
    [EXECUTION]
  );
  await addin.mockApiJson(
    "GET",
    "**/projects/project-1/ai-executions/execution-1/review/redline-bundle**",
    bundle,
    opts.bundleStatus ? { status: opts.bundleStatus } : undefined
  );
}

async function openSelectedBundle(addin: Addin): Promise<void> {
  const page = addin.page;
  await page.getByRole("button", { name: "Load approved redlines" }).click();
  await expect(page.getByLabel("Approved execution")).toBeVisible();
  await page.getByRole("button", { name: "Open approved bundle" }).click();
}

test.describe("approved redline bundles", () => {
  test("opens a verified bundle and applies or omits each action once", async ({
    addin,
    page,
  }) => {
    const bundle = makeBundle([
      action("action-a", "Source A.", "Reviewed A."),
      action("action-b", "Source B.", "Reviewed B."),
    ]);
    await mockExecutionPicker(addin, bundle);
    await gotoActions(addin);
    await openSelectedBundle(addin);

    await expect(page.getByText("2 approved redline actions")).toBeVisible();
    await expect(page.getByText("Source A.")).toBeVisible();
    await expect(page.getByText("Reviewed A.")).toBeVisible();
    await expect(page.getByText("Source B.")).toBeVisible();

    const applyFirst = page.getByRole("button", { name: "Apply change 1" });
    await applyFirst.click();
    await expect(applyFirst).toBeDisabled();
    await page.getByRole("button", { name: "Omit change 2" }).click();

    await expect(
      page.getByRole("status", { name: "Redline bundle status" })
    ).toHaveText("Applied 1, omitted 1, failed 0, pending 0.");
    const calls = await addin.wordCalls();
    expect(calls.trackedChanges).toEqual([
      { text: "Reviewed A.", location: "Replace", original: "Source A." },
    ]);
    expect(calls.inserts).toEqual([]);
    expect(calls.changeTrackingMode).toBe("TrackAll");
  });

  test("fails closed when the before-text span does not match", async ({
    addin,
    page,
  }) => {
    const bundle = makeBundle([
      action("action-a", "Source A.", "Reviewed A."),
    ]);
    await mockExecutionPicker(addin, bundle);
    await gotoActions(addin);
    await addin.setDocumentText("Changed text only.");
    await openSelectedBundle(addin);

    await expect(
      page.getByRole("alert").filter({ hasText: /could not be verif|ambiguous/i })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply change 1" })).toHaveCount(0);
    expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  });

  test("fails closed when the bundle hash is tampered", async ({ addin, page }) => {
    const bundle = makeBundle(
      [action("action-a", "Source A.", "Reviewed A.")],
      { bundle_sha256: "0".repeat(64) }
    );
    await mockExecutionPicker(addin, bundle);
    await gotoActions(addin);
    await openSelectedBundle(addin);

    await expect(
      page.getByRole("alert").filter({ hasText: /integrity|tamper/i })
    ).toBeVisible();
    expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  });

  test("does not apply a revoked bundle", async ({ addin, page }) => {
    await mockExecutionPicker(
      addin,
      {
        code: "authorization_revoked",
        detail: "Matter authorization changed; redline bundle was not read",
      },
      { bundleStatus: 403 }
    );
    await gotoActions(addin);
    await openSelectedBundle(addin);

    await expect(
      page.getByRole("alert").filter({ hasText: /authorization changed/i })
    ).toBeVisible();
    expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  });

  test("does not duplicate a change when the before text occurs twice", async ({
    addin,
    page,
  }) => {
    const bundle = makeBundle([
      action("action-a", "Source A.", "Reviewed A."),
    ]);
    await mockExecutionPicker(addin, bundle);
    await gotoActions(addin);
    await addin.setDocumentText("Source A. Other. Source A.");
    await openSelectedBundle(addin);

    await expect(
      page.getByRole("alert").filter({ hasText: /could not be verif|ambiguous/i })
    ).toBeVisible();
    expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  });

  test("never renders rejected actions from a bundle", async ({ addin, page }) => {
    const bundle = makeBundle([
      action("action-accepted", "Source A.", "Reviewed A."),
      action("action-rejected", "Source B.", "Forbidden replacement", {
        status: "rejected",
      }),
    ]);
    await mockExecutionPicker(addin, bundle);
    await gotoActions(addin);
    await openSelectedBundle(addin);

    await expect(page.getByText("1 approved redline action")).toBeVisible();
    await expect(page.getByText("Forbidden replacement")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Apply change 2" })).toHaveCount(0);
  });
});
