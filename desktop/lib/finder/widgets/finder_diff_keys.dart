import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// F7 and ⇧F7, Orca's next and previous change, while the diff has focus.
class FinderDiffKeys extends StatelessWidget {
  const FinderDiffKeys({
    super.key,
    required this.onPrevious,
    required this.onNext,
    required this.child,
  });

  final VoidCallback onPrevious, onNext;
  final Widget child;

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {
      const SingleActivator(LogicalKeyboardKey.f7): onNext,
      const SingleActivator(LogicalKeyboardKey.f7, shift: true): onPrevious,
    },
    child: Focus(child: child),
  );
}
