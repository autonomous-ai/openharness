// Workspace paths are filenames, not URLs: #, ? and % must reach the server literally.
export function workspaceFileUrl(path, parameters = {}) {
  const query = new URLSearchParams(parameters).toString()
  return '/' + path.split('/').map(encodeURIComponent).join('/') + (query ? '?' + query : '')
}
