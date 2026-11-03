import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_menu.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/finger_target.dart';
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
String _servers(BuddyModelOffer offer) {
  final servers = offer.servedBy.join(', ');
  return offer.servedBy.every((s) => s.endsWith("'s saved API"))
      ? servers
      : 'served by $servers';
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

  /// A refusal shows under the chat's composer, as the bar's other Buddy
  /// actions' do (`SuperTabController.composerError`).
  void _pick(String? model) {
    _menu.close();
    if (model == widget.agent.gridModel) return;
    unawaited(c.switchBuddyModel(model));
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = c.snapshot!;
    final agent = widget.agent;
    final now = DateTime.now();
    final offers = buddyModelOffers(snapshot, now: now);
    final current = agent.gridModel;
    final on = offers.where((o) => o.model == current).firstOrNull;
    // A model gone quiet is still named by the last reading that served it.
    String nameOf(String model) =>
        offers.where((o) => o.model == model).firstOrNull?.name ??
        superTabLocalModelRows(
          snapshot,
          now: now,
          freshFor: null,
        ).where((r) => r.model == model).firstOrNull?.name ??
        model;
    final request = agent.modelRequest;
    final phone = workspaceIsCompact(context);
    final busy = !c.canWrite || c.saving || c.hasPendingAction;
    final after = [
      if (request == null && current != null)
        on == null ? 'not served now' : _servers(on),
      widget.rest,
    ].join(' · ');
    final picker = request != null
        ? Text(
            request.gridModel == null
                ? 'Switching to your subscription…'
                : 'Switching to ${request.name ?? nameOf(request.gridModel!)}…',
            style: DesktopChrome.metadata(),
          )
        : _anchor(
            label: current == null ? 'Your subscription' : nameOf(current),
            offers: offers,
            phone: phone,
            busy: busy,
          );
    return Text.rich(
      TextSpan(
        children: [
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: KeyedSubtree(
              key: const ValueKey('super-buddy-model'),
              child: picker,
            ),
          ),
          TextSpan(text: ' · $after'),
        ],
      ),
      style: DesktopChrome.metadata(),
    );
  }

  Widget _anchor({
    required String label,
    required List<BuddyModelOffer> offers,
    required bool phone,
    required bool busy,
  }) {
    final current = widget.agent.gridModel;
    final pool = c.snapshot!.pool(widget.agent.machineId);
    Widget row(AppMenuItem item) => fingerTarget(enabled: phone, item);
    Widget words(String text) => Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: grid.AppDesktop.groupGap,
        vertical: grid.AppDesktop.menuInset,
      ),
      child: Text(text, style: DesktopChrome.metadata()),
    );
    return MenuAnchor(
      controller: _menu,
      consumeOutsideTap: true,
      // Held to the style's width, so the longer lines wrap.
      crossAxisUnconstrained: false,
      alignmentOffset: const Offset(0, grid.AppControl.menuGap),
      style: grid.AppMenu.style(minWidth: 220, maxWidth: 440, maxHeight: 520),
      menuChildren: [
        row(
          AppMenuItem(
            icon: current == null ? AppIcons.check : null,
            label: 'Your subscription',
            note: 'Claude Code',
            expandLabel: true,
            onPressed: () => _pick(null),
          ),
        ),
        const AppMenuDivider(),
        words('SHARED IN THIS SWARM'),
        // A Buddy-only machine never joins the Swarm's grid (backend
        // read/hostRows.ts), so nothing shared reaches a Buddy there.
        if (pool == null || pool['buddyOnly'] == true)
          words(
            "Add ${widget.machine} to the Swarm's Machines to use shared models.",
          )
        else if (offers.isEmpty)
          words('Nobody shares a model in this Swarm yet.')
        else
          for (final offer in offers)
            row(
              AppMenuItem(
                icon: offer.model == current ? AppIcons.check : null,
                label: offer.name,
                // Under the name: a list of servers would be cut short beside it.
                detail: _servers(offer),
                onPressed: () => _pick(offer.model),
              ),
            ),
        const AppMenuDivider(),
        words(
          'What your Buddy reads and writes goes to the machine or API that serves the model you pick.',
        ),
      ],
      builder: (context, menu, _) => fingerTarget(
        enabled: phone,
        InkWell(
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
          onTap: busy ? null : () => menu.isOpen ? menu.close() : menu.open(),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: DesktopChrome.metadata(color: DesktopChrome.foreground),
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
  }
}
