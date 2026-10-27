{{flutter_js}}
{{flutter_build_config}}
// Flutter's own startup, with one change: the loader waits for main.dart.js, which index.html
// preloads first. Started together, the app and the engine (canvaskit.wasm) shared the line and
// arrived together, and only then did the app's script run. Now it runs while the engine is still
// downloading. No preload, or one that fails, starts the loader as before. A preload already done
// (from the cache, before this script was parsed) has marked itself in index.html. A browser that
// has loaded this release's script before has both in its cache and nothing to wait for: waiting
// for the script there only delays the engine, so the loader starts at once.
(function () {
  var link = document.getElementById('harness-main-preload');
  var key = 'harness.web.v1.main_script_loaded';
  function loadedBefore() {
    try { return localStorage.getItem(key) === link.href; } catch (e) { return false; }
  }
  function remember() {
    try { localStorage.setItem(key, link.href); } catch (e) { /* storage refused: wait next time too */ }
  }
  var downloaded = new Promise(function (resolve) {
    if (!link || !link.relList || !link.relList.supports || !link.relList.supports('preload') ||
        link.dataset.done || loadedBefore()) {
      if (link && link.dataset.done === 'loaded') remember();
      resolve();
      return;
    }
    link.addEventListener('load', function () { remember(); resolve(); });
    link.addEventListener('error', resolve);
  });
  var load = _flutter.loader.load.bind(_flutter.loader);
  _flutter.loader.load = function (options) {
    return downloaded.then(function () { return load(options); });
  };
})();
// The website rewrites the call below for each release (website/scripts/harness-web-assets.mjs): it
// must stay the last statement and the only call with an object literal.
_flutter.loader.load({
  serviceWorkerSettings: {
    serviceWorkerVersion: {{flutter_service_worker_version}}
  }
});
