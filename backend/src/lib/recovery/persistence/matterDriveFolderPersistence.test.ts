import { describe, expect, it, vi } from "vitest";

import {
  MATTER_DRIVE_FOLDER_RPC_NAMES,
  createMatterDriveFolderPersistence,
} from "./matterDriveFolderPersistence";

const IDS = {
  actor: "11111111-1111-4111-8111-111111111111",
  organization: "22222222-2222-4222-8222-222222222222",
  matter: "33333333-3333-4333-8333-333333333333",
  project: "44444444-4444-4444-8444-444444444444",
} as const;

const context = {
  actor_user_id: IDS.actor,
  organization_id: IDS.organization,
  authorization_epoch: 7,
};

function response(drive_folder_id: string | null = "folder-1") {
  return {
    data: {
      matter_id: IDS.matter,
      project_id: IDS.project,
      organization_id: IDS.organization,
      drive_folder_id,
    },
    error: null,
  };
}

describe("matter Drive folder persistence", () => {
  it("reads each mutable input field exactly once", async () => {
    let reads = 0;
    const rpc = vi.fn().mockResolvedValue(response());
    const persistence = createMatterDriveFolderPersistence({
      client: { rpc },
      context,
    });
    await expect(
      persistence.update({
        matter_id: IDS.matter,
        project_id: IDS.project,
        get drive_folder_id() {
          reads += 1;
          return reads === 1 ? "folder-1" : "bad/id";
        },
      }),
    ).resolves.toEqual(response().data);
    expect(reads).toBe(1);
    expect(rpc.mock.calls[0][1].p_drive_folder_id).toBe("folder-1");
  });

  it("rejects non-string UUID authority before calling RPC", () => {
    const rpc = vi.fn();
    expect(() =>
      createMatterDriveFolderPersistence({
        client: { rpc },
        context: {
          ...context,
          actor_user_id: [IDS.actor] as unknown as string,
        },
      }),
    ).toThrow("matter Drive folder persistence failed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends a snapshotted server authority context and acknowledges the saved value", async () => {
    const rpc = vi.fn().mockResolvedValue(response());
    const persistence = createMatterDriveFolderPersistence({
      client: { rpc },
      context,
    });

    const result = await persistence.update({
      matter_id: IDS.matter,
      project_id: IDS.project,
      drive_folder_id: "folder-1",
    });

    expect(rpc).toHaveBeenCalledWith(MATTER_DRIVE_FOLDER_RPC_NAMES.update, {
      p_matter_id: IDS.matter,
      p_project_id: IDS.project,
      p_drive_folder_id: "folder-1",
      p_actor_user_id: IDS.actor,
      p_organization_id: IDS.organization,
      p_authorization_epoch: 7,
    });
    expect(result).toEqual(response().data);
  });

  it("supports clearing and rejects malformed or mismatched RPC rows without leaking provider errors", async () => {
    const rpc = vi.fn().mockResolvedValue(response(null));
    const persistence = createMatterDriveFolderPersistence({
      client: { rpc },
      context,
    });
    await expect(
      persistence.update({
        matter_id: IDS.matter,
        project_id: IDS.project,
        drive_folder_id: null,
      }),
    ).resolves.toEqual(response(null).data);

    rpc.mockResolvedValueOnce({
      data: { ...response().data, drive_folder_id: "different" },
      error: null,
    });
    await expect(
      persistence.update({
        matter_id: IDS.matter,
        project_id: IDS.project,
        drive_folder_id: "folder-1",
      }),
    ).rejects.toThrow("matter Drive folder persistence failed");

    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "secret provider detail" },
    });
    await expect(
      persistence.update({
        matter_id: IDS.matter,
        project_id: IDS.project,
        drive_folder_id: "folder-1",
      }),
    ).rejects.toThrow("matter Drive folder persistence failed");
  });

  it.each([
    [
      "unknown role",
      {
        matter_id: IDS.matter,
        project_id: IDS.project,
        organization_id: IDS.organization,
        drive_folder_id: "folder-1",
        role: "admin",
      },
    ],
    [
      "unknown status",
      {
        matter_id: IDS.matter,
        project_id: IDS.project,
        organization_id: IDS.organization,
        drive_folder_id: "folder-1",
        status: "pending",
      },
    ],
  ])(
    "does not accept invalid returned authority rows (%s)",
    async (_label, row) => {
      const rpc = vi.fn().mockResolvedValue({ data: row, error: null });
      const persistence = createMatterDriveFolderPersistence({
        client: { rpc },
        context,
      });
      await expect(
        persistence.update({
          matter_id: IDS.matter,
          project_id: IDS.project,
          drive_folder_id: "folder-1",
        }),
      ).rejects.toThrow("matter Drive folder persistence failed");
    },
  );
});
