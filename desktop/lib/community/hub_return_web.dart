import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

import 'hub_return.dart';

/// Mounted only after the existing app has authenticated this browser.
class HubReturn extends StatefulWidget {
  const HubReturn({super.key, required this.child});
  final Widget child;
  @override
  State<HubReturn> createState() => _HubReturnState();
}

class _HubReturnState extends State<HubReturn> {
  @override
  void initState() {
    super.initState();
    const key = 'harness.hub.returnTo';
    final path = hubReturnPath(web.window.sessionStorage.getItem(key));
    web.window.sessionStorage.removeItem(key);
    if (path != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) web.window.location.replace(path);
      });
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
