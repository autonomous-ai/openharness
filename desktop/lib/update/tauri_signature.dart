/// Harness's Tauri signatures: a Linux AppImage installs only when the key
/// Harness Device's updater trusts signed that file, for that version.
///
/// The public key is pinned here, in the app, never read from a manifest, so
/// whoever can write the release bucket still cannot sign as Harness. Its twin
/// is `plugins.updater.pubkey` in device-app/src-tauri/tauri.conf.json, the
/// key the Device app pins and whose private half signs both apps' Linux
/// releases; tauri_signature_test.dart holds the two equal, so a new key is a
/// release of both apps.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';
import 'package:flutter/foundation.dart' show listEquals;

import 'update_signature.dart';

/// Harness's Tauri update key (key id 4739BFCC687B1F62), in Tauri's form:
/// base64 of minisign's public key file.
const tauriUpdatePublicKey =
    'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ3MzlCRkNDNjg3QjFGNjIKUldSaUgzdG96TDg1UjdIaUhrOUZJQWF1Q1BMUGVyV0crMmNZZ0ZMWkx1QWp0dS9UbE9IcXAwdjkK';

/// Why a signature was refused, the one thing about it the log names.
enum SignatureRefusal { missing, malformed, key, file, global, comment }

/// The person reads only this; why it failed is for the log.
const notSignedByHarness =
    'it is not signed by Harness, so it may not be genuine. You are still on '
    'your current version.';

class TauriSignatureRefused extends UpdateRefused {
  const TauriSignatureRefused(this.reason) : super(notSignedByHarness);
  final SignatureRefusal reason;
}

/// Tauri's signatures are under 500 characters; refusing longer text before
/// decoding it bounds what hostile manifest text can cost.
const _maxSignatureLength = 4096;

const _blake2b512 = DartBlake2b(hashLengthInBytes: 64);

final _ed25519 = DartEd25519();

/// Refuses unless [signature] (a manifest's `signature`: the `.minisig` text,
/// base64-encoded) was made by [publicKey] over [digest], the BLAKE2b-512 of
/// the file, and its trusted comment names `file:<fileName>` and
/// [versionField] (the whole field, e.g. `desktop-version:1.2.3`) among its
/// tab-separated fields.
///
/// The cheap checks come first, so hostile text never costs a hash: [digest]
/// is called only once the signature and its comment hold. Each refusal has
/// one reason: an edited comment fails `global`, a genuine signature for
/// another file or version fails `comment`, a changed byte fails `file`.
Future<void> checkTauriSignature(
  String? signature, {
  required String fileName,
  required String versionField,
  required Future<List<int>> Function() digest,
  String publicKey = tauriUpdatePublicKey,
}) async {
  if (signature == null || signature.isEmpty) {
    throw const TauriSignatureRefused(SignatureRefusal.missing);
  }
  final signed = _parseSignature(signature);
  final key = _parsePublicKey(publicKey);
  if (!listEquals(signed.keyId, key.sublist(2, 10))) {
    throw const TauriSignatureRefused(SignatureRefusal.key);
  }
  final ed25519 = SimplePublicKey(key.sublist(10), type: KeyPairType.ed25519);
  final global = [
    ...signed.fileSignature,
    ...utf8.encode(signed.trustedComment),
  ];
  if (!await _verifies(global, signed.globalSignature, ed25519)) {
    throw const TauriSignatureRefused(SignatureRefusal.global);
  }
  final fields = signed.trustedComment.split('\t');
  if (!fields.contains('file:$fileName') || !fields.contains(versionField)) {
    throw const TauriSignatureRefused(SignatureRefusal.comment);
  }
  if (!await _verifies(await digest(), signed.fileSignature, ed25519)) {
    throw const TauriSignatureRefused(SignatureRefusal.file);
  }
}

/// The BLAKE2b-512 of [bytes], off the UI isolate: pure Dart and synchronous
/// underneath, as `sha256HexOffUiIsolate`'s hash is.
Future<List<int>> blake2b512OfBytes(List<int> bytes) =>
    Isolate.run(() => _blake2b512.hashSync(bytes).bytes);

/// The BLAKE2b-512 of the file at [path], off the UI isolate, read in chunks
/// so a 100 MB AppImage is never held whole.
Future<List<int>> blake2b512OfFile(String path) => Isolate.run(() async {
  final sink = _blake2b512.newHashSink();
  await File(path).openRead().forEach(sink.add);
  sink.close();
  return sink.hashSync().bytes;
});

typedef _Signature = ({
  List<int> keyId,
  List<int> fileSignature,
  String trustedComment,
  List<int> globalSignature,
});

/// minisign's signature file: an untrusted comment (not signed, so ignored);
/// `ED` (Ed25519 over the file's BLAKE2b-512), the key id and the file
/// signature; `trusted comment: ` and its text; and the global signature over
/// the file signature and that text. A trailing newline is allowed.
_Signature _parseSignature(String signature) {
  const malformed = TauriSignatureRefused(SignatureRefusal.malformed);
  if (signature.length > _maxSignatureLength) throw malformed;
  try {
    var lines = utf8.decode(base64.decode(signature)).split('\n');
    if (lines.length == 5 && lines.last.isEmpty) lines = lines.sublist(0, 4);
    if (lines.length != 4 ||
        !lines[0].startsWith('untrusted comment: ') ||
        !lines[2].startsWith('trusted comment: ')) {
      throw malformed;
    }
    final file = base64.decode(lines[1]);
    final global = base64.decode(lines[3]);
    // The legacy `Ed` signs the file itself, not its hash: Tauri never writes
    // it, so it is refused rather than given a second way to verify.
    if (file.length != 74 ||
        String.fromCharCodes(file, 0, 2) != 'ED' ||
        global.length != 64) {
      throw malformed;
    }
    return (
      keyId: file.sublist(2, 10),
      fileSignature: file.sublist(10),
      trustedComment: lines[2].substring('trusted comment: '.length),
      globalSignature: global,
    );
  } on FormatException {
    throw malformed;
  }
}

/// minisign's public key file: an untrusted comment, then `Ed`, the key id
/// and the 32-byte Ed25519 key.
List<int> _parsePublicKey(String publicKey) {
  final lines = utf8.decode(base64.decode(publicKey)).split('\n');
  final key = lines.length < 2 ? const <int>[] : base64.decode(lines[1]);
  if (key.length != 42 || String.fromCharCodes(key, 0, 2) != 'Ed') {
    throw ArgumentError.value(publicKey, 'publicKey', 'not a minisign key');
  }
  return key;
}

Future<bool> _verifies(
  List<int> message,
  List<int> signature,
  SimplePublicKey key,
) => _ed25519.verify(message, signature: Signature(signature, publicKey: key));
