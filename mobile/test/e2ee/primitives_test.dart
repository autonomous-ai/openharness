import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/e2ee/bytes.dart';
import 'package:harness_mobile/e2ee/cpace.dart';
import 'package:harness_mobile/e2ee/envelope.dart';
import 'package:harness_mobile/e2ee/password_pake.dart';
import 'package:harness_mobile/e2ee/primitives.dart';
import 'package:harness_mobile/e2ee/replay_window.dart';
import 'package:harness_mobile/e2ee/ristretto.dart';
import 'package:harness_mobile/e2ee/scrypt.dart';
import 'package:harness_mobile/e2ee/terminal_cipher.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';

Uint8List _hex(String hex) => Uint8List.fromList([
  for (var i = 0; i < hex.length; i += 2)
    int.parse(hex.substring(i, i + 2), radix: 16),
]);

/// The building blocks, held to published vectors where there are any — the port is only worth
/// anything byte for byte — and to their refusals where the input is a peer's.
void main() {
  group('scrypt (RFC 7914 §12)', () {
    test('the empty vector', () {
      expect(
        hexOf(scrypt(const [], const [], n: 16, r: 1, p: 1, dkLen: 64)),
        '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede2144'
        '2fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906',
      );
    });

    test('password / NaCl', () {
      expect(
        hexOf(
          scrypt(
            utf8Bytes('password'),
            utf8Bytes('NaCl'),
            n: 1024,
            r: 8,
            p: 16,
            dkLen: 64,
          ),
        ),
        'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162'
        '2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
      );
    });

    test('refuses parameters it cannot run', () {
      for (final (n, r, p) in [
        (0, 1, 1),
        (3, 1, 1),
        (1000, 1, 1),
        (16, 0, 1),
        (16, 1, 0),
      ]) {
        expect(
          () => scrypt(const [1], const [2], n: n, r: r, p: p, dkLen: 16),
          throwsArgumentError,
          reason: 'N=$n r=$r p=$p',
        );
      }
    });
  });

  group('HKDF-SHA256 (RFC 5869 §A)', () {
    test('case 1: salt and info', () {
      expect(
        hexOf(
          hkdfSha256(
            List.filled(22, 0x0b),
            salt: List.generate(13, (i) => i),
            info: List.generate(10, (i) => 0xf0 + i),
            length: 42,
          ),
        ),
        '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
      );
    });

    test('case 3: no salt, no info', () {
      expect(
        hexOf(hkdfSha256(List.filled(22, 0x0b), length: 42)),
        '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
      );
    });
  });

  group('the AEAD', () {
    test('opens what it sealed, and nothing that was changed', () {
      final key = List.filled(32, 1);
      final sealed = aeadSeal(key, 7, utf8Bytes('aad'), utf8Bytes('hello'));
      expect(utf8.decode(aeadOpen(key, 7, utf8Bytes('aad'), sealed)!), 'hello');
      expect(
        aeadOpen(key, 8, utf8Bytes('aad'), sealed),
        isNull,
        reason: 'other counter',
      );
      expect(
        aeadOpen(key, 7, utf8Bytes('AAD'), sealed),
        isNull,
        reason: 'other AAD',
      );
      expect(aeadOpen(List.filled(32, 2), 7, utf8Bytes('aad'), sealed), isNull);
      expect(
        aeadOpen(key, 7, utf8Bytes('aad'), sealed.sublist(0, 15)),
        isNull,
        reason: 'shorter than a tag',
      );
      expect(
        aeadOpen(List.filled(5, 1), 7, utf8Bytes('aad'), sealed),
        isNull,
        reason: 'a key of the wrong size',
      );
    });

    test('the nonce is the counter, big-endian, then four zeros', () {
      expect(
        hexOf(counterNonce(0x0102030405060708)),
        '010203040506070800000000',
      );
    });
  });

  group('bytes', () {
    test('lvCat prefixes every part with its length', () {
      expect(
        hexOf(
          lvCat([
            'ab',
            [1],
          ]),
        ),
        '00000002616200000001'
        '01',
      );
      expect(() => lvCat([3]), throwsArgumentError);
    });

    test('ctEqual compares all of it', () {
      expect(ctEqual([1, 2], [1, 2]), isTrue);
      expect(ctEqual([1, 2], [1, 3]), isFalse);
      expect(ctEqual([1, 2], [1, 2, 3]), isFalse);
    });

    test('random bytes are the length asked for', () {
      expect(secureRandomBytes(0), isEmpty);
      expect(secureRandomBytes(33), hasLength(33));
    });
  });

  group('ristretto255 (RFC 9496 §A)', () {
    const base =
        'e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76';

    test('the small multiples of the generator encode as published', () {
      final b = RistrettoPoint.fromBytes(_hex(base));
      expect(hexOf(b.toBytes()), base);
      expect(
        hexOf(b.add(b).toBytes()),
        '6a493210f7499cd17fecb510ae0cea23a110e8d5b901f8acadd3095c73a3b919',
      );
      expect(
        hexOf(b.multiply(BigInt.from(3)).toBytes()),
        '94741f5d5d52755ece4f23f044ee27d5d1ea1e2bd196b462166b16152a9d0259',
      );
      expect(hexOf(RistrettoPoint.zero.toBytes()), '00' * 32);
      expect(b.equals(b.add(RistrettoPoint.zero)), isTrue);
      expect(b.equals(b.add(b)), isFalse);
    });

    test('a share that is not a canonical point is refused', () {
      for (final bad in [
        '00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
        'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
        '0100000000000000000000000000000000000000000000000000000000000000',
        '01ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
        '26948d35ca62e643e26a83177332e6b6afeb9d08e4268b650f1f5bbd8d81d371',
      ]) {
        expect(
          () => RistrettoPoint.fromBytes(_hex(bad)),
          throwsArgumentError,
          reason: bad,
        );
      }
      expect(
        () => RistrettoPoint.fromBytes(List.filled(31, 0)),
        throwsArgumentError,
      );
    });

    test('the identity as a peer\'s share gives no shared secret', () {
      expect(
        () => cpaceShared(RistrettoPoint.zero.toBytes(), BigInt.from(12345)),
        throwsStateError,
      );
    });

    test(
      'a scalar is never zero, and a broken source of randomness is refused',
      () {
        expect(randScalar(secureRandomBytes), greaterThan(BigInt.zero));
        expect(
          () => randScalar((length) => Uint8List(length)),
          throwsStateError,
        );
      },
    );

    test('expand_message_xmd refuses a tag longer than 255 bytes', () {
      expect(
        () => expandMessageXmd(const [1], List.filled(256, 1), 64),
        throwsArgumentError,
      );
      expect(expandMessageXmd(const [1], const [2], 200), hasLength(200));
    });
  });

  group('the password link\'s generator', () {
    test('is bound to the machine and the attempt', () {
      expect(
        pwContext('m1'),
        'autonomous-e2e-pw-pair|agent:m1|a:adapter|b:machine',
      );
      final stretched = List.filled(32, 3);
      final sid = List.filled(16, 1);
      final g = pwCpaceGenerator(stretched, sid, pwContext('m1'));
      expect(g.equals(RistrettoPoint.zero), isFalse);
      expect(
        g.equals(pwCpaceGenerator(stretched, sid, pwContext('m1'))),
        isTrue,
      );
      expect(
        g.equals(
          pwCpaceGenerator(stretched, List.filled(16, 2), pwContext('m1')),
        ),
        isFalse,
      );
      expect(
        g.equals(pwCpaceGenerator(stretched, sid, pwContext('m2'))),
        isFalse,
      );
    });
  });

  group('the replay window (replayWindow.spec.ts)', () {
    test('takes counters out of order once each, then refuses replays', () {
      final window = ReplayWindow();
      for (final n in [2, 0, 1]) {
        expect(window.allows(n), isTrue);
        window.commit(n);
      }
      expect(window.allows(0), isFalse);
      expect(window.allows(2), isFalse);
    });

    test('refuses counters older than the window', () {
      final window = ReplayWindow()..commit(e2eeReplayWindowSize + 7);
      expect(window.allows(7), isFalse);
      expect(window.allows(8), isTrue);
    });

    test('refuses what JavaScript could not count', () {
      final window = ReplayWindow();
      expect(window.allows(-1), isFalse);
      expect(window.allows(maxSafeInteger), isTrue);
      expect(window.allows(maxSafeInteger + 1), isFalse);
    });

    test(
      'a counter far ahead forgets the old ones rather than walking the gap',
      () {
        final window = ReplayWindow();
        for (var n = 0; n < 10; n++) {
          window.commit(n);
        }
        window.commit(1 << 40);
        expect(window.allows(5), isFalse, reason: 'far behind the window now');
        expect(window.allows((1 << 40) - 1), isTrue);
        expect(window.allows(1 << 40), isFalse);
      },
    );

    test('sliding forward one at a time prunes as it goes', () {
      final window = ReplayWindow();
      for (var n = 0; n < e2eeReplayWindowSize + 50; n++) {
        expect(window.allows(n), isTrue);
        window.commit(n);
      }
      expect(window.allows(49), isFalse);
      expect(window.allows(e2eeReplayWindowSize + 49), isFalse);
    });
  });

  group('the binary terminal frame (HTRM v3)', () {
    final key = deriveTerminalBinaryKey(List.filled(32, 4));
    TerminalBinaryFrame frame({
      TerminalBinaryKind kind = TerminalBinaryKind.output,
      bool compressed = false,
    }) => TerminalBinaryFrame(
      kind: kind,
      streamId: '11111111-1111-4111-8111-111111111111',
      seq: 9,
      bytes: utf8Bytes('hi'),
      compressed: compressed,
    );

    test('round-trips, counter and all', () {
      final sealed = sealTerminalBinary(key, 42, frame())!;
      expect(sealed.sublist(0, 4), utf8Bytes('HTRM'));
      final opened = openTerminalBinary(key, sealed)!;
      expect(opened.counter, 42);
      expect(utf8.decode(opened.frame.bytes), 'hi');
      expect(opened.frame.seq, 9);
    });

    test('will not seal on a counter JavaScript could not count', () {
      expect(sealTerminalBinary(key, -1, frame()), isNull);
      expect(sealTerminalBinary(key, maxSafeInteger + 1, frame()), isNull);
      expect(sealTerminalBinary(key, maxSafeInteger, frame()), isNotNull);
    });

    test('refuses every malformed header', () {
      final sealed = sealTerminalBinary(key, 1, frame())!;
      Uint8List changed(void Function(Uint8List bytes) edit) =>
          Uint8List.fromList(sealed)..let(edit);
      final bad = <String, Uint8List>{
        'too short': Uint8List.sublistView(sealed, 0, 30),
        'magic': changed((b) => b[0] = 0x58),
        'version': changed((b) => b[4] = 2),
        'kind': changed((b) => b[5] = 99),
        'reserved byte': changed((b) => b[7] = 1),
        'length says more': changed(
          (b) => ByteData.sublistView(b).setUint32(16, sealed.length),
        ),
        'length under a tag': changed(
          (b) => ByteData.sublistView(b).setUint32(16, 3),
        ),
        'counter past 2^53': changed(
          (b) => ByteData.sublistView(b).setUint64(8, maxSafeInteger + 1),
        ),
        'counter past 2^63': changed((b) => b[8] = 0x80),
        'one more byte': Uint8List.fromList([...sealed, 0]),
      };
      bad.forEach(
        (why, bytes) =>
            expect(openTerminalBinary(key, bytes), isNull, reason: why),
      );
      expect(
        openTerminalBinary(deriveTerminalBinaryKey(List.filled(32, 5)), sealed),
        isNull,
      );
    });
  });

  group('the frame envelope', () {
    test('only a JSON object is a payload', () {
      expect(jsonObjectOf(utf8Bytes('{"a":1}')), {'a': 1});
      expect(jsonObjectOf(utf8Bytes('[1]')), isNull);
      expect(jsonObjectOf(utf8Bytes('nope')), isNull);
      expect(jsonObjectOf([0xff, 0xfe]), isNull, reason: 'not UTF-8 at all');
    });

    test('an epoch that is not a string is refused', () {
      final key = List.filled(32, 1);
      final wrapped = wrapPayload(key, 'g', 1, 'x', null, {
        'a': 1,
      }, epoch: 'e1');
      final env = Map<String, dynamic>.from(wrapped['__e2e']! as Map);
      expect(unwrapPayload(key, env, 'x', null), {'a': 1});
      expect(unwrapPayload(key, {...env, 'epoch': 1}, 'x', null), isNull);
      expect(
        unwrapPayload(key, {...env, 'k': 'p'}, 'x', null),
        isNull,
        reason: 'the key kind is in the AAD',
      );
      expect(isWrapped(wrapped), isTrue);
      expect(isWrapped({'a': 1}), isFalse);
      expect(isWrapped('x'), isFalse);
    });

    test('strict types are sealed only for a machine that opens them', () {
      expect(sealsDown('terminal_input', strictDown: false), isTrue);
      expect(sealsDown('dsh_install', strictDown: false), isFalse);
      expect(sealsDown('dsh_install', strictDown: true), isTrue);
      expect(sealsDown('machine_select', strictDown: true), isFalse);
    });
  });
}

extension<T> on T {
  void let(void Function(T it) edit) => edit(this);
}
