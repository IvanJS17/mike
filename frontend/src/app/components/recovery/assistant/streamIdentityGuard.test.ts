import { describe, expect, it } from "vitest";
import * as moduleExports from "./streamIdentityGuard";
import {
  createStreamIdentity,
  transitionStreamIdentity,
} from "./streamIdentityGuard";

const scope = {
  chat_id: "chat-1",
  matter_id: "matter-1",
  project_id: "project-1",
  document_version_id: "version-1",
};

describe("stream identity guard", () => {
  it("accepts only supported frames with the current generation and scope", () => {
    const state = createStreamIdentity(scope);

    for (const kind of ["content", "citation", "provenance"] as const) {
      const result = transitionStreamIdentity(state, {
        kind,
        generation: 0,
        ...scope,
      });
      expect(result.accepted).toBe(true);
      expect(result.state).toBe(state);
    }
  });

  it.each([
    ["generation", { generation: 9 }],
    ["chat", { chat_id: "chat-late" }],
    ["matter", { matter_id: "matter-late" }],
    ["project", { project_id: "project-late" }],
    ["document", { document_version_id: "version-late" }],
  ])("rejects a frame with mismatched %s", (_name, replacement) => {
    const state = createStreamIdentity(scope);
    const result = transitionStreamIdentity(state, {
      kind: "citation",
      generation: 0,
      ...scope,
      ...replacement,
    });

    expect(result).toEqual({ accepted: false, state });
  });

  it("switches chat and rejects late content, citation and provenance frames", () => {
    const initial = createStreamIdentity(scope);
    const switched = transitionStreamIdentity(initial, {
      kind: "switch_chat",
      chat_id: "chat-2",
    });

    expect(switched.accepted).toBe(true);
    expect(switched.state).toMatchObject({ chat_id: "chat-2", generation: 1 });
    for (const kind of ["content", "citation", "provenance"] as const) {
      expect(
        transitionStreamIdentity(switched.state, {
          kind,
          generation: 0,
          ...scope,
        }).accepted,
      ).toBe(false);
    }
  });

  it("switches document version and rejects late frames", () => {
    const initial = createStreamIdentity(scope);
    const switched = transitionStreamIdentity(initial, {
      kind: "switch_document_version",
      document_version_id: "version-2",
    });

    expect(switched.state).toMatchObject({
      document_version_id: "version-2",
      generation: 1,
    });
    expect(
      transitionStreamIdentity(switched.state, {
        kind: "provenance",
        generation: 0,
        ...scope,
      }).accepted,
    ).toBe(false);
  });

  it("aborts by advancing the generation", () => {
    const initial = createStreamIdentity(scope);
    const aborted = transitionStreamIdentity(initial, { kind: "abort" });

    expect(aborted).toEqual({
      accepted: true,
      state: expect.objectContaining({ generation: 1 }),
    });
    expect(Object.isFrozen(aborted.state)).toBe(true);
  });

  it.each([
    null,
    {},
    { kind: "content", generation: "0", chat_id: "chat-1" },
    { kind: "unknown", generation: 0, chat_id: "chat-1" },
    { kind: "citation", generation: 0 },
    { kind: "abort", extra: true },
    { kind: "switch_chat", chat_id: "" },
    { kind: "switch_document_version", document_version_id: 4 },
  ])("fails closed without mutating state for malformed input %#", (frame) => {
    const state = createStreamIdentity(scope);
    const snapshot = { ...state };

    const result = transitionStreamIdentity(state, frame);

    expect(result).toEqual({ accepted: false, state });
    expect(state).toEqual(snapshot);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("supports omitted optional scope without weakening supplied discriminators", () => {
    const state = createStreamIdentity({ chat_id: "chat-1" });
    expect(
      transitionStreamIdentity(state, {
        kind: "content",
        generation: 0,
        chat_id: "chat-1",
      }).accepted,
    ).toBe(true);
    expect(
      transitionStreamIdentity(state, {
        kind: "content",
        generation: 0,
        chat_id: "chat-1",
        matter_id: "unexpected",
      }).accepted,
    ).toBe(false);
  });

  it("locks the runtime export surface", () => {
    expect(Object.keys(moduleExports).sort()).toEqual([
      "createStreamIdentity",
      "transitionStreamIdentity",
    ]);
  });
});
