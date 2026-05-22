# Stormbox Docs

This directory is the human entry point for project documentation.

## Architecture

- [Performance and architecture notes](architecture/performance.md): current
  runtime shape, cache behavior, and performance work.
- [SQLite storage design](architecture/sqlite-storage.md): local cache schema,
  sync state, and storage rationale.

## Spec-Driven Development

Stormbox uses GitHub Spec Kit for shared, IDE-agnostic specs.

- [Project constitution](../.specify/memory/constitution.md): project-wide
  product and architecture constraints.
- [Specs](../specs/): feature specs created through the Spec Kit workflow.
- [MVP scope spec](../specs/001-mvp-scope/spec.md): the first product-level
  spec, reframed from the original MVP planning document.

Shared Spec Kit artifacts (`.specify/` and `specs/`) are committed. Local
agent bindings, including `.cursor/skills/`, are per-developer setup and
remain ignored.

To install the local Cursor bindings for this repo:

```bash
uvx --from git+https://github.com/github/spec-kit.git@v0.4.4 \
  specify init --here --force --ai cursor-agent --ai-skills --offline
```

Contributors using another supported agent should pass that agent to `--ai`
instead.

## Research

[Research and benchmarks](../research/README.md) live outside `docs/` because
they include executable Playwright configs, specs, and benchmark scripts. Keep
research artifacts with their runner files and link to them from docs when
they inform architecture or product decisions.
