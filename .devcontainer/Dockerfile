# Use the official Node.js image as base
# Using Node 20 LTS for stability
FROM node:20-bullseye

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

# Install global npm packages for development
# Note: yarn is already installed in node:20 image
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
