import js from "@eslint/js"
import globals from "globals"
import json from "@eslint/json"
import stylistic from "@stylistic/eslint-plugin"
import { defineConfig } from "eslint/config"

export default defineConfig([
  {
    files: ["**/*.js"],
    ...stylistic.configs.customize({
      indent: 2,
      semi: false,
      quotes: "double",
    }),
  },
  {
    files: ["**/*.js"],
    rules: {
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "@stylistic/space-before-function-paren": ["error", {
        anonymous: "never",
        named: "always",
        asyncArrow: "always",
      }],
    },
  },
  {
    files: ["**/*.js"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.node },
    rules: {
      curly: ["error", "all"],
    },
  },
  {
    files: ["**/*.json"],
    plugins: { json },
    language: "json/json",
    extends: ["json/recommended"],
  },
])
