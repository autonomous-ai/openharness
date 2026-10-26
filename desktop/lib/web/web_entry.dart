import 'package:flutter/widgets.dart';

import '../state/app_state.dart';
import '../community/hub_return_web.dart';
import '../widgets/key_hints.dart';
import '../ws/terminal_transport_plugin.dart';
import 'p2p/p2p_resume_retry.dart';
import 'p2p/web_terminal_p2p.dart';
import 'shell/web_focus_ring.dart';
import 'shell/web_store_banner.dart';
import 'shell/web_workspace.dart';
import 'web_console.dart';

/// The signed-in screen of a browser build, chosen over
/// `desktop_workspace.dart` by the conditional import in `main.dart`: the
/// shared workspace, composed for a mouse.
Widget authenticatedWorkspace(AppNotifier app) => P2pResumeRetry(
  plugins: webTerminalP2p,
  child: HubReturn(child: WebWorkspace(app: app)),
);

/// A released browser build's console carries errors, not traces (see [prepareWebConsole]).
void prepareConsole() => prepareWebConsole();

/// What a browser build draws around every screen: on a phone, the bar that
/// sends it to the Harness app in its store. Above the Navigator, so every
/// screen and route under it shows no key hints: the web is mouse-first.
Widget appFrame(Widget app) => WebFocusRing(
  child: WebStoreFrame(child: KeyHints(visible: false, child: app)),
);

/// A browser reaches a machine through the relay, so each connection gets a
/// WebRTC data channel beside it (`p2p/`); the relay stays the fallback.
final TerminalTransportPluginFactory terminalTransportPlugins =
    webTerminalP2p.create;
