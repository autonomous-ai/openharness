import 'terminal_p2p_plugin.dart';
import 'webrtc_terminal_p2p_link.dart';

/// The phone's one set of P2P terminal plugins — handed to `startHarness` by
/// `main()` and reached again by the shell when the app returns to the foreground.
final phoneTerminalP2p = TerminalP2pPlugins(
  links: const WebRtcTerminalP2pLinkFactory(),
);
