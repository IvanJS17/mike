import { readFile } from "fs/promises";
import { contentTypeForDocumentType } from "./documentTypes";
import { MX_CIVIL_COMMERCIAL_SYNC_ENTRY } from "./recovery/workflows/mxCivilCommercialPlaybook";
import { storageEnabled, uploadFile } from "./storage";
import type { createServerSupabase } from "./supabase";
import {
  prepareWorkflowCatalog,
  removePreparedWorkflowCatalog,
  validateWorkflowCatalogDocument,
  type WorkflowCatalogSourceOptions,
  type WorkflowCatalogSourceWorkflow,
} from "./workflowCatalogSource";

type Db = ReturnType<typeof createServerSupabase>;

export type WorkflowCatalogSyncResult = {
  workflows: number;
  references: number;
  /** Upstream import commit; owned entries retain their own source commits. */
  sourceCommit: string;
};

function metadataWithoutTemporaryReferences(
  workflow: WorkflowCatalogSourceWorkflow,
  referenceFiles: Array<{
    filename: string;
    file_type: string;
    storage_path: string;
    size_bytes: number;
    content_hash: string;
  }>,
) {
  const { reference_files: _references, ...metadata } = workflow;
  return { ...metadata, reference_files: referenceFiles };
}

export async function syncWorkflowCatalog(
  db: Db,
  options: WorkflowCatalogSourceOptions = {},
): Promise<WorkflowCatalogSyncResult> {
  const prepared = await prepareWorkflowCatalog(options);
  try {
    const document = validateWorkflowCatalogDocument(
      JSON.parse(await readFile(prepared.catalogPath, "utf8")) as unknown,
    );
    if (
      document.workflows.some(
        (workflow) =>
          workflow.workflow_key === MX_CIVIL_COMMERCIAL_SYNC_ENTRY.workflow_key,
      )
    ) {
      throw new Error(
        `Upstream catalog collides with reserved workflow key '${MX_CIVIL_COMMERCIAL_SYNC_ENTRY.workflow_key}'`,
      );
    }
    let references = 0;
    const databaseWorkflows: Array<
      | (ReturnType<typeof metadataWithoutTemporaryReferences> & {
          source: string;
          approval_provenance: string;
        })
      | typeof MX_CIVIL_COMMERCIAL_SYNC_ENTRY
    > = [];
    const hasReferences = document.workflows.some(
      (workflow) => workflow.reference_files.length > 0,
    );
    if (hasReferences && !storageEnabled) {
      throw new Error(
        "Workflow reference files require configured S3-compatible storage",
      );
    }

    for (const workflow of document.workflows) {
      const databaseReferences = [];
      for (const reference of workflow.reference_files) {
        if (storageEnabled) {
          const storagePath =
            `mike-workflows/${workflow.workflow_key}/` +
            `${reference.content_hash}/${reference.filename}`;
          const bytes = await readFile(reference.temporary_path);
          await uploadFile(
            storagePath,
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
            contentTypeForDocumentType(reference.file_type),
          );
          databaseReferences.push({
            filename: reference.filename,
            file_type: reference.file_type,
            storage_path: storagePath,
            size_bytes: reference.size_bytes,
            content_hash: reference.content_hash,
          });
          references += 1;
        }
      }
      databaseWorkflows.push({
        ...metadataWithoutTemporaryReferences(workflow, databaseReferences),
        source: `https://github.com/${document.source_repository}/tree/${document.source_commit}`,
        approval_provenance:
          "Upstream catalog import; LiTT legal validation pending",
      });
    }
    databaseWorkflows.push(MX_CIVIL_COMMERCIAL_SYNC_ENTRY);

    const { error } = await db.rpc("replace_mike_workflows", {
      p_source_commit: document.source_commit,
      p_workflows: databaseWorkflows,
    });
    if (error) throw error;

    return {
      workflows: databaseWorkflows.length,
      references,
      sourceCommit: document.source_commit,
    };
  } finally {
    await removePreparedWorkflowCatalog(prepared);
  }
}
