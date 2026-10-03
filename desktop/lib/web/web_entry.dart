import 'package:flutter/widgets.dart';

import '../state/app_state.dart';
import 'shell/web_store_banner.dart';
import 'shell/web_workspace.dart';

/// The signed-in screen of a browser build, chosen over
/// `desktop_workspace.dart` by the conditional import in `main.dart`: the
/// shared workspace, composed for a mouse.
Widget authenticatedWorkspace(AppNotifier app) => WebWorkspace(app: app);

/// What a browser build draws around every screen: on a phone, the bar that
/// sends it to the Harness app in its store.
Widget appFrame(Widget app) => WebStoreFrame(child: app);
