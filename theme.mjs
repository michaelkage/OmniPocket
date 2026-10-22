const THEMES = {
  light: {
    bg: "#F7F4EF", text: "#111111", surface: "#EFECE6", accent: "#3B6E52",
    muted: "#686962", border: "#C9C5BC", borderStrong: "#918D84", danger: "#A33D32"
  },
  dark: {
    bg: "#121414", text: "#ECEDED", surface: "#1C1F1F", accent: "#4E8F6C",
    muted: "#A5AAA6", border: "#414644", borderStrong: "#727974", danger: "#E07B70"
  }
};

const TOKEN_MAP = {
  "--op-bg": "bg", "--op-text": "text", "--op-surface": "surface",
  "--op-accent": "accent", "--op-muted": "muted",
  "--op-border": "border", "--op-border-strong": "borderStrong", "--op-danger": "danger"
};

function applyTheme(mode) {
  const root = document.documentElement;
  const resolved = mode === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : mode;
  const theme = THEMES[resolved] || THEMES.light;

  root.dataset.theme = resolved;
  root.dataset.mdTheme = resolved;
  root.style.colorScheme = resolved;
  for (const [token, key] of Object.entries(TOKEN_MAP)) {
    root.style.setProperty(token, theme[key]);
  }

  // Keep existing components on their legacy token names, without generated palettes.
  const aliases = {
    "--md-sys-color-primary": theme.accent,
    "--md-sys-color-on-primary": "#FFFFFF",
    "--md-sys-color-primary-container": theme.surface,
    "--md-sys-color-on-primary-container": theme.text,
    "--md-sys-color-secondary": theme.accent,
    "--md-sys-color-on-secondary": "#FFFFFF",
    "--md-sys-color-secondary-container": theme.surface,
    "--md-sys-color-on-secondary-container": theme.text,
    "--md-sys-color-tertiary": theme.accent,
    "--md-sys-color-on-tertiary": "#FFFFFF",
    "--md-sys-color-tertiary-container": theme.surface,
    "--md-sys-color-on-tertiary-container": theme.text,
    "--md-sys-color-error": theme.danger,
    "--md-sys-color-on-error": resolved === "dark" ? "#121414" : "#FFFFFF",
    "--md-sys-color-error-container": resolved === "dark" ? "#35201E" : "#F3E3DF",
    "--md-sys-color-on-error-container": theme.text,
    "--md-sys-color-surface": theme.bg,
    "--md-sys-color-on-surface": theme.text,
    "--md-sys-color-on-surface-variant": theme.muted,
    "--md-sys-color-surface-variant": theme.surface,
    "--md-sys-color-surface-container": theme.surface,
    "--md-sys-color-surface-container-high": theme.surface,
    "--md-sys-color-surface-container-highest": theme.surface,
    "--md-sys-color-surface-container-low": theme.bg,
    "--md-sys-color-outline": theme.border,
    "--md-sys-color-outline-variant": theme.border,
    "--md-sys-color-background": theme.bg,
    "--md-sys-color-on-background": theme.text,
    "--md-sys-color-inverse-surface": theme.text,
    "--md-sys-color-inverse-on-surface": theme.bg,
    "--md-sys-color-inverse-primary": resolved === "dark" ? "#3B6E52" : "#4E8F6C",
    "--md-sys-color-shadow": "transparent",
    "--md-sys-color-surface-tint": "transparent",
    "--md-sys-color-scrim": resolved === "dark" ? "rgba(0,0,0,.72)" : "rgba(17,17,17,.58)"
  };
  for (const [token, value] of Object.entries(aliases)) root.style.setProperty(token, value);

  root.style.setProperty("--md-sys-shape-none", "0");
  root.style.setProperty("--md-sys-shape-small", "2px");
  root.style.setProperty("--md-sys-shape-medium", "4px");
  root.style.setProperty("--md-sys-shape-large", "4px");
  root.style.setProperty("--md-sys-shape-full", "4px");
  root.style.setProperty("--ease-mechanical", "cubic-bezier(0.16, 1, 0.3, 1)");

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme.bg);
}

function init() {
  const stored = (() => {
    try { return window.localStorage.getItem("omnipocket-theme"); } catch (_) { return null; }
  })();
  const valid = ["light", "dark", "system"].includes(stored) ? stored : "system";
  applyTheme(valid);

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  if (media.addEventListener) media.addEventListener("change", () => {
    let current = "system";
    try { current = window.localStorage.getItem("omnipocket-theme") || "system"; } catch (_) {}
    if (current === "system") applyTheme("system");
  });

  // Expose a small stable API for the existing settings UI and future controls.
  window.OmniPocketTheme = Object.freeze({
    set(mode) {
      if (!["light", "dark", "system"].includes(mode)) return;
      try { window.localStorage.setItem("omnipocket-theme", mode); } catch (_) {}
      applyTheme(mode);
    },
    get() { return document.documentElement.dataset.theme || "light"; },
    getPreference() {
      try { return window.localStorage.getItem("omnipocket-theme") || "system"; } catch (_) { return "system"; }
    },
    toggle() { this.set(this.get() === "dark" ? "light" : "dark"); }
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") init();
export { init, applyTheme };
