import { Hct, SchemeTonalSpot, argbFromHex, hexFromArgb } from '@material/material-color-utilities';

async function loadTokens() {
  try {
    const res = await fetch('./theme.tokens.json', { cache: 'no-store' });
    if (res.ok) {
      return await res.json();
    }
  } catch (_) {}
  return { seedColor: 'var(--md-sys-color-primary)' };
}

function setTheme(scheme, isDark) {
  const root = document.documentElement;
  root.style.setProperty('--md-sys-color-primary', hexFromArgb(scheme.primary));
  root.style.setProperty('--md-sys-color-on-primary', hexFromArgb(scheme.onPrimary));
  root.style.setProperty('--md-sys-color-primary-container', hexFromArgb(scheme.primaryContainer));
  root.style.setProperty('--md-sys-color-on-primary-container', hexFromArgb(scheme.onPrimaryContainer));
  root.style.setProperty('--md-sys-color-secondary', hexFromArgb(scheme.secondary));
  root.style.setProperty('--md-sys-color-on-secondary', hexFromArgb(scheme.onSecondary));
  root.style.setProperty('--md-sys-color-secondary-container', hexFromArgb(scheme.secondaryContainer));
  root.style.setProperty('--md-sys-color-on-secondary-container', hexFromArgb(scheme.onSecondaryContainer));
  root.style.setProperty('--md-sys-color-tertiary', hexFromArgb(scheme.tertiary));
  root.style.setProperty('--md-sys-color-on-tertiary', hexFromArgb(scheme.onTertiary));
  root.style.setProperty('--md-sys-color-tertiary-container', hexFromArgb(scheme.tertiaryContainer));
  root.style.setProperty('--md-sys-color-on-tertiary-container', hexFromArgb(scheme.onTertiaryContainer));
  root.style.setProperty('--md-sys-color-error', hexFromArgb(scheme.error));
  root.style.setProperty('--md-sys-color-on-error', hexFromArgb(scheme.onError));
  root.style.setProperty('--md-sys-color-error-container', hexFromArgb(scheme.errorContainer));
  root.style.setProperty('--md-sys-color-on-error-container', hexFromArgb(scheme.onErrorContainer));
  root.style.setProperty('--md-sys-color-surface', hexFromArgb(scheme.surface));
  root.style.setProperty('--md-sys-color-on-surface', hexFromArgb(scheme.onSurface));
  root.style.setProperty('--md-sys-color-on-surface-variant', hexFromArgb(scheme.onSurfaceVariant));
  root.style.setProperty('--md-sys-color-surface-variant', hexFromArgb(scheme.surfaceVariant));
  root.style.setProperty('--md-sys-color-surface-container', hexFromArgb(scheme.surfaceContainer));
  root.style.setProperty('--md-sys-color-surface-container-high', hexFromArgb(scheme.surfaceContainerHigh));
  root.style.setProperty('--md-sys-color-surface-container-highest', hexFromArgb(scheme.surfaceContainerHighest));
  root.style.setProperty('--md-sys-color-surface-container-low', hexFromArgb(scheme.surfaceContainerLow));
  root.style.setProperty('--md-sys-color-outline', hexFromArgb(scheme.outline));
  root.style.setProperty('--md-sys-color-outline-variant', hexFromArgb(scheme.outlineVariant));
  root.style.setProperty('--md-sys-color-background', hexFromArgb(scheme.background));
  root.style.setProperty('--md-sys-color-on-background', hexFromArgb(scheme.onBackground));
  root.style.setProperty('--md-sys-color-inverse-surface', hexFromArgb(scheme.inverseSurface));
  root.style.setProperty('--md-sys-color-inverse-on-surface', hexFromArgb(scheme.inverseOnSurface));
  root.style.setProperty('--md-sys-color-inverse-primary', hexFromArgb(scheme.inversePrimary));
  root.style.setProperty('--md-sys-color-shadow', hexFromArgb(scheme.shadow));
  root.style.setProperty('--md-sys-color-surface-tint', hexFromArgb(scheme.surfaceTint));
  root.style.setProperty('--md-sys-color-scrim', hexFromArgb(scheme.scrim));
  root.setAttribute('data-md-theme', isDark ? 'dark' : 'light');
  root.style.setProperty('color-scheme', isDark ? 'dark' : 'light');
}

async function init() {
  const tokens = await loadTokens();
  const defaultSeed = '#6750A4';
  const seedHex = tokens.seedColor && tokens.seedColor.startsWith('var(') ? defaultSeed : (tokens.seedColor || defaultSeed);
  const seed = argbFromHex(seedHex);
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

  function apply() {
    const isDark = mediaQuery.matches;
    const scheme = isDark
      ? new SchemeTonalSpot(Hct.fromInt(seed), true, 0).toJSON()
      : new SchemeTonalSpot(Hct.fromInt(seed), false, 0).toJSON();
    setTheme(scheme, isDark);
  }

  apply();
  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener('change', apply);
  } else if (mediaQuery.addListener) {
    mediaQuery.addListener(apply);
  }
}

if (typeof window !== 'undefined') {
  init();
}

export { init };
