import type { AtomicEvidenceAppendPort } from "../evidence/appendOnlyEvidence";
import type { ApprovedRedlineAppendPort } from "../review/approvedRedlineBundle";
import type { HumanReviewMutationPort } from "../review/humanReview";

export type AiPersistenceContext = Readonly<{
  actor_user_id: string;
  organization_id: string;
  authorization_epoch: number;
}>;

type RpcResponse = {
  data: unknown;
  error: unknown;
};

export type SupabaseRpcClient = {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<RpcResponse>;
};

const RPC_FAILURE = "AI persistence RPC failed";

function snapshotContext(context: AiPersistenceContext): AiPersistenceContext {
  return Object.freeze({
    actor_user_id: context.actor_user_id,
    organization_id: context.organization_id,
    authorization_epoch: context.authorization_epoch,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function callRpc(
  client: SupabaseRpcClient,
  functionName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let response: RpcResponse;
  try {
    response = await client.rpc(functionName, args);
  } catch {
    throw new Error(RPC_FAILURE);
  }

  if (
    !isRecord(response) ||
    !Object.prototype.hasOwnProperty.call(response, "data") ||
    !Object.prototype.hasOwnProperty.call(response, "error") ||
    response.error != null ||
    response.data == null ||
    (isRecord(response.data) &&
      Object.prototype.hasOwnProperty.call(response.data, "error"))
  ) {
    throw new Error(RPC_FAILURE);
  }

  return response.data;
}

function contextArgs(context: AiPersistenceContext) {
  return {
    p_actor_user_id: context.actor_user_id,
    p_organization_id: context.organization_id,
    p_authorization_epoch: context.authorization_epoch,
  };
}

export function createSupabaseAtomicEvidenceAppendPort(
  client: SupabaseRpcClient,
  context: AiPersistenceContext,
): AtomicEvidenceAppendPort {
  const boundContext = snapshotContext(context);
  return {
    append: (batch) =>
      callRpc(client, "append_ai_evidence_batch", {
        ...contextArgs(boundContext),
        p_batch: batch,
      }),
  };
}

export function createSupabaseHumanReviewMutationPort(
  client: SupabaseRpcClient,
  context: AiPersistenceContext,
): HumanReviewMutationPort {
  const boundContext = snapshotContext(context);
  return {
    create: (mutation) =>
      callRpc(client, "create_ai_review", {
        ...contextArgs(boundContext),
        p_mutation: mutation,
      }),
    decide: (mutation) =>
      callRpc(client, "apply_ai_review_item_decision", {
        ...contextArgs(boundContext),
        p_mutation: mutation,
      }),
    complete: (mutation) =>
      callRpc(client, "complete_ai_review", {
        ...contextArgs(boundContext),
        p_mutation: mutation,
      }),
  };
}

export function createSupabaseApprovedRedlineAppendPort(
  client: SupabaseRpcClient,
  context: AiPersistenceContext,
): ApprovedRedlineAppendPort {
  const boundContext = snapshotContext(context);
  return {
    append: (bundle) =>
      callRpc(client, "append_ai_redline_bundle", {
        ...contextArgs(boundContext),
        p_bundle: bundle,
      }),
  };
}

export function createSupabaseAiPersistencePorts(
  client: SupabaseRpcClient,
  context: AiPersistenceContext,
) {
  return {
    evidence: createSupabaseAtomicEvidenceAppendPort(client, context),
    review: createSupabaseHumanReviewMutationPort(client, context),
    redline: createSupabaseApprovedRedlineAppendPort(client, context),
  };
}
