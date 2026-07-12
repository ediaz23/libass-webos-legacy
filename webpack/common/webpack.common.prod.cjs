const { prodEntries } = require('./webpack.common.base.cjs')

const configCommonDebugProdEsm = {
    mode: 'development',
    entry: prodEntries,
    output: {
        filename: '[name].debug.js'
    }
}

const configCommonMinProdEsm = {
    mode: 'production',
    entry: prodEntries,
    output: {
        filename: '[name].min.js'
    },
    optimization: {
        usedExports: false,
    },
    performance: { hints: false },
}

module.exports = { configCommonDebugProdEsm, configCommonMinProdEsm }
