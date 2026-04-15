# Inicio Rápido

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

## 1. Verificar Instalación

```bash
node packages/cli/dist/index.js doctor
```

Todos los checks deben mostrar ✓. Si falla algo, ejecuta `node scripts/install.mjs`.

## 2. Enviar tu Primer Mensaje

```bash
node packages/cli/dist/index.js agent --message "Hola, ¿qué puedes hacer?" --stream
```

Esto envía un mensaje directamente al agente con streaming en tiempo real.

## 3. Chat Interactivo

```bash
node packages/cli/dist/index.js chat
```

Sesión interactiva continua con memoria de la conversación.

## 4. Explorar Comandos

```bash
# Ver todos los comandos disponibles
node packages/cli/dist/index.js --help

# Ver ayuda de un comando específico
node packages/cli/dist/index.js agent --help
```

## 5. Configurar Proveedores de IA

```bash
# Z.ai (proveedor por defecto)
node packages/cli/dist/index.js config set ai.providers.zhipu.apiKey "TU_KEY"

# OpenAI
node packages/cli/dist/index.js config set ai.providers.openai.apiKey "sk-..."

# Anthropic
node packages/cli/dist/index.js config set ai.providers.anthropic.apiKey "sk-ant-..."

# Ver configuración actual
node packages/cli/dist/index.js config get
```

## 6. Cambiar Modelo de Razonamiento

```bash
# Sin razonamiento (respuestas rápidas)
node packages/cli/dist/index.js config set ai.thinking "none"

# Razonamiento bajo
node packages/cli/dist/index.js config set ai.thinking "low"

# Razonamiento medio (por defecto)
node packages/cli/dist/index.js config set ai.thinking "medium"

# Razonamiento alto (más profundo)
node packages/cli/dist/index.js config set ai.thinking "high"
```

## 7. Gestión de Memoria

```bash
# Ver estadísticas de memoria
node packages/cli/dist/index.js memory stats

# Buscar recuerdos
node packages/cli/dist/index.js memory search "arquitectura del proyecto"

# Forzar consolidación (STM → LTM)
node packages/cli/dist/index.js memory consolidate
```

## 8. Skills (Habilidades)

```bash
# Listar skills instaladas
node packages/cli/dist/index.js skills list

# Crear nueva skill
node packages/cli/dist/index.js skills create mi-skill

# Explorar marketplace
node packages/cli/dist/index.js skills browse

# Importar skill desde archivo
node packages/cli/dist/index.js skills import ./mi-skill.json
```

## 9. Plugins

```bash
# Listar plugins instalados
node packages/cli/dist/index.js plugins list

# Buscar en marketplace
node packages/cli/dist/index.js plugins search "database"

# Instalar plugin
node packages/cli/dist/index.js plugins install email-automation
```

## 10. Multi-Canal

```bash
# Habilitar canales
node packages/cli/dist/index.js channels enable discord
node packages/cli/dist/index.js channels enable telegram

# Ver estado
node packages/cli/dist/index.js channels status
```

## Siguiente Paso

- [Configuración Completa](./configuration.md) — Todas las opciones disponibles
- [Arquitectura](../architecture/overview.md) — Entender el diseño del sistema
