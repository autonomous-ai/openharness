/// Hands out a usable SSO access token — refreshing first when it is stale, when [force]d, or when
/// the caller just had [failedToken] refused. Only a viewer build holds one; everywhere else the
/// harness CLI does, and signs the requests itself.
abstract interface class AccessTokenSource {
  Future<String> accessToken({bool force = false, String? failedToken});
}

/// Distinguishes an expired session from a temporary failure to renew it.
abstract interface class AccessTokenFailure implements Exception {
  bool get signedOut;
}

/// A token source that says which sign-in its tokens belong to: the number
/// moves whenever someone signs in or out on this device, so a request can
/// tell that a retry would go out as somebody else.
abstract interface class SignInRevision {
  int get signInRevision;
}

/// A request's sign-in ended before it could be retried: it is not sent
/// again, as anybody.
class SignInChanged implements Exception {
  const SignInChanged();
  @override
  String toString() => 'The sign-in changed. Try again.';
}
