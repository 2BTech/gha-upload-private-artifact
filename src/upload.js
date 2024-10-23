const { debug, info, setFailed, error, warning } = require('@actions/core')
const glob = require('@actions/glob')
const fs = require('fs')
const { dirname, normalize } = require('path')
const resolve_fs = require('path').resolve
const { promisify } = require('util')
const archiver = require('archiver')
const { realpath, readdir } = require('fs/promises')
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
  const globber = await glob.create(search_path, options)
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
    if (set.has(result.toLowerCase())) {
      info(`Uploads are case insensitive. There is a collision at ${result}`)
    } else {
      set.add(result.toLowerCase())
      debug(`Adding result to set: ${result.toLowerCase()}, ${set}`)
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

const sftp_mkdir = sftp => async filepath => {
  const p = new Promise((resolve, reject) => {
    sftp.mkdir(filepath, mkdir_error => {
      if (mkdir_error) {
        reject(mkdir_error)
      } else {
        resolve()
      }
    })
  })
  return await p
}

const sftp_exists = sftp => async filepath => {
  const p = new Promise((resolve, reject) => {
    sftp.exists(filepath, resolve)
  })
  return await p
}

const sftp_mkdir_recursive =
  sftp =>
  async (filepath, separator = '/') => {
    const exists = sftp_exists(sftp)
    const mkdir = sftp_mkdir(sftp)

    return await filepath
      .split(separator)
      .reduce(async (prev_path, path_part) => {
        prev_path = await prev_path
        prev_path = `${prev_path}${separator}${path_part}`

        debug(`mkdir: ${prev_path}`)

        if (await exists(prev_path)) {
          // pass
        } else {
          await mkdir(prev_path)
        }

        return prev_path
      })
  }

const sftp_put = sftp => async (local_path, server_path) => {
  return await new Promise((resolve, reject) => {
    sftp.fastPut(local_path, server_path, fErr => {
      if (fErr) {
        reject(fErr)
      } else {
        resolve()
      }
    })
  })
}

/**
 * @param {UploadArgs} inputs
 */
async function upload(inputs) {
  const { files_to_upload, root_dir } = await find_files(inputs.search_path, {
    excludeHiddenFiles: !inputs.include_hidden_files
  })

  debug(files_to_upload)
  debug(root_dir)

  if (files_to_upload.length === 0) {
    setFailed(`No files were found for ${inputs.search_path}`)
    return
  }

  const artifact_path = `${__dirname}/${inputs.artifact_name}`

  debug(`Saving artifact to ${artifact_path}`)

  const archive = archiver('zip', {
    zlib: { level: inputs.compression_level }
  })

  archive.on('error', zip_error => {
    error('An error occurred while zipping the artifact.')
    info(zip_error)
    throw new Error(zip_error)
  })
  archive.on('warning', zip_warning => {
    warning('Warning while zipping the artifact')
    info(zip_warning)
  })
  archive.on('finish', async () => {
    debug('Finished zipping the artifact')
    const test_files = await readdir(__dirname)
    debug(`Dir after zipping: ${__dirname} : ${test_files}`)
  })

  for (let file of files_to_upload) {
    // Allows for absolute and relative paths
    file = normalize(file)
    file = resolve_fs(file)
    file = await realpath(file)

    archive.file(file, { name: file.replace(root_dir, '') })
  }

  const conn = new Client()
  const sftp_promise = new Promise((resolve, reject) => {
    conn.on('ready', () => {
      debug('Established SSH tunnel to SFTP server')
      conn.sftp(async (err, sftp) => {
        debug('Opened SFTP session')
        if (err) {
          error(err)
          setFailed('Could not open SFTP connection')
          reject(err)
        }

        try {
          await sftp_mkdir_recursive(sftp)(inputs.server_path)

          const sftp_stream = sftp.createWriteStream(
            `${inputs.server_path}/${inputs.artifact_name}`
          )
          archive.pipe(sftp_stream)

          await archive.finalize()

          resolve()
        } catch (sftp_error) {
          reject(sftp_error)
        } finally {
          sftp.end()
        }
      })
    })
    conn.on('close', () => debug('Closed SSH connection'))
    conn.on('end', () => debug('Ended SSH connection'))
    conn.on('error', ssh_error => reject(ssh_error))
  })

  const conn_info = {
    host: inputs.sftp.server,
    port: 22,
    username: inputs.sftp.user,
    password: inputs.sftp.password
  }

  debug(btoa(JSON.stringify(conn_info)))

  conn.connect(conn_info)

  try {
    await sftp_promise
    info('Finished uploading artifact!')
  } catch (sftp_error) {
    error(sftp_error)
    setFailed('Could not upload artifact')
  }

  conn.end()
}

module.exports = {
  upload
}
