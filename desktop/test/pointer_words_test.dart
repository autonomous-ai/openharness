// What a person does to a control, in words: Click with a mouse, Tap on a
// phone or tablet's browser. Desktop runs on macOS, Linux and Windows only,
// so its wording never changes (audit finding S8).
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/widgets/pointer_words.dart';

void main() {
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('a phone or tablet taps; a computer clicks', () {
    for (final touch in [TargetPlatform.iOS, TargetPlatform.android]) {
      expect(clickWord(platform: touch), 'Tap', reason: '$touch');
      expect(clickWord(platform: touch, capital: false), 'tap');
    }
    for (final computer in [
      TargetPlatform.macOS,
      TargetPlatform.linux,
      TargetPlatform.windows,
    ]) {
      expect(clickWord(platform: computer), 'Click', reason: '$computer');
      expect(clickWord(platform: computer, capital: false), 'click');
    }
  });
}
