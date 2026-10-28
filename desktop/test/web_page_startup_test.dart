// The web page's own startup (web/index.html, web/flutter_bootstrap.js). The
// loader waits for the main.dart.js preload; these keep the guards that stop it
// waiting forever, which no browser test sees until a returning visit stays on
// the loading screen.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  final page = File('web/index.html').readAsStringSync();
  final bootstrap = File('web/flutter_bootstrap.js').readAsStringSync();
  final preload = RegExp(
    r'<link rel="preload" href="main\.dart\.js"[^>]*>',
  ).firstMatch(page)?[0];

  test('the page preloads main.dart.js under the id the loader reads', () {
    expect(preload, isNotNull);
    expect(preload, contains('as="script"'));
    expect(preload, contains('id="harness-main-preload"'));
    expect(bootstrap, contains("getElementById('harness-main-preload')"));
  });

  test('the preload marks itself done, so a finish nobody heard still counts', () {
    // From the cache it can finish before flutter_bootstrap.js is parsed.
    expect(preload, contains('''onload="this.dataset.done = 'loaded'"'''));
    expect(preload, contains('''onerror="this.dataset.done = 'failed'"'''));
    expect(bootstrap, contains('link.dataset.done'));
  });

  test('the preload is in the head, ahead of every script', () {
    final at = page.indexOf(preload!);
    expect(at, lessThan(page.indexOf('</head>')));
    expect(at, lessThan(page.indexOf('<script')));
  });

  test('a preload that never reports back holds the loader only so long', () {
    expect(bootstrap, contains('setTimeout(resolve, 30000)'));
    // Chrome fires load without waiting for a preload: the engine would share
    // the line with main.dart.js again.
    expect(bootstrap, isNot(contains("addEventListener('load', resolve")));
  });

  test('the loader call stays the one the website rewrites for each release', () {
    // website/scripts/harness-web-assets.mjs: exactly one call with an object
    // literal, the last statement of the script.
    expect('_flutter.loader.load({'.allMatches(bootstrap), hasLength(1));
    expect(
      bootstrap.trimRight(),
      matches(RegExp(r'_flutter\.loader\.load\(\{[^;]*\}\);$')),
    );
  });
}
