# opencode-design

Design UI proposals, review them in a browser canvas, and send visual feedback
back to the same OpenCode session. Standalone OpenCode V2 plugin; no Pi or ODD required.

## Try it locally

Requires **OpenCode 2.2.5** (the tested plugin API) and **Node 22.19+** for development.
The package is not published yet.

1. In this repository, run `npm install`.
2. Add the local plugin directory to your project's `opencode.jsonc`, preserving
   any existing configuration:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["D:/dev/opencode-design"],
   }
   ```

3. OpenCode reloads configuration automatically; `/reload` forces a reload.
4. In an editing agent, ask: **“Design three proposals for a pricing page.”**

The session's current model writes the proposals. The canvas opens in your browser.
Turn on **Comment**, click an element, and send feedback. The agent revises only
that proposal, resolves the comment, and refreshes the canvas.

For feedback affecting every proposal (for example, “Add a testimonials section”),
click **General comment**, or choose **General — all proposals** under **Applies to**
in the comment composer. General comments apply only to the selected design, not
other designs or the design-system board. They support screenshots and both send
modes, appear as **All proposals** in the sidebar, and resolve after every proposal
satisfies the request while retaining its distinct approach. Existing element comments
remain unchanged.

### Responsive device previews

Use **Device** in the canvas toolbar to resize all proposals together:
**Desktop** restores each proposal's original dimensions, **Tablet** uses 768 × 1024,
and **Mobile** uses 390 × 844 CSS pixels. This changes actual iframe viewports so
responsive CSS/media queries activate, rather than merely scaling the canvas.
The selection stays active when switching designs or refreshing boards within the
canvas. Compare uses the selected dimensions for both frames; the design-system
board and saved proposal manifests remain unchanged.

### Design-system feedback

Click **Design system comment** for palette, typography, or spacing requests, or
annotate the system board in Comment mode. Select **Design system** in the sidebar's
**Feedback scope** to view, send, or resolve its project-wide comments separately.

Changes are **preview-only**: `design/system-overrides.json` survives `/design sync`
and application styles stay untouched. The agent uses `design_system` to sync extracted
tokens, set/remove overrides, and regenerate the system board. It then updates affected
proposal previews. Source changes produce review warnings; missing or incompatible
tokens leave overrides preserved but inactive. Removing an override restores the source value.

The structured source snapshot is `design/system-source.json`; generated `system.md`
and `system.html` show effective values and override labels. Existing boards without
a snapshot need one source sync before overrides can be applied.

## Commands

| Command | Result |
| --- | --- |
| `/design <brief>` | Generate proposals (three by default) |
| `/design` | Open the latest design, or the system board |
| `/design open [slug]` | Open/refresh a design |
| `/design sync` | Extract project tokens and render a design-system board |
| `/design implement <slug>/<artboard>` | Hand a chosen proposal to the session for implementation |
| `/design stop` | Stop this session's canvas |

Plain requests work too: the bundled **opencode-design** skill guides the model
to use **design_canvas**, **design_comments**, and **design_system**. In Plan mode, it discusses the
design without writing files; switch to an editing agent to generate proposals.

## What is included

- Distinct, self-contained HTML proposals with titles and tradeoffs.
- Design-system extraction, source detection, and stale-token warnings.
- Side-by-side artboards, pan/zoom, focus mode, and live reload.
- Element-linked comment pins, open/resolved history, and immediate or batch submission.
- Attached/pasted/dropped screenshots (PNG, JPEG, WebP, GIF; up to 5 MB each).
  Screenshots are user-supplied, not automatically captured; a batch attaches up to six.
- Implementation selection, progress badges, and comparison with a running loopback app.

Design artifacts stay in your project:

```text
design/
  system-source.json        # Extracted source-token snapshot
  system-overrides.json     # Persistent preview-only overrides
  system.md                 # Effective tokens and component rules
  system.html               # Annotatable preview system board
  system-comments.json      # Project-wide system feedback
  .system-screenshots/      # System feedback screenshots
  pricing/
    design.json             # Proposal manifest and viewport sizes
    01-comparison.html
    02-focused.html
    03-editorial.html
    comments.json           # Feedback history
    handoffs.json           # Chosen proposal and implementation progress
    .screenshots/           # User attachments
```

The manifest schema and model workflow are in
[`skills/design/references/workflow.md`](skills/design/references/workflow.md).

## Session safety and lifecycle

Each canvas belongs to its originating session and directory, not the active UI tab.
Feedback enters OpenCode's durable inbox with queued delivery; it does not interrupt
the agent. A delivery journal preserves inbox IDs across comment retries, including
retries with newly collected comments. Failed submissions remain saved and unsent.

The canvas stops on `/design stop`, session move/deletion, or plugin unload.
Closing the terminal client does not end a shared-service session. Reopen the canvas
after a move or reload. Artifacts persist across sessions, and malformed storage
files are refused rather than overwritten.

Writes and deliveries serialize within one service process. **Do not use multiple
OpenCode service processes against the same `design/` directory.** Keep journals
in OpenCode plugin storage: deleting that storage removes retry deduplication history.

## Security and permissions

The server binds only to `127.0.0.1` on a random port. Routes require an unguessable
token, writes require the exact canvas Origin, and files must remain inside the
design directory. Proposal frames have opaque sandboxed origins and no network
connections. OpenCode credentials never reach the browser.

Tool-driven handoff/comment mutations request `edit` permission; canvas open/stop
requests `design_canvas` permission. Browser feedback runs under the session's
existing agent and permissions. Treat the tokenized URL as a private capability.

This release assumes the browser and OpenCode server run on the same machine.
Remote/SSH browser opening and port forwarding are not automated. Comparison may
be blocked by the app's framing policy; use **Open in new tab**. IPv6 loopback
previews also have a browser CSP limitation; prefer `localhost`.

Disable automatic browser opening while keeping the returned URL:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "D:/dev/opencode-design", "options": { "openBrowser": false } },
  ],
}
```

## Develop and verify

```sh
npm ci
npm run typecheck
npm test
npm run test:package
npm pack
```

Tests cover the real HTTP/SSE server, browser behavior in a DOM harness, storage,
and the adapter with a typed mock OpenCode host. They do not establish model-driven
design quality. File-symlink tests explicitly skip on Windows without Developer Mode;
the configured Linux CI job runs them. The OpenCode SDK dependency currently brings moderate
transitive `glob`/`minimatch` audit findings; no high/critical findings were reported
at initial implementation. Do not force incompatible dependency overrides.

`npm run test:package` installs the tarball into a clean temporary project and checks
the installed export and bundled assets. It prefers npm's cache but may need the registry.
`npm run test:host` verifies activation, the bundled skill, `/design open`/`stop`,
native session-inbox notices, and canvas HTTP in an isolated OpenCode service,
without model calls. Notices queue without resuming the model. On Windows with a PowerShell package-manager shim, set
`OPENCODE_BIN` to the actual `opencode.exe` path first.

## Attribution

Adapted from [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell)'s
gentle-design feature. See [NOTICE](NOTICE), [MIT license](LICENSE), and the
[Apache-2.0 skill license](skills/design/LICENSE).
