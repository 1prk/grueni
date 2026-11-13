/* GZ.snackbar is a small toast message without dependencies.
   A toast shows at the bottom right. Many toasts can stack.
   A toast hides itself after `duration`. The user can click ✕ to close it at once.
   The module is a UI utility with no view. It attaches itself to document.body (see
   ensureContainer()).
   Use a toast for events that the user must see.
   Examples: "Calculate" is blocked or skipped, or a configuration loads only in part.
   Do not use a toast for the live validation of single rows.
   The inline status dots and tooltips do that. A toast for each key press is too much. */
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

  // opts: { type: 'error'|'warning'|'info' (default 'info'),
  //         description: string (optional second line, grey),
  //         duration: ms until the toast hides itself (default 7000, 0 = do not hide) }
  // Returns { close() }. Use it to close the toast early from code.
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
    // Use rAF so that the fade-in transition (opacity and transform) runs.
    // Without rAF the toast starts in its end state.
    requestAnimationFrame(() => el.classList.add('snackbar-show'));

    const duration = opts.duration == null ? 7000 : opts.duration;
    if (duration > 0) setTimeout(close, duration);
    return { close };
  }

  GZ.snackbar = { show };
})(window.GZ = window.GZ || {});
