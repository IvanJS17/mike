import { describe, expect, it, vi } from "vitest";

import {
  createSupabaseAiPersistencePorts,
  type AiPersistenceContext,
} from "./supabaseAiPersistencePorts";

function client(result: unknown) {
  return { rpc: vi.fn(async () => result) };
}

const context: AiPersistenceContext = {
  actor_user_id: "actor-a",
  organization_id: "org-a",
  authorization_epoch: 7,
};

describe("Supabase AI persistence ports", () => {
  it("calls every reviewed RPC with its exact name and bound context", async () => {
    const db = client({ data: "receipt", error: null });
    const ports = createSupabaseAiPersistencePorts(db, context);
    const batch = { kind: "batch" };
    const create = { kind: "create" };
    const decide = { kind: "decide" };
    const complete = { kind: "complete" };
    const bundle = { kind: "bundle" };

    await expect(ports.evidence.append(batch as never)).resolves.toBe(
      "receipt",
    );
    await expect(ports.review.create(create as never)).resolves.toBe("receipt");
    await expect(ports.review.decide(decide as never)).resolves.toBe("receipt");
    await expect(ports.review.complete(complete as never)).resolves.toBe(
      "receipt",
    );
    await expect(ports.redline.append(bundle as never)).resolves.toBe(
      "receipt",
    );

    expect(db.rpc).toHaveBeenNthCalledWith(1, "append_ai_evidence_batch", {
      p_actor_user_id: "actor-a",
      p_organization_id: "org-a",
      p_authorization_epoch: 7,
      p_batch: batch,
    });
    expect(db.rpc).toHaveBeenNthCalledWith(2, "create_ai_review", {
      p_actor_user_id: "actor-a",
      p_organization_id: "org-a",
      p_authorization_epoch: 7,
      p_mutation: create,
    });
    expect(db.rpc).toHaveBeenNthCalledWith(3, "apply_ai_review_item_decision", {
      p_actor_user_id: "actor-a",
      p_organization_id: "org-a",
      p_authorization_epoch: 7,
      p_mutation: decide,
    });
    expect(db.rpc).toHaveBeenNthCalledWith(4, "complete_ai_review", {
      p_actor_user_id: "actor-a",
      p_organization_id: "org-a",
      p_authorization_epoch: 7,
      p_mutation: complete,
    });
    expect(db.rpc).toHaveBeenNthCalledWith(5, "append_ai_redline_bundle", {
      p_actor_user_id: "actor-a",
      p_organization_id: "org-a",
      p_authorization_epoch: 7,
      p_bundle: bundle,
    });
  });

  it("snapshots context and is safe when methods are detached", async () => {
    const db = client({ data: { ok: true }, error: null });
    const mutable = { ...context };
    const ports = createSupabaseAiPersistencePorts(db, mutable);
    mutable.actor_user_id = "changed";
    mutable.organization_id = "changed";
    mutable.authorization_epoch = 99;

    const append = ports.evidence.append;
    await append({ value: 1 } as never);
    expect(db.rpc).toHaveBeenCalledWith("append_ai_evidence_batch", {
      p_actor_user_id: "actor-a",
      p_organization_id: "org-a",
      p_authorization_epoch: 7,
      p_batch: { value: 1 },
    });
  });

  it.each([
    new Error("secret details"),
    { data: { ok: false }, error: { message: "secret details" } },
    { data: null, error: null },
    { data: undefined, error: null },
    { data: { error: "server detail" }, error: null },
  ])("redacts or fails closed for bad RPC result %j", async (result) => {
    const db = client(result);
    const ports = createSupabaseAiPersistencePorts(db, context);

    await expect(ports.evidence.append({} as never)).rejects.toThrow(
      "AI persistence RPC failed",
    );
    await expect(ports.evidence.append({} as never)).rejects.not.toThrow(
      /secret|server detail/,
    );
  });

  it("redacts an exception thrown by the RPC client", async () => {
    const db = {
      rpc: vi.fn(async () => {
        throw new Error("password=secret table=ai_receipts");
      }),
    };
    const ports = createSupabaseAiPersistencePorts(db, context);
    const promise = ports.review.create({} as never);

    await expect(promise).rejects.toThrow("AI persistence RPC failed");
    await expect(promise).rejects.not.toThrow(/password|secret|ai_receipts/);
  });
});
