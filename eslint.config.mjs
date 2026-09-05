import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**", "test-results/**", "site/data/**"] },
  js.configs.recommended,
  {
    files: ["site/src/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.browser, google: "readonly", YT: "readonly" } },
    rules: { "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }], "no-empty": ["error", { allowEmptyCatch: true }], "prefer-const": "error", eqeqeq: ["error", "smart"] },
  },
  { files: ["site/sw.js"], languageOptions: { ecmaVersion: 2023, sourceType: "script", globals: globals.serviceworker } },
  { files: ["build.mjs", "playwright.config.mjs", "tests/site/**/*.mjs"], languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: globals.node } },
];
