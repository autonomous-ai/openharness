// Apps (the mockup's renderApps): "APPS" in a header column, then one card per app the daemon lists, in its order, and
// "+ New" last while the computer offers New Harness. The row scrolls sideways and comes to rest on a card's edge.
import 'package:flutter/widgets.dart';

import '../../model/bar_model.dart';
import '../../model/types.dart';
import '../lists/app_card.dart';
import '../lists/snap_physics.dart';
import '../tokens.dart';

class AppsPage extends StatefulWidget {
  const AppsPage({super.key, required this.model});
  final BarModel model;

  @override
  State<AppsPage> createState() => _AppsPageState();
}

/// The row's leading padding and a card's step (its width and the gap), the mockup's `.cards`.
const double _lead = 26, _gap = 16;

class _AppsPageState extends State<AppsPage> {
  final ScrollController _scroll = SnapController(_lead);

  BarModel get model => widget.model;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: model,
        builder: (context, _) => Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          // The mockup has no Close here; the header column takes the finger instead, as the dial's Apps did.
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: model.closeList,
            child: SizedBox(
              width: 210,
              child: Padding(
                padding: const EdgeInsets.only(left: 34),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text('APPS', style: Face.s(22, weight: FontWeight.w600, color: Ink.dim, spacing: 22 * 0.14)),
                ),
              ),
            ),
          ),
          Expanded(child: Center(child: SizedBox(height: kAppCardHeight + 50, child: _cards()))),
        ]),
      );

  Widget _cards() {
    final apps = model.apps;
    final count = apps.length + (model.offersNew ? 1 : 0);
    return ListView.separated(
      controller: _scroll,
      scrollDirection: Axis.horizontal,
      physics: const SnapPhysics(origin: _lead, extent: kAppCardWidth + _gap, parent: ClampingScrollPhysics()),
      padding: const EdgeInsets.fromLTRB(_lead, 20, 30, 30),
      itemCount: count,
      separatorBuilder: (context, i) => const SizedBox(width: _gap),
      itemBuilder: (context, i) {
        if (i >= apps.length) return AppCard.add(key: const ValueKey('+new'), onTap: model.newHarness);
        final app = apps[i];
        final shown = app.id == model.shownApp;
        return AppCard(
          key: ValueKey(app.id),
          app: app,
          shown: shown,
          dots: _dots(app, shown),
          onTap: () => model.pickApp(app.id),
        );
      },
    );
  }

  /// The shown app's agents in their own states, in the row's order; another app's waiting agents in yellow and the
  /// rest faint, as the daemon counts them but does not send their states.
  List<Color> _dots(AppInfo app, bool shown) {
    if (shown && model.agents.isNotEmpty) {
      return [for (final a in model.row.take(kAppDots)) appDotInk(a.state)];
    }
    final n = app.count < kAppDots ? app.count : kAppDots;
    return [for (var i = 0; i < n; i++) i < app.waiting ? appDotInk(AgentState.asking) : appDotInk(AgentState.idle)];
  }
}
