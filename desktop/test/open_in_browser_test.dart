import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/open_in_browser.dart';

void main() {
  test('only an http(s) page with a host is handed to a browser', () async {
    final opened = <Uri>[];
    final previous = browserOpener;
    browserOpener = (url) async {
      opened.add(url);
      return true;
    };
    addTearDown(() => browserOpener = previous);

    expect(
      await openInBrowser(Uri.parse('http://127.0.0.1:4179/?file=a')),
      isTrue,
    );
    expect(await openInBrowser(Uri.parse('https://excalidraw.com')), isTrue);
    for (final refused in [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ms-settings:privacy',
      'http:///no-host',
    ]) {
      expect(await openInBrowser(Uri.parse(refused)), isFalse, reason: refused);
    }
    expect(opened.map((u) => u.toString()), [
      'http://127.0.0.1:4179/?file=a',
      'https://excalidraw.com',
    ]);
  });
}
