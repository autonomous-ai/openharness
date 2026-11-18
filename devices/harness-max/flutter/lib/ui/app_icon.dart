// An app's icon as the mockup's APP_ICON (assets/apps), Harness's drawn as its SVG was; an app without one draws
// nothing, as the mockup.
import 'package:flutter/widgets.dart';

import 'tokens.dart';

/// The icon asset for an app id or name ("orca", "VS Code"), null when the mockup has none.
String? appIconAsset(String app) {
  final k = app.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
  return switch (k) {
    'orca' => 'assets/apps/orca.png',
    'herdr' => 'assets/apps/herdr.png',
    'vscode' || 'visualstudiocode' || 'code' => 'assets/apps/visual-studio-code.png',
    'cursor' => 'assets/apps/cursor.png',
    'claude' || 'claudedesktop' => 'assets/apps/claude.png',
    'chatgpt' || 'codex' => 'assets/apps/chatgpt.png',
    'terminal' => 'assets/apps/terminal.png',
    _ => null,
  };
}

bool hasAppIcon(String app) => isHarness(app) || appIconAsset(app) != null;
bool isHarness(String app) => app.toLowerCase() == 'harness';

class AppIcon extends StatelessWidget {
  const AppIcon(this.app, {super.key, required this.size, this.radius});
  final String app;
  final double size;

  /// The corner, as a share of the size (the mockup's icons are their own rounded squares; Harness's rx is 14/60).
  final double? radius;

  @override
  Widget build(BuildContext context) {
    if (isHarness(app)) {
      return Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
            color: const Color(0xFFD97757), borderRadius: BorderRadius.circular(size * (radius ?? 14 / 60))),
        child: Text('H',
            style: Face.s(size * 28 / 60, weight: FontWeight.w700, color: const Color(0xFFFFFFFF), height: 1)),
      );
    }
    final asset = appIconAsset(app);
    if (asset == null) return SizedBox(width: size, height: size);
    final img = Image.asset(asset, width: size, height: size, filterQuality: FilterQuality.medium);
    return radius == null ? img : ClipRRect(borderRadius: BorderRadius.circular(size * radius!), child: img);
  }
}
