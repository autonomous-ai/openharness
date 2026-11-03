import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'model.dart';
import 'swarm_buddy.dart' show swarmCanWrite;
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_session.dart' show SwarmScope;
import 'swarm_start.dart' show SwarmComputers;

/// A session running on one of the person's computers, as Add agent lists
/// it: the computer's id and name, the session's id there ([harnessId]), its
/// name and its engine.
typedef SwarmRunningSession = ({
  String machineId,
  String machine,
  String harnessId,
  String name,
  String engine,
});

/// The sessions running on the person's computers that may join a Swarm, as
/// Desktop's Add agent lists those of the computers it reaches: the app's own
/// (`AppSwarmComputers`), a stand-in in a test. Apart from [SwarmComputers],
/// so a stand-in of those need not list any: none listed is none to attach.
abstract interface class SwarmRunningSessions {
  List<SwarmRunningSession> get running;
}

/// One row of Add agent: an agent already in the Swarm ([agentId]), or a
/// session running on one of the person's computers ([session]).
class SwarmAgentChoice {
  SwarmAgentChoice.agent(SuperTabAgent agent, this.name)
    : key = 'agent:${agent.id}',
      agentId = agent.id,
      engine = agent.engine,
      session = null;

  SwarmAgentChoice.session(SwarmRunningSession this.session)
    : key = 'session:${session.machineId}/${session.harnessId}',
      agentId = null,
      name = session.name,
      engine = session.engine;

  /// Which row it is, the same at every read.
  final String key;
  final String name, engine;
  final String? agentId;
  final SwarmRunningSession? session;
}

/// What Add agent and Remove from Swarm sent to one Swarm and the server has
/// not answered yet: an agent being removed leaves the Team at once and comes
/// back if the server refuses; a row being added says so and is not sent
/// twice. One per [SwarmReader], for as long as it lasts.
class SwarmAgentWrites extends ChangeNotifier {
  SwarmAgentWrites._();

  static final _byReader = Expando<SwarmAgentWrites>('SwarmAgentWrites');

  static SwarmAgentWrites of(SwarmReader reader) =>
      _byReader[reader] ??= SwarmAgentWrites._();

  final _removing = <String>{};
  final _adding = <(String, String)>{};

  /// Agent [agentId]'s removal is on its way.
  bool removing(String agentId) => _removing.contains(agentId);

  /// The row keyed [key] ([SwarmAgentChoice.key]) is on its way into chat
  /// [chatId].
  bool adding(String chatId, String key) => _adding.contains((chatId, key));

  void _changed() => notifyListeners();
}

/// Whether the reader may add an agent to chat [chatId], as Desktop's Members
/// offers Add agent (`roster.dart`, `_addAgent`): someone who may write, to a
/// chat that is open and shared with its project; never a private chat or a
/// Buddy chat, which stays its owner's and their Buddy's (backend
/// `BUDDY_CHAT_FIXED`). The project chat is one: a session shared there joins
/// the project, for its tasks (#2207).
bool swarmCanAddAgent(SwarmReader reader, String chatId) {
  final snapshot = reader.snapshot;
  if (reader.accessRevoked || snapshot == null) return false;
  final chat = snapshot.conversation(chatId);
  return chat != null &&
      !chat.archived &&
      chat.audience == null &&
      !chat.isBuddyChat &&
      !reader.buddies.chatOwners.containsKey(chatId) &&
      swarmCanWrite(reader);
}

/// Add agent's rows for chat [chatId], as Desktop's picker offers them
/// (`swarm_screen.dart` `_openSearch`): the Swarm's agents of the chat's
/// project not in it yet, by name — never a Buddy — then the sessions
/// [running] on the person's computers that are not in the Swarm. The project
/// chat holds only its coordinator among agents (#2207), so an agent of the
/// Swarm, which the server would refuse there, is not offered in it; a
/// session shared there joins the project. Empty when the reader may not add
/// one ([swarmCanAddAgent]).
List<SwarmAgentChoice> swarmAgentChoices(
  SwarmReader reader,
  String chatId,
  List<SwarmRunningSession> running,
) {
  if (!swarmCanAddAgent(reader, chatId)) return const [];
  final snapshot = reader.snapshot!;
  final chat = snapshot.conversation(chatId)!;
  final members = [
    if (!snapshot.isProjectLead(chatId))
      for (final agent in snapshot.agents)
        if (!agent.isBuddy &&
            agent.projectId == chat.projectId &&
            !chat.agentIds.contains(agent.id))
          SwarmAgentChoice.agent(agent, snapshot.agentName(agent.id)),
  ];
  String sortName(SwarmAgentChoice c) => c.name.toLowerCase();
  members.sort((a, b) {
    final byName = sortName(a).compareTo(sortName(b));
    return byName != 0 ? byName : a.key.compareTo(b.key);
  });
  return [
    ...members,
    // One already in the Swarm is its agent's row, or none: a Buddy, or an
    // agent of another project or already here.
    for (final session in running)
      if (!snapshot.agents.any(
        (a) =>
            a.machineId == session.machineId &&
            a.harnessId == session.harnessId,
      ))
        SwarmAgentChoice.session(session),
  ];
}

/// The longest name the backend takes (commands.ts `title`).
const _maxName = 160;

/// [name] as `agent.add` takes it: trimmed, at most [_maxName] characters,
/// never half a character.
String _nameToSend(String name) {
  var trimmed = name.trim();
  if (trimmed.isEmpty) return 'Agent';
  if (trimmed.length <= _maxName) return trimmed;
  trimmed = trimmed.substring(0, _maxName);
  final last = trimmed.codeUnitAt(_maxName - 1);
  // A lead surrogate cut from its pair.
  if (last >= 0xD800 && last <= 0xDBFF) {
    trimmed = trimmed.substring(0, _maxName - 1);
  }
  return trimmed.trimRight();
}

/// Adds [choice] to chat [chatId], as Desktop's `addSuperTabAgent` does: an
/// agent of the Swarm joins it (`conversation.agent`); a running session is
/// shared into it (`agent.add`), and its computer is woken to host it through
/// [computers]. Null once the server kept it and the Swarm is read again,
/// else the sentence to show. A row already on its way sends nothing again.
Future<String?> swarmAddAgent(
  SwarmReader reader,
  String chatId,
  SwarmAgentChoice choice, {
  SwarmComputers? computers,
}) async {
  if (!swarmCanAddAgent(reader, chatId)) return _notAllowed;
  final writes = SwarmAgentWrites.of(reader);
  final pending = (chatId, choice.key);
  if (!writes._adding.add(pending)) return null;
  writes._changed();
  try {
    final session = choice.session;
    // A session already in the Swarm joins as its agent (Desktop's
    // addSuperTabAgent): it may have been added since the sheet was drawn.
    final agentId =
        choice.agentId ??
        reader.snapshot?.agents
            .where(
              (a) =>
                  a.machineId == session?.machineId &&
                  a.harnessId == session?.harnessId,
            )
            .firstOrNull
            ?.id;
    if (agentId != null) {
      return await _send(reader, {
        'type': 'conversation.agent',
        'conversationId': chatId,
        'agentId': agentId,
        'present': true,
        'lead': false,
      });
    }
    if (session == null) return _notAllowed;
    return await _send(
      reader,
      {
        'type': 'agent.add',
        'conversationId': chatId,
        'machineId': session.machineId,
        'harnessId': session.harnessId,
        'name': _nameToSend(session.name),
        'lead': false,
        // What it runs is its host's to report (agent.configuration): the
        // phone reads no model of a session.
        'configuration': {
          'engine': session.engine,
          'model': null,
          'effort': null,
          'contextWindow': null,
          'engineVersion': null,
        },
      },
      kept: () {
        // Its host reads the Swarm now, not at its next look. Best effort:
        // the host looks again by itself.
        final wake = computers?.ask(session.machineId, {'action': 'wake'});
        unawaited(wake?.then((_) {}, onError: (_) {}));
      },
    );
  } finally {
    writes._adding.remove(pending);
    writes._changed();
  }
}

/// What the reader may do to agent [agentId] of a Swarm, as Desktop's Members
/// row offers it (`roster.dart` `_canRemove`, `_removeReason`): remove it
/// from the Swarm when they may write and it is theirs, or the Swarm is;
/// never a project's coordinator while it is one ([removeReason], the
/// desktop's words). The server checks both again (`agent.remove`
/// FORBIDDEN). Null once the Swarm can no longer be read, or the agent is
/// gone from it.
typedef SwarmAgentRights = ({bool remove, String? removeReason});

SwarmAgentRights? swarmAgentRights(SwarmReader reader, String agentId) {
  final snapshot = reader.snapshot;
  if (reader.accessRevoked || snapshot == null) return null;
  final agent = snapshot.agent(agentId);
  if (agent == null) return null;
  return (
    remove:
        swarmCanWrite(reader) &&
        (snapshot.ownerId == reader.accountId ||
            agent.contributorId == reader.accountId),
    removeReason: snapshot.leadProtectionReason(agentId),
  );
}

/// Removes agent [agentId] from the Swarm (`agent.remove`): it leaves the
/// Team at once ([SwarmAgentWrites.removing]) and comes back if the server
/// refuses. Null once the server kept it and the Swarm is read again, else
/// the sentence to show.
Future<String?> swarmRemoveAgent(SwarmReader reader, String agentId) async {
  final rights = swarmAgentRights(reader, agentId);
  if (rights == null || !rights.remove) return _notAllowed;
  if (rights.removeReason case final reason?) return reason;
  final writes = SwarmAgentWrites.of(reader);
  if (!writes._removing.add(agentId)) return null;
  writes._changed();
  try {
    return await _send(reader, {'type': 'agent.remove', 'agentId': agentId});
  } finally {
    writes._removing.remove(agentId);
    writes._changed();
  }
}

const _notAllowed = 'This action is no longer available.';
const _notSent = 'Could not reach this Swarm. Try again.';

/// Sends [command]; once the server kept it, [kept], then a read begun after
/// it, so what is drawn next is the server's.
Future<String?> _send(
  SwarmReader reader,
  Map<String, dynamic> command, {
  VoidCallback? kept,
}) async {
  try {
    await reader.request(
      'POST',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
      body: {'operationId': superTabOperationId(), 'command': command},
    );
  } on SuperTabFailure catch (failure) {
    return failure.message;
  } catch (_) {
    // A call lost on the way (a timeout, a socket dropped) is no answer.
    return _notSent;
  }
  kept?.call();
  // A read under way began before the server kept it: one more after it.
  if (reader.refreshing) await reader.refresh();
  await reader.refresh();
  return null;
}

/// Says [error] at the foot of the screen, unless the screen is gone or the
/// Swarm can no longer be read.
void _tell(
  ScaffoldMessengerState? messenger,
  SwarmReader reader,
  String? error,
) {
  if (error == null ||
      messenger == null ||
      !messenger.mounted ||
      reader.accessRevoked) {
    return;
  }
  messenger.showSnackBar(
    SnackBar(key: const ValueKey('swarm-agent-failed'), content: Text(error)),
  );
}

/// Takes [route] down once [gone] says so, as the Swarm is read; not while
/// the reader tells its listeners: once this frame is done.
void _closeWhen(Route<void> route, SwarmReader reader, bool Function() gone) {
  void check() {
    if (!gone()) return;
    reader.removeListener(check);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (route.isActive) route.navigator?.removeRoute(route);
    });
  }

  reader.addListener(check);
  unawaited(
    (route is TransitionRoute<void> ? route.completed : route.popped)
        .whenComplete(() => reader.removeListener(check)),
  );
}

/// The chat ⋮ sheet's Add agent for chat [chatId], where the reader may add
/// one ([swarmCanAddAgent]); none otherwise.
List<PhoneSheetAction> swarmAddAgentActions(
  BuildContext context,
  SwarmReader reader,
  String chatId,
) => [
  if (swarmCanAddAgent(reader, chatId))
    PhoneSheetAction(
      icon: LucideIcons.userPlus300,
      label: 'Add agent',
      chevron: true,
      onTap: () => unawaited(showSwarmAddAgentSheet(context, reader, chatId)),
    ),
];

/// Add agent for chat [chatId], titled as Desktop's picker is: the Swarm's
/// agents that may join it, then the sessions running on each of the
/// person's computers under its name ([swarmAgentChoices]), each with its
/// engine. A tap closes the sheet and adds it ([swarmAddAgent]); the server's
/// refusal shows at the foot of the screen. The rows follow the Swarm as it
/// is read, a row on its way says so, and the sheet goes once the chat can no
/// longer take an agent.
Future<void> showSwarmAddAgentSheet(
  BuildContext context,
  SwarmReader reader,
  String chatId,
) {
  if (!swarmCanAddAgent(reader, chatId) || !context.mounted) {
    return Future.value();
  }
  final computers = SwarmScope.computersOf(context);
  final messenger = ScaffoldMessenger.maybeOf(context);
  final writes = SwarmAgentWrites.of(reader);
  List<SwarmRunningSession> running() => switch (computers) {
    final SwarmRunningSessions sessions => sessions.running,
    _ => const [],
  };

  PhoneSheetRows rows() {
    final choices = swarmAgentChoices(reader, chatId, running());
    PhoneSheetAction row(SwarmAgentChoice choice) {
      final adding = writes.adding(chatId, choice.key);
      return PhoneSheetAction(
        icon: LucideIcons.bot300,
        label: choice.name,
        value: adding ? 'Adding…' : engineIdentity(choice.engine).label,
        enabled: !adding,
        onTap: () => unawaited(() async {
          final error = await swarmAddAgent(
            reader,
            chatId,
            choice,
            computers: computers,
          );
          _tell(messenger, reader, error);
        }()),
      );
    }

    final machines = <String, ({String name, List<PhoneSheetAction> rows})>{};
    for (final choice in choices) {
      final session = choice.session;
      if (session == null) continue;
      (machines[session.machineId] ??= (
        name: session.machine,
        rows: [],
      )).rows.add(row(choice));
    }
    return (
      actions: [
        if (choices.isEmpty)
          PhoneSheetAction(
            icon: LucideIcons.bot300,
            label: 'No running agents',
            enabled: false,
            onTap: () {},
          ),
      ],
      sections: [
        PhoneSheetSection(
          caption: 'Agents',
          actions: [
            for (final choice in choices)
              if (choice.agentId != null) row(choice),
          ],
        ),
        for (final machine in machines.values)
          PhoneSheetSection(caption: machine.name, actions: machine.rows),
      ],
    );
  }

  return showPhoneSheet(
    context,
    title: 'Add agent to ${reader.snapshot?.name ?? 'Swarm'}',
    rows: rows,
    rebuildOn: Listenable.merge([reader, writes]),
    onShown: (route) =>
        _closeWhen(route, reader, () => !swarmCanAddAgent(reader, chatId)),
  );
}

/// The long-press menu of an agent on a project's Team: Remove from Swarm,
/// as Desktop's Members row menu offers it, for whoever may
/// ([swarmAgentRights]); held back for a project's coordinator, which its
/// row names in a word. The row follows the Swarm as it is read; the sheet
/// goes once the agent, or the reader's right to remove it, is gone.
Future<void> showSwarmAgentMenu(
  BuildContext context,
  SwarmReader reader,
  String agentId,
) {
  final snapshot = reader.snapshot;
  if (swarmAgentRights(reader, agentId)?.remove != true || snapshot == null) {
    return Future.value();
  }
  PhoneSheetRows rows() {
    final rights = swarmAgentRights(reader, agentId);
    final project = reader.snapshot?.leadProjectForAgent(agentId);
    return (
      actions: [
        if (rights != null && rights.remove)
          PhoneSheetAction(
            icon: LucideIcons.trash2300,
            label: 'Remove from Swarm',
            destructive: true,
            enabled: rights.removeReason == null,
            // The whole sentence is the desktop's line under the row; a
            // sheet row has room for a word or two.
            value: rights.removeReason == null || project == null
                ? null
                : reader.snapshot!.coordinatorNameOf(project.id),
            onTap: () =>
                unawaited(confirmSwarmRemoveAgent(context, reader, agentId)),
          ),
      ],
      sections: const <PhoneSheetSection>[],
    );
  }

  return showPhoneSheet(
    context,
    title: snapshot.agentName(agentId),
    rows: rows,
    rebuildOn: reader,
    onShown: (route) => _closeWhen(
      route,
      reader,
      () => swarmAgentRights(reader, agentId)?.remove != true,
    ),
  );
}

/// Asks before removing agent [agentId] from the Swarm, in the desktop's
/// words (`roster.dart` `_remove`), then removes it ([swarmRemoveAgent]);
/// the server's refusal shows at the foot of the screen. Nothing is asked or
/// sent for someone who may not, an agent that changed meanwhile, or a Swarm
/// the reader lost access to while it asked.
Future<void> confirmSwarmRemoveAgent(
  BuildContext context,
  SwarmReader reader,
  String agentId,
) async {
  bool allowed() {
    final rights = swarmAgentRights(reader, agentId);
    return rights != null && rights.remove && rights.removeReason == null;
  }

  final snapshot = reader.snapshot;
  final agent = snapshot?.agent(agentId);
  if (!allowed() || !context.mounted || snapshot == null || agent == null) {
    return;
  }
  final messenger = ScaffoldMessenger.maybeOf(context);
  final generation = reader.generation;
  final name = snapshot.agentName(agentId);
  // The Mac, for an agent in that Mac's Harness Team account; named as the
  // desktop names it: the person's own computer first, then the Swarm's
  // record of it, which a computer used only for agents may not have.
  final place = snapshot.placeOf(agent.machineId);
  final own = SwarmScope.computersOf(
    context,
  )?.own.where((c) => c.id == place).firstOrNull?.name;
  final pooled = snapshot.pool(place)?['name'];
  final machine = switch ((own, pooled)) {
    (final String own, _) when own.isNotEmpty => own,
    (_, final String pooled) when pooled.isNotEmpty => pooled,
    _ => 'its computer',
  };
  final confirmed = await confirmPhoneAction(
    context,
    icon: LucideIcons.trash2300,
    title: 'Remove $name from this Swarm?',
    message:
        'Any open task needs to be assigned again or closed. Its session on '
        '$machine will stop.',
    confirmLabel: 'Remove from Swarm',
  );
  if (!confirmed || reader.generation != generation || !allowed()) return;
  _tell(messenger, reader, await swarmRemoveAgent(reader, agentId));
}
