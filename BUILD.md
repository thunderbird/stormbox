# Build Instructions

## Recommended: Build with Dev Container

```bash
# Start dev container
docker compose -f .devcontainer/docker-compose.yml up -d

# Build for production
docker compose -f .devcontainer/docker-compose.yml exec app npm run build
```

## Local Build

```bash
npm install
npm run build
```

## Configuration

Before building, configure your JMAP server endpoint:

```bash
# Set environment variable (required)
export JMAP_SERVER_URL="https://your-jmap-server.com"

# Then build
npm run build
```

Or create a `.env.local` file:

```
JMAP_SERVER_URL=https://your-jmap-server.com
```

## Output

Static files are generated in `dist/` directory and can be served from any web server.

## Deployment

Deploy the `dist/` directory to any static hosting service:

- AWS S3 + CloudFront
- Netlify
- Vercel
- GitHub Pages
- Any web server (Nginx, Apache, etc.)
