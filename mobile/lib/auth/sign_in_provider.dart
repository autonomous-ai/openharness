/// The account a sign-in goes straight to: the welcome screen's two buttons, the backend's
/// `provider` (`SIGN_IN_PROVIDERS` in `backend/src/lib/sso.ts`) — the desktop's
/// `auth/sign_in_provider.dart`, the same two in the same order.
///
/// [name] is the wire form.
enum SignInProvider {
  google('Google'),
  apple('Apple');

  const SignInProvider(this.label);

  /// How the provider is written for a person.
  final String label;
}
