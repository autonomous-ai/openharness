import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/phone/computer_version_page.dart';

void main() {
  test(
    'a version reads as its release, without the build pacman names it by',
    () {
      expect(shortVersion('0.1.8.r1792577066.g8df82cc2bc-1'), '0.1.8');
      expect(shortVersion('0.1.7.r1792566394.ga1fceef1bf-1'), '0.1.7');
      expect(shortVersion('0.4.39'), '0.4.39');
      expect(shortVersion('0.1.8.simulated-1'), '0.1.8');
      expect(shortVersion('preview'), 'preview');
      expect(shortVersion(null), isNull);
    },
  );
}
