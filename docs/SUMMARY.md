# Documentación de Octopus AI

<p align="center">
  <img src="../logo aplicacion.png" alt="Octopus AI" width="120" />
</p>

Asistente AI autoalojado con memoria persistente, aprendizaje continuo, automatizaciones autónomas y mensajería multicanal.

## Primeros Pasos

- [Instalación](./getting-started/installation.md) — Instalador interactivo-saltable, modo automático, manual y Docker
- [Inicio Rápido](./getting-started/quick-start.md) — Tu primera conversación con Octopus AI
- [Configuración](./getting-started/configuration.md) — Proveedores de IA, memoria, aprendizaje, skills, canales
- [Guía de Docker](./getting-started/docker.md) — Instalación y despliegue con contenedores
- [App de Escritorio](./getting-started/desktop.md) — Compilar y usar la app Electron
- [Panel Web](./getting-started/web-dashboard.md) — Usar el dashboard desde el navegador

## Arquitectura

- [Visión General](./architecture/overview.md) — Monorepo, módulos y flujo de datos
- [Sistema de Memoria](./architecture/memory.md) — STM, rolling context, `recall_conversation`, LTM, consolidación, decaimiento y memoria procedural
- [Orquestación de Memoria](./architecture/memory-orchestration.md) — Integridad, scopes, evidencia, incertidumbre, contexto avanzado y Centro de Memoria
- [Motor de Aprendizaje](./architecture/learning.md) — Experiencias, insights, feedback y auto-mejora controlada
- [Agente Autónomo, Workflows y Automatizaciones](./architecture/automation.md) — Daemon, heartbeat, cron, coordinación multi-agente, recovery y sandbox
- [Skill Forge](./architecture/skills.md) — Creación automática, mejora, A/B testing
- [Sistema de Plugins y MCP](./architecture/plugins.md) — Engine, Model Context Protocol, marketplace
- Canales de Comunicación — WhatsApp, Telegram, Discord, Slack
- Voz y Audio — Sistemas STT, TTS y Wake-words

## Referencia

- [Comandos CLI](./api/cli.md) — Referencia completa de todos los comandos
- [API HTTP y WebSocket](./api/http.md) — Health, auth, memoria, agentes, workflows, learning, skills, tools, canales y media

## Avanzado

- [Solución de Problemas](./advanced/troubleshooting.md) — Errores comunes, Docker, canales, FAQ
