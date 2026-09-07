import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatterDriveSettings } from "./MatterDriveSettings";

const api = vi.hoisted(() => ({
  getMatterDriveFolder: vi.fn(),
  updateMatterDriveFolder: vi.fn(),
  isMfaRequiredError: vi.fn(
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "mfa_verification_required",
  ),
}));

vi.mock("@/app/lib/mikeApi", () => api);

function settings(
  overrides: Partial<{
    matter_id: string;
    project_id: string;
    drive_folder_id: string | null;
    role:
      | "matter_owner"
      | "editor"
      | "viewer"
      | "technical_operator"
      | "org_owner"
      | "workspace_admin";
    can_edit: boolean;
  }> = {},
) {
  return {
    matter_id: "matter-1",
    project_id: "project-1",
    drive_folder_id: "folder-1",
    role: "matter_owner" as const,
    can_edit: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.getMatterDriveFolder.mockReset();
  api.updateMatterDriveFolder.mockReset();
  api.getMatterDriveFolder.mockResolvedValue(settings());
  api.updateMatterDriveFolder.mockImplementation(async (_p, _m, folder) =>
    settings({ drive_folder_id: folder }),
  );
});

describe("MatterDriveSettings", () => {
  it("makes the non-publication scope and touch controls explicit", async () => {
    render(<MatterDriveSettings projectId="project-1" matterId="matter-1" />);
    await screen.findByDisplayValue("folder-1");
    expect(screen.getByText(/Guardar no publica documentos/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Guardar" })).toHaveClass("h-10");
    expect(
      screen.getByRole("button", { name: "Limpiar configuración" }),
    ).toHaveClass("h-10");
  });
  it("requires a new server read after a save loses MFA", async () => {
    const user = userEvent.setup();
    api.updateMatterDriveFolder.mockRejectedValue({
      code: "mfa_verification_required",
    });
    render(<MatterDriveSettings projectId="project-1" matterId="matter-1" />);
    await screen.findByDisplayValue("folder-1");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Guardar" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByDisplayValue("folder-1");
    expect(api.getMatterDriveFolder).toHaveBeenCalledTimes(2);
    expect(api.updateMatterDriveFolder).toHaveBeenCalledTimes(1);
  });
  it("loads and renders the authoritative folder setting for its scope", async () => {
    render(<MatterDriveSettings projectId="project-1" matterId="matter-1" />);

    expect(screen.getByText("Cargando configuración…")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-1")).toBeVisible(),
    );
    expect(api.getMatterDriveFolder).toHaveBeenCalledWith(
      "project-1",
      "matter-1",
    );
    expect(
      screen.getByText("Configuración guardada en el servidor"),
    ).toBeVisible();
    expect(
      screen.getByText(/No comprueba la conexión con Google Drive/),
    ).toBeVisible();
  });

  it("allows a matter owner to save and explicitly clear the setting", async () => {
    const user = userEvent.setup();
    render(<MatterDriveSettings projectId="project-1" matterId="matter-1" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-1")).toBeVisible(),
    );

    const input = screen.getByLabelText("ID de carpeta de Google Drive");
    await user.clear(input);
    await user.type(input, "folder-2");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(api.updateMatterDriveFolder).toHaveBeenCalledWith(
        "project-1",
        "matter-1",
        "folder-2",
      ),
    );
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-2")).toBeVisible(),
    );
    expect(screen.getByText("Guardado correctamente")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Limpiar configuración" }),
    );
    await waitFor(() =>
      expect(api.updateMatterDriveFolder).toHaveBeenLastCalledWith(
        "project-1",
        "matter-1",
        null,
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("Sin carpeta configurada")).toBeVisible(),
    );
  });

  it.each([
    ["viewer", false],
    ["org_owner", false],
    ["editor", false],
  ] as const)(
    "keeps %s without edit authority read-only",
    async (role, can_edit) => {
      api.getMatterDriveFolder.mockResolvedValue(settings({ role, can_edit }));
      render(<MatterDriveSettings projectId="project-1" matterId="matter-1" />);

      await waitFor(() =>
        expect(screen.getByDisplayValue("folder-1")).toBeVisible(),
      );
      expect(
        screen.queryByRole("button", { name: "Guardar" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Limpiar configuración" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("No puede cambiar esta configuración"),
      ).toBeVisible();
    },
  );

  it("shows MFA required without retrying or exposing the raw error", async () => {
    const user = userEvent.setup();
    api.updateMatterDriveFolder.mockRejectedValue({
      status: 403,
      code: "mfa_verification_required",
      message: "internal MFA detail",
    });
    render(<MatterDriveSettings projectId="project-1" matterId="matter-1" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-1")).toBeVisible(),
    );

    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(screen.getByText(/Se requiere verificar MFA/)).toBeVisible(),
    );
    expect(screen.queryByText("internal MFA detail")).not.toBeInTheDocument();
  });

  it("shows a safe unavailable error when the read fails", async () => {
    api.getMatterDriveFolder.mockRejectedValue(
      new Error("secret backend detail"),
    );
    render(<MatterDriveSettings projectId="project-1" matterId="matter-1" />);

    await waitFor(() =>
      expect(screen.getByText(/no está disponible/)).toBeVisible(),
    );
    expect(screen.queryByText("secret backend detail")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("ID de carpeta de Google Drive"),
    ).not.toBeInTheDocument();
  });

  it("does not issue a second write while the first is pending", async () => {
    const user = userEvent.setup();
    const pending = deferred<ReturnType<typeof settings>>();
    api.updateMatterDriveFolder.mockReturnValue(pending.promise);
    render(<MatterDriveSettings projectId="project-1" matterId="matter-1" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-1")).toBeVisible(),
    );

    const save = screen.getByRole("button", { name: "Guardar" });
    await user.click(save);
    await user.click(save);
    expect(api.updateMatterDriveFolder).toHaveBeenCalledTimes(1);

    pending.resolve(settings());
    await waitFor(() =>
      expect(screen.getByText("Guardado correctamente")).toBeVisible(),
    );
  });

  it("ignores a stale read when navigation changes the project and matter", async () => {
    const oldRead = deferred<ReturnType<typeof settings>>();
    api.getMatterDriveFolder.mockImplementation((projectId: string) =>
      projectId === "project-1"
        ? oldRead.promise
        : Promise.resolve(
            settings({
              project_id: "project-2",
              matter_id: "matter-2",
              drive_folder_id: "folder-2",
            }),
          ),
    );
    const { rerender } = render(
      <MatterDriveSettings projectId="project-1" matterId="matter-1" />,
    );
    rerender(<MatterDriveSettings projectId="project-2" matterId="matter-2" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-2")).toBeVisible(),
    );

    oldRead.resolve(settings());
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-2")).toBeVisible(),
    );
    expect(screen.queryByDisplayValue("folder-1")).not.toBeInTheDocument();
  });

  it("ignores a stale write completion after navigation", async () => {
    const oldWrite = deferred<ReturnType<typeof settings>>();
    api.updateMatterDriveFolder.mockReturnValue(oldWrite.promise);
    const user = userEvent.setup();
    const { rerender } = render(
      <MatterDriveSettings projectId="project-1" matterId="matter-1" />,
    );
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-1")).toBeVisible(),
    );
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    api.getMatterDriveFolder.mockResolvedValue(
      settings({
        project_id: "project-2",
        matter_id: "matter-2",
        drive_folder_id: "folder-2",
      }),
    );
    rerender(<MatterDriveSettings projectId="project-2" matterId="matter-2" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-2")).toBeVisible(),
    );
    oldWrite.resolve(settings({ drive_folder_id: "old-write" }));
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-2")).toBeVisible(),
    );
    expect(
      screen.queryByText("Guardado correctamente"),
    ).not.toBeInTheDocument();
  });

  it("fails closed for malformed or mismatched read and write acknowledgements", async () => {
    api.getMatterDriveFolder.mockResolvedValueOnce({
      ...settings(),
      project_id: "other-project",
    });
    const { rerender } = render(
      <MatterDriveSettings projectId="project-1" matterId="matter-1" />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("La respuesta del servidor no es válida."),
      ).toBeVisible(),
    );
    expect(screen.queryByDisplayValue("folder-1")).not.toBeInTheDocument();

    api.getMatterDriveFolder.mockResolvedValue(
      settings({ project_id: "project-2", matter_id: "matter-2" }),
    );
    rerender(<MatterDriveSettings projectId="project-2" matterId="matter-2" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-1")).toBeVisible(),
    );
    api.updateMatterDriveFolder.mockResolvedValue(
      settings({ project_id: "other-project" }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(
        screen.getByText("La respuesta del servidor no es válida."),
      ).toBeVisible(),
    );
    expect(
      screen.queryByRole("button", { name: "Guardar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeEnabled();
  });

  it("fails closed for malformed read and write acknowledgements", async () => {
    api.getMatterDriveFolder.mockResolvedValue({
      ...settings(),
      can_edit: "true",
    });
    const { rerender } = render(
      <MatterDriveSettings projectId="project-1" matterId="matter-1" />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("La respuesta del servidor no es válida."),
      ).toBeVisible(),
    );

    api.getMatterDriveFolder.mockResolvedValue(
      settings({ project_id: "project-2", matter_id: "matter-2" }),
    );
    rerender(<MatterDriveSettings projectId="project-2" matterId="matter-2" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-1")).toBeVisible(),
    );
    api.updateMatterDriveFolder.mockResolvedValue({
      ...settings({ project_id: "project-2", matter_id: "matter-2" }),
      drive_folder_id: 7,
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(
        screen.getByText("La respuesta del servidor no es válida."),
      ).toBeVisible(),
    );
    expect(
      screen.queryByRole("button", { name: "Guardar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeEnabled();
  });

  it("rejects blank values and URLs instead of normalizing them", async () => {
    const user = userEvent.setup();
    render(<MatterDriveSettings projectId="project-1" matterId="matter-1" />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("folder-1")).toBeVisible(),
    );
    const input = screen.getByLabelText("ID de carpeta de Google Drive");

    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(api.updateMatterDriveFolder).not.toHaveBeenCalled();
    expect(screen.getByText(/Usa «Limpiar configuración»/)).toBeVisible();

    await user.type(input, "https://drive.google.com/drive/folders/folder-2");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(api.updateMatterDriveFolder).not.toHaveBeenCalled();
    expect(screen.getByText(/ID válido/)).toBeVisible();
  });
});
