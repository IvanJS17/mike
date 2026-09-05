import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect, type Addin } from "./support/fixtures";
import { canonicalApprovedRedlineJson as canonical } from "../src/taskpane/lib/approvedRedline";

const text = "Alpha clause. Beta clause.";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const execution = {
  id: "execution-1", project_id: "project-1", matter_id: "matter-1",
  document_id: "document-1", document_version_id: "version-1",
  document_content_sha256: sha("synthetic-docx"), status: "succeeded",
  error_class: null, created_at: "2026-09-05", started_at: null, finished_at: null,
};
const review = {
  organization_id: "org-1", matter_id: execution.matter_id,
  project_id: execution.project_id, document_id: execution.document_id,
  document_version_id: execution.document_version_id,
  document_content_sha256: execution.document_content_sha256,
  review_id: "review-1", revision: 1, execution_id: execution.id,
  status: "approved", execution_author_user_id: "author-1",
  reviewer_user_id: "reviewer-1", evidence_receipt_sha256: sha("receipt"), items: [],
};
function bundle(patch: Record<string, unknown> = {}, spans = [[0, 13], [14, 26]]) {
  const actions = spans.map(([start, end], index) => ({
    action_id: `action-${index + 1}`, review_item_id: `item-${index}`,
    citation_id: `citation-${index}`, document_id: execution.document_id,
    document_version_id: execution.document_version_id, page: 1, start, end,
    page_content_sha256: sha(text), before_text_sha256: sha(text.slice(start, end)),
    replacement_text_sha256: sha(`Replacement ${index + 1}`),
    replacement_text: `Replacement ${index + 1}`,
  }));
  const body = {
    bundle_version: "approved-redline-v1", revision: 1,
    review_id: review.review_id, review_revision: review.revision,
    execution_id: execution.id, organization_id: review.organization_id,
    matter_id: review.matter_id, project_id: review.project_id,
    document_id: review.document_id, document_version_id: review.document_version_id,
    source_document_sha256: review.document_content_sha256,
    evidence_receipt_version: "evidence-v1", evidence_receipt_sha256: review.evidence_receipt_sha256,
    reviewer_user_id: review.reviewer_user_id,
    ...patch,
    actions: actions.map(({ replacement_text: _text, ...identity }) => identity),
  };
  const canonical_json = canonical(body);
  return { ...body, actions, canonical_json, bundle_sha256: sha(canonical_json) };
}
const scopeUrl = "**/projects/project-1/ai-executions/execution-1/review";
const bundleUrl = `${scopeUrl}/redline-bundle?revision=1`;

async function setup(addin: Addin, page: Page, documentText = text) {
  addin.seedToken("synthetic-session");
  // Augment only this spec; the shared Office fixture remains frozen.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const host = window as any;
      host.__SNAPSHOT_FAILURE__ = false;
      host.__SNAPSHOT_BYTES__ = "synthetic-docx";
      host.Office.FileType = { Compressed: "compressed" };
      host.Office.context.document.getFileAsync = (_type: unknown, _options: unknown, callback: any) => {
        if (host.__SNAPSHOT_FAILURE__) return callback({ status: "failed" });
        const bytes = Array.from(new TextEncoder().encode(host.__SNAPSHOT_BYTES__));
        callback({ status: host.Office.AsyncResultStatus.Succeeded, value: {
          sliceCount: 1,
          getSliceAsync: (index: number, done: any) => done({
            status: host.Office.AsyncResultStatus.Succeeded, value: { index, data: bytes },
          }),
          closeAsync: (done?: any) => done?.({ status: host.Office.AsyncResultStatus.Succeeded }),
        } });
      };
    });
  });
  await addin.mockApiJson("GET", "**/projects?*", [{ id: "project-1", name: "Synthetic matter" }, { id: "project-2", name: "Other matter" }]);
  await addin.mockApiJson("GET", "**/projects/project-1/ai-executions", [execution, { ...execution, id: "failed-1", status: "failed" }]);
  await addin.mockApiJson("GET", "**/projects/project-2/ai-executions", []);
  await addin.mockApiJson("GET", scopeUrl, review);
  await addin.mockApiJson("GET", bundleUrl, bundle());
  await addin.gotoTaskpane({ documentText });
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Approved redlines" }).click();
  await page.getByLabel("Project", { exact: true }).selectOption("project-1");
}
async function load(page: Page) {
  await page.getByLabel("Execution", { exact: true }).selectOption("execution-1");
}
async function zeroWrites(addin: Addin) {
  const calls = await addin.wordCalls();
  expect(calls.inserts).toEqual([]);
  expect(calls.trackedChanges).toEqual([]);
  expect(calls.acceptedChanges).toEqual([]);
  expect(calls.rejectedChanges).toEqual([]);
}
async function blocked(page: Page, addin: Addin) {
  await expect(page.getByRole("alert")).toContainText(/cannot|could not|stopped/i);
  await expect(page.getByRole("button", { name: /^Apply / })).toHaveCount(0);
  await zeroWrites(addin);
}
async function saveAs(page: Page) {
  await page.evaluate(() => { (window as any).Office.context.document.url = "C:/copy.docx"; });
}

test("happy load and descending single-action gating", async ({ addin, page }) => {
  await setup(addin, page);
  await expect(page.getByLabel("Execution", { exact: true }).locator("option[value='failed-1']")).toHaveCount(0);
  await load(page);
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Beta clause.");
  await expect(cards.first()).toContainText("Page 1");
  await expect(cards.first()).toContainText("Replacement 2");
  await expect(page.getByRole("button", { name: "Apply action-2", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Apply action-1", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Apply All", exact: true })).toHaveCount(0);
  await zeroWrites(addin);
  await page.getByRole("button", { name: "Apply action-2", exact: true }).click();
  await expect(cards.first()).toContainText("Applied");
  await expect(page.getByRole("button", { name: "Apply action-1", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Apply action-1", exact: true }).click();
  await expect(cards.nth(1)).toContainText("Applied");
  const calls = await addin.wordCalls();
  expect(calls.trackedChanges.map((call) => call.original)).toEqual(["Beta clause.", "Alpha clause."]);
});

for (const field of ["project_id", "matter_id", "execution_id", "document_id", "document_version_id", "document_content_sha256"]) {
  test(`rejects cross-scope review ${field}`, async ({ addin, page }) => {
    await setup(addin, page);
    await addin.mockApiJson("GET", scopeUrl, { ...review, [field]: field.endsWith("sha256") ? sha("other") : "other" });
    await load(page);
    await blocked(page, addin);
  });
}
for (const failure of ["tamper", "scope", "source", "revision", "span", "overlap", "ambiguity", "pending", "API", "snapshot", "binary hash"]) {
  test(`load fails closed: ${failure}`, async ({ addin, page }) => {
    await setup(addin, page, failure === "ambiguity" ? `${text} Alpha clause.` : text);
    if (failure === "tamper") {
      const value = bundle(); value.actions[0]!.replacement_text = "tampered";
      await addin.mockApiJson("GET", bundleUrl, value);
    }
    if (failure === "scope") await addin.mockApiJson("GET", bundleUrl, bundle({ matter_id: "other" }));
    if (failure === "source") await addin.mockApiJson("GET", bundleUrl, bundle({ source_document_sha256: sha("other") }));
    if (failure === "revision") await addin.mockApiJson("GET", bundleUrl, bundle({ revision: 2 }));
    if (failure === "span") await addin.mockApiJson("GET", bundleUrl, bundle({}, [[0, 100]]));
    if (failure === "overlap") await addin.mockApiJson("GET", bundleUrl, bundle({}, [[0, 13], [7, 20]]));
    if (failure === "pending") await addin.mockApiJson("GET", scopeUrl, { ...review, status: "pending" });
    if (failure === "API") await addin.mockApiError("GET", bundleUrl, 403, "secret internal error");
    if (failure === "snapshot") await page.evaluate(() => { (window as any).__SNAPSHOT_FAILURE__ = true; });
    if (failure === "binary hash") await page.evaluate(() => { (window as any).__SNAPSHOT_BYTES__ = "other"; });
    await load(page);
    await blocked(page, addin);
    await expect(page.getByText("secret internal error")).toHaveCount(0);
  });
}

test("Save-As during asynchronous load", async ({ addin, page }) => {
  await setup(addin, page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(bundleUrl, async (route) => { await gate; await route.fulfill({ json: bundle() }); });
  const request = page.waitForRequest((request) => request.url().includes("redline-bundle"));
  await load(page); await request; await saveAs(page); release();
  await blocked(page, addin);
});

for (const failure of ["Save-As", "review revision", "review status", "bundle replacement", "API", "identity during fetch"]) {
  test(`before apply fails closed: ${failure}`, async ({ addin, page }) => {
    await setup(addin, page); await load(page);
    const apply = page.getByRole("button", { name: "Apply action-2", exact: true });
    await expect(apply).toBeEnabled();
    if (failure === "Save-As") await saveAs(page);
    if (failure === "review revision") await addin.mockApiJson("GET", scopeUrl, { ...review, revision: 2 });
    if (failure === "review status") await addin.mockApiJson("GET", scopeUrl, { ...review, status: "changes_requested" });
    if (failure === "bundle replacement") {
      const value = bundle(); value.actions[1]!.replacement_text = "changed without hash update";
      await addin.mockApiJson("GET", bundleUrl, value);
    }
    if (failure === "API") await addin.mockApiError("GET", scopeUrl, 404);
    if (failure === "identity during fetch") await page.route(bundleUrl, async (route) => {
      await saveAs(page); await route.fulfill({ json: bundle() });
    });
    await apply.click(); await blocked(page, addin);
    await expect(page.getByRole("alert")).toContainText("prior Word revisions remain reviewable");
  });
}

test("selection change discards an asynchronous load", async ({ addin, page }) => {
  await setup(addin, page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(bundleUrl, async (route) => { await gate; await route.fulfill({ json: bundle() }); });
  const request = page.waitForRequest((request) => request.url().includes("redline-bundle"));
  await load(page); await request;
  await page.getByLabel("Project", { exact: true }).selectOption("project-2");
  release();
  await expect(page.getByText("No succeeded executions available.")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await zeroWrites(addin);
});
