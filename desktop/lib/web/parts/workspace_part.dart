import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../state/app_state.dart';
import '../shell/web_workspace.dart' deferred as workspace;
import 'deferred_part.dart';

/// The signed-in workspace, most of the app (about 4.4 of 10.9 MB of
/// script): a first visit's sign-in page draws without it, and it is
/// downloaded once that first frame is up ([WorkspacePrefetch]).
final workspacePart = DeferredPart(workspace.loadLibrary);

/// The browser's workspace once [workspacePart] is in.
class DeferredWorkspace extends StatelessWidget {
  const DeferredWorkspace({super.key, required this.app});

  final AppNotifier app;

  @override
  Widget build(BuildContext context) => DeferredPartView(
    part: workspacePart,
    builder: (_) => workspace.WebWorkspace(app: app),
  );
}

/// Starts downloading [part] after the first frame is drawn: early enough
/// that a signed-in boot rarely waits for it, late enough that a first
/// visit's sign-in page does not share the network with it.
class WorkspacePrefetch extends StatefulWidget {
  WorkspacePrefetch({super.key, DeferredPart? part, required this.child})
    : part = part ?? workspacePart;

  final DeferredPart part;
  final Widget child;

  @override
  State<WorkspacePrefetch> createState() => _WorkspacePrefetchState();
}

class _WorkspacePrefetchState extends State<WorkspacePrefetch> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // Nothing waits on it yet: a failure here is asked again by the
      // workspace when it is drawn, which shows it with Retry.
      unawaited(widget.part.load().then((_) {}, onError: (Object _) {}));
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
