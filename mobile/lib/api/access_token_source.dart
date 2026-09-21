/// Hands out a usable SSO access token — refreshing first when it is stale, when [force]d, or when
/// the caller just had [failedToken] refused. Only a viewer build holds one; everywhere else the
/// harness CLI does, and signs the requests itself.
abstract interface class AccessTokenSource {
  Future<String> accessToken({bool force = false, String? failedToken});
}
