import 'dart:async';
import 'dart:convert';

import 'package:cryptography/dart.dart';
import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_buddy.dart' show swarmCanWrite;
import 'swarm_reader.dart';
import 'swarm_request.dart';

/// The name Desktop gives the person's Personal Swarm (`kPersonalSwarmName`).
const swarmPersonalName = 'Personal';

/// How long a start the phone asked for shows as starting: the server's claim
/// holds as long (backend leadStart.ts `LEAD_CLAIM_MS`).
const swarmLeadStartWindow = Duration(minutes: 10);

/// One of the person's own computers a Lead can start on: its name, the
/// engines signed in there (Claude Code first), the folder of each repo its
/// agents work in, by remote ([swarmNormalizedRemote]), and when the person
/// last opened one of its agents, from any app ([lastUsed]; null if never).
typedef SwarmLeadComputer = ({
  String id,
  String name,
  List<String> engines,
  Map<String, String> folders,
  DateTime? lastUsed,
});

/// What the computer is asked to start: the Lead's engine, the repo's folder
/// there or null for a new one named after [projectName], its first prompt,
/// and the project's skill mode.
typedef SwarmLeadLaunch = ({
  String engine,
  String? folder,
  String projectName,
  String prompt,
  String skillMode,
});

/// The harness a computer started, and the folder and remote it reports.
typedef SwarmLeadStarted = ({String harnessId, String? cwd, String? remote});

/// The person's computers that start a Personal project's Lead, as Desktop
/// starts it on another of theirs (desktop personal_lead.dart): the computer
/// runs it, never the phone.
abstract interface class SwarmLeadComputers implements Listenable {
  /// The person's own connected computers, never shared nor a Harness Team
  /// account.
  List<SwarmLeadComputer> get leadComputers;

  /// Starts the Lead on [machineId]; answers what it started, or throws a
  /// [SuperTabFailure] saying why not.
  Future<SwarmLeadStarted> startLead(String machineId, SwarmLeadLaunch launch);
}

/// Where a project's Lead starts: the computer, its engine, and the repo's
/// folder there, or null for a new folder in the Harness projects folder.
typedef SwarmLeadPlan = ({String machineId, String engine, String? folder});

/// Whether [chatId] of [reader] offers to start its project's Lead, as
/// Desktop's card shows (personal_lead.dart `wants`): the person's own
/// Personal Swarm with no one else in it, a project's chat that is open, no
/// Lead there, and a reader who may write.
bool swarmWantsLeadStart(SwarmReader reader, String chatId) {
  final snapshot = reader.snapshot;
  if (reader.accessRevoked || snapshot == null) return false;
  if (snapshot.name.trim() != swarmPersonalName ||
      snapshot.ownerId != reader.accountId ||
      snapshot.people.any((p) => p.id != reader.accountId) ||
      !swarmCanWrite(reader)) {
    return false;
  }
  final chat = snapshot.conversation(chatId);
  if (chat == null || chat.archived || chat.isBuddyChat) return false;
  if (!snapshot.isProjectLead(chatId)) return false;
  final project = snapshot.projectFor(chatId);
  if (project == null) return false;
  final leadId = chat.leadId;
  return leadId == null ||
      !chat.agentIds.contains(leadId) ||
      snapshot.agent(leadId) == null;
}

/// Where [chatId]'s Lead starts, or throws why it cannot, picking what
/// Desktop's card picks (`planFor`, task #3042): the computer picked, else
/// the repo's folder on the computer the person used last of those that hold
/// it (Desktop prefers its own, the one the person is at), else the computer
/// used last; the engine picked, else its first signed in (Claude Code, then
/// Codex). Claude runs at the Lead's model on the computer, as on Desktop.
SwarmLeadPlan swarmLeadPlan(
  SwarmReader reader,
  SwarmLeadComputers computers,
  String chatId, {
  String? machineId,
  String? engine,
}) {
  final projectId = reader.snapshot?.projectFor(chatId)?.id;
  final all = computers.leadComputers;
  String? folderOn(SwarmLeadComputer c) => projectId == null
      ? null
      : c.folders.entries
            .where((e) => swarmPersonalProjectOperation(e.key) == projectId)
            .firstOrNull
            ?.value;
  final picked = machineId == null
      ? null
      : all.where((c) => c.id == machineId).firstOrNull;
  if (machineId != null && picked == null) {
    throw const SuperTabFailure('NO_MACHINE', 'that computer isn’t online');
  }
  // The last used first; ties and never used in the list's order (a sort
  // alone may not keep it).
  final order = {for (final (i, c) in all.indexed) c.id: i};
  final byUse = [...all]
    ..sort((a, b) {
      final x = a.lastUsed, y = b.lastUsed;
      final byTime = x == null || y == null
          ? (x == y ? 0 : (x == null ? 1 : -1))
          : y.compareTo(x);
      return byTime != 0 ? byTime : order[a.id]!.compareTo(order[b.id]!);
    });
  final chosen =
      picked ??
      byUse.where((c) => folderOn(c) != null).firstOrNull ??
      byUse.firstOrNull;
  if (chosen == null) {
    throw const SuperTabFailure(
      'NO_MACHINE',
      'none of your computers is online',
    );
  }
  final runs = engine != null && chosen.engines.contains(engine)
      ? engine
      : chosen.engines.firstOrNull;
  if (runs == null) {
    throw SuperTabFailure(
      'NO_ENGINE',
      'Claude Code and Codex aren’t signed in on ${chosen.name}',
    );
  }
  return (machineId: chosen.id, engine: runs, folder: folderOn(chosen));
}

/// What the phone knows of a chat's Lead start: starting since [at], or
/// failed with [reason].
@immutable
class SwarmLeadStatus {
  const SwarmLeadStatus.starting(DateTime this.at) : reason = null;
  const SwarmLeadStatus.failed(String this.reason) : at = null;
  final DateTime? at;
  final String? reason;
  bool get failed => reason != null;
}

/// Starts a Personal project's Lead from the phone, once per chat, the way
/// Desktop does (personal_lead.dart `start`): one claim (`lead.claim`) keeps
/// two of the person's devices from starting two, the computer starts the
/// agent, and `agent.add` joins it as Lead. One per [SwarmReader].
class SwarmLeadStarter extends ChangeNotifier {
  SwarmLeadStarter._();
  static final _of = Expando<SwarmLeadStarter>('SwarmLeadStarter');
  static SwarmLeadStarter of(SwarmReader reader) =>
      _of[reader] ??= SwarmLeadStarter._();

  final _status = <String, SwarmLeadStatus>{};

  /// A harness started for a chat whose join has not gone through: Start
  /// again joins it rather than starting a second.
  final _started =
      <String, ({String machineId, String engine, SwarmLeadStarted started})>{};

  /// The computer and engine of [chatId]'s harness started but not joined
  /// yet: Start again claims that computer and joins it, so the card shows it
  /// and offers no other.
  ({String machineId, String engine})? kept(String chatId) =>
      switch (_started[chatId]) {
        (:final machineId, :final engine, started: _) => (
          machineId: machineId,
          engine: engine,
        ),
        null => null,
      };

  /// [chatId]'s start as the phone knows it: one starting for longer than
  /// the claim holds is no longer shown.
  SwarmLeadStatus? statusOf(String chatId) {
    final status = _status[chatId];
    if (status?.at case final at?
        when DateTime.now().difference(at) >= swarmLeadStartWindow) {
      return null;
    }
    return status;
  }

  void _set(String chatId, SwarmLeadStatus status) {
    _status[chatId] = status;
    notifyListeners();
  }

  /// Starts [chatId]'s Lead on [machineId] with [engine], unless a start is
  /// already under way.
  Future<void> start(
    SwarmReader reader,
    SwarmLeadComputers computers,
    String chatId, {
    required String machineId,
    required String engine,
  }) async {
    if (statusOf(chatId) case final status? when !status.failed) return;
    _set(chatId, SwarmLeadStatus.starting(DateTime.now()));
    try {
      final project = reader.snapshot?.projectFor(chatId);
      if (project == null) {
        throw const SuperTabFailure(
          'PROJECT_UNAVAILABLE',
          'this project is no longer available',
        );
      }
      // A harness already started whose join did not go through is the one:
      // its computer is claimed and it joins, whatever was picked since
      // (review of #3029).
      final kept = _started[chatId];
      final plan = kept != null
          ? (machineId: kept.machineId, engine: kept.engine, folder: null)
          : swarmLeadPlan(
              reader,
              computers,
              chatId,
              machineId: machineId,
              engine: engine,
            );
      final claim = await _command(reader, {
        'type': 'lead.claim',
        'projectId': project.id,
        'machineId': plan.machineId,
      });
      // Another of the person's machines starts it: its join ends the note.
      if (claim['leadStart'] == 'waiting') return;
      final machine = plan.machineId;
      final runs = plan.engine;
      final started =
          kept?.started ??
          await computers.startLead(plan.machineId, (
            engine: plan.engine,
            folder: plan.folder,
            projectName: project.name,
            prompt: swarmLeadLaunchPrompt(
              tabId: reader.tabId,
              conversationId: chatId,
            ),
            skillMode: project.skillMode,
          ));
      _started[chatId] = (machineId: machine, engine: runs, started: started);
      await _command(reader, {
        'type': 'agent.add',
        'conversationId': chatId,
        'machineId': machine,
        'harnessId': started.harnessId,
        'name': 'Lead',
        'lead': true,
        if (started.cwd case final cwd?)
          'project': {
            'cwd': cwd,
            'repositoryUrl': superTabRepositoryUrl(started.remote),
          },
        // What it runs is its host's to report (agent.configuration).
        'configuration': {
          'engine': runs,
          'model': null,
          'effort': null,
          'contextWindow': null,
          'engineVersion': null,
        },
      });
      _started.remove(chatId);
      // Starting until the chat reads its Lead.
      unawaited(reader.refresh().catchError((Object _) {}));
    } on SuperTabFailure catch (failure) {
      _set(chatId, SwarmLeadStatus.failed(_reason(failure)));
    } catch (error) {
      _set(chatId, SwarmLeadStatus.failed(_trim('$error')));
    }
  }

  Future<Map<String, dynamic>> _command(
    SwarmReader reader,
    Map<String, dynamic> command,
  ) async {
    final answer = await reader.request(
      'POST',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
      body: {'operationId': superTabOperationId(), 'command': command},
    );
    return superTabMap(superTabMap(answer)['result']);
  }

  /// A failure in the receipt's words: a server that does not know the claim
  /// says so, any other its own reason, without a final full stop.
  String _reason(SuperTabFailure failure) => failure.code == 'VALIDATION_ERROR'
      ? 'this Swarm’s server needs an update'
      : _trim(failure.message);

  String _trim(String text) {
    final line = text.trim().split('\n').first;
    return line.endsWith('.') ? line.substring(0, line.length - 1) : line;
  }
}

/// The form an agent reports its project's remote in: `host[:port]/owner/repo`
/// with no scheme, user or `.git` (Desktop's `_canonicalRemote`).
final _canonicalRemote = RegExp(
  r'^[a-z0-9][a-z0-9._-]*[a-z0-9](?::\d+)?/\S+$',
  caseSensitive: false,
);

/// A repo as one string on every computer, as Desktop's `normalizedRemote`
/// makes it: the remote's host and path, lower case, without scheme, user,
/// password, port or `.git`. Null for no remote, or a folder.
String? swarmNormalizedRemote(String? remote) {
  var text = remote?.trim() ?? '';
  if (text.isEmpty) return null;
  if (_canonicalRemote.hasMatch(text)) text = 'https://$text';
  String? host, path;
  final url = RegExp(
    r'^([a-z][a-z0-9+.-]*)://(.*)$',
    caseSensitive: false,
  ).firstMatch(text);
  if (url != null) {
    if (url.group(1)!.toLowerCase() == 'file') return null;
    final rest = url.group(2)!;
    final slash = rest.indexOf('/');
    if (slash <= 0) return null;
    var authority = rest.substring(0, slash);
    authority = authority.substring(authority.lastIndexOf('@') + 1);
    host = authority.replaceFirst(RegExp(r':\d*$'), '');
    path = rest.substring(slash + 1);
  } else {
    // scp-like `user@host:owner/repo`; a path (`/x`, `./x`, `C:\x`) is no remote.
    final scp = RegExp(r'^(?:[^@/\\]+@)?([^:/\\]+):(?!//)(.+)$')
        .firstMatch(text);
    if (scp == null || scp.group(1)!.length < 2) return null;
    host = scp.group(1);
    path = scp.group(2);
  }
  final parts = path!
      .replaceFirst(RegExp(r'\.git/*$', caseSensitive: false), '')
      .split('/')
      .where((p) => p.isNotEmpty && p != '.' && p != '..')
      .toList();
  if (host == null || host.isEmpty || parts.isEmpty) return null;
  return [host, ...parts].join('/').toLowerCase();
}

/// The id of [repo]'s Personal project, as Desktop creates it on every
/// computer of the person's (`personalProjectOperation`; backend
/// `project.create` takes the request id as the project's).
String swarmPersonalProjectOperation(String repo) {
  final digest = const DartSha256()
      .hashSync(utf8.encode(repo))
      .bytes
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join();
  return 'personal-repo-${digest.substring(0, 24)}';
}

/// The Lead's first prompt, Desktop's `superTabLaunchPrompt(lead: true)` word
/// for word (desktop super_tabs/launch_prompt.dart).
String swarmLeadLaunchPrompt({
  required String tabId,
  required String conversationId,
}) =>
    'Harness Swarm agent. '
    'You are the Lead. '
    'Use `harness super-tab --tab $tabId` subcommands. '
    'First: `status`. Retry AGENT_UNAVAILABLE briefly; do not work or post before registration. '
    'Read `messages $conversationId` for the full request; if empty, ask what to work on. '
    'Reply: `post GROUP "message" UNIQUE_OPERATION_ID [--reply-to MESSAGE_ID]`. '
    'Use --reply-to for existing messages; answer each message once, do not post again. Retry lost replies with the same ID and text. '
    'Terminal output is not shared chat. If sandbox blocks commands, request permission. '
    "Read your role in the project's instructions: `harness super-tab --tab $tabId instructions`. "
    'Be a helpful colleague: answer first, in their language, under 150 words unless asked. Hide commands, internal IDs and field names. Give results with revision/links. '
    "Keep the project's status card current with project.report, the whole card as text: one short line per active task, where it is and what it waits on; it posts nothing. "
    'Post in the Lead chat only when work merges or ships, a person must decide something new, or work is badly stuck: one or two lines with the link. '
    'Ask a person a question once, as a decision; never repeat it. Answer questions, blockers and completion at once. '
    'On scheduled requests read new reports, then use project.report with the whole card, or text:null when nothing changed. No per-turn summarizer. '
    'Scope workgroups and sessions to this project.';
