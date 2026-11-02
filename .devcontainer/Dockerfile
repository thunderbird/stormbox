# Use the official Node.js image as base
FROM node:24-bookworm

# Install additional development tools, E2E browser runtime dependencies and
# global npm packages for development. Browser binaries are installed in
# postCreateCommand so they match the checked-out lockfile.
# Note: yarn is already installed in the official node image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    nano \
    python3 \
    python3-pip \
    vim \
    wget \
    && npx --ignore-scripts -y playwright@1.60.0 install-deps chromium firefox \
    && npm install -g --force --ignore-scripts \
    @vue/cli@5.0.9 \
    eslint@10.4.0 \
    nodemon@3.1.14 \
    npm@12.2.0 \
    pnpm@12.11.2 \
    prettier@3.9.10 \
    typescript@6.0.3 \
    vite@8.0.16 \
    # Clean up apt cache to reduce image size
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user for development
ARG USERNAME=node
ARG USER_UID=1000
ARG USER_GID=$USER_UID

# Ensure the node user has the correct UID/GID
RUN groupmod --gid "$USER_GID" "$USERNAME" \
    && usermod --uid "$USER_UID" --gid "$USER_GID" "$USERNAME" \
    && chown -R "$USER_UID:$USER_GID" "/home/$USERNAME"

# Set up workspace directory
WORKDIR /workspace

RUN mkdir -p /workspace/node_modules && chown -R "${USER_UID}:${USER_GID}" /workspace

# Copy package files for dependency installation
# This is done as a separate layer for better caching
COPY --chown=$USERNAME:$USERNAME package*.json ./

# Switch to non-root user
USER $USERNAME

# Set npm registry (optional - can be customized for private registries)
RUN npm config set registry https://registry.npmjs.org/

# Expose the Vite dev server port
EXPOSE 3000

# Default command
CMD ["npm", "run", "dev"]
