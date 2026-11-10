import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

// The Browser panel loads this page with loadHtmlString, which has no base URL:
// anything it fetched or imported would not load on every native webview.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the html has no external src or href and no import statement', () async {
    final html =
        await rootBundle.loadString('assets/browser/browser_viewer.html');
    final scripts = RegExp(r'<script\b([^>]*)>([\s\S]*?)</script>',
            caseSensitive: false)
        .allMatches(html)
        .toList();
    expect(scripts, hasLength(1));
    // No attributes: a classic inline script, never type="module" or src.
    expect(scripts.single.group(1)!.trim(), isEmpty);
    final markup =
        html.replaceRange(scripts.single.start, scripts.single.end, '');
    expect(RegExp(r'\b(src|href)\s*=', caseSensitive: false).hasMatch(markup),
        isFalse);
    final code = scripts.single.group(2)!;
    expect(code.length, greaterThan(100000), reason: 'noVNC is inlined');
    expect(
        RegExp(r'''(^|[^.\w$])import\s*[\s{*('"]|import\.meta''')
            .hasMatch(code),
        isFalse);
  });
}
