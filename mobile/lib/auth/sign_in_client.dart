import 'cli_login.dart';

/// Whether the app is signed in, and signing it out — the seam the notifier reads the session
/// through.
///
/// The phone holds its own session (`viewer/direct_login.dart`); a desktop build asks the local
/// harness CLI instead, which holds it there. How a phone signs IN is not here: an emailed code or
/// a scanned one (`viewer/email_code_login.dart`), or a Google or Apple account through the SSO
/// page (`viewer/direct_login.dart` `login`).
abstract interface class SignInClient {
  Future<CliAuthStatus> checkStatus();

  Future<void> logout();
}
