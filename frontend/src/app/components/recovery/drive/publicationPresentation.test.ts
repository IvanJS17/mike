import { describe, expect, it } from "vitest";
import { parsePublicationWrite, canPublishReview, parsePublicationReview, parsePublicationStatus, stablePublicationIdempotencyKey } from "./publicationPresentation";

const review = { review_id: "00000000-0000-4000-8000-000000000001", revision: 2, execution_id: "execution-1", reviewer_user_id: "reviewer", execution_author_user_id: "author", project_id: "project-1", matter_id: "matter-1", organization_id: "org-1", document_id: "doc-1", document_version_id: "version-1", document_content_sha256: "a".repeat(64), evidence_receipt_sha256: "b".repeat(64), status: "approved", items: [{ item_id: "item-1", item_key: "finding", finding_text: "Finding", status: "accepted" }] };
const status = { publication_id: "00000000-0000-4000-8000-000000000002", export_id: "00000000-0000-4000-8000-000000000003", execution_id: "execution-1", review_revision: 2, revision: 1, outcome: "unknown_outcome", attempts: 1, approved_artifact_sha256: "c".repeat(64), provider_file_id: null, failure_code: "drive_upload_outcome_unknown" };

describe("approved publication presentation", () => {
  it("accepts only an approved, bound review and stable key", () => { const parsed = parsePublicationReview(review, "project-1", "matter-1", "execution-1"); expect(canPublishReview(parsed)).toBe(true); expect(stablePublicationIdempotencyKey(parsed!)).toBe("approved-report:00000000-0000-4000-8000-000000000001:2"); });
  it("refuses pending, malformed, and scope-mismatched values", () => { expect(canPublishReview(parsePublicationReview({ ...review, status: "pending" }, "project-1", "matter-1", "execution-1"))).toBe(false); expect(parsePublicationReview({ ...review, reviewer_user_id: "author" }, "project-1", "matter-1", "execution-1")).toBeNull(); expect(parsePublicationReview(review, "other", "matter-1", "execution-1")).toBeNull(); expect(parsePublicationReview(review, "project-1", "other", "execution-1")).toBeNull(); expect(parsePublicationStatus({ ...status, execution_id: "other" }, review as never)).toBeNull(); });
});

describe("server publication invariants", () => {
 const bound = () => parsePublicationReview(review,"project-1","matter-1","execution-1")!;
 it("preserves the validated failure code", () => { expect(parsePublicationStatus(status,bound())?.failure_code).toBe(status.failure_code); });
 it.each([
  {outcome:"uploaded",provider_file_id:null,failure_code:null},
  {outcome:"reconciled",provider_file_id:null,failure_code:null},
  {outcome:"uploaded",provider_file_id:"file",failure_code:"failed"},
  {outcome:"failed",provider_file_id:null,failure_code:null},
  {outcome:"pending",attempts:0},
 ])("rejects inconsistent status %j", delta => { expect(parsePublicationStatus({...status,...delta},bound())).toBeNull(); });
 it.each(["failed","unknown_outcome","reconciled"])("rejects uploaded with disposition %s", disposition => {
  const publication={...status,outcome:"uploaded",provider_file_id:"file",failure_code:null};
  expect(parsePublicationWrite({outcome:"uploaded",disposition,publication},bound())).toBeNull();
 });
});

it.each(["pending","uploaded","reconciled","unknown_outcome","failed"])("accepts valid %s and its replay", outcome => {
 const bound=parsePublicationReview(review,"project-1","matter-1","execution-1")!;
 const successful=outcome==="uploaded"||outcome==="reconciled";
 const publication={...status,outcome,provider_file_id:successful?"file":null,failure_code:successful?null:"synthetic_failure"};
 for(const disposition of [outcome==="pending"?"unknown_outcome":outcome,"replayed"])
  expect(parsePublicationWrite({outcome,disposition,publication},bound)?.publication).toEqual(publication);
});
