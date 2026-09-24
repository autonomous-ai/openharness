import '../auth/auth_session.dart';
import '../core/config.dart';
import '../ws/relay_codec.dart';
import '../ws/terminal_transport_plugin.dart';
import 'direct_auth.dart';
import 'direct_auth_api.dart';
import 'direct_link.dart';
import 'direct_login.dart';
import 'email_code_login.dart';
import 'e2ee_relay_codec.dart';
import 'viewer_key_store.dart';

/// The second wire a viewer build offers its relay connections — the phone's WebRTC
/// data channel to the machine. Set once, from that app's `main()` through
/// `startHarness`, before the first frame; a mutable global because its one
/// writer runs before any widget tree exists to carry it. Null — the desktop, or
/// a viewer without one — leaves every terminal frame on the relay socket.
TerminalTransportPluginFactory? harnessTransportPlugins;

/// Everything a viewer build uses in place of the harness CLI, built once and handed to
/// `AppNotifier`: the SSO session, signing in, the machines this device has linked and the E2EE
/// sessions to them. A desktop build has none — and where it is null, nothing in the app behaves
/// any differently than it did before viewers existed.
class ViewerServices {
  const ViewerServices._({
    required this.keys,
    required this.auth,
    required this.login,
    required this.emailLogin,
    required this.links,
    required this.relayCodecs,
    required this.transportPlugins,
  });

  factory ViewerServices({
    required AppConfig config,
    required AuthSession session,
    ViewerKeyStore? keys,
    TerminalTransportPluginFactory? transportPlugins,
  }) {
    final store = keys ?? ViewerKeyStore();
    final auth = DirectAuth(
      session: session,
      api: DirectAuthApi(config: config),
    );
    return ViewerServices._(
      keys: store,
      auth: auth,
      login: DirectLogin(auth: auth),
      emailLogin: EmailCodeLogin(auth: auth),
      links: DirectLink(keys: store, auth: auth, config: config),
      relayCodecs: viewerRelayCodecs(store),
      transportPlugins: transportPlugins ?? harnessTransportPlugins,
    );
  }

  final ViewerKeyStore keys;
  final DirectAuth auth;
  final DirectLogin login;

  /// How a phone signs in — an emailed code, never the browser. See `email_code_api.dart`.
  final EmailCodeLogin emailLogin;
  final DirectLink links;
  final RelayCodecFactory relayCodecs;
  final TerminalTransportPluginFactory? transportPlugins;
}
