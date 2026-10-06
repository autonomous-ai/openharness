import 'browser_terminal_p2p_link.dart';
import 'terminal_p2p_plugin.dart';

/// The browser's one set of P2P terminal plugins, the phone's
/// `phoneTerminalP2p` on the browser's own WebRTC: each relay connection to a
/// machine gets a data channel beside it, and terminal traffic takes whichever
/// wire is up.
final webTerminalP2p = TerminalP2pPlugins(
  links: const BrowserTerminalP2pLinkFactory(),
);
