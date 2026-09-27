import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/bytes.dart';
import 'package:harness/e2ee/password_pake.dart';
import 'package:harness/e2ee/scrypt.dart';

void main() {
  test(
    'native and cooperative scrypt match the RFC empty-password vector',
    () async {
      const expected =
          '77d6576238657b203b19ca42c18a0497'
          'f16b4844e3074ae8dfdffa3fede21442'
          'fcd0069ded0948f8326a753a0fc81f17'
          'e8d3e0fb2e0d3628cf35e20c38d18906';
      expect(hexOf(scrypt([], [], n: 16, r: 1, p: 1, dkLen: 64)), expected);
      expect(
        hexOf(await scryptCooperative([], [], n: 16, r: 1, p: 1, dkLen: 64)),
        expected,
      );
    },
  );

  test(
    'machine password stretching matches Node at the production cost',
    () async {
      // Generated independently with node:crypto.scryptSync, N=2^17,r=8,p=1,
      // maxmem=256MiB; salt=SHA256("e2e-remote-password-salt-v1|fixture-machine").
      var ticks = 0;
      final timer = Timer.periodic(
        const Duration(milliseconds: 1),
        (_) => ticks++,
      );
      addTearDown(timer.cancel);
      final stretched = await stretchPassword(
        'browser-fixture-only',
        'fixture-machine',
      );
      timer.cancel();
      expect(
        hexOf(stretched),
        '0bcc55a7792882037a7fd20323b14128a31a44d2c0ddf6d45e44ad2cdb5536b2',
      );
      if (kIsWeb) {
        expect(
          ticks,
          greaterThan(1),
          reason: 'The browser must remain responsive while linking',
        );
      }
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
