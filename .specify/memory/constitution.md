# Stormbox Constitution

## Core Principles

### I. Browser-Owned Mail Client

The system shall remain a fully in-browser webmail client with no
server-side mail application component. Self-hosters must be able to run
Stormbox against their own supported mail services without adding a
Stormbox-specific backend for mail storage or mail mutation handling.

### II. Local Cache as the Rendered Source

The system shall render mail UI from the local browser cache first, with
network sync filling or refreshing the cache in the background. The local
cache shall use browser storage backed by SQLite through the repository
and worker layers. Message bodies are cache data, not the durable source
of truth.

### III. Protocol and Layer Boundaries

The system shall target JMAP for the MVP mail protocol while preserving
room for future protocols. UI components and stores shall not call JMAP,
`fetch`, or protocol transports directly; protocol-specific behavior
belongs behind sync backends.

### IV. Single-Account MVP, Extensible Model

The MVP shall support a single active account. Data models and service
boundaries shall not assume that only one account or one account provider
will ever exist; future Thundermail and external accounts must remain
possible without rewriting core storage concepts.

### V. Earlybird-Ready User Value

The system shall prioritize the smallest webmail surface suitable for an
Earlybird audience alpha: reliable sign-in, reading mail, sending mail,
safe message display, basic message actions, and recipient autocomplete.
Features outside that scope should not displace core reading and sending
reliability.

## Technology Commitments

- The system shall use Vue 3 and Pinia for the frontend application.
- The system shall prefer services-ui components where they fit the
  interaction and accessibility requirements.
- The compose experience shall use Fastmail's Squire editor where
  practical, with a plain-text alternative available.
- Authentication shall support Keycloak OIDC for hosted/development
  flows and basic username/password authentication for self-hosters.
- The mail protocol for MVP delivery shall be JMAP, initially against
  Stalwart.

## Development Workflow

Specs live under `specs/NNN-feature/` and are governed by this
constitution. Agents should follow the Spec Kit flow:
`/speckit.constitution`, `/speckit.specify`, `/speckit.plan`,
`/speckit.tasks`, and `/speckit.implement`.

Implementation work must also follow `AGENTS.md`, especially the
container-only command rules and the E2E coverage requirements for
changes that mutate both the server and the local SQLite cache.

## Governance

This constitution is the source of project-wide product and architecture
constraints for Spec Kit work. Feature specs, plans, and tasks must call
out any conflict with this document before implementation begins.

Amendments require an explicit update to this file and should include the
reason the principle changed. Existing specs that depend on an amended
principle should be reviewed before work continues.

**Version**: 1.0.0 | **Ratified**: 2026-05-21 | **Last Amended**: 2026-05-21
