"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { PillButton } from "@/app/components/ui/pill-button";
import { LIQUID_SUBTLE_PANEL_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { errorCode } from "@/app/lib/userFacingError";
import {
  getMatterDriveFolder,
  isMfaRequiredError,
  updateMatterDriveFolder,
  type MatterDriveFolderRole,
  type MatterDriveFolderSettings,
} from "@/app/lib/mikeApi";

const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const ROLES: ReadonlySet<MatterDriveFolderRole> = new Set([
  "matter_owner",
  "editor",
  "viewer",
  "technical_operator",
  "org_owner",
  "workspace_admin",
]);

const INVALID_RESPONSE = "La respuesta del servidor no es válida.";
const LOAD_ERROR = "La configuración de Drive no está disponible.";
const SAVE_ERROR = "No se pudo guardar la configuración de Drive.";
const MFA_ERROR = "Se requiere verificar MFA antes de guardar cambios.";

function isMatterDriveFolderSettings(
  value: unknown,
  projectId: string,
  matterId: string,
): value is MatterDriveFolderSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const role = candidate.role;
  const folderId = candidate.drive_folder_id;
  return (
    candidate.project_id === projectId &&
    candidate.matter_id === matterId &&
    typeof role === "string" &&
    ROLES.has(role as MatterDriveFolderRole) &&
    typeof candidate.can_edit === "boolean" &&
    candidate.can_edit === (role === "matter_owner") &&
    (folderId === null ||
      (typeof folderId === "string" && FOLDER_ID_PATTERN.test(folderId)))
  );
}

function safeErrorMessage(error: unknown, fallback: string) {
  if (isMfaRequiredError(error)) return MFA_ERROR;
  if (errorCode(error) === "invalid_drive_folder_id") {
    return "El ID de carpeta no es válido.";
  }
  return fallback;
}

function roleLabel(role: MatterDriveFolderRole) {
  switch (role) {
    case "matter_owner":
      return "Propietario del asunto";
    case "org_owner":
      return "Propietario de la organización";
    case "workspace_admin":
      return "Administrador del espacio de trabajo";
    case "technical_operator":
      return "Operador técnico";
    case "editor":
      return "Editor";
    case "viewer":
      return "Visualizador";
  }
}

export interface MatterDriveSettingsProps {
  projectId: string;
  matterId: string;
}

export function MatterDriveSettings({
  projectId,
  matterId,
}: MatterDriveSettingsProps) {
  const [settings, setSettings] = useState<MatterDriveFolderSettings | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    let active = true;
    setLoading(true);
    busyRef.current = false;
    setBusy(false);
    setSettings(null);
    setDraft("");
    setLoadError(null);
    setActionError(null);
    setSuccess(null);

    void getMatterDriveFolder(projectId, matterId)
      .then((result) => {
        if (!active || requestGeneration !== generation.current) return;
        if (!isMatterDriveFolderSettings(result, projectId, matterId)) {
          setLoadError(INVALID_RESPONSE);
          return;
        }
        setSettings(result);
        setDraft(result.drive_folder_id ?? "");
      })
      .catch((error: unknown) => {
        if (!active || requestGeneration !== generation.current) return;
        setLoadError(safeErrorMessage(error, LOAD_ERROR));
      })
      .finally(() => {
        if (!active || requestGeneration !== generation.current) return;
        setLoading(false);
      });

    return () => {
      active = false;
      generation.current += 1;
    };
  }, [matterId, projectId, reloadToken]);

  function isCurrent(requestGeneration: number) {
    return requestGeneration === generation.current;
  }

  async function persist(driveFolderId: string | null) {
    if (busyRef.current || !settings?.can_edit) return;
    const requestGeneration = generation.current;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    setSuccess(null);
    try {
      const result = await updateMatterDriveFolder(
        projectId,
        matterId,
        driveFolderId,
      );
      if (!isCurrent(requestGeneration)) return;
      if (
        !isMatterDriveFolderSettings(result, projectId, matterId) ||
        result.drive_folder_id !== driveFolderId
      ) {
        setSettings(null);
        setLoadError(INVALID_RESPONSE);
        return;
      }
      setSettings(result);
      setDraft(result.drive_folder_id ?? "");
      setSuccess("Guardado correctamente");
    } catch (error: unknown) {
      if (!isCurrent(requestGeneration)) return;
      setSettings(null);
      setLoadError(safeErrorMessage(error, SAVE_ERROR));
    } finally {
      if (isCurrent(requestGeneration)) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function handleSave() {
    if (!FOLDER_ID_PATTERN.test(draft)) {
      setActionError(
        draft === ""
          ? "Usa «Limpiar configuración» para quitar la carpeta."
          : "Introduce un ID válido de carpeta de Google Drive.",
      );
      setSuccess(null);
      return;
    }
    void persist(draft);
  }

  function handleClear() {
    void persist(null);
  }

  const canEdit = settings?.role === "matter_owner" && settings.can_edit;

  return (
    <main className="min-h-full px-4 py-6 md:px-8">
      <div className="mx-auto max-w-2xl">
        <header className="mb-5">
          <p className="mb-1 text-xs text-gray-500">Asunto</p>
          <h1 className="font-serif text-2xl text-gray-900">
            Configuración de carpeta de Google Drive
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            Referencia de carpeta de este asunto para futuras operaciones
            autorizadas.
          </p>
        </header>

        <section
          className={`${LIQUID_SUBTLE_PANEL_SURFACE_CLASS} p-5 md:p-6`}
          aria-busy={loading || busy}
        >
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>Cargando configuración…</span>
            </div>
          ) : loadError ? (
            <div className="space-y-3" role="alert">
              <p className="text-sm text-red-700">{loadError}</p>
              <PillButton
                tone="white"
                size="sm"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                Reintentar
              </PillButton>
            </div>
          ) : settings ? (
            <>
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium text-gray-900">
                    {settings.drive_folder_id
                      ? "Carpeta configurada"
                      : "Sin carpeta configurada"}
                  </h2>
                  <p className="mt-1 text-xs text-gray-600">
                    Rol: {roleLabel(settings.role)}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Configuración guardada en el servidor
                  </p>
                </div>
                <p className="text-xs text-gray-600">
                  {canEdit
                    ? "Puede editar"
                    : "No puede cambiar esta configuración"}
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <FieldLabel htmlFor="matter-drive-folder-id">
                    ID de carpeta de Google Drive
                  </FieldLabel>
                  <FormTextInput
                    id="matter-drive-folder-id"
                    value={draft}
                    disabled={!canEdit || busy}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setActionError(null);
                      setSuccess(null);
                    }}
                    placeholder="Ej. 1AbC_def-234"
                    aria-describedby="matter-drive-folder-help"
                  />
                  <p
                    id="matter-drive-folder-help"
                    className="mt-2 text-xs text-gray-500"
                  >
                    {canEdit
                      ? "Usa el ID exacto (letras, números, guion y guion bajo). No se aceptan URLs."
                      : "Referencia guardada para este asunto."}
                  </p>
                </div>

                {actionError && (
                  <p className="text-sm text-red-700" role="alert">
                    {actionError}
                  </p>
                )}
                {success && (
                  <p className="text-sm text-green-700" role="status">
                    {success}
                  </p>
                )}

                {canEdit && (
                  <div className="flex flex-wrap items-center gap-2">
                    <PillButton
                      tone="blue"
                      className="h-10"
                      onClick={handleSave}
                      disabled={busy}
                    >
                      {busy ? "Guardando…" : "Guardar"}
                    </PillButton>
                    <PillButton
                      tone="white"
                      className="h-10"
                      onClick={handleClear}
                      disabled={busy || settings.drive_folder_id === null}
                    >
                      Limpiar configuración
                    </PillButton>
                  </div>
                )}
              </div>

              <p className="mt-5 border-t border-gray-200/70 pt-4 text-sm leading-5 text-gray-600">
                Esta configuración solo guarda la referencia de la carpeta.
                Guardar no publica documentos. No comprueba la conexión con
                Google Drive ni elimina ninguna carpeta o archivo al quitarla.
              </p>
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}

export default MatterDriveSettings;
