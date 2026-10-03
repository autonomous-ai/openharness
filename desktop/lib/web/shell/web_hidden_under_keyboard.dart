import 'package:flutter/widgets.dart';

/// Draws [child] only while no on-screen keyboard is up. Reads the view
/// itself: a Scaffold hands its body a MediaQuery with the keyboard's inset
/// already taken out, so the body never sees it there.
class WebHiddenUnderKeyboard extends StatefulWidget {
  const WebHiddenUnderKeyboard({super.key, required this.child});

  final Widget child;

  @override
  State<WebHiddenUnderKeyboard> createState() => _WebHiddenUnderKeyboardState();
}

class _WebHiddenUnderKeyboardState extends State<WebHiddenUnderKeyboard>
    with WidgetsBindingObserver {
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
  Widget build(BuildContext context) => View.of(context).viewInsets.bottom > 0
      ? const SizedBox.shrink()
      : widget.child;
}
