import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/remote_media_download.dart';
import 'package:harness_mobile/terminal/terminal_link_opener.dart';

void main() {
  test('web links launch directly without downloading a file', () async {
    final launched = <Uri>[];
    final opener = TerminalLinkOpener(
      launch: (uri) async {
        launched.add(uri);
        return true;
      },
    );
    expect(await opener.open('https://example.invalid/report?q=one'), isNull);
    expect(launched.single, Uri.parse('https://example.invalid/report?q=one'));
  });

  test(
    'a terminal file is downloaded from its computer before opening',
    () async {
      final launched = <Uri>[];
      final requested = <String>[];
      final opener = TerminalLinkOpener(
        launch: (uri) async {
          launched.add(uri);
          return true;
        },
        fileExists: (_) async => true,
        windows: false,
      );
      expect(
        await opener.open(
          '~/project/preview.png',
          downloadRemote: (target) async {
            requested.add(target);
            return '/sample-cache/preview.png';
          },
        ),
        isNull,
      );
      expect(requested, ['~/project/preview.png']);
      expect(launched.single, Uri.file('/sample-cache/preview.png'));
    },
  );

  test('unsupported targets never launch or request a download', () async {
    final opener = TerminalLinkOpener(
      launch: (_) async => fail('unsupported link launched'),
    );
    for (final target in [
      'javascript:alert(1)',
      'https:',
      'file://other-machine/image.png',
      '/project/credentials.txt',
      'image.png\ncommand',
    ]) {
      expect(
        await opener.open(
          target,
          downloadRemote: (_) async => fail('unsupported file downloaded'),
        ),
        isNotNull,
      );
    }
  });

  test(
    'missing download support or an expired preview explains the failure',
    () async {
      final opener = TerminalLinkOpener(
        launch: (_) async => fail('missing file launched'),
        fileExists: (_) async => false,
      );
      expect(
        await opener.open('/project/image.png'),
        contains('download a preview'),
      );
      expect(
        await opener.open(
          '/project/image.png',
          downloadRemote: (_) async => '/sample-cache/gone.png',
        ),
        contains('no longer available'),
      );
    },
  );

  test('a cancelled download stays silent and never launches', () async {
    var cancelled = false;
    final opener = TerminalLinkOpener(
      launch: (_) async => fail('cancelled preview launched'),
    );
    expect(
      await opener.open(
        '/project/image.png',
        isCancelled: () => cancelled,
        downloadRemote: (_) async {
          cancelled = true;
          return '/sample-cache/image.png';
        },
      ),
      isNull,
    );
    expect(
      await opener.open(
        '/project/image.png',
        downloadRemote: (_) async => throw const RemoteMediaCancelled(),
      ),
      isNull,
    );
  });

  test('download and launcher failures become readable messages', () async {
    final opener = TerminalLinkOpener(launch: (_) async => false);
    expect(
      await opener.open('https://example.invalid'),
      contains('Could not open'),
    );
    expect(
      await opener.open(
        '/project/image.png',
        downloadRemote: (_) async =>
            throw const RemoteMediaException('Preview too large.'),
      ),
      'Preview too large.',
    );
    final throwing = TerminalLinkOpener(
      launch: (_) async => throw StateError('launcher unavailable'),
    );
    expect(
      await throwing.open('https://example.invalid'),
      contains('Could not open'),
    );
  });
}
