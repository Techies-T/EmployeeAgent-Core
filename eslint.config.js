import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'dist/**', 'zta-mcp-stack', 'zta-mcp-stack/**', '**/._*', '**/.DS_Store']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      react,
    },
    rules: {
      'no-unused-vars': ['warn', { varsIgnorePattern: '^(_|[A-Z])', argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-refresh/only-export-components': 'warn',
      'no-regex-spaces': 'warn',
      'no-empty': 'warn',
      'no-undef': 'warn',
      'no-useless-escape': 'warn',
      'no-use-before-define': ['warn', { "functions": false, "classes": true, "variables": true }]
    },
  },
])
