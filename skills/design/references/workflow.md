# Design workflow reference

## Activation

Use this skill for UI design, mockups, screens, landing pages, visual directions,
and iterations on artboards under `design/`. Designing is separate from production
implementation. `/design` is a shortcut, not a requirement.

## Hard rules

- One self-contained HTML file per artboard: inline CSS, JavaScript, and SVG;
  system font stacks only. No external URLs, CDNs, remote fonts, images or scripts.
- Realistic audience-specific content, never lorem ipsum.
- Semantic markup, WCAG AA contrast, visible focus styles, reduced-motion support.
- Read `design/system.md` when present; use its tokens and component rules.
- Ask at most one clarifying question, only when the goal or content is missing.
- Feedback edits only the named artboard. Never rewrite sibling proposals.
- Respect the active agent's permissions. In Plan mode, discuss designs without
  writing files; ask the user to switch to an editing agent before generating.

## Before each new brief

Call `design_canvas` with `action: "list"`.

| Report | Action |
| --- | --- |
| Design sources exist, no `design/system.md` | Run Design system sync first, report it, then design |
| No design sources | Design freely |
| `system.staleSources` is nonempty | Name stale sources and offer to re-sync; require approval and do not silently use stale tokens |

## Generate proposals

1. Understand goal, layout, audience, and content.
2. Choose a new kebab-case slug. Never overwrite an existing design for a new brief.
3. Write three clearly different directions by default, or the requested number.
   Vary structure or visual strategy, not just colors. Name each tradeoff.
4. Write `design/<slug>/NN-<name>.html` and `design/<slug>/design.json`:

```json
{
  "title": "Pricing page",
  "brief": "Pricing for a note-taking app aimed at students",
  "artboards": [
    { "file": "01-comparison.html", "title": "Comparison", "tradeoff": "Scannable but dense", "width": 1440, "height": 900 },
    { "file": "02-focused.html", "title": "Focused plan", "tradeoff": "Simple but less comparative", "width": 1440, "height": 900 }
  ]
}
```

5. Dimensions are intended viewport CSS pixels. Keep the manifest in sync.
6. With system tokens present, list used colors and font families, compare against
   the tokens, and fix deviations before finishing.
7. Call `design_canvas` with `action: "open"` and `slug` after every change unless
   the user declines. An existing canvas refreshes without opening another tab.
8. Report the URL, artboard files, titles, tradeoffs, and changed files.

## Iterate

- Feedback: edit only its artboard; update the manifest tradeoff if needed.
- "Save and try another approach": append the next numbered artboard, preserving all earlier ones.
- Tuning values: add controls and a "Copy as prompt" button for chosen values.

## Design system sync

1. Read, never edit, project sources: CSS custom properties, Tailwind config or
   `@theme`, token files, components, and declared font families.
2. Write `design/system.md`: colors, typography, spacing, radii, shadows, component
   rules. Every entry cites its source path; record only observed values.
3. Write `design/system.html`, a self-contained 1440 px wide token/component board.
   The canvas displays it first, without comments or implementation controls.
4. With no sources, explain that and propose a starter system for approval. Do not
   invent project tokens or present a proposal as extracted facts.
5. Report source paths, token counts by group, and whether this is a starter proposal.
6. Open the canvas after syncing unless declined.

## Canvas feedback

1. Call `design_comments` with `action: "list"`, optionally `slug` and `file`.
2. Read attached screenshots first (or their named paths). They may show transient states.
3. Use the comment's `file`, CSS `selector`, and text `excerpt` to locate the target.
4. Apply each request only to its named artboard.
5. Call `design_comments` with `action: "resolve"`, `slug`, and applied `ids`.
   Leave unapplied comments open and explain why. Refresh the canvas.
6. Report changed files and resolved IDs. Never delete or reorder comment history.

Comments live in `design/<slug>/comments.json`; screenshots in `.screenshots/`.
The tools own writes. Malformed comment files must be repaired explicitly, not overwritten.

## Implement a chosen proposal

Use `design_canvas` with `action: "implement"` and `target: "<slug>/<artboard>"`.
Follow its handoff instructions. Map the visual spec to the real project's
components and stack; do not copy the artboard HTML verbatim.

Report progress with `action: "handoff"`, the same `target`, and
`status: "in_progress"` when starting, then `status: "implemented"` only after
verification. Include `previewUrl` when a running app exists (HTTP/S loopback URL).
The canvas marks the chosen proposal, shows progress, and offers comparison.

Use `design_canvas` actions `list`, `open`, and `stop` to manage the canvas.
Neither choosing nor handing off a proposal commits changes.
