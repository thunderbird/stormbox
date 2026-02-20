FROM node:24 as builder

WORKDIR /workspace
COPY . .
RUN npm install && npm run build

# use slim with otel supported nginx
# less privilegs
FROM ghcr.io/nginx/nginx-unprivileged:1.29.3-alpine3.22-otel

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=0755 live-configure.sh /docker-entrypoint.d/90-stormbox-configure.sh
COPY --from=builder /workspace/dist/ /usr/share/nginx/html

ARG UID=101
USER root
RUN chown $UID:0 /usr/share/nginx/html/assets/index*.js
USER $UID
