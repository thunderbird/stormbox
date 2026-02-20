# Stormbox Webmail

A Vue 3 email client using JMAP (JSON Meta Application Protocol) for email.

## Quick Start

### Recommended: Container

```bash
# Start dev container
podman run --name stormbox -p 8080:8080 --replace --pull=always -e JMAP_SERVER=mail.tb.pro ghcr.io/thunderbird/stormbox:latest
```

### Dev Container

The easiest way to get started is using the dev container which provides a consistent environment:

```bash
# Start the dev container
docker compose -f .devcontainer/docker-compose.yml up -d

# Open in VS Code with Dev Containers extension, or run commands directly:
docker compose -f .devcontainer/docker-compose.yml exec app npm run dev
```

Access the app at `http://localhost:3000`

### Local Setup (Alternative)

If you prefer local development:

```bash
# Clone and install
git clone <repository-url>
cd thundermail-vue
npm install

# Configure JMAP server (required)
export VITE_JMAP_SERVER_URL="https://your-jmap-server.com"

# Start development server
npm run dev
```

## Configuration

Set your JMAP server endpoint before running:

```bash
# Environment variable
export VITE_JMAP_SERVER_URL="https://your-jmap-server.com"

# Or create .env.local file
echo "VITE_JMAP_SERVER_URL=https://your-jmap-server.com" > .env.local
```

## Usage

1. **Login**: Enter your username and app password for the JMAP server
2. **Browse Mailboxes**: Use the sidebar to navigate between different mailboxes
3. **View Emails**: Click on emails in the message list to view their content
4. **Compose**: Click the "Compose" button to write new emails
5. **Reply/Delete**: Use the action buttons in the email detail view

## Building for Production

See [BUILD.md](BUILD.md) for production build instructions.

## Project Structure

```
src/
├── components/         # Vue components
├── composables/        # Vue composables (main business logic)
├── services/          # JMAP client service
├── assets/           # Global styles and CSS variables
├── App.vue          # Main application component
└── main.js         # Application entry point
```

## Key Dependencies

- **Vue 3**: Modern reactive framework with Composition API
- **Vite**: Fast build tool and dev server
- **JMAP**: JSON Meta Application Protocol for email
- **Quill.js**: Rich text editor for email composition
- **@tanstack/vue-query**: Syncing client/server data state
- **@tanstack/vue-virtual**: High-performance virtual scrolling

