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
- Element feedback edits only the named artboard. General feedback applies to every
  proposal in that design, preserving each approach; exclude other designs and the system board.
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

### New page from an existing proposal

Hover a proposal (or focus its controls) and use the floating **+** beneath it.
Enter the new page brief and choose **3–12** proposals. The request is queued to
the canvas's originating session, not whichever session the client selects later.

1. Read the referenced HTML, parent brief, applicable comments/preferences, and effective system tokens.
2. Use the reserved `design/<child-slug>/` from the request. Its initial manifest
   already includes `parent: {slug, file}` and `requestId`; preserve both exactly.
   This is the exception to choosing a new slug for each brief: do not duplicate a reserved request.
3. Create at least the requested number of self-contained responsive alternatives
   for the new page. Preserve the app's visual language, similar structure, shared
   headers/footers, navigation, conventions and preferences while varying the page layout.
4. Never overwrite the base proposal or production sources. Add generated artboards
   to the reserved manifest, give it a useful page title, and refresh the canvas.

The family appears together: original alternatives above, connected new-page
alternatives beneath their exact base proposal. Any child can be a reference for
another page. Device previews apply to the whole family. Clicking into a child
selects that page's comment scope; each design keeps its own general feedback and
implementation choice. Connections are derived from optional manifest metadata;
old manifests without it keep their original layout. Missing parents and cycles
are isolated; family previews are bounded to 60 artboards and 8 descendant levels.

Requests live in `design/page-requests.json`. Failed admission retains the child
slug and request identity; Retry sends the same brief to avoid duplicate generation.
Cancel and reopen to make a different request. Canvas connections appear as the
agent writes the new proposals; queuing does not itself guarantee model completion.

- Element feedback: edit only its artboard; update the manifest tradeoff if needed.
- General feedback: apply to all proposals in the selected design, preserving their distinct approaches.
- "Save and try another approach": append the next numbered artboard, preserving all earlier ones.
- Tuning values: add controls and a "Copy as prompt" button for chosen values.

## Design system sync

1. Read, never edit, project sources: CSS custom properties, Tailwind config or
   `@theme`, token files, components, and declared font families.
2. Call `design_system` action `sync`, supplying `tokens` as
   `{key, group, value, source}`. Use stable semantic keys, groups `color`, `font`,
   `spacing`, `radius`, `shadow`, or `component`, and project-relative source paths.
   Represent component rules as component tokens. Record only observed values.
3. The tool saves `design/system-source.json`, preserves `design/system-overrides.json`,
   and generates `system.md` and `system.html` from effective values. The canvas displays
   the board first with annotations but no implementation controls. Do not hand-edit generated files.
4. With no sources, explain that and propose a starter system for approval. Do not
   invent project tokens or present a proposal as extracted facts. Approved starter tokens use source `proposed`.
5. Report source paths, token counts by group, and whether this is a starter proposal.
6. Open the canvas after syncing unless declined.

### Design-system feedback (preview only)

Use **Design system comment**, choose **Design system** under **Applies to**, or
annotate the system board in Comment mode. The sidebar's **Feedback scope** selector
separates system comments and their Send all batch from selected-design comments.
Screenshots, Send now, Collect, Resolve and Reopen work in either scope.

1. List `design_comments` with `scope: "system"` (omit slug/file); inspect screenshots.
2. Call `design_system` action `list`; if the structured baseline is missing, extract
   sources and sync first. Legacy boards are not silently treated as source snapshots.
3. Use action `set` with `key`, `value`, optional `reason` to persist a preview override;
   use `remove` with `key` to restore the source value. Never modify application sources.
4. Review warnings: source changes retain active overrides; missing/group-incompatible
   tokens retain inactive overrides. Reconcile conflicts explicitly, never erase them silently.
5. Update affected proposal previews across designs using effective tokens, preserving
   their distinct approaches. Token tools do not rewrite proposal HTML automatically.
6. Verify the board and affected proposals, then resolve completed IDs with
   `design_comments` action `resolve`, `scope: "system"`, `ids`, no slug.

System comments live in `design/system-comments.json`; screenshots live in
`design/.system-screenshots/`. These are independent of any proposal slug named `system`.
The source snapshot, not later override rendering, determines source-sync freshness.

## Canvas feedback

1. Call `design_comments` with `action: "list"`, optionally `slug` and `file`.
2. Read attached screenshots first (or their named paths). They may show transient states.
3. Check scope. Missing scope (legacy) or `scope: "element"` targets the named `file`,
   CSS `selector`, and text `excerpt`. `scope: "general"` has no element fields and
   applies to every proposal listed in that design's `design.json`.
4. Apply element requests only to their artboard; apply general requests to all
   proposals, preserving their distinct approaches. Do not edit other designs or the system board.
5. Call `design_comments` with `action: "resolve"`, `slug`, and applied `ids`.
   Resolve general comments only after all proposals satisfy them. Leave unapplied
   comments open and explain why. Refresh the canvas.
6. Report changed files and resolved IDs. Never delete or reorder comment history.

Comments live in `design/<slug>/comments.json`; screenshots in `.screenshots/`.
The tools own writes. Malformed comment files must be repaired explicitly, not overwritten.

Use **General comment** to write without selecting an element, or switch **Applies to**
in the element composer to **General — all proposals**. Both scopes support screenshots,
Send now, Collect, and Send all. General comments appear in the sidebar without pins.
Filtering comments by artboard also includes applicable general comments.

## Implement a chosen proposal

Use `design_canvas` with `action: "implement"` and `target: "<slug>/<artboard>"`.
Follow its handoff instructions. Map the visual spec to the real project's
components and stack; do not copy the artboard HTML verbatim.
Include applicable general feedback in the implementation, but do not resolve its
design-wide comment just because the selected implementation satisfies it.

Report progress with `action: "handoff"`, the same `target`, and
`status: "in_progress"` when starting, then `status: "implemented"` only after
verification. Include `previewUrl` when a running app exists (HTTP/S loopback URL).
The canvas marks the chosen proposal, shows progress, and offers comparison.

Use `design_canvas` actions `list`, `open`, and `stop` to manage the canvas.
Neither choosing nor handing off a proposal commits changes.
