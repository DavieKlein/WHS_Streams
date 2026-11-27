/* Tab "Controles": uncovered zones, conflicts, unplaced locations and unresolved directives. Never filtered away silently. */
const ChecksTab = (() => {
  function init() {
    document.getElementById("checkTables").addEventListener("click", (e) => {
      const z = e.target.closest("[data-goto-zone]");
      if (z) { App.showTab("draw"); }
    });
  }

  function problemCount() {
    const c = state.checks;
    if (!c) return 0;
    return c.zonesWithoutAction.length + c.conflicts.length + c.unresolvedActions.length + c.linesWithoutDirective.length + c.locationsWithoutZone.length + c.issues.filter((i) => i.type !== "location-no-zone").length;
  }

  function table(head, rows) {
    return `<div class="table-wrap scroll-table"><table class="simple-table"><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.join("")}</tbody></table></div>`;
  }
  function section(title, hint, body, empty) {
    return `<div class="panel"><div class="panel-head">${escapeHtml(title)}</div><div class="panel-body">
      ${hint ? `<p class="hint">${escapeHtml(hint)}</p>` : ""}${body || `<div class="message good">${escapeHtml(empty)}</div>`}</div></div>`;
  }

  function render() {
    const c = state.checks;
    const cards = document.getElementById("checkCards");
    const tables = document.getElementById("checkTables");
    if (!c) { cards.innerHTML = ""; tables.innerHTML = `<p class="hint">Nog geen data of layout geladen.</p>`; return; }
    const flows = state.flowResult.flows;
    const n = (s) => flows.filter((f) => f.status === s).length;
    const card = (num, text, cls) => `<div class="summary-card ${num ? cls : ""}"><div class="n">${num}</div><div class="t">${escapeHtml(text)}</div></div>`;
    cards.innerHTML = [
      `<div class="summary-card"><div class="n">${n("complete")} / ${flows.length}</div><div class="t">Stromen compleet</div></div>`,
      card(n("incomplete"), "Stromen onvolledig", "warn"),
      card(c.conflicts.length, "Conflicten tussen directives", "bad"),
      card(c.zonesWithoutAction.length, "Zones zonder directive-actie", "bad"),
      card(c.unplaced.length, "Locaties nog niet getekend", "warn"),
      card(c.unresolvedActions.length, "Directives/acties niet op te lossen", "warn")
    ].join("");

    const parts = [];
    parts.push(section("Zones zonder enkele directive-actie", "Geen enkele actie van een location directive in dit warehouse zoekt in deze zone: voorraad komt er via de configuratie nooit terecht.",
      c.zonesWithoutAction.length ? table(["Zone", "Locaties", "Op plattegrond"], c.zonesWithoutAction.map((z) =>
        `<tr><td>${escapeHtml(z.zone)}</td><td>${z.locations}</td><td>${z.drawn ? '<span class="status-tag ready">Getekend</span>' : '<span class="status-tag none">Niet getekend</span>'}</td></tr>`)) : "",
      "Elke zone wordt door minstens één directive-actie geraakt."));

    parts.push(section("Overlappende directives (conflict)", "Zelfde warehouse, work order type, work type, directive code en dezelfde header-restricties. D365 gebruikt alleen de eerste in volgorde.",
      c.conflicts.length ? c.conflicts.map((x) => `<div class="message error">${escapeHtml(x.message)}</div>`).join("") : "",
      "Geen overlappende directives gevonden."));

    parts.push(section("Directives en acties die niet opgelost konden worden", "Ontbrekende of niet-ondersteunde query-ranges. Vul ze aan via de X++-export of het CSV-bestand (tabblad Koppeling).",
      c.unresolvedActions.length ? table(["Directive", "Actie", "Reden"], c.unresolvedActions.map((u) =>
        `<tr><td>${escapeHtml(u.directive)}</td><td>${escapeHtml(u.action || "(header)")}</td><td>${escapeHtml(u.reason)}</td></tr>`)) : "",
      "Alle directives en acties zijn opgelost."));

    parts.push(section("Template-regels zonder directive", "", c.linesWithoutDirective.length ? table(["Template", "Melding"], c.linesWithoutDirective.map((l) =>
      `<tr><td>${escapeHtml(l.template)}</td><td>${escapeHtml(l.message)}</td></tr>`)) : "", "Elke Pick- en Put-regel vindt een directive (of een vaste bron)."));

    const unplacedRows = c.unplaced.slice(0, 500).map((l) => `<tr><td class="mono">${escapeHtml(l.id)}</td><td>${escapeHtml(l.zoneId || "—")}</td><td>${escapeHtml(l.aisleId || "—")}</td><td>${escapeHtml(l.profileId || "—")}</td></tr>`);
    parts.push(section(`Locaties die niet geplaatst zijn (${c.unplaced.length})`, c.unplaced.length > 500 ? "Eerste 500 getoond." : "Teken hun zone, gang of de locatie zelf op het tabblad Tekenen.",
      c.unplaced.length ? table(["Locatie", "Zone", "Gang", "Profiel"], unplacedRows) + `<button class="btn-link" data-goto-zone>Naar Tekenen</button>` : "",
      "Alle locaties staan op de plattegrond."));

    if (c.locationsWithoutZone.length) parts.push(section("Locaties zonder zone", "Deze locaties kunnen alleen als losse locatie getekend worden en vallen buiten zone-restricties.",
      table(["Locatie", "Gang", "Profiel"], c.locationsWithoutZone.map((l) => `<tr><td class="mono">${escapeHtml(l.id)}</td><td>${escapeHtml(l.aisleId || "—")}</td><td>${escapeHtml(l.profileId || "—")}</td></tr>`)), ""));

    if (c.aisleWarnings.length) parts.push(section("Gangen buiten hun zone", "", c.aisleWarnings.map((w) => `<div class="message warn">${escapeHtml(w.message)}</div>`).join(""), ""));
    const dataIssues = c.issues.filter((i) => i.type !== "location-no-zone");
    if (dataIssues.length) parts.push(section("Datafouten bij het koppelen", "Records die niet aan hun directive, regel of template gekoppeld konden worden.", dataIssues.map((i) => `<div class="message warn">${escapeHtml(i.message)}</div>`).join(""), ""));

    const incomplete = state.flowResult.flows.filter((f) => f.status !== "complete");
    parts.push(section("Stromen die niet compleet zijn", "", incomplete.length ? table(["Template", "Stap", "Status", "Reden"], incomplete.map((f) =>
      `<tr><td>${escapeHtml(f.templateId)}</td><td>${f.pair}</td><td>${statusTag(f.status)}</td><td>${f.notes.map(escapeHtml).join("<br>")}</td></tr>`)) : "", "Alle stromen zijn compleet."));

    tables.innerHTML = parts.join("");
  }

  return { init, render, problemCount };
})();
