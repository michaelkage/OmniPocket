export default [
  {
    ignores: ["node_modules/**", "dist/**", "build/**"]
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        document: "readonly",
        window: "readonly",
        fetch: "readonly",
        matchMedia: "readonly"
      }
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
          message: "Hardcoded hex color values are not allowed. Use CSS custom properties from theme tokens (e.g., var(--md-sys-color-primary))."
        },
        {
          selector: "TemplateElement[value.cooked=/^#[0-9a-fA-F]{3,8}$/]",
          message: "Hardcoded hex color values are not allowed. Use CSS custom properties from theme tokens (e.g., var(--md-sys-color-primary))."
        },
        {
          selector: "Literal[value=/^rgb[a]?\\(/]",
          message: "Hardcoded rgb/rgba color values are not allowed. Use CSS custom properties from theme tokens."
        },
        {
          selector: "Literal[value=/^hsl[a]?\\(/]",
          message: "Hardcoded hsl/hsla color values are not allowed. Use CSS custom properties from theme tokens."
        }
      ]
    }
  },
  {
    files: ["theme.mjs"],
    rules: {
      "no-restricted-syntax": "off"
    }
  },
  {
    files: ["**/*.css"],
    rules: {}
  }
];
