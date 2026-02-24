# Stormbox Development Conventions

## Vue Component Style

- Use `<script setup>` composition API for all components.
- SFC section order: `<script setup>`, `<template>`, `<style scoped>`.
- Never use the Options API (`export default { ... }`).

## State Management — Pinia

- All shared application state lives in Pinia stores under `src/stores/`.
- Stores use the composition-function syntax (`defineStore('id', () => { ... })`).
- Store files are named `<domain>-store.js` (e.g. `auth-store.js`, `email-store.js`).
- API calls that primarily set or retrieve store data may live inside store actions.

## Routing — Vue Router

- Routes are defined in `src/router/index.js`.
- URLs use human-readable folder names, not internal IDs (e.g. `/mailbox/inbox`, not `/mailbox/abc123`).
- Compose is a route: `/mailbox/:folderName/compose`.
- Navigation guards enforce authentication (redirect to `/login` when not connected).
- Unknown folder names fall back to `/mailbox/inbox`.

## Project Structure

```
src/
  components/    # Shared, reusable components (use props/emits)
  composables/   # Shared composable functions (UI concerns like useTheme)
  router/        # Vue Router configuration
  services/      # External service clients (JMAP, OIDC auth)
  stores/        # Pinia stores
  views/         # Page-level views, organized in folders
    LoginView/
    MailboxView/
  assets/        # CSS, images
  utils/         # Pure utility functions
```

## Views vs Components

- **Views** live in `src/views/<ViewName>/` folders. View-specific components are
  co-located in the same folder (e.g. `MailboxView/FolderList.vue`).
- Views are "inflexible" — they pull data directly from Pinia stores and call
  store actions. They do not accept props for data that comes from stores.
- **Shared components** live in `src/components/` and communicate via props and
  emits. Use these for truly reusable UI (e.g. `Avatar`).
- Prefer reading from stores in views over bubbling data through emits.
  From experience, it is easier to find where logic lives rather than to trace
  emits across component trees.

## Avatars

- Use [Libravatar](https://wiki.libravatar.org/api/) for avatar images, not Gravatar.
  Libravatar automatically proxies to Gravatar and supports federated avatar servers.

## Services

- JMAP client and OIDC auth live in `src/services/`.
- Configuration constants (server URLs, client IDs) live in `src/defines.js`
  and read from Vite environment variables with sensible defaults.
