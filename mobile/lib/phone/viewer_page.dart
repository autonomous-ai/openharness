import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/models.dart';
import '../state/app_state.dart';
import '../surface/interactive_viewer_session.dart';
import '../surface/touch_viewer_surface.dart';

/// A harness's viewer, full screen on the phone: the machine renders the page, the phone shows it
/// and sends touches back. The surface closes when the page does.
class ViewerPage extends StatefulWidget {
  ViewerPage({super.key, required AppNotifier notifier, required String machineId, required Agent agent})
      : title = agent.viewerName ?? 'Viewer',
        request = ((payload) => notifier.viewerSurface(machineId, agent.id, payload));

  /// For tests: any request function.
  const ViewerPage.withRequest({super.key, required this.title, required this.request});

  final String title;
  final ViewerSurfaceRequest request;

  @override
  State<ViewerPage> createState() => _ViewerPageState();
}

class _ViewerPageState extends State<ViewerPage> {
  late final _session = InteractiveViewerSession(widget.request, mobile: true, touch: true);

  @override
  void dispose() {
    _session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.title),
      actions: [
        IconButton(
          icon: const Icon(LucideIcons.rotateCw300),
          tooltip: 'Reload',
          onPressed: _session.reload,
        ),
      ],
    ),
    body: SafeArea(top: false, child: TouchViewerSurface(session: _session)),
  );
}
