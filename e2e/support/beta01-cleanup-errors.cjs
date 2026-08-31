"use strict";

// Beta 0.1 — composición pura de errores cuerpo/teardown (Gate 2 fix B).
//
// Regla de oro: el teardown (fixture/auth/state-file) SIEMPRE corre y sus
// errores NUNCA reemplazan el error primario del cuerpo. Este módulo decide
// qué propagar (sin stack, sin red):
//   - cuerpo OK  y cleanup OK            -> null (éxito, nada que propagar)
//   - cuerpo FAIL y cleanup OK           -> el error del cuerpo TAL CUAL
//   - cuerpo OK y cleanup FAIL (1)       -> ese error de cleanup TAL CUAL
//   - cuerpo OK y cleanup FAIL (varios)  -> CleanupOnlyCompositeError
//     (mensajes y stacks de TODOS los cleanup preservados: ningún residuo se
//     silencia)
//   - cuerpo FAIL y cleanup FAIL         -> CleanupCompositeError: mensaje y
//     stack con PRIMARY primero y CLEANUP después, conservando message/stack
//     de TODOS los errores; el primario jamás se pierde ni se reemplaza.
//
// El contract test (scripts/test-beta01-cleanup-errors.sh) lo ejercita con
// Node puro y verifica las 4 combinaciones y el orden/diagnóstico.

function errorMessage(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function errorStack(error) {
  return error instanceof Error &&
    typeof error.stack === "string" &&
    error.stack.length > 0
    ? error.stack
    : String(error);
}

class CleanupCompositeError extends Error {
  constructor(primaryError, cleanupErrors) {
    const cleanups = cleanupErrors.slice();
    super(
      "Body failed and cleanup failed — PRIMARY first, CLEANUP after:\n" +
        "[PRIMARY] " + errorMessage(primaryError) + "\n" +
        cleanups
          .map((error, index) => `[CLEANUP ${index + 1}] ${errorMessage(error)}`)
          .join("\n"),
    );
    this.name = "CleanupCompositeError";
    this.primaryError = primaryError;
    this.cleanupErrors = cleanups;
    // Conserva AMBOS stacks: el del cuerpo y el de cada paso de cleanup.
    this.stack =
      this.name + ": " + this.message + "\n" +
      "[PRIMARY stack]\n" + errorStack(primaryError) + "\n" +
      cleanups
        .map((error, index) => `[CLEANUP ${index + 1} stack]\n${errorStack(error)}`)
        .join("\n");
  }
}

class CleanupOnlyCompositeError extends Error {
  constructor(cleanupErrors) {
    const cleanups = cleanupErrors.slice();
    super(
      "Cleanup failed (body succeeded) — cleanup errors:\n" +
        cleanups
          .map((error, index) => `[CLEANUP ${index + 1}] ${errorMessage(error)}`)
          .join("\n"),
    );
    this.name = "CleanupOnlyCompositeError";
    this.cleanupErrors = cleanups;
    this.stack =
      this.name + ": " + this.message + "\n" +
      cleanups
        .map((error, index) => `[CLEANUP ${index + 1} stack]\n${errorStack(error)}`)
        .join("\n");
  }
}

function combineCleanupErrors(primaryError, cleanupErrors) {
  const cleanups = (
    Array.isArray(cleanupErrors) ? cleanupErrors : [cleanupErrors]
  ).filter((error) => error !== undefined && error !== null);
  if (primaryError === undefined || primaryError === null) {
    if (cleanups.length === 0) return null; // éxito: ambos pasaron
    if (cleanups.length === 1) return cleanups[0]; // propagar cleanup tal cual
    return new CleanupOnlyCompositeError(cleanups);
  }
  if (cleanups.length === 0) return primaryError; // propagar cuerpo tal cual
  return new CleanupCompositeError(primaryError, cleanups);
}

module.exports = {
  combineCleanupErrors,
  CleanupCompositeError,
  CleanupOnlyCompositeError,
};