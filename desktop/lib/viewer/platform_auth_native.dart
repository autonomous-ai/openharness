import '../auth/auth_session.dart';
import '../core/local_hostname.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';

DirectAuth createViewerAuth({
  required AuthSession session,
  required DirectAuthApi api,
}) => DirectAuth(session: session, api: api);

/// A native build holds a Harness session in place of SSO tokens, named for this device
/// ([DirectAuthApi.harnessSessionLabel]).
String? viewerSessionLabel() => localHostnameOrNull() ?? 'Desktop app';
