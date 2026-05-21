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
- Centro de control con estado del sistema
- Gestión visual de memoria, skills, tareas y automatizaciones
- Aprendizajes operacionales disponibles por API para auditoría y feedback
- Herramientas, variables, media y configuración desde la interfaz
- Diseño responsive (funciona en móviles y tablets)

---

## 🚀 Iniciar el Panel Web

### Método estable (instalación normal)

Desde la raíz del proyecto:

```bash
pnpm start
```

Esto inicia el backend compilado, la API HTTP/WebSocket y la UI web desde `packages/web/dist` en un solo puerto: `18789`.

Para iniciar y abrir el navegador automáticamente:

```bash
pnpm launch
```

### Método rápido (modo desarrollo frontend)

```bash
pnpm run start:web
```

Esto inicia solo Vite para el dashboard web en `http://localhost:3000`; requiere que el backend estable ya esté escuchando en `18789`.

### Método paso a paso

```bash
# 1. Asegúrate de que el proyecto está compilado
pnpm build

# 2. Iniciar el servidor backend
pnpm start

# 3. En otra terminal, iniciar el frontend
pnpm run start:web
```

---

## 🖥️ Acceso desde el Navegador

Una vez iniciado, abre tu navegador y ve a:

| URL | Descripción |
|---|---|
| `http://127.0.0.1:18789` | Panel web estable + API + WebSocket |
| `http://localhost:3000` | Panel web en desarrollo con Vite/HMR |

> **Navegadores soportados:** Chrome, Firefox, Safari, Edge (cualquier versión reciente).

---

## 🎯 Funcionalidades

### Chat en Tiempo Real

Envía mensajes al asistente y recibe respuestas con streaming. La interfaz muestra la respuesta generándose en tiempo real, igual que en ChatGPT.

### Gestión de Memoria

Visualiza y gestiona lo que Octopus AI recuerda:
- **Memoria a corto plazo:** Lo que la IA tiene en contexto ahora
- **Memoria a largo plazo:** Hechos, eventos y procedimientos almacenados
- **Resumen diario:** Actividad consolidada del día en curso
- **Perfil de usuario:** Idioma, estilo, preferencias y expertise detectados
- **Memoria procedural aprendida:** Procedimientos y antipatrones derivados de trabajos exitosos o fallidos
- **Centro de Memoria:** Métricas, grafo navegable, inspector de nodos, filtros por fuente, minimapa, foco por conexiones y navegación hacia la memoria fuente
- **Trazabilidad:** El runtime conserva una traza de las memorias utilizadas para explicar qué contexto influyó en una respuesta
- **Búsqueda:** Busca entre los recuerdos de la IA
- **Estadísticas:** Cuántos recuerdos tiene, tipo, antigüedad

### Workspace Operativo

La UI actual tambien incluye vistas específicas para:

- agentes y conversaciones
- tareas y automatizaciones
- herramientas y ejecución de código
- variables gestionadas y biblioteca multimedia

Los aprendizajes de `LearningEngine` se consultan por API en `/api/learning/insights`. Si detectas un aprendizaje incorrecto, puedes borrarlo con `DELETE /api/learning/insights/{id}` o enviar feedback con `POST /api/learning/feedback`.

### Configuración

Cambia la configuración de Octopus AI directamente desde la interfaz web sin necesidad de editar archivos JSON ni usar la terminal.

### Estado del Sistema

Monitorea el estado de:
- Proveedores de IA configurados
- Canales de mensajería conectados
- Uso de memoria y base de datos
- Conectividad de red
- Disponibilidad de tools y automatizaciones

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

3. Accede desde otro dispositivo: `http://TU_IP:18789`

### Con túnel (acceso desde cualquier lugar)

Puedes usar servicios como ngrok o Cloudflare Tunnel para exponer tu panel web temporalmente:

```bash
# Ejemplo con ngrok
ngrok http 18789
```

---

## 🔧 Solución de Problemas

### "No se puede acceder a 127.0.0.1:18789"

Verifica que el backend estable está corriendo:
```bash
pnpm start

# Windows
netstat -ano | findstr :18789

# macOS/Linux
lsof -i :18789
```

Si estás trabajando en desarrollo frontend y falla `localhost:3000`, verifica `pnpm run start:web`.

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
