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
Turn on **Comment**, click an element, and **Save** comments. Click **Send feedback**
when ready to submit the collected batch. The agent revises only
that proposal, resolves the comment, and refreshes the canvas.

Request toasts appear in the canvas's top-right corner: **Working** with an
indeterminate progress bar while the agent works, and a separate **Request queued**
card for each waiting request. Once the agent finishes and updated artboards load,
**Request completed** appears for one second. While reviewing, no request toast is
shown. Saving a comment without sending it does not start a request.

Opening the canvas creates `design/session-status.json`. The plugin maintains this
file from native request lifecycle events; canvases read only their originating
session's status. Reloading the browser restores active/queued cards without
replaying historical completion toasts. Failures and interruptions are not reported
as successful completion. Do not edit this runtime status file manually.

For feedback affecting every proposal (for example, “Add a testimonials section”),
click **General comment**, or choose **General — all proposals** under **Applies to**
in the comment composer. General comments apply only to the selected design, not
other designs or the design-system board. They support screenshots and collected
feedback, appear as **All proposals** in the sidebar, and resolve after every proposal
satisfies the request while retaining its distinct approach. Existing element comments
remain unchanged.

### Start from an existing app snapshot

Export a rendered app page as one self-contained UTF-8 HTML file, including the
state after login or other interactions, then run:

```text
/design import "exports/My dashboard.html"
```

Local `@file` references and `file:` URIs also work. Agents can use `design_import`
with a `file` argument. Import creates `design/` when needed, copies the page into
a unique design with **one original artboard**, and opens it without generating or
restyling anything. Existing designs and the source export stay untouched.

Comment on the imported copy or use **+** to create a connected page. Use the
**refresh-icon button** beside **+** to generate variations of the **same page**:
optionally describe changes and choose 3–12 proposals (default 3). Variations are
shown in a connected child panel linked to the exact reference proposal; the
reference and earlier proposals remain unchanged. Both buttons create children:
**+** designs a different page; **refresh** explores the same page.
Retries reuse the same request rather than adding duplicate work.

This is a visual snapshot, not a running React app: authentication, backend calls
and action replay are not restored. Export embedded styles/assets rather than the
app's bootstrap `index.html`; remote resources remain blocked by the canvas sandbox.
Imports are limited to 32 MiB. Review captures for private account data before sharing.

### Design another page from a proposal

Use **Discard** on a proposal and confirm to permanently delete its HTML, manifest
entry, proposal-specific comments/screenshots, and implementation record. Sibling
proposals, shared assets and general feedback remain. A proposal referenced by
connected pages is protected from discard. This action cannot be undone in the canvas.

To implement several pages together, check **Select page** on one proposal per
page, then use **Implement selected (N)** in the toolbar. Choosing another
alternative for the same page replaces its selection. The agent receives one
coordinated app implementation request, with each page's feedback and individual
progress tracking. **Clear selection** resets your choices. For a single page,
select just that proposal and use the same **Implement selected** action.

Hover a proposal and click its floating **+** button (also keyboard accessible).
Describe the new page—such as pricing based on a landing-page proposal—and choose
3–12 variations. The agent receives the selected proposal as a reference, including
instructions to retain shared headers, footers, visual conventions and preferences.

Each page's sibling proposals share a titled panel. A single connector links the
exact base proposal to each child panel. Use the square **− / +** button at a child
panel's incoming connector to collapse or expand it. Collapsing also hides all
descendant panels; expanding restores their individual collapse states. Collapse
state survives canvas updates and design switching within the open canvas.

The header selector distinguishes **Initial** designs from **Child** pages and names
each child's reference. Selecting an initial design shows its panel and descendants.
Selecting a child shows only its exact parent reference proposal, its own panel,
and its descendants—not the parent's other alternatives, branches, or ancestors.
The design-system board remains visible when available, and the selected panel is
always expanded. You can branch again from any alternative.
The original proposals are left unchanged. Each page retains independent comments
and implementation choices. Failed submissions offer a retry without creating a
second child page; generation still depends on the originating agent completing
the request. Existing designs without relationships continue to work normally.

### Responsive device previews

Use **Device** in the canvas toolbar to resize all proposals together:
**Desktop** restores each proposal's original dimensions, **Tablet** uses 768 × 1024,
and **Mobile** uses 390 × 844 CSS pixels. This changes actual iframe viewports so
responsive CSS/media queries activate, rather than merely scaling the canvas.
The selection stays active when switching designs or refreshing boards within the
canvas. Compare uses the selected dimensions for both frames; the design-system
board and saved proposal manifests remain unchanged.

### Design-system feedback

Click **Sync design system** in the canvas toolbar to run the same workflow as
`/design sync`: the originating session's agent reads project sources, extracts
design tokens, preserves preview overrides, and refreshes the system board.
The button works before a system board exists. It queues agent work; it does not
edit application styles or invent tokens in the browser. Failed submissions offer
**Retry sync** without creating a duplicate request.

The system board groups themed colors into **Light** and **Dark** palettes, with
matching roles in the same order. Unthemed colors have a separate shared section.
**Typography**, **Spacing**, **Radii**, **Shadows**, and **Components** have their own
visual sections; absent data is marked **Not specified**, never filled with guessed tokens.
Run `/design sync` to regenerate an existing board and re-extract all foundations,
including font and spacing declarations. The renderer cannot recover tokens omitted
from an earlier color-only snapshot. Existing preview overrides are preserved.

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

## Design agent: specifications before implementation

The plugin also registers a primary **Design** agent (`design`). Select it explicitly;
the plugin does not change your default or active agent. No agent-file copy is needed.
If an agent named `design` already exists, it is preserved: rename that file to
`design-old.md` yourself if you want to use the bundled agent, then `/reload`.
The plugin never renames or writes your OpenCode configuration files.

Design gathers requirements and maintains these project-root artifacts:

```text
spec/
  APP.md                 # App-wide requirements and links to EVERY feature spec
  authentication.md      # Feature requirements, technical details and selected UI
  billing.md
design/                  # Canvas previews and feedback, not production app code
```

It asks whether all technical and design details are provided and whether UI design
may begin, then waits for explicit approval before generating/syncing/opening previews.
After approval, use the usual canvas feedback workflow. Keep **Design** selected
while reviewing: **Implement selected** means *capture the chosen designs in the
specifications* for this agent, not implement code. It records selected visual
details and design-file links, updates every relevant feature file and APP.md's
complete feature index, and reports **implementation not started**. It does not
mark canvas handoffs implemented or launch an application.

Hand an implementation agent just this entrypoint later:

> Implement the application specified in `spec/APP.md`, reading all linked feature specifications.

Design can edit only `spec/*.md` and `design/` artifacts at the plugin's location;
shell commands, subagents and application-source edits are denied. Start at the
project root. Readiness and specification completeness are model instructions,
not a deterministic canvas state machine. Existing build agents keep the normal
code-implementation handoff behavior. The packaged source is
[`agents/design.md`](agents/design.md); native registration adds location-specific
absolute edit rules for canvas tools. It inherits the session's selected model.

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
to use **design_import**, **design_canvas**, **design_comments**, and **design_system**. In Plan mode, it discusses the
design without writing files; switch to an editing agent to generate proposals.

## What is included

- Distinct, self-contained HTML proposals with titles and tradeoffs.
- Design-system extraction, source detection, and stale-token warnings.
- Side-by-side artboards, pan/zoom, focus mode, and live reload.
- Element-linked comment pins, open/resolved history, and explicit batch submission with **Send feedback**.
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
  session-status.json       # Session-scoped request lifecycle (plugin-managed)
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
In the terminal UI, `/design stop` shows a three-second success toast when it stops
the canvas, while retaining the session notice. If no canvas is running, only the
session notice appears. Toasts appear only in the originating session; headless clients still receive
the notice. Desktop/web native toasts are not included.
The TUI part is loaded by the terminal client, so restart OpenCode after changing
plugin files; `/reload` only reloads the server part. A failed TUI part appears in
`/plugins` with its load error. The shared background service caches prepared plugin
metadata, including whether a `./tui` entrypoint exists; after adding or changing that
entrypoint, run `opencode service restart` before relaunching the TUI, or the terminal
client silently skips the part.
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
