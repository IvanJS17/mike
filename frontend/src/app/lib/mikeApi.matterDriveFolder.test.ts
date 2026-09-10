import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getMatterDriveFolder,
  updateMatterDriveFolder,
  type MatterDriveFolderSettings,
} from "./mikeApi";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("./authEvents", () => ({ authenticatedFetch: fetchMock }));

const settings: MatterDriveFolderSettings = {
  matter_id: "matter-1",
  project_id: "project-1",
  drive_folder_id: "folder-1",
  role: "matter_owner",
  can_edit: true,
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify(settings), { status: 200 }),
  );
});

describe("matter Drive folder API", () => {
  it("encodes each scope identifier for both methods", async () => {
    await getMatterDriveFolder("project/id", "matter?id");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/projects/project%2Fid/matters/matter%3Fid/drive-folder",
    );
    await updateMatterDriveFolder("project/id", "matter?id", "folder-1");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/projects/project%2Fid/matters/matter%3Fid/drive-folder",
    );
  });

  it("loads the authenticated setting", async () => {
    await expect(
      getMatterDriveFolder("project-1", "matter-1"),
    ).resolves.toEqual(settings);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/matters/matter-1/drive-folder",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("updates and clears the setting with the typed request body", async () => {
    await updateMatterDriveFolder("project-1", "matter-1", null);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/matters/matter-1/drive-folder",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ drive_folder_id: null }),
      }),
    );
  });
});
