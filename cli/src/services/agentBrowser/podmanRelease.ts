/**
 * The Podman setup installs where there is none: one pinned release, each file with the SHA-256 its release publishes.
 * Source: https://github.com/podman-container-tools/podman/releases/tag/v5.8.9 (its `shasums` file, which matches the
 * digests GitHub lists for each asset). Read 2026-11-10. Linux installs the distribution's own package instead.
 */
const DOWNLOAD = 'https://github.com/podman-container-tools/podman/releases/download/v5.8.9'

export const PODMAN_RELEASE: {
  version: string
  artifacts: Record<'darwin-arm64' | 'darwin-x64', { url: string; sha256: string }>
} = {
  version: '5.8.9',
  artifacts: {
    'darwin-arm64': {
      url: `${DOWNLOAD}/podman-installer-macos-arm64.pkg`,
      sha256: '2c86fb0ebdd81a4bf9d93d1aba632e62f4e65850f68f1a75e4feed8c77a46d11',
    },
    'darwin-x64': {
      url: `${DOWNLOAD}/podman-installer-macos-amd64.pkg`,
      sha256: '3d600c6a1efd41445b56ed9864b9daba0765cfeae9d62604e87cf6c01b613403',
    },
  },
}
