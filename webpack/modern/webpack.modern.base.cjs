const path = require('path')
const { merge } = require('webpack-merge')
const { commonBaseConfig } = require('../common/webpack.common.base.cjs')

const modernConfig = merge(commonBaseConfig, {
    target: ['browserslist'],
    module: {
        rules: [{
            test: /\.(js|mjs)$/,
            exclude: [/core-js/, /worker\.(debug|min)\.js$/],
            use: [{
                loader: 'babel-loader',
                options: {
                    sourceType: 'unambiguous',
                    presets: [[
                        '@babel/preset-env',
                        {
                            useBuiltIns: 'usage',
                            targets: { chrome: '68' },
                            bugfixes: true,
                            corejs: '3.39.0',
                        }
                    ]],
                    plugins: [
                        '@babel/plugin-transform-runtime',
                        '@babel/plugin-proposal-nullish-coalescing-operator',
                        '@babel/plugin-proposal-optional-chaining',
                    ],
                }
            }, {
                loader: 'webpack-conditional-loader'
            }]
        }, {
            test: /worker\.(debug|min)\.js$/,
            parser: { url: false }
        }]
    }
})

const esmConfig = merge(modernConfig, {
    experiments: {
        outputModule: true
    },
    output: {
        path: path.resolve(__dirname, '../../dist/modern'),
        publicPath: '/dist/modern/',
        library: { type: 'module' },
    },
})

module.exports = { esmConfig }
