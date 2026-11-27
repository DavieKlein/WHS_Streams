# X++ export for query ranges (fallback)

Only needed when the query text fields of the standard V2 entities (`DirectiveQuery`, `ActionQuery`, `TemplateQuery`)
are not available via OData or are in a format the viewer cannot read.

`WMSQueryRangeExport.xpp` unpacks the "Edit query" restrictions of location directives (header and
actions) and work templates and writes them to a custom table `WMSQueryRangeExportTable`
(fields `Source` str 20, `RefRecId` RecId, `TableName` str 60, `FieldName` str 60, `RangeValue` str 1000).

1. A Cegeka developer adds the table, the class and a **read-only data entity** on the table
   (public collection name e.g. `WMSQueryRangeExports`) in a dev or test environment.
2. Run the class (menu item or batch) whenever directives change.
3. On the Koppeling tab, set source "Query-ranges" to that entity set and check it against `$metadata`.

The viewer only uses GET, so a custom service (POST) is deliberately not used.
Until this is in place, use the CSV route (`bron, recId, tabel, veld, waarde`).
