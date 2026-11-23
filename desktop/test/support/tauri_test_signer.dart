import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';

final _ed25519 = DartEd25519();

/// Signs as Tauri's signer does (minisign, prehashed `ED`) with a key made for
/// the test, so a test can sign bytes it makes itself. tauri_signature_test.dart
/// holds this form to signatures the real tools made.
class TauriTestSigner {
  TauriTestSigner._(this._keyPair, this._keyId, this.publicKey);

  static Future<TauriTestSigner> generate() async {
    final keyPair = await _ed25519.newKeyPair();
    final key = await keyPair.extractPublicKey();
    final random = Random.secure();
    final keyId = [for (var i = 0; i < 8; i++) random.nextInt(256)];
    final keyLine = base64.encode([...'Ed'.codeUnits, ...keyId, ...key.bytes]);
    return TauriTestSigner._(
      keyPair,
      keyId,
      _tauriForm('untrusted comment: minisign public key\n$keyLine\n'),
    );
  }

  final SimpleKeyPair _keyPair;
  final List<int> _keyId;

  /// In Tauri's form, as `plugins.updater.pubkey` holds a key.
  final String publicKey;

  /// A signature of [digest], a file's BLAKE2b-512, in Tauri's form, as a
  /// manifest's `signature` holds one.
  Future<String> sign(List<int> digest, String trustedComment) async {
    final file = (await _ed25519.sign(digest, keyPair: _keyPair)).bytes;
    final global = await _ed25519.sign([
      ...file,
      ...utf8.encode(trustedComment),
    ], keyPair: _keyPair);
    return _tauriForm(
      'untrusted comment: signature from tauri secret key\n'
      '${base64.encode([...'ED'.codeUnits, ..._keyId, ...file])}\n'
      'trusted comment: $trustedComment\n'
      '${base64.encode(global.bytes)}\n',
    );
  }
}

/// Tauri hands minisign's text around base64-encoded, on one line.
String _tauriForm(String minisign) => base64.encode(utf8.encode(minisign));
