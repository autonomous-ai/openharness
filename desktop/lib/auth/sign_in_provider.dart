/// The account a sign-in goes straight to: the login screen's two buttons, the CLI's `--google`
/// and `--apple`, the backend's `provider` (`SIGN_IN_PROVIDERS` in `backend/src/lib/sso.ts`).
///
/// [name] is the wire form in all three places.
enum SignInProvider {
  google('Google'),
  apple('Apple');

  const SignInProvider(this.label);

  /// How the provider is written for a person.
  final String label;
}
