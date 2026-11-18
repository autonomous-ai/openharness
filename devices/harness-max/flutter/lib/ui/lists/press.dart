// A card a finger holds sinks a little, as the mockup's `:active{transform:scale(.98)}`.
import 'package:flutter/widgets.dart';

class Press extends StatefulWidget {
  const Press({super.key, required this.onTap, required this.child});
  final VoidCallback onTap;
  final Widget child;

  @override
  State<Press> createState() => _PressState();
}

class _PressState extends State<Press> {
  bool _held = false;

  void _hold(bool held) {
    if (_held != held) setState(() => _held = held);
  }

  @override
  Widget build(BuildContext context) => GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => _hold(true),
        onTapUp: (_) => _hold(false),
        onTapCancel: () => _hold(false),
        onTap: widget.onTap,
        // No transition on :active in the mockup: the card sinks and rises at once.
        child: Transform.scale(scale: _held ? 0.98 : 1, child: widget.child),
      );
}
