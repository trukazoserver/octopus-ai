# Sistema de Memoria

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="80" />
</p>

Octopus AI implementa un sistema de memoria inspirado en la memoria humana, con memoria a corto plazo (STM), memoria a largo plazo (LTM), resumen diario global y perfil persistente del usuario.

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
   Memoria a Largo Plazo (LTM) ← Hechos, eventos y procedimientos
        ↓ (recuperación)
   Contexto enriquecido para la IA → Respuesta personalizada
```

---

## Memoria a Corto Plazo (STM - Short-Term Memory)

La STM es la memoria "activa" — lo que la IA tiene fresco en su ventana de contexto durante una conversación.

| Parámetro | Valor por defecto | Descripción |
|---|---|---|
| `maxTokens` | 8192 | Tamaño máximo de la ventana de contexto |
| `scratchPadSize` | 2048 | Espacio reservado para razonamiento interno |
| `autoEviction` | `true` | Elimina información antigua cuando se llena |

### Cómo funciona

- Funciona como una **ventana deslizante**: los mensajes más recientes se mantienen
- Cuando se alcanza el límite de tokens, se elimina automáticamente lo más antiguo (**FIFO**)
- Incluye un "bloc de notas" de 2048 tokens donde la IA puede hacer cálculos y razonamientos
- La evicción automática está siempre activa por defecto

---

## Memoria a Largo Plazo (LTM - Long-Term Memory)

La LTM es el almacenamiento permanente donde se guardan los recuerdos importantes.

### Tipos de memoria

| Tipo | Descripción | Ejemplo |
|---|---|---|
| **Episódica** | Eventos y experiencias con contexto temporal | "El 15 de marzo discutimos sobre el proyecto X" |
| **Semántica** | Hechos y conocimientos del usuario | "María trabaja como diseñadora" |
| **Asociativa** | Relaciones entre recuerdos | "María → trabaja en → Proyecto X → usa React" |

### Capas adicionales del runtime actual

| Capa | Descripción | Archivo |
|---|---|---|
| **Resumen diario global** | Comprime los mensajes recientes del día en una narrativa breve reutilizable por el runtime | `daily.ts` |
| **Perfil de usuario** | Aprende estilo de comunicación, idioma preferido, expertise, decisiones y patrones de trabajo | `user-profile.ts` |

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
- **Contexto STM filtrado por conversación/canal** para no mezclar historiales activos distintos

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
- Dashboard/API: STM, resumen diario, perfil del usuario y memorias recientes

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
