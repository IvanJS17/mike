// Existing E2a synthetic legacy seed, shared without changing its SQL.
export const IDS = {
  owner: "11111111-0000-0000-0000-000000000001",
  reviewer: "11111111-0000-0000-0000-000000000002",
  outsider: "11111111-0000-0000-0000-000000000003",
  org: "aaaaaaaa-0000-0000-0000-000000000001",
  workspace: "bbbbbbbb-0000-0000-0000-000000000001",
  matter: "cccccccc-0000-0000-0000-000000000001",
  project: "dddddddd-0000-0000-0000-000000000001",
  document: "eeeeeeee-0000-0000-0000-000000000001",
  version: "ffffffff-0000-0000-0000-000000000001",
  execution: "aaaaaaaa-0000-0000-0000-000000000002",
  blockedExecution: "aaaaaaaa-0000-0000-0000-000000000006",
  review: "bbbbbbbb-0000-0000-0000-000000000002",
  artifactDocument: "eeeeeeee-0000-0000-0000-000000000003",
  artifactVersion: "ffffffff-0000-0000-0000-000000000003",
  collisionArtifactDocument: "eeeeeeee-0000-0000-0000-000000000004",
  collisionArtifactVersion: "ffffffff-0000-0000-0000-000000000004",
} as const;

export const LEGACY_IDS = {
  artifactDocument: "eeeeeeee-0000-0000-0000-000000000002",
  artifactVersion: "ffffffff-0000-0000-0000-000000000002",
  execution: "aaaaaaaa-0000-0000-0000-000000000003",
  output: "aaaaaaaa-0000-0000-0000-000000000004",
  receipt: "aaaaaaaa-0000-0000-0000-000000000005",
  review: "bbbbbbbb-0000-0000-0000-000000000003",
  item: "bbbbbbbb-0000-0000-0000-000000000004",
  decision: "bbbbbbbb-0000-0000-0000-000000000005",
  export: "bbbbbbbb-0000-0000-0000-000000000006",
  bundle: "bbbbbbbb-0000-0000-0000-000000000007",
} as const;

export const SEED = `
insert into auth.users(id,email) values
 ('${IDS.owner}','owner@e2a.test'), ('${IDS.reviewer}','reviewer@e2a.test'), ('${IDS.outsider}','outsider@e2a.test');
insert into public.organizations(id,name,created_by) values ('${IDS.org}','E2a Org','${IDS.owner}');
insert into public.organization_memberships(organization_id,user_id,role,status) values
 ('${IDS.org}','${IDS.owner}','org_owner','active'), ('${IDS.org}','${IDS.reviewer}','editor','active');
insert into public.projects(id,user_id,name) values ('${IDS.project}','${IDS.owner}','E2a Project');
insert into public.workspaces(id,organization_id,name,created_by) values ('${IDS.workspace}','${IDS.org}','E2a Workspace','${IDS.owner}');
insert into public.workspace_memberships(workspace_id,user_id,role,status) values
 ('${IDS.workspace}','${IDS.owner}','workspace_admin','active'), ('${IDS.workspace}','${IDS.reviewer}','editor','active');
insert into public.matters(id,workspace_id,name,created_by,project_id,visibility) values
 ('${IDS.matter}','${IDS.workspace}','E2a Matter','${IDS.owner}','${IDS.project}','private');
insert into public.matter_memberships(matter_id,user_id,role,status) values
 ('${IDS.matter}','${IDS.owner}','matter_owner','active'), ('${IDS.matter}','${IDS.reviewer}','editor','active');
insert into public.documents(id,project_id,user_id,status) values ('${IDS.document}','${IDS.project}','${IDS.owner}','completed');
insert into public.document_versions(id,document_id,content_sha256,created_at) values
 ('${IDS.version}','${IDS.document}',repeat('a',64),now());
`;

export const BASELINE_LEGACY_SEED = SEED.replaceAll(
  "organization_memberships(organization_id,user_id,role,status)",
  "organization_memberships(organization_id,user_id,role)",
)
  .replaceAll(
    "workspace_memberships(workspace_id,user_id,role,status)",
    "workspace_memberships(workspace_id,user_id,role)",
  )
  .replaceAll(
    "matter_memberships(matter_id,user_id,role,status)",
    "matter_memberships(matter_id,user_id,role)",
  )
  .replaceAll(",'active'", "")
  .replace(",project_id,visibility", "")
  .replace(`,'${IDS.project}','private'`, "");

export const LEGACY_AI_SEED = `
insert into public.documents(id,project_id,user_id,status) values
 ('${LEGACY_IDS.artifactDocument}','${IDS.project}','${IDS.owner}','completed');
insert into public.document_versions(id,document_id,content_sha256,source,created_at) values
 ('${LEGACY_IDS.artifactVersion}','${LEGACY_IDS.artifactDocument}',repeat('e',64),'ai_review_report',now());
set session_replication_role = replica;
insert into public.ai_document_version_pages(
  document_id,document_version_id,page,content,content_sha256
) values (
  '${IDS.document}','${IDS.version}',2,'Legacy page',
  encode(digest('Legacy page','sha256'),'hex')
);
insert into public.ai_executions(
  id,user_id,matter_id,project_id,workflow_id,workflow_version,playbook_sha256,
  document_id,document_version_id,document_content_sha256,input_sha256,
  route_provider,route_model,credential_ref,status
) values (
  '${LEGACY_IDS.execution}','${IDS.owner}','${IDS.matter}','${IDS.project}',
  'legacy-workflow','1.0.0',repeat('b',64),'${IDS.document}','${IDS.version}',
  repeat('a',64),repeat('a',64),'openai','legacy-model','legacy-credential','succeeded'
);
insert into public.ai_output_versions(
  id,execution_id,output_format,output_text,output_sha256,citation_refs
) values (
  '${LEGACY_IDS.output}','${LEGACY_IDS.execution}','markdown','Legacy output',
  encode(digest('Legacy output','sha256'),'hex'),'[]'::jsonb
);
insert into public.ai_receipts(
  id,execution_id,receipt_version,canonical_json,receipt_sha256
) values (
  '${LEGACY_IDS.receipt}','${LEGACY_IDS.execution}','beta-0.1',
  '{"legacy":true}'::jsonb,repeat('c',64)
);
insert into public.ai_reviews(
  id,execution_id,matter_id,project_id,reviewer_user_id,status
) values (
  '${LEGACY_IDS.review}','${LEGACY_IDS.execution}','${IDS.matter}','${IDS.project}',
  '${IDS.reviewer}','approved'
);
insert into public.ai_review_items(
  id,review_id,item_key,original_text,finding_text,citation_refs,status
) values (
  '${LEGACY_IDS.item}','${LEGACY_IDS.review}','legacy-item','Legacy finding',
  'Legacy finding','[]'::jsonb,'accepted'
);
insert into public.ai_review_decisions(
  id,review_id,review_item_id,actor_user_id,decision,before_state,after_state
) values (
  '${LEGACY_IDS.decision}','${LEGACY_IDS.review}','${LEGACY_IDS.item}',
  '${IDS.reviewer}','accepted','{"status":"pending"}'::jsonb,
  '{"status":"accepted"}'::jsonb
);
insert into public.ai_review_exports(
  id,review_id,execution_id,matter_id,project_id,source_document_version_id,
  document_id,document_version_id,report_version,filename,content_sha256,actor_user_id
) values (
  '${LEGACY_IDS.export}','${LEGACY_IDS.review}','${LEGACY_IDS.execution}',
  '${IDS.matter}','${IDS.project}','${IDS.version}','${LEGACY_IDS.artifactDocument}',
  '${LEGACY_IDS.artifactVersion}',1,'Informe de revision humana.docx',repeat('e',64),
  '${IDS.reviewer}'
);
insert into public.ai_redline_bundles(
  id,bundle_version,revision,review_id,execution_id,matter_id,project_id,
  source_document_version_id,source_document_sha256,receipt_id,receipt_sha256,
  canonical_json,canonical_json_text,bundle_sha256,actions_count,actor_user_id
) values (
  '${LEGACY_IDS.bundle}','beta-0.1',1,'${LEGACY_IDS.review}','${LEGACY_IDS.execution}',
  '${IDS.matter}','${IDS.project}','${IDS.version}',repeat('a',64),
  '${LEGACY_IDS.receipt}',repeat('c',64),'{"actions":[{"legacy":true}]}'::jsonb,
  '{"actions":[{"legacy":true}]}',repeat('d',64),1,'${IDS.reviewer}'
);
set session_replication_role = origin;
`;
