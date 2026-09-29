import 'dart:async';

import '../auth/cli_login.dart' show SignInQr;
import '../e2ee/pair_code.dart';
import 'connect_code.dart';
import 'direct_auth_api.dart';

/// What a browser's sign-in by phone came to: the session, and the approving phone's trust group,
/// sealed under the pairing code that was in the QR — which never left this browser except by the
/// phone's camera, so only this browser opens it.
class QrSignInResult {
  const QrSignInResult({
    required this.tokens,
    required this.code,
    required this.userCode,
    this.sealedRoster,
  });

  final IssuedTokens tokens;
  final String code;
  final String userCode;
  final String? sealedRoster;
}

/// A web desktop's sign-in by phone — the browser's counterpart of `harness login --qr`:
///
/// 1. ask the backend for a sign-in request (`kind: viewer`, this browser's name and E2EE
///    fingerprint), and mint the one-time pairing code;
/// 2. show both in a QR (`…/pair#s=…&c=…&f=…&n=…&k=v`), redrawn with a fresh request before the
///    old one expires;
/// 3. poll until a phone approves it (or says "Not me").
///
/// Signing in is the caller's; joining the phone's group after it is `AppNotifier`'s.
class WebQrSignIn {
  WebQrSignIn({
    required this.api,
    required this.fingerprint,
    required this.pub,
    required this.label,
    this.linkBase,
    String Function()? mintCode,
    Future<void> Function(Duration)? sleep,
  }) : _mint = mintCode ?? newPhonePairCode,
       _sleep = sleep ?? ((d) => Future<void>.delayed(d));

  final DirectAuthApi api;

  /// This browser's E2EE identity fingerprint, as `fingerprint()` spells it.
  final String fingerprint;

  /// The same key, whole (base64): the phone checks it against the QR's fingerprint and takes it
  /// into its trust group.
  final String pub;
  final String label;

  /// Where the QR's link lands: this build's own origin, so a phone's camera opens a build that
  /// can approve it. Null: the production site.
  final Uri? linkBase;
  final String Function() _mint;
  final Future<void> Function(Duration) _sleep;

  static const poll = Duration(seconds: 2);

  /// A QR is replaced this long before its request would expire, so a phone never reads a dead one.
  static const _margin = Duration(seconds: 10);

  Future<QrSignInResult> run({
    required void Function(SignInQr qr) onQr,
    required bool Function() current,
  }) async {
    final plain = fingerprint.toUpperCase().replaceAll(RegExp('[^0-9A-Z]'), '');
    while (true) {
      if (!current()) throw _cancelled;
      final code = _mint();
      final request = await api.startSignInRequest(
        label: label,
        fingerprint: plain,
        pub: pub,
      );
      if (!current()) throw _cancelled;
      onQr(
        SignInQr(
          url: ConnectCode.signInLink(
            request.userCode,
            pairCode: code,
            fingerprint: plain,
            hostname: label,
            viewer: true,
            base: linkBase,
          ),
          fingerprint: fingerprint,
          expiresAt: DateTime.now().add(request.expiresIn),
        ),
      );
      final life = request.expiresIn - _margin;
      var waited = Duration.zero;
      while (waited < life) {
        await _sleep(poll);
        waited += poll;
        if (!current()) throw _cancelled;
        SignInRequestAnswer answer;
        try {
          answer = await api.pollSignInRequest(request.deviceCode);
        } catch (_) {
          continue; // A blip: the request is still alive, ask again.
        }
        if (!current()) throw _cancelled;
        switch (answer.status) {
          case SignInRequestStatus.pending:
            continue;
          case SignInRequestStatus.denied:
            throw const DirectAuthException(
              'Declined on your phone. Refresh to show a new code.',
            );
          case SignInRequestStatus.expired:
            waited = life; // A fresh request, and a fresh QR.
          case SignInRequestStatus.approved:
            return QrSignInResult(
              tokens: answer.tokens!,
              code: code,
              userCode: request.userCode,
              sealedRoster: answer.sealedRoster,
            );
        }
      }
    }
  }

  static const _cancelled = DirectAuthException('Sign-in was cancelled.');
}
