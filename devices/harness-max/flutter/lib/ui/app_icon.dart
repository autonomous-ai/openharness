// An app's icon as the mockup's APP_ICON (assets/apps); Harness's is its symbol (the owner's, 19 Nov) on the same white
// tile as the light icons beside it, since the symbol is drawn in black. An app without one draws nothing, as the mockup.
import 'package:flutter/widgets.dart';

/// The icon asset for an app id or name ("orca", "VS Code"), null when the mockup has none.
String? appIconAsset(String app) {
  final k = app.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
  return switch (k) {
    'harness' => 'assets/apps/harness.png',
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

bool hasAppIcon(String app) => appIconAsset(app) != null;

class AppIcon extends StatelessWidget {
  const AppIcon(this.app, {super.key, required this.size, this.radius});
  final String app;
  final double size;

  /// The corner, as a share of the size; null for the icons, which are their own rounded squares.
  final double? radius;

  @override
  Widget build(BuildContext context) {
    final asset = appIconAsset(app);
    if (asset == null) return SizedBox(width: size, height: size);
    final img = Image.asset(asset, width: size, height: size, filterQuality: FilterQuality.medium);
    return radius == null ? img : ClipRRect(borderRadius: BorderRadius.circular(size * radius!), child: img);
  }
}
