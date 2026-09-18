# 06 — Inventory Crawler

A dynamic, application-agnostic crawler that discovers the "expected" coverage
inventory (routes, components, actions) for **any** hosted web application you
have access to. It **overwrites** `01-module-inventory/module_inventory.json`
in place with a generated inventory in the same schema the coverage engine and
the .NET API already consume — so no downstream wiring changes are needed.

## Why

Previously the expected inventory was hard-coded for one app. This crawler drives
the real application in a browser (Playwright), walks its routes, extracts every
interactive element, and derives **stable IDs** using the same rules the browser
extension uses — so observed automation events line up with discovered nodes and
the gap report is accurate.

## How it works

1. **Auth** — runs the configured login steps (fill/click/wait).
2. **Crawl** — starts at `startPath`, clicks configured SPA nav selectors, and
   follows same-origin links. Dynamic URL segments are collapsed
   (`/orders/123` → `/orders/{id}`).
3. **Extract** — for each route, `extract.js` collects visible interactive
   elements plus their nearest landmark container.
4. **Fingerprint** — `fingerprint.py` derives route / component / action IDs via
   a fallback chain: `data-testid` → `id` → `name` → `aria-label` → role+text →
   CSS-path hash. This mirrors `05-browser-extension/shared/fingerprint.js`.
5. **Emit** — writes an inventory JSON matching
   `02-coverage-engine/coverage_engine.py`'s expected shape.

## Setup

```powershell
cd 06-inventory-crawler
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m playwright install chromium
```

## Run

Start the target application first (for the demo app on
`http://localhost:5173`), then:

```powershell
python crawl.py --config crawl.config.json --out ..\01-module-inventory\module_inventory.json
```

`--out` defaults to `..\01-module-inventory\module_inventory.json`, so you can
just run `python crawl.py` to regenerate the inventory the API serves.

## Configure for a different application

Everything app-specific lives in `crawl.config.json`:

| Field | Purpose |
| --- | --- |
| `baseUrl` / `startPath` | Where to start crawling |
| `auth.steps` | Login sequence (fill/click/waitForSelector/goto) |
| `spaNavSelectors` | Elements to click for client-side navigation |
| `dynamicSegmentPatterns` | Regexes that mark a path segment as dynamic |
| `ignorePathPatterns` | Paths to skip (logout, APIs, etc.) |
| `riskRules` | Keyword → risk mapping used for gap prioritization |

## Workflows

The crawler cannot infer business workflows, so it emits an empty `workflows`
list. Curated workflows live in `01-module-inventory/workflows.overlay.json` and
are merged back in **at serve time**:

- The **.NET API** (`03-coverage-api/Program.cs`) merges the overlay by workflow
  `id` when it loads `module_inventory.json`, so overwriting the inventory via a
  re-crawl never wipes curated workflows.
- The **Python engine** does the same via
  `coverage_engine.merge_workflow_overlay(...)`.

## Pipeline

```text
crawl.py  ->  module_inventory.json  ->  API / coverage_engine.compare(inventory, events)
              (+ workflows.overlay.json merged at serve time)
```
