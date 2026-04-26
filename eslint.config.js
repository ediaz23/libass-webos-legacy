
import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import globals from 'globals'
import n from 'eslint-plugin-n'
import importPlugin from 'eslint-plugin-import'

export default defineConfig([
    {
        ignores: ['eslint.config.js', 'tests/**', ' dist/**', 'lib/**', 'build/**'],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.worker,
            },
        },
        plugins: {
            n,
            import: importPlugin
        },
        rules: {
            'no-unused-vars': [
                'error',
                {
                    'argsIgnorePattern': '^_',
                    'varsIgnorePattern': '^_',
                    'caughtErrorsIgnorePattern': '^_'
                }
            ],
            'import/extensions': ['error', 'ignorePackages'],
            'import/no-unresolved': 'error'
        },
    }
])
