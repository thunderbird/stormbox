# Dev Container Setup for Stormbox Webmail

This directory contains the development container configuration for the Stormbox Vue webmail client project.

## Quick Start

### Prerequisites

1. **Docker** installed on your machine
2. **Visual Studio Code** with the **Dev Containers extension** (ms-vscode-remote.remote-containers)
   - Or **Cursor** (has built-in dev container support)

### Getting Started

1. **Start the local mail stack** (Keycloak + Stalwart on the Docker host):

   ```bash
   cd thunderbird-accounts && docker compose up --build -d
   # One-time: http://localhost:8087 — admin@example.org / admin, provision Thundermail
   cd ../stormbox && npm run stack:seed
   npm run stack:ws-proxy &
   ```

   Dev defaults live in `.env.development` (local stack via Vite proxies, not stage).

2. **Open in VS Code or Cursor:**

   - Open the project folder in VS Code or Cursor
   - When prompted, click "Reopen in Container"
   - Or use Command Palette (F1) → "Dev Containers: Reopen in Container"

3. **First Time Setup:**

   - Container builds automatically (3-5 minutes on first run)
   - Dependencies install via `npm ci`
   - Dev server starts automatically on port 3000

4. **Access the Application:**
   - Open browser to **https://localhost:3000** (self-signed cert; accept once)
   - Hot module replacement (HMR) enabled

   To hit **stage** instead, unset local stack in `.env.local`:
   `VITE_LOCAL_STACK=0` and set `VITE_JMAP_SERVER_URL=https://wsmail.stage-thundermail.com`.

## Configuration Files

- **`devcontainer.json`**: Main dev container configuration

  - VS Code/Cursor extensions and settings for Vue 3 development
  - Port forwarding for Vite dev server
  - Automated setup commands

- **`Dockerfile`**: Development environment

  - Node.js 20 LTS base image
  - Development tools (git, build-essential, etc.)
  - Global npm packages (Vite, Vue CLI, ESLint, Prettier)

- **`docker-compose.yml`**: Container orchestration
  - Volume mounts for project files
  - Git and SSH key mounting
  - Environment variables for file watching

## Available Commands

Inside the container:

- `npm run dev` - Start Vite development server (auto-starts)
- `npm run build` - Build static files for production deployment
- `npm run preview` - Preview production build locally

## Troubleshooting

### Container Won't Start

- Verify Docker is running: `docker ps`
- Check port conflicts: `lsof -i :3000`
- Rebuild: F1 → "Dev Containers: Rebuild Container"

### JMAP Connection Issues

- Ensure `JMAP_SERVER_URL` is set in `.env.local`
- Verify CORS is configured on your JMAP server
- Check credentials are correct

## Updating

After configuration changes:

1. **Rebuild**: F1 → "Dev Containers: Rebuild Container"
2. **Clean rebuild**: F1 → "Dev Containers: Rebuild Container Without Cache"

## Resources

- [VS Code Dev Containers](https://code.visualstudio.com/docs/remote/containers)
- [Project README](../README.md)
- [Build Instructions](../BUILD.md)
