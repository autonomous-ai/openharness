import 'package:flutter/material.dart';

import '../../core/runtime_model_name.dart';
import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_menu.dart';
import '../../widgets/desktop_chrome.dart';
import '../../widgets/finger_target.dart';
import '../buddy_engine.dart';
import '../buddy_model.dart';
import '../controller.dart';
import '../model.dart';

/// The top bar's one quiet line (anh Dee's six rules, task #4465): the agent's engine and model, `Claude Code · Opus
/// 5.5`, in 12-point third grey. For the reader's own Swarm Buddy it is plain until hover and opens one menu, its
/// engines and then the models shared in the Swarm. The server switches no other agent, so theirs says the same and
/// opens nothing. The chevron's room is kept at rest, so hover never moves the line.
class SuperTabEngineModelLine extends StatefulWidget {
  const SuperTabEngineModelLine({
    super.key,
    required this.controller,
    required this.agent,
    required this.machine,
    required this.switchable,
  });

  final SuperTabController controller;
  final SuperTabAgent agent;

  /// The agent's machine's name, for the menu's line that asks to add it to the Swarm.
  final String machine;

  /// The reader's own Swarm Buddy, whose engine and model they switch here.
  final bool switchable;

  @override
  State<SuperTabEngineModelLine> createState() =>
      _SuperTabEngineModelLineState();
}

class _SuperTabEngineModelLineState extends State<SuperTabEngineModelLine> {
  final _menu = MenuController();
  var _hover = false, _focus = false, _open = false;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final c = widget.controller;
    final agent = widget.agent;
    final snapshot = c.snapshot!;
    final now = DateTime.now();
    final engine = buddyEngineLabel(agent.engine);
    final offers = agent.engine == 'claude' && widget.switchable
        ? buddyModelOffers(snapshot, now: now)
        : <BuddyModelOffer>[];
    String nameOf(String model) =>
        buddyModelName(snapshot, model, offers: offers, now: now);
    final shared = agent.gridModel;
    final model = shared != null
        ? nameOf(shared)
        : switch (agent.configuration['model']) {
            final String id when id.isNotEmpty && id != 'default' =>
              modelDisplayName(id),
            _ => null,
          };
    final engineSwitch = agent.switchRequest?['engine'];
    final modelSwitch = agent.modelRequest;
    final words = engineSwitch is String
        ? 'Switching to ${buddyEngineLabel(engineSwitch)}…'
        : modelSwitch != null
        ? 'Switching to ${modelSwitch.gridModel == null ? engine : modelSwitch.name ?? nameOf(modelSwitch.gridModel!)}…'
        : [
            engine,
            ?model,
            // A picked shared model that stopped is a failure the reader acts on, so it stays (review 4 of #3464).
            if (shared != null &&
                widget.switchable &&
                !offers.any((o) => o.model == shared))
              'not served now',
          ].join(' · ');
    final opens =
        widget.switchable &&
        engineSwitch is! String &&
        modelSwitch == null &&
        !buddyModelBusy(c, agent);
    final lit = opens && (_hover || _focus || _open);
    Widget line() => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Flexible(
          child: Text(
            words,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: DesktopChrome.metadata(
              color: lit ? DesktopChrome.foreground : DesktopChrome.hint,
            ),
          ),
        ),
        if (opens)
          Opacity(
            opacity: lit ? 1 : 0,
            child: Icon(
              AppIcons.chevronDown,
              size: AppIcons.inlineSize,
              color: DesktopChrome.muted,
            ),
          )
        else
          const SizedBox(width: AppIcons.inlineSize),
      ],
    );
    Widget padded(Widget child) => Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.menuInset,
        vertical: grid.AppDesktop.listRowGap,
      ),
      child: child,
    );
    if (!opens) {
      return KeyedSubtree(
        key: const ValueKey('super-agent-engine-model'),
        child: padded(line()),
      );
    }
    final phone = workspaceIsCompact(context);
    final models = buddyModelMenuRows(
      controller: c,
      agent: agent,
      machine: widget.machine,
      menu: _menu,
      offers: offers,
      phone: phone,
      busy: buddyModelBusy(c, agent),
      subscription: false,
    );
    return AppDropdown(
      controller: _menu,
      // Wide enough for a model and its servers; the longer lines wrap.
      width: 320,
      maxHeight: 520,
      onOpen: () => setState(() => _open = true),
      onClose: () => setState(() => _open = false),
      children: [
        ...buddyEngineMenuRows(
          controller: c,
          agent: agent,
          menu: _menu,
          phone: phone,
          backFromShared: true,
        ),
        if (models.isNotEmpty) ...[const AppMenuDivider(), ...models],
      ],
      builder: (context, menu, _) => fingerTarget(
        enabled: phone,
        InkWell(
          key: const ValueKey('super-agent-engine-model'),
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          onHover: (hover) => setState(() => _hover = hover),
          onFocusChange: (focus) => setState(() => _focus = focus),
          onTap: () => menu.isOpen ? menu.close() : menu.open(),
          child: padded(line()),
        ),
      ),
    );
  }
}
