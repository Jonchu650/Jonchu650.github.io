// Mobile nav + theme toggle. Everything else is static HTML.
(function () {
  var t = document.getElementById('navtoggle');
  var s = document.getElementById('scrim');
  function close() {
    document.body.classList.remove('nav-open');
    if (t) t.setAttribute('aria-expanded', 'false');
  }
  if (t) {
    t.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open');
      t.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  if (s) s.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  var stored = null;
  try { stored = localStorage.getItem('ram-theme'); } catch (e) {}
  if (stored) document.documentElement.setAttribute('data-theme', stored);

  var tt = document.getElementById('themetoggle');
  if (tt) tt.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    if (!cur) {
      cur = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('ram-theme', next); } catch (e) {}
  });
})();
