import _ from 'lodash'
import https from 'https'
import path from 'path'
import webpack from 'webpack'
import dotenv from 'dotenv'
import fs from 'fs'
import HtmlWebpackPlugin from 'html-webpack-plugin'
import S3WebpackPlugin from '../src/s3_plugin'
import {assert} from 'chai'

dotenv.load()

const {
  AWS_BUCKET,
  AWS_REGION,
  AWS_ACCESS_KEY,
  AWS_SECRET_ACCESS_KEY
} = process.env

const S3_URL = `https://s3-${AWS_REGION}.amazonaws.com/${AWS_BUCKET}/`,
      S3_ERROR_REGEX = /<Error>/,
      OUTPUT_FILE_NAME = 's3Test',
      OUTPUT_PATH = path.resolve(__dirname, '.tmp'),
      ENTRY_PATH = path.resolve(__dirname, 'fixtures/index.js')

var extractCodeFromS3Html = function(html) {
  return /<pre .*>(.*)<\/pre>/gs.match(html)
}

var deleteFolderRecursive = function(path) {
  if (fs.existsSync(path)) {
    fs.readdirSync(path).forEach(function(file,index) {
      var curPath = `${path}/${file}`

      if (fs.lstatSync(curPath).isDirectory()) { // recurse
        deleteFolderRecursive(curPath)
      } else { // delete file
        fs.unlinkSync(curPath)
      }
    })

    fs.rmdirSync(path)
  }
}

var generateS3Config = function(config) {
  var params = _.merge(config || {}, {
    s3Options: {
      accessKeyId: AWS_ACCESS_KEY,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      region: AWS_REGION
    },
    s3UploadOptions: {
      Bucket: AWS_BUCKET
    }
  })

  return new S3WebpackPlugin(params)
}

export default {
  OUTPUT_FILE_NAME,
  OUTPUT_PATH,
  S3_URL,
  S3_ERROR_REGEX,

  fetch: function(url) {
    return new Promise(function(resolve, reject) {
      https.get(url, function(response) {
        var body = ''

        response.on('data', data => body += data)
        response.on('end', () => resolve(body))
        response.on('error', reject)
      })
    })
  },

  testForFailFromStatsOrGetS3Files({errors, stats}) {
    if (errors)
      return assert.fail([], errors, 'Webpack Build Failed')

    return this.getBuildFilesFromS3(this.getFilesFromStats(stats))
  },

  cleanOutputDirectory() {
    deleteFolderRecursive(OUTPUT_PATH)
  },

  createOutputPath() {
    if (!fs.existsSync(OUTPUT_PATH))
      fs.mkdirSync(OUTPUT_PATH)
  },

  createRandomFile(newPath) {
    var hash = Math.random() * 10000,
        fileName = `random-file-${hash}`,
        newFileName = `${newPath}/${fileName}`

    // Create Random File to upload
    fs.writeFileSync(newFileName, `This is a new file - ${hash}`)

    return {fullPath: newFileName, fileName}
  },

  createWebpackConfig({config, s3Config} = {}) {
    return _.extend({
      entry: ENTRY_PATH,
      plugins: [
        new HtmlWebpackPlugin(),
        generateS3Config(s3Config)
      ],
      output: {
        path: OUTPUT_PATH,
        filename: `${OUTPUT_FILE_NAME}-[hash]-${+new Date()}.js`
      }
    }, config)
  },

  runWebpackConfig({config, s3Config}) {
    this.createOutputPath()

    return new Promise(function(resolve, reject) {
      webpack(config, function(err, stats) {
        if (stats.toJson().errors.length)
          resolve({errors: stats.toJson().errors})
        else
          resolve({config, stats})
      })
    })
  },

  getFilesFromDirectory(directory) {
    return fs.readdirSync(directory)
  },

  getFilesFromStats(stats) {
    return _.pluck(stats.toJson().assets, 'name')
  },

  getBuildFilesFromS3(files) {
    var fetchFiles = files
      .filter(file => !/.*\.html$/.test(file))

    return Promise.all(fetchFiles.map(file => this.fetch(S3_URL + file))) 
      .then(nFiles => nFiles.map((file, i) => {
        return {
          name: fetchFiles[i],
          actual: file,
          expected: this.readFileFromOutputDir(fetchFiles[i])
        }
      }))
  },

  readFileFromOutputDir(file) {
    return fs.readFileSync(path.resolve(OUTPUT_PATH, file)).toString()
  },

  assertFileMatches(files) {
    var errors = _(files)
      .map(({expected, actual, name}) => assert.equal(actual, expected, `File - ${name} - doesn't match`))
      .compact()
      .value()

    return Promise.all(_.any(errors) ? errors : files)
  }
}