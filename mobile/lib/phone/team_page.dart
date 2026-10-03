import 'dart:async';

import 'package:flutter/material.dart';

import '../state/app_state.dart';
import '../teams/team_controller.dart';
import 'desk_groups.dart';
import 'phone_header.dart';
import 'phone_navigation.dart';
import 'tty.dart';

class PhoneTeamCandidate {
  const PhoneTeamCandidate({
    required this.machineId,
    required this.agentId,
    required this.name,
    required this.engine,
    required this.available,
  });
  final String machineId, agentId, name, engine;
  final bool available;
  String get key => '$machineId/$agentId';
}

class TeamPage extends StatelessWidget {
  const TeamPage({
    super.key,
    required this.notifier,
    required this.machineId,
    this.tabId,
    this.agentId,
  });
  final AppNotifier notifier;
  final String machineId;
  final String? tabId, agentId;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) => tabId == null
        ? Scaffold(
            body: SafeArea(
              child: Column(
                children: [
                  const PhoneHeader(title: 'Swarms'),
                  Expanded(
                    child: ListView(
                      children: [
                        if (notifier.deskTabs.isEmpty)
                          Padding(
                            padding: const EdgeInsets.all(16),
                            child: Text(
                              'Add harnesses to a swarm so their agents can collaborate.',
                              style: Tty.of(context).style(),
                            ),
                          ),
                        for (final tab in notifier.deskTabs)
                          TextButton(
                            onPressed: () => Navigator.of(context).push(
                              phoneRoute(
                                (_) => TeamPage(
                                  notifier: notifier,
                                  machineId: machineId,
                                  tabId: tab.id,
                                ),
                              ),
                            ),
                            child: Text(
                              deskTabName(tab, null),
                              style: Tty.of(context).style(),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          )
        : PhoneTeamView(
            key: ValueKey(tabId),
            controller: notifier.channelController(tabId!, machineId),
            machineName:
                notifier.stateOf(machineId)?.machine.displayName ?? 'Machine',
            candidates: const [],
            onOpen: (machine, agent) =>
                openAgent(context, notifier, machine, agent),
          ),
  );
}

/// A projection of the daemon ledger; leaving the page stops only its read subscription.
class PhoneTeamView extends StatefulWidget {
  const PhoneTeamView({
    super.key,
    required this.controller,
    required this.machineName,
    required this.candidates,
    required this.onOpen,
  });
  final TeamController controller;
  final String machineName;
  final List<PhoneTeamCandidate> candidates;
  final void Function(String machineId, String agentId) onOpen;
  @override
  State<PhoneTeamView> createState() => _PhoneTeamViewState();
}

class _PhoneTeamViewState extends State<PhoneTeamView> {
  TeamController get model => widget.controller;
  bool creating = false;
  late final name = TextEditingController(text: model.newName);
  late final description = TextEditingController(text: model.newDescription);
  late final question = TextEditingController(text: model.draft);
  late Tty tty;
  @override
  void initState() {
    super.initState();
    creating = model.pendingCreate;
    model.addListener(changed);
    model.watch();
  }

  void changed() {
    if (!mounted) return;
    if (question.text != model.draft) {
      question.value = TextEditingValue(
        text: model.draft,
        selection: TextSelection.collapsed(offset: model.draft.length),
      );
    }
    if (model.team != null) creating = false;
    setState(() {});
  }

  @override
  void dispose() {
    model.removeListener(changed);
    model.unwatch();
    name.dispose();
    description.dispose();
    question.dispose();
    super.dispose();
  }

  Widget action(String label, VoidCallback? onTap, {Key? key}) => TextButton(
    key: key,
    style: TextButton.styleFrom(
      foregroundColor: tty.text,
      textStyle: tty.style(),
      alignment: Alignment.centerLeft,
      minimumSize: Size(44, tty.tapRow),
      padding: EdgeInsets.symmetric(horizontal: tty.cell),
      shape: const RoundedRectangleBorder(),
    ),
    onPressed: onTap,
    child: Text('[ $label ]'),
  );
  Widget text(String value, {bool faint = false}) => SelectableText(
    value,
    style: tty.style(color: faint ? tty.faint : tty.text),
  );
  Widget gap() => SizedBox(height: tty.row);
  Widget field(
    TextEditingController controller,
    String label,
    ValueChanged<String> onChanged, {
    int lines = 1,
    bool readOnly = false,
    Key? key,
  }) => TextField(
    key: key,
    controller: controller,
    style: tty.style(),
    minLines: lines,
    maxLines: lines + 2,
    readOnly: readOnly,
    decoration: InputDecoration(
      labelText: label,
      labelStyle: tty.style(color: tty.faint),
      filled: false,
      enabledBorder: UnderlineInputBorder(
        borderSide: BorderSide(color: tty.dim),
      ),
      focusedBorder: UnderlineInputBorder(
        borderSide: BorderSide(color: tty.text),
      ),
    ),
    onChanged: onChanged,
  );
  String memberName(dynamic id) {
    final member = model.members.where((m) => m['id'] == id).firstOrNull;
    final runtime = member?['runtime'] as Map?;
    if (model.isChannel && runtime?['name'] is String) {
      return runtime!['name'] as String;
    }
    return member?['name'] as String? ?? 'choose';
  }

  String alias(String name) {
    var value = name
        .replaceAll(RegExp(r'[^a-zA-Z0-9_-]+'), '-')
        .replaceAll(RegExp(r'^-+|-+$'), '');
    if (value.isEmpty) value = 'teammate';
    if (value.length > 30) value = value.substring(0, 30);
    final base = value;
    var n = 2;
    final used = [
      ...model.newMembers.values,
      ...model.members.where((m) => m['enabled'] != false),
    ];
    while (used.any(
      (m) => m['name'].toString().toLowerCase() == value.toLowerCase(),
    )) {
      value = '$base-${n++}';
    }
    return value;
  }

  Future<void> editMember(
    Map<String, dynamic> member, {
    bool adding = false,
  }) async {
    final alias = TextEditingController(text: member['name'] as String? ?? '');
    final role = TextEditingController(text: member['role'] as String? ?? '');
    final result = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: tty.ground,
      shape: const RoundedRectangleBorder(),
      builder: (context) => SafeArea(
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            16,
            16,
            16,
            MediaQuery.viewInsetsOf(context).bottom + 16,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                text(adding ? 'Connect teammate' : 'Edit teammate'),
                gap(),
                field(alias, 'Team name', (_) {}),
                field(role, 'Knows about', (_) {}, lines: 2),
                gap(),
                action(
                  adding ? 'Connect' : 'Save',
                  () => Navigator.pop(context, 'save'),
                ),
                if (!adding && !creating && member['enabled'] != false)
                  action(
                    'Remove from team',
                    () => Navigator.pop(context, 'remove'),
                  ),
                action('Back', () => Navigator.pop(context)),
              ],
            ),
          ),
        ),
      ),
    );
    if (mounted && result != null) {
      final updated = {
        ...member,
        'name': alias.text.trim(),
        'role': role.text.trim(),
      };
      if (adding) {
        await model.addMember(updated);
      } else if (creating) {
        model.newMembers['${member['machineId']}/${member['agentId']}'] =
            updated;
        setState(() {});
      } else {
        await model.act('member', {
          'member': {
            ...updated,
            'enabled': result != 'remove' && member['enabled'] != false,
          },
        });
      }
    }
    alias.dispose();
    role.dispose();
  }

  Future<void> chooseMember(bool source) async {
    final selected = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: tty.ground,
      shape: const RoundedRectangleBorder(),
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final m in model.members)
              if (m['enabled'] != false && (source || m['id'] != model.from))
                action('@${m['name']}', () => Navigator.pop(context, m['id'])),
          ],
        ),
      ),
    );
    if (!mounted || selected == null) return;
    setState(() {
      if (source) {
        model.from = selected;
        if (model.to == selected) model.to = null;
      } else {
        model.to = selected;
      }
    });
  }

  Future<void> addMember() async {
    if (model.pendingAdd) {
      await model.addMember();
      return;
    }
    final candidates = widget.candidates
        .where(
          (c) =>
              c.available &&
              !model.members.any(
                (m) =>
                    m['enabled'] != false &&
                    m['machineId'] == c.machineId &&
                    m['agentId'] == c.agentId,
              ),
        )
        .toList();
    final selected = await showModalBottomSheet<PhoneTeamCandidate>(
      context: context,
      backgroundColor: tty.ground,
      shape: const RoundedRectangleBorder(),
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            if (candidates.isEmpty)
              Padding(
                padding: const EdgeInsets.all(16),
                child: text('No additional harnesses available.'),
              ),
            for (final c in candidates)
              action(
                '${c.name} · ${c.engine}',
                () => Navigator.pop(context, c),
              ),
          ],
        ),
      ),
    );
    if (!mounted || selected == null) return;
    await editMember({
      'machineId': selected.machineId,
      'agentId': selected.agentId,
      'name': alias(selected.name),
      'role': selected.name,
    }, adding: true);
  }

  List<Widget> home() => [
    text('Teams on ${widget.machineName}', faint: true),
    gap(),
    text(
      'Connect existing harnesses. Questions and answers return to the agents doing the work.',
    ),
    gap(),
    action(
      'New team',
      model.operating ? null : () => setState(() => creating = true),
      key: const Key('phone-team-new'),
    ),
    if (model.loading) text('Reading teams…', faint: true),
    if (!model.loading && model.teams.isEmpty)
      text('No teams yet.', faint: true),
    for (final team in model.teams)
      action(
        '${team['name']} · ${team['pending']} waiting',
        () => unawaited(model.select(team['id'] as String)),
      ),
  ];
  List<Widget> create() => [
    field(
      name,
      'Team name',
      (v) => model.newName = v,
      readOnly: model.pendingCreate,
    ),
    field(
      description,
      'What you are building',
      (v) => model.newDescription = v,
      readOnly: model.pendingCreate,
    ),
    gap(),
    text(
      'Choose at least two existing harnesses. Connect sends each one its team introduction.',
      faint: true,
    ),
    gap(),
    for (final c in widget.candidates) ...[
      action(
        '${model.newMembers.containsKey(c.key) ? 'x' : ' '} ${c.name} · ${c.engine}',
        model.pendingCreate || model.operating || !c.available
            ? null
            : () => setState(() {
                if (model.newMembers.remove(c.key) == null) {
                  model.newMembers[c.key] = {
                    'machineId': c.machineId,
                    'agentId': c.agentId,
                    'name': alias(c.name),
                    'role': c.name,
                  };
                }
              }),
        key: ValueKey('phone-team-candidate-${c.agentId}'),
      ),
      if (model.newMembers[c.key] case final member?)
        action(
          '@${member['name']} · edit role',
          model.pendingCreate ? null : () => editMember(member),
        ),
    ],
    gap(),
    action(
      model.pendingCreate
          ? 'Check connection'
          : 'Connect ${model.newMembers.length} teammates',
      model.operating ||
              (!model.pendingCreate &&
                  (model.newMembers.length < 2 || model.newName.trim().isEmpty))
          ? null
          : () => unawaited(model.create()),
      key: const Key('phone-team-connect'),
    ),
    action(
      'Back',
      model.operating ? null : () => setState(() => creating = false),
    ),
  ];
  List<Widget> detail() => [
    if (!model.isChannel)
      action(
        'All teams',
        model.operating ? null : () => unawaited(model.select(null)),
      ),
    if (model.team == null)
      text(model.isChannel ? 'Reading swarm…' : 'Reading team…')
    else ...[
      text(
        '${model.isChannel ? 'Swarm conversation · ' : ''}${model.team!['state']} · ${model.members.where((m) => m['enabled'] != false).length} harnesses',
        faint: true,
      ),
      if (model.isChannel)
        text('This swarm only · membership follows the swarm.', faint: true),
      Wrap(
        children: [
          if (model.team!['state'] != 'archived')
            action(
              model.active ? 'Pause' : 'Resume',
              model.operating
                  ? null
                  : () =>
                        unawaited(model.act(model.active ? 'pause' : 'resume')),
            ),
          if (!model.isChannel && model.team!['state'] != 'archived')
            action(
              model.pendingAdd ? 'Check teammate' : 'Add teammate',
              model.operating ? null : addMember,
            ),
          if (!model.isChannel && model.team!['state'] == 'paused')
            action(
              'Archive',
              model.operating ? null : () => unawaited(model.act('archive')),
            ),
        ],
      ),
      gap(),
      text(
        model.isChannel ? 'Harnesses in this swarm' : 'Teammates',
        faint: true,
      ),
      for (final m in model.members) ...[
        action(
          '${model.isChannel ? memberName(m['id']) : '@${m['name']}'} · ${m['enabled'] == false ? 'removed' : (m['runtime'] as Map?)?['engine'] ?? 'offline'}',
          () => widget.onOpen(m['machineId'] as String, m['agentId'] as String),
        ),
        if ((m['role'] as String? ?? '').isNotEmpty)
          text(m['role'] as String, faint: true),
        if (!model.isChannel)
          action(
            'Edit @${m['name']}',
            model.operating || model.team!['state'] == 'archived'
                ? null
                : () => editMember(m),
          ),
      ],
      gap(),
      text('Exchanges', faint: true),
      if (model.exchanges.isEmpty) text('No questions yet.', faint: true),
      for (final e in model.exchanges) ...[
        action(
          '${(e['fromPeer'] as Map?)?['name'] ?? memberName(e['from'])} → ${(e['toPeer'] as Map?)?['name'] ?? memberName(e['to'])} · ${e['state']}',
          () => setState(
            () => model.selectedExchange = model.selectedExchange == e['id']
                ? null
                : e['id'],
          ),
        ),
        if (model.selectedExchange == e['id']) ...conversation(e),
      ],
      if (!model.isChannel) ...[
        gap(),
        text('Ask a teammate'),
        Wrap(
          children: [
            action(
              'From @${memberName(model.from)}',
              model.pendingAsk ? null : () => chooseMember(true),
            ),
            action(
              'To @${memberName(model.to)}',
              model.pendingAsk ? null : () => chooseMember(false),
            ),
          ],
        ),
        field(
          question,
          'What do you need to know?',
          (v) {
            model.draft = v;
            setState(() {});
          },
          lines: 3,
          readOnly: model.pendingAsk,
          key: const Key('phone-team-question'),
        ),
        gap(),
        text(
          'The exchange records that you requested this. The answer returns to @${memberName(model.from)}.',
          faint: true,
        ),
        action(
          model.pendingAsk ? 'Check send' : 'Ask',
          model.operating ||
                  !model.active ||
                  (!model.pendingAsk &&
                      (model.draft.trim().isEmpty ||
                          model.to == null ||
                          model.to == model.from))
              ? null
              : () => unawaited(model.ask()),
          key: const Key('phone-team-ask'),
        ),
      ],
    ],
  ];
  List<Widget> conversation(Map<String, dynamic> e) {
    final answer = (e['answer'] as Map?)?.cast<String, dynamic>();
    final fromName = (e['fromPeer'] as Map?)?['name'] ?? memberName(e['from']);
    return [
      text(
        '${e['origin'] == 'owner' ? 'Requested by you' : 'Agent question'} · ${teamDeliveryLabel((e['delivery'] as Map?)?.cast<String, dynamic>())}',
        faint: true,
      ),
      gap(),
      text(e['text'] as String),
      if ((e['context'] as String? ?? '').isNotEmpty)
        text(e['context'] as String, faint: true),
      gap(),
      if (answer == null)
        text('Waiting for an explicit answer.', faint: true)
      else ...[
        text(
          '${answer['late'] == true ? 'Late answer' : 'Answer'}${answer['origin'] == 'owner' ? ' supplied by you' : ''}',
          faint: true,
        ),
        gap(),
        text(answer['text'] as String),
        for (final ref in answer['evidence'] as List? ?? [])
          text(ref.toString(), faint: true),
        gap(),
        text(
          answer['late'] == true
              ? 'Retained for reference; no automatic continuation.'
              : 'Return to $fromName: ${teamDeliveryLabel((e['continuation'] as Map?)?.cast<String, dynamic>())}',
          faint: true,
        ),
      ],
      if (e['state'] == 'pending')
        action(
          'Cancel question',
          model.operating
              ? null
              : () => unawaited(
                  model.act('cancel', {
                    'questionId': e['questionId'] ?? e['id'],
                    if (e['teamId'] != null) 'teamId': e['teamId'],
                  }),
                ),
        ),
      gap(),
    ];
  }

  @override
  Widget build(BuildContext context) {
    tty = Tty.of(context);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: Column(
          children: [
            PhoneHeader(
              title: creating
                  ? 'Connect a team'
                  : model.team?['name'] as String? ??
                        (model.isChannel ? 'Swarm conversation' : 'Team'),
              trailing: [action('Refresh', () => unawaited(model.refresh()))],
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: model.refresh,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  children: [
                    if (model.error case final error?) ...[
                      Semantics(liveRegion: true, child: text(error)),
                      gap(),
                    ],
                    ...(creating
                        ? create()
                        : model.selectedId == null && !model.isChannel
                        ? home()
                        : detail()),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
