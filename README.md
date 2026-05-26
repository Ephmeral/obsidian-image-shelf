# Image Shelf

Image Shelf is an Obsidian community plugin for managing vault images as searchable, reference-aware assets.

It scans images in the current vault, builds a local asset index, tracks Markdown references, renders a multi-view gallery, and provides tools for image cleanup, annotation, OCR text storage, and note-aware recommendations.

## Current Capabilities

- Multi-pane Obsidian UI: navigation, gallery, inspector, task center, and current-note recommendations.
- Image indexing: file metadata, dimensions, SHA-256 for eligible files, dominant colors, status, tags, collections, and Asset Note metadata.
- Reference graph: wiki embeds, Markdown image links, and HTML image tags mapped back to source notes, headings, and line context.
- Gallery workflows: masonry, grid, list, and compact modes with search, sorting, quick filters, field visibility, multi-select, and virtual rendering.
- Detail workspace: large preview, zoom/pan, references, Asset Note editing, metadata, similar images, OCR text panel, and rectangular annotations.
- Safety-first file operations: dry-run summaries, transaction logs, Markdown link rewrites, trash/archive/permanent-delete confirmation, and restore support for plugin trash state.
- Local-first AI/OCR foundations: OCR currently saves pasted local text; AI tag suggestions currently use local rules and require explicit user confirmation.

## Project Layout

```text
src/
  main.ts                 # Plugin lifecycle, command handlers, file operations
  commands/               # Command palette registration
  services/               # Indexing, repository, thumbnails, search, OCR, AI, tasks
  settings/               # Defaults and settings tab
  storage/                # Plugin data persistence helpers
  types/                  # Shared domain types
  utils/                  # Small pure helpers
  views/                  # Obsidian views, modals, and UI surfaces
tests/                    # No-dependency Node test files
scripts/run-tests.mjs     # Bundles TS tests with esbuild, runs node:test
docs/                     # Product, technical, and UI reference documents
```

## Development

Install dependencies:

```bash
npm install
```

Start esbuild in watch mode:

```bash
npm run dev
```

Build release artifacts at the project root:

```bash
npm run build
```

Run the full local verification suite:

```bash
npm run check
```

That runs TypeScript, ESLint, and the no-dependency Node test suite.

## Sync To A Local Vault

`npm run build` intentionally has no vault side effects. To copy release artifacts into a local Obsidian vault plugin directory, set `IMAGE_SHELF_PLUGIN_DIR` and run:

```bash
IMAGE_SHELF_PLUGIN_DIR="/path/to/Vault/.obsidian/plugins/image-shelf" npm run sync:vault
```

The sync command copies:

- `main.js`
- `manifest.json`
- `styles.css`

## Testing

The test runner uses existing dev dependencies only. It bundles `tests/*.test.ts` with esbuild into a temporary directory, then runs Node's built-in `node:test` runner.

```bash
npm test
```

Add tests for pure TypeScript utilities first. Obsidian API behavior should be covered with focused abstractions or manual vault validation until a proper Obsidian test harness is introduced.

## Release Notes

- Keep `manifest.json`, `package.json`, and `versions.json` versions aligned.
- GitHub release tags should match `manifest.json` exactly and should not use a leading `v`.
- Release assets are `manifest.json`, `main.js`, and `styles.css`.

## Privacy And Safety

Image Shelf defaults to local/offline behavior. Cloud AI uploads are disabled by normalization in settings, and current OCR/AI flows do not upload images. Do not introduce network requests, telemetry, or remote-code execution without a clear user-facing reason, explicit opt-in, and documentation.
