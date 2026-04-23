# Contributing to Octopus AI

¡Gracias por tu interés en contribuir a Octopus AI! 🐙

## 🚀 Quick Start

```bash
# 1. Fork y clonar
git clone https://github.com/tu-usuario/octopus-ai.git
cd octopus-ai

# 2. Instalar
pnpm run install:octopus

# 3. Crear una rama
git checkout -b feature/mi-mejora
```

## 📐 Estructura del Proyecto

```text
packages/
├── core/           # SDK principal — aquí van la mayoría de las contribuciones
│   └── src/
│       ├── agent/     # Runtime, reflexión, heartbeat, daemon
│       ├── ai/        # Proveedores de LLM (OpenAI, Anthropic, etc.)
│       ├── channels/  # Integraciones de mensajería
│       ├── config/    # Configuración y SOUL.md parser
│       ├── memory/    # STM, LTM, FTS5, user profiling
│       ├── plugins/   # Engine, MCP, marketplace
│       ├── skills/    # SkillForge, Improver, A/B testing
│       ├── storage/   # Database adapters
│       ├── tasks/     # Cron, automatizaciones
│       ├── team/      # Multi-agente, delegación, permisos
│       ├── tools/     # Herramientas del agente
│       └── utils/     # Logger, métricas, crypto
├── cli/            # Interfaz de terminal
├── desktop/        # App Electron
├── web/            # Dashboard React
└── plugins/        # Plugins oficiales
```

## 🎯 Áreas donde Puedes Contribuir

### 🔥 Alta Prioridad
- **Nuevos canales de mensajería** — Signal, Matrix, iMessage
- **Skills builtin** — Nuevas habilidades pre-construidas
- **Tests** — Mejorar la cobertura de pruebas
- **Documentación** — Guías, tutoriales, traducciones

### 🧩 Nuevas Features
- **Plugins** — Integraciones con servicios externos
- **Proveedores de IA** — Nuevos LLM providers
- **Tools** — Nuevas herramientas para el agente
- **UI** — Mejoras al dashboard web o app de escritorio

### 🐛 Bug Fixes
- Revisa los [Issues abiertos](https://github.com/trukazoserver/octopus-ai/issues)
- Reproduce, diagnostica y envía un fix

## 📝 Convenciones de Código

### TypeScript
- Usa **TypeScript estricto** — sin `any` excepto donde sea absolutamente necesario
- Usa `type` imports: `import type { Foo } from "./foo.js"`
- Extensiones `.js` en imports (ESM)
- Nombres descriptivos, sin abreviaciones crípticas

### Estilo
- Tabs para indentación
- Comillas dobles para strings
- Sin punto y coma (se usa la omisión de ASI)
- Documenta funciones públicas con JSDoc

### Commits
Usa [Conventional Commits](https://www.conventionalcommits.org/):
```
feat(memory): add FTS5 full-text search
fix(channels): telegram media handling crash
docs(readme): update provider list
refactor(agent): extract reflection engine
```

## 🏗️ Crear un Nuevo Componente

### Nuevo Proveedor de IA
1. Crear `packages/core/src/ai/providers/mi-proveedor.ts`
2. Extender `BaseLLMProvider`
3. Registrar en `packages/core/src/ai/router.ts`
4. Agregar tests

### Nuevo Canal de Mensajería
1. Crear directorio `packages/core/src/channels/mi-canal/`
2. Implementar la interfaz `Channel`
3. Registrar en `ChannelManager`

### Nuevo Tool
1. Crear `packages/core/src/tools/mi-tool.ts`
2. Usar `ToolDefinition` para definir el schema
3. Exportar una función `createMyTool()` en `tools/index.ts`

### Nuevo Skill Builtin
1. Crear `packages/core/src/skills/builtin/mi-skill.md`
2. Seguir el formato de skills existentes

## 🧪 Testing

```bash
# Ejecutar todos los tests
pnpm test

# Tests de un paquete específico
pnpm --filter @octopus-ai/core test

# Watch mode
pnpm --filter @octopus-ai/core test -- --watch
```

## 📋 Checklist de Pull Request

- [ ] La rama está actualizada con `main`
- [ ] Los tests pasan
- [ ] El código compila sin errores (`pnpm build`)
- [ ] Se agregaron tests para nuevas funcionalidades
- [ ] Se actualizó la documentación relevante
- [ ] El commit message sigue las convenciones
- [ ] El PR tiene una descripción clara

## 🔒 Seguridad

Si descubres una vulnerabilidad de seguridad, **no la publiques en Issues**. Envía un email a [security@octopus-ai.dev] con los detalles.

## ❓ Preguntas

- Abre un [Discussion](https://github.com/trukazoserver/octopus-ai/discussions)
- Únete a nuestro Discord (próximamente)

## 📄 Licencia

Al contribuir, aceptas que tus contribuciones estarán bajo la [Licencia MIT](LICENSE).

---

¡Gracias por hacer Octopus AI mejor! 🐙✨
