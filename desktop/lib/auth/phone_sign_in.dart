/// Signing in by a QR that a signed-in phone scans and approves (backend `routes/qrSignIn.ts`) —
/// beside SSO, for the sign-in clients that can: the CLI's (`harness login --qr`) and a viewer's.
///
/// A client that cannot is simply not one of these, and the login screen offers SSO alone.
abstract interface class PhoneSignInClient {
  /// Shows [onQr] the link to encode (again, whenever its life is extended), waits for a phone to
  /// approve it, then asks [onConfirm] whether to sign in as the account that approved — someone
  /// else's phone may have. Resolves once signed in; throws [PhoneSignInException] otherwise.
  Future<void> loginWithPhone({
    required void Function(String link, int expiresIn) onQr,
    required Future<bool> Function(String email) onConfirm,
  });
}

/// Why a phone sign-in did not finish. [code]: `DENIED` (on the phone), `EXPIRED`, `CANCELLED`
/// (the person here said no, or went back), `BACKEND_ERROR`, `UNAVAILABLE` (a backend without it).
class PhoneSignInException implements Exception {
  const PhoneSignInException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

/// Where a sign-in QR points; the phone's scanner reads exactly this (mobile `SignInCode`).
String phoneSignInLink(String code) => Uri(
  scheme: 'https',
  host: 'harness.autonomous.ai',
  path: '/signin',
  fragment: 'k=${Uri.encodeQueryComponent(code)}',
).toString();
