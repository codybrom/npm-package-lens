import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import jsdoc from "eslint-plugin-jsdoc";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["out/**", "node_modules/**", "*.vsix"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  jsdoc.configs["flat/recommended-typescript"],
  {
    languageOptions: {
      parserOptions: {
        // The root config files (esbuild.js, eslint.config.mjs) live outside
        // tsconfig's `include`, so the project service needs them listed here
        // or it reports them as "not found by the project service".
        projectService: {
          allowDefaultProject: ["esbuild.js", "eslint.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
      // Requires a JSDoc block on every exported function/class — the
      // module's public API — without demanding one on every private
      // helper, which would be noise rather than signal.
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
          },
        },
      ],
    },
  },
  {
    // Build/config scripts are plain JS running on Node, not part of the
    // typed source tree — the type-aware rules have nothing useful to say.
    files: ["*.js", "*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      "jsdoc/require-jsdoc": "off",
      // In .js files `@type` is the only way to get type-checking, so it is
      // not redundant the way it would be in TypeScript.
      "jsdoc/check-tag-names": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // esbuild.js is CommonJS; the .mjs config is an ES module, so only the
    // former gets the commonjs source type.
    files: ["*.js"],
    languageOptions: { sourceType: "commonjs" },
  },
  eslintConfigPrettier,
);
