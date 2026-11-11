// Light/dark theme. The selection is stored in the browser (falls back to system preference).
// Theme colors are defined in CSS using light-dark(): browser resolves them for canvas use.
const root = document.documentElement;
const mq = window.matchMedia('(prefers-color-scheme: dark)');

export const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : mq.matches);

// Favicon follows the theme (same asset picked by theme-init.js on load).
const icon = document.getElementById('favicon');
const changed = () => {
  icon?.setAttribute('href', `brand/favicon-${isDark() ? 'dark' : 'light'}.svg`);
  window.dispatchEvent(new Event('themechange'));
};
mq.addEventListener?.('change', changed);

export function setTheme(theme) {
  root.dataset.theme = theme;
  try {
    localStorage.setItem('hub-theme', theme);
  } catch {
    /* theme still applies for the current session */
  }
  changed();
}

export const toggleTheme = () => setTheme(isDark() ? 'light' : 'dark');

/** Resolves CSS variables (including light-dark()) into canvas-ready color strings: { agent: 'rgb(...)', ... }. */
export function resolveColors(host, names) {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0';
  host.append(probe);
  const out = {};
  for (const [key, cssVar] of Object.entries(names)) {
    probe.style.color = '';
    probe.style.color = `var(${cssVar})`;
    out[key] = getComputedStyle(probe).color;
  }
  probe.remove();
  return out;
}
