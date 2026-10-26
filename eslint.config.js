import js from "@eslint/js";
import globals from "globals";

export default [{ ignores: ["coverage/"] }, js.configs.recommended, { languageOptions: { globals: globals.node } }];
