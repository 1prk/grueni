/* GZ.views.umlaufpruefung — Tab "Umlaufprüfung": eine Zeile je Umlauf (TX=0-
   Grenze) im Erscheinungsbild des Signalzeitendiagramms, aber jede Zeile auf
   ihren eigenen Umlauf skaliert (nicht auf ein gemeinsames Zeitfenster).
   Signalgruppen/Detektoren/APW-ÖPNV-Werte/synthetische Formel-Spalten
   (Formel-Builder, siehe formulaBuilder.js) werden über EINE vereinheitlichte,
   durchsuchbare Objekt-Liste ausgewählt (siehe allObjects()/#upObjList) - per
   Ziehen am Griff links frei sortierbar (objectOrder/wireObjDrag()), diese
   Reihenfolge bestimmt direkt die Spuren-Reihenfolge im Umlauf-Output unten
   (Signalgruppen bleiben dabei optisch Hauptzeilen mit An/Ab/TF-Werten, alle
   anderen schmalere Nebenspuren - beides kann aber frei miteinander
   verschachtelt werden). Die Filterung, WELCHE Umläufe angezeigt werden, ist
   bewusst eine separate Liste mit eigenen, typabhängigen Bedingungen
   (Zustand-Gleichheit bzw. Zahlenvergleich, siehe filterRows/
   computeMatchingCycles()) - unabhängig von der Objekt-Auswahl/Reihenfolge.
   Jede Spur unterstützt eine manuelle Strg+Klick-Zeitmessung (siehe unten)
   sowie ein Hover-Fadenkreuz über alle Spuren eines Umlaufs (TX in Sekunden).

   Performance bei großen Aufzeichnungen (viele Umläufe/Messzeilen):
   - Alle Nachschlagevorgänge je Umlauf (Grünsegment, Signal-/Detektor-
     segmente, APW-Rohwerte) laufen über einen fortlaufenden Sweep
     (GZ.segments.makeIntervalSweep/-IndexSweep bzw. ein lokaler Zeilen-
     zeiger) statt über einen Vollscan pro Umlauf - amortisiert O(n) über
     die gesamte Aufzeichnung statt O(n²)/O(Umläufe × Messzeilen).
   - Die Breite/Höhe der Spuren-SVGs wird einmal je Render-Durchlauf
     gemessen (nicht je Zeile) und an renderLane durchgereicht, um
     Layout-Thrashing (abwechselnd DOM-Schreiben/erzwungenes Neu-Layout)
     bei vielen Zeilen zu vermeiden.
   - Ein Umlauf-Fenster (wie im Signalzeitendiagramm) begrenzt die Anzahl
     gleichzeitig gerenderter DOM-/SVG-Knoten, damit auch sehr lange
     Aufzeichnungen (tausende Umläufe) flüssig bleiben. */
(function (GZ) {
  'use strict';
  const { esc, fmtTs, fmtTimeShort } = GZ.format;
  const {
    buildSegments, computeGlobalTU, findSplAt, computeSegmentAnAbTf, getFlaggedAnomalies,
    makeIntervalSweep, makeIndexSweep
  } = GZ.segments;
  const { categorizeDetRaw } = GZ.parser;
  const { renderLane } = GZ.charts.timelineLane;
  const { wzIstBelegt, computeOepnvEvents } = GZ.oepnvLogic;

  let els = null;
  let windowCount = 20, windowStartIdx = 0, showAll = false;
  let lastEffectiveCount = 0; // Anzahl Umläufe nach aktuellem Filter (für Fenster-Navigation)

  // Vereinheitlichte Objekt-Liste (SG/DET/APW/ÖPNV/FORMEL in EINER Liste,
  // siehe allObjects()): objectOrder ist die Anzeige-/Ausgabe-Reihenfolge
  // ALLER bekannten Objekte (angehakt oder nicht) als Array von Schlüsseln
  // ("<Kürzel>|<Index>", siehe objKey()) - per Ziehen am Griff links neu
  // anordenbar (wireObjDrag()), ausgewählt = im DOM angehakt (keine
  // separate JS-Selektionsmenge, dieselbe Konvention wie die bisherigen
  // Checklisten). Bleibt über Render-Durchläufe hinweg bestehen, wird nur
  // bei neuem Datenimport zurückgesetzt (populateControls()) bzw. bei neuen
  // Formel-Spalten/Konfigurations-Import abgeglichen (reconcileObjectOrder()).
  let objectOrder = [];
  // Mehrfachauswahl in der Objekt-Liste (Strg-Klick) - rein zum GEMEINSAMEN
  // Ziehen mehrerer Zeilen auf einmal (siehe wireObjDrag()), unabhängig vom
  // Anhak-Status (checked = im Umlauf-Output, dieses Set = "zusammen
  // verschieben"). Bleibt über Render-Durchläufe hinweg bestehen (wie
  // objectOrder), wird gegen bekannte Objekte abgeglichen (renderObjList()).
  let multiSelectKeys = new Set();
  // Filterbedingungen (separat von der Objekt-Auswahl/Reihenfolge oben) -
  // jede Zeile UND-verknüpft: {id, key, op, value} - op/value-Bedeutung
  // hängt vom Objekttyp ab (Zustand-Gleichheit für SG/DET/FORMEL,
  // Vergleichsoperator+Zahl für APW/ÖPNV), siehe defaultCondFor()/
  // computeMatchingCycles().
  let filterRows = [];
  let nextFilterId = 1;

  // Manuelle Zeitmessung (Strg+Klick): Zustand pro (Umlauf, Spur) über
  // Render-Durchläufe hinweg - siehe wireMeasure()/measureClickHandler().
  // Schlüssel: "<Umlaufindex>|<Spurart>|<Bezeichner>", Wert: {a, b} in ms
  // (Unix-Zeit), b ist null solange nur eine Marke gesetzt ist.
  let measurements = new Map();

  function init(root) {
    els = {
      root,
      objList: root.querySelector('#upObjList'),
      objSearch: root.querySelector('#upObjSearch'),
      fzToggle: root.querySelector('#upFzToggle'),
      filterRowsEl: root.querySelector('#upFilterRows'),
      addFilterBtn: root.querySelector('#upAddFilterBtn'),
      hint: root.querySelector('#upHint'),
      tablePanel: root.querySelector('#upTablePanel'),
      sgLabel: root.querySelector('#upSgLabel'),
      info: root.querySelector('#upInfo'),
      rows: root.querySelector('#upRows'),
      diagramControls: root.querySelector('#upDiagramControls'),
      btnWinPrev: root.querySelector('#upBtnWinPrev'),
      winLabel: root.querySelector('#upWinLabel'),
      btnWinNext: root.querySelector('#upBtnWinNext'),
      winSize: root.querySelector('#upWinSize'),
      btnWinAll: root.querySelector('#upBtnWinAll'),
      configSaveBtn: root.querySelector('#upConfigSaveBtn'),
      configLoadInput: root.querySelector('#upConfigLoadInput')
    };

    els.objSearch.addEventListener('input', applyObjSearch);
    els.addFilterBtn.addEventListener('click', () => {
      const objs = allObjects();
      if (!objs.length) return;
      const first = objs[0];
      filterRows.push({ id: nextFilterId++, key: objKey(first), ...defaultCondFor(first.kuerzel) });
      renderFilterRows();
      windowStartIdx = 0; render();
    });

    els.configSaveBtn.addEventListener('click', saveConfig);
    els.configLoadInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) loadConfigFile(file);
      e.target.value = '';
    });

    els.btnWinPrev.addEventListener('click', () => {
      if (showAll) return;
      windowStartIdx = Math.max(0, windowStartIdx - windowCount);
      render();
    });
    els.btnWinNext.addEventListener('click', () => {
      if (showAll) return;
      const maxStart = Math.max(0, lastEffectiveCount - 1);
      windowStartIdx = Math.min(maxStart, windowStartIdx + windowCount);
      render();
    });
    els.winSize.addEventListener('change', () => {
      const v = parseInt(els.winSize.value, 10);
      windowCount = Number.isFinite(v) && v > 0 ? v : 20;
      els.winSize.value = windowCount;
      render();
    });
    els.btnWinAll.addEventListener('click', () => {
      showAll = !showAll;
      els.btnWinAll.textContent = showAll ? 'Fenster anzeigen' : 'Alle anzeigen';
      els.btnWinAll.classList.toggle('primary', showAll);
      render();
    });
  }

  // Formel-Builder-Ergebnisse (siehe formulaBuilder.js): read-only Zugriff,
  // NICHT die geteilte Analyse mutieren (gleiches Muster wie
  // GZ.views.oepnvQa.getRowsForSg). Leer, solange keine Formeln berechnet
  // wurden oder das Modul (noch) nicht geladen ist.
  function formulaCols() {
    return GZ.views.formulaBuilder ? GZ.views.formulaBuilder.getSyntheticColumns() : [];
  }

  // Eindeutiger, stabiler (innerhalb einer Sitzung) Schlüssel für ein
  // Objekt - SG-Spalten haben von Haus aus kein "kuerzel"-Feld, daher wie
  // schon beim bisherigen Filter synthetisch mit 'SG' getaggt; ihr "index"
  // ist die Position in allStats (nicht der rohe Spaltenindex), für DET/
  // APW/OEPNV/FORMEL ist es der echte (bei FORMEL: SYNTH_INDEX_BASE+id,
  // siehe formulaBuilder.js berechnen() - stabil über Neuberechnungen
  // hinweg, solange die Formel-Zeile nicht gelöscht/neu angelegt wird)
  // Spaltenindex.
  function objKey(c) { return c.kuerzel + '|' + c.index; }

  // Alle aktuell bekannten, in der vereinheitlichten Objekt-Liste wähl-
  // baren Objekte (Signalgruppen, Detektoren, APW/ÖPNV-Werte, synthetische
  // Formel-Spalten) - EINE gemeinsame Liste statt dreier getrennter
  // (ersetzt die früheren separaten SG-/DET-/APW-Checklisten). Reihenfolge
  // hier ist nur die "natürliche" Grundreihenfolge (Datenspalten, Formeln
  // am Ende) - die tatsächliche Anzeige-/Ausgabe-Reihenfolge liefert
  // objectOrder (siehe reconcileObjectOrder()).
  function allObjects() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return [];
    const sg = a.allStats.map(({ col }, i) => ({ kuerzel: 'SG', index: i, name: col.name, beschreibung: col.beschreibung }));
    const det = a.otherColumns.filter(c => c.kuerzel === 'DET').concat(formulaCols());
    const apw = a.otherColumns.filter(c => c.kuerzel === 'APW' || c.kuerzel === 'OEPNV');
    return sg.concat(det, apw);
  }

  function isNumericKuerzel(kuerzel) { return kuerzel === 'APW' || kuerzel === 'OEPNV'; }
  // DET und FORMEL teilen sich dieselbe WAHR/FALSCH-artige Belegungslogik
  // (categorizeDetRaw) und damit dieselben Zustände (BELEGT/FREI).
  function stateOptionsFor(kuerzel) {
    const want = kuerzel === 'SG' ? 'KAT_SG' : 'KAT_DET';
    return Object.keys(GZ.exprEngine.KAT_TOKENS).filter(k => GZ.exprEngine.KAT_TOKENS[k] === want);
  }
  function defaultCondFor(kuerzel) {
    return isNumericKuerzel(kuerzel) ? { op: '>', value: 0 } : { op: '==', value: stateOptionsFor(kuerzel)[0] };
  }

  // Gleicht objectOrder gegen die aktuell bekannten Objekte ab: bestehende
  // Reihenfolge bleibt erhalten (auch für nicht angehakte Objekte), neue
  // Objekte (z.B. gerade berechnete Formeln, oder aus einer geladenen
  // Konfiguration übrig gebliebene) werden ans Ende angehängt, nicht mehr
  // vorhandene (gelöschte Formel, neuer Datenimport mit anderen Spalten)
  // entfernt. Idempotent - darf beliebig oft aufgerufen werden.
  function reconcileObjectOrder(objs) {
    const known = new Set(objs.map(objKey));
    const kept = objectOrder.filter(k => known.has(k));
    const keptSet = new Set(kept);
    objs.forEach(o => { const k = objKey(o); if (!keptSet.has(k)) kept.push(k); });
    objectOrder = kept;
    return objectOrder;
  }

  // Baut die vereinheitlichte Objekt-Liste (#upObjList) aus objectOrder neu
  // auf. explicitSelected (Set von Schlüsseln) überschreibt bei Bedarf den
  // Auswahl-Zustand komplett (nur von applyConfig() beim Laden einer
  // Konfiguration genutzt) - normalerweise wird der bisherige DOM-Zustand
  // (angehakte Checkboxen) erhalten, wie schon bei den früheren
  // Checklisten. Ohne jede Vorgeschichte (erstes Rendern nach Datenimport)
  // ist nur die erste Signalgruppe vorausgewählt.
  function renderObjList(explicitSelected) {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const objs = allObjects();
    const hasExplicit = explicitSelected instanceof Set;
    const hadRows = els.objList.querySelectorAll('.obj-row').length > 0;
    const prevChecked = hasExplicit ? explicitSelected
      : new Set([...els.objList.querySelectorAll('input:checked')].map(cb => cb.closest('.obj-row').dataset.key));
    reconcileObjectOrder(objs);
    const byKey = new Map(objs.map(o => [objKey(o), o]));
    multiSelectKeys = new Set([...multiSelectKeys].filter(k => byKey.has(k)));
    const rows = objectOrder.map(k => byKey.get(k)).filter(Boolean);

    els.objList.innerHTML = rows.length ? rows.map(c => {
      const key = objKey(c);
      const label = c.beschreibung && c.beschreibung !== c.name ? `${c.name} – ${c.beschreibung}` : c.name;
      const checked = (hasExplicit || hadRows) ? prevChecked.has(key) : (c.kuerzel === 'SG' && c.index === 0);
      const selected = multiSelectKeys.has(key);
      return `<div class="obj-row${selected ? ' obj-row-selected' : ''}" data-key="${esc(key)}">
        <span class="obj-drag" title="Ziehen zum Sortieren (mehrere: erst mit Strg-Klick auswählen)">⠿</span>
        <label class="obj-row-label">
          <input type="checkbox" ${checked ? 'checked' : ''}>
          <span class="filter-kuerzel">${esc(c.kuerzel)}</span>
          <span class="obj-row-name">${esc(label)}</span>
        </label>
      </div>`;
    }).join('') : '<div class="obj-list-empty">Keine Objekte erkannt.</div>';

    els.objList.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = render);
    wireObjDrag();
    applyObjSearch();
  }

  // Reine Sichtbarkeits-Filterung der Liste nach Name/Kürzel - beeinflusst
  // NICHT Auswahl oder Reihenfolge (siehe Nutzeranforderung: Suche dient
  // nur dem schnelleren Finden eines Objekts in der Liste).
  function applyObjSearch() {
    if (!els || !els.objSearch) return;
    const q = els.objSearch.value.trim().toLowerCase();
    els.objList.querySelectorAll('.obj-row').forEach(row => {
      const hay = row.querySelector('.obj-row-name').textContent.toLowerCase() + ' ' + row.querySelector('.filter-kuerzel').textContent.toLowerCase();
      row.classList.toggle('obj-row-hidden', !!q && !hay.includes(q));
    });
  }

  // Aktualisiert nur die .obj-row-selected-Klasse anhand von multiSelectKeys
  // (leichtgewichtig - KEIN render(), Mehrfachauswahl betrifft nur, welche
  // Zeilen später gemeinsam gezogen werden, nicht den Umlauf-Output).
  function updateObjSelectionHighlight() {
    els.objList.querySelectorAll('.obj-row').forEach(row => {
      row.classList.toggle('obj-row-selected', multiSelectKeys.has(row.dataset.key));
    });
  }

  // Ziehen-zum-Sortieren per natives HTML5 Drag&Drop, nur vom Griff (.obj-
  // drag) auslösbar: die Zeile selbst ist standardmäßig NICHT draggable
  // (sonst würde ein Klick auf die Checkbox/den Namen versehentlich einen
  // Drag statt eines Checkbox-Toggles/einer Textselektion auslösen) - erst
  // ein mousedown auf dem Griff schaltet draggable für diese eine Zeile
  // scharf, dragend schaltet es wieder aus. Während des Ziehens wird die
  // gezogene (Anker-)Zeile LIVE an die Zielposition verschoben (einfaches,
  // robustes Muster ohne zusätzliche Bibliothek); beim Ablegen wird die
  // jetzt im DOM sichtbare Reihenfolge in objectOrder übernommen und die
  // Umlauf-Ausgabe neu gerendert.
  //
  // Mehrfachauswahl (Strg-Klick, siehe multiSelectKeys): ist die gezogene
  // Zeile Teil einer Mehrfachauswahl mit >1 Elementen, werden die ANDEREN
  // ausgewählten Zeilen während des Ziehens nur optisch abgedunkelt
  // (.dragging-group) statt live mitverschoben (kein vollwertiges Multi-
  // Element-Drag nötig) - beim Ablegen (dragend) werden dann ALLE
  // ausgewählten Schlüssel (in ihrer bisherigen relativen Reihenfolge
  // zueinander, siehe objectOrder.filter()) gemeinsam an die Position der
  // Anker-Zeile eingefügt. Wird eine Zeile gezogen, die NICHT Teil der
  // aktuellen Mehrfachauswahl ist, ersetzt sie die Auswahl (zieht allein) -
  // wie in üblichen Datei-Manager-Listen.
  //
  // Zeilen- und Listen-Level-Handler sind getrennt: Zeilen werden bei jedem
  // renderObjList() neu erzeugt (mousedown/click müssen daher jedes Mal neu
  // verdrahtet werden), der Listen-Container selbst bleibt bestehen (drag-/
  // dragover/dragend nur EINMAL verdrahtet, per Event-Delegation über
  // e.target.closest()).
  let dragAnchorKey = null;
  function wireObjDrag() {
    els.objList.querySelectorAll('.obj-drag').forEach(handle => {
      handle.onmousedown = () => { const row = handle.closest('.obj-row'); if (row) row.draggable = true; };
    });
    els.objList.querySelectorAll('.obj-row').forEach(row => {
      row.onclick = e => {
        if (!(e.ctrlKey || e.metaKey)) { if (multiSelectKeys.size) { multiSelectKeys.clear(); updateObjSelectionHighlight(); } return; }
        if (e.target.closest('.obj-drag')) return; // Griff hat eigene Semantik (startet Drag)
        e.preventDefault(); // verhindert, dass der Klick zusätzlich die Checkbox umschaltet
        const key = row.dataset.key;
        if (multiSelectKeys.has(key)) multiSelectKeys.delete(key); else multiSelectKeys.add(key);
        updateObjSelectionHighlight();
      };
    });
    if (els.objList.__dragWired) return;
    els.objList.__dragWired = true;
    els.objList.addEventListener('dragstart', e => {
      const row = e.target.closest('.obj-row');
      if (!row || !row.draggable) { e.preventDefault(); return; }
      dragAnchorKey = row.dataset.key;
      if (!multiSelectKeys.has(dragAnchorKey)) { multiSelectKeys = new Set([dragAnchorKey]); updateObjSelectionHighlight(); }
      row.classList.add('dragging');
      if (multiSelectKeys.size > 1) {
        els.objList.querySelectorAll('.obj-row').forEach(r => {
          if (r !== row && multiSelectKeys.has(r.dataset.key)) r.classList.add('dragging-group');
        });
      }
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragAnchorKey); } catch (err) { /* Firefox braucht Daten, Chrome ist tolerant */ }
    });
    els.objList.addEventListener('dragover', e => {
      const draggingRow = els.objList.querySelector('.obj-row.dragging');
      if (!draggingRow) return;
      e.preventDefault();
      const overRow = e.target.closest('.obj-row');
      if (!overRow || overRow === draggingRow) return;
      const rect = overRow.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      overRow.parentNode.insertBefore(draggingRow, before ? overRow : overRow.nextSibling);
    });
    els.objList.addEventListener('dragend', () => {
      // Nur die Anker-Zeile wurde während dragover live im DOM verschoben
      // (siehe Kopfkommentar) - die übrigen Gruppenmitglieder stehen dort
      // noch an ihrer ALTEN Position. Reihenfolge daher NICHT direkt aus dem
      // DOM übernehmen (wie beim Einzel-Drag), sondern rechnerisch bilden:
      // alle Gruppenschlüssel aus der DOM-Reihenfolge herauslösen und
      // gemeinsam an der (auf die verbleibenden Zeilen umgerechneten)
      // Ankerposition wieder einfügen - anschließend #upObjList komplett aus
      // dem neuen objectOrder neu aufbauen (renderObjList()), damit DOM und
      // objectOrder wieder übereinstimmen, BEVOR render() die Checkbox-
      // Reihenfolge aus dem DOM ausliest.
      const domOrder = [...els.objList.querySelectorAll('.obj-row')].map(r => r.dataset.key);
      const groupKeys = multiSelectKeys.size > 1 && multiSelectKeys.has(dragAnchorKey)
        ? objectOrder.filter(k => multiSelectKeys.has(k)) // bisherige relative Reihenfolge untereinander erhalten
        : [dragAnchorKey];
      const anchorDomIdx = domOrder.indexOf(dragAnchorKey);
      let insertAt = 0;
      for (let i = 0; i < anchorDomIdx; i++) { if (!groupKeys.includes(domOrder[i])) insertAt++; }
      const rest = domOrder.filter(k => !groupKeys.includes(k));
      rest.splice(insertAt, 0, ...groupKeys);
      objectOrder = rest;
      dragAnchorKey = null;
      renderObjList();
      render();
    });
  }

  // Baut die Filterbedingungs-Zeilen (#upFilterRows) neu auf - separat von
  // der Objekt-Liste oben (eigene Objekt-Auswahl je Zeile per <select>,
  // unbeeinflusst von deren Sortierung/Suche). Je Zeile eine typabhängige
  // Bedingung: Zustand-Gleichheit (SG/DET/FORMEL) oder Operator+Zahl (APW/
  // ÖPNV) - siehe filterCondHtml()/computeMatchingCycles().
  function renderFilterRows() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const objs = allObjects();
    const objsByKey = new Map(objs.map(o => [objKey(o), o]));
    // Verwaiste Zeilen (Objekt existiert nicht mehr, z.B. gelöschte Formel
    // oder neuer Datenimport) still entfernen statt kaputt anzuzeigen.
    filterRows = filterRows.filter(fr => objsByKey.has(fr.key));

    const groups = [
      { label: 'Signalgruppen', items: objs.filter(o => o.kuerzel === 'SG') },
      { label: 'Detektoren', items: objs.filter(o => o.kuerzel === 'DET') },
      { label: 'Formeln', items: objs.filter(o => o.kuerzel === 'FORMEL') },
      { label: 'APW/ÖPNV-Werte', items: objs.filter(o => isNumericKuerzel(o.kuerzel)) }
    ].filter(g => g.items.length);

    els.filterRowsEl.innerHTML = filterRows.length ? filterRows.map(fr => {
      const c = objsByKey.get(fr.key);
      const objOptions = groups.map(g => `<optgroup label="${esc(g.label)}">${g.items.map(o =>
        `<option value="${esc(objKey(o))}" ${objKey(o) === fr.key ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</optgroup>`).join('');
      return `<div class="up-filter-row" data-id="${fr.id}">
        <select class="up-filter-obj">${objOptions}</select>
        <span class="up-filter-cond">${filterCondHtml(c.kuerzel, fr)}</span>
        <button type="button" class="oe-row-remove up-filter-remove">✕</button>
      </div>`;
    }).join('') : '<div class="cfg-empty">Keine Filterbedingungen – alle Umläufe werden angezeigt.</div>';

    els.filterRowsEl.querySelectorAll('.up-filter-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const fr = filterRows.find(x => x.id === id);
      if (!fr) return;
      rowEl.querySelector('.up-filter-obj').onchange = e => {
        const newC = objsByKey.get(e.target.value);
        fr.key = e.target.value;
        // Bedingungstyp kann beim Objektwechsel wechseln (Zustand <-> Zahl)
        // - Operator/Wert auf einen für den NEUEN Typ sinnvollen Default
        // zurücksetzen, statt einen jetzt bedeutungslosen alten Wert
        // stehenzulassen.
        Object.assign(fr, defaultCondFor(newC.kuerzel));
        renderFilterRows();
        windowStartIdx = 0; render();
      };
      const opSel = rowEl.querySelector('.up-filter-op');
      if (opSel) opSel.onchange = e => { fr.op = e.target.value; windowStartIdx = 0; render(); };
      const valNum = rowEl.querySelector('.up-filter-val');
      if (valNum) valNum.onchange = e => { fr.value = Number(e.target.value); windowStartIdx = 0; render(); };
      const valState = rowEl.querySelector('.up-filter-val-state');
      if (valState) valState.onchange = e => { fr.value = e.target.value; windowStartIdx = 0; render(); };
      rowEl.querySelector('.up-filter-remove').onclick = () => {
        filterRows = filterRows.filter(x => x.id !== id);
        renderFilterRows();
        windowStartIdx = 0; render();
      };
    });
  }

  function filterCondHtml(kuerzel, fr) {
    if (isNumericKuerzel(kuerzel)) {
      const ops = ['=', '!=', '>', '>=', '<', '<='];
      return `<select class="up-filter-op">${ops.map(o => `<option value="${esc(o)}" ${o === fr.op ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
        <input type="number" class="up-filter-val" value="${esc(String(fr.value ?? 0))}" step="any">`;
    }
    const opts = stateOptionsFor(kuerzel);
    return `<span class="filter-kuerzel">Zustand =</span>
      <select class="up-filter-val-state">${opts.map(o => `<option value="${esc(o)}" ${o === fr.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }

  // Nach "Berechnen" im Formel-Builder aufgerufen: Objekt-Liste + Filter-
  // zeilen (die jetzt ggf. neue/geänderte Formel-Spalten enthalten/
  // referenzieren) neu aufbauen und neu rendern - bewusst OHNE Fenster-
  // position/Messungen zurückzusetzen (anders als populateControls() bei
  // einem komplett neuen Datenimport).
  function refreshFormulaColumns() {
    if (!els) return;
    renderObjList();
    renderFilterRows();
    render();
  }

  /* ---------------- Konfiguration speichern/laden (JSON) ----------------
     Spaltenverweise (Kürzel+Name statt Rohindex, siehe GZ.configIO) statt
     Rohdaten - eine gespeicherte Konfiguration bleibt so über neue Exports
     derselben Anlage hinweg anwendbar, auch wenn sich Spaltenindizes/
     Zeilenzahl ändern. Enthält NICHT die CSV selbst (bis zu 100k Zeilen). */
  // objects: EIN Array (statt dreier getrennter Listen) in objectOrder-
  // Reihenfolge - jeder Eintrag trägt "selected" (angehakt?) mit, deckt
  // also sowohl Auswahl als auch Reihenfolge ab. filters: eine Zeile je
  // Filterbedingung (Objekt + Operator + Wert).
  function getConfig() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return null;
    const objs = allObjects();
    const objsByKey = new Map(objs.map(o => [objKey(o), o]));
    const checkedKeys = new Set([...els.objList.querySelectorAll('input:checked')].map(cb => cb.closest('.obj-row').dataset.key));
    const objectsCfg = objectOrder.map(k => objsByKey.get(k)).filter(Boolean).map(c => ({
      kuerzel: c.kuerzel, name: c.name, selected: checkedKeys.has(objKey(c))
    }));
    const filtersCfg = filterRows.map(fr => {
      const c = objsByKey.get(fr.key);
      return c ? { kuerzel: c.kuerzel, name: c.name, op: fr.op, value: fr.value } : null;
    }).filter(Boolean);
    return {
      objects: objectsCfg,
      filters: filtersCfg,
      fzEnabled: !!(els.fzToggle && els.fzToggle.checked),
      windowSize: windowCount
    };
  }

  // Reihenfolge wichtig: wird von loadConfigFile() erst NACH
  // GZ.views.formulaBuilder.applyConfig() aufgerufen, damit ggf. gespeicherte
  // FORMEL-Auswahlen bereits existierende, neu berechnete Spalten vorfinden.
  // Spaltenverweise werden wie zuvor über Kürzel+Name aufgelöst (nicht den
  // rohen Index, der sich zwischen Aufzeichnungen ändern kann) - Objekte in
  // der gespeicherten Konfiguration, die im aktuellen Datensatz nicht
  // (mehr) existieren, landen in "skipped"; Objekte im aktuellen Datensatz,
  // die die gespeicherte Konfiguration nicht kennt (z.B. seither neu
  // berechnete Formel), werden von renderObjList()/reconcileObjectOrder()
  // automatisch ans Ende angehängt.
  function applyConfig(cfg) {
    if (!cfg) return { skipped: [] };
    const a = GZ.state.data.currentAnalysis;
    if (!a) return { skipped: ['Keine Daten geladen'] };
    const skipped = [];
    const objs = allObjects();
    const byNameKey = new Map(objs.map(o => [o.kuerzel + '|' + o.name, o]));

    const orderedKeys = [];
    const selectedKeys = new Set();
    (cfg.objects || []).forEach(ref => {
      const c = byNameKey.get(ref.kuerzel + '|' + ref.name);
      if (!c) { skipped.push(`Objekt „${ref.name}“`); return; }
      orderedKeys.push(objKey(c));
      if (ref.selected) selectedKeys.add(objKey(c));
    });
    objectOrder = orderedKeys;

    filterRows = (cfg.filters || []).map(f => {
      const c = byNameKey.get(f.kuerzel + '|' + f.name);
      if (!c) { skipped.push(`Filter „${f.name}“`); return null; }
      return { id: nextFilterId++, key: objKey(c), op: f.op, value: f.value };
    }).filter(Boolean);

    if (els.fzToggle) els.fzToggle.checked = !!cfg.fzEnabled;
    if (cfg.windowSize) { windowCount = cfg.windowSize; els.winSize.value = windowCount; }
    windowStartIdx = 0;

    renderObjList(selectedKeys);
    renderFilterRows();
    render();
    return { skipped };
  }

  function saveConfig() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const cfg = {
      version: 1,
      fingerprint: GZ.configIO.buildFingerprint(a),
      umlaufpruefung: getConfig(),
      formulaBuilder: GZ.views.formulaBuilder ? GZ.views.formulaBuilder.getConfig() : null
    };
    GZ.configIO.downloadJson('umlaufpruefung_konfiguration.json', cfg);
  }

  async function loadConfigFile(file) {
    const a = GZ.state.data.currentAnalysis;
    if (!a) {
      els.hint.textContent = 'Bitte zuerst Daten laden/analysieren.'; els.hint.className = 'hint warn';
      if (GZ.snackbar) GZ.snackbar.show('Konfiguration kann nicht geladen werden', { type: 'warning', description: 'Bitte zuerst Daten laden/analysieren.' });
      return;
    }
    let cfg;
    try { cfg = await GZ.configIO.readJsonFile(file); }
    catch (e) {
      els.hint.textContent = e.message; els.hint.className = 'hint warn';
      if (GZ.snackbar) GZ.snackbar.show('Konfiguration konnte nicht gelesen werden', { type: 'error', description: e.message });
      return;
    }

    const match = GZ.configIO.fingerprintMatches(cfg.fingerprint, a);
    const notes = [];
    if (!match.exact) {
      notes.push(match.columnsMatch
        ? 'Spaltenstruktur passt, aber andere Aufzeichnung (Zeitraum/Zeilenzahl weichen ab) – Zuordnung erfolgte über Spaltennamen.'
        : 'Spaltenstruktur weicht von der gespeicherten Konfiguration ab – ggf. nicht alle Einstellungen übernommen.');
    }

    // Formeln ZUERST anwenden + berechnen, damit applyConfig() unten
    // gespeicherte FORMEL-Auswahlen in der bereits aktualisierten
    // Detektor-/Filterliste wiederfinden kann.
    const formulaSkipped = GZ.views.formulaBuilder ? GZ.views.formulaBuilder.applyConfig(cfg.formulaBuilder).skipped : [];
    const upSkipped = applyConfig(cfg.umlaufpruefung).skipped;

    const allSkipped = formulaSkipped.concat(upSkipped);
    els.hint.textContent = ['Konfiguration geladen.', ...notes, allSkipped.length ? `Nicht gefunden: ${allSkipped.join(', ')}.` : '']
      .filter(Boolean).join(' ');
    els.hint.className = 'hint' + ((notes.length || allSkipped.length) ? ' warn' : '');
    if ((notes.length || allSkipped.length) && GZ.snackbar) {
      GZ.snackbar.show('Konfiguration teilweise geladen', {
        type: 'warning',
        description: [...notes, allSkipped.length ? `Nicht gefunden: ${allSkipped.join(', ')}.` : ''].filter(Boolean).join(' ')
      });
    }
  }

  function populateControls() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    measurements = new Map();
    // Kompletter Neustart der Objekt-Reihenfolge/Auswahl und Filter bei
    // einem neuen Datenimport (reconcileObjectOrder() würde ohnehin nicht
    // mehr existierende Schlüssel verwerfen, aber ein expliziter Reset ist
    // klarer als sich darauf zu verlassen).
    objectOrder = [];
    filterRows = [];

    renderObjList();
    renderFilterRows();

    windowStartIdx = 0;
    showAll = false;
    els.btnWinAll.textContent = 'Alle anzeigen';
    els.btnWinAll.classList.remove('primary');

    wireEvents();
    render();
  }

  function wireEvents() {
    els.fzToggle.onchange = render;
  }

  function windowRange(n) {
    if (showAll || n <= 0) return { from: 0, to: n };
    const from = Math.max(0, Math.min(windowStartIdx, Math.max(0, n - 1)));
    return { from, to: Math.min(from + windowCount, n) };
  }

  /* ---------------- Manuelle Zeitmessung (Strg+Klick) ---------------- */
  // 3-Klick-Zyklus je Spur: leer -> erste Marke -> zweite Marke (Differenz
  // wird angezeigt) -> nächster Strg+Klick verwirft beide und beginnt an der
  // geklickten Stelle neu. Zeiten werden auf die volle Sekunde gerundet.
  function measureClickHandler(svgEl, wMin, wMax, key) {
    return function (event) {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();
      const width = svgEl.clientWidth;
      if (!width) return;
      const rect = svgEl.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);
      let t = Math.round(x.invert(px) / 1000) * 1000;
      t = Math.max(wMin, Math.min(wMax, t));

      const cur = measurements.get(key);
      let next;
      if (!cur || cur.a == null) next = { a: t, b: null };
      else if (cur.b == null) next = { a: cur.a, b: t };
      else next = { a: t, b: null };
      measurements.set(key, next);
      drawMeasureOverlay(svgEl, wMin, wMax, next);
    };
  }

  function drawMeasureOverlay(svgEl, wMin, wMax, mark) {
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return;
    const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);
    let g = d3.select(svgEl).select('g.measure-layer');
    if (g.empty()) g = d3.select(svgEl).append('g').attr('class', 'measure-layer').style('pointer-events', 'none');
    g.selectAll('*').remove();
    if (!mark || mark.a == null) return;

    const capTop = height * 0.12, capBot = height * 0.88;
    const drawCap = (t) => {
      const px = x(t);
      g.append('line').attr('class', 'measure-cap-halo').attr('x1', px).attr('x2', px).attr('y1', capTop).attr('y2', capBot);
      g.append('line').attr('class', 'measure-cap').attr('x1', px).attr('x2', px).attr('y1', capTop).attr('y2', capBot);
    };
    drawCap(mark.a);
    if (mark.b == null) return;
    drawCap(mark.b);

    const t0 = Math.min(mark.a, mark.b), t1 = Math.max(mark.a, mark.b);
    const xa = x(t0), xb = x(t1);
    [['measure-line-halo'], ['measure-line']].forEach(([cls]) => {
      g.append('line').attr('class', cls).attr('x1', xa).attr('x2', xb).attr('y1', height / 2).attr('y2', height / 2);
    });
    const secs = Math.round((t1 - t0) / 1000);
    g.append('text').attr('class', 'measure-label')
      .attr('x', (xa + xb) / 2).attr('y', height / 2).attr('dy', '-4')
      .text(`${secs}s`)
      .append('title').text(`${fmtTimeShort(t0)}–${fmtTimeShort(t1)} (${secs}s)`);
  }

  // Nach jedem renderLane()-Aufruf: Klick-Handler (neu) verdrahten und den
  // gespeicherten Messwert dieser Spur (falls vorhanden) neu einzeichnen -
  // renderLane() leert das SVG bei jedem Aufruf, daher muss die Übermalung
  // danach passieren, nicht davor.
  function wireMeasure(svgEl, wMin, wMax, key) {
    if (svgEl.__measureClickHandler) svgEl.removeEventListener('click', svgEl.__measureClickHandler, true);
    const handler = measureClickHandler(svgEl, wMin, wMax, key);
    svgEl.__measureClickHandler = handler;
    svgEl.addEventListener('click', handler, true);
    drawMeasureOverlay(svgEl, wMin, wMax, measurements.get(key));
  }

  /* ---------------- Sekunden-Fadenkreuz (Hover, alle Spuren eines Umlaufs) --------------
     Läuft je Umlauf-Gruppe (nicht je Spur) - eine senkrechte Linie in ALLEN
     Spuren-SVGs dieser Gruppe an derselben (auf volle Sekunde gerundeten,
     NICHT interpolierten) x-Position, plus ein Label darunter mit der
     seit Umlaufbeginn vergangenen Zeit (TX in Sekunden). Rein visuell/
     ephemer (kein persistenter Zustand über Render-Durchläufe hinweg nötig,
     anders als die Strg+Klick-Messung oben). */
  function wireCrosshair(groupEl, wMin, wMax) {
    if (groupEl.__crosshairMove) groupEl.removeEventListener('mousemove', groupEl.__crosshairMove);
    if (groupEl.__crosshairLeave) groupEl.removeEventListener('mouseleave', groupEl.__crosshairLeave);

    let label = groupEl.querySelector('.up-crosshair-label');
    if (!label) {
      label = document.createElement('div');
      label.className = 'up-crosshair-label';
      groupEl.appendChild(label);
    }

    const clear = () => {
      groupEl.querySelectorAll('.lane-track svg g.crosshair-layer').forEach(g => g.remove());
      label.style.display = 'none';
    };

    const onMove = (event) => {
      const trackEl = event.target.closest && event.target.closest('.lane-track');
      if (!trackEl || !groupEl.contains(trackEl)) { clear(); return; }
      const rect = trackEl.getBoundingClientRect();
      if (!rect.width) { clear(); return; }
      const px = event.clientX - rect.left;
      if (px < 0 || px > rect.width) { clear(); return; }
      const xTrack = d3.scaleLinear().domain([wMin, wMax]).range([0, rect.width]);
      let t = Math.round(xTrack.invert(px) / 1000) * 1000;
      t = Math.max(wMin, Math.min(wMax, t));

      groupEl.querySelectorAll('.lane-track svg').forEach(svg => {
        const w = svg.clientWidth, h = svg.clientHeight;
        if (!w || !h) return;
        const x = d3.scaleLinear().domain([wMin, wMax]).range([0, w]);
        const lx = x(t);
        let g = d3.select(svg).select('g.crosshair-layer');
        if (g.empty()) g = d3.select(svg).append('g').attr('class', 'crosshair-layer').style('pointer-events', 'none');
        g.selectAll('*').remove();
        g.append('line').attr('class', 'crosshair-line-halo').attr('x1', lx).attr('x2', lx).attr('y1', 0).attr('y2', h);
        g.append('line').attr('class', 'crosshair-line').attr('x1', lx).attr('x2', lx).attr('y1', 0).attr('y2', h);
      });

      const groupRect = groupEl.getBoundingClientRect();
      label.textContent = String(Math.round((t - wMin) / 1000));
      label.style.left = `${rect.left - groupRect.left + xTrack(t)}px`;
      label.style.display = 'block';
    };

    groupEl.addEventListener('mousemove', onMove);
    groupEl.addEventListener('mouseleave', clear);
    groupEl.__crosshairMove = onMove;
    groupEl.__crosshairLeave = clear;
  }

  /* ---------------- ÖV-Fahrzeiten je Signalgruppe ---------------- */
  // Übernimmt die im Tab "ÖPNV" für die gegebene Signalgruppe konfigurierten
  // Zeilen und berechnet die Anmeldung/Abmeldung-Ereignisse einmal über die
  // gesamte Aufzeichnung (wie die Detektor-Segmente), für den Sweep je
  // Umlauf-Fenster. Siehe computeOepnvEvents (GZ.oepnvLogic) für die Logik.
  function buildFzRowsForSg(sgIdx, times, seriesByCol, splValues) {
    const oepnvRows = GZ.views.oepnvQa ? GZ.views.oepnvQa.getRowsForSg(sgIdx) : [];
    return oepnvRows.map(orow => {
      const anOccupied = times.map((_, i) => orow.anDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
      const abOccupied = times.map((_, i) => orow.abDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
      const { events, unresolved } = computeOepnvEvents(times, anOccupied, abOccupied, splValues, [], orow.sollfahrzeitSek, orow.zwangsloeschSek);

      const fzSegs = [];
      const zwlSegs = [];
      const addPair = (anTime, endTime) => {
        const sollEnd = anTime + orow.sollfahrzeitSek * 1000;
        fzSegs.push({ start: anTime, end: Math.min(sollEnd, endTime), cat: 'FZ_SOLL', sollfahrzeitSek: orow.sollfahrzeitSek });
        if (endTime > sollEnd) {
          fzSegs.push({ start: sollEnd, end: endTime, cat: 'FZ_VERLUST', verlustSek: (endTime - sollEnd) / 1000 });
        }
        zwlSegs.push({ start: anTime, end: anTime + orow.zwangsloeschSek * 1000, cat: 'ZWL_WINDOW', zwangsloeschSek: orow.zwangsloeschSek });
      };
      events.forEach(e => addPair(e.anTime, e.endTime));
      if (unresolved) addPair(unresolved.startTime, unresolved.startTime + orow.sollfahrzeitSek * 1000);

      return {
        label: orow.anDetCols.map(c => c.name).join('+'),
        fzSweep: makeIntervalSweep(fzSegs), zwlSweep: makeIntervalSweep(zwlSegs)
      };
    });
  }

  // Filtern: liefert die Indizes aller Umläufe, die JEDE Filterbedingung
  // erfüllen (UND-Verknüpfung, siehe filterRows/renderFilterRows()). Zwei
  // Prüfarten je nach Objekttyp:
  // - Zustand (SG/DET/FORMEL): Segmente nach der gewählten Kategorie
  //   filtern, dann existenziell prüfen ("war das Objekt irgendwann im
  //   Umlauf in diesem Zustand?", per makeIntervalSweep) - für SG reicht
  //   ein Filter der bereits vorhandenen allStats[i].segs (ALLE Zustände,
  //   nicht nur die vorberechneten Grünphasen), für DET/FORMEL wie zuvor
  //   ein frischer Segment-Aufbau über categorizeDetRaw.
  // - Zahl (APW/ÖPNV): linearer Rohwert-Scan über die Zeilen des Umlaufs
  //   gegen den gewählten Vergleichsoperator - Lücken/nicht-numerische
  //   Rohwerte erfüllen nie eine Bedingung (Number('') ist NaN, jeder
  //   Vergleich damit liefert false).
  // Ein einmaliger Vollscan über die Aufzeichnung (wie die Detektor-/APW-
  // Sweeps oben) statt pro Umlauf neu zu scannen.
  function computeMatchingCycles(conditions, objsByKey, allStats, cycleStarts, tMax, times, seriesByCol) {
    const n = cycleStarts.length;
    const numCmp = { '=': (a, b) => a === b, '!=': (a, b) => a !== b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b };
    const stateSweeps = [];
    const numChecks = [];
    conditions.forEach(fr => {
      const c = objsByKey.get(fr.key);
      if (!c) return;
      if (isNumericKuerzel(c.kuerzel)) {
        numChecks.push({ index: c.index, op: fr.op, value: Number(fr.value) });
      } else {
        const segs = c.kuerzel === 'SG'
          ? allStats[c.index].segs.filter(s => s.cat === fr.value)
          : buildSegments(times, seriesByCol.get(c.index), categorizeDetRaw).filter(s => s.cat === fr.value);
        stateSweeps.push(makeIntervalSweep(segs));
      }
    });

    const matches = [];
    let ptr = 0;
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      while (ptr < times.length && times[ptr] < start) ptr++;
      const rowFrom = ptr;
      while (ptr < times.length && times[ptr] < end) ptr++;
      const rowTo = ptr;
      const stateOk = stateSweeps.every(sweep => sweep(start, end).length > 0);
      const numOk = numChecks.every(({ index, op, value }) => {
        const vals = seriesByCol.get(index);
        const cmp = numCmp[op];
        for (let k = rowFrom; k < rowTo; k++) {
          const num = Number((vals[k] || '').trim());
          if (!Number.isNaN(num) && cmp(num, value)) return true;
        }
        return false;
      });
      if (stateOk && numOk) matches.push(i);
    }
    return matches;
  }

  function render() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { allStats, cycleStarts, tMax, times, splValues, seriesByCol: seriesByColReal, otherColumns: otherColumnsReal } = a;

    // Synthetische Formel-Spalten NICHT in die geteilte Analyse mutieren -
    // stattdessen hier lokal einmischen (seriesByCol bleibt bei leerer
    // formulaCols()-Liste dieselbe Map-Referenz, keine unnötige Kopie).
    const fCols = formulaCols();
    const otherColumns = fCols.length ? otherColumnsReal.concat(fCols) : otherColumnsReal;
    const seriesByCol = fCols.length ? new Map(seriesByColReal) : seriesByColReal;
    fCols.forEach(c => seriesByCol.set(c.index, c.rawSeries));

    if (!cycleStarts || cycleStarts.length < 2) {
      els.tablePanel.style.display = 'none';
      els.diagramControls.style.display = 'none';
      els.hint.textContent = 'Zu wenige erkannte Umläufe (TX=0-Wechsel) für diese Auswertung.';
      return;
    }

    // Eine gemeinsame, geordnete Liste angehakter Objekte (SG UND DET/APW/
    // OEPNV/FORMEL gemischt) statt dreier getrennter Checklisten - die
    // Reihenfolge ergibt sich direkt aus der DOM-Reihenfolge der
    // angehakten Checkboxen in #upObjList (per Ziehen am Griff sortierbar,
    // siehe wireObjDrag()), sgRefs/traceRefs sind reine .filter()-
    // Teilmengen davon und behalten daher dieselbe relative Reihenfolge -
    // das treibt weiter unten die verschachtelte Zeilen-Reihenfolge.
    const objsNow = allObjects();
    const objsByKey = new Map(objsNow.map(o => [objKey(o), o]));
    const objRefs = [...els.objList.querySelectorAll('input:checked')]
      .map(cb => objsByKey.get(cb.closest('.obj-row').dataset.key))
      .filter(Boolean);
    const sgRefs = objRefs.filter(r => r.kuerzel === 'SG');
    const traceRefs = objRefs.filter(r => r.kuerzel !== 'SG');

    if (sgRefs.length === 0) {
      els.tablePanel.style.display = 'none';
      els.diagramControls.style.display = 'none';
      els.hint.textContent = 'Bitte mindestens eine Signalgruppe auswählen.';
      return;
    }

    const TU = computeGlobalTU(cycleStarts);
    const anomalyCtx = GZ.state.anomalyCtx();
    const fzEnabled = !!(els.fzToggle && els.fzToggle.checked);

    const sgData = sgRefs.map(r => {
      const sgIdx = r.index;
      const sgEntry = allStats[sgIdx];
      if (!sgEntry) return null;
      const { segs, stats } = sgEntry;
      return {
        sgIdx, sgEntry, segs, stats,
        flags: getFlaggedAnomalies(stats, anomalyCtx),
        greenSweep: makeIndexSweep(stats.greens),
        segSweep: makeIntervalSweep(segs),
        fzRows: fzEnabled ? buildFzRowsForSg(sgIdx, times, seriesByCol, splValues) : []
      };
    }).filter(Boolean);

    const missingFz = fzEnabled ? sgData.filter(sd => sd.fzRows.length === 0).map(sd => sd.sgEntry.col.name) : [];
    els.hint.textContent = missingFz.length
      ? `Keine ÖPNV-Konfiguration für: ${missingFz.join(', ')} – bitte im Tab „ÖPNV“ anlegen.`
      : '';

    // Nicht-SG-Spuren (DET/FORMEL/APW/OEPNV) - bis auf die Segmentierungs-
    // Funktion (kind bestimmt außerdem die Darstellung beim SVG-Rendern
    // weiter unten) identisch behandelt, damit sie sich frei mit den
    // Signalgruppen verschachteln lassen.
    const traceMeta = new Map();
    traceRefs.forEach(r => {
      const kind = isNumericKuerzel(r.kuerzel) ? 'apw' : (r.kuerzel === 'FORMEL' ? 'formula' : 'det');
      const catFn = kind === 'apw' ? (v => v.trim()) : categorizeDetRaw;
      const segs = buildSegments(times, seriesByCol.get(r.index), catFn);
      if (kind === 'apw') segs.forEach((s, idx) => { s.idx = idx; });
      traceMeta.set(objKey(r), { col: r, kind, sweep: makeIntervalSweep(segs) });
    });

    const n = cycleStarts.length;
    const matchingCycles = filterRows.length ? computeMatchingCycles(filterRows, objsByKey, allStats, cycleStarts, tMax, times, seriesByCol) : null;
    const effectiveCount = matchingCycles ? matchingCycles.length : n;
    lastEffectiveCount = effectiveCount;
    const { from, to } = windowRange(effectiveCount);
    const cycleIdxList = matchingCycles ? matchingCycles.slice(from, to) : Array.from({ length: to - from }, (_, k) => from + k);

    els.diagramControls.style.display = 'flex';
    const filterSuffix = matchingCycles ? ` (gefiltert aus ${n})` : '';
    els.winLabel.textContent = showAll
      ? `Gesamte Aufzeichnung (${effectiveCount} Umläufe${filterSuffix})`
      : `Umlauf ${from + 1}–${to} von ${effectiveCount}${filterSuffix}`;
    els.btnWinPrev.disabled = showAll || from <= 0;
    els.btnWinNext.disabled = showAll || to >= effectiveCount;
    els.winSize.disabled = showAll;

    // Grünsegmente, die über eine Umlaufgrenze hinausreichen (Grün beginnt
    // in Umlauf A, endet erst in Umlauf B): stats.greens/greenSweep
    // (makeIndexSweep, startpunkt-basiert) ordnet ein solches Segment
    // AUSSCHLIESSLICH Umlauf A zu (dort beginnt es) - Umlauf B bekäme ohne
    // dieses Tracking gar keinen Bezug zu diesem Segment, obwohl sein Balken
    // dort (dank überlappungs-basiertem segSweep) durchaus weiter grün
    // gezeichnet wird. carrySegs merkt sich je Signalgruppe das zuletzt in
    // EINEM Umlauf begonnene, aber über dessen Ende hinausreichende Segment
    // (+ dessen bereits berechneten Ab-Wert) und reicht es an den jeweils
    // NÄCHSTEN, zeitlich unmittelbar anschließenden Umlauf weiter (geprüft
    // über echte Zeit-Überlappung, nicht Listenindex - überspringt eine
    // gefilterte/nicht angezeigte Zwischenzeile daher korrekt ersatzlos).
    const carrySegs = sgData.map(() => null);

    const rowData = [];
    cycleIdxList.forEach(i => {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      const spl = findSplAt(start, times, splValues) || '–';
      const tu = Math.round((end - start) / 1000);

      const sgRows = sgData.map((sd, sgIdx) => {
        const gIdx = sd.greenSweep(start, end);
        let an = '–', ab = '–', tf = '–', anomClass = '', greenSeg = null;
        let carryGreenSeg = null, carryAb = null;

        const prevCarry = carrySegs[sgIdx];
        if (prevCarry && prevCarry.seg.end > start && prevCarry.seg.end <= end) {
          carryGreenSeg = prevCarry.seg;
          carryAb = prevCarry.ab;
          carrySegs[sgIdx] = null; // in diesem Umlauf endend - für weitere Zeilen erledigt
        } else if (prevCarry && prevCarry.seg.end <= start) {
          carrySegs[sgIdx] = null; // bereits vorher geendet (z.B. Zeile übersprungen) - nicht mehr gültig
        }

        if (gIdx !== -1) {
          // Dieselbe Objekt-Referenz wie in visSegs (stats.greens ist per
          // .filter() aus denselben Segment-Objekten wie segs abgeleitet,
          // siehe computeCycleStats()) - erlaubt es edgeLabelsFor() unten,
          // GENAU dieses Grün-Segment zu identifizieren (statt An/Ab jedem
          // GRUEN-Segment der Zeile zuzuschreiben, falls es je Umlauf
          // mehrere gäbe).
          greenSeg = sd.stats.greens[gIdx];
          const seg = TU ? computeSegmentAnAbTf(greenSeg, cycleStarts, TU) : null;
          if (seg) { an = seg.an; ab = seg.ab; tf = seg.tf; }
          if (sd.flags[gIdx]) anomClass = 'up-anom';
          if (greenSeg.end > end) carrySegs[sgIdx] = { seg: greenSeg, ab }; // reicht über diese Zeile hinaus
        }
        return {
          sgEntry: sd.sgEntry, an, ab, tf, anomClass, greenSeg, carryGreenSeg, carryAb,
          visSegs: sd.segSweep(start, end),
          fzVisSegs: sd.fzRows.map(fd => fd.fzSweep(start, end)),
          zwlVisSegs: sd.fzRows.map(fd => fd.zwlSweep(start, end)),
          fzRows: sd.fzRows
        };
      });

      const traceRows = traceRefs.map(r => {
        const m = traceMeta.get(objKey(r));
        return { col: m.col, kind: m.kind, visSegs: m.sweep(start, end) };
      });

      rowData.push({ i, start, end, spl, tu, sgRows, traceRows });
    });

    if (rowData.length === 0) {
      els.rows.innerHTML = matchingCycles
        ? '<div class="cfg-empty" style="padding:16px;">Keine Umläufe erfüllen den Filter.</div>'
        : '';
      els.sgLabel.textContent = sgData.map(sd => sd.sgEntry.col.name).join(', ');
      els.info.textContent = `${n} Umlauf/Umläufe`;
      els.tablePanel.style.display = '';
      return;
    }

    // Zeilen-HTML je Umlauf-Gruppe: läuft EINMAL über objRefs (= die vom
    // Nutzer festgelegte Anzeige-Reihenfolge) und zieht dabei abwechselnd
    // aus sgRows/traceRows - deren relative Reihenfolge stimmt exakt mit
    // sgRefs/traceRefs überein, da beide per .filter() aus derselben
    // objRefs-Liste abgeleitet wurden. So lassen sich Signalgruppen und
    // Detektor-/APW-/Formel-Spuren frei miteinander verschachteln statt in
    // drei starren Blöcken zu erscheinen. Die ÖV-Fahrzeiten-Unterzeilen
    // (tFZ/ZwL) bleiben dagegen fest an ihre Signalgruppe gebunden (kein
    // eigener Eintrag in der Objekt-Liste) - daher weiterhin mit "↳"
    // markiert; DET/APW/FORMEL sind jetzt gleichrangige Spuren, nicht mehr
    // "unter" einer bestimmten Signalgruppe, daher ohne Pfeil-Präfix.
    const laneRowsHtml = r => {
      let sgCursor = 0, traceCursor = 0;
      return objRefs.map(ref => {
        if (ref.kuerzel === 'SG') {
          const sr = r.sgRows[sgCursor++];
          return `
        <div class="lane-row up-main-row">
          <div class="lane-name" title="${esc(sr.sgEntry.col.beschreibung && sr.sgEntry.col.beschreibung !== sr.sgEntry.col.name ? sr.sgEntry.col.beschreibung : sr.sgEntry.col.name)}">${esc(sr.sgEntry.col.name)}</div>
          <div class="lane-num" data-field="an" title="An [s]">${sr.an}</div>
          <div class="lane-num" data-field="ab" title="Ab [s]">${sr.ab}</div>
          <div class="lane-num ${sr.anomClass}" data-field="tf" title="TF [s]${sr.anomClass ? ' – auffällig' : ''}">${sr.tf}</div>
          <div class="lane-track"><svg></svg></div>
        </div>` + sr.fzRows.map(fd => `
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="Theoretische Fahrzeit (${esc(sr.sgEntry.col.name)} · ${esc(fd.label)}): Soll-Anteil und Verlustzeit-Anteil">↳tFZ ${esc(fd.label)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="Zwangslöschzeit-Fenster (${esc(sr.sgEntry.col.name)} · ${esc(fd.label)}): Anmeldung bis Zwangslöschzeit">↳ZwL ${esc(fd.label)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`).join('');
        }
        const tr = r.traceRows[traceCursor++];
        const c = tr.col;
        return `
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="${esc(c.beschreibung && c.beschreibung !== c.name ? c.beschreibung : c.name)}">${esc(c.name)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`;
      }).join('');
    };

    els.rows.innerHTML = rowData.map(r => `
      <div class="up-group">
        <div class="up-group-caption" title="Start: ${esc(fmtTs(new Date(r.start)))}">Umlauf #${r.i + 1} <span class="win-label">${fmtTimeShort(r.start)} · SPL ${esc(r.spl)} · TU ${r.tu}s</span></div>
        ${laneRowsHtml(r)}
      </div>`).join('');

    // Größe je EINMAL messen (erzwingt Reflow) statt je Zeile - sonst
    // Layout-Thrashing bei vielen Umläufen (Schreiben+Messen im Wechsel).
    const groupEls = els.rows.querySelectorAll('.up-group');
    const firstMainTrack = els.rows.querySelector('.up-main-row .lane-track');
    const mainSize = firstMainTrack ? { width: firstMainTrack.clientWidth, height: firstMainTrack.clientHeight } : { width: 0, height: 0 };
    const firstSubTrack = els.rows.querySelector('.up-sub-track');
    const subSize = firstSubTrack ? { width: firstSubTrack.clientWidth, height: firstSubTrack.clientHeight } : mainSize;

    rowData.forEach((r, idx) => {
      const group = groupEls[idx];
      const mainRowEls = group.querySelectorAll('.up-main-row');
      const subRows = group.querySelectorAll('.up-sub-row');
      let sgCursor = 0, subCursor = 0, traceCursor = 0;

      // Dieselbe objRefs-Reihenfolge wie beim Template oben - Zeilen-DOM
      // (per Klassenselektor in Dokumentreihenfolge) und Datenzugriff
      // (sgRows/traceRows-Cursor) laufen synchron mit.
      objRefs.forEach(ref => {
        if (ref.kuerzel === 'SG') {
          const sr = r.sgRows[sgCursor];
          const mainSvg = mainRowEls[sgCursor].querySelector('.lane-track svg');
          sgCursor++;
          renderLane(mainSvg, {
            wMin: r.start, wMax: r.end, segs: sr.visSegs, baselineCat: 'ROT', baselineColor: 'var(--sig-red)',
            width: mainSize.width, height: mainSize.height, gridStepMs: 5000,
            // Ein Grünsegment, das über die Umlaufgrenze hinausreicht, wird
            // in ZWEI Zeilen sichtbar (Balken-Füllung via segSweep in
            // beiden, siehe carrySegs oben) - hier aber je Zeile nur die
            // Beschriftung(en) zeigen, die TATSÄCHLICH zu deren sichtbarem
            // Rand gehören: An (links) nur, wenn das Segment auch hier
            // beginnt UND endet (sonst reicht es weiter, kein rechter Rand
            // hier); Ab (rechts) separat für die Fortsetzungszeile, in der
            // es tatsächlich endet (carryGreenSeg/carryAb).
            edgeLabelsFor: d => {
              if (sr.greenSeg && d === sr.greenSeg) return { left: sr.an, right: sr.greenSeg.end <= r.end ? sr.ab : null };
              if (sr.carryGreenSeg && d === sr.carryGreenSeg) return { right: sr.carryAb };
              return null;
            }
          });
          wireMeasure(mainSvg, r.start, r.end, `${r.i}|main|${sr.sgEntry.col.index}`);

          sr.fzRows.forEach((fd, fi) => {
            const fzSvg = subRows[subCursor++].querySelector('.lane-track svg');
            renderLane(fzSvg, {
              wMin: r.start, wMax: r.end, segs: sr.fzVisSegs[fi],
              baselineCat: 'FZ_NONE', baselineColor: 'var(--text-faint)', baselineHeight: 2,
              width: subSize.width, height: subSize.height, gridStepMs: 5000,
              fillFor: d => d.cat === 'FZ_SOLL' ? 'var(--fz-soll)' : 'var(--fz-verlust)',
              segLabelFor: d => d.cat === 'FZ_SOLL' ? String(Math.round(d.sollfahrzeitSek)) : String(Math.round(d.verlustSek)),
              segTitle: d => d.cat === 'FZ_SOLL'
                ? `Sollfahrzeit: ${d.sollfahrzeitSek}s (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)})`
                : `Verlustzeit: ${d.verlustSek.toFixed(1)}s (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)})`
            });
            wireMeasure(fzSvg, r.start, r.end, `${r.i}|fz|${sr.sgEntry.col.index}|${fi}`);

            const zwlSvg = subRows[subCursor++].querySelector('.lane-track svg');
            renderLane(zwlSvg, {
              wMin: r.start, wMax: r.end, segs: sr.zwlVisSegs[fi],
              baselineCat: 'ZWL_NONE', baselineColor: 'var(--text-faint)', baselineHeight: 2,
              width: subSize.width, height: subSize.height, gridStepMs: 5000,
              fillFor: () => 'url(#gz-pat-zwl)',
              segLabelFor: d => String(Math.round(d.zwangsloeschSek)),
              segLabelColorFor: () => 'var(--text)',
              segTitle: d => `Zwangslöschzeit-Fenster: ${d.zwangsloeschSek}s ab Anmeldung (Schwelle ${fmtTimeShort(d.end)})`
            });
            wireMeasure(zwlSvg, r.start, r.end, `${r.i}|zwl|${sr.sgEntry.col.index}|${fi}`);
          });
          return;
        }

        const tr = r.traceRows[traceCursor++];
        const c = tr.col;
        const subSvg = subRows[subCursor++].querySelector('.lane-track svg');
        if (tr.kind === 'apw') {
          renderLane(subSvg, {
            wMin: r.start, wMax: r.end, segs: tr.visSegs,
            baselineCat: '__apw_none__', baselineColor: 'var(--text-faint)', baselineHeight: 2,
            width: subSize.width, height: subSize.height, gridStepMs: 5000,
            fillFor: d => d.cat === 'LUECKE' ? 'url(#gz-pat-gap)' : (d.idx % 2 === 0 ? 'var(--apw-a)' : 'var(--apw-b)'),
            segLabelFor: d => d.cat === 'LUECKE' ? '' : d.cat,
            segLabelColorFor: d => d.idx % 2 === 0 ? '#fff' : 'var(--text)',
            segTitle: d => d.cat === 'LUECKE'
              ? `Datenlücke: ${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)}`
              : `${esc(c.name)}: ${esc(d.cat)} (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)}, ${Math.round((d.end - d.start) / 1000)}s)`
          });
          wireMeasure(subSvg, r.start, r.end, `${r.i}|apw|${c.index}`);
        } else {
          const isFormula = tr.kind === 'formula';
          renderLane(subSvg, {
            wMin: r.start, wMax: r.end, segs: tr.visSegs,
            baselineCat: 'FREI', baselineColor: 'var(--text-faint)', baselineHeight: 2,
            width: subSize.width, height: subSize.height, gridStepMs: 5000,
            fillFor: isFormula ? (d => d.cat === 'BELEGT' ? 'var(--formula-on)' : undefined) : undefined,
            segTitle: s => `${esc(c.name)}${isFormula ? ` (Formel: ${esc(c.beschreibung)})` : ''} – ${s.cat === 'BELEGT' ? (isFormula ? 'Formel wahr' : 'Belegt') : s.cat === 'LUECKE' ? 'Datenlücke' : 'Unbekannt/INV'}: ${fmtTimeShort(s.start)}–${fmtTimeShort(s.end)} (${Math.round((s.end - s.start) / 1000)}s)`
          });
          wireMeasure(subSvg, r.start, r.end, `${r.i}|det|${c.index}`);
        }
      });

      wireCrosshair(group, r.start, r.end);
    });

    els.sgLabel.textContent = sgData.map(sd => sd.sgEntry.col.name).join(', ');
    els.info.textContent = `${n} Umlauf/Umläufe`;
    els.tablePanel.style.display = '';
  }

  GZ.views = GZ.views || {};
  GZ.views.umlaufpruefung = { init, populateControls, render, refreshFormulaColumns };
})(window.GZ = window.GZ || {});
