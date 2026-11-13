/* GZ.views.projectPanel shows the LSAs of the project and the recordings of the active LSA.

   It is the list part of the project bar. It has no logic for the project. It reads the lists from the store
   (the provider projectOverview) and draws them again after the topic project:changed.
   An action of the user becomes a command: project:selectLsa, project:selectRecording, project:addRecording,
   project:newLsa, project:rename and project:remove. The view GZ.views.project does the work.

   The panel opens and closes with a button. The text of this button shows the number of LSAs and recordings.
   A name changes in place: the user clicks the pencil, types a new name and presses Enter. Escape cancels. */
GZ.define('views.projectPanel', { layer: 'views', deps: ['format', 'state'] }, function (GZ) {
  'use strict';
  const { fmtTs } = GZ.format;

  let els = null;
  let open = false;

  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  function node(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function iconButton(label, title, action) {
    const b = node('button', 'project-item-btn', label);
    b.type = 'button';
    b.title = title;
    b.dataset.action = action;
    return b;
  }

  function period(rec) {
    const a = new Date(rec.tMin), b = new Date(rec.tMax);
    return fmtTs(a) + ' – ' + fmtTs(b);
  }

  // One row of a list. kind is 'lsa' or 'recording'.
  function row(kind, item, metaText) {
    const li = node('li', 'project-item' + (item.active ? ' active' : ''));
    li.dataset.kind = kind;
    li.dataset.id = item.id;
    const main = node('button', 'project-item-main');
    main.type = 'button';
    main.dataset.action = 'select';
    main.title = kind === 'lsa' ? 'LSA anzeigen' : 'Aufzeichnung anzeigen';
    main.appendChild(node('span', 'project-item-name', item.name));
    main.appendChild(node('span', 'project-item-meta', metaText));
    li.appendChild(main);
    li.appendChild(iconButton('✎', 'Umbenennen', 'rename'));
    li.appendChild(iconButton('✕', 'Aus dem Projekt entfernen', 'remove'));
    return li;
  }

  function render() {
    const o = GZ.state.request('projectOverview');
    els.root.classList.toggle('has-project', !!o);
    if (!o) { els.panel.classList.remove('open'); els.toggle.disabled = true; els.toggle.textContent = 'LSAs und Aufzeichnungen'; return; }
    const recCount = o.lsas.reduce((n, l) => n + l.recordings.length, 0);
    els.toggle.disabled = false;
    els.toggle.textContent = 'LSAs und Aufzeichnungen (' + o.lsas.length + ' · ' + recCount + ') ' + (open ? '▴' : '▾');
    els.panel.classList.toggle('open', open);

    els.lsaList.textContent = '';
    o.lsas.forEach(l => {
      els.lsaList.appendChild(row('lsa', l, (l.nodeNo ? 'Nr. ' + l.nodeNo + ' · ' : '') + plural(l.recordings.length, 'Aufzeichnung', 'Aufzeichnungen')));
    });
    const active = o.lsas.find(l => l.active);
    els.recHead.textContent = active ? 'Aufzeichnungen von „' + active.name + '“' : 'Aufzeichnungen';
    els.recList.textContent = '';
    if (active) active.recordings.forEach(r => els.recList.appendChild(row('recording', r, plural(r.rowCount, 'Zeile', 'Zeilen') + ' · ' + period(r))));
    els.recAddLabel.classList.toggle('disabled', !active);
  }

  // Replaces the name by a text field. Enter saves, Escape and a click outside cancel.
  function startRename(li) {
    const nameEl = li.querySelector('.project-item-name');
    const old = nameEl.textContent;
    const input = node('input', 'project-item-input');
    input.type = 'text';
    input.value = old;
    input.maxLength = 120;
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== old) GZ.state.command('project:rename', { kind: li.dataset.kind, id: li.dataset.id, name });
      else render();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(false));
    input.addEventListener('click', e => e.stopPropagation());
    nameEl.replaceWith(input);
    input.focus();
    input.select();
  }

  function onListClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const li = btn.closest('.project-item');
    if (!li) return;
    const kind = li.dataset.kind, id = li.dataset.id;
    switch (btn.dataset.action) {
      case 'select': GZ.state.command(kind === 'lsa' ? 'project:selectLsa' : 'project:selectRecording', { id }); break;
      case 'rename': startRename(li); break;
      case 'remove': GZ.state.command('project:remove', { kind, id }); break;
      default: break;
    }
  }

  function init(root) {
    els = {
      root,
      toggle: root.querySelector('#btnProjectPanel'),
      panel: root.querySelector('#projectPanel'),
      lsaList: root.querySelector('#lsaList'),
      recList: root.querySelector('#recList'),
      recHead: root.querySelector('#recHead'),
      lsaNewInput: root.querySelector('#lsaNewInput'),
      recAddInput: root.querySelector('#recAddInput'),
      recAddLabel: root.querySelector('#recAddLabel')
    };
    els.toggle.addEventListener('click', () => { open = !open; render(); });
    els.lsaList.addEventListener('click', onListClick);
    els.recList.addEventListener('click', onListClick);
    els.lsaNewInput.addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) GZ.state.command('project:newLsa', { file: f }); });
    els.recAddInput.addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) GZ.state.command('project:addRecording', { file: f }); });
    GZ.state.on('project:changed', render);
    render();
  }

  return { init };
});
