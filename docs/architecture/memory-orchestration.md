# Orquestación de Memoria

La orquestación de memoria es la capa que convierte la memoria persistente de Octopus AI en un sistema auditable, seguro y útil para agentes autónomos. Su objetivo es que el agente no solo "recuerde", sino que pueda explicar por qué recuerda algo, de dónde salió, qué tan confiable es y si debe usarse en la respuesta actual.

## Objetivos

- Evitar persistir datos sensibles, instrucciones maliciosas o recuerdos de baja confianza.
- Separar recuerdos por tenant, usuario, proyecto, rol de agente, sesión y tarea.
- Combinar búsqueda vectorial, FTS y señales de uso sin exponer memorias inactivas.
- Preservar memoria crítica de usuario y recordatorios prospectivos dentro del presupuesto de tokens.
- Registrar evidencia, uso, versiones y relaciones para auditoría posterior.
- Detectar incertidumbre y gaps antes de que el agente afirme algo sin cobertura suficiente.

## Componentes

| Componente | Archivo | Rol |
|---|---|---|
| `MemoryIntegrityLayer` | `packages/core/src/memory/integrity.ts` | Valida candidatos, detecta patrones inseguros, redacciona secretos y registra auditoría |
| `MemoryOrchestrator` | `packages/core/src/memory/orchestrator.ts` | Fachada central de escritura, lectura, feedback, forgetting, evidencia, usage y relaciones |
| `ContextAssembler` | `packages/core/src/memory/context-assembler.ts` | Ensambla el contexto final con presupuesto de tokens y secciones obligatorias |
| `ProactiveMemoryScanner` | `packages/core/src/memory/proactive-scanner.ts` | Detecta recordatorios pendientes, próximos o vencidos |
| `UncertaintyEstimator` | `packages/core/src/memory/uncertainty.ts` | Estima confianza global y gaps conocidos |
| `FTSSearchEngine` | `packages/core/src/memory/fts-search.ts` | Complementa la búsqueda vectorial con coincidencia lexical exacta |

## Flujo de Escritura

```text
MemoryCandidate
      ↓
MemoryIntegrityLayer.validate()
      ├── bloquea instrucciones peligrosas
      ├── redacciona secretos/API keys/tokens
      └── aplica confidenceCap
      ↓
MemoryOrchestrator.write()
      ├── normaliza scope
      ├── busca duplicados activos dentro del mismo scope
      ├── refuerza duplicados o crea MemoryItem
      ├── registra evidencia
      ├── aplica supersedes/contradicts
      └── actualiza coverage
```

### Candidatos de memoria

Un candidato debe incluir:

- `type`: `episodic`, `semantic`, `procedural`, `user`, `org`, `agent`, `prospective` o `meta`.
- `content`: contenido normalizado y redactado antes de persistir.
- `sourceTrust`: `external`, `user_inferred`, `user_explicit`, `agent` o `system`.
- `scope`: `tenantId`, `userId`, `projectId`, `agentRole`, `sessionId` y `taskId` cuando estén disponibles.
- `evidence`: tipo de fuente, identificador y extracto usado para justificar la memoria.

## Flujo de Lectura

```text
Objetivo del usuario
      ↓
ContextAssembler.assemble()
      ↓
MemoryOrchestrator.read()
      ├── embedding(query)
      ├── retrieval vectorial filtrado por scope/estado antes del límite
      ├── búsqueda híbrida FTS + vector
      ├── filtro por tenant/user/project/agent/timeRange/minTrustLevel
      ├── estimación de incertidumbre
      └── selección por presupuesto de tokens
      ↓
ProactiveMemoryScanner.scan()
      └── recordatorios prospectivos
      ↓
ContextAssembler.degradeToBudget()
      ├── conserva user_memory
      ├── conserva prospective_reminders
      ├── recorta episodios similares
      └── recorta agent_lessons si hace falta
      ↓
AgentRuntime.buildContext()
```

## Aislamiento por Scope

Las lecturas avanzadas aplican filtros antes de limitar candidatos. Esto evita que memorias de otro usuario o proyecto consuman el `maxReadCandidates` y oculten los resultados correctos.

| Campo | Uso |
|---|---|
| `tenantId` | Aislamiento principal de instalación, organización o workspace |
| `userId` | Preferencias y datos del usuario actual |
| `projectId` | Contexto de proyecto o repositorio |
| `agentRole` | Lecciones específicas de un agente o rol |
| `sessionId` | Conversación/canal actual |
| `taskId` | Tarea específica que originó la memoria |
| `timeRange` | Ventana temporal permitida para recuperación |
| `minTrustLevel` | Umbral mínimo de confianza de origen |

## Estados de Memoria

| Estado | Significado | Visibilidad por defecto |
|---|---|---|
| `active` | Memoria usable | Visible |
| `expired` | Memoria vencida por TTL o forgetting activo | Oculta |
| `superseded` | Reemplazada por una memoria nueva | Oculta |
| `contradicted` | Contradicha por información posterior | Oculta en rutas normales |
| `user_deleted` | Borrado lógico solicitado por usuario | Oculta |

Las rutas legacy (`listRecent`, `listAll`, `search`) y FTS ocultan memorias inactivas por defecto. Para auditoría interna, `listAll(limit, { includeInactive: true })` puede recuperar también estados inactivos.

## Integridad y Redacción

`MemoryIntegrityLayer` protege la persistencia contra:

- Instrucciones que intentan cambiar reglas del sistema.
- Texto que pide recordar permisos inexistentes.
- Tokens, API keys, private keys y secretos similares.
- Candidatos sin confianza suficiente.

Cuando detecta secretos, redacciona el contenido y reduce el techo de confianza. Cuando detecta patrones incompatibles con una memoria segura, bloquea la escritura y registra el evento en `memory_integrity_log`.

## Evidencia, Usage y Explicabilidad

La arquitectura escribe tablas auxiliares para poder auditar decisiones:

| Tabla | Contenido |
|---|---|
| `memory_evidence` | Fuente y extracto que justifican la memoria |
| `memory_usage` | Sesión, tarea, rol y momento donde una memoria fue recuperada |
| `memory_versions` | Cambios por corrección, borrado o forgetting |
| `memory_edges` | Relaciones `supersedes`, `contradicts` u otras |
| `memory_coverage` | Cobertura por tópico, distribución de confianza y gaps |

`AgentRuntime.getLastMemoryTrace()` devuelve una traza con:

- `responseId`
- objetivo del usuario
- canal
- nivel de incertidumbre
- IDs de memorias usadas
- gaps conocidos
- avisos proactivos
- secciones degradadas por presupuesto

`AgentRuntime.explainLastMemoryUsage()` usa esa traza para recuperar evidencia y usage histórico de las memorias involucradas.

## Incertidumbre

`UncertaintyEstimator` produce tres niveles:

| Nivel | Uso |
|---|---|
| `HIGH_CONFIDENCE` | Hay cobertura suficiente, memorias relevantes y confianza aceptable |
| `LOW_CONFIDENCE` | Hay alguna señal, pero la cobertura o confianza es débil |
| `NO_COVERAGE` | No hay memoria confiable para el objetivo actual |

Cuando el nivel es bajo o nulo, el contexto incluye `knownGaps` para que el agente evite inventar recuerdos.

## Recordatorios Prospectivos

Las memorias `prospective` representan compromisos futuros o pendientes. Pueden incluir:

- `dueAt`: fecha/hora de vencimiento.
- `triggerCondition`: condición textual que activa el recordatorio.
- `prospectiveStatus`: `pending`, `fulfilled` o `expired`.

`ProactiveMemoryScanner` genera avisos como:

- `Vencido hace 3h: ...`
- `Próximo en 12h: ...`
- `Pendiente para 2026-05-18T09:00:00.000Z: ...`

## Centro de Memoria en la UI

El dashboard web expone un Centro de Memoria con:

- Tarjetas de métricas para LTM, STM, conexiones, aprendizajes y perfil.
- Grafo navegable de recuerdos, aprendizajes, perfil, diario y STM.
- Filtros por fuente.
- Inspector de nodo con contenido, tipo, peso, keywords y conexiones.
- Navegación directa desde un nodo hacia su tab fuente.
- Mini mapa, zoom y modo de foco por vecinos.
- Paneles de salud de memoria, conceptos activos, resumen diario y aprendizajes recientes.

## Validación Recomendada

Para cambios en esta capa ejecutar:

```bash
pnpm --filter @octopus-ai/core test -- memory-systems.test.ts agent-runtime.test.ts
pnpm --filter @octopus-ai/core typecheck
pnpm --filter @octopus-ai/web typecheck
pnpm --filter @octopus-ai/web lint
```

Antes de publicar en GitHub ejecutar matriz completa:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Archivos Relacionados

- `packages/core/src/memory/types.ts`
- `packages/core/src/memory/orchestrator.ts`
- `packages/core/src/memory/integrity.ts`
- `packages/core/src/memory/context-assembler.ts`
- `packages/core/src/memory/proactive-scanner.ts`
- `packages/core/src/memory/uncertainty.ts`
- `packages/core/src/memory/fts-search.ts`
- `packages/core/src/agent/runtime.ts`
- `packages/cli/src/bootstrap.ts`
- `packages/web/src/pages/memory.tsx`
