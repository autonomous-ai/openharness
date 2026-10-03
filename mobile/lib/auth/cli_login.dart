/// Whether the app is signed in, as [SignInClient.checkStatus] answers it — the shape the harness
/// CLI's `auth status --json` gives a desktop build, kept by the phone for its own session.
class CliAuthStatus {
  final bool loggedIn;

  const CliAuthStatus({required this.loggedIn});
}
