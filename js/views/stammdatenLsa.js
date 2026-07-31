/* GZ.views.stammdatenLsa — Tab "Stammdaten LSA": Phaseneinteilung festlegen.
   Eine Phase = eine Menge von Signalgruppen, die gleichzeitig Grün zeigen
   (siehe RiLSA-Erläuterung im Panel-Hinweistext). Editiert direkt
   GZ.state.data.phases; die Auswertung selbst passiert im Tab
   "Phasenauswertung" (js/views/phasenauswertung.js), das nach jeder
   Änderung hier aufgefrischt wird. */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;
  const { createPhase } = GZ.phases;

  let els = null;

  function init(root) {
    els = {
      root,
      table: root.querySelector('#sdPhaseTable'),
      emptyHint: root.querySelector('#sdEmptyHint'),
      addBtn: root.querySelector('#sdAddPhase'),
      noSgHint: root.querySelector('#sdNoSgHint')
    };
    els.addBtn.addEventListener('click', () => {
      const a = GZ.state.data.currentAnalysis;
      if (!a) return;
      GZ.state.data.phases.push(createPhase(GZ.state.data.phases));
      renderTable();
      notifyChanged();
    });
  }

  function onAnalyzeComplete() {
    GZ.state.data.phases = [];
    renderTable();
  }

  function notifyChanged() {
    if (GZ.views.phasenauswertung) GZ.views.phasenauswertung.refresh();
  }

  function renderTable() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) { els.table.innerHTML = ''; els.emptyHint.style.display = 'none'; return; }
    const sgCols = a.allStats.map(({ col }) => col);
    els.noSgHint.style.display = sgCols.length ? 'none' : '';

    const phases = GZ.state.data.phases;
    if (phases.length === 0) {
      els.table.innerHTML = '';
      els.emptyHint.style.display = '';
      return;
    }
    els.emptyHint.style.display = 'none';

    const headCells = sgCols.map(col => {
      const title = col.beschreibung && col.beschreibung !== col.name ? `${col.name} – ${col.beschreibung}` : col.name;
      return `<th title="${esc(title)}">${esc(col.name)}</th>`;
    }).join('');

    const bodyRows = phases.map(phase => {
      const cells = sgCols.map(col => {
        const checked = phase.members.has(col.index) ? 'checked' : '';
        return `<td class="phase-check-cell"><input type="checkbox" data-member="${col.index}" ${checked}></td>`;
      }).join('');
      const count = phase.members.size;
      const countHint = count === 0
        ? '<span class="phase-count-hint warn">keine Signalgruppe gewählt</span>'
        : `<span class="phase-count-hint">${count} Signalgruppe${count === 1 ? '' : 'n'}</span>`;
      return `<tr data-phase="${phase.id}">
        <td class="phase-label-cell">
          <input type="text" class="phase-kuerzel" data-field="kuerzel" value="${esc(phase.kuerzel)}" title="Kürzel (z. B. Ph1)" maxlength="12">
          <input type="text" class="phase-name" data-field="name" value="${esc(phase.name)}" title="Bezeichnung">
          ${countHint}
        </td>
        ${cells}
        <td class="phase-del-cell"><button type="button" class="phase-del" title="Phase löschen">✕</button></td>
      </tr>`;
    }).join('');

    els.table.innerHTML = `
      <thead><tr><th>Phase</th>${headCells}<th></th></tr></thead>
      <tbody>${bodyRows}</tbody>`;

    wireRowEvents();
  }

  function wireRowEvents() {
    els.table.querySelectorAll('tbody tr[data-phase]').forEach(tr => {
      const phase = GZ.state.data.phases.find(p => p.id === tr.dataset.phase);
      if (!phase) return;

      tr.querySelectorAll('input[data-field]').forEach(inp => {
        inp.addEventListener('change', () => {
          const val = inp.value.trim();
          phase[inp.dataset.field] = val || (inp.dataset.field === 'kuerzel' ? phase.kuerzel : phase.name);
          inp.value = phase[inp.dataset.field];
          notifyChanged();
        });
      });

      tr.querySelectorAll('input[data-member]').forEach(cb => {
        cb.addEventListener('change', () => {
          const idx = Number(cb.dataset.member);
          if (cb.checked) phase.members.add(idx); else phase.members.delete(idx);
          const hint = tr.querySelector('.phase-count-hint');
          const count = phase.members.size;
          hint.className = 'phase-count-hint' + (count === 0 ? ' warn' : '');
          hint.textContent = count === 0 ? 'keine Signalgruppe gewählt' : `${count} Signalgruppe${count === 1 ? '' : 'n'}`;
          notifyChanged();
        });
      });

      tr.querySelector('.phase-del').addEventListener('click', () => {
        GZ.state.data.phases = GZ.state.data.phases.filter(p => p.id !== phase.id);
        renderTable();
        notifyChanged();
      });
    });
  }

  GZ.views = GZ.views || {};
  GZ.views.stammdatenLsa = { init, onAnalyzeComplete };
})(window.GZ = window.GZ || {});
