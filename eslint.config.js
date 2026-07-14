import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-empty-function": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["bin/**/*.mjs"],
    languageOptions: {
      globals: {
        AbortController: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.test.ts",
      "frontend/",
      "extension/",
      "spikes/",
      ".worktrees/",
      ".claude/worktrees/",
    ],
  },
);
