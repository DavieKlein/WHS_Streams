# Data model

## Flat tables (what the backend delivers, sample or live)

| Source | Fields |
|---|---|
| locations | id, warehouse, zoneId, profileId, aisleId, rack, level, position, isDefaultReceipt, isDefaultIssue, isDefaultProductionInput, isDefaultProductionOutput |
| zones | id, name, zoneGroup |
| profiles | id, locationType, lpControlled |
| workClasses | id, workOrderType |
| directives | key (composite or RecId), query (text), code, name, workOrderType, workType, site, warehouse, sequence, directiveCode, multipleSku, restrictByUnit |
| directiveLines | key, directiveKey, sequence, fromQty, toQty, unit, locateQty |
| directiveActions | key, lineKey, sequence, name, strategy, allowSplit, query (text) |
| templates | key, id, workOrderType, sequence, workPool, valid, query (text) |
| templateLines | templateKey, lineNo, workType, workClass, directiveCode |
| queryRanges | source (directive/action/template), key (RecId), table, field, value — a row with an empty table means "checked, no restrictions" |

## Pipeline (`app/js/core.js`, shared by browser and tests)

1. **normalize**: link lines → directives, actions → lines, template lines → templates, ranges → records.
2. **resolveAction**: which locations a directive action allows (header + action ranges).
3. **buildFlows**: per template, each Pick line paired with the next Put line → flow with ranked target areas.
4. **placeLocations**: locations → drawn shapes (location/point > aisle > zone; a fully covered drawn zone collapses to the zone).
5. **runChecks**: zones without any action, conflicts, unplaced locations, unresolved directives/actions, aisles outside their zone.
6. Rendering: `app/js/map.js` (SVG; the export reuses the same code).

## Layout (`data/layouts/<warehouse>.json`)

```json
{ "warehouse": "WH01", "grid": { "cellMeters": 1, "width": 100, "height": 66 },
  "shapes": [ { "id": "s1", "type": "zone", "ref": "BULK", "label": "Bulk", "x": 10, "y": 4, "w": 36, "h": 24, "rotation": 0 },
              { "id": "s5", "type": "point", "role": "receipt", "ref": "DOCK-IN-1", "x": 10, "y": 56, "w": 8, "h": 5, "rotation": 0 } ] }
```
Point roles: receipt, baydoor, staging, production-input, production-output.
