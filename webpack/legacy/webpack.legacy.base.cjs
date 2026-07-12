const path = require('path')
const { merge } = require('webpack-merge')
const { commonBaseConfig } = require('../common/webpack.common.base.cjs')

const baseConfig = {
    test: /\.(js|mjs)$/,
    use: [{
        loader: 'babel-loader',
        options: {
            sourceType: 'unambiguous',
            presets: [[
                '@babel/preset-env',
                {
                    useBuiltIns: 'usage',
                    targets: { chrome: '38' },
                    corejs: '3.39.0',
                }
            ]],
            plugins: [
                '@babel/plugin-transform-runtime',
                '@babel/plugin-transform-parameters',
            ],
        },
    }, {
        loader: 'webpack-conditional-loader'
    }]
}

const legacyConfig = merge(commonBaseConfig, {
    target: ['web', 'es5'],
    module: {
        rules: [
            {
                ...baseConfig,
                exclude: [/core-js/, /worker\.(debug|min)\.js$/],
            },
            {
                ...baseConfig,
                include: [path.resolve(__dirname, '../../node_modules/event-target-shim')],
            },
        ]
    },
})

const esmConfig = merge(legacyConfig, {
    experiments: {
        outputModule: true
    },
    output: {
        path: path.resolve(__dirname, '../../dist/legacy'),
        publicPath: '/dist/legacy/',
        library: { type: 'module' },
    },
})

module.exports = { esmConfig }
