import 'cli_login.dart';
import 'sign_in_provider.dart';

/// Whether the app is signed in, and how it signs in — the seam between the two kinds of build.
///
/// [CliLogin] asks the local harness CLI, which holds the session. A viewer build has no CLI and
/// holds its own (`viewer/direct_login.dart`).
abstract interface class SignInClient {
  Future<CliAuthStatus> checkStatus();

  /// Resolves once signed in; throws on failure or [cancel]. [onAuthorizeUrl] gets the SSO page,
  /// which opens on [provider]'s own sign-in — or, without one, on the page's chooser.
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
    SignInProvider? provider,
  });

  void cancel();

  Future<void> logout();
}
