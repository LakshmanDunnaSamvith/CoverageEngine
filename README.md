# Coverage Intelligence Pilot

A sequential proof of concept for browser automation coverage intelligence.

## Project sequence

1. `01-module-inventory` — expected hierarchical routes, components, actions, and workflows.
2. `02-coverage-engine` — Python comparator and gap calculator.
3. `03-coverage-api` — .NET 10 JSON-backed session and report API on port 5070. (Port 5060 is intentionally avoided because Chromium browsers block it as an unsafe SIP port.)
4. `04-dashboard` — React/Vite coverage dashboard.
5. `05-browser-extension` — Chromium Manifest V3 capture plugin.

The full design is in `docs/04-Coverage-Intelligence-Pilot-Design.md` in the existing Hackathon Demo repository.

## Run

From this folder, run `powershell -ExecutionPolicy Bypass -File .\run-pilot.ps1`.

Then open `http://localhost:5174` and load `05-browser-extension` as an unpacked extension in Chrome or Edge.

The pilot stores session data in `03-coverage-api/data`. It never stores input values; only safe event metadata is captured.
