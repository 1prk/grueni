/* GZ.snackbar — kleine, abhängigkeitsfreie Toast-Benachrichtigung (unten
   rechts, mehrere stapelbar, automatisches Ausblenden nach duration, per
   Klick auf ✕ sofort schließbar). Reines UI-Utility ohne View-Bezug - hängt
   sich selbst an document.body (siehe ensureContainer()). Gedacht für
   Ereignisse, die dem Nutzer AKTIV mitgeteilt werden sollen (z.B. "Berechnen"
   blockiert/übersprungen, Konfiguration teilweise geladen) - NICHT für die
   fortlaufende Tipp-Validierung einzelner Zeilen (die bleibt bei den
   bestehenden Inline-Status-Punkten/Tooltips, sonst würde bei jedem
   Tastendruck ein Toast aufpoppen). */
(function (GZ) {
  'use strict';

  let container = null;
  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement('div');
    container.className = 'snackbar-stack';
    document.body.appendChild(container);
    return container;
  }

  // opts: { type: 'error'|'warning'|'info' (Default 'info'),
  //         description: string (optionale zweite, gedämpfte Zeile),
  //         duration: ms bis automatisches Ausblenden (Default 7000, 0 = kein
  //         Auto-Ausblenden) }
  // Rückgabe: { close() } zum vorzeitigen, programmatischen Schließen.
  function show(message, opts) {
    opts = opts || {};
    const type = opts.type === 'error' || opts.type === 'warning' ? opts.type : 'info';
    const icon = type === 'error' ? '✕' : type === 'warning' ? '!' : 'i';

    const el = document.createElement('div');
    el.className = `snackbar snackbar-${type}`;
    el.innerHTML = `
      <span class="snackbar-icon">${icon}</span>
      <span class="snackbar-body">
        <span class="snackbar-msg"></span>
        <span class="snackbar-desc" hidden></span>
      </span>
      <button type="button" class="snackbar-close" title="Schließen">✕</button>`;
    el.querySelector('.snackbar-msg').textContent = message;
    if (opts.description) {
      const descEl = el.querySelector('.snackbar-desc');
      descEl.textContent = opts.description;
      descEl.hidden = false;
    }

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      el.classList.remove('snackbar-show');
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector('.snackbar-close').onclick = close;

    ensureContainer().appendChild(el);
    // rAF, damit die Einblend-Transition (opacity/transform) tatsächlich
    // greift statt sofort im Endzustand zu starten.
    requestAnimationFrame(() => el.classList.add('snackbar-show'));

    const duration = opts.duration == null ? 7000 : opts.duration;
    if (duration > 0) setTimeout(close, duration);
    return { close };
  }

  GZ.snackbar = { show };
})(window.GZ = window.GZ || {});
