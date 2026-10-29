import 'package:flutter/widgets.dart';

/// A part of the screen kept built but out of sight: Harness under Swarm Home, and Swarm Home
/// under Harness (`SwarmHomeRoot`). Kept so the person comes back to it as they left it, it should
/// cost nothing meanwhile — what is under it stops listening to the app while [hidden], and catches
/// up once shown ([ListenWhileInSight]).
///
/// ⚠️ **Not `TickerMode`, though that also goes off out of sight.** `TickerMode` is off as well for
/// a page covered by another one and for the pages the agent pager keeps beside the one on screen,
/// and those still act on what the app tells them (a question raising the keyboard, a machine just
/// unlocked opening its new-agent form). This is off only where nothing can be seen or done.
class OutOfSight extends InheritedWidget {
  const OutOfSight({super.key, required this.hidden, required super.child});

  final bool hidden;

  /// Whether [context] is out of sight; in sight with no [OutOfSight] above it.
  static bool of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<OutOfSight>()?.hidden ?? false;

  @override
  bool updateShouldNotify(OutOfSight oldWidget) => hidden != oldWidget.hidden;
}

/// A [ListenableBuilder] that stops while [OutOfSight]: it neither listens to [listenable] nor
/// builds, and what is under it stays as it was last drawn. Shown again, it builds once, with what
/// is there now, and listens again.
class ListenWhileInSight extends StatefulWidget {
  const ListenWhileInSight({
    super.key,
    required this.listenable,
    required this.builder,
  });

  final Listenable listenable;
  final WidgetBuilder builder;

  @override
  State<ListenWhileInSight> createState() => _ListenWhileInSightState();
}

class _ListenWhileInSightState extends State<ListenWhileInSight> {
  bool _hidden = false;
  bool _listening = false;

  /// What was built last. Handed back unchanged while out of sight, so the framework leaves
  /// everything under it alone — a rebuild from above included.
  Widget? _drawn;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _hidden = OutOfSight.of(context);
    _listen(!_hidden);
  }

  @override
  void didUpdateWidget(ListenWhileInSight oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (identical(oldWidget.listenable, widget.listenable)) return;
    if (_listening) oldWidget.listenable.removeListener(_changed);
    _listening = false;
    _listen(!_hidden);
  }

  @override
  void dispose() {
    _listen(false);
    super.dispose();
  }

  void _listen(bool on) {
    if (on == _listening) return;
    _listening = on;
    if (on) {
      widget.listenable.addListener(_changed);
    } else {
      widget.listenable.removeListener(_changed);
    }
  }

  void _changed() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final drawn = _drawn;
    if (_hidden && drawn != null) return drawn;
    return _drawn = widget.builder(context);
  }
}
