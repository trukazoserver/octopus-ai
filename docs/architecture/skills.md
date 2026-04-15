# Motor de Skills (Skill Forge)

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="80" />
</p>

El Skill Forge es el sistema de Octopus AI para crear, mejorar y gestionar habilidades (skills) automáticamente.

---

## ¿Qué es una Skill?

Una Skill es una herramienta o capacidad que la IA puede utilizar para realizar tareas. Por ejemplo: analizar código, buscar archivos, generar documentos, etc.

Lo especial de Octopus AI es que **puede crear nuevas skills por sí mismo** cuando detecta que una tarea se repite, y **mejorar las existentes** si no funcionan bien.

---

## Ciclo de Vida de una Skill

```
1. Detección → La IA nota que una tarea compleja se repite
2. Creación  → Skill Forge genera código para la nueva skill
3. Validación → Un evaluador puntúa la skill (1-10)
4. Almacenamiento → Se guarda en el registro con embeddings
5. Carga     → Se carga según la tarea (lazy loading)
6. Uso       → Se ejecuta y se registran métricas de éxito/fracaso
7. Mejora    → Se auto-mejora si la tasa de éxito baja
```

### Detalle de cada fase

| Fase | Descripción |
|---|---|
| **Detección** | El analizador de tareas detecta que una tarea compleja podría beneficiarse de una skill dedicada |
| **Creación** | Skill Forge genera el código de la skill con auto-crítica (self-critique) |
| **Validación** | El evaluador de calidad puntúa la skill del 1 al 10. Mínimo requerido: 7 |
| **Almacenamiento** | Se guarda en el registro de skills con embeddings para búsqueda semántica |
| **Carga** | Se carga de forma perezosa (lazy) solo cuando la tarea es relevante |
| **Uso** | Se ejecuta y se registran métricas: tasa de éxito, valoración del usuario |
| **Mejora** | Si la tasa de éxito baja del 70%, se activa la mejora automática |

---

## Carga Progresiva (Progressive Loading)

Las skills se cargan por niveles para optimizar el uso de tokens:

| Nivel | Contenido cargado | Tokens aprox. | Cuándo se usa |
|---|---|---|---|
| **1** | Nombre + descripción | ~50 | Siempre (para decidir si es relevante) |
| **2** | + Instrucciones | ~500 | Cuando la tarea coincide con la skill |
| **3** | + Ejemplos de uso | ~1500 | Para tareas más complejas |
| **4** | + Plantillas + antipatrones | ~3000 | Para dominio completo de la skill |

Esto significa que Octopus no carga todo en memoria de golpe — solo carga lo necesario para cada tarea, ahorrando tokens y mejorando la velocidad.

---

## Skills Incluidas por Defecto

| Skill | Descripción |
|---|---|
| `general-reasoning` | Razonamiento general para cualquier tipo de tarea |
| `code-generation` | Generación, análisis y depuración de código |
| `writing` | Escritura y redacción de textos, emails, documentos |
| `research` | Investigación, búsqueda y síntesis de información |

### Gestionar skills desde la CLI

```bash
# Listar skills instaladas
node packages/cli/dist/index.js skills list

# Crear una nueva skill manualmente
node packages/cli/dist/index.js skills create "nombre-de-skill"

# Explorar el marketplace de skills
node packages/cli/dist/index.js skills browse

# Importar una skill desde un archivo JSON
node packages/cli/dist/index.js skills import ./mi-skill.json
```

---

## Auto-Mejora

El sistema de auto-mejora monitorea el rendimiento de cada skill y la mejora cuando es necesario.

### Criterios para activar la mejora

| Criterio | Valor | Descripción |
|---|---|---|
| Tasa de éxito baja | < 70% | La skill falla más del 30% de las veces |
| Valoración baja | < 3.5/5 | Los usuarios valoran mal la skill |
| Cada N usos | 10 | Revisión periódica cada 10 usos |
| Tiempo sin mejora | > 30 días | Se revisa si lleva mucho sin actualizarse |

### Proceso de mejora

1. Se analiza el historial de errores de la skill
2. Se genera una versión mejorada del código
3. Para cambios mayores, se ejecuta **A/B testing**:
   - Se divide el tráfico entre la versión antigua y la nueva
   - Tamaño de muestra: 20 usos (configurable)
   - La versión con mejor tasa de éxito se mantiene

### Configuración

```json
{
  "skills": {
    "enabled": true,
    "autoCreate": true,
    "autoImprove": true,
    "forge": {
      "complexityThreshold": 0.6,
      "selfCritique": true,
      "minQualityScore": 7,
      "includeExamples": true,
      "includeTemplates": true,
      "includeAntiPatterns": true
    },
    "improvement": {
      "triggerOnSuccessRate": 0.7,
      "triggerOnRating": 3.5,
      "reviewEveryNUses": 10,
      "abTestMajorChanges": true,
      "abTestSampleSize": 20
    },
    "loading": {
      "maxTokenBudget": 3000,
      "progressiveLevels": true,
      "autoUnload": true,
      "searchThreshold": 0.7
    }
  }
}
```

---

## A/B Testing

Los cambios mayores en skills se someten a pruebas A/B antes de ser aceptados:

1. Se crea una variante de la skill
2. Se divide el uso entre versión original (A) y nueva (B)
3. Se comparan tasas de éxito tras **20 usos** (configurable)
4. La versión ganadora reemplaza a la perdedora

Esto asegura que las "mejoras" realmente mejoren el resultado y no lo empeoren.

---

## Crear una Skill Manualmente

### Desde la CLI

```bash
node packages/cli/dist/index.js skills create "analizador-json"
```

### Estructura de una skill

```json
{
  "name": "analizador-json",
  "version": "1.0.0",
  "description": "Analiza y valida archivos JSON",
  "instructions": "Cuando el usuario pida analizar JSON...",
  "examples": [
    { "input": "Analiza este JSON", "output": "Estructura válida con 3 campos" }
  ],
  "templates": [],
  "antiPatterns": ["No modifiques el JSON original"]
}
```

---

## Siguientes Pasos

- 🧠 [Sistema de Memoria](./memory.md) — Cómo la IA recuerda información
- 🔌 [Sistema de Plugins](./plugins.md) — Extensiones y MCP
- ⚙️ [Configuración](../getting-started/configuration.md#motor-de-skills-habilidades) — Ajustar parámetros de skills
