import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalApprovedRedlineJson,
  prepareApprovedRedline,
  ApprovedRedlineValidationError,
} from "../src/taskpane/lib/approvedRedline.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const DOC = "Alpha clause. Beta clause.";
const DOC_SHA = sha("docx-current");
const scope = {
  organization_id: "org-1",
  matter_id: "matter-1",
  project_id: "project-1",
  document_id: "document-1",
  document_version_id: "version-1",
  source_document_sha256: DOC_SHA,
  document_identity: "word-identity-1",
};

function identityAction(id, start, end, replacement = "Alpha provision.") {
  return {
    action_id: id,
    review_item_id: `${id}-item`,
    citation_id: `${id}-citation`,
    document_id: scope.document_id,
    document_version_id: scope.document_version_id,
    page: 1,
    start,
    end,
    page_content_sha256: sha(DOC),
    before_text_sha256: sha(DOC.slice(start, end)),
    replacement_text_sha256: sha(replacement),
  };
}

function makeBundle(overrides = {}) {
  const canonicalAction = identityAction("action-1", 0, 13);
  const fullAction = {
    ...canonicalAction,
    replacement_text: "Alpha provision.",
  };
  const canonicalBody = {
    bundle_version: "approved-redline-v1",
    revision: 3,
    review_id: "review-1",
    review_revision: 7,
    execution_id: "execution-1",
    organization_id: scope.organization_id,
    matter_id: scope.matter_id,
    project_id: scope.project_id,
    document_id: scope.document_id,
    document_version_id: scope.document_version_id,
    source_document_sha256: scope.source_document_sha256,
    evidence_receipt_version: "evidence-v1",
    evidence_receipt_sha256: "e".repeat(64),
    reviewer_user_id: "reviewer-1",
    actions: [canonicalAction],
  };
  const bundle = {
    ...canonicalBody,
    actions: [fullAction],
    canonical_json: canonicalApprovedRedlineJson(canonicalBody),
    bundle_sha256: sha(canonicalApprovedRedlineJson(canonicalBody)),
  };
  return {
    bundle,
    input: {
      bundle,
      expected: {
        execution_id: "execution-1",
        review_id: "review-1",
        review_revision: 7,
        organization_id: scope.organization_id,
        matter_id: scope.matter_id,
        project_id: scope.project_id,
        document_id: scope.document_id,
        document_version_id: scope.document_version_id,
        source_document_sha256: DOC_SHA,
        document_identity: scope.document_identity,
        document_sha256: DOC_SHA,
      },
      current: { ...scope, document_sha256: DOC_SHA, text: DOC },
    },
  };
}

async function rejects(input, code) {
  await assert.rejects(
    prepareApprovedRedline(input),
    (error) =>
      error instanceof ApprovedRedlineValidationError && error.code === code,
  );
}

test("prepares a valid immutable approved redline", async () => {
  const { input } = makeBundle();
  const prepared = await prepareApprovedRedline(input);
  assert.equal(prepared.actions[0].original, "Alpha clause.");
  assert.equal(prepared.actions[0].replacement, "Alpha provision.");
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.actions));
  assert.ok(Object.isFrozen(prepared.actions[0]));
  assert.throws(() => {
    prepared.actions[0].replacement = "evil";
  }, TypeError);
  assert.equal(input.bundle.canonical_json.includes("Alpha provision."), false);
});

test("does not hash every document offset after a direct unique span match", async (t) => {
  const fixture = makeBundle();
  fixture.input.current.text = `${DOC}${" z".repeat(100)}`;
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let digestCalls = 0;
  t.mock.method(globalThis.crypto.subtle, "digest", (...args) => {
    digestCalls += 1;
    return digest(...args);
  });

  await prepareApprovedRedline(fixture.input);
  assert.ok(
    digestCalls <= 4,
    `expected constant digest work, got ${digestCalls}`,
  );
});

test("rejects tampered canonical, bundle, replacement, and extra keys", async () => {
  const cases = [
    (i) => ({ ...i, bundle: { ...i.bundle, canonical_json: "{}" } }),
    (i) => ({ ...i, bundle: { ...i.bundle, bundle_sha256: "0".repeat(64) } }),
    (i) => ({
      ...i,
      bundle: {
        ...i.bundle,
        actions: [{ ...i.bundle.actions[0], replacement_text: "Nope" }],
      },
    }),
    (i) => ({ ...i, bundle: { ...i.bundle, unexpected: true } }),
  ];
  for (const mutate of cases)
    await rejects(mutate(makeBundle().input), "tampered");
});

test("rejects malformed canonical identities and evidence hashes", async () => {
  for (const patch of [
    { reviewer_user_id: "" },
    { evidence_receipt_sha256: "not-a-sha" },
  ]) {
    const fixture = makeBundle();
    const fullActions = fixture.input.bundle.actions;
    const canonicalBody = {
      ...fixture.input.bundle,
      ...patch,
      actions: fullActions.map(
        ({ replacement_text: _replacementText, ...canonicalAction }) =>
          canonicalAction,
      ),
    };
    delete canonicalBody.canonical_json;
    delete canonicalBody.bundle_sha256;
    const canonicalJson = canonicalApprovedRedlineJson(canonicalBody);
    fixture.input.bundle = {
      ...canonicalBody,
      actions: fullActions,
      canonical_json: canonicalJson,
      bundle_sha256: sha(canonicalJson),
    };
    await rejects(fixture.input, "tampered");
  }
});

test("rejects scope, Save-As, review supersession, and source drift", async () => {
  const { input } = makeBundle();
  await rejects(
    { ...input, expected: { ...input.expected, matter_id: "other" } },
    "scope-mismatch",
  );
  await rejects(
    { ...input, current: { ...input.current, document_identity: "save-as" } },
    "document-identity",
  );
  await rejects(
    { ...input, expected: { ...input.expected, review_revision: 6 } },
    "superseded",
  );
  await rejects(
    { ...input, current: { ...input.current, document_sha256: sha("other") } },
    "source-mismatch",
  );
  const missingIdentity = makeBundle().input;
  delete missingIdentity.expected.document_identity;
  delete missingIdentity.current.document_identity;
  await rejects(missingIdentity, "document-identity");
});

test("resolves a moved unique span by bounded hash search", async () => {
  const { input } = makeBundle();
  input.current.text = "Prefix. Alpha clause. Beta clause.";
  const prepared = await prepareApprovedRedline(input);
  assert.equal(prepared.actions[0].start, 8);
});

test("projects full actions in the canonical hashed order", async () => {
  const fixture = makeBundle();
  const first = fixture.input.bundle.actions[0];
  const secondIdentity = identityAction("action-2", 14, 26, "Beta provision.");
  const second = { ...secondIdentity, replacement_text: "Beta provision." };
  const { replacement_text: _firstReplacement, ...firstIdentity } = first;
  const canonicalBody = {
    ...fixture.input.bundle,
    actions: [firstIdentity, secondIdentity],
  };
  delete canonicalBody.canonical_json;
  delete canonicalBody.bundle_sha256;
  const canonicalJson = canonicalApprovedRedlineJson(canonicalBody);
  fixture.input.bundle = {
    ...canonicalBody,
    actions: [second, first],
    canonical_json: canonicalJson,
    bundle_sha256: sha(canonicalJson),
  };

  const prepared = await prepareApprovedRedline(fixture.input);
  assert.deepEqual(
    prepared.actions.map((action) => action.action_id),
    ["action-1", "action-2"],
  );
});

test("rejects duplicate occurrence ambiguity, overlap, duplicate IDs, and no actions", async () => {
  const base = makeBundle();
  const duplicate = {
    ...base.input,
    current: { ...base.input.current, text: "Alpha clause. Alpha clause." },
  };
  await rejects(duplicate, "ambiguous");
  const overlap = makeBundle();
  const second = identityAction("action-2", 7, 20, "x");
  const fullSecond = { ...second, replacement_text: "x" };
  const { replacement_text: _replacement, ...firstIdentity } =
    overlap.input.bundle.actions[0];
  const canonicalBody = {
    ...overlap.input.bundle,
    actions: [firstIdentity, second],
  };
  delete canonicalBody.canonical_json;
  delete canonicalBody.bundle_sha256;
  const canonicalJson = canonicalApprovedRedlineJson(canonicalBody);
  overlap.input.bundle = {
    ...canonicalBody,
    actions: [overlap.input.bundle.actions[0], fullSecond],
    canonical_json: canonicalJson,
    bundle_sha256: sha(canonicalJson),
  };
  await rejects(overlap.input, "overlap");
  const dupId = makeBundle();
  dupId.input.bundle = {
    ...dupId.input.bundle,
    actions: [dupId.input.bundle.actions[0], dupId.input.bundle.actions[0]],
  };
  await rejects(dupId.input, "tampered");
  const none = makeBundle();
  const emptyCanonical = { ...none.input.bundle, actions: [] };
  delete emptyCanonical.canonical_json;
  delete emptyCanonical.bundle_sha256;
  const emptyJson = canonicalApprovedRedlineJson(emptyCanonical);
  none.input.bundle = {
    ...emptyCanonical,
    actions: [],
    canonical_json: emptyJson,
    bundle_sha256: sha(emptyJson),
  };
  await rejects(none.input, "no-actions");
});

test("canonical JSON is locale-independent and getters are snapshotted once", async () => {
  const { input } = makeBundle();
  const canonical = canonicalApprovedRedlineJson({
    z: "é",
    a: "I",
    nested: { b: 2, a: 1 },
  });
  assert.equal(canonical, '{"a":"I","nested":{"a":1,"b":2},"z":"é"}');
  let reads = 0;
  const hostile = {
    ...input,
    get bundle() {
      reads += 1;
      return input.bundle;
    },
  };
  await prepareApprovedRedline(hostile);
  assert.equal(reads, 1);
});
