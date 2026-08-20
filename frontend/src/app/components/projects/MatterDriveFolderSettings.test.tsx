import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatterDriveFolderSettings } from "./MatterDriveFolderSettings";

const { getMatterDriveFolder, updateMatterDriveFolder } = vi.hoisted(() => ({
  getMatterDriveFolder: vi.fn(),
  updateMatterDriveFolder: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getMatterDriveFolder: (...args: unknown[]) => getMatterDriveFolder(...args),
  updateMatterDriveFolder: (...args: unknown[]) => updateMatterDriveFolder(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getMatterDriveFolder.mockResolvedValue({
    matter_id: "matter-1",
    project_id: "project-1",
    drive_folder_id: "folder-1",
    role: "matter_owner",
    can_edit: true,
  });
  updateMatterDriveFolder.mockResolvedValue({
    matter_id: "matter-1",
    project_id: "project-1",
    drive_folder_id: "folder-2",
    role: "matter_owner",
    can_edit: true,
  });
});

describe("MatterDriveFolderSettings", () => {
  it("loads the explicit folder and lets the matter owner save it", async () => {
    const user = userEvent.setup();
    render(
      <MatterDriveFolderSettings projectId="project-1" matterId="matter-1" />,
    );

    const input = await screen.findByLabelText("ID de carpeta Shared Drive");
    expect(input).toHaveValue("folder-1");
    await user.clear(input);
    await user.type(input, "folder-2");
    await user.click(screen.getByRole("button", { name: "Guardar carpeta" }));

    await waitFor(() => {
      expect(updateMatterDriveFolder).toHaveBeenCalledWith(
        "project-1",
        "matter-1",
        "folder-2",
      );
    });
    expect(await screen.findByText("Carpeta guardada")).toBeInTheDocument();
  });

  it("shows the folder read-only to an editor", async () => {
    getMatterDriveFolder.mockResolvedValue({
      matter_id: "matter-1",
      project_id: "project-1",
      drive_folder_id: "folder-editor",
      role: "editor",
      can_edit: false,
    });

    render(
      <MatterDriveFolderSettings projectId="project-1" matterId="matter-1" />,
    );

    const input = await screen.findByLabelText("ID de carpeta Shared Drive");
    expect(input).toHaveValue("folder-editor");
    expect(input).toBeDisabled();
    expect(screen.getByText("Solo el matter owner puede cambiar esta carpeta.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar carpeta" })).not.toBeInTheDocument();
  });
});
