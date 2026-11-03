import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/web_build_version.dart';

/// The release a page was built as, told apart from the one its host serves
/// now (task #2185, review of #2622): a page an old cache keeps must not take
/// the host's newer version for its own.
void main() {
  test('a build says the version compiled into it, or none', () {
    expect(builtWebVersion(''), isNull);
    expect(builtWebVersion('  '), isNull);
    expect(builtWebVersion(' 1.3.50 \n'), '1.3.50');
  });

  test('the page\'s own version is the built one, not what the host says', () {
    expect(webPageVersion(built: '1.3.50', declared: '1.3.51'), '1.3.50');
  });

  test('a build with none compiled in (flutter run) falls back to what it '
      'read at start-up', () {
    expect(webPageVersion(built: '', declared: '1.3.51'), '1.3.51');
    expect(webPageVersion(built: '', declared: null), isNull);
  });

  test('a page started from an old cache learns the host runs another one, '
      'before the first interval', () async {
    final running = await webRunningVersion(
      built: '1.3.50',
      readHost: () async => '1.3.51',
    );
    expect(running, '1.3.50');
    // Without a compiled-in version the host's answer stands in.
    expect(
      await webRunningVersion(built: '', readHost: () async => '1.3.51'),
      '1.3.51',
    );
  });
}
