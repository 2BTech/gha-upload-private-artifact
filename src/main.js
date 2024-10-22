const core = require('@actions/core')

const { upload } = require('./upload')

const validNoFileOptions = ['warn', 'error', 'ignore']

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
async function run() {
  try {
    const artifact_name = core.getInput('name', { required: true })
    const search_path = core.getInput('path', { required: true })
    const if_no_files_found = core.getInput('if-no-files-found')
    let compression_level = core.getInput('compression-level')
    const include_hidden_files = core.getBooleanInput('include-hidden-files')
    const method = 'SFTP'
    const server = core.getInput('server', { required: true })
    const user = core.getInput('user', { required: true })
    const password = core.getInput('password')
    const private_key = core.getInput('private-key')
    let server_path = core.getInput('server-path')

    if (compression_level) {
      compression_level = parseInt(compression_level)
      if (isNaN(compression_level)) {
        core.setFailed('Invalid compression-level')
      }
      if (compression_level < 0 || compression_level > 9) {
        core.setFailed('Invalid compression level. Valid values are 0-9')
      }
    }

    if (!validNoFileOptions.includes(if_no_files_found)) {
      core.setFailed(
        `Unrecognized 'if-no-files-found' input. Provide: ${if_no_files_found}`
      )
    }

    if (server_path == '') {
      const path_parts = [
        process.env['GITHUB_REPOSITORY'],
        process.env['GITHUB_REF'],
        process.env['GITHUB_SHA'].slice(0, 7),
        process.env['GITHUB_WORKFLOW'],
        process.env['GITHUB_RUN_NUMBER']
      ];
      server_path = path_parts.join('/');
      core.info(`Set server-path to default: ${ server_path }`);
    }

    /** @type {import('./upload').UploadArgs} */
    const args = {
      artifact_name,
      search_path,
      if_no_files_found,
      compression_level,
      include_hidden_files,
      method,
      sftp: {
        user,
        password,
        private_key
      },
      server_path
    }

    await upload(args);

  } catch (error) {
    // Fail the workflow run if an error occurs
    core.setFailed(error.message)
  }
}

module.exports = {
  run
}
