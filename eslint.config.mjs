import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Node built-ins are banned in src/: the plugin must run on iOS/Android (CLAUDE.md §3, "Mobile first").
const nodeBuiltins = [
  "fs", "fs/*", "path", "path/*", "os", "child_process", "crypto", "http", "https", "net", "tls", "stream", "zlib",
  "util", "url", "buffer", "events", "worker_threads", "electron",
];

export default defineConfig([
  globalIgnores(["main.js", "node_modules/**", "coverage/**", "docs/**", "reference/**", "*.json", "scripts/**", "tests/e2e/obsidian/**", "dist/**", "src/studio/api-types.ts"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*", "esbuild.config.mjs", "version-bump.mjs", "vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: nodeBuiltins.map((name) => ({
            name,
            message: "Node/Electron APIs do not exist on mobile. Use Web APIs or Obsidian's API (CLAUDE.md §3).",
          })),
          patterns: [{ group: ["node:*"], message: "Node APIs do not exist on mobile (CLAUDE.md §3)." }],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Use the platform http adapter (Obsidian's requestUrl): it is not bound by CORS and works on mobile." },
        { name: "XMLHttpRequest", message: "Use the platform http adapter (requestUrl)." },
        { name: "Buffer", message: "Node-only. Use Uint8Array / TextEncoder." },
        { name: "process", message: "Node-only." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]",
          message: "No innerHTML/outerHTML. Build DOM with createEl, or sanitizeHTMLToDom for foreign HTML.",
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: "No insertAdjacentHTML. Build DOM with createEl, or sanitizeHTMLToDom for foreign HTML.",
        },
        {
          selector: "CallExpression[callee.property.name=/^(createContextualFragment|setHTMLUnsafe|parseFromString)$/], NewExpression[callee.name='DOMParser']",
          message: "No other HTML sinks: foreign HTML goes through sanitizeHTMLToDom only (docs/SECURITY.md §2).",
        },
        {
          selector: "CallExpression[callee.property.name='write'][callee.object.name='document'], AssignmentExpression[left.property.name='srcdoc'], NewExpression[callee.name='Function'], CallExpression[callee.name='eval']",
          message: "No document.write, srcdoc, eval or new Function (docs/SECURITY.md §2, Obsidian's plugin guidelines).",
        },
      ],
    },
  },
  {
    // Build tooling runs in Node, not in Obsidian.
    files: ["*.mjs", "*.config.ts"],
    languageOptions: { globals: { process: "readonly" } },
    rules: { "obsidianmd/no-nodejs-modules": "off" },
  },
  {
    // Tests run in Node: Node built-ins are fine there.
    files: ["tests/**/*.ts"],
    languageOptions: { globals: { Buffer: "readonly", process: "readonly" } },
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-globals": "off",
      "obsidianmd/no-nodejs-modules": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);
