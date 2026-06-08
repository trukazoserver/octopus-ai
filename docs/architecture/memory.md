# Sistema de Memoria

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="80" />
</p>

Octopus AI implementa un sistema de memoria inspirado en la memoria humana, con memoria a corto plazo (STM), memoria a largo plazo (LTM), knowledge base, resumen diario global, perfil persistente del usuario y una capa avanzada de orquestación con integridad, evidencia, scopes, feedback, recordatorios prospectivos e incertidumbre explícita.

---

## Visión General

A diferencia de los chatbots tradicionales que "olvidan" todo al cerrar la conversación, Octopus AI recuerda información importante de forma permanente. Esto se logra mediante una arquitectura de dos capas:

```text
Mensaje del usuario
        ↓
   Memoria a Corto Plazo (STM) ← Conversación activa
        ├── Resumen diario global ← Actividad reciente del día
        ├── Perfil del usuario ← Preferencias, idioma, expertise
        ↓ (consolidación automática)
   Memory Orchestrator ← integridad, evidencia, scopes, feedback
        ↓
    Memoria a Largo Plazo (LTM) ← hechos, eventos, procedimientos, usuario, org, agente, prospectiva
        ├── KnowledgeManager ← colecciones, items, chunks y búsqueda documental
        ├── Conversation Context Snapshots ← continuidad y ledger de tareas/chat
        ↓ (recuperación híbrida + presupuesto)
   ContextAssembler → Contexto enriquecido para la IA → Respuesta personalizada
```

---

## Memoria a Corto Plazo (STM - Short-Term Memory)

La STM es la memoria "activa" — lo que la IA tiene fresco en su ventana de contexto durante una conversación.

| Parámetro | Valor por defecto | Descripción |
|---|---|---|
| `maxTokens` | 8192 | Presupuesto de STM antes de evicción, no la ventana total del modelo |
| `scratchPadSize` | 2048 | Espacio reservado para razonamiento interno |
| `autoEviction` | `true` | Elimina información antigua cuando se llena |

### Cómo funciona

- Funciona como una **ventana deslizante**: los mensajes más recientes se mantienen
- Cuando se alcanza el límite de tokens, se elimina automáticamente lo más antiguo (**FIFO**)
- Incluye un "bloc de notas" de 2048 tokens donde la IA puede hacer cálculos y razonamientos
- La evicción automática está siempre activa por defecto

### Rolling Context y recuperación de agujas

Además de la STM tradicional, `RollingContextManager` protege conversaciones largas contra pérdida de contexto:

- Usa la ventana real del modelo activo, no un número fijo.
- Cuando el contexto llega al 80% de la ventana del modelo, resume la parte antigua.
- Conserva los últimos 20 turnos crudos sin resumir.
- El resumen acumulado se condensa cuando crece demasiado.
- Preserva tool outcomes, rutas, URLs, media IDs, comandos, errores y decisiones.
- Incluye una sección obligatoria `[Retrieval Hints]`.

`[Retrieval Hints]` funciona como mapa para buscar una aguja en un pajar. Contiene cadenas exactas como nombres de archivo, rutas, URLs, fragmentos de error, comandos, media IDs, frases del usuario y referencias `segment-message #NNN`.

Si el agente necesita un detalle exacto que no aparece en el resumen, debe usar la tool interna `recall_conversation` antes de adivinar. Esa tool busca en los mensajes crudos guardados de la conversación actual o, si se pide, en todas las conversaciones guardadas.

Ejemplos de búsqueda que el resumen puede sugerir:

```text
[Retrieval Hints]
- path: "packages/core/src/agent/runtime.ts" near segment-message #014
- error: "EPERM: operation not permitted" near segment-message #021
- user-phrase: "mata procesos viejos y reinicia todo" near segment-message #033
- media: "/api/media/file/..." near segment-message #041
```

Esto permite recuperar datos específicos aunque hayan quedado fuera del resumen denso.

---

## Memoria a Largo Plazo (LTM - Long-Term Memory)

La LTM es el almacenamiento permanente donde se guardan los recuerdos importantes.

### Tipos de memoria

| Tipo | Descripción | Ejemplo |
|---|---|---|
| **Episódica** | Eventos y experiencias con contexto temporal | "El 15 de marzo discutimos sobre el proyecto X" |
| **Semántica** | Hechos y conocimientos del usuario | "María trabaja como diseñadora" |
| **Procedural** | Procedimientos y estrategias reutilizables | "Para extraer imágenes, primero usar DOM" |
| **Usuario** | Preferencias, idioma, estilo y datos explícitos del usuario | "Edwin prefiere respuestas cortas en español" |
| **Organización** | Reglas y contexto de proyecto/equipo | "El proyecto usa React y Vite" |
| **Agente** | Lecciones internas del agente | "Evitar repetir una tool si falló dos veces" |
| **Prospectiva** | Recordatorios y compromisos futuros | "Recordar revisar el sprint mañana" |
| **Meta** | Información de control sobre memoria o sistema | "Cobertura baja en tema X" |

### Capas adicionales del runtime actual

| Capa | Descripción | Archivo |
|---|---|---|
| **Resumen diario global** | Comprime los mensajes recientes del día en una narrativa breve reutilizable por el runtime | `daily.ts` |
| **Perfil de usuario** | Aprende estilo de comunicación, idioma preferido, expertise, decisiones y patrones de trabajo | `user-profile.ts` |
| **Aprendizaje operacional** | Guarda procedimientos, antipatrones y estrategias de tools extraídas de trabajos reales | `learning/engine.ts` |
| **Knowledge base** | Indexa colecciones, texto, media y archivos en chunks buscables | `knowledge-manager.ts`, `knowledge-extractor.ts` |
| **Snapshots de contexto** | Persisten snapshots conversacionales y ledger de tareas/chat para continuidad y recuperación | `storage/migrations/010_*`, `011_*` |

### Parámetros

| Parámetro | Valor por defecto | Descripción |
|---|---|---|
| `backend` | `"sqlite-vss"` | Motor de búsqueda vectorial (SQLite con VSS) |
| `importanceThreshold` | `0.5` | Importancia mínima (0-1) para guardar un recuerdo |
| `maxItems` | `100000` | Máximo de recuerdos almacenados (100 mil) |

### Backend: SQLite-VSS

El sistema usa SQLite con la extensión VSS (Vector Similarity Search) para búsquedas semánticas. Esto permite:
- Buscar recuerdos por **significado**, no solo por palabras exactas
- Encontrar información relacionada aunque se exprese de forma diferente
- Operar completamente en local, sin depender de servicios externos

Adicionalmente, el core exporta `FTSSearchEngine`, un componente basado en SQLite FTS5 para despliegues que necesiten complementar la búsqueda vectorial con coincidencias exactas de texto.

---

## Orquestación Avanzada

La ruta avanzada de memoria está documentada en detalle en [Orquestación de Memoria](./memory-orchestration.md). Sus responsabilidades principales son:

| Componente | Responsabilidad |
|---|---|
| `MemoryIntegrityLayer` | Valida candidatos, detecta instrucciones maliciosas o datos sensibles y aplica redacciones antes de persistir |
| `MemoryOrchestrator` | Es la fachada central para escribir, leer, explicar, olvidar, aplicar feedback y mantener relaciones entre memorias |
| `ContextAssembler` | Ensambla un paquete de contexto dentro de un presupuesto de tokens y preserva secciones obligatorias |
| `ProactiveMemoryScanner` | Busca recordatorios prospectivos vencidos, próximos o pendientes |
| `UncertaintyEstimator` | Calcula `HIGH_CONFIDENCE`, `LOW_CONFIDENCE` o `NO_COVERAGE` según cobertura, confianza y gaps |

### Scopes y aislamiento

Cada memoria puede quedar asociada a `tenantId`, `userId`, `projectId`, `agentRole`, `sessionId` y `taskId`. Las lecturas avanzadas filtran antes de limitar candidatos, evitando que recuerdos de otro usuario o proyecto oculten los resultados correctos. También se respeta `timeRange` y `minTrustLevel`.

### Estados de memoria

Las memorias pueden estar en estado `active`, `expired`, `superseded`, `contradicted` o `user_deleted`. Las rutas públicas de LTM, búsqueda vectorial, FTS, listados recientes y UI ocultan memorias inactivas por defecto.

### Evidencia y trazabilidad

La arquitectura persiste:

- `memory_evidence`: origen y extracto que justifican una memoria.
- `memory_usage`: cuándo una memoria fue usada y en qué sesión/tarea.
- `memory_versions`: cambios, correcciones y borrados lógicos.
- `memory_edges`: relaciones `supersedes`, `contradicts` y otras conexiones.
- `memory_coverage`: cobertura por tópico y gaps conocidos.

`AgentRuntime.getLastMemoryTrace()` permite auditar qué memorias y recordatorios influyeron en la última respuesta.

---

## Consolidación (STM → LTM)

La consolidación es el proceso de transferir información importante de la memoria a corto plazo a la memoria a largo plazo.

### Cuándo ocurre

| Disparador | Descripción |
|---|---|
| **Fin de tarea** (`task-complete`) | Cuando la IA detecta que se completó una tarea explícita |
| **Inactividad** (`idleInterval: 30m`) | Tras 30 minutos sin actividad |
| **Manual** | Cuando ejecutas `memory consolidate` |

### Qué extrae durante la consolidación

| Tipo | Descripción |
|---|---|
| **Hechos (facts)** | Información objetiva: "María vive en Madrid" |
| **Eventos (events)** | Experiencias con contexto temporal: "Hoy discutimos el plan" |
| **Procedimientos (procedures)** | Instrucciones aprendidas: "Cuando María pide un resumen, prefiere viñetas" |
| **Aprendizajes operacionales** | Qué método funcionó o falló en trabajos previos: "Para extraer imágenes de producto, usar primero extracción DOM antes de hacer clic en miniaturas" |
| **Asociaciones** | Conexiones entre conceptos: "María → prefiere → viñetas" |

### Configuración

```json
{
  "consolidation": {
    "trigger": "task-complete",
    "idleInterval": "30m",
    "batchSize": 50,
    "extractFacts": true,
    "extractEvents": true,
    "extractProcedures": true,
    "buildAssociations": true
  }
}
```

---

## Decaimiento de la Memoria (Decay)

Los recuerdos no duran para siempre. Al igual que la memoria humana, los recuerdos que no se usan se desvanecen gradualmente.

| Tipo de memoria | Tasa de decaimiento | Comportamiento |
|---|---|---|
| **Episódica** | 0.3% diario sin acceso | Los eventos se olvidan más rápido |
| **Semántica** | 0.01% diario | Los hechos se olvidan muy lentamente |
| **Compresión** | Tras 30 días | Recuerdos episódicos similares se fusionan |
| **Edad máxima** | 365 días sin acceso | Se eliminan recuerdos muy antiguos no accedidos |

### Ejemplo práctico

- Dices "mi color favorito es el azul" → Memoria semántica, decae 0.01%/día
- Después de 100 días sin mencionar colores → Importancia reducida ~1%
- Si lo mencionas de nuevo → Importancia restaurada completamente

---

## Grafo de Conocimiento (Knowledge Graph)

Octopus AI construye un grafo de asociaciones entre recuerdos:

```
[María] --trabaja en--> [Proyecto X]
    |                        |
  usa React            tiene deadline mayo
    |                        |
[Frontend]         [Prioridad alta]
```

| Parámetro | Valor | Descripción |
|---|---|---|
| `cascadeDepth` | 2 niveles | Profundidad de búsqueda en el grafo |
| `cascadeThreshold` | 0.8 | Similitud mínima para seguir una asociación |
| Bidireccional | Sí | Si A → B, entonces B → A |

---

## Knowledge Base Documental

`KnowledgeManager` y `KnowledgeExtractor` complementan la memoria autobiográfica con conocimiento documental. La capa permite crear colecciones, agregar items desde texto, media o archivos, extraer chunks y buscarlos desde API o UI.

| Recurso | Descripción |
|---|---|
| Colecciones | Agrupan documentos o fuentes por proyecto, tema o workflow |
| Items | Representan una fuente concreta: texto directo, media registrada o archivo del workspace |
| Chunks | Fragmentos indexables usados por búsqueda y recuperación contextual |
| Metadata | Guarda origen, etiquetas, relación con media y trazabilidad |

Endpoints principales:

| Metodo | Ruta |
|---|---|
| `GET`/`POST` | `/api/memory/knowledge/collections` |
| `GET`/`DELETE` | `/api/memory/knowledge/collections/{id}` |
| `GET` | `/api/memory/knowledge/items` |
| `POST` | `/api/memory/knowledge/items/text` |
| `POST` | `/api/memory/knowledge/items/media` |
| `POST` | `/api/memory/knowledge/items/file` |
| `GET` | `/api/memory/knowledge/search` |

---

## Recuperación de Memoria (Retrieval)

Cuando la IA necesita recordar algo, usa un sistema de puntuación ponderada:

| Factor | Peso | Descripción |
|---|---|---|
| **Relevancia** | 50% | Qué tan relacionado está el recuerdo con la consulta actual |
| **Recencia** | 30% | Qué tan reciente es el recuerdo |
| **Frecuencia** | 20% | Cuántas veces se ha accedido a ese recuerdo |

| Parámetro | Valor | Descripción |
|---|---|---|
| `minRelevance` | `0.6` | Relevancia mínima para incluir un recuerdo |
| `maxResults` | `10` | Máximo recuerdos recuperados por consulta |
| `maxTokens` | `2000` | Máximo tokens de recuerdos inyectados en el contexto |

En el runtime actual, la recuperación de memorias se combina además con:

- **Resumen diario global** para mantener continuidad dentro del mismo día
- **Perfil del usuario** para ajustar idioma, tono, preferencias y expertise conocidos
- **Learned Operating Guidance** para recordar procedimientos y antipatrones aprendidos de ejecuciones anteriores
- **Contexto STM filtrado por conversación/canal** para no mezclar historiales activos distintos
- **Snapshots de contexto conversacional** para reconstruir continuidad después de runs largos, reinicios o workflows recuperados
- **Knowledge base documental** para incorporar colecciones, media y archivos al contexto bajo demanda
- **Búsqueda híbrida** vectorial + FTS con filtros de estado, scope, rango temporal y confianza
- **Recordatorios prospectivos** para compromisos pendientes o próximos
- **Known gaps** cuando la cobertura es insuficiente

---

## Cómo Afecta la Memoria al Usuario Final

### Lo que la IA recuerda automáticamente

- Tu nombre, profesión y preferencias
- Proyectos y temas que discutes frecuentemente
- Instrucciones que repites (ej: "siempre responde en español")
- Contexto de conversaciones anteriores
- Tu estilo de comunicación e idioma preferido
- Resumen operativo de lo ocurrido durante el día

### Lo que la IA NO recuerda

- Mensajes triviales ("hola", "gracias")
- Información por debajo del umbral de importancia (`0.5`)
- Recuerdos que han decaído completamente (>365 días sin acceso)

### Dónde inspeccionarlo

- CLI: `memory stats`, `memory search`, `memory consolidate`
- Dashboard/API: Centro de Memoria, STM, LTM, resumen diario, perfil del usuario, aprendizajes, grafo de memoria y memorias recientes

### Gestionar la memoria manualmente

```bash
# Ver estadísticas de memoria
node packages/cli/dist/index.js memory stats

# Buscar recuerdos específicos
node packages/cli/dist/index.js memory search "mi proyecto"

# Forzar consolidación inmediata
node packages/cli/dist/index.js memory consolidate
```

---

## Configurar el Comportamiento de la Memoria

### Desactivar la memoria

```bash
node packages/cli/dist/index.js config set memory.enabled false
```

### Aumentar la ventana de contexto

```bash
node packages/cli/dist/index.js config set memory.shortTerm.maxTokens 16384
```

### Hacer que recuerde más cosas (bajar el umbral)

```bash
node packages/cli/dist/index.js config set memory.longTerm.importanceThreshold 0.3
```

### Recuperar más recuerdos por consulta

```bash
node packages/cli/dist/index.js config set memory.retrieval.maxResults 20
```

---

## Siguientes Pasos

- 🛠️ [Motor de Skills](./skills.md) — Cómo la IA crea y mejora herramientas
- 🔌 [Sistema de Plugins](./plugins.md) — Extensiones y MCP
- ⚙️ [Configuración](../getting-started/configuration.md#sistema-de-memoria) — Ajustar parámetros de memoria
