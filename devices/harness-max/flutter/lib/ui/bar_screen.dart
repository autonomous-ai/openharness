// The bar: the page the model shows, the edge light over it while Attention is up, and the toast. A new page fades in
// over the last as the mockup's go() and its .page transition do.
import 'package:flutter/widgets.dart';

import '../model/bar_model.dart';
import '../model/types.dart';
import 'overlays/done_note.dart';
import 'overlays/edge_light.dart';
import 'overlays/toast_overlay.dart';
import 'overview/motion.dart';
import 'pages/agent_page.dart';
import 'pages/ambient_page.dart';
import 'pages/apps_page.dart';
import 'pages/attention_page.dart';
import 'pages/inbox_page.dart';
import 'pages/overview_page.dart';

class BarScreen extends StatelessWidget {
  const BarScreen({super.key, required this.model});
  final BarModel model;

  @override
  Widget build(BuildContext context) => Listener(
        // Every touch, a drag through Inbox or Apps too, starts the idle clock again, not only the taps that act.
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => model.touched(),
        child: ListenableBuilder(
          listenable: model,
          builder: (context, _) => Stack(fit: StackFit.expand, children: [
            FadeSwitch(child: KeyedSubtree(key: ValueKey(model.page), child: _page())),
            if (model.page == BarPage.attention) EdgeLight(model: model),
            ToastOverlay(model: model),
            DoneNote(model: model),
          ]),
        ),
      );

  Widget _page() => switch (model.page) {
        BarPage.overview => OverviewPage(model: model),
        BarPage.agent => AgentPage(model: model),
        BarPage.attention => AttentionPage(model: model),
        BarPage.inbox => InboxPage(model: model),
        BarPage.apps => AppsPage(model: model),
        BarPage.ambient => AmbientPage(model: model),
      };
}
