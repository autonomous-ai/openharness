import '../auth/auth_session.dart';
import 'direct_auth.dart';
import 'email_code_api.dart';

/// A phone's sign-in: an emailed code, typed into the app — see [EmailCodeApi] for why a phone
/// does not go through the browser.
///
/// Two steps the login screen drives in turn, each throwing a `DirectAuthException` whose message
/// is fit to show. The session lands in the same [DirectAuth] the SSO flow fills, marked as an
/// emailed-code session so it is renewed where it was issued.
class EmailCodeLogin {
  EmailCodeLogin({required this.auth});

  final DirectAuth auth;

  EmailCodeApi get _api => auth.emailCodes;

  Future<void> sendCode(String email) => _api.sendCode(email);

  Future<void> signIn({required String email, required String code}) async {
    final tokens = await _api.signIn(email: email, code: code);
    await auth.signIn(tokens, issuer: SessionIssuer.emailCode);
  }
}
