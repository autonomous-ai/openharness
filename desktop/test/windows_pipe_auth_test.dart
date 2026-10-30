import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/ws/windows_pipe_auth.dart';

Uint8List _bytes(String hex) => Uint8List.fromList([
  for (var i = 0; i < hex.length; i += 2)
    int.parse(hex.substring(i, i + 2), radix: 16),
]);

/// The CLI's own vectors, made by its pipeAuth.ts (`cli/scripts/gen-pipe-auth-vectors.ts`)
/// and checked there by pipeAuth.spec.ts. Read from `../cli`, never copied, so the two
/// halves of the credential cannot drift. `flutter test` runs in `desktop/`; PR CI's
/// desktop checkout includes `/cli/`.
List<Map<String, dynamic>> _vectors() {
  final file = File(
    '../cli/src/lib/windows/__fixtures__/pipe-auth-vectors.json',
  );
  final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  return [for (final v in json['vectors'] as List) v as Map<String, dynamic>];
}

void main() {
  final vectors = _vectors();

  test('names its headers in lower case, as the daemon reads them', () {
    expect(
      [pipeAuthHeader, pipeProofHeader],
      ['x-harness-auth', 'x-harness-proof'],
    );
  });

  test('has the shared vectors to check', () {
    expect(vectors.length, greaterThanOrEqualTo(3));
  });

  for (final v in vectors) {
    test(
      'vector ${v['pipeId']}: the auth the daemon expects, and its proof taken',
      () {
        final token = _bytes(v['token'] as String);
        final auth = pipeAuthHeaderValue(
          token,
          v['pipeId'] as String,
          _bytes(v['nonceTail'] as String),
        );
        expect(auth, v['auth']);
        expect(pipeNonceOf(auth), v['nonce']);
        expect(
          pipeProofMatches(token, v['nonce'] as String, v['proof'] as String),
          isTrue,
        );
      },
    );
  }

  test('refuses a proof that is not the token\'s answer for this nonce', () {
    final v = vectors.first;
    final token = _bytes(v['token'] as String);
    final nonce = v['nonce'] as String;
    final proof = v['proof'] as String;
    final other = vectors[1];
    for (final wrong in [
      '',
      'zz',
      proof.toUpperCase(),
      '$proof ',
      proof.substring(1),
      // The auth's own MAC: what the app sends never passes as what the daemon answers.
      (v['auth'] as String).split('.').last,
      // Another token's answer, and this token's answer for another nonce.
      other['proof'] as String,
    ]) {
      expect(pipeProofMatches(token, nonce, wrong), isFalse, reason: wrong);
    }
    expect(
      pipeProofMatches(_bytes(other['token'] as String), nonce, proof),
      isFalse,
    );
    expect(pipeProofMatches(token, other['nonce'] as String, proof), isFalse);
    expect(pipeProofMatches(token, nonce.substring(2), proof), isFalse);
  });

  test('makes an auth only for a whole pipe id and a 16-byte tail', () {
    final token = Uint8List(32);
    for (final id in ['', 'a' * 31, 'a' * 33, 'A' * 32, '${'a' * 31}g']) {
      expect(
        () => pipeAuthHeaderValue(token, id, Uint8List(16)),
        throwsArgumentError,
        reason: id,
      );
    }
    for (final length in [0, 15, 17, 32]) {
      expect(
        () => pipeAuthHeaderValue(token, 'a' * 32, Uint8List(length)),
        throwsArgumentError,
      );
    }
  });
}
