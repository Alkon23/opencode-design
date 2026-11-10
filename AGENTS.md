# opencode-design

Standalone OpenCode V2 server plugin. No Pi runtime or ODD integration.

- `src/plugin.ts`: typed OpenCode adapter, session ownership, permissions, delivery journal.
- `src/design-agent.ts` and `agents/design.md`: opt-in primary Design agent registration
  and spec-first workflow. Preserve custom-agent collisions; selections update specs,
  never production code. `.spec/SPEC.md` must link every feature specification.
- `lib/`: portable HTTP/SSE server, storage, canvas lifecycle, design-source detection.
- `assets/design-canvas/`: dependency-free browser UI and sandboxed element inspector.
- `skills/design/SKILL.md`: bundled `opencode-design` skill. Load it for UI design,
  mockups, landing pages, artboards, or design-system sync; details live alongside it.
- Preserve the upstream notices in `LICENSE`, `NOTICE`, and `skills/design/LICENSE`.
- Run `npm run typecheck` and `npm test`; do not treat mocked adapter tests as
  evidence of a live model-driven OpenCode run.
- Keep canvas callbacks bound to an explicit originating session and directory.
  Never redirect to whichever session is currently selected in a client.
