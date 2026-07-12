const path = require('path')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const { merge } = require('webpack-merge')
const { esmConfig } = require('./webpack.legacy.base.cjs')
const {
    configCommonDebugProdEsm,
    configCommonMinProdEsm,
} = require('../common/webpack.common.prod.cjs')

const source = path.resolve(__dirname, '../../build/js/legacy')
const emptyModule = path.resolve(__dirname, '../../src/empty.js')

const configLegacyDebugEsm = merge(esmConfig, configCommonDebugProdEsm, {
    resolve: { alias: { wasm: emptyModule } },
    plugins: [
        new CopyWebpackPlugin({ patterns: [{ from: `${source}/worker.debug.js` }] }),
    ],
})

const configLegacyMinEsm = merge(esmConfig, configCommonMinProdEsm, {
    resolve: { alias: { wasm: emptyModule } },
    plugins: [
        new CopyWebpackPlugin({ patterns: [{ from: `${source}/worker.min.js` }] }),
    ],
})

module.exports = [configLegacyDebugEsm, configLegacyMinEsm]
