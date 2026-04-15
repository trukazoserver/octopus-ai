# Sistema de Plugins

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="80" />
</p>

Octopus AI tiene un sistema de plugins extensible que permite añadir funcionalidades sin modificar el código base.

---

## ¿Qué es un Plugin?

Un plugin es un módulo que añade comandos, integraciones o capacidades a Octopus AI. A diferencia de las Skills (que la IA crea automáticamente), los plugins son extensiones escritas por desarrolladores.

---

## Plugins Integrados

Octopus AI incluye 7 plugins oficiales listos para usar:

| Plugin | Descripción | Casos de uso |
|---|---|---|
| **productivity** | Tareas, calendario y notas | Gestión del día a día |
| **coding** | Code review, refactoring y debugging | Desarrollo de software |
| **research** | Búsqueda, papers y resúmenes | Investigación académica |
| **file-manager** | Operaciones de archivos | Leer, escribir, organizar archivos |
| **sales** | CRM, pipeline y follow-ups | Gestión comercial |
| **customer-support** | Tickets, respuestas y escalamiento | Atención al cliente |
| **data** | SQL, gráficos y ETL | Análisis de datos |

### Configuración

```json
{
  "plugins": {
    "directories": ["~/.octopus/plugins"],
    "builtin": ["productivity", "coding"]
  }
}
```

---

## Estructura de un Plugin

Un plugin es un directorio con al menos dos archivos:

```
mi-plugin/
├── plugin.json    # Manifiesto (metadatos)
└── index.js       # Punto de entrada (ESM)
```

### Manifiesto (plugin.json)

```json
{
  "name": "mi-plugin",
  "version": "1.0.0",
  "description": "Descripción de lo que hace este plugin",
  "author": "Tu Nombre",
  "dependencies": []
}
```

### API de Plugin

```typescript
import type { Plugin } from '@octopus-ai/core';

const plugin: Plugin = {
  manifest: {
    name: 'mi-plugin',
    version: '1.0.0',
    description: 'Mi plugin personalizado',
    author: 'desarrollador',
  },
  commands: [
    {
      name: '/mi-comando',
      description: 'Hace algo útil',
      execute: async (args) => {
        return `Resultado: ${args.join(' ')}`;
      },
    },
  ],
  mcpServers: [
    {
      command: 'node',
      args: ['mcp-server.js'],
    },
  ],
  onLoad: async () => {
    console.log('Plugin cargado');
  },
  onUnload: async () => {
    console.log('Plugin descargado');
  },
};

export default plugin;
```

### Componentes de un plugin

| Componente | Descripción |
|---|---|
| `manifest` | Metadatos del plugin (nombre, versión, descripción) |
| `commands` | Comandos personalizados que el usuario puede ejecutar |
| `mcpServers` | Servidores MCP (Model Context Protocol) para herramientas externas |
| `onLoad` | Función que se ejecuta al cargar el plugin |
| `onUnload` | Función que se ejecuta al descargar el plugin |

---

## Plugins y MCP (Model Context Protocol)

MCP es un protocolo que permite a la IA conectarse con herramientas y servicios externos de forma estandarizada.

### ¿Qué es MCP?

MCP (Model Context Protocol) es un estándar para que los modelos de IA interactúen con herramientas externas. Permite:

- Conectar con APIs externas
- Acceder a bases de datos
- Ejecutar herramientas de línea de comandos
- Integrarse con servicios de terceros

### Configurar un servidor MCP

Un plugin puede definir servidores MCP:

```typescript
mcpServers: [
  {
    command: 'node',
    args: ['servidor-mcp.js'],
    env: {
      API_KEY: 'tu-key'
    }
  }
]
```

---

## Gestionar Plugins desde la CLI

```bash
# Listar plugins instalados
node packages/cli/dist/index.js plugins list

# Buscar en el marketplace
node packages/cli/dist/index.js plugins search "database"

# Instalar un plugin
node packages/cli/dist/index.js plugins install mi-plugin

# Actualizar un plugin
node packages/cli/dist/index.js plugins update mi-plugin

# Desinstalar un plugin
node packages/cli/dist/index.js plugins uninstall mi-plugin
```

---

## Crear un Plugin Personalizado

### Paso 1: Crear la estructura

```bash
mkdir -p ~/.octopus/plugins/mi-plugin
cd ~/.octopus/plugins/mi-plugin
```

### Paso 2: Crear el manifiesto

Crea `plugin.json`:

```json
{
  "name": "mi-plugin",
  "version": "1.0.0",
  "description": "Mi primer plugin para Octopus AI",
  "author": "Tu Nombre",
  "dependencies": []
}
```

### Paso 3: Crear el punto de entrada

Crea `index.js`:

```javascript
export default {
  manifest: {
    name: 'mi-plugin',
    version: '1.0.0',
    description: 'Mi primer plugin para Octopus AI',
    author: 'Tu Nombre',
  },
  commands: [
    {
      name: '/saludar',
      description: 'Saluda al usuario',
      execute: async (args) => {
        const nombre = args[0] || 'amigo';
        return `¡Hola ${nombre}! Este es mi primer plugin.`;
      },
    },
  ],
  onLoad: async () => {
    console.log('Plugin "mi-plugin" cargado correctamente');
  },
  onUnload: async () => {
    console.log('Plugin "mi-plugin" descargado');
  },
};
```

### Paso 4: Instalar el plugin

```bash
node packages/cli/dist/index.js plugins install mi-plugin
```

O configura el directorio de plugins en la configuración:

```bash
node packages/cli/dist/index.js config set plugins.directories '["~/.octopus/plugins"]'
```

---

## Directorio de Plugins

Por defecto, Octopus busca plugins en:

| Ubicación | Descripción |
|---|---|
| `~/.octopus/plugins/` | Directorio de plugins del usuario |
| `packages/plugins/` | Plugins integrados del proyecto |

Puedes añadir más directorios:

```bash
node packages/cli/dist/index.js config set plugins.directories '["~/.octopus/plugins", "/ruta/a/mis/plugins"]'
```

---

## Siguientes Pasos

- 🧠 [Sistema de Memoria](./memory.md) — Cómo la IA recuerda información
- 🛠️ [Motor de Skills](./skills.md) — Habilidades auto-generadas
- ⚙️ [Configuración](../getting-started/configuration.md) — Ajustar el sistema de plugins
