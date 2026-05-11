# Motor de Aprendizaje Continuo

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="80" />
</p>

Octopus AI incluye un motor de aprendizaje continuo que registra trabajos reales, extrae patrones reutilizables y los usa como guía operacional en futuras tareas similares.

---

## Objetivo

El sistema no modifica el código base de forma automática. Aprende de forma controlada:

- qué procedimientos funcionaron
- qué herramientas fueron útiles
- qué fallos o antipatrones debe evitar
- cuándo una experiencia puede convertirse en una skill reutilizable
- cómo reforzar o mejorar skills existentes con métricas reales

Esto permite que Octopus mejore su comportamiento con el tiempo sin perder trazabilidad ni control humano.

---

## Flujo Principal

```text
Solicitud del usuario
        ↓
AgentRuntime ejecuta la tarea
        ↓
Se registra una ExperienceRecord
        ↓
LearningEngine evalúa resultado y confianza
        ↓
Extrae LearningInsight(s)
        ↓
Guarda insights en SQLite y memoria procedural
        ↓
En tareas futuras recupera guías relevantes
        ↓
Se inyectan como Learned Operating Guidance
```

---

## ExperienceRecord

Cada trabajo completado genera una experiencia con datos compactos:

| Campo | Descripción |
|---|---|
| `userRequest` | Solicitud original del usuario |
| `finalResponse` | Respuesta final entregada |
| `status` | `succeeded`, `failed`, `partial` o `unknown` |
| `confidence` | Confianza estimada de 0 a 1 |
| `toolsUsed` | Herramientas usadas, éxito/fallo y resumen |
| `skillsUsed` | Skills cargadas durante la tarea |
| `durationMs` | Duración aproximada de la ejecución |
| `metadata` | Bloqueadores, señales de evaluación y contexto adicional |

Las experiencias se guardan en la tabla `experiences`.

---

## LearningInsight

Los aprendizajes son piezas accionables derivadas de una experiencia:

| Tipo | Uso |
|---|---|
| `procedure` | Procedimiento recomendado para tareas similares |
| `tool_strategy` | Secuencia o estrategia de herramientas que produjo progreso |
| `anti_pattern` | Acción que debe evitarse si no hay nueva evidencia |
| `what_worked` | Enfoque exitoso reutilizable |
| `what_failed` | Fallo registrado para evitar repetirlo |
| `skill_candidate` | Señal de que conviene crear una skill |

Los insights se guardan en la tabla `learning_insights` con keywords, dominio, embedding, confianza, importancia y contador de uso.

---

## Recuperación en Contexto

Antes de responder, `AgentRuntime` consulta `LearningEngine.retrieveRelevant(message)`. Si hay aprendizajes suficientemente relevantes, los inyecta en el prompt como:

```text
# Learned Operating Guidance
- procedure: ...
- tool strategy: ...
- anti pattern: ...
```

El runtime aplica límites de cantidad y tokens para evitar contaminar el contexto. Por defecto carga hasta 5 insights y 1000 tokens.

---

## Relación con Memoria

Los insights de alta confianza también se almacenan como memorias `procedural` en la LTM con metadata:

```json
{
  "source": "learning_engine",
  "insightId": "...",
  "type": "procedure",
  "confidence": 0.9
}
```

Esto permite que el sistema de memoria semántica recupere procedimientos aprendidos aunque no se consulte directamente la tabla de learning.

---

## Relación con Skills

Cuando una skill participa en una tarea, el motor registra un `SkillUsage` con éxito o fallo. Después:

- actualiza métricas de éxito de la skill
- puede activar `SkillImprover` si hay fallos recurrentes
- puede activar `SkillForge` si hay varias experiencias similares exitosas

La creación automática de skills usa umbrales conservadores: no convierte una única experiencia aislada en una regla permanente.

---

## Feedback Humano

La API permite reforzar o corregir aprendizajes:

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/api/learning/insights` | Lista aprendizajes recientes |
| `POST` | `/api/learning/feedback` | Marca una experiencia como positiva o negativa |
| `DELETE` | `/api/learning/insights/{id}` | Borra un aprendizaje incorrecto |

Ejemplo:

```bash
curl -X POST http://localhost:18789/api/learning/feedback \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "conv_123",
    "rating": "positive",
    "comment": "La estrategia funcionó"
  }'
```

---

## Configuración

```json
{
  "learning": {
    "enabled": true,
    "autoReflect": true,
    "minConfidenceToStore": 0.65,
    "minConfidenceToInject": 0.55,
    "maxInsightsPerContext": 5,
    "maxContextTokens": 1000,
    "autoCreateSkills": true,
    "minSimilarSuccessesForSkill": 3,
    "retainFailedInsights": true
  }
}
```

| Parámetro | Descripción |
|---|---|
| `learning.enabled` | Activa o desactiva el aprendizaje continuo |
| `learning.autoReflect` | Permite extracción adicional con LLM cuando hay router disponible |
| `learning.minConfidenceToStore` | Confianza mínima para guardar aprendizajes |
| `learning.minConfidenceToInject` | Confianza mínima para inyectar aprendizajes en contexto |
| `learning.maxInsightsPerContext` | Máximo de insights por respuesta |
| `learning.maxContextTokens` | Presupuesto máximo de tokens para guía aprendida |
| `learning.autoCreateSkills` | Permite crear skills desde experiencias repetidas |
| `learning.minSimilarSuccessesForSkill` | Experiencias similares exitosas requeridas para crear skill |
| `learning.retainFailedInsights` | Guarda antipatrones derivados de fallos |

---

## Seguridad Operacional

- Las llamadas de aprendizaje son best-effort: si fallan, no bloquean la respuesta.
- Los aprendizajes tienen confianza e importancia, no son reglas absolutas.
- Los usuarios pueden borrar insights incorrectos por API.
- La auto-creación de skills requiere varias experiencias similares.
- No se ejecutan cambios automáticos al código fuente del repositorio.

---

## Siguientes Pasos

- [Sistema de Memoria](./memory.md) — Cómo se guardan memorias procedurales
- [Motor de Skills](./skills.md) — Cómo una experiencia puede convertirse en skill
- [API HTTP](../api/http.md) — Endpoints de feedback e inspección
