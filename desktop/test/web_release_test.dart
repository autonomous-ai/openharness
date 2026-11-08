import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/web_release.dart';

void main() {
  test('a release manifest names its version', () {
    expect(
      webReleaseVersionFrom({
        'version': '1.3.19',
        'sourceCommit': '54fc5b06',
        'baseHref': '/harness-web/',
      }),
      '1.3.19',
    );
    expect(webReleaseVersionFrom({'version': ' 1.3.20 \n'}), '1.3.20');
  });

  test('anything else names none', () {
    for (final manifest in <Object?>[
      null,
      '1.3.19',
      <String, Object?>{},
      {'version': ''},
      {'version': 1319},
      ['1.3.19'],
    ]) {
      expect(webReleaseVersionFrom(manifest), isNull, reason: '$manifest');
    }
  });

  test('no manifest beside the page (native, or flutter run) names none', () async {
    expect(await webReleaseVersion(), isNull);
  });
}
