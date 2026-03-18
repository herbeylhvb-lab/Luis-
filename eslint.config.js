const globals = require("globals");

module.exports = [
  {
    files: ["*.js", "routes/*.js", "providers/*.js", "middleware/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      eqeqeq: ["warn", "smart"],
      "no-var": "warn",
      "prefer-const": "warn",
      "no-throw-literal": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
];
