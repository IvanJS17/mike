export type StreamIdentity = Readonly<{
  generation: number;
  chat_id: string;
  matter_id?: string;
  project_id?: string;
  document_version_id?: string;
}>;

export type StreamTransition = Readonly<{
  accepted: boolean;
  state: StreamIdentity;
}>;

type StreamScope = Omit<StreamIdentity, "generation">;
type UnknownRecord = Record<string, unknown>;

const SCOPE_KEYS = [
  "chat_id",
  "matter_id",
  "project_id",
  "document_version_id",
] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function result(state: StreamIdentity, accepted: boolean): StreamTransition {
  return Object.freeze({ accepted, state });
}

function nextState(
  state: StreamIdentity,
  replacement: Partial<StreamScope> = {},
): StreamIdentity {
  return Object.freeze({
    ...state,
    ...replacement,
    generation: state.generation + 1,
  });
}

export function createStreamIdentity(scope: StreamScope): StreamIdentity {
  return Object.freeze({ generation: 0, ...scope });
}

export function transitionStreamIdentity(
  state: StreamIdentity,
  frame: unknown,
): StreamTransition {
  if (!isRecord(frame) || typeof frame.kind !== "string") {
    return result(state, false);
  }

  if (frame.kind === "abort") {
    return hasOnlyKeys(frame, ["kind"])
      ? result(nextState(state), true)
      : result(state, false);
  }

  if (frame.kind === "switch_chat") {
    if (
      !hasOnlyKeys(frame, ["kind", "chat_id"]) ||
      !isNonEmptyString(frame.chat_id)
    ) {
      return result(state, false);
    }
    return result(nextState(state, { chat_id: frame.chat_id }), true);
  }

  if (frame.kind === "switch_document_version") {
    if (
      !hasOnlyKeys(frame, ["kind", "document_version_id"]) ||
      !isNonEmptyString(frame.document_version_id)
    ) {
      return result(state, false);
    }
    return result(
      nextState(state, { document_version_id: frame.document_version_id }),
      true,
    );
  }

  if (!(["content", "citation", "provenance"] as string[]).includes(frame.kind)) {
    return result(state, false);
  }
  if (
    !hasOnlyKeys(frame, ["kind", "generation", ...SCOPE_KEYS, "payload"]) ||
    !Number.isSafeInteger(frame.generation) ||
    frame.generation !== state.generation ||
    !isNonEmptyString(frame.chat_id)
  ) {
    return result(state, false);
  }

  for (const key of SCOPE_KEYS) {
    if (frame[key] !== undefined && frame[key] !== state[key]) {
      return result(state, false);
    }
  }

  return result(state, true);
}
