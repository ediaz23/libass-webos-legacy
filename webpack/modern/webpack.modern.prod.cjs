const path = require('path')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const { merge } = require('webpack-merge')
const { esmConfig } = require('./webpack.modern.base.cjs')
const {
    configCommonDebugProdEsm,
    configCommonMinProdEsm,
} = require('../common/webpack.common.prod.cjs')

const source = path.resolve(__dirname, '../../build/js/modern')

const configModernDebugEsm = merge(esmConfig, configCommonDebugProdEsm, {
    resolve: { alias: { wasm: `${source}/worker.debug.js` } },
    plugins: [
        new CopyWebpackPlugin({ patterns: [{ from: `${source}/worker.debug.wasm` }] }),
    ],
})

const configModernMinEsm = merge(esmConfig, configCommonMinProdEsm, {
    resolve: { alias: { wasm: `${source}/worker.min.js` } },
    plugins: [
        new CopyWebpackPlugin({ patterns: [{ from: `${source}/worker.min.wasm` }] }),
    ],
})

module.exports = [configModernDebugEsm, configModernMinEsm]
