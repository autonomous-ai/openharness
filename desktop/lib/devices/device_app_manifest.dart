/// Which build of the Harness menu-bar app (`Harness Device.app`) this Mac
/// installs, from the release's own manifest.
///
/// The manifest is read from the bucket, never through the CDN, which could
/// still serve the copy from before a release. Its entry's URL is checked all
/// the same: a manifest someone else wrote must not send the download anywhere
/// but the release's own folders.
library;

const deviceAppManifestUrl =
    'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json';
const deviceAppUrlPrefixes = [
  'https://cdn.autonomous.ai/harness/device/',
  'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/',
];
const deviceAppMaxBytes = 200 * 1024 * 1024;
const deviceAppManifestMaxBytes = 64 * 1024;

class DeviceAppRelease {
  const DeviceAppRelease({
    required this.url,
    required this.sha256,
    required this.size,
  });

  final String url;
  final String sha256; // lowercase
  final int size;
}

final _sha256 = RegExp(r'^[0-9a-fA-F]{64}$');

/// The entry this computer installs, or null when the manifest names none it may fetch.
/// [architecture] is `arm64` or `x64`.
DeviceAppRelease? parseDeviceAppManifest(
  Object? manifest, {
  required String architecture,
}) {
  if (manifest is! Map) return null;
  // The app is universal, so an Apple Silicon Mac can fall back to the other
  // build; an Intel Mac never takes the arm64 one.
  final keys = architecture == 'arm64'
      ? const ['device-macos-arm64', 'device-macos']
      : const ['device-macos'];
  for (final key in keys) {
    final release = _release(manifest[key]);
    if (release != null) return release;
  }
  return null;
}

DeviceAppRelease? _release(Object? entry) {
  if (entry is! Map) return null;
  final url = entry['url'];
  final sha256 = entry['sha256'];
  final size = entry['size'];
  if (url is! String || !_fetchable(url)) return null;
  if (sha256 is! String || !_sha256.hasMatch(sha256)) return null;
  if (size is! int || size < 1 || size > deviceAppMaxBytes) return null;
  return DeviceAppRelease(url: url, sha256: sha256.toLowerCase(), size: size);
}

/// Under one of [deviceAppUrlPrefixes] once a server has read it: a `..` or
/// `%2e%2e` segment changes the normal form, a server may read `\` as `/`, and
/// nothing may ride along in a query, a fragment, user info or a port.
bool _fetchable(String url) {
  if (!deviceAppUrlPrefixes.any(url.startsWith) || url.contains(r'\')) {
    return false;
  }
  final uri = Uri.tryParse(url);
  return uri != null &&
      uri.normalizePath().toString() == url &&
      !uri.hasQuery &&
      !uri.hasFragment &&
      uri.userInfo.isEmpty &&
      !uri.hasPort;
}
