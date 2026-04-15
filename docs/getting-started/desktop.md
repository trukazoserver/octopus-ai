# App de Escritorio (Electron)

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Octopus AI incluye una aplicación de escritorio construida con Electron que te permite interactuar con el asistente desde una ventana nativa en tu sistema operativo.

---

## 📋 Tabla de Contenidos

- [¿Qué es la App de Escritorio?](#-qué-es-la-app-de-escritorio)
- [Requisitos](#-requisitos)
- [Compilar y Ejecutar](#-compilar-y-ejecutar)
- [Modo Desarrollo](#-modo-desarrollo)
- [Tecnologías Utilizadas](#-tecnologías-utilizadas)
- [Solución de Problemas](#-solución-de-problemas)

---

## 🖥️ ¿Qué es la App de Escritorio?

La app de escritorio es una interfaz nativa para Octopus AI que se ejecuta como una aplicación independiente en tu sistema. A diferencia del chat en terminal o el panel web, la app de escritorio:

- Tiene su propia ventana, como cualquier otra aplicación
- Se integra mejor con el sistema operativo
- Puede acceder a archivos locales directamente
- Funciona sin necesidad de abrir un navegador

> **Estado actual:** La app de escritorio está en desarrollo activo (v0.1.0). No tiene aún un instalador automatizado ni sistema de empaquetado para distribuir ejecutables.

---

## 📦 Requisitos

Además de los [requisitos generales de Octopus AI](./installation.md#-requisitos-del-sistema), necesitas:

| Requisito | Versión | Notas |
|---|---|---|
| **Electron** | 33.x | Se instala automáticamente con `pnpm install` |
| **Vite** | 8.x | Se instala automáticamente |
| **React** | 18.x/19.x | Se instala automáticamente |

No necesitas instalar nada adicional — todas las dependencias se instalan al ejecutar `pnpm install` en el proyecto raíz.

---

## 🔨 Compilar y Ejecutar

### Paso 1: Instalar Octopus AI completo

Primero necesitas el proyecto completo compilado:

```bash
git clone https://github.com/trukazoserver/octopus-ai.git
cd octopus-ai
pnpm run install:octopus
```

### Paso 2: Compilar el paquete desktop

```bash
# Compilar TypeScript del paquete desktop
cd packages/desktop
pnpm build
```

### Paso 3: Ejecutar en modo desarrollo

```bash
# Desde la raíz del proyecto
pnpm dev
```

Esto iniciará tanto el backend (Core) como el frontend de la app.

---

## 💻 Modo Desarrollo

### Compilación automática (watch)

Para desarrollo, puedes mantener la compilación en modo observador:

```bash
cd packages/desktop
pnpm dev
```

Esto recompila automáticamente cuando modificas archivos TypeScript.

### Estructura del paquete

```text
packages/desktop/
├── src/
│   ├── main/          # Proceso principal de Electron
│   └── renderer/      # Interfaz de usuario (React + Tailwind)
├── dist/              # Código compilado (TypeScript → JavaScript)
└── package.json
```

### Scripts disponibles

| Comando | Descripción |
|---|---|
| `pnpm build` | Compilar TypeScript (`tsc`) |
| `pnpm dev` | Compilar en modo observador (`tsc --watch`) |
| `pnpm typecheck` | Verificar tipos sin compilar |
| `pnpm lint` | Analizar código con Biome |
| `pnpm clean` | Eliminar la carpeta `dist/` |

---

## 🛠️ Tecnologías Utilizadas

| Tecnología | Uso |
|---|---|
| **Electron 33** | Framework de app de escritorio |
| **React** | Librería de interfaz de usuario |
| **Vite 8** | Bundler y servidor de desarrollo |
| **Tailwind CSS 4** | Framework de estilos |
| **TypeScript 5.8** | Lenguaje con tipos estáticos |

---

## 🔧 Solución de Problemas

### La app no abre una ventana

Verifica que Electron se instaló correctamente:

```bash
cd packages/desktop
ls node_modules/electron
```

Si no existe, ejecuta `pnpm install` desde la raíz del proyecto.

### Error al compilar TypeScript

```bash
# Verificar errores
cd packages/desktop
pnpm typecheck

# Si hay errores, limpiar y recompilar
pnpm clean
pnpm build
```

### La app no conecta con el backend

Asegúrate de que el servidor Core esté corriendo:

```bash
node packages/cli/dist/index.js start
```

El servidor debe estar en `http://127.0.0.1:18789`.

### Problemas en Linux

Si Electron no se ejecuta en Linux, instala las dependencias del sistema:

```bash
# Debian/Ubuntu
sudo apt install -y libgtk-3-dev libnotify-dev libxss1 libxtst6 libnss3 libasound2

# Fedora
sudo dnf install -y gtk3 libnotify libXScrnSaver libXtst nss alsa-lib
```

---

## Siguientes Pasos

- 🌐 [Panel Web](./web-dashboard.md) — Usar Octopus desde el navegador
- ⚙️ [Configuración](./configuration.md) — Ajustar el comportamiento de la app
- 🐳 [Docker](./docker.md) — Desplegar Octopus en un contenedor
