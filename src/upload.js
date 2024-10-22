const { debug, info, setFailed, error, warning } = require('@actions/core')
const glob = require('@actions/glob')
const fs = require('fs')
const { dirname, normalize, resolve } = require('path')
const { promisify } = require('util')
const archiver = require('archiver')
const { realpath } = require('fs/promises')
const { Client } = require('ssh2')
const path = require('path')

const stat = promisify(fs.stat)

/**
 * @typedef UploadArgs
 * @prop {string} artifact_name
 * @prop {string} search_path
 * @prop {'warn'|'error'|'ignore'} if_no_files_found
 * @prop {number} compression_level
 * @prop {boolean} include_hidden_files
 * @prop {string} method
 * @prop {Object} sftp
 * @prop {string} sftp.server
 * @prop {string} sftp.user
 * @prop {string} sftp.password
 * @prop {string} sftp.private_key
 * @prop {string} server_path
 */

/**
 * @typedef SearchResults
 * @prop {string[]} files_to_upload
 * @prop {string} root_dir
 */

/**
 * Stolen from https://github.com/actions/upload-artifact/blob/main/src/shared/search.ts#L32
 * If multiple paths are specific, the least common ancestor (LCA) of the search paths is used as
 * the delimiter to control the directory structure for the artifact. This function returns the LCA
 * when given an array of search paths
 *
 * Example 1: The patterns `/foo/` and `/bar/` returns `/`
 *
 * Example 2: The patterns `~/foo/bar/*` and `~/foo/voo/two/*` and `~/foo/mo/` returns `~/foo`
 */
function getMultiPathLCA(searchPaths) {
  if (searchPaths.length < 2) {
    throw new Error('At least two search paths must be provided')
  }

  const commonPaths = []
  const splitPaths = []
  let smallestPathLength = Number.MAX_SAFE_INTEGER

  // split each of the search paths using the platform specific separator
  for (const searchPath of searchPaths) {
    debug(`Using search path ${searchPath}`)

    const splitSearchPath = path.normalize(searchPath).split(path.sep)

    // keep track of the smallest path length so that we don't accidentally later go out of bounds
    smallestPathLength = Math.min(smallestPathLength, splitSearchPath.length)
    splitPaths.push(splitSearchPath)
  }

  // on Unix-like file systems, the file separator exists at the beginning of the file path, make sure to preserve it
  if (searchPaths[0].startsWith(path.sep)) {
    commonPaths.push(path.sep)
  }

  let splitIndex = 0
  // function to check if the paths are the same at a specific index
  function isPathTheSame() {
    const compare = splitPaths[0][splitIndex]
    for (let i = 1; i < splitPaths.length; i++) {
      if (compare !== splitPaths[i][splitIndex]) {
        // a non-common index has been reached
        return false
      }
    }
    return true
  }

  // loop over all the search paths until there is a non-common ancestor or we go out of bounds
  while (splitIndex < smallestPathLength) {
    if (!isPathTheSame()) {
      break
    }
    // if all are the same, add to the end result & increment the index
    commonPaths.push(splitPaths[0][splitIndex])
    splitIndex++
  }
  return path.join(...commonPaths)
}

/**
 *
 * @param {string} search_path
 * @param {glob.GlobOptions} options
 * @returns {SearchResults}
 */
async function find_files(search_path, options) {
  const globber = await glob.create(search_path)
  const raw_search_results = await globber.glob()
  const search_results = []

  const set = new Set()

  for (const result of raw_search_results) {
    const fileStats = await stat(result)
    if (fileStats.isDirectory()) {
      debug(`Ignoring directory ${result}`)
      continue
    }

    search_results.push(result)
    if (set.has(result)) {
      info(`Uploads are case insensitive. There is a collision at ${result}`)
    } else {
      set.add(result)
    }
  }

  // Find the least common ancestor for all included files
  const search_paths = globber.getSearchPaths()
  if (search_paths.length > 1) {
    return {
      files_to_upload: search_results,
      root_dir: getMultiPathLCA(search_paths)
    }
  }

  if (search_results.length === 1 && search_paths[0] === search_results[0]) {
    return {
      files_to_upload: search_results,
      root_dir: dirname(search_results[0])
    }
  }

  return {
    files_to_upload: search_results,
    root_dir: search_paths[0]
  }
}

/**
 * @param {UploadArgs} inputs
 */
async function upload(inputs) {
  const { files_to_upload, root_dir } = find_files(inputs.search_path, {
    excludeHiddenFiles: !inputs.include_hidden_files
  })

  if (files_to_upload.length === 0) {
    setFailed(`No files were found for ${inputs.search_path}`)
    return
  }

  const zip_output_stream = fs.createWriteStream(
    __dirname + inputs.artifact_name
  )
  const archive = archiver('zip', {
    zlib: { level: inputs.compression_level }
  })
  archive.pipe(zip_output_stream)

  archive.on('error', zip_error => {
    error('An error occurred while zipping the artifact.')
    info(zip_error)
    throw new Error(zip_error)
  })
  archive.on('warning', zip_warning => {
    warning('Warning while zipping the artifact')
    info(zip_warning)
  })
  archive.on('finish', () => debug('Finished zipping the artifact'))

  for (let file of files_to_upload) {
    // Allows for absolute and relative paths
    file = normalize(file)
    file = resolve(file)
    file = await realpath(file)

    archive.file(file, { name: file.replace(root_dir, '') })
  }

  await archive.finalize()

  const conn = new Client()
  conn.on('ready', () => {
    info('Established SSH tunnel to SFTP server')
    conn.sftp((err, sftp) => {
      if (err) {
        info(err)
        setFailed('Could not open SFTP connection')
        throw err
      }

      sftp.fastPut(inputs.artifact_name, inputs.server_path)
    })
  })
  conn.on('close', () => info('Closed SFTP connection'))
  conn.on('end', () => info('Ended SFTP connection'))
  conn.on('error', sftp_error => error(`SFTP Error: ${sftp_error}`))

  conn.connect({
    host: inputs.sftp.server,
    port: 22,
    username: inputs.sftp.user,
    password: inputs.sftp.password
  })

  info('Finished uploading artifact!')
}

module.exports = {
  upload
}
