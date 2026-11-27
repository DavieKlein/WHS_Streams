# Assumptions (to verify against the customer's D365 F&O)

Every assumption is also a `TODO(assumption …)` in the code.

| # | Assumption | Where | How to verify |
|---|---|---|---|
| A1 | Field names in `config/entities.json` come from the Microsoft CDM schema of the standard entities (WHSWarehouseLocationDirectiveV2Entity, …LineEntity, …LineActionV2Entity, WHSWarehouseWorkTemplateV2Entity, WHSWarehouseWorkTemplateLineEntity, WMSWarehouseLocationEntity, WHSWarehouseZoneEntity, WHSWarehouseLocationProfileEntity, WHSWarehouseWorkClassEntity). The OData **entity set** names are not in CDM and are found per environment with "Automatisch herkennen". Whether every entity is OData-public (IsPublic) is unverified. | config/entities.json | Koppeling → Automatisch herkennen → Controleer tegen $metadata. |
| A2 | A work template line **without** directive code only uses location directives **without** directive code; with a code only directives with that same code. | core.js `directivesForLine` | Compare with a test order in the customer environment. |
| A3 | Pick lines without a location directive take their stock from the warehouse's default location (IsDefaultReceipt / IsDefaultProductionFinishedGoods flags on the location) when drawn, else from a drawn fixed point: purchase / transfer receipt / return → receipt dock (point role "receipt"); finished goods / co-product put-away → production output. | core.js `PICK_FALLBACK` | Check the warehouse's default receipt location and production output location. |
| A4 | A Pick line that follows a Put line in the same template picks from that Put's location (e.g. staging → bay door). | core.js `makeFlow` | Standard D365 behaviour; confirm on a sales order with staging. |
| A5 | Query semantics: ranges on the same field are OR, different fields AND; values support `A,B`, `!A`, `A..B`, `*`, `?`, `""`. | core.js `locationFilter` | Unusual range expressions (functions such as `(dayRange())`) are not evaluated: they show as "niet-ondersteund". |
| A6 | Header ranges on item/order tables (InventTable, InventItemGroupItem, InventDim, SalesTable, …) restrict *which* stock a directive applies to, not *where* it goes; they are shown as "alleen voor …". | core.js `CONDITION_TABLES` | Extend the table list when a customer uses other tables. |
| A7 | Two directives conflict when warehouse, work order type, work type, directive code and the (normalised) header ranges are equal. Only the one with the lowest sequence is ever used. | core.js `findConflicts` | — |
| A9 | The query text fields `DirectiveQuery`, `ActionQuery`, `TemplateQuery` hold the restrictions. Their format is not documented; the reader handles XML with DataSource/Range elements. Other formats count as "unknown" (flow incomplete) and a sample is shown on the Koppeling tab so the reader can be extended. | core.js `parseQueryText` | First live refresh: look at Koppeling → query-ranges table. |
| A10 | CSV/X++ rows may reference a record by RecId, by the composite key, or by a readable key (directive id; `directive/line/action`; template id). Readable keys can be ambiguous across work types. | core.js `rangesFor` | — |
| A8 | Arrow thickness = number of directive actions that feed the arrow (phase 2 may switch to transaction volume). | core.js `makeFlow` | — |

Open questions from the instructions (to fill in before phase 2): where the DM Quality Tool code lives and whether its
app registration may be reused; whether it already shows query ranges readably; first customer / legal entity / warehouse;
which work order types are in scope; zones on all locations or drawing on aisle/location level.
