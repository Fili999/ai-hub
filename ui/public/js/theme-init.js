// Light/dark theme: loaded in <head> before rendering to prevent flash of wrong theme.
// If the user has not chosen a theme, system preference (prefers-color-scheme) is followed. Favicon is also set here.
(function () {
  var t = null;
  try {
    t = localStorage.getItem('hub-theme');
  } catch (e) {
    /* browser storage unavailable: fall back to system theme */
  }
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  var icon = document.getElementById('favicon');
  if (icon) icon.setAttribute('href', 'brand/favicon-' + t + '.svg');
})();
