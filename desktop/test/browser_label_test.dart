import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/browser_label.dart';

void main() {
  test('names the browser and its OS', () {
    expect(
      browserLabelFrom(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      ),
      'Chrome on macOS',
    );
    expect(
      browserLabelFrom(
        'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0',
      ),
      'Edge on Windows',
    );
    expect(
      browserLabelFrom(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
      ),
      'Safari on macOS',
    );
    expect(
      browserLabelFrom(
        'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
      ),
      'Firefox on Linux',
    );
    expect(
      browserLabelFrom(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
      ),
      'Chrome on Android',
    );
    expect(
      browserLabelFrom(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1',
      ),
      'Chrome on iPhone',
    );
    expect(browserLabelFrom(''), 'Web browser');
  });
}
