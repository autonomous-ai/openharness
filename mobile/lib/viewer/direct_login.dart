import '../auth/cli_login.dart';
import '../auth/sign_in_client.dart';
import 'direct_auth.dart';

/// Whether this app is signed in, and signing it out, with no harness CLI to ask — the session is
/// the app's own ([DirectAuth]).
///
/// There is no browser sign-in here. The desktop's is cli.ts `loginCommand` — a loopback listener
/// for the SSO redirect — and a phone that hands the person to Safari is suspended along with that
/// listener. A phone signs in with a code instead (`email_code_login.dart`).
class DirectLogin implements SignInClient {
  DirectLogin({required this.auth});

  final DirectAuth auth;

  @override
  Future<CliAuthStatus> checkStatus() async =>
      CliAuthStatus(loggedIn: await auth.hasSession());

  @override
  Future<void> logout() => auth.signOut();
}
