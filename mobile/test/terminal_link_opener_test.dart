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
    expect(
      await opener.open(
        'https://example.invalid/report?q=one',
        downloadRemote: (_) async => fail('web link downloaded'),
        showLocal: (_) => fail('web link shown in the app'),
      ),
      isNull,
    );
    expect(launched.single, Uri.parse('https://example.invalid/report?q=one'));
  });

  test(
    'a terminal file is downloaded from its computer, then shown in the app',
    () async {
      final launched = <Uri>[];
      final requested = <String>[];
      final shown = <String>[];
      final opener = TerminalLinkOpener(
        launch: (uri) async {
          launched.add(uri);
          return true;
        },
        fileExists: (_) async => true,
      );
      for (final (target, local) in [
        ('~/project/preview.png', '/sample-cache/preview.png'),
        ('file:///project/clip.mov', '/sample-cache/clip.mov'),
      ]) {
        expect(
          await opener.open(
            target,
            downloadRemote: (target) async {
              requested.add(target);
              return local;
            },
            showLocal: shown.add,
          ),
          isNull,
        );
      }
      expect(requested, ['~/project/preview.png', 'file:///project/clip.mov']);
      expect(shown, ['/sample-cache/preview.png', '/sample-cache/clip.mov']);
      // `url_launcher` opens `file:` URLs on desktop platforms only: on a phone
      // handing the copy to it always failed.
      expect(launched, isEmpty);
    },
  );

  test('a file with nowhere to be shown is not downloaded', () async {
    final opener = TerminalLinkOpener(
      launch: (_) async => fail('local file launched'),
    );
    expect(
      await opener.open(
        '/project/image.png',
        downloadRemote: (_) async => fail('file downloaded for nothing'),
      ),
      'Could not open this preview.',
    );
  });

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
          showLocal: (_) => fail('unsupported file shown'),
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
          showLocal: (_) => fail('missing file shown'),
        ),
        contains('no longer available'),
      );
    },
  );

  test('a cancelled download stays silent and is never shown', () async {
    var cancelled = false;
    final opener = TerminalLinkOpener(
      launch: (_) async => fail('cancelled preview launched'),
      fileExists: (_) async => true,
    );
    expect(
      await opener.open(
        '/project/image.png',
        isCancelled: () => cancelled,
        downloadRemote: (_) async {
          cancelled = true;
          return '/sample-cache/image.png';
        },
        showLocal: (_) => fail('cancelled preview shown'),
      ),
      isNull,
    );
    expect(
      await opener.open(
        '/project/image.png',
        downloadRemote: (_) async => throw const RemoteMediaCancelled(),
        showLocal: (_) => fail('cancelled preview shown'),
      ),
      isNull,
    );
  });

  test(
    'a pane that moves on while the copy is checked does not show it',
    () async {
      // Cancelled between the download finishing and the copy being found on
      // disk: the pane went to another agent, or the bar's Cancel was pressed.
      var cancelled = false;
      final opener = TerminalLinkOpener(
        launch: (_) async => fail('cancelled preview launched'),
        fileExists: (_) async {
          cancelled = true;
          return true;
        },
      );
      expect(
        await opener.open(
          '/project/image.png',
          isCancelled: () => cancelled,
          downloadRemote: (_) async => '/sample-cache/image.png',
          showLocal: (_) => fail('cancelled preview shown'),
        ),
        isNull,
      );
    },
  );

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
        showLocal: (_) => fail('failed download shown'),
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
