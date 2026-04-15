# Panel Web (Web Dashboard)

<p align="center">
  <img src="../../logo aplicacion.png" alt="Octopus AI" width="100" />
</p>

Octopus AI incluye un panel web moderno construido con React y Vite que te permite interactuar con el asistente desde tu navegador.

---

## 📋 Tabla de Contenidos

- [¿Qué es el Panel Web?](#-qué-es-el-panel-web)
- [Iniciar el Panel Web](#-iniciar-el-panel-web)
- [Acceso desde el Navegador](#-acceso-desde-el-navegador)
- [Funcionalidades](#-funcionalidades)
- [Configuración del Servidor](#-configuración-del-servidor)
- [Acceso Remoto](#-acceso-remoto)
- [Solución de Problemas](#-solución-de-problemas)

---

## 🌐 ¿Qué es el Panel Web?

El panel web es una interfaz gráfica para Octopus AI que se ejecuta en tu navegador. Te ofrece una experiencia visual completa sin necesidad de usar la terminal.

**Características:**
- Interfaz de chat con mensajes en tiempo real (streaming)
- Gestión visual de la memoria (ver qué recuerda la IA)
- Configuración desde la interfaz
- Diseño responsive (funciona en móviles y tablets)

---

## 🚀 Iniciar el Panel Web

### Método rápido (modo desarrollo)

Desde la raíz del proyecto:

```bash
pnpm dev
```

Esto inicia dos procesos simultáneamente:
1. **Servidor Backend** (Core de Octopus AI) — Puerto 18789
2. **Servidor Frontend** (Dashboard Web) — Puerto 5173

### Método paso a paso

```bash
# 1. Asegúrate de que el proyecto está compilado
pnpm build

# 2. Iniciar el servidor backend
node packages/cli/dist/index.js start

# 3. En otra terminal, iniciar el frontend
cd packages/web
pnpm dev
```

---

## 🖥️ Acceso desde el Navegador

Una vez iniciado, abre tu navegador y ve a:

| URL | Descripción |
|---|---|
| `http://localhost:5173` | Panel web (interfaz de usuario) |
| `http://localhost:18789` | API del servidor backend |

> **Navegadores soportados:** Chrome, Firefox, Safari, Edge (cualquier versión reciente).

---

## 🎯 Funcionalidades

### Chat en Tiempo Real

Envía mensajes al asistente y recibe respuestas con streaming. La interfaz muestra la respuesta generándose en tiempo real, igual que en ChatGPT.

### Gestión de Memoria

Visualiza y gestiona lo que Octopus AI recuerda:
- **Memoria a corto plazo:** Lo que la IA tiene en contexto ahora
- **Memoria a largo plazo:** Hechos, eventos y procedimientos almacenados
- **Búsqueda:** Busca entre los recuerdos de la IA
- **Estadísticas:** Cuántos recuerdos tiene, tipo, antigüedad

### Configuración

Cambia la configuración de Octopus AI directamente desde la interfaz web sin necesidad de editar archivos JSON ni usar la terminal.

### Estado del Sistema

Monitorea el estado de:
- Proveedores de IA configurados
- Canales de mensajería conectados
- Uso de memoria y base de datos
- Conectividad de red

---

## ⚙️ Configuración del Servidor

La configuración del servidor se almacena en `~/.octopus/config.json`:

```json
{
  "server": {
    "port": 18789,
    "host": "127.0.0.1",
    "transport": "auto"
  }
}
```

### Cambiar el puerto

```bash
node packages/cli/dist/index.js config set server.port 8080
```

### Cambiar el host

Por defecto, el servidor escucha en `127.0.0.1` (solo accesible desde tu máquina). Para permitir acceso desde otros dispositivos en tu red:

```bash
node packages/cli/dist/index.js config set server.host "0.0.0.0"
```

> **⚠️ Seguridad:** Exponer el servidor a `0.0.0.0` lo hace accesible desde cualquier dispositivo en tu red. Asegúrate de confiar en tu red local.

---

## 🌍 Acceso Remoto

Si quieres acceder al panel web desde otro dispositivo (por ejemplo, tu móvil):

### En tu red local

1. Configura el host a `0.0.0.0`:
   ```bash
   node packages/cli/dist/index.js config set server.host "0.0.0.0"
   ```

2. Encuentra la IP de tu máquina:
   ```bash
   # Windows
   ipconfig

   # macOS/Linux
   ifconfig
   # o
   hostname -I
   ```

3. Accede desde otro dispositivo: `http://TU_IP:5173`

### Con túnel (acceso desde cualquier lugar)

Puedes usar servicios como ngrok o Cloudflare Tunnel para exponer tu panel web temporalmente:

```bash
# Ejemplo con ngrok
ngrok http 5173
```

---

## 🔧 Solución de Problemas

### "No se puede acceder a localhost:5173"

Verifica que el frontend está corriendo:
```bash
# ¿Está el proceso activo?
# Windows
netstat -ano | findstr :5173

# macOS/Linux
lsof -i :5173
```

### El chat no responde

1. Verifica que el backend está corriendo:
   ```bash
   node packages/cli/dist/index.js doctor
   ```

2. Comprueba que tienes API Keys configuradas:
   ```bash
   node packages/cli/dist/index.js config get ai.providers.zhipu.apiKey
   ```

### Error en la compilación del frontend

```bash
cd packages/web
pnpm clean
pnpm build
```

### La página se ve mal o no carga estilos

Limpia la caché del navegador: `Ctrl + Shift + R` (o `Cmd + Shift + R` en Mac).

---

## Siguientes Pasos

- 💬 [Inicio Rápido](./quick-start.md) — Tu primera conversación
- ⚙️ [Configuración](./configuration.md) — Ajustar modelos y memoria
- 🖥️ [App de Escritorio](./desktop.md) — Usar la app nativa
- 🐳 [Docker](./docker.md) — Desplegar con contenedores
