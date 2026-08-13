// Type-aware linting plus Obsidian's own plugin-review rules, so the checks the
// community-plugin reviewers run are the checks `npm run lint` runs here.
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "main.js.map"] }, // the esbuild bundle, not source
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `test()` returns a promise the runner awaits, not the caller. Named
      // rather than switched off, so a genuinely dropped promise still fails.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", name: ["test", "describe", "it"], package: "node:test" }] },
      ],
      // "Silica" and "Markdown" are proper nouns; the rule reads them as
      // mid-sentence capitals and asks for them lowercased.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
  // The build and lint configs are outside tsconfig's `include`, so there are no
  // types to lint them against.
  { files: ["**/*.mjs"], ...tseslint.configs.disableTypeChecked },
);
