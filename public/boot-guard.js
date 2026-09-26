// Boot guard: if the viewer's modules fail to load or throw before the app
// starts, show why instead of a blank page. main.ts calls done() once its own
// error panel is up. A file of its own, since the studio server's page policy
// allows no inline script (ADR 0008).
(function () {
  var started = false;
  function box() {
    return document.getElementById('boot-error');
  }
  function show(title, detail) {
    var el = box();
    if (started || !el) return;
    el.hidden = false;
    var heading = document.createElement('strong');
    heading.textContent = title;
    var body = document.createElement('div');
    body.textContent = detail;
    el.append(heading, body);
  }
  function onError(e) {
    var err = e.error || e.reason;
    show('The viewer failed to start', (err && (err.stack || err.message)) || e.message || String(err));
  }
  // A module script that fails to load fires its error on the element, not the window.
  function onLoadError(e) {
    var target = e.target;
    if (target && target.tagName === 'SCRIPT' && target.type === 'module') {
      show('The viewer failed to load', 'Could not load ' + target.src + ' or one of its imports (a missing file or a syntax error).\n' +
        'Check the terminal and the console. Saving a fix reloads the page.');
    }
  }
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onError);
  document.addEventListener('error', onLoadError, true);
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!started && box() && box().hidden) show('The viewer did not start', 'main.ts loaded but never finished booting. Check the console.');
    }, 15000);
  });
  window.__studioBoot = {
    done: function () {
      started = true;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onError);
      document.removeEventListener('error', onLoadError, true);
    },
  };
})();
