import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
import 'buddy_engine.dart';
import 'controller.dart';
import 'identity.dart';
import 'model.dart';

/// A model a person may switch their Buddy to, and who serves it: machines by
/// name for a model they run, `<member>'s saved API` for an API a member
/// shares. A model several machines serve names them all; the Swarm's grid
/// picks one per request.
typedef BuddyModelOffer = ({String model, String name, List<String> servedBy});

/// What the server lets a Buddy switch to (backend buddyModel.ts, machines.ts
/// `servedLocalModels`): every model on this Swarm's grid in a fresh reading of
/// a machine of the Swarm, once each. Never a model of another grid a member
/// is signed into, which only that member's machine reaches.
List<BuddyModelOffer> buddyModelOffers(
  SuperTabSnapshot snapshot, {
  required DateTime now,
}) {
  final grid = snapshot.localModels?.grid;
  final offers = <String, BuddyModelOffer>{};
  for (final row in superTabLocalModelRows(snapshot, now: now)) {
    if (row.grid != grid || !const {'local', 'api'}.contains(row.kind)) {
      continue;
    }
    final server = row.kind == 'api'
        ? "${_sharer(snapshot, row.machineId)}'s saved API"
        : superTabMachineName(row.machine);
    final offer = offers[row.model] ??= (
      model: row.model,
      name: row.name,
      servedBy: <String>[],
    );
    if (!offer.servedBy.contains(server)) offer.servedBy.add(server);
  }
  return offers.values.toList();
}

String _sharer(SuperTabSnapshot snapshot, String machineId) =>
    snapshot.usernameOf(
      snapshot.pool(machineId)?['contributorId'] as String? ?? '',
    ) ??
    'a member';

/// Who serves [offer], as the server's lines say it (backend buddyModel.ts).
String buddyModelServers(BuddyModelOffer offer) {
  final servers = offer.servedBy.join(', ');
  return offer.servedBy.every((s) => s.endsWith("'s saved API"))
      ? servers
      : 'served by $servers';
}

/// The name of [model] as the Buddy's lines say it: the offer's, else the last reading that served it (a model gone
/// quiet), else its id.
String buddyModelName(
  SuperTabSnapshot snapshot,
  String model, {
  required List<BuddyModelOffer> offers,
  required DateTime now,
}) =>
    offers.where((o) => o.model == model).firstOrNull?.name ??
    superTabLocalModelRows(
      snapshot,
      now: now,
      freshFor: null,
    ).where((r) => r.model == model).firstOrNull?.name ??
    model;

/// Whether a Swarm Buddy's model choices wait: the reader cannot write, something is saving, or a switch is under way.
bool buddyModelBusy(SuperTabController c, SuperTabAgent agent) =>
    !c.canWrite ||
    c.saving ||
    c.hasPendingAction ||
    agent.switchRequest != null;

/// The model rows of a Swarm Buddy's menus: [subscription] first for the bar's picker (the top bar's engine rows say
/// it there), then the models shared in this Swarm with who serves each. A refusal shows under the chat's composer,
/// as the bar's other Buddy actions' do (`SuperTabController.composerError`).
List<Widget> buddyModelMenuRows({
  required SuperTabController controller,
  required SuperTabAgent agent,
  required String machine,
  required MenuController menu,
  required List<BuddyModelOffer> offers,
  required bool phone,
  required bool busy,
  bool subscription = true,
}) {
  final current = agent.gridModel;
  final pool = controller.snapshot!.pool(agent.machineId);
  void pick(String? model) {
    menu.close();
    if (model == current) return;
    unawaited(controller.switchBuddyModel(model));
  }

  Widget row(AppMenuItem item) => fingerTarget(enabled: phone, item);
  Widget words(String text) => Padding(
    padding: const EdgeInsets.symmetric(
      horizontal: grid.AppDesktop.groupGap,
      vertical: grid.AppDesktop.menuInset,
    ),
    child: Text(text, style: DesktopChrome.metadata()),
  );
  return [
    if (subscription)
      row(
        AppMenuItem(
          icon: current == null ? AppIcons.check : null,
          label: 'Your subscription',
          note: buddyEngineLabel(agent.engine),
          onPressed: busy ? null : () => pick(null),
        ),
      ),
    if (agent.engine == 'claude') ...[
      if (subscription) const AppMenuDivider(),
      words('SHARED IN THIS SWARM'),
      // A Buddy-only machine never joins the Swarm's grid (backend
      // read/hostRows.ts), so nothing shared reaches a Buddy there.
      if (pool == null || pool['buddyOnly'] == true)
        words("Add $machine to the Swarm's Machines to use shared models.")
      else if (offers.isEmpty)
        words('Nobody shares a model in this Swarm yet.')
      else
        for (final offer in offers)
          row(
            AppMenuItem(
              icon: offer.model == current ? AppIcons.check : null,
              label: offer.name,
              // Under the name: a list of servers would be cut short beside it.
              detail: buddyModelServers(offer),
              onPressed: busy ? null : () => pick(offer.model),
            ),
          ),
      const AppMenuDivider(),
      words(
        'What your Buddy reads and writes goes to the machine or API that serves the model you pick.',
      ),
    ],
  ];
}

/// The Buddy bar's line with the model picker first (task #2354): the
/// subscription or the shared model the Buddy runs on and who serves it, then
/// [rest]. While a switch is under way it says where to and opens nothing.
class BuddyModelLine extends StatefulWidget {
  const BuddyModelLine({
    super.key,
    required this.controller,
    required this.agent,
    required this.machine,
    required this.rest,
  });

  final SuperTabController controller;

  /// The reader's own main Buddy.
  final SuperTabAgent agent;

  /// Its machine's name, for the line that asks to add it to the Swarm.
  final String machine;

  /// The bar's line after the picker.
  final String rest;

  @override
  State<BuddyModelLine> createState() => _BuddyModelLineState();
}

class _BuddyModelLineState extends State<BuddyModelLine> {
  final _menu = MenuController();

  SuperTabController get c => widget.controller;

  @override
  Widget build(BuildContext context) {
    final snapshot = c.snapshot!;
    final agent = widget.agent;
    final now = DateTime.now();
    final offers = agent.engine == 'claude'
        ? buddyModelOffers(snapshot, now: now)
        : <BuddyModelOffer>[];
    final current = agent.gridModel;
    final on = offers.where((o) => o.model == current).firstOrNull;
    String nameOf(String model) =>
        buddyModelName(snapshot, model, offers: offers, now: now);
    final request = agent.modelRequest;
    final phone = workspaceIsCompact(context);
    final busy = buddyModelBusy(c, agent);
    final after = [
      if (request == null && current != null)
        on == null ? 'not served now' : buddyModelServers(on),
      widget.rest,
    ].join(' · ');
    final picker = request != null
        ? Text(
            request.gridModel == null
                ? 'Switching to your subscription…'
                : 'Switching to ${request.name ?? nameOf(request.gridModel!)}…',
            style: DesktopChrome.metadata(),
          )
        : AppDropdown(
            controller: _menu,
            // Wide enough for a model and its servers; the longer lines wrap.
            width: 320,
            maxHeight: 520,
            children: buddyModelMenuRows(
              controller: c,
              agent: agent,
              machine: widget.machine,
              menu: _menu,
              offers: offers,
              phone: phone,
              busy: busy,
            ),
            builder: (context, menu, _) => fingerTarget(
              enabled: phone,
              InkWell(
                borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
                onTap: busy
                    ? null
                    : () => menu.isOpen ? menu.close() : menu.open(),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(
                      child: Text(
                        current == null ? 'Your subscription' : nameOf(current),
                        style: DesktopChrome.metadata(
                          color: DesktopChrome.foreground,
                        ),
                      ),
                    ),
                    Icon(
                      AppIcons.chevronDown,
                      size: AppIcons.inlineSize,
                      color: DesktopChrome.muted,
                    ),
                  ],
                ),
              ),
            ),
          );
    // Text.rich scales inline widgets as well as the Text they contain.
    // Ordinary children scale once and wrap naturally on a narrow header.
    return Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        if (buddyEngineCapable(snapshot, agent)) ...[
          BuddyEnginePicker(
            key: const ValueKey('super-buddy-engine'),
            controller: c,
            agent: agent,
          ),
          Text(' · ', style: DesktopChrome.metadata()),
        ],
        KeyedSubtree(key: const ValueKey('super-buddy-model'), child: picker),
        Text(' · $after', style: DesktopChrome.metadata()),
      ],
    );
  }
}
