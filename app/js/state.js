/* The single app state. render*() functions rebuild the DOM from it. */
const state = {
  tab: "draw",
  d365: { mode: "sample" },
  settings: { dataMode: "sample", legalEntity: "", warehouse: "" },
  dataset: null,          // { mode, fetchedAt, flat, counts, ... } from /api/dataset (customer rows stay in memory only)
  model: null,            // Core.normalize(dataset.flat)
  warehouse: "",
  layout: null,           // { warehouse, grid, shapes }
  layoutSource: "",
  layoutDirty: false,
  flowResult: null,       // Core.buildFlows(...)
  checks: null,           // Core.runChecks(...)

  draw: {
    tool: "select",
    newType: "zone",
    selectedId: null,
    snap: 1,
    undo: [],
    redo: [],
    underlay: null,       // { src, opacity } — session only
    nextId: 1
  },
  flows: {
    hiddenCategories: new Set(),
    template: "",
    directive: "",
    problemsOnly: false,
    selected: null        // { kind: "flow", flowId, edge } | { kind: "area", shapeId }
  },
  entities: null,
  entityCheck: null
};

/** Recomputes the pipeline after data or layout changes. */
function recompute() {
  if (!state.model || !state.layout) { state.flowResult = null; state.checks = null; return; }
  state.flowResult = Core.buildFlows(state.model, state.layout, { warehouse: state.warehouse });
  state.checks = Core.runChecks(state.model, state.layout, state.flowResult);
}
