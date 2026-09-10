import { describe, expect, it, vi } from "vitest";
import { recordAudit } from "../audit";

describe("canonical append-only audit writer", () => {
  it("writes one canonical actor/event/detail shape, not nullable aliases", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ insert });
    await recordAudit(
      { from } as unknown as Parameters<typeof recordAudit>[0],
      {
        userId: "11111111-0000-0000-0000-000000000001",
        action: "document.generated",
        detail: { workflow_id: "workflow-1" },
      },
    );
    expect(from).toHaveBeenCalledWith("audit_events");
    const row = insert.mock.calls[0][0];
    expect(row).toMatchObject({
      actor_user_id: "11111111-0000-0000-0000-000000000001",
      event_type: "document.generated",
      event_detail: { workflow_id: "workflow-1" },
    });
    for (const key of ["user_id", "action", "detail"])
      expect(row).not.toHaveProperty(key);
  });
});
