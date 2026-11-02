import 'package:flutter/widgets.dart';

/// Builds with the height left on screen above an on-screen keyboard. Reads the
/// view itself: a Scaffold hands its body a MediaQuery with the keyboard's inset
/// taken out and its size whole, so the body never sees it there.
class ViewRoom extends StatefulWidget {
  const ViewRoom({super.key, required this.builder});

  final Widget Function(BuildContext context, double room) builder;

  @override
  State<ViewRoom> createState() => _ViewRoomState();
}

class _ViewRoomState extends State<ViewRoom> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeMetrics() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final view = View.of(context);
    return widget.builder(
      context,
      (view.physicalSize.height - view.viewInsets.bottom) /
          view.devicePixelRatio,
    );
  }
}
