import 'package:flutter/widgets.dart';

import '../../finder/widgets/finder_pane_panel.dart' deferred as finder;
import '../../widgets/agent_drag.dart' show PaneDragHandle;
import 'deferred_part.dart';

/// The Finder and its editor, with every language's colours (re_highlight,
/// about 2 MB): a browser cannot open a Finder yet (`canOpenFinderOn`), so
/// they stay out of `main.dart.js` until a Finder tile is drawn.
final finderPart = DeferredPart(finder.loadLibrary);

/// The browser's stand-in for `finder/widgets/finder_pane_panel.dart`, picked
/// by the pane grid's conditional import: the same tile, once [finderPart] is
/// in. It takes what the grid hands a Finder tile.
class FinderPanePanel extends StatelessWidget {
  const FinderPanePanel({
    super.key,
    required this.root,
    this.onGuardClose,
    this.compactHeader = false,
    this.onFixedWidth,
    this.paneDrag,
  });

  final String root;
  final void Function(Future<bool> Function()? guard)? onGuardClose;
  final bool compactHeader;
  final ValueChanged<double?>? onFixedWidth;
  final PaneDragHandle? paneDrag;

  @override
  Widget build(BuildContext context) => DeferredPartView(
    part: finderPart,
    builder: (_) => finder.FinderPanePanel(
      root: root,
      onGuardClose: onGuardClose,
      compactHeader: compactHeader,
      onFixedWidth: onFixedWidth,
      paneDrag: paneDrag,
    ),
  );
}
