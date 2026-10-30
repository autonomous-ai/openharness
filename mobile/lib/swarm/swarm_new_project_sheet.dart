import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_buddy.dart' show swarmCanWrite;
import 'swarm_home_list.dart' show swarmProjectActivity;
import 'swarm_home_top.dart' show swarmHomeOffers;
import 'swarm_inbox.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// New project from the phone (Tony, 10-30): Swarm Home's last Projects row
/// ([SwarmNewProjectRow]) opens a sheet ([showSwarmNewProjectSheet]) that
/// creates a project in a Swarm the person may write in and starts its
/// Product Manager on the Swarm machine they pick, as Desktop's New Project
/// does through the Swarm (desktop `super_tabs/launch.dart` `startInSwarm`,
/// #2208, #2215, #2228). A phone never runs the Product Manager itself, so
/// it has no "this computer".

/// Whether the person may create a project in Swarm [swarmId] from Home: Home
/// offers it, it is read, and they may write in it (an owner or a
/// collaborator, never a viewer, as the server's `project.create` asks).
bool swarmMayCreateProject(SwarmInbox inbox, String swarmId) {
  final reader = inbox.reader(swarmId);
  return reader != null &&
      !reader.accessRevoked &&
      reader.snapshot != null &&
      swarmHomeOffers(inbox, swarmId) &&
      swarmCanWrite(reader);
}

/// The engines a Product Manager runs on, in the order one is chosen
/// (Desktop's `kLeadEngines`).
const swarmLeadEngines = ['claude', 'codex'];

/// A Product Manager engine's name as people read it.
String swarmLeadEngineLabel(String engine) =>
    const {'claude': 'Claude Code', 'codex': 'Codex'}[engine] ?? engine;

/// Why a paused Swarm's machines take no work (Desktop's `kLeadSwarmPaused`).
const swarmLeadSwarmPaused = 'New work is paused in this Swarm';

/// New project's reason while no machine is chosen: none is chosen for the
/// person, since only they know which one stays on (Ken, 10-29).
const swarmLeadChooseMachine =
    'Choose the machine the Product Manager runs on.';

/// What PM runs on says when no machine can take the Product Manager now.
const swarmLeadNoMachine = 'No machine can run the Product Manager now.';

/// A machine's reading counts while it is this fresh (backend
/// `MACHINE_FRESH_MS`, as the start itself reads it).
const _freshFor = Duration(seconds: 45);

/// The longest brief kept: a project's brief, and its chat's first message
/// (Desktop's 4000; the server takes 8000 characters, a rune is at most two).
const swarmNewProjectBriefRunes = 4000;

/// A machine of the Swarm a new project's Product Manager could start on, as
/// PM runs on lists it: Desktop's `LeadMachine`, without what only a desktop
/// that starts it itself needs.
class SwarmLeadMachine {
  const SwarmLeadMachine({
    required this.id,
    required this.name,
    required this.online,
    required this.freeAgents,
    this.own = true,
    this.maySleep = false,
    this.team = false,
    this.teamEngines,
    this.unavailable,
    this.engineRefusals = const {},
  });

  final String id, name;
  final bool online;

  /// The agent slots it offers the Swarm that nothing runs in.
  final int freeAgents;

  /// One of the person's own machines.
  final bool own;

  /// A laptop: it may sleep with the Product Manager on it.
  final bool maySleep;

  /// It runs the Product Manager in that Mac's Harness Team account.
  final bool team;

  /// The engines it runs in that Mac's Harness Team account, as the server
  /// decided (backend leadStart.ts `leadChoices`); null where it does not say.
  final Set<String>? teamEngines;

  /// Why the Product Manager cannot start here whatever its engine, or null.
  final String? unavailable;

  /// Why an engine cannot run a Product Manager here, by engine; an engine
  /// not in it runs.
  final Map<String, String> engineRefusals;

  bool runs(String engine) => !engineRefusals.containsKey(engine);

  /// The engines it runs a Product Manager with, best first.
  List<String> get leadEngines => [
    for (final engine in swarmLeadEngines)
      if (runs(engine)) engine,
  ];

  /// The engine its Product Manager starts with: the first it runs.
  String? get engine => leadEngines.firstOrNull;

  /// It runs with [engine] in that Mac's Harness Team account.
  bool inTeam(String engine) => teamEngines?.contains(engine) ?? team;

  /// It can start a Product Manager now.
  bool get startable =>
      unavailable == null && online && freeAgents > 0 && leadEngines.isNotEmpty;

  /// Its line under its name, in words: why it cannot take the Product
  /// Manager, or the engine it starts it with and its room (Desktop's
  /// `leadMachineDetail`).
  String get detail {
    if (unavailable case final why?) return why;
    if (!online) return 'Offline';
    if (leadEngines.isEmpty) {
      // One reason for both engines (a paused or offline machine) said once.
      return 'Can’t run a Product Manager: '
          '${{for (final engine in swarmLeadEngines) ?engineRefusals[engine]}.join(', ')}';
    }
    final engine = this.engine!;
    return [
      swarmLeadEngineLabel(engine),
      freeAgents <= 0
          ? 'No agents free'
          : '$freeAgents ${freeAgents == 1 ? 'agent' : 'agents'} free',
      if (freeAgents > 0 && inTeam(engine)) 'Team account',
      if (freeAgents > 0 && maySleep) 'May sleep',
    ].join(' · ');
  }
}

/// Why each of [swarmLeadEngines] cannot run a Product Manager on a machine,
/// from what the Swarm reads of it: the engines it offers ([offered], null when
/// not reported), each engine's install and sign-in ([readiness], null for not
/// known), its subscription windows' use ([usedPercents]) and the engines the
/// server suspended there ([suspended], with why). What is not known rules
/// nothing out (Desktop's `leadEngineRefusals`).
Map<String, String> swarmLeadEngineRefusals({
  Set<String>? offered,
  Map<String, ({bool? installed, bool? signedIn})> readiness = const {},
  Map<String, List<num>> usedPercents = const {},
  Map<String, String> suspended = const {},
}) {
  String? refusal(String engine) {
    final label = swarmLeadEngineLabel(engine);
    if (offered != null && !offered.contains(engine)) {
      return '$label isn’t offered here';
    }
    if (readiness[engine]?.installed == false) return '$label isn’t installed';
    if (readiness[engine]?.signedIn == false) return '$label isn’t signed in';
    if ((usedPercents[engine] ?? const []).any((used) => used >= 100)) {
      return '$label has no quota left until it resets';
    }
    return suspended[engine];
  }

  return {for (final engine in swarmLeadEngines) engine: ?refusal(engine)};
}

/// The engines the Swarm's model list ([policy], its routing policy) has no
/// enabled model of, with why: none of them may run a new project's Product
/// Manager (Desktop's `LeadModelList.engineRefusal`). Null or unread rules
/// nothing out.
Map<String, String> swarmLeadModelListRefusals(Map<String, dynamic>? policy) {
  final byEngine = <String, bool>{};
  for (final row in policy?['models'] as List? ?? const []) {
    if (row case {'engine': final String engine, 'enabled': final bool on}) {
      byEngine[engine] = (byEngine[engine] ?? false) || on;
    }
  }
  return {
    for (final MapEntry(:key, :value) in byEngine.entries)
      if (!value && swarmLeadEngines.contains(key))
        key:
            'The Swarm’s model list has no enabled '
            '${const {'claude': 'Claude', 'codex': 'Codex'}[key]} model',
  };
}

/// The Swarm's machines a new project's Product Manager could start on, one
/// row per computer, best first: Desktop's `leadMachinesOf`, where every start
/// is the Swarm's (`lead.start`), never the phone's. The person's own machine
/// takes it when its Harness can start one and an engine runs there; a
/// teammate's as the server decided for each engine (backend leadStart.ts
/// `leadChoices`), or, from a server that does not say, its Harness Team
/// account or the Mac itself as Desktop reads them. [modelList] rules engines
/// out everywhere ([swarmLeadModelListRefusals]).
List<SwarmLeadMachine> swarmLeadMachines(
  SuperTabSnapshot snapshot,
  String accountId, {
  required DateTime now,
  Map<String, String> modelList = const {},
}) {
  Map<String, dynamic> part(Object? value) =>
      value is Map ? superTabMap(value) : const {};
  bool fresh(Map<String, dynamic> observation) =>
      switch (observation['receivedAt']) {
        final num at =>
          now.difference(DateTime.fromMillisecondsSinceEpoch(at.toInt())) <=
              _freshFor,
        _ => false,
      };
  bool hostsLead(Map<String, dynamic> observation) =>
      (observation['capabilities'] as List?)?.contains('leadStart') == true;

  SwarmLeadMachine row(String id, Map<String, dynamic> pool) {
    final reading = snapshot.readingPoolOf(id, accountId) ?? pool;
    final observation = part(reading['observation']);
    final name = _machineName(pool['name'] as String? ?? id);
    final own = pool['contributorId'] == accountId;
    final capable = hostsLead(observation);
    // Another person's Mac runs one in its Harness Team account when that
    // takes it now, else itself.
    final teamReading =
        !own &&
        (reading['hostMachineId'] != null ||
            observation['sessionKind'] == 'team');
    final teamRefusal = !teamReading
        ? null
        : switch (reading['teamWork']) {
            {'allowed': false, 'reason': final String reason} => reason,
            _ when !capable =>
              'Update Harness on $name to run a Product Manager there.',
            _ => null,
          };
    final team =
        teamReading &&
        teamRefusal == null &&
        fresh(observation) &&
        reading['paused'] != true;
    final mac = part(pool['observation']);
    // A Mac added as its person joined takes teammates' work only in its
    // Team account (backend machines.ts teamAccountOnly).
    final macTakes =
        pool['teamAccountOnly'] != true &&
        pool['hostMachineId'] == null &&
        mac['sessionKind'] != 'team' &&
        hostsLead(mac);
    // On a teammate's machine the server decides, by engine, where it runs,
    // as the start itself does.
    final decided = <String, String>{}, refused = <String, String>{};
    if (!own && pool['lead'] is Map) {
      for (final MapEntry(:key, :value) in superTabMap(pool['lead']).entries) {
        switch (value) {
          case {'machineId': final String machine}:
            decided[key] = machine;
          case {'refused': final String why}:
            // Its line adds its own full stop.
            refused[key] = why.endsWith('.')
                ? why.substring(0, why.length - 1)
                : why;
        }
      }
    }
    final server = decided.isNotEmpty || refused.isNotEmpty;
    final shownHost = [for (final engine in swarmLeadEngines) ?decided[engine]]
        .firstOrNull;
    // Where it would run: the server's machine for its first engine that
    // runs; else the Mac itself when its Team account cannot.
    final host = server
        ? (shownHost == null ? pool : snapshot.pool(shownHost) ?? pool)
        : teamReading && !team
        ? pool
        : reading;
    final hostReading = part(host['observation']);
    final running = hostReading['runningHarnessIds'];
    final max = host['maxAgents'];
    final device = part(hostReading['resources'])['deviceType'];
    final engineRefusals = {
      ...server
          ? {
              for (final engine in swarmLeadEngines)
                if (refused[engine] ?? (decided[engine] == null ? '' : null)
                    case final why?)
                  engine: why.isEmpty ? 'Not offered by this Swarm' : why,
            }
          : swarmLeadEngineRefusals(
              offered: switch (host['engines']) {
                final List engines => engines.whereType<String>().toSet(),
                _ => null,
              },
              readiness: {
                for (final raw
                    in part(hostReading['readiness'])['engines'] as List? ??
                        const [])
                  if (part(raw)
                      case {'engine': final String engine} && final row)
                    engine: (
                      installed: row['installed'] as bool?,
                      signedIn: row['signedIn'] as bool?,
                    ),
              },
              usedPercents: {
                for (final raw in hostReading['quotas'] as List? ?? const [])
                  if (part(raw) case {
                    'engine': final String engine,
                    'known': true,
                    'windows': final List windows,
                  })
                    engine: [
                      for (final window in windows)
                        if (part(window)['usedPercent'] case final num used)
                          used,
                    ],
              },
              suspended: {
                for (final source in {pool, host})
                  if (source['suspendedEngines'] case final Map raw)
                    for (final MapEntry(:key, :value) in raw.entries)
                      if ((key, value) case (
                        final String engine,
                        final String why,
                      ))
                        engine: why,
              },
            ),
      // The Swarm's model list rules an engine out wherever it would run.
      for (final MapEntry(:key, :value) in modelList.entries)
        if (swarmLeadEngines.contains(key)) key: value,
    };
    return SwarmLeadMachine(
      id: id,
      name: name,
      online: fresh(hostReading),
      // The server's count holds pending starts and the Team account sharing
      // a Mac; a server without it: slots minus running.
      freeAgents: switch (host['availableSlots']) {
        final num slots => math.max(0, slots.toInt()),
        _ => math.max(
          0,
          (max is num ? max.toInt() : 0) -
              (running is List ? running.length : 0),
        ),
      },
      own: own,
      maySleep:
          device is String && device.trim().toLowerCase().startsWith('macbook'),
      team: server ? shownHost != null && shownHost != id : team,
      teamEngines: server
          ? {
              for (final MapEntry(:key, :value) in decided.entries)
                if (value != id) key,
            }
          : null,
      engineRefusals: engineRefusals,
      unavailable: snapshot.paused
          ? swarmLeadSwarmPaused
          // The Swarm starts it on the person's own machine too: its Harness
          // must be able to (backend leadStart.ts `admitLead`).
          : own
          ? (pool['paused'] == true
                ? 'Paused in this Swarm'
                : capable
                ? null
                : 'Update Harness on $name to run a Product Manager there.')
          // The server's reasons are each engine's (engineRefusals).
          : server
          ? null
          : host['paused'] == true
          ? 'Paused in this Swarm'
          : team || macTakes
          ? null
          : teamRefusal ??
                switch (pool['teamWork']) {
                  {'allowed': false, 'reason': final String reason} => reason,
                  _ =>
                    'Update Harness on $name to run a Product Manager there.',
                },
    );
  }

  final machines = [
    for (final pool in snapshot.machines)
      if (pool['machineId'] case final String id
          when snapshot.placeOf(id) == id && pool['removal'] == null)
        row(id, pool),
  ];
  // Best first: one that can start it now (the person's own first, those
  // that stay on before laptops, the most room), then full ones, then the
  // ones that cannot, then offline ones (Desktop's `rankLeadMachines`).
  int tier(SwarmLeadMachine m) => m.startable
      ? 0
      : m.unavailable == null && m.online && m.leadEngines.isNotEmpty
      ? 1
      : m.online
      ? 2
      : 3;
  int flag(bool value) => value ? 0 : 1;
  return machines..sort(
    (a, b) => [
      tier(a).compareTo(tier(b)),
      flag(a.own).compareTo(flag(b.own)),
      flag(!a.maySleep).compareTo(flag(!b.maySleep)),
      b.freeAgents.compareTo(a.freeAgents),
      a.name.toLowerCase().compareTo(b.name.toLowerCase()),
    ].firstWhere((order) => order != 0, orElse: () => 0),
  );
}

/// Why the Product Manager cannot start on [machineId] now, in words that
/// say what to do; null when it can (Desktop's `checkLeadMachine`).
String? swarmLeadMachineRefusal(
  List<SwarmLeadMachine> machines,
  String machineId,
) {
  final chosen = machines.where((m) => m.id == machineId).firstOrNull;
  if (chosen == null) return 'Choose one of this Swarm’s machines.';
  if (chosen.startable) return null;
  final name = chosen.name;
  return chosen.unavailable != null
      ? '$name: ${chosen.unavailable}. Choose another machine.'
      : !chosen.online
      ? '$name is offline. Choose another machine.'
      : chosen.leadEngines.isEmpty
      ? '$name: ${chosen.detail}. Choose another machine.'
      : '$name has no free agents. Choose another machine.';
}

/// A machine's name without its `.local`, as Desktop shows it.
String _machineName(String name) {
  const suffix = '.local';
  return name.length > suffix.length && name.toLowerCase().endsWith(suffix)
      ? name.substring(0, name.length - suffix.length)
      : name;
}

/// One repository however its address is spelled: `host/owner/name`, lower
/// case, without scheme, user, `.git` or trailing slash; null for none
/// (Desktop's `leadRepositoryKey`).
String? swarmRepositoryKey(String? remote) {
  var value = remote?.trim().toLowerCase() ?? '';
  if (value.isEmpty) return null;
  value = value.replaceFirst(RegExp(r'^[a-z+]+://'), '');
  value = value.replaceFirst(RegExp(r'^[^@/]+@'), '');
  // scp-like `host:owner/name`.
  value = value.replaceFirstMapped(
    RegExp(r'^([^/:]+):(?!\d)'),
    (m) => '${m[1]}/',
  );
  value = value.replaceFirst(RegExp(r'/+$'), '');
  value = value.replaceFirst(RegExp(r'\.git$'), '');
  return value.isEmpty ? null : value;
}

/// A repository's name as a project takes it: the last part of its address,
/// without `.git`.
String swarmRepositoryName(String url) {
  final key = swarmRepositoryKey(url) ?? url;
  final name = key.split('/').where((part) => part.isNotEmpty).lastOrNull;
  return name == null || name.isEmpty ? 'New project' : name;
}

/// Whether the server takes [value] as a project's repository: a git or web
/// address with a host and no credentials, or `git@host:path` (backend
/// commands.ts `repositoryUrl`). Never stricter in what it lets through.
bool swarmRepositoryUrlValid(String value) {
  if (value.isEmpty || value.length > 4096) return false;
  if (RegExp(r'[\x00-\x20\x7f]').hasMatch(value)) return false;
  if (RegExp(r'^git@[^/@:]+:[^@]+$').hasMatch(value)) return true;
  final uri = Uri.tryParse(value);
  if (uri == null || !uri.hasScheme || uri.host.isEmpty) return false;
  if (!const {'https', 'http', 'ssh', 'git'}.contains(uri.scheme)) {
    return false;
  }
  final user = uri.userInfo;
  final colon = user.indexOf(':');
  final username = colon < 0 ? user : user.substring(0, colon);
  final password = colon < 0 ? '' : user.substring(colon + 1);
  if (password.isNotEmpty) return false;
  return username.isEmpty || (uri.scheme == 'ssh' && username == 'git');
}

/// The address a typed link stands for, or null when the server would refuse
/// it: trimmed, and `github.com/owner/name` read as its https address, as
/// Desktop reads a checkout's remote.
String? swarmRepositoryLink(String typed) {
  final value = typed.trim();
  final link = value.toLowerCase().startsWith('github.com/')
      ? 'https://$value'
      : value;
  return swarmRepositoryUrlValid(link) ? link : null;
}

/// The repositories of the projects [reader] reads in its Swarm, once each,
/// the most recently active project's first: what New project offers, with
/// the first chosen for the person (Lead's ruling, 10-30). Only projects the
/// person may read are in a read, so no other project's repository shows.
List<String> swarmProjectRepositories(SwarmReader reader) {
  final snapshot = reader.snapshot;
  if (snapshot == null) return const [];
  final activity = swarmProjectActivity(snapshot, reader.buddies);
  final never = DateTime.fromMillisecondsSinceEpoch(0, isUtc: true);
  final projects = [...snapshot.projects]
    ..sort(
      (a, b) => (activity[b.id] ?? never).compareTo(activity[a.id] ?? never),
    );
  final seen = <String>{};
  return [
    for (final project in projects)
      if (project.repository?['repositoryUrl'] case final String url
          when swarmRepositoryUrlValid(url) &&
              seen.add(swarmRepositoryKey(url) ?? url))
        url,
  ];
}

/// A step of New project stopped because the sheet that asked for it went:
/// its Swarm, the person's access or their account. Nothing more is sent.
class SwarmNewProjectGone implements Exception {
  const SwarmNewProjectGone();
}

/// One New project's steps in one Swarm, as Desktop's `startInSwarm` runs
/// them: the project, its brief in its chat, its Product Manager's start on
/// the machine picked, then its name. Each request is kept as first sent,
/// under one operation id, for as long as the sheet is open: Create again
/// repeats only what has not answered, and the Swarm answers a repeated
/// operation with its receipt, so a lost answer never makes a second project.
/// Only a definite refusal drops a request, so the next attempt (perhaps on
/// another machine) is a new one.
class SwarmNewProjectSteps {
  SwarmNewProjectSteps(this.reader);

  final SwarmReader reader;

  Map<String, dynamic>? _create, _brief, _start;
  String? _projectId, _conversationId;
  bool _briefPosted = false, _started = false, _named = false;

  /// The project exists: its Swarm, brief and visibility are what it was
  /// made with.
  String? get projectId => _projectId;

  /// Its creation was asked for: Swarm, brief and visibility stay as sent.
  bool get sent => _create != null || _projectId != null;

  /// A start was sent and has not answered: a retry repeats it as it is.
  bool get starting => _start != null && !_started;

  /// The machine of the start under way, if any.
  String? get startMachine =>
      superTabMap(_start?['command'] ?? const {})['machineId'] as String?;

  /// The repository of the start under way, if any.
  String? get startRepository =>
      superTabMap(_start?['command'] ?? const {})['repositoryUrl'] as String?;

  /// Runs what is left: creates the project with [brief] and [visibility],
  /// posts [brief] in its chat, starts its Product Manager on [machineId]
  /// with the repository [repositoryUrl], then names it after that
  /// repository. Answers the project's id once all of it is done and read.
  /// [live] is asked after every answer: once it says no, nothing more is
  /// sent and [SwarmNewProjectGone] is thrown. [machinesOf] lists the
  /// machines from a fresh read before a start is first sent, as Desktop
  /// checks the machine again: one that can no longer take it is refused
  /// with why, and nothing is sent.
  Future<String> run({
    required String brief,
    required String visibility,
    required String machineId,
    required String repositoryUrl,
    required bool Function() live,
    required List<SwarmLeadMachine> Function(SuperTabSnapshot snapshot)
    machinesOf,
  }) async {
    void check() {
      if (!live()) throw const SwarmNewProjectGone();
    }

    final text = String.fromCharCodes(
      brief.trim().runes.take(swarmNewProjectBriefRunes),
    ).trim();
    if (_projectId == null) {
      _create ??= {
        'operationId': superTabOperationId(),
        'command': {
          'type': 'project.create',
          'name': 'New project',
          'visibility': visibility,
          'brief': text,
        },
      };
      final result = await _send(() => _create, (v) => _create = v);
      check();
      final (projectId, conversationId) = switch (result) {
        {
          'projectId': final String project,
          'conversationId': final String conversation,
        } =>
          (project, conversation),
        _ => throw const FormatException('The Swarm did not name the project.'),
      };
      _projectId = projectId;
      _conversationId = conversationId;
      // In Home's list at once, while its Product Manager starts.
      unawaited(reader.refresh());
    }
    final projectId = _projectId!;
    if (!_briefPosted && text.isNotEmpty) {
      _brief ??= {
        'operationId': superTabOperationId(),
        'command': {
          'type': 'message.send',
          'conversationId': _conversationId,
          'text': text,
          'replyTo': null,
          'recipientIds': const <String>[],
        },
      };
      await _send(() => _brief, (v) => _brief = v);
      check();
      _briefPosted = true;
    }
    if (!_started) {
      if (_start == null) {
        // The list from when the sheet drew it may be stale: read the Swarm
        // again, and send nothing to a machine that cannot take it now.
        final reads = reader.reads.value;
        await reader.refresh();
        check();
        final snapshot = reader.snapshot;
        if (reader.reads.value == reads || snapshot == null) {
          throw const SuperTabFailure(
            'SWARM_UNREADABLE',
            'Couldn’t check the machine for the Product Manager: the Swarm '
                'didn’t answer. Try again.',
          );
        }
        final machines = machinesOf(snapshot);
        if (swarmLeadMachineRefusal(machines, machineId) case final why?) {
          throw SuperTabFailure('MACHINE_UNAVAILABLE', why);
        }
        final machine = machines.firstWhere((m) => m.id == machineId);
        _start = {
          'operationId': superTabOperationId(),
          'command': {
            'type': 'lead.start',
            'projectId': projectId,
            'machineId': machineId,
            // No model: the Swarm fills its role's default where the owner's
            // model list and rules allow it (backend commands.ts lead.start).
            'engine': machine.engine,
            'repositoryUrl': repositoryUrl,
          },
        };
      }
      await _send(() => _start, (v) => _start = v);
      check();
      _started = true;
    }
    if (!_named) {
      await _send(
        () => {
          'operationId':
              '${superTabMap(_create ?? const {})['operationId'] ?? projectId}-name',
          'command': {
            'type': 'project.rename',
            'projectId': projectId,
            'name': swarmRepositoryName(startRepository ?? repositoryUrl),
          },
        },
        (_) {},
      );
      check();
      _named = true;
    }
    // Read before the project opens, so its screen finds it: once more when
    // the read joined was asked before the project was.
    for (
      var i = 0;
      i < 2 && reader.snapshot?.projectById(projectId) == null;
      i++
    ) {
      await reader.refresh();
      check();
    }
    return projectId;
  }

  /// Sends the request [held] holds exactly as it was first written and
  /// answers its result. A definite refusal drops it ([drop] with null).
  Future<Map<String, dynamic>> _send(
    Map<String, dynamic>? Function() held,
    void Function(Map<String, dynamic>? value) drop,
  ) async {
    final request = held()!;
    try {
      final answer = superTabMap(
        await reader.request(
          'POST',
          '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
          body: request,
        ),
      );
      return answer['result'] is Map ? superTabMap(answer['result']) : const {};
    } on SuperTabFailure catch (failure) {
      if (_refusedOutright(failure)) drop(null);
      rethrow;
    }
  }

  /// The Swarm said no and wrote nothing: a 4xx answer other than a timeout
  /// or a rate limit. A transport failure or a 5xx may have been committed.
  static bool _refusedOutright(SuperTabFailure failure) =>
      failure.statusCode >= 400 &&
      failure.statusCode < 500 &&
      failure.statusCode != 408 &&
      failure.statusCode != 429;
}

/// Swarm Home's last Projects row, in a project row's shape: a plus, then
/// "New project". Shown only to someone who may write in a Swarm Home shows
/// ([swarmMayCreateProject]).
class SwarmNewProjectRow extends StatelessWidget {
  const SwarmNewProjectRow({super.key, required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: 'New project',
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () {
            HapticFeedback.selectionClick();
            onTap();
          },
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: SwarmRow.height),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpace.l,
                vertical: AppSpace.m,
              ),
              child: Row(
                children: [
                  SizedBox(
                    width: 16,
                    child: Icon(
                      LucideIcons.plus300,
                      size: 18,
                      color: AppPalette.textSecondary,
                    ),
                  ),
                  const SizedBox(width: AppSpace.s),
                  Expanded(
                    child: Text(
                      'New project',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppType.label(
                        color: AppPalette.textSecondary,
                        height: 1.3,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A project New project made: the Swarm, and the project.
typedef SwarmNewProject = ({String swarmId, String projectId});

/// New project, from Swarm Home: which Swarm (only when Home shows several,
/// and only those of [swarmIds] the person may write in), the brief, the
/// visibility, the repository and the machine its Product Manager runs on,
/// then Create. Answers the project once it is made and its Product Manager
/// asked to start; null when closed. The Swarm taken away, the person's
/// access to it, or their account, while it is open closes it, and nothing
/// more is sent. [now] is what machine readings are measured from.
Future<SwarmNewProject?> showSwarmNewProjectSheet(
  BuildContext context, {
  required SwarmSession session,
  required List<String> swarmIds,
  DateTime Function() now = DateTime.now,
}) => showModalBottomSheet<SwarmNewProject>(
  context: context,
  isScrollControlled: true,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  builder: (_) =>
      SwarmNewProjectSheet(session: session, swarmIds: swarmIds, now: now),
);

/// What [showSwarmNewProjectSheet] shows.
class SwarmNewProjectSheet extends StatefulWidget {
  const SwarmNewProjectSheet({
    super.key,
    required this.session,
    required this.swarmIds,
    this.now = DateTime.now,
  });

  final SwarmSession session;
  final List<String> swarmIds;
  final DateTime Function() now;

  @override
  State<SwarmNewProjectSheet> createState() => _SwarmNewProjectSheetState();
}

/// What the sheet shows in place of its form: one of its choices' lists.
enum _Pick { swarm, visibility, repository, link, machine }

class _SwarmNewProjectSheetState extends State<SwarmNewProjectSheet> {
  final _brief = TextEditingController();
  final _link = TextEditingController();
  String? _swarmId;
  String _visibility = 'public';

  /// The repository the person chose; until then, the Swarm's first
  /// ([swarmProjectRepositories]).
  String? _repository;
  bool _repositoryPicked = false;
  String? _machineId;
  _Pick? _picking;
  String? _linkError;

  /// The steps sent in the Swarm picked: kept while the sheet is open.
  SwarmNewProjectSteps? _steps;
  bool _busy = false;
  String? _error;

  /// The model list of the Swarm [_policySwarm], once read.
  Map<String, String> _modelList = const {};
  String? _policySwarm;
  int _policyReads = 0;

  bool _closing = false;
  SwarmSession? _scoped;

  SwarmInbox get _inbox => widget.session.inbox;

  List<String> get _writable => [
    for (final id in widget.swarmIds)
      if (swarmMayCreateProject(_inbox, id)) id,
  ];

  @override
  void initState() {
    super.initState();
    _swarmId = _writable.firstOrNull;
    if (_swarmId case final id?) unawaited(_readModelList(id));
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _scoped = SwarmScope.of(context);
  }

  @override
  void dispose() {
    _brief.dispose();
    _link.dispose();
    super.dispose();
  }

  /// The sheet still stands for [swarmId]: open, the account's session the
  /// same, and the person still able to write in it.
  bool _live(String swarmId, SwarmReader reader) =>
      mounted &&
      !_closing &&
      _scoped == widget.session &&
      identical(_inbox.reader(swarmId), reader) &&
      swarmMayCreateProject(_inbox, swarmId);

  /// Reads Swarm [swarmId]'s model list. Unread, nothing is ruled out by it;
  /// an answer for a Swarm no longer picked is dropped.
  Future<void> _readModelList(String swarmId) async {
    final reader = _inbox.reader(swarmId);
    if (reader == null) return;
    final read = ++_policyReads;
    Map<String, String> refusals = const {};
    try {
      final answer = superTabMap(
        await reader.request(
          'GET',
          '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/routing-policy',
        ),
      );
      refusals = swarmLeadModelListRefusals(
        answer['policy'] is Map ? superTabMap(answer['policy']) : null,
      );
    } catch (_) {
      // Unread: the start's own checks still apply.
    }
    if (read != _policyReads ||
        _swarmId != swarmId ||
        !_live(swarmId, reader)) {
      return;
    }
    setState(() {
      _modelList = refusals;
      _policySwarm = swarmId;
    });
  }

  /// Closes the sheet once, after the frame it went blank in.
  void _close() {
    if (_closing) return;
    _closing = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      if (route.isCurrent) {
        Navigator.of(context).pop();
      } else {
        Navigator.of(context).removeRoute(route);
      }
    });
  }

  List<SwarmLeadMachine> _machinesOf(
    String swarmId,
    SuperTabSnapshot snapshot,
  ) => swarmLeadMachines(
    snapshot,
    widget.session.inbox.reader(swarmId)?.accountId ?? '',
    now: widget.now(),
    modelList: _policySwarm == swarmId ? _modelList : const {},
  );

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final readers = [for (final id in widget.swarmIds) ?_inbox.reader(id)];
    return ListenableBuilder(
      listenable: Listenable.merge([widget.session, _inbox, ...readers]),
      builder: (context, _) {
        final writable = _writable;
        final swarmId = _swarmId;
        // Signed out, another account, or the Swarm picked no longer the
        // person's to write in: nothing of it stays, and the sheet goes.
        if (_closing ||
            SwarmScope.of(context) != widget.session ||
            swarmId == null ||
            !writable.contains(swarmId)) {
          _close();
          return const SizedBox.shrink();
        }
        final reader = _inbox.reader(swarmId)!;
        final snapshot = reader.snapshot!;
        final insets = MediaQuery.viewInsetsOf(context).bottom;
        return Padding(
          padding: EdgeInsets.only(bottom: insets),
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(context).height * .85 - insets,
            ),
            child: SafeArea(
              top: false,
              child: KeyedSubtree(
                key: const ValueKey('swarm-new-project-sheet'),
                child: switch (_picking) {
                  null => _form(context, writable, swarmId, reader, snapshot),
                  final pick => _pick(
                    context,
                    pick,
                    writable,
                    swarmId,
                    reader,
                    snapshot,
                  ),
                },
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _frame({required Widget header, required List<Widget> children}) =>
      ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(
          AppSpace.l,
          AppSpace.s,
          AppSpace.l,
          AppSpace.l,
        ),
        children: [
          // The grabber: a capsule as wide as the two largest steps.
          Center(
            child: Container(
              width: AppSpace.xl + AppSpace.m,
              height: AppSpace.xs,
              margin: const EdgeInsets.only(bottom: AppSpace.s),
              decoration: ShapeDecoration(
                color: AppGlass.hair,
                shape: const StadiumBorder(),
              ),
            ),
          ),
          header,
          ...children,
        ],
      );

  /// The sheet's title row: [leading] at its left, [title] in the middle.
  Widget _header(String title, Widget leading) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpace.s),
    child: Row(
      children: [
        leading,
        Expanded(
          child: Text(
            title,
            textAlign: TextAlign.center,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppType.heading(color: AppPalette.textPrimary),
          ),
        ),
        // As wide as [leading], so the title stays in the middle.
        const SizedBox(width: 44),
      ],
    ),
  );

  Widget _form(
    BuildContext context,
    List<String> writable,
    String swarmId,
    SwarmReader reader,
    SuperTabSnapshot snapshot,
  ) {
    final steps = _steps;
    final machines = _machinesOf(swarmId, snapshot);
    final repositories = swarmProjectRepositories(reader);
    final repository =
        steps?.startRepository ??
        (_repositoryPicked ? _repository : repositories.firstOrNull);
    final machineId = steps?.startMachine ?? _machineId;
    final machine = machines.where((m) => m.id == machineId).firstOrNull;
    final sent = steps?.sent ?? false;
    final starting = steps?.starting ?? false;
    final blocked = _blocked(snapshot, machines, machine, repository);
    final swarmName =
        _inbox.swarms.where((s) => s.id == swarmId).firstOrNull?.name ??
        snapshot.name;
    return _frame(
      header: _header(
        'New project',
        SwarmIconButton(
          key: const ValueKey('swarm-new-project-close'),
          icon: LucideIcons.x300,
          label: 'Close',
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      children: [
        if (writable.length > 1 || widget.swarmIds.length > 1) ...[
          SwarmGroup(
            children: [
              _Field(
                key: const ValueKey('swarm-new-project-swarm'),
                label: 'Swarm',
                value: swarmName,
                onTap: sent || _busy
                    ? null
                    : () => setState(() => _picking = _Pick.swarm),
              ),
            ],
          ),
          const SizedBox(height: AppSpace.m),
        ],
        TextField(
          key: const ValueKey('swarm-new-project-brief'),
          controller: _brief,
          enabled: !sent && !_busy,
          minLines: 3,
          maxLines: 6,
          textCapitalization: TextCapitalization.sentences,
          inputFormatters: const [_RuneLimit(swarmNewProjectBriefRunes)],
          style: AppType.body(color: AppPalette.textPrimary),
          decoration: InputDecoration(
            hintText: 'What should this project work on? (optional)',
            hintStyle: TextStyle(color: AppPalette.textFaint),
            filled: true,
            fillColor: AppPalette.swarmField,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AppControl.radius),
              borderSide: BorderSide.none,
            ),
          ),
        ),
        const SizedBox(height: AppSpace.m),
        SwarmGroup(
          children: [
            _Field(
              key: const ValueKey('swarm-new-project-visibility'),
              label: 'Visibility',
              value: _visibility == 'private' ? 'Private' : 'Public',
              onTap: sent || _busy
                  ? null
                  : () => setState(() => _picking = _Pick.visibility),
            ),
            // Just above PM runs on, chosen for the person (Lead, 10-30).
            _Field(
              key: const ValueKey('swarm-new-project-repository'),
              label: 'Repository',
              value: repository == null
                  ? 'Choose'
                  : swarmRepositoryName(repository),
              detail: repository == null
                  ? null
                  : swarmRepositoryKey(repository),
              onTap: starting || _busy
                  ? null
                  : () => setState(() => _picking = _Pick.repository),
            ),
            _Field(
              key: const ValueKey('swarm-new-project-machine'),
              label: 'PM runs on',
              value: machine?.name ?? 'Choose',
              detail: machine?.detail,
              onTap: starting || _busy
                  ? null
                  : () => setState(() => _picking = _Pick.machine),
            ),
          ],
        ),
        if (_error case final error?)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.m,
              AppSpace.xs,
              0,
            ),
            child: SwarmRow.line(
              error,
              key: const ValueKey('swarm-new-project-error'),
              lines: 4,
              color: AppColors.danger,
            ),
          )
        else if (blocked case final why?)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.m,
              AppSpace.xs,
              0,
            ),
            child: SwarmRow.line(
              why,
              key: const ValueKey('swarm-new-project-note'),
              lines: 3,
            ),
          ),
        const SizedBox(height: AppSpace.l),
        SwarmButton(
          key: const ValueKey('swarm-new-project-create'),
          label: _error == null ? 'Create' : 'Try again',
          style: SwarmButtonStyle.fill,
          wide: true,
          busy: _busy,
          busyLabel: 'Creating…',
          onPressed:
              blocked == null &&
                  repository != null &&
                  machineId != null &&
                  (machine != null || starting)
              ? () => unawaited(_create(swarmId, reader, repository, machineId))
              : null,
        ),
      ],
    );
  }

  /// Why Create cannot be pressed now, or null (Desktop's `leadBlocked`).
  String? _blocked(
    SuperTabSnapshot snapshot,
    List<SwarmLeadMachine> machines,
    SwarmLeadMachine? machine,
    String? repository,
  ) {
    if (snapshot.paused) {
      return '$swarmLeadSwarmPaused. New project can start once it resumes.';
    }
    if (repository == null) {
      return 'Choose the repository this project works in.';
    }
    // A start under way is repeated as it was sent, whatever the list says.
    if (_steps?.starting ?? false) return null;
    if (!machines.any((m) => m.startable)) return swarmLeadNoMachine;
    if (machine == null) return swarmLeadChooseMachine;
    if (!machine.startable) {
      return '${machine.name} cannot start the Product Manager. '
          'Choose another machine.';
    }
    return null;
  }

  Future<void> _create(
    String swarmId,
    SwarmReader reader,
    String repository,
    String machineId,
  ) async {
    if (_busy) return;
    final steps = _steps ??= SwarmNewProjectSteps(reader);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final projectId = await steps.run(
        brief: _brief.text,
        visibility: _visibility,
        machineId: machineId,
        repositoryUrl: repository,
        live: () => _live(swarmId, reader),
        machinesOf: (snapshot) => _machinesOf(swarmId, snapshot),
      );
      if (!mounted || !_live(swarmId, reader)) return;
      _closing = true;
      Navigator.of(context).pop((swarmId: swarmId, projectId: projectId));
    } on SwarmNewProjectGone {
      // The sheet goes by itself: its Swarm, access or account went.
    } on SuperTabFailure catch (failure) {
      _fail(swarmId, reader, steps, failure.message);
    } catch (_) {
      _fail(swarmId, reader, steps, 'The Swarm didn’t answer. Try again.');
    } finally {
      if (mounted && !_closing) setState(() => _busy = false);
    }
  }

  /// Says why the last Create stopped; once the project exists, that it
  /// stays, as Desktop leaves it in the list.
  void _fail(
    String swarmId,
    SwarmReader reader,
    SwarmNewProjectSteps steps,
    String why,
  ) {
    if (!_live(swarmId, reader)) return;
    setState(
      () => _error = steps.projectId == null
          ? 'Couldn’t create the project: $why'
          : 'The project is made. Its Product Manager didn’t start: $why',
    );
  }

  Widget _pick(
    BuildContext context,
    _Pick pick,
    List<String> writable,
    String swarmId,
    SwarmReader reader,
    SuperTabSnapshot snapshot,
  ) {
    void back() => setState(() {
      _picking = pick == _Pick.link ? _Pick.repository : null;
      _linkError = null;
    });
    final header = _header(
      switch (pick) {
        _Pick.swarm => 'Swarm',
        _Pick.visibility => 'Visibility',
        _Pick.repository => 'Repository',
        _Pick.link => 'Enter a link',
        _Pick.machine => 'PM runs on',
      },
      SwarmIconButton(
        key: const ValueKey('swarm-new-project-back'),
        icon: LucideIcons.chevronLeft300,
        size: 24,
        label: 'Back',
        onPressed: back,
      ),
    );
    Widget tick() =>
        Icon(LucideIcons.check300, size: 20, color: AppPalette.swarmAccent);
    switch (pick) {
      case _Pick.swarm:
        return _frame(
          header: header,
          children: [
            SwarmGroup(
              children: [
                for (final id in writable)
                  _Option(
                    key: ValueKey('swarm-new-project-pick-swarm-$id'),
                    leading: SwarmProjectTile(_swarmName(id)),
                    title: _swarmName(id),
                    trailing: id == swarmId ? tick() : null,
                    onTap: () => setState(() {
                      _picking = null;
                      if (id == _swarmId) return;
                      // Another Swarm: its own repositories and machines.
                      _swarmId = id;
                      _steps = null;
                      _error = null;
                      _repository = null;
                      _repositoryPicked = false;
                      _machineId = null;
                      _modelList = const {};
                      _policySwarm = null;
                      unawaited(_readModelList(id));
                    }),
                  ),
              ],
            ),
          ],
        );
      case _Pick.visibility:
        return _frame(
          header: header,
          children: [
            SwarmGroup(
              children: [
                for (final (id, title, line, icon) in [
                  (
                    'public',
                    'Public',
                    'Everyone in this Swarm',
                    LucideIcons.users300,
                  ),
                  (
                    'private',
                    'Private',
                    'Only people you invite to this project',
                    LucideIcons.lock300,
                  ),
                ])
                  _Option(
                    key: ValueKey('swarm-new-project-pick-visibility-$id'),
                    leading: Icon(
                      icon,
                      size: 20,
                      color: AppPalette.textSecondary,
                    ),
                    title: title,
                    detail: line,
                    trailing: id == _visibility ? tick() : null,
                    onTap: () => setState(() {
                      _visibility = id;
                      _picking = null;
                    }),
                  ),
              ],
            ),
          ],
        );
      case _Pick.repository:
        final repositories = swarmProjectRepositories(reader);
        final chosen = _repositoryPicked
            ? _repository
            : repositories.firstOrNull;
        return _frame(
          header: header,
          children: [
            SwarmGroup(
              children: [
                for (final url in {...repositories, ?chosen})
                  _Option(
                    key: ValueKey('swarm-new-project-pick-repo-$url'),
                    leading: Icon(
                      LucideIcons.gitBranch300,
                      size: 20,
                      color: AppPalette.textSecondary,
                    ),
                    title: swarmRepositoryName(url),
                    detail: swarmRepositoryKey(url),
                    trailing: url == chosen ? tick() : null,
                    onTap: () => setState(() {
                      _repository = url;
                      _repositoryPicked = true;
                      _picking = null;
                    }),
                  ),
                _Option(
                  key: const ValueKey('swarm-new-project-pick-link'),
                  leading: Icon(
                    LucideIcons.link300,
                    size: 20,
                    color: AppPalette.textSecondary,
                  ),
                  title: 'Enter a link',
                  onTap: () => setState(() {
                    _picking = _Pick.link;
                    _linkError = null;
                  }),
                ),
              ],
            ),
          ],
        );
      case _Pick.link:
        void use() {
          final link = swarmRepositoryLink(_link.text);
          setState(() {
            if (link == null) {
              _linkError =
                  'Enter a repository link without a password, such as '
                  'https://github.com/owner/name.';
              return;
            }
            _repository = link;
            _repositoryPicked = true;
            _linkError = null;
            _picking = null;
          });
        }
        return _frame(
          header: header,
          children: [
            TextField(
              key: const ValueKey('swarm-new-project-link'),
              controller: _link,
              autofocus: true,
              autocorrect: false,
              enableSuggestions: false,
              keyboardType: TextInputType.url,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => use(),
              style: AppType.body(color: AppPalette.textPrimary),
              decoration: InputDecoration(
                hintText: 'https://github.com/owner/name',
                hintStyle: TextStyle(color: AppPalette.textFaint),
                filled: true,
                fillColor: AppPalette.swarmField,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(AppControl.radius),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
            if (_linkError case final error?)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpace.xs,
                  AppSpace.s,
                  AppSpace.xs,
                  0,
                ),
                child: SwarmRow.line(
                  error,
                  key: const ValueKey('swarm-new-project-link-error'),
                  lines: 3,
                  color: AppColors.danger,
                ),
              ),
            const SizedBox(height: AppSpace.l),
            SwarmButton(
              key: const ValueKey('swarm-new-project-link-use'),
              label: 'Use this link',
              style: SwarmButtonStyle.fill,
              wide: true,
              onPressed: use,
            ),
          ],
        );
      case _Pick.machine:
        final machines = _machinesOf(swarmId, snapshot);
        final startable = machines.where((m) => m.startable).toList();
        return _frame(
          header: header,
          children: [
            if (startable.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpace.xs,
                  0,
                  AppSpace.xs,
                  AppSpace.s,
                ),
                child: SwarmRow.line(
                  snapshot.paused
                      ? '$swarmLeadSwarmPaused.'
                      : machines.isEmpty
                      ? 'This Swarm has no machines yet. Add one from '
                            'Harness on a computer.'
                      : swarmLeadNoMachine,
                  key: const ValueKey('swarm-new-project-no-machine'),
                  lines: 3,
                ),
              ),
            if (machines.isNotEmpty)
              SwarmGroup(
                children: [
                  // Only those that can take it; when none can, each says
                  // why it cannot.
                  for (final m in startable.isEmpty ? machines : startable)
                    _Option(
                      key: ValueKey('swarm-new-project-pick-machine-${m.id}'),
                      leading: Icon(
                        m.maySleep
                            ? LucideIcons.laptop300
                            : LucideIcons.monitor300,
                        size: 20,
                        color: AppPalette.textSecondary,
                      ),
                      title: m.name,
                      detail: m.detail,
                      trailing: m.id == _machineId ? tick() : null,
                      onTap: m.startable
                          ? () => setState(() {
                              _machineId = m.id;
                              _picking = null;
                              _error = null;
                            })
                          : null,
                    ),
                ],
              ),
          ],
        );
    }
  }

  String _swarmName(String id) =>
      _inbox.swarms.where((s) => s.id == id).firstOrNull?.name ??
      _inbox.reader(id)?.snapshot?.name ??
      'Swarm';
}

/// One of the sheet's choices: its [label] at its left, what is chosen at
/// its right with a chevron, and maybe a line under it. Fixed ([onTap] null)
/// once what it chose was sent.
class _Field extends StatelessWidget {
  const _Field({
    super.key,
    required this.label,
    required this.value,
    this.detail,
    required this.onTap,
  });

  final String label, value;
  final String? detail;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final enabled = onTap != null;
    return Semantics(
      button: true,
      enabled: enabled,
      label: '$label: $value',
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: SwarmRow.height),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpace.l,
                vertical: AppSpace.m,
              ),
              child: Row(
                children: [
                  Text(
                    label,
                    style: AppType.label(color: AppPalette.textSecondary),
                  ),
                  const SizedBox(width: AppSpace.m),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          value,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.end,
                          style: AppType.label(
                            color: enabled
                                ? AppPalette.textPrimary
                                : AppPalette.textSecondary,
                            height: 1.3,
                          ),
                        ),
                        if (detail case final detail?) ...[
                          const SizedBox(height: 3),
                          Text(
                            detail,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            textAlign: TextAlign.end,
                            style: AppType.caption(
                              color: AppPalette.textSecondary,
                              height: 1.35,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (enabled) ...[
                    const SizedBox(width: AppSpace.s),
                    Icon(
                      LucideIcons.chevronDown300,
                      size: 18,
                      color: AppPalette.textFaint,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// One choice in one of the sheet's lists: dimmed, and not tappable, when it
/// cannot be chosen ([onTap] null), its line saying why.
class _Option extends StatelessWidget {
  const _Option({
    super.key,
    this.leading,
    required this.title,
    this.detail,
    this.trailing,
    required this.onTap,
  });

  final Widget? leading;
  final String title;
  final String? detail;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final enabled = onTap != null;
    return Semantics(
      button: true,
      enabled: enabled,
      selected: trailing != null,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          child: Opacity(
            opacity: enabled ? 1 : .55,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: SwarmRow.height),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpace.l,
                  vertical: AppSpace.m,
                ),
                child: Row(
                  children: [
                    if (leading case final leading?) ...[
                      leading,
                      const SizedBox(width: AppSpace.m),
                    ],
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppType.label(
                              color: AppPalette.textPrimary,
                              height: 1.3,
                            ),
                          ),
                          if (detail case final detail?) ...[
                            const SizedBox(height: 3),
                            SwarmRow.line(detail, lines: 3),
                          ],
                        ],
                      ),
                    ),
                    if (trailing case final trailing?) ...[
                      const SizedBox(width: AppSpace.m),
                      trailing,
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Keeps a field to [max] runes, cutting a paste rather than refusing it,
/// and never between the two halves of one.
class _RuneLimit extends TextInputFormatter {
  const _RuneLimit(this.max);

  final int max;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    if (newValue.text.runes.length <= max) return newValue;
    final text = String.fromCharCodes(newValue.text.runes.take(max));
    return TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(
        offset: math.min(newValue.selection.extentOffset, text.length),
      ),
    );
  }
}
