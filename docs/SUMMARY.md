# Documentación de Octopus AI

<p align="center">
  <img src="../logo aplicacion.png" alt="Octopus AI" width="120" />
</p>

Asistente AI autoalojado con memoria persistente, automatizaciones autónomas y mensajería multicanal.

## Primeros Pasos

- [Instalación](./getting-started/installation.md) — Requisitos, instalador automático, manual y Docker
- [Inicio Rápido](./getting-started/quick-start.md) — Tu primera conversación con Octopus AI
- [Configuración](./getting-started/configuration.md) — Proveedores de IA, memoria, skills, canales
- [Guía de Docker](./getting-started/docker.md) — Instalación y despliegue con contenedores
- [App de Escritorio](./getting-started/desktop.md) — Compilar y usar la app Electron
- [Panel Web](./getting-started/web-dashboard.md) — Usar el dashboard desde el navegador

## Arquitectura

- [Visión General](./architecture/overview.md) — Monorepo, módulos y flujo de datos
- [Sistema de Memoria](./architecture/memory.md) — STM, LTM, consolidación, decaimiento
- [Agente Autónomo y Automatizaciones](./architecture/automation.md) — Daemon, heartbeat, cron, delegación y sandbox
- [Skill Forge](./architecture/skills.md) — Creación automática, mejora, A/B testing
- [Sistema de Plugins y MCP](./architecture/plugins.md) — Engine, Model Context Protocol, marketplace
- Canales de Comunicación — WhatsApp, Telegram, Discord, Slack
- Voz y Audio — Sistemas STT, TTS y Wake-words

## Referencia

- [Comandos CLI](./api/cli.md) — Referencia completa de todos los comandos
- [API HTTP y WebSocket](./api/http.md) — Health, memoria, skills, tools, tareas, canales y media

## Avanzado

- [Solución de Problemas](./advanced/troubleshooting.md) — Errores comunes, Docker, canales, FAQ
