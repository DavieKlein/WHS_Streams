# Stroomviewer WMS

Local web tool that draws the warehouse flows that a D365 F&O configuration prescribes (work templates +
location directives) as arrows on a floor plan you draw yourself. Read-only towards D365, Cegeka house style.

## Start

Requires Node 18 or newer. No `npm install` is needed: there are no dependencies.

```
node app/server.js
```
Open http://127.0.0.1:5176. The app starts on the fictional warehouse in `sample-data/` (WH01).

Tests: `npm test` (23 tests, including the proof that the backend can only send GET to D365).

## Tabs

- **Tekenen**: draw zones, aisles, locations and fixed points (receipt dock, bay door, staging, production in/out)
  as rectangles on a grid; link each one to a value from the data; see which locations are "Nog niet getekend".
- **Stromen**: arrows from source area to target area per work template; colour + line style per work order type,
  thickness = number of directive actions, numbers = 1st/2nd choice; click an arrow or area for details; SVG/PNG export.
- **Controles**: zones without any directive action, overlapping directives, unplaced locations, unresolved directives.
- **Koppeling**: connection with the Cegeka/customer D365 F&O environment, scope (legal entity, warehouse), entity
  mapping checked against `$metadata`, "Ververs data" and query ranges.

## Connecting to D365 F&O

In this order (the first one found wins):
1. `.env` / environment variables: `STROOM_D365_CONNECTION` (JSON) or `STROOM_D365_ENVIRONMENT_URL`, `_TENANT_ID`,
   `_CLIENT_ID`, `_CLIENT_SECRET`, `_ENV_LABEL`. The DM Quality Tool's `DM_QUALITY_D365_CONNECTION` also works. See `.env.example`.
2. A connection remembered in Windows Credential Manager (`StroomViewer:D365`).
3. The form on the Koppeling tab (optionally "Onthouden op deze computer").

Use an app registration linked to a D365 user with a **read-only** role. Secrets stay in the Node process.
All D365 calls go through `app/lib/readonly-http.js`, which refuses every method except GET.

Then: Koppeling → **Automatisch herkennen**. The tool reads `/data/$metadata` (schema only, no records) and finds the
OData entity set of each standard entity by its fields (field names from the Microsoft CDM schema, see docs/assumptions.md A1).
Fill in legal entity + warehouse and press **Ververs data**: the records (location directives, lines, actions, work
templates, lines, locations, zones, profiles, work classes) are fetched with `$select`/`$filter`/paging and cached in
`data/cache/` (git-ignored).

## Query ranges

The standard V2 entities carry the "Edit query" restrictions as text fields (`DirectiveQuery`, `ActionQuery`,
`TemplateQuery`); the tool reads them. Queries in a format it cannot read count as unknown (flow "onvolledig", never
"no restrictions") and a sample is shown on the Koppeling tab. Fallbacks: the X++ export in `x++/` or a CSV with
`bron, recId, tabel, veld, waarde`; these override the text fields.

## Folders

```
app/            server.js, d365-adapter.js, data-store.js, windows-credential-store.js, lib/, index.html, styles.css, js/
config/         entities.json (default mapping, unverified)
sample-data/    fictional warehouse WH01 + example layout
data/           customer cache, layouts, mapping, settings (git-ignored)
x++/            export class for query ranges
tests/          node:test, no dependencies
docs/           assumptions, data model, changelog
```
