// The fixtures in test/fixtures/tauri_signature/ were made on 2026-11-21 by the
// tools Harness signs with, with throwaway keys whose private halves were never
// committed (run in that folder; Ed25519 is deterministic, so the same keys
// give the same files):
//
//   cargo tauri signer generate --ci -p fixture -w test.key  # test_key.pub is test.key.pub
//   cargo tauri signer generate --ci -p fixture -w other.key
//   for i in $(seq 40); do printf 'Harness signature fixture\n'; done > payload.bin
//   sign() { printf 'fixture\n' | minisign -S ${3-} -s <(base64 --decode < "$1") \
//     -m payload.bin -x x.minisig -t "$(printf "$2")" && base64 < x.minisig | tr -d '\n'; }
//   sign test.key 'timestamp:1795200000\tfile:Harness-linux-x64.AppImage\tdesktop-version:1.2.3' > desktop.sig
//   sign test.key 'timestamp:1795200000\tfile:Harness-Device-linux-x64.AppImage\tversion:0.1.12' > device.sig
//   sign other.key 'timestamp:1795200000\tfile:Harness-linux-x64.AppImage\tdesktop-version:1.2.3' > other_key.sig
//   sign test.key 'timestamp:1795200000\tfile:Harness-linux-x64.AppImage\tdesktop-version:1.2.3' -l > legacy.sig
//
// device-0.1.11.json is a signature Harness really made, so the pinned key is
// proven, not assumed: platforms.darwin-aarch64.signature of
// https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json
// and `openssl dgst -blake2b512` of the archive it names,
// https://cdn.autonomous.ai/harness/device/0.1.11/Harness-Device.app.tar.gz
// (11 MB, not committed).

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/update/tauri_signature.dart';
import 'package:path/path.dart' as p;

import 'support/tauri_test_signer.dart';

const _fixtures = 'test/fixtures/tauri_signature';
const _desktopFile = 'Harness-linux-x64.AppImage';
const _desktopVersion = 'desktop-version:1.2.3';

String _fixture(String name) => File('$_fixtures/$name').readAsStringSync();

Matcher refused(SignatureRefusal reason) => throwsA(
  isA<TauriSignatureRefused>().having((e) => e.reason, 'reason', reason),
);

/// The minisign text inside a signature in Tauri's form, as its lines.
List<String> _lines(String signature) =>
    utf8.decode(base64.decode(signature)).split('\n');

/// [lines] back in Tauri's form.
String _encode(List<String> lines) =>
    base64.encode(utf8.encode(lines.join('\n')));

String _hex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

List<int> _unhex(String hex) => [
  for (var i = 0; i < hex.length; i += 2)
    int.parse(hex.substring(i, i + 2), radix: 16),
];

void main() {
  final testKey = _fixture('test_key.pub');
  final desktopSig = _fixture('desktop.sig');
  late List<int> payload;
  late List<int> payloadDigest;

  setUpAll(() async {
    payload = File('$_fixtures/payload.bin').readAsBytesSync();
    payloadDigest = await blake2b512OfBytes(payload);
  });

  /// Checks [signature] as the x64 Desktop 1.2.3 AppImage, payload.bin, signed
  /// with the test key.
  Future<void> desktop(
    String? signature, {
    String fileName = _desktopFile,
    String versionField = _desktopVersion,
    Future<List<int>> Function()? digest,
    String? publicKey,
  }) => checkTauriSignature(
    signature,
    fileName: fileName,
    versionField: versionField,
    digest: digest ?? () async => payloadDigest,
    publicKey: publicKey ?? testKey,
  );

  test('a signature minisign made with a Tauri key passes', () async {
    await expectLater(
      desktop(
        desktopSig,
        digest: () => blake2b512OfFile('$_fixtures/payload.bin'),
      ),
      completes,
    );
  });

  test('one changed byte refuses: file', () async {
    final changed = [...payload];
    changed[100] ^= 1;
    await expectLater(
      desktop(desktopSig, digest: () => blake2b512OfBytes(changed)),
      refused(SignatureRefusal.file),
    );
  });

  test('a Device signature offered for Desktop refuses: comment', () async {
    await expectLater(
      desktop(_fixture('device.sig')),
      refused(SignatureRefusal.comment),
    );
  });

  test('a Desktop signature offered for the Device refuses: comment', () async {
    await expectLater(
      desktop(
        desktopSig,
        fileName: 'Harness-Device-linux-x64.AppImage',
        versionField: 'version:1.2.3',
      ),
      refused(SignatureRefusal.comment),
    );
  });

  test('another version refuses: comment', () async {
    await expectLater(
      desktop(desktopSig, versionField: 'desktop-version:1.2.4'),
      refused(SignatureRefusal.comment),
    );
  });

  // Harness Device's updater trusts a `version:` field, so a Desktop
  // signature carrying one could make a Linux Device install Desktop.
  test('a Desktop signature with a version: field refuses: comment', () async {
    final signer = await TauriTestSigner.generate();
    for (final version in ['version:1.2.3', 'version:0.1.12']) {
      final signature = await signer.sign(
        payloadDigest,
        'file:$_desktopFile\t$_desktopVersion\t$version',
      );
      await expectLater(
        desktop(signature, publicKey: signer.publicKey),
        refused(SignatureRefusal.comment),
        reason: version,
      );
    }
  });

  test('another key refuses: key', () async {
    await expectLater(
      desktop(_fixture('other_key.sig')),
      refused(SignatureRefusal.key),
    );
  });

  test(
    "another key's signature with the pinned key id written in refuses: global",
    () async {
      final keyId = base64.decode(_lines(testKey)[1]).sublist(2, 10);
      final forged = _lines(_fixture('other_key.sig'));
      forged[1] = base64.encode(
        base64.decode(forged[1])..setRange(2, 10, keyId),
      );
      await expectLater(
        desktop(_encode(forged)),
        refused(SignatureRefusal.global),
      );
    },
  );

  test('a broken global signature refuses: global', () async {
    final broken = _lines(desktopSig);
    final global = base64.decode(broken[3]);
    global[0] ^= 1;
    broken[3] = base64.encode(global);
    await expectLater(
      desktop(_encode(broken)),
      refused(SignatureRefusal.global),
    );
  });

  test('an edited trusted comment refuses: global', () async {
    final edited = _lines(desktopSig);
    edited[2] = edited[2].replaceFirst('1.2.3', '1.2.4');
    await expectLater(
      desktop(_encode(edited), versionField: 'desktop-version:1.2.4'),
      refused(SignatureRefusal.global),
    );
  });

  test('the legacy Ed algorithm refuses: malformed', () async {
    await expectLater(
      desktop(_fixture('legacy.sig')),
      refused(SignatureRefusal.malformed),
    );
  });

  test('no signature refuses: missing', () async {
    await expectLater(desktop(null), refused(SignatureRefusal.missing));
    await expectLater(desktop(''), refused(SignatureRefusal.missing));
  });

  test('garbage refuses: malformed and never hashes the file', () async {
    final lines = _lines(desktopSig);
    final garbage = {
      'not base64': 'not base64!',
      'not a signature': base64.encode(utf8.encode('hello')),
      'three lines': _encode(lines.take(3).toList()),
      'five lines': _encode([...lines.take(4), 'trusted comment: more', '']),
      'CRLF line ends': base64.encode(utf8.encode(lines.join('\r\n'))),
      // Genuine but for its padded untrusted comment, so only the cap
      // refuses it.
      'over 4096 characters': _encode([
        'untrusted comment: ${'x' * 3000}',
        ...lines.skip(1),
      ]),
    };
    expect(garbage['over 4096 characters']!.length, greaterThan(4096));
    var hashed = 0;
    for (final MapEntry(key: name, value: signature) in garbage.entries) {
      await expectLater(
        desktop(
          signature,
          digest: () async {
            hashed++;
            return payloadDigest;
          },
        ),
        refused(SignatureRefusal.malformed),
        reason: name,
      );
    }
    expect(hashed, 0);
  });

  test('look-alike fields refuse: comment', () async {
    for (final fileName in [
      'Harness-linux-x64.App',
      'Harness-linux-x64.AppImage.old',
    ]) {
      await expectLater(
        desktop(desktopSig, fileName: fileName),
        refused(SignatureRefusal.comment),
        reason: fileName,
      );
    }
    for (final versionField in [
      'desktop-version:1.2',
      'desktop-version:1.2.30',
      'version:1.2.3',
    ]) {
      await expectLater(
        desktop(desktopSig, versionField: versionField),
        refused(SignatureRefusal.comment),
        reason: versionField,
      );
    }
  });

  test(
    "the pinned key verifies the live Device 0.1.11 archive's signature",
    () async {
      final live =
          jsonDecode(_fixture('device-0.1.11.json')) as Map<String, dynamic>;
      final digest = _unhex(live['blake2b512'] as String);
      await expectLater(
        checkTauriSignature(
          live['signature'] as String,
          fileName: live['file'] as String,
          versionField: 'version:${live['version']}',
          digest: () async => digest,
        ),
        completes,
      );
    },
  );

  test('the pinned key is the one Harness Device trusts', () {
    final conf = jsonDecode(
      File('../device-app/src-tauri/tauri.conf.json').readAsStringSync(),
    );
    expect(tauriUpdatePublicKey, conf['plugins']['updater']['pubkey']);
  });

  test('BLAKE2b-512 of bytes and of a file agree', () async {
    const abc =
        'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1'
        '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923';
    final dir = Directory.systemTemp.createTempSync('tauri-signature-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final small = File(p.join(dir.path, 'abc'))..writeAsStringSync('abc');
    expect(_hex(await blake2b512OfBytes(utf8.encode('abc'))), abc);
    expect(_hex(await blake2b512OfFile(small.path)), abc);

    // Over a megabyte, so the file is read in more than one chunk.
    final bytes = List<int>.generate((1 << 20) + 3, (i) => i * 31 % 251);
    final large = File(p.join(dir.path, 'large'))..writeAsBytesSync(bytes);
    expect(
      _hex(await blake2b512OfFile(large.path)),
      _hex(await blake2b512OfBytes(bytes)),
    );
  });

  test(
    "the test signer's signatures verify, and no other key passes them",
    () async {
      final signer = await TauriTestSigner.generate();
      final signature = await signer.sign(
        payloadDigest,
        'timestamp:1\tfile:$_desktopFile\t$_desktopVersion',
      );
      await expectLater(
        desktop(signature, publicKey: signer.publicKey),
        completes,
      );
      await expectLater(desktop(signature), refused(SignatureRefusal.key));
    },
  );
}
