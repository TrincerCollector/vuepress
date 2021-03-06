'use strict'

module.exports = async function dev (sourceDir, cliOptions = {}) {
  const { path } = require('@vuepress/shared-utils')
  const webpack = require('webpack')
  const chokidar = require('chokidar')
  const serve = require('webpack-serve')
  const convert = require('koa-connect')
  const mount = require('koa-mount')
  const range = require('koa-range')
  const serveStatic = require('koa-static')
  const history = require('connect-history-api-fallback')

  const prepare = require('./prepare/index')
  const { chalk, fs, logger } = require('@vuepress/shared-utils')
  const HeadPlugin = require('./webpack/HeadPlugin')
  const DevLogPlugin = require('./webpack/DevLogPlugin')
  const createClientConfig = require('./webpack/createClientConfig')
  const { applyUserWebpackConfig } = require('./util/index')
  const { frontmatterEmitter } = require('@vuepress/markdown-loader')

  logger.wait('\nExtracting site metadata...')
  const options = await prepare(sourceDir, cliOptions, false /* isProd */)

  // setup watchers to update options and dynamically generated files
  const update = (reason) => {
    logger.debug(`Re-prepare due to ${chalk.cyan(reason)}`)
    options.pluginAPI.options.updated.syncApply()
    prepare(sourceDir, cliOptions, false /* isProd */).catch(err => {
      console.error(logger.error(chalk.red(err.stack), false))
    })
  }

  // watch add/remove of files
  const pagesWatcher = chokidar.watch([
    '**/*.md',
    '.vuepress/components/**/*.vue'
  ], {
    cwd: sourceDir,
    ignored: ['.vuepress/**/*.md', 'node_modules'],
    ignoreInitial: true
  })
  pagesWatcher.on('add', () => update('add page'))
  pagesWatcher.on('unlink', () => update('unlink page'))
  pagesWatcher.on('addDir', () => update('addDir'))
  pagesWatcher.on('unlinkDir', () => update('unlinkDir'))

  // watch config file
  const configWatcher = chokidar.watch([
    '.vuepress/config.js',
    '.vuepress/config.yml',
    '.vuepress/config.toml'
  ], {
    cwd: sourceDir,
    ignoreInitial: true
  })
  configWatcher.on('change', () => update('config change'))

  // also listen for frontmatter changes from markdown files
  frontmatterEmitter.on('update', () => update('frontmatter or headers change'))

  // resolve webpack config
  let config = createClientConfig(options)

  config
    .plugin('html')
    // using a fork of html-webpack-plugin to avoid it requiring webpack
    // internals from an incompatible version.
    .use(require('vuepress-html-webpack-plugin'), [{
      template: options.devTemplate
    }])

  config
    .plugin('site-data')
    .use(HeadPlugin, [{
      tags: options.siteConfig.head || []
    }])

  const port = await resolvePort(cliOptions.port || options.siteConfig.port)
  const { host, displayHost } = await resolveHost(cliOptions.host || options.siteConfig.host)

  config
  .plugin('vuepress-log')
  .use(DevLogPlugin, [{
    port,
    displayHost,
    publicPath: options.base
  }])

  config = config.toConfig()
  const userConfig = options.siteConfig.configureWebpack
  if (userConfig) {
    config = applyUserWebpackConfig(userConfig, config, false /* isServer */)
  }

  const compiler = webpack(config)

  const nonExistentDir = path.resolve(__dirname, 'non-existent')
  await serve({
    // avoid project cwd from being served. Otherwise if the user has index.html
    // in cwd it would break the server
    content: [nonExistentDir],
    compiler,
    host,
    dev: { logLevel: 'warn' },
    hot: {
      port: port + 1,
      logLevel: 'error'
    },
    logLevel: 'error',
    port,
    add: app => {
      // apply plugin options to extend dev server.
      const { pluginAPI } = options
      pluginAPI.options.enhanceDevServer.syncApply(app)

      const userPublic = path.resolve(sourceDir, '.vuepress/public')

      // enable range request
      app.use(range)

      // respect base when serving static files...
      if (fs.existsSync(userPublic)) {
        app.use(mount(options.base, serveStatic(userPublic)))
      }

      app.use(convert(history({
        rewrites: [
          { from: /\.html$/, to: '/' }
        ]
      })))
    }
  })
}

function resolveHost (host) {
  // webpack-serve hot updates doesn't work properly over 0.0.0.0 on Windows,
  // but localhost does not allow visiting over network :/
  const defaultHost = process.platform === 'win32' ? 'localhost' : '0.0.0.0'
  host = host || defaultHost
  const displayHost = host === defaultHost && process.platform !== 'win32'
    ? 'localhost'
    : host
  return {
    displayHost,
    host
  }
}

async function resolvePort (port) {
  const portfinder = require('portfinder')
  portfinder.basePort = parseInt(port) || 8080
  port = await portfinder.getPortPromise()
  return port
}
