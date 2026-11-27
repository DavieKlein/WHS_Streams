# Changelog

## 2026-11-27 (2)
- Mapping switched to the standard D365 data entities with field names from the Microsoft CDM schema; composite keys
  (no RecId needed) link directives, lines and actions, and templates and lines.
- "Automatisch herkennen": finds each entity set in `$metadata` by its fields.
- Restrictions are read from the entities' query text fields (`DirectiveQuery`, `ActionQuery`, `TemplateQuery`);
  unreadable formats are flagged and shown as a sample. X++ export and CSV remain as fallback and take precedence.
- Default receipt / production output locations come from the location flags in the data.

## 2026-11-27
- First complete version on the fictional warehouse (phases 1–5 of the instructions in one go, at the owner's request):
  Tekenen (grid, snap, zoom/pan, draw/move/resize/rotate/duplicate/delete, undo/redo, link to zone/aisle/location/point
  from the data, auto-distribute aisles, "Nog niet getekend", session underlay, save/load), Stromen (arrows per work
  order type with colour + line style, thickness, numbered choices, filters, details, legend, SVG/PNG export),
  Controles, and Koppeling (D365 connection via .env / Credential Manager / form, $metadata check and search,
  entity mapping, scope, "Ververs data" with paging and cache, query ranges via X++ export entity or CSV).
- Stack follows the Cegeka app blueprint (dependency-free Node, plain JS, no build step) instead of the
  TypeScript/Vite/Fastify suggestion in the instructions; the blueprint is the house style.
- Shell max-width 1600 px instead of the blueprint's 1280 px, because the canvas needs the room.
- The official Cegeka logo and favicon are not included: put them in app/assets/ (a text wordmark is shown until then).
