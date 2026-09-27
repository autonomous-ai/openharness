import '../auth/auth_session.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';

DirectAuth createViewerAuth({
  required AuthSession session,
  required DirectAuthApi api,
}) => DirectAuth(session: session, api: api);
