/// The credential of the daemon's Windows pipe, the app's half (CLI `lib/windows/pipeAuth.ts`;
/// `docs/superpowers/specs/2026-10-16-windows-native-cli-design.md` §2).
///
/// Reaching `\\.\pipe\harness-<id>` proves nothing on Windows: the pipe's default DACL lets every
/// account open it, and once the daemon is gone any account can create a pipe of that name. So
/// each request proves the daemon's token and each answer proves it back. The app sends
/// `<nonce>.<HMAC-SHA256(token, 0x01‖nonce)>` and takes an answer only when its proof is
/// HMAC-SHA256(token, 0x00‖nonce). The token never travels. The nonce starts with the pipe's id,
/// so an auth that a squatter took on a dead daemon's name opens nothing at the next daemon.
///
/// Both halves are held to the CLI's `src/lib/windows/__fixtures__/pipe-auth-vectors.json`.
library;

import 'dart:convert';
import 'dart:typed_data';

import '../e2ee/primitives.dart' show hmacSha256;

/// The request header that carries the auth. Lower case, as Node reads it.
const pipeAuthHeader = 'x-harness-auth';

/// The answer header that carries the daemon's proof.
const pipeProofHeader = 'x-harness-proof';

final _pipeId = RegExp(r'^[0-9a-f]{32}$');
final _hex64 = RegExp(r'^[0-9a-f]{64}$');

String _hex(List<int> bytes) =>
    [for (final b in bytes) b.toRadixString(16).padLeft(2, '0')].join();

String _mac(Uint8List token, int separator, String nonce) =>
    _hex(hmacSha256(token, [separator, ...utf8.encode(nonce)]));

/// What `x-harness-auth` carries for one request to the pipe whose id is
/// [pipeId]: `<nonce>.<mac>`, where the nonce is [pipeId] and then
/// [nonceTail] (16 fresh random bytes) in hex.
String pipeAuthHeaderValue(
  Uint8List token,
  String pipeId,
  Uint8List nonceTail,
) {
  if (!_pipeId.hasMatch(pipeId)) {
    throw ArgumentError.value(pipeId, 'pipeId', 'is not a Harness pipe id');
  }
  if (nonceTail.length != 16) {
    throw ArgumentError.value(
      nonceTail.length,
      'nonceTail',
      'must be 16 bytes',
    );
  }
  final nonce = '$pipeId${_hex(nonceTail)}';
  return '$nonce.${_mac(token, 0x01, nonce)}';
}

/// The nonce an auth value made by [pipeAuthHeaderValue] starts with.
String pipeNonceOf(String authValue) => authValue.substring(0, 64);

/// Whether [proof] is the daemon's answer for [token] and [nonce]: 64
/// lower-case hex digits, compared in constant time.
bool pipeProofMatches(Uint8List token, String nonce, String proof) {
  if (!_hex64.hasMatch(nonce) || !_hex64.hasMatch(proof)) return false;
  final expected = _mac(token, 0x00, nonce);
  var difference = 0;
  for (var i = 0; i < expected.length; i++) {
    difference |= expected.codeUnitAt(i) ^ proof.codeUnitAt(i);
  }
  return difference == 0;
}
