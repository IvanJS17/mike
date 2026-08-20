"use client";

import { useEffect, useState } from "react";
import {
  getMatterDriveFolder,
  updateMatterDriveFolder,
  type MatterDriveFolderSettings as MatterDriveFolderSettingsValue,
} from "@/app/lib/mikeApi";

export function MatterDriveFolderSettings({
  projectId,
  matterId,
}: {
  projectId: string;
  matterId: string;
}) {
  const [settings, setSettings] =
    useState<MatterDriveFolderSettingsValue | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const normalizedMatterId = matterId.trim();
    if (!normalizedMatterId) {
      setSettings(null);
      setDraft("");
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSaved(false);
    setError(null);
    getMatterDriveFolder(projectId, normalizedMatterId)
      .then((next) => {
        if (cancelled) return;
        setSettings(next);
        setDraft(next.drive_folder_id ?? "");
      })
      .catch(() => {
        if (cancelled) return;
        setSettings(null);
        setDraft("");
        setError("No se pudo cargar la configuración del Shared Drive.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [matterId, projectId]);

  async function save() {
    if (!settings?.can_edit || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const next = await updateMatterDriveFolder(
        projectId,
        settings.matter_id,
        draft.trim() || null,
      );
      setSettings(next);
      setDraft(next.drive_folder_id ?? "");
      setSaved(true);
    } catch {
      setError("No se pudo guardar la carpeta del Shared Drive.");
    } finally {
      setSaving(false);
    }
  }

  if (!matterId.trim()) return null;

  return (
    <section
      className="mt-5 rounded-xl border border-gray-200 bg-white p-4"
      data-testid="matter-drive-folder-settings"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium text-gray-800">Shared Drive del matter</h2>
          <p className="mt-1 text-sm leading-6 text-gray-500">
            La publicación usa únicamente esta carpeta explícita; no se acepta
            una carpeta en la solicitud de publicación.
          </p>
        </div>
        {settings && (
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
            {settings.role}
          </span>
        )}
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-gray-500">Cargando carpeta…</p>
      ) : settings ? (
        <>
          <label className="mt-4 block text-sm font-medium text-gray-700">
            ID de carpeta Shared Drive
            <input
              aria-label="ID de carpeta Shared Drive"
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-gray-700 disabled:bg-gray-50 disabled:text-gray-500"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaved(false);
                setError(null);
              }}
              disabled={!settings.can_edit || saving}
              placeholder="ID explícito de la carpeta"
            />
          </label>
          {settings.can_edit ? (
            <button
              type="button"
              className="mt-3 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Guardando…" : "Guardar carpeta"}
            </button>
          ) : (
            <p className="mt-3 text-sm text-gray-500">
              Solo el matter owner puede cambiar esta carpeta.
            </p>
          )}
        </>
      ) : null}

      {saved && (
        <p className="mt-3 text-sm text-emerald-700" role="status">
          Carpeta guardada
        </p>
      )}
      {error && (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
