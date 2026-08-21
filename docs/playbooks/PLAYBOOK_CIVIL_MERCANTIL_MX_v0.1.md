# Playbook Civil/Mercantil MX v0.1 — Mike / recorrido Beta

Estado: especificación read-only, no asesoría para un caso real. Corte de base funcional: `IvanJS17/mike` en `aac256f69192a2a26ffa0502f92f608b8b003243`.

## 1. Alcance y límites

**Incluye:** revisión inicial de contratos civiles y mercantiles sujetos a derecho mexicano: partes y capacidad aparente, objeto, obligaciones, contraprestación, vigencia/terminación, incumplimiento/pena, responsabilidad, garantías, ley/jurisdicción y formalidades.

**Excluye:** laboral, fiscal, penal, amparo, litigación estratégica, opinión de validez definitiva, cálculo fiscal, análisis de hechos no contenidos en el documento y determinación de jurisprudencia aplicable. El resultado es un triage documentado; debe abstenerse cuando el texto o el contexto mínimo no permitan verificar un riesgo.

La base normativa federal se consulta en los textos vigentes de la Cámara de Diputados: Código Civil Federal (CCF) y Código de Comercio (CCom).[1][2] La página de reformas del CCom identifica como texto vigente el PDF oficial y una última reforma publicada el 18-02-2026.[2] **No se debe trasladar automáticamente el CCF a un contrato gobernado por un código civil local:** el playbook marca esa selección como revisión humana.

## 2. Regla de operación KISS

Cada hallazgo debe ser una observación verificable, no una conclusión jurídica absoluta. La salida usa severidad `critical|high|medium|low|info`, una cita al documento fuente y, cuando se invoca ley externa, una cita normativa separada. Si no existe texto suficiente, la salida obligatoria es `abstain` (no inferir, no completar con conocimiento general). La heurística se etiqueta `heuristic`; la ley se etiqueta `law`; no se mezclan.

### Taxonomía de 10 riesgos accionables

En todos los casos: `trigger` es una prueba reproducible sobre el documento; `evidence` es la cita que debe conservarse; `expected` es el hallazgo; `abstain` es la condición de no emitirlo; `example` es sintético.

| ID / riesgo | Trigger verificable | Evidencia/cita requerida | Severidad | Salida esperada | Abstención | Ejemplo sintético |
|---|---|---|---|---|---|---|
| R1 Partes/capacidad | Falta nombre legal, rol, firma, representación o facultades; o una parte no es identificable | Encabezado, definiciones, bloque de firmas y poder/anexo citado; si se afirma incapacidad, norma y hecho textual | high | `finding`: identidad/representación no verificable; pedir documento faltante | No afirmar incapacidad, nulidad o falta de poder sin cláusula/anexo | “Firma ‘ABC’ sin razón social ni representante.” |
| R2 Objeto | Objeto ausente, indeterminado, ilícito en apariencia documental o incompatible con anexos | Cláusula de objeto, SOW/anexo, entregables y exclusiones | high | Comparar objeto, anexos y aceptación; señalar ambigüedad concreta | No calificar ilicitud si el objeto está incompleto o fuera del documento | “Servicios descritos como ‘lo necesario’, sin entregables.” |
| R3 Obligaciones | Obligación sin responsable, estándar, plazo, dependencia, aceptación o remedio | Cláusulas de obligaciones, SLA, hitos, aceptación y matriz de responsabilidades | high | Lista de obligación + campo faltante + impacto operativo | No inferir obligación implícita ni estándar comercial | “Proveedor debe entregar ‘pronto’, sin fecha ni criterio.” |
| R4 Contraprestación | Precio, moneda, impuestos, facturación, vencimiento, reajuste o condición de pago falta o contradice otra cláusula | Precio/fees, órdenes, facturas, impuestos y pago | high | Señalar variable no determinada o conflicto; no calcular monto | No asumir IVA, moneda, interés o fórmula no escrita | “$100,000” en portada; “precio por definir” en anexo. |
| R5 Vigencia/terminación | Inicio/fin, renovación, aviso, causa, cura o efectos de terminación faltan o son incompatibles | Term, renewal, termination, survival, transición y avisos | high | Línea temporal y conflictos; marcar dependencia entre terminación y obligaciones sobrevivientes | No inventar plazo legal o derecho de terminación | “Renovación automática sin plazo para avisar.” |
| R6 Incumplimiento/pena | Incumplimiento no definido, pena sin evento/monto/límite, o remedios acumulados ambiguos | Default, cure, penalty/liquidated damages, intereses y remedios | high | Distinguir incumplimiento total, mora y cumplimiento defectuoso; advertir doble recuperación como riesgo a revisar | No afirmar exigibilidad ni compatibilidad de remedios sin texto y ley aplicable | “Pena diaria y daños ilimitados por el mismo retraso.” |
| R7 Responsabilidad | Cap, exclusiones, daños indirectos, indemnidad o carve-outs ausentes/contradictorios | Liability, indemnity, exclusions, insurance y survival | high | Tabla cap/carve-outs/indemnities; señalar asimetría textual como heurística | No declarar cláusula inválida ni “no mercado” sin fuente aplicable | “Cap de fees, pero indemnidad ilimitada sin alcance.” |
| R8 Garantías | Garantía, condición, alcance, plazo, exclusiones, ejecución o garantía real/personal no definidos | Warranties, security, guaranty, anexos, montos y releases | medium/high | Identificar qué garantiza quién, por cuánto y cómo se ejecuta | No presumir garantía legal o prioridad registral sin instrumento y jurisdicción | “Fiador mencionado, pero no firma ni obligación.” |
| R9 Ley/jurisdicción | Governing law, foro, arbitraje, sede, idioma o notificaciones faltan o son incompatibles | Governing law, dispute resolution, venue, arbitration y notices | high | Reportar foro/ley textuales y conflicto; escalar elección local/federal | No decir que un foro es válido, exclusivo o ejecutable sin revisión humana | “Ley mexicana; arbitraje con sede no indicada.” |
| R10 Formalidades | Ley/cláusula exige escrito, firma, forma electrónica, fedatario, registro o anexos y el expediente no los contiene | Firma, anexos, notarización, registro, mensajes/datos y versión | high | `missing_evidence` con pieza exacta; verificar integridad de versión | No concluir nulidad/inexistencia por falta de copia o firma no visible | “Contrato electrónico sin evidencia de aceptación/firma.” |

### Anclajes normativos mínimos (ley, no heurística)

- El CCF define convenio/contrato y sus requisitos de existencia y validez en arts. 1792–1797; el objeto aparece en arts. 1824 y siguientes.[1]
- El CCF permite cláusulas convenientes (art. 1839), regula pena convencional (arts. 1840–1843) y la opción entre cumplimiento o pena bajo el art. 1846; el motor debe citar el texto exacto antes de emitir una conclusión.[1]
- El CCF distingue daño, perjuicio y consecuencia inmediata/directa en arts. 2108–2110; la responsabilidad convencional aparece en art. 2117.[1]
- El CCom reputa actos de comercio (art. 75), obliga conforme a los términos pactados (art. 78), contempla contratación por medios electrónicos (arts. 80 y 89 bis), y contiene reglas mercantiles sobre morosidad, lugar de cumplimiento y pena (arts. 85, 86 y 88).[2]
- La SCJN tiene precedentes sobre pena convencional, pero su alcance depende de la norma, entidad y hechos: el registro 19880 trata una contradicción sobre el art. 1743 del Código Civil de Nuevo León y distingue pena sancionadora de compensatoria; no debe presentarse como regla general del CCF.[3] El registro 21028 reporta una contradicción sobre contratos mercantiles e incumplimiento parcial, con referencia al art. 88 CCom frente al art. 1846 CCF supletorio; debe verificarse el texto y ámbito antes de usarlo.[4]

## 3. Contrato exacto con el esquema Beta existente

No se inventan columnas ni entidades nuevas. El playbook emite un `ai_review_item` por riesgo material:

```json
{
  "item_key": "R6-pena-01",
  "original_text": "cita literal del contrato",
  "finding_text": "observación + impacto + abstención/limitación",
  "citation_refs": [
    {
      "citation_id": "R6-pena-01-c1",
      "document_version_id": "<version-id>",
      "page": 4,
      "span": {"start_char": 120, "end_char": 133},
      "quote": "texto literal",
      "quote_sha256": "<64 hex lowercase SHA-256 de quote exacto>",
      "verified": true
    }
  ],
  "status": "pending"
}
```

Contrato verificado en la base funcional:

- `ai_document_version_pages` conserva `document_id`, `document_version_id`, página, contenido y `content_sha256`, con integridad de pertenencia y hash (`backend/migrations/20260819_01_ai_executions_outputs_receipts.sql:18-33,94-121`).
- `ai_executions` fija workflow/version, `playbook_sha256`, documento/versión, hash de entrada y ruta de modelo; output Markdown, `citation_refs` y receipt canónico son insert-only (`..._01_ai_executions_outputs_receipts.sql:35-89,159-240`). El playbook debe congelarse y registrar su SHA-256 en `playbook_sha256`.
- `ai_reviews` exige ejecución `succeeded`, materia/proyecto coincidentes y revisor distinto del autor; `ai_review_items.citation_refs` es arreglo; la aprobación rechaza citas no verificadas y findings pendientes (`backend/migrations/20260819_02_ai_human_reviews.sql:7-39,67-107,129-172`).
- Decisiones son append-only con `before_state`/`after_state`; los RPC atómicos actualizan proyección y decisión juntas (`..._02_ai_human_reviews.sql:44-60`; `backend/migrations/20260819_04_ai_review_atomic_writes.sql:5-16,122-156`).
- Redline exige review aprobada, receipt ligado, documento/version/hash de origen, `citation_id` verificada, `item_id` aceptado/editado, offsets y `before_text_sha256`; no aplica cambios al DOCX por sí mismo (`backend/migrations/20260819_06_ai_review_redline_bundles.sql:6-27,114-203`).
- DOCX de informe solo se crea desde review aprobada, con source version y hash, filename exacto `Informe de revision humana.docx`, y `source='ai_review_report'` (`backend/migrations/20260819_05_ai_review_docx_reports.sql:5-36,86-120`).
- El parser legado de chat acepta `doc_id`, `page`, `quote` y hasta tres quotes, o citas de caso (`backend/src/lib/chat/citations.ts:7-39,76-95,120-173`). Ese parser es una ruta de presentación/compatibilidad; la ruta Beta de ejecuciones exige además `citation_id`, `document_version_id`, `span`, `quote_sha256`, `finding_text` y `verified` al resolver citas (`backend/src/lib/aiCitations.ts:120-156,175-186`).
- La ruta de ejecución instruye al proveedor a devolver `quote_sha256` como SHA-256 hexadecimal lowercase de 64 caracteres calculado sobre el extracto exacto (`backend/src/routes/aiExecutions.ts:303-309`), y persiste los campos resueltos en `citation_refs` del output (`backend/src/routes/aiExecutions.ts:544-569`). Las pruebas de integración verifican la instrucción del prompt y construyen `quote_sha256` con `sha256Hex(quote)` (`backend/src/__tests__/integration/aiExecutions.routes.test.ts:184-195,256-264`).
- Los informes humanos solo aceptan citas `verified=true` con hash lowercase de 64 caracteres y lo imprimen como `Quote SHA-256` (`backend/src/lib/aiReviewReports.ts:53-60,93-124,144-155`). El redline recalcula el hash del texto en los offsets, exige igualdad exacta con `quote` y rechaza si `quote_sha256` no coincide (`backend/src/lib/aiRedlineBundles.ts:157-186`); sus pruebas usan el hash del quote (`backend/src/__tests__/integration/aiRedlineBundles.routes.test.ts:60-69,185-195`).

**Corrección del supuesto:** `quote_sha256` no es una columna SQL independiente; es un campo obligatorio dentro de cada objeto de `citation_refs` JSON. La base sí conserva hashes de documento/output/receipt/origen/antes del texto en sus columnas, mientras que el hash del quote se valida en código: debe ser lowercase SHA-256 del `quote` exacto, derivado del slice indicado por `span.start_char/end_char`, y acompañarse de `verified=true`. Por ello no se agrega una columna ni migración para este campo; el PASS exige el objeto JSON completo y la validación de `aiCitations`, y el redline/report lo vuelven a comprobar.

## 4. Caso sintético de aceptación end-to-end

**Entrada:** versión `v1` de un MSA sintético; R4 detecta precio “por definir”; R6 detecta “pena de 1% diario” sin límite ni aclaración de cumplimiento total; R9 encuentra ley mexicana y foro Ciudad de México. Cada cita apunta a páginas de `v1`, incluye `span`, `quote` exacto, `quote_sha256` lowercase calculado sobre ese quote y `verified=true`; ninguna cita se crea sin texto literal.

**Flujo esperado:** ejecución `pending → running → succeeded` con output Markdown y receipt; se crea review con revisor distinto; tres items `pending`; el revisor rechaza R4 por falta de contexto, edita R6 a “verificar alcance y tope de pena” y acepta R9. Cada decisión inserta before/after; se completa review `approved` solo cuando no hay pending y todas las citas están verificadas. Se genera DOCX de informe con filename exacto y, únicamente para R6/R9 aceptados/editados, redline bundle con receipt, hash de documento, offsets y citas verificadas. R4 no produce redline.

**PASS:** alcance excluye materias prohibidas; 0–10 riesgos; cada finding tiene trigger/evidence/severity/expected/abstain/example; toda afirmación legal tiene fuente oficial y la heurística está etiquetada; cada cita tiene `citation_id`, `document_version_id`, página, span válido, quote exacto, `quote_sha256` lowercase SHA-256 del quote y `verified=true`; IDs y campos pasan constraints; hashes coinciden; review independiente aprobada; DOCX/redline solo nacen de review aprobada; receipt y versión son inmutables.

**FAIL:** inventa hechos o jurisprudencia; cita una norma sin conservar quote/document version; emite finding con texto ausente; omite `quote_sha256`, lo escribe en mayúsculas, no corresponde al hash SHA-256 lowercase del quote exacto, o lo trata como columna SQL; aprueba con cita no verificada/pending; genera DOCX o redline antes de aprobación; confunde precedente local con regla federal; o convierte triage en asesoría para un cliente.

Nota de verificación: se inspeccionó el commit `aac256f69192a2a26ffa0502f92f608b8b003243` y las rutas indicadas en el repositorio. Las referencias SCJN se reportan como precedentes con alcance condicionado; no se afirma jurisprudencia general más allá de lo que sus registros muestran.

## Sources

[1] https://www.diputados.gob.mx/LeyesBiblio/ref/ccf.htm — Código Civil Federal, Cámara de Diputados
[2] https://www.diputados.gob.mx/LeyesBiblio/ref/ccom.htm — Código de Comercio, Cámara de Diputados
[3] https://sjf2.scjn.gob.mx/detalle/ejecutoria/19880 — SCJN, precedente sobre pena convencional
[4] https://sjf2.scjn.gob.mx/detalle/ejecutoria/21028 — SCJN, contratos mercantiles y pena
