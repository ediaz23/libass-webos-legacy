const pkg = require('../../package.json')

const commonBaseConfig = {
    devtool: 'source-map',
    module: {
        rules: [{
            test: /\.(js|mjs)$/,
            exclude: [/core-js/, /worker\.(debug|min)\.js$/],
            use: [{
                loader: 'string-replace-loader',
                options: {
                    search: '__VERSION__',
                    replace: pkg.version,
                },
            }],
        }],
    },
}

const prodEntries = {
    'libass': './src/libass.js',
    'libass.worker': './src/worker.js',
}

module.exports = { commonBaseConfig, prodEntries }
