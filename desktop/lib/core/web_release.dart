import 'package:dio/dio.dart';

import 'page_base_native.dart'
    if (dart.library.js_interop) 'page_base_web.dart'
    as impl;

/// The manifest a web release writes beside its index.html
/// (`scripts/build-web-release.sh`); the host serves it `no-store`.
const kWebReleaseManifest = 'release.json';

const _readTimeout = Duration(seconds: 10);

/// The web release this host serves, read from its [kWebReleaseManifest] —
/// the same file `make release-web` checks after a deploy. Null natively, under
/// `flutter run` (which serves no manifest), or when it cannot be read.
Future<String?> webReleaseVersion({Dio? dio}) async {
  final base = impl.pageBaseUri();
  if (base == null) return null;
  try {
    final response = await (dio ?? Dio()).getUri<Object?>(
      base.resolve(kWebReleaseManifest),
      options: Options(
        responseType: ResponseType.json,
        sendTimeout: _readTimeout,
        receiveTimeout: _readTimeout,
      ),
    );
    return webReleaseVersionFrom(response.data);
  } on DioException {
    return null;
  }
}

/// The `version` a release manifest names — pure, so it is tested without a
/// browser.
String? webReleaseVersionFrom(Object? manifest) => switch (manifest) {
  {'version': final String version} when version.trim().isNotEmpty =>
    version.trim(),
  _ => null,
};
