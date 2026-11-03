---
name: opencode-design
description: "Trigger: UI design, mockup, landing page, artboards, visual directions, design system sync. Generate proposals and iterate through a visual canvas."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
  adapted-by: opencode-design
---

## Activation Contract

Use for UI proposals and iterations on `design/` artboards. Separate visual design
from production implementation. `/design` is optional; plain requests work too.

## Hard Rules

- Respect agent permissions. In Plan mode, discuss only; require an editing agent to write proposals.
- Write self-contained HTML: inline CSS, JS, SVG; system fonts; no external assets or URLs.
- Use realistic content, semantic markup, AA contrast, visible focus, reduced-motion support.
- Read and follow `design/system.md` when present; verify colors and fonts against it.
- Ask at most one clarification, only if goal or content is missing.
- Feedback edits only its named artboard. Preserve sibling proposals and comment history.

## Decision Gates

| Request/state | Action |
| --- | --- |
| New brief | Call `design_canvas` action `list`; generate 3 distinct directions unless another count is requested |
| Sources exist, system missing | Sync the design system first |
| System stale | Name stale sources; offer sync and require approval; never silently use stale tokens |
| No sources | Design freely; propose starter tokens only for approval |
| Another approach | Append a numbered artboard; preserve earlier ones |
| Canvas feedback | List, apply, resolve only completed comment IDs |
| Implement | Get the tool's handoff, implement in the real stack, report progress |

## Execution Steps

1. Read [workflow details](references/workflow.md) for manifest schema, sync, feedback, and implementation.
2. For proposals, choose a new `design/<slug>/`; write `NN-<name>.html` files and
   `design.json` with title, brief, and artboards (file, title, tradeoff, width, height).
   Vary structure/strategy, not only color. Dimensions are viewport CSS pixels.
3. Sync by reading sources without changing them; write sourced tokens and rules to
   `design/system.md` and their visual board to `design/system.html`. Never invent extracted tokens.
4. For feedback, call `design_comments` action `list`; inspect screenshots, locate
   selector/excerpt, edit only its file, then `resolve` applied IDs. Explain unapplied requests.
5. For implementation, call `design_canvas` action `implement`, target
   `<slug>/<artboard>`; map the visual spec to existing components, not verbatim HTML.
   Report `handoff` status `in_progress`, then `implemented` after verification;
   include the running app's loopback `previewUrl` when available. Commit nothing automatically.
6. After writing/changing boards, call `design_canvas` action `open` with the slug
   unless declined. For sync-only, omit slug. Use `list`/`stop` to manage the canvas.

## Output Contract

Return canvas URL, slug, artboard files/titles/tradeoffs, changed files, resolved
comment IDs, and open questions. For sync, report source paths, token counts by
group, and whether tokens are an extracted system or a proposed starter.

## References

- [Workflow details](references/workflow.md)
