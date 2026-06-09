# Use the official Node.js image as base

# We must keep node in this devcontainer pinned to 24:14, why?
# We need to use @playwright/test 1.59.0 because that is the latest version that is
# supported on BrowserStack / compatible with the latest browserstack-node-sdk (where
# we optionally run E2E tests). In playwright/test 1.59 and earlier there is a known bug
# where installing the playwright browsers hangs/fails if using node v24:15 or higher.
# It is fixed in playwright/test 1.60.0 but as mentioned we cannot upgrade to that yet.
# Therefore our only solution, in order to run tests in BrowserStack, is to use
# playwrignt/test 1.59.0 and ensure we use node 24:14 at the highest. Once a new
# browserstack-node-sdk is released that is compatible with @playwright/test 1.60+ then
# we can upgrade the browserstack-node-sdk and remove this pinned node version.
FROM node:24:14-bookworm

# Install additional development tools
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    vim \
    nano \
    build-essential \
    python3 \
    python3-pip \
    # Clean up apt cache to reduce image size
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Keep local E2E browser runtime dependencies in the image. Browser binaries
# are installed in postCreateCommand so they match the checked-out lockfile.
# Do NOT upgrade playwright as we need 1.59.0 as that is compatible with BrowserStack
RUN npx -y playwright@1.59.0 install-deps chromium firefox \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install global npm packages for development.
# Note: yarn is already installed in the official node image.
RUN npm install -g --force \
    npm@latest \
    pnpm \
    @vue/cli \
    vite \
    typescript \
    eslint \
    prettier \
    nodemon

# Create a non-root user for development
ARG USERNAME=node
ARG USER_UID=1000
ARG USER_GID=$USER_UID

# Ensure the node user has the correct UID/GID
RUN groupmod --gid $USER_GID $USERNAME \
    && usermod --uid $USER_UID --gid $USER_GID $USERNAME \
    && chown -R $USER_UID:$USER_GID /home/$USERNAME

# Set up workspace directory
WORKDIR /workspace

RUN mkdir -p /workspace/node_modules && chown -R ${USER_UID}:${USER_GID} /workspace

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
