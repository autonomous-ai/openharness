import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;
import 'package:harness_mobile/widgets/engine_identity.dart' show EngineMark;

import 'model.dart';
import 'swarm_attach.dart' show SwarmOutgoingChips;
import 'swarm_buddy.dart' show swarmCanWrite;
import 'swarm_choices.dart' show swarmSendsFiles;
import 'swarm_conversation_page.dart' show SwarmAttachButton, attachSwarmFiles;
import 'swarm_home_list.dart' show swarmProjectActivity;
import 'swarm_home_top.dart' show swarmHomeOffers;
import 'swarm_inbox.dart';
import 'swarm_new_repository.dart';
import 'swarm_outgoing_files.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_uploads.dart';

/// New project from the phone (Tony, 10-30): the Swarm switcher's New
/// project row (Home's title, since 2026-11-04) opens a sheet
/// ([showSwarmNewProjectSheet]) that
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

/// Whether Swarm [swarmId] is paused: it takes no new work, so a project
/// made there could not start its Product Manager.
bool swarmNewProjectPaused(SwarmInbox inbox, String swarmId) =>
    inbox.reader(swarmId)?.snapshot?.paused ?? false;

/// The Swarm New project opens on, of [writable] (those that take work
/// first): the one Home showed ([openedFrom]) unless it is paused, else the
/// first that is not (Dee, 11-01: it opened on an old paused Swarm, Create
/// off). All paused: the one Home showed, else the first.
String? swarmNewProjectSwarm(
  List<String> writable, {
  String? openedFrom,
  required bool Function(String swarmId) paused,
}) {
  final from = writable.contains(openedFrom) ? openedFrom : null;
  if (from != null && !paused(from)) return from;
  return writable.where((id) => !paused(id)).firstOrNull ??
      from ??
      writable.firstOrNull;
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

/// Why one of the person's machines added for the Lead only cannot take a
/// project's Product Manager: the server's reason, said to its owner.
const swarmLeadUnscoped =
    'Add this machine to the Swarm again to support other projects.';

/// What the sheet says once Start over lets go of a create never answered:
/// the Swarm may have made the project all the same.
const swarmNewProjectMaybeMade =
    'A project may already have been made. '
    'Check Projects before you create it again.';

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
  String get detail => detailFor(null);

  /// [detail], naming [chosen] as its engine where it runs it.
  String detailFor(String? chosen) {
    if (unavailable case final why?) return why;
    if (!online) return 'Offline';
    if (leadEngines.isEmpty) {
      // One reason for both engines (a paused or offline machine) said once.
      return 'Can’t run a Product Manager: '
          '${{for (final engine in swarmLeadEngines) ?engineRefusals[engine]}.join(', ')}';
    }
    final engine = chosen != null && runs(chosen) ? chosen : this.engine!;
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
/// known) and the engines the server suspended there ([suspended], with why).
/// What is not known rules nothing out, and quota never does: an older
/// server's own refusal shows as the start's error (Desktop's
/// `leadEngineRefusals`).
Map<String, String> swarmLeadEngineRefusals({
  Set<String>? offered,
  Map<String, ({bool? installed, bool? signedIn})> readiness = const {},
  Map<String, String> suspended = const {},
}) {
  String? refusal(String engine) {
    final label = swarmLeadEngineLabel(engine);
    if (offered != null && !offered.contains(engine)) {
      return '$label isn’t offered here';
    }
    if (readiness[engine]?.installed == false) return '$label isn’t installed';
    if (readiness[engine]?.signedIn == false) return '$label isn’t signed in';
    return suspended[engine];
  }

  return {for (final engine in swarmLeadEngines) engine: ?refusal(engine)};
}

/// The engines the Swarm's model list has no enabled model of, with why, from
/// the tab's routing-policy read ([answer]): none of them may run a new
/// project's Product Manager on an older backend, which enforces its list
/// (Desktop's `LeadModelList.engineRefusal`). A backend that sends its
/// `catalog` refuses nothing for the list, so neither does the phone. Null or
/// unread rules nothing out.
Map<String, String> swarmLeadModelListRefusals(Map<String, dynamic>? answer) {
  if (answer == null || answer.containsKey('catalog')) return const {};
  final policy = answer['policy'] is Map ? superTabMap(answer['policy']) : null;
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

/// The model a Claude Product Manager runs when its person chose none: its
/// role's default (Desktop's `kLeadModel`, backend
/// `BUILT_IN_ROLE_DEFAULTS.lead`).
const _leadModel = (model: 'opus', label: 'Opus 5.5', effort: 'xhigh');

/// Whether the Swarm's model list, from the tab's routing-policy read
/// ([answer]), leaves a Claude Product Manager's default model on: that
/// effort's row when the list has one, else any row of the model at an
/// effort; a model it does not name, a backend that sends its `catalog`, or
/// no read, is on (Desktop's `LeadModelList.modelOn`).
bool swarmLeadModelOn(Map<String, dynamic>? answer) {
  if (answer == null || answer.containsKey('catalog')) return true;
  final policy = answer['policy'] is Map ? superTabMap(answer['policy']) : null;
  final named = <String, bool>{};
  for (final row in policy?['models'] as List? ?? const []) {
    if (row
        case {
          'engine': 'claude',
          'model': final String model,
          'effort': final String effort,
          'enabled': final bool on,
        }
        when model == _leadModel.model) {
      named[effort] = (named[effort] ?? false) || on;
    }
  }
  return named.isEmpty ||
      (named[_leadModel.effort] ?? named.values.any((on) => on));
}

/// The model a new project's Product Manager runs on [engine], as New
/// project names it (Desktop's `leadModelLabel`): no model is sent, and the
/// Swarm fills Claude's role default where its model list leaves it on
/// ([leadModelOn]); else the engine runs its own.
String swarmLeadModelLabel(String engine, {bool leadModelOn = true}) =>
    engine == 'claude' && leadModelOn
    ? '${_leadModel.label} · ${_leadModel.effort}'
    : 'Default model';

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
                // Added for the Lead only: the server takes no other
                // project's work there (backend machines.ts
                // admitMachineStart, PROJECT_CONTRIBUTION).
                : pool['scope'] != 'swarm'
                ? swarmLeadUnscoped
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

/// Why the Product Manager cannot start on [machineId] now, with [engine]
/// when the person chose one, in words that say what to do; null when it can
/// (Desktop's `checkLeadMachine`).
String? swarmLeadMachineRefusal(
  List<SwarmLeadMachine> machines,
  String machineId, {
  String? engine,
}) {
  final chosen = machines.where((m) => m.id == machineId).firstOrNull;
  if (chosen == null) return 'Choose one of this Swarm’s machines.';
  final name = chosen.name;
  if (chosen.startable) {
    return switch (engine == null ? null : chosen.engineRefusals[engine]) {
      final why? =>
        '$name can’t run ${swarmLeadEngineLabel(engine!)}: $why. '
            'Choose another engine.',
      null => null,
    };
  }
  if (chosen.unavailable case final why?) {
    // One full stop, whether its reason ends with one or not.
    return '$name: ${why.endsWith('.') ? why : '$why.'} '
        'Choose another machine.';
  }
  return !chosen.online
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

/// The New project steps each Swarm's reader holds until they finish: kept
/// with the session's reader of that Swarm, so they go with the Swarm, the
/// person's access to it or their account, and never outlive the session.
final _heldSteps = Expando<SwarmNewProjectSteps>('New project steps');

/// How long a file of the brief may go up without a byte moving before it is
/// given up, as a chat's (`SwarmConversation.uploadTimeout`'s default).
const _uploadTimeout = Duration(minutes: 2);

/// One New project's steps in one Swarm, as Desktop's `startInSwarm` runs
/// them: the project, its brief and files in its chat, its Product Manager's
/// start on the machine and engine picked, then its name. Each request is
/// kept as first sent, under one operation id, until the steps finish:
/// Create again repeats only what has not answered, and the Swarm answers a
/// repeated operation with its receipt, so a lost answer never makes a second
/// project, and a file that went up never goes up again. Only a definite
/// refusal drops a request, so the next attempt (perhaps on another machine)
/// is a new one. The Swarm's reader holds them ([SwarmNewProjectSteps.of]):
/// the sheet closed or torn down between steps, opening it again resumes
/// them (Lead's ruling on #2324). Listeners hear the files go up.
class SwarmNewProjectSteps with ChangeNotifier {
  SwarmNewProjectSteps._(this.reader);

  /// The steps [reader]'s Swarm holds, or new ones it holds from now on.
  factory SwarmNewProjectSteps.of(SwarmReader reader) =>
      _heldSteps[reader] ??= SwarmNewProjectSteps._(reader);

  /// The steps [reader]'s Swarm holds, if any.
  static SwarmNewProjectSteps? heldBy(SwarmReader reader) => _heldSteps[reader];

  final SwarmReader reader;

  Map<String, dynamic>? _create, _brief, _start;
  String? _projectId, _conversationId;

  /// New repository's request once sent (task #3373): what was asked, the
  /// time that names it and GitHub's sign-in, until its outcome comes back.
  /// A refusal or a failed outcome drops it, so Try again asks afresh.
  ({SwarmNewRepository repository, int at, String authorizeUrl})? _creation;

  /// The repository New repository made is not yet in reach of Harness (F7):
  /// its Product Manager was started all the same.
  bool unreachable = false;
  bool _briefPosted = false, _started = false, _named = false;

  /// The files its brief goes with, as they were when its creation was
  /// asked for.
  List<SwarmOutgoingFile>? _files;

  /// Those files on their way to the project's chat, and the ids of those
  /// already up.
  SwarmUploads? _uploads;

  Future<void>? _running;

  /// The run under way, if any: the next waits for it.
  Future<void>? get running => _running;

  /// What the sheet last chose and last said, to show again when it opens
  /// on these steps. [chosenEngine] is null while the person left the
  /// machine's own.
  String? chosenMachine, chosenRepository, chosenEngine, failure;

  /// New repository, when the sheet chose it in place of [chosenRepository].
  SwarmNewRepository? chosenNewRepository;

  /// The repository New repository waits for: asked, sign-in opened, its
  /// outcome not read yet. Null otherwise.
  SwarmNewRepository? get creating => _started ? null : _creation?.repository;

  /// The time naming the request [creating] waits for.
  int? get creationAt => _started ? null : _creation?.at;

  /// The project exists: its Swarm, brief and visibility are what it was
  /// made with.
  String? get projectId => _projectId;

  /// Its creation was asked for: Swarm, brief, files and visibility stay as
  /// sent.
  bool get sent => _create != null || _projectId != null;

  /// The files its brief goes with, once [sent].
  List<SwarmOutgoingFile> get sentFiles => _files ?? const [];

  /// Whether [file] is on its way to the project's chat.
  bool isUploading(SwarmOutgoingFile file) =>
      _uploads?.isUploading(file) ?? false;

  /// How much of [file] has gone up, from 0 to 1, while it is going up.
  double? uploadProgress(SwarmOutgoingFile file) => _uploads?.progress(file);

  /// Its creation was asked for and never answered: the Swarm may have made
  /// it all the same. A refusal made nothing, and drops the request.
  bool get createUnanswered => _create != null && _projectId == null;

  /// The brief and visibility its creation was asked with, once [sent].
  String? get sentBrief =>
      superTabMap(_create?['command'] ?? const {})['brief'] as String?;
  String? get sentVisibility =>
      superTabMap(_create?['command'] ?? const {})['visibility'] as String?;

  /// A start was sent and has not answered: a retry repeats it as it is.
  bool get starting => _start != null && !_started;

  /// The Swarm took its Product Manager's start: only its name is left.
  bool get started => _started;

  /// A start was sent, answered or not: its machine and repository stay as
  /// sent, whatever the machine's room says now.
  bool get startSent => _start != null;

  /// The machine of the start under way, if any.
  String? get startMachine =>
      superTabMap(_start?['command'] ?? const {})['machineId'] as String?;

  /// The repository of the start under way, if any.
  String? get startRepository =>
      superTabMap(_start?['command'] ?? const {})['repositoryUrl'] as String?;

  /// The engine of the start under way, if any.
  String? get startEngine =>
      superTabMap(_start?['command'] ?? const {})['engine'] as String?;

  /// Done with: the Swarm holds them no more.
  void forget() {
    if (identical(_heldSteps[reader], this)) _heldSteps[reader] = null;
  }

  /// Runs what is left: creates the project with [brief] and [visibility],
  /// posts [brief] in its chat with [files], starts its Product Manager on
  /// [machineId] with [engine] (the machine's first when null) and the
  /// repository [repositoryUrl], then names it after that repository.
  /// Answers the project's id once all of it is done and read. Each answer is
  /// kept before [live] is asked: once it says no, nothing more is sent and
  /// [SwarmNewProjectGone] is thrown, and the next run starts after what was
  /// answered. [machinesOf] lists the machines from a fresh read before a
  /// start is first sent, as Desktop checks the machine again: one that can
  /// no longer take it, or no longer runs [engine], is refused with why, and
  /// nothing is sent. A project made in an earlier run is looked for first,
  /// and one deleted since lets the steps go. A name the Swarm refuses counts
  /// as done. One run at a time: a second waits for the first.
  Future<String> run({
    required String brief,
    required String visibility,
    required String machineId,
    String? repositoryUrl,
    SwarmNewRepository? newRepository,
    String? engine,
    List<SwarmOutgoingFile> files = const [],
    required bool Function() live,
    required List<SwarmLeadMachine> Function(SuperTabSnapshot snapshot)
    machinesOf,
  }) async {
    assert(repositoryUrl != null || newRepository != null);
    for (var running = _running; running != null; running = _running) {
      await running;
    }
    final done = Completer<void>();
    _running = done.future;
    try {
      return await _run(
        brief: brief,
        visibility: visibility,
        machineId: machineId,
        repositoryUrl: repositoryUrl,
        newRepository: newRepository,
        engine: engine,
        files: files,
        live: live,
        machinesOf: machinesOf,
      );
    } finally {
      _running = null;
      done.complete();
    }
  }

  Future<String> _run({
    required String brief,
    required String visibility,
    required String machineId,
    required String? repositoryUrl,
    required SwarmNewRepository? newRepository,
    required String? engine,
    required List<SwarmOutgoingFile> files,
    required bool Function() live,
    required List<SwarmLeadMachine> Function(SuperTabSnapshot snapshot)
    machinesOf,
  }) async {
    void check() {
      if (!live()) throw const SwarmNewProjectGone();
    }

    check();
    final text = String.fromCharCodes(
      brief.trim().runes.take(swarmNewProjectBriefRunes),
    ).trim();
    // Made in an earlier run, it may have been deleted since (from Desktop,
    // say): then these steps are done with, whatever step they stopped at.
    // Unread, the steps left say what is wrong themselves.
    var read = false;
    if (_projectId case final made?) {
      switch (await _deleted(made, check)) {
        case true:
          _gone();
        case false:
          read = true;
        case null:
      }
    }
    if (_projectId == null) {
      if (_create == null) {
        // The files go with the brief it is made with.
        _files = List.unmodifiable(files);
        _create = {
          'operationId': superTabOperationId(),
          'command': {
            'type': 'project.create',
            'name': 'New project',
            'visibility': visibility,
            'brief': text,
          },
        };
      }
      final result = await _send(() => _create, (v) => _create = v);
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
      check();
    }
    final projectId = _projectId!;
    // The brief and files the project was made with, whatever the sheet
    // holds now.
    final posted = sentBrief ?? text;
    final attached = sentFiles;
    if (!_briefPosted && (posted.isNotEmpty || attached.isNotEmpty)) {
      if (_brief == null) {
        // Up once, to its chat, before the message they go with: written
        // with their ids, it is repeated as it is.
        final ids = await _upload(attached, live);
        check();
        _brief = {
          'operationId': superTabOperationId(),
          'command': {
            'type': 'message.send',
            'conversationId': _conversationId,
            'text': posted,
            'replyTo': null,
            'recipientIds': const <String>[],
            if (ids.isNotEmpty) 'attachmentIds': ids,
          },
        };
      }
      try {
        await _send(() => _brief, (v) => _brief = v);
      } on SuperTabFailure catch (failure) {
        // Refused, its files go up afresh with the next one.
        if (_refusedOutright(failure)) _uploads?.forget(attached);
        rethrow;
      }
      _briefPosted = true;
      check();
    }
    // New repository: made on GitHub through the person's own sign-in before
    // its Product Manager can start in it (task #3373). A start already sent
    // keeps the repository it was sent with.
    var url = repositoryUrl;
    if (!_started && _start == null && newRepository != null) {
      url = await _newRepository(projectId, newRepository, check);
      read = true;
    }
    if (!_started) {
      if (_start == null) {
        // The list from when the sheet drew it may be stale: read the Swarm
        // again (unless this run just did), and send nothing to a machine
        // that cannot take it now, nor for a project deleted meanwhile.
        final deleted = read ? false : await _deleted(projectId, check);
        final snapshot = reader.snapshot;
        if (deleted == null || snapshot == null) {
          throw const SuperTabFailure(
            'SWARM_UNREADABLE',
            'Couldn’t check the machine for the Product Manager: the Swarm '
                'didn’t answer. Try again.',
          );
        }
        if (deleted) _gone();
        final machines = machinesOf(snapshot);
        if (swarmLeadMachineRefusal(machines, machineId, engine: engine)
            case final why?) {
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
            'engine': engine ?? machine.engine,
            'repositoryUrl': url,
          },
        };
      }
      await _send(() => _start, (v) => _start = v);
      _started = true;
      check();
    }
    final name = swarmRepositoryName(startRepository ?? url!);
    if (!_named) {
      try {
        await _send(
          () => {
            'operationId':
                '${superTabMap(_create ?? const {})['operationId'] ?? projectId}-name',
            'command': {
              'type': 'project.rename',
              'projectId': projectId,
              'name': name,
            },
          },
          (_) {},
        );
      } on SuperTabFailure catch (failure) {
        // Refused, it never will be: the project keeps the name it has and
        // opens by it, rather than hold the steps (Lead's re-review).
        if (!_refusedOutright(failure)) rethrow;
      }
      _named = true;
      check();
    }
    // Read before the project opens, so its screen finds it by its name:
    // once more when the read joined was asked before the name was.
    for (var i = 0; i < 2; i++) {
      await reader.refresh();
      check();
      if (reader.snapshot?.projectById(projectId)?.name == name) break;
    }
    // Not there (its name refused because it was deleted, say): it says so
    // rather than close on nothing.
    if (reader.snapshot?.projectById(projectId) == null &&
        (await _deleted(projectId, check) ?? false)) {
      _gone();
    }
    forget();
    return projectId;
  }

  /// Whether project [projectId] was deleted: absent from a read of the
  /// Swarm asked after it was made. A read already on its way is joined and
  /// may have been asked before, so an absence is read once more before it
  /// counts. Null when the Swarm did not answer. [check] runs after each
  /// read.
  Future<bool?> _deleted(String projectId, void Function() check) async {
    for (var i = 0; i < 2; i++) {
      final reads = reader.reads.value;
      await reader.refresh();
      check();
      final snapshot = reader.snapshot;
      if (reader.reads.value == reads || snapshot == null) return null;
      if (snapshot.projectById(projectId) != null) return false;
    }
    return true;
  }

  /// New repository [asked] for project [projectId]: its outcome when the
  /// Swarm state has it (the repository's address, once made), else the
  /// request sent and GitHub's sign-in opened, and the steps wait
  /// ([SwarmRepositoryWaiting]). A refusal or an outcome other than made says
  /// why in the design's words ([SwarmRepositoryFailure]) and drops the
  /// request, so the next run asks afresh. The state is read first, so a
  /// sheet back from GitHub sees the outcome.
  Future<String> _newRepository(
    String projectId,
    SwarmNewRepository asked,
    void Function() check,
  ) async {
    if (_creation case final sent?) {
      await reader.refresh();
      check();
      final project = reader.snapshot?.projectById(projectId);
      if (project == null) {
        if (await _deleted(projectId, check) ?? false) _gone();
        throw const SwarmRepositoryWaiting();
      }
      final outcome = project.repositoryCreation;
      // Not this request's yet (a read from before it, say): still waiting.
      if (outcome == null || outcome['at'] != sent.at) {
        throw const SwarmRepositoryWaiting();
      }
      final (owner, name) = (sent.repository.owner, sent.repository.name);
      switch (outcome['state']) {
        case 'created':
          final made = outcome['repositoryUrl'];
          if (made is! String || !swarmRepositoryUrlValid(made)) {
            _creation = null;
            throw const SwarmRepositoryFailure(swarmRepositoryNoAnswer);
          }
          unreachable = outcome['reachable'] == false;
          return made;
        // Making it now, in the callback (Heron, #3201): as waiting.
        case 'waiting' || 'creating':
          throw const SwarmRepositoryWaiting();
        case 'taken':
          _creation = null;
          throw SwarmRepositoryFailure(swarmRepositoryTaken(owner, name));
        case 'refused':
          _creation = null;
          final reason = outcome['reason'];
          throw SwarmRepositoryFailure(
            swarmRepositoryRefused(
              owner,
              reason is String && reason.trim().isNotEmpty
                  ? reason.trim().replaceFirst(RegExp(r'[.\s]+$'), '')
                  : 'GitHub gave no reason',
            ),
          );
        case 'cancelled':
          _creation = null;
          throw const SwarmRepositoryFailure(swarmRepositoryNotCreated);
        default:
          _creation = null;
          throw const SwarmRepositoryFailure(swarmRepositoryNoAnswer);
      }
    }
    final Map<String, dynamic> answer;
    try {
      answer = superTabMap(
        await reader.request(
          'POST',
          '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/projects/'
              '${Uri.encodeComponent(projectId)}/github/repository',
          body: {
            'owner': asked.owner,
            'name': asked.name,
            'private': asked.private,
          },
        ),
      );
    } on SuperTabFailure catch (failure) {
      if (swarmRateLimited(failure)) {
        throw const SwarmRepositoryFailure(swarmRepositoryRateLimited);
      }
      throw switch (failure.code) {
        'GITHUB_APP_NOT_INSTALLED' => SwarmRepositoryFailure(
          swarmRepositoryNotInstalled(asked.owner),
        ),
        'GITHUB_APP_PERMISSIONS' => SwarmRepositoryFailure(
          swarmRepositoryNotAccepted(asked.owner),
        ),
        'REPOSITORY_NAME' => SwarmRepositoryFailure(failure.message),
        _ => failure,
      };
    }
    check();
    final (authorizeUrl, at) = switch (answer) {
      {'authorizeUrl': final String link, 'at': final num at}
          when Uri.tryParse(link)?.isScheme('https') ?? false =>
        (link, at.toInt()),
      _ => throw const SwarmRepositoryFailure(swarmRepositoryNoAnswer),
    };
    _creation = (repository: asked, at: at, authorizeUrl: authorizeUrl);
    notifyListeners();
    try {
      await swarmOpenGitHub(Uri.parse(authorizeUrl));
    } catch (_) {
      // Not opened: Check again reads the outcome, and Start over lets go.
    }
    throw const SwarmRepositoryWaiting();
  }

  /// GitHub's sign-in for the request [creating] waits for, to open again.
  String? get authorizeUrl => _started ? null : _creation?.authorizeUrl;

  /// Its project deleted meanwhile: these steps are done with, and the next
  /// Create makes a new project. Deleted while New repository was out in
  /// GitHub, the repository may still have been made (F11).
  Never _gone() {
    forget();
    if (_creation case final asked?) {
      throw SwarmRepositoryFailure(
        swarmRepositoryProjectGone(
          asked.repository.owner,
          asked.repository.name,
        ),
      );
    }
    throw const SuperTabFailure(
      'PROJECT_GONE',
      'The project was deleted meanwhile. Create it again.',
    );
  }

  /// Uploads each of [files] not up yet to the project's chat and answers
  /// their ids, those up kept for the next run. A failure says why in the
  /// chat's words ([swarmUploadError]). No file starts once [live] says no.
  Future<List<String>> _upload(
    List<SwarmOutgoingFile> files,
    bool Function() live,
  ) async {
    if (files.isEmpty) return const [];
    final uploads = _uploads ??= SwarmUploads(
      reader,
      _conversationId!,
      timeout: _uploadTimeout,
      onChanged: notifyListeners,
      onProgress: notifyListeners,
    );
    final up = await uploads.upload(files, live: live);
    // Gone meanwhile: its caller's check ends the run.
    if (!live()) return const [];
    if (up.ids case final ids?) return ids;
    final failure = up.failure;
    if (failure is SuperTabFailure) throw failure;
    throw SuperTabFailure(
      'UPLOAD_FAILED',
      failure == null
          ? 'Could not upload ${files.length == 1 ? 'the file' : 'the files'}. '
                'Try again.'
          : swarmUploadError(failure, files.length),
    );
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

/// A project New project made: the Swarm, and the project.
typedef SwarmNewProject = ({String swarmId, String projectId});

/// New project, from Swarm Home: which Swarm (only when there are several,
/// and only those of [swarmIds] the person may write in; it opens on
/// [openedFrom], the Swarm Home shows, unless that one is paused
/// ([swarmNewProjectSwarm]), and paused ones come last), the brief, the
/// visibility, the repository and the machine its Product Manager runs on,
/// then Create. Answers the project once it is made and its Product Manager
/// asked to start; null when closed. The Swarm taken away, the person's
/// access to it, or their account, while it is open closes it, and nothing
/// more is sent. Steps left unfinished stay with the Swarm's reader
/// ([SwarmNewProjectSteps]): the sheet opens on them again, and stays open
/// while one of them waits for its answer. [now] is what machine readings
/// are measured from.
Future<SwarmNewProject?> showSwarmNewProjectSheet(
  BuildContext context, {
  required SwarmSession session,
  required List<String> swarmIds,
  String? openedFrom,
  DateTime Function() now = DateTime.now,
}) {
  // The sheet reads no status bar of its own (the route takes it away).
  final top = MediaQuery.paddingOf(context).top;
  return showModalBottomSheet<SwarmNewProject>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppGlass.rowFill,
    shape: AppControl.sheetShape,
    builder: (_) => SwarmNewProjectSheet(
      session: session,
      swarmIds: swarmIds,
      openedFrom: openedFrom,
      now: now,
      topInset: top,
    ),
  );
}

/// What [showSwarmNewProjectSheet] shows.
class SwarmNewProjectSheet extends StatefulWidget {
  const SwarmNewProjectSheet({
    super.key,
    required this.session,
    required this.swarmIds,
    this.openedFrom,
    this.now = DateTime.now,
    this.topInset = 0,
  });

  final SwarmSession session;
  final List<String> swarmIds;

  /// The Swarm Home showed when it opened, if one: chosen first unless it is
  /// paused.
  final String? openedFrom;
  final DateTime Function() now;

  /// The phone's status bar: with the keyboard up the sheet reaches it.
  final double topInset;

  @override
  State<SwarmNewProjectSheet> createState() => _SwarmNewProjectSheetState();
}

/// What the sheet shows in place of its form: one of its choices' lists.
enum _Pick {
  swarm,
  visibility,
  repository,
  link,
  newRepository,
  owner,
  machine,
  engine,
}

class _SwarmNewProjectSheetState extends State<SwarmNewProjectSheet>
    implements SwarmFilesBox {
  final _brief = TextEditingController();
  final _link = TextEditingController();

  /// New repository (task #3373): its name and another organization, as
  /// typed, and whether it is private (on by default).
  final _newName = TextEditingController();
  final _otherOwner = TextEditingController();
  bool _newPrivate = true;

  /// The organization New repository's subpage has, until it is used.
  String? _newOwner;

  /// New repository, once its name is used: the repository the project is
  /// made in, in place of [_repository].
  SwarmNewRepository? _newRepository;

  /// Each organization's check, by Swarm and owner; a check under way is
  /// there as null, asked once.
  final _ownerChecks = <String, SwarmOwnerCheck?>{};
  final _ownerAsked = <String>{};

  /// When each rate-limited check answered: asked again a minute after.
  final _ownerLimitedAt = <String, DateTime>{};

  /// The outcome New repository last went on from, so one outcome runs once.
  String? _outcomeRun;

  /// Made, but its repository not yet in reach of Harness (F7): the sheet
  /// stays to say so, then opens the project.
  SwarmNewProject? _madeUnreachable;
  String? _unreachableLine;

  /// The files going with the brief: in memory, or a large one on disk in
  /// the app's temporary folder while it is held (here, or by the steps once
  /// sent).
  final _files = SwarmOutgoingFiles();

  /// What the last pick of files left out, if anything.
  String? _attachNote;
  bool _attaching = false;

  String? _swarmId;
  String _visibility = 'public';

  /// The repository the person chose; until then, the Swarm's first
  /// ([swarmProjectRepositories]).
  String? _repository;
  bool _repositoryPicked = false;
  String? _machineId;

  /// The engine the person chose for the Product Manager; until then, the
  /// machine's first, as before there was a choice.
  String? _engine;
  _Pick? _picking;
  String? _linkError;

  /// A step's answer is awaited: the sheet stays open until it comes.
  bool _busy = false;
  String? _error;
  final _errorKey = GlobalKey();

  /// Start over let go of a create never answered ([swarmNewProjectMaybeMade]),
  /// until the next Create or another Swarm.
  bool _maybeMade = false;

  /// The model list of the Swarm [_policySwarm], once read: the engines it
  /// rules out, and whether it leaves Claude's default model on.
  Map<String, String> _modelList = const {};
  bool _leadModelOn = true;
  String? _policySwarm;
  int _policyReads = 0;

  bool _closing = false;
  SwarmSession? _scoped;

  SwarmInbox get _inbox => widget.session.inbox;

  /// Each Swarm's reader as the sheet opened. One replaced since (its Swarm
  /// left Home's list and came back) is another read of it: the sheet goes
  /// rather than send through either.
  late final Map<String, SwarmReader?> _readers;

  /// The Swarms it offers: those that take work first, then the paused,
  /// each in Home's order.
  List<String> get _writable {
    final writable = [
      for (final id in widget.swarmIds)
        if (_readers[id] case final reader?
            when identical(_inbox.reader(id), reader) &&
                swarmMayCreateProject(_inbox, id))
          id,
    ];
    return [
      for (final id in writable)
        if (!_paused(id)) id,
      for (final id in writable)
        if (_paused(id)) id,
    ];
  }

  bool _paused(String id) => swarmNewProjectPaused(_inbox, id);

  /// The steps the Swarm picked holds, if any.
  SwarmNewProjectSteps? get _steps => switch (_readers[_swarmId]) {
    final reader? => SwarmNewProjectSteps.heldBy(reader),
    null => null,
  };

  @override
  void initState() {
    super.initState();
    _readers = {for (final id in widget.swarmIds) id: _inbox.reader(id)};
    final writable = _writable;
    // A Swarm with a project's steps left unfinished: it opens on them.
    _swarmId =
        writable
            .where(
              (id) => SwarmNewProjectSteps.heldBy(_readers[id]!)?.sent ?? false,
            )
            .firstOrNull ??
        swarmNewProjectSwarm(
          writable,
          openedFrom: widget.openedFrom,
          paused: _paused,
        );
    if (_steps case final steps?) _resume(steps);
    _files.addListener(_filesChanged);
    if (_swarmId case final id?) unawaited(_readModelList(id));
  }

  /// Shows [steps] where they stopped: what they were sent with, what was
  /// last chosen, and why they stopped. A run still under way keeps the
  /// sheet busy until it answers.
  void _resume(SwarmNewProjectSteps steps) {
    if (steps.sentBrief case final brief?) _brief.text = brief;
    if (steps.sentVisibility case final visibility?) _visibility = visibility;
    if (steps.chosenRepository case final repository?) {
      _repository = repository;
      _repositoryPicked = true;
    }
    if (steps.chosenNewRepository case final repository?) {
      _newRepository = repository;
      _repository = null;
      _repositoryPicked = true;
    }
    _machineId = steps.chosenMachine;
    _engine = steps.chosenEngine;
    // The files its brief went with, held as sent.
    if (steps.sent) _files.add(steps.sentFiles);
    _error = steps.failure;
    if (_error != null) _showError();
    if (steps.running case final running?) {
      _busy = true;
      unawaited(
        running.whenComplete(() {
          if (!mounted || _closing) return;
          setState(() {
            _busy = false;
            _error = steps.failure;
          });
          if (_error != null) _showError();
        }),
      );
    }
  }

  /// Steps nothing was sent for, nor runs: let go, so the next Create
  /// starts afresh.
  void _dropUnsent() {
    if (_steps case final steps? when !steps.sent && steps.running == null) {
      steps.forget();
    }
  }

  /// Scrolls why Create stopped into sight once it is drawn.
  void _showError() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (_errorKey.currentContext case final shown? when mounted) {
      unawaited(Scrollable.ensureVisible(shown, alignment: 1));
    }
  });

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _scoped = SwarmScope.of(context);
  }

  @override
  void dispose() {
    _dropUnsent();
    _files
      ..removeListener(_filesChanged)
      ..dispose();
    _brief.dispose();
    _link.dispose();
    _newName.dispose();
    _otherOwner.dispose();
    super.dispose();
  }

  void _filesChanged() {
    if (mounted && !_closing) setState(() {});
  }

  @override
  SwarmOutgoingFiles get files => _files;

  @override
  bool isUploading(SwarmOutgoingFile file) =>
      _steps?.isUploading(file) ?? false;

  @override
  double? uploadProgress(SwarmOutgoingFile file) =>
      _steps?.uploadProgress(file);

  /// +'s sheet and picker ([attachSwarmFiles]), their files into [_files];
  /// what a pick left out is said under them.
  Future<void> _attach() async {
    if (_attaching || _busy) return;
    _attaching = true;
    try {
      await attachSwarmFiles(
        context,
        _files,
        stillWanted: () =>
            mounted && !_closing && !_busy && !(_steps?.sent ?? false),
        note: (note) {
          if (mounted && !_closing) setState(() => _attachNote = note);
        },
      );
    } finally {
      _attaching = false;
    }
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
    var leadModelOn = true;
    try {
      final answer = superTabMap(
        await reader.request(
          'GET',
          '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/routing-policy',
        ),
      );
      refusals = swarmLeadModelListRefusals(answer);
      leadModelOn = swarmLeadModelOn(answer);
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
      _leadModelOn = leadModelOn;
      _policySwarm = swarmId;
    });
  }

  /// Closes the sheet once, after the frame it went blank in. A sheet or
  /// dialog over it (+'s, or one it opened) goes too.
  void _close() {
    if (_closing) return;
    _closing = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      final navigator = Navigator.of(context);
      navigator.popUntil((top) => top == route || top is! PopupRoute);
      if (route.isCurrent) {
        navigator.pop();
      } else {
        navigator.removeRoute(route);
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
    modelList: _modelListOf(swarmId),
  );

  /// The engines Swarm [swarmId]'s model list rules out, once read.
  Map<String, String> _modelListOf(String swarmId) =>
      _policySwarm == swarmId ? _modelList : const {};

  /// The engine the Product Manager starts with: the start's, once sent;
  /// else the person's choice; else [machine]'s first, as before there was a
  /// choice; else the first the Swarm's model list leaves.
  String _engineOf(String swarmId, SwarmLeadMachine? machine) =>
      _steps?.startEngine ??
      _engine ??
      machine?.engine ??
      swarmLeadEngines
          .where((engine) => !_modelListOf(swarmId).containsKey(engine))
          .firstOrNull ??
      swarmLeadEngines.first;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    // Signed out or another account: its session is gone, and nothing of it
    // is listened to again.
    if (_closing || SwarmScope.of(context) != widget.session) {
      _close();
      return const SizedBox.shrink();
    }
    return ListenableBuilder(
      listenable: Listenable.merge([
        widget.session,
        _inbox,
        // Not one replaced since: the inbox disposes it.
        for (final MapEntry(:key, :value) in _readers.entries)
          if (value != null && identical(_inbox.reader(key), value)) value,
        // Its files going up.
        ?_steps,
      ]),
      builder: (context, _) {
        final writable = _writable;
        final swarmId = _swarmId;
        // Signed out, another account, or the Swarm picked no longer the
        // person's to write in, or read again: nothing of it stays, and the
        // sheet goes.
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
        final height = MediaQuery.sizeOf(context).height;
        // With the keyboard up the sheet may reach the status bar, so what
        // is typed in and Create both stay in sight on a small phone.
        final maxHeight =
            (insets > 0
                ? height - widget.topInset - AppSpace.s
                : height * .85) -
            insets;
        // While a step's answer is unknown the sheet stays: its close, the
        // back gesture, the dimmed page behind it, and a drag down (which
        // closes a sheet past PopScope) do nothing.
        return PopScope(
          canPop: !_busy,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onVerticalDragStart: _busy ? (_) {} : null,
            child: Padding(
              padding: EdgeInsets.only(bottom: insets),
              child: ConstrainedBox(
                constraints: BoxConstraints(maxHeight: math.max(0, maxHeight)),
                child: SafeArea(
                  top: false,
                  child: KeyedSubtree(
                    key: const ValueKey('swarm-new-project-sheet'),
                    child: switch (_picking) {
                      null => _form(
                        context,
                        writable,
                        swarmId,
                        reader,
                        snapshot,
                      ),
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
            ),
          ),
        );
      },
    );
  }

  /// The sheet's grabber and [header] at its top and [footer] (its one
  /// button) at its bottom, always in sight; [children] between them scroll
  /// when the phone, or the room the keyboard leaves, is too short for them.
  Widget _frame({
    required Widget header,
    required List<Widget> children,
    List<Widget> footer = const [],
  }) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpace.l,
          AppSpace.s,
          AppSpace.l,
          0,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
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
          ],
        ),
      ),
      Flexible(
        child: SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(
            AppSpace.l,
            0,
            AppSpace.l,
            footer.isEmpty ? AppSpace.l : 0,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: children,
          ),
        ),
      ),
      if (footer.isNotEmpty)
        Padding(
          padding: const EdgeInsets.all(AppSpace.l).copyWith(top: 0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: footer,
          ),
        ),
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
    // New repository, while no start went with another one.
    final newRepository = steps?.startRepository == null
        ? _newRepository
        : null;
    final creating = steps?.creating;
    final machineId = steps?.startMachine ?? _machineId;
    final machine = machines.where((m) => m.id == machineId).firstOrNull;
    final sent = steps?.sent ?? false;
    final startSent = steps?.startSent ?? false;
    final engine = _engineOf(swarmId, machine);
    final blocked = _blocked(
      snapshot,
      machines,
      machine,
      repository ??
          (newRepository == null ? null : swarmNewRepositoryUrl(newRepository)),
    );
    _goOnFromOutcome(swarmId, reader, snapshot, steps, machineId);
    final swarmName =
        _inbox.swarms.where((s) => s.id == swarmId).firstOrNull?.name ??
        snapshot.name;
    return _frame(
      header: _header(
        'New project',
        // Dimmed while a step's answer is awaited, and the sheet stays.
        IgnorePointer(
          ignoring: _busy,
          child: Opacity(
            opacity: _busy ? .55 : 1,
            child: SwarmIconButton(
              key: const ValueKey('swarm-new-project-close'),
              icon: LucideIcons.x300,
              label: 'Close',
              onPressed: () => unawaited(Navigator.of(context).maybePop()),
            ),
          ),
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
                detail: snapshot.paused ? 'Paused' : null,
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
        if (swarmSendsFiles) ...[
          const SizedBox(height: AppSpace.s),
          _attachments(locked: sent || _busy),
          if (_attachNote case final note?)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
              child: SwarmRow.line(
                note,
                key: const ValueKey('swarm-new-project-attach-note'),
                lines: 3,
              ),
            ),
        ],
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
              value: newRepository != null
                  ? 'New · ${newRepository.name}'
                  : repository == null
                  ? 'Choose'
                  : swarmRepositoryName(repository),
              detail: newRepository != null
                  ? '${newRepository.owner}/${newRepository.name}'
                  : repository == null
                  ? null
                  : swarmRepositoryKey(repository),
              // A link is a choice in its list: said here while none is
              // chosen, so it is found (Dee, 11-01; Lead: no line otherwise).
              hint: repository == null && newRepository == null
                  ? 'Or enter a link'
                  : null,
              // Fixed while GitHub's sign-in is out for it.
              onTap: startSent || _busy || creating != null
                  ? null
                  : () => setState(() => _picking = _Pick.repository),
            ),
            _Field(
              key: const ValueKey('swarm-new-project-machine'),
              label: 'PM runs on',
              value: machine?.name ?? 'Choose',
              detail: machine?.detailFor(engine),
              onTap: startSent || _busy
                  ? null
                  : () => setState(() => _picking = _Pick.machine),
            ),
            // The engine and the model it runs, as Desktop's Agent and Model
            // (Desktop's `leadModelLabel`: through the Swarm no model is
            // sent, so the one it gets is shown, not chosen).
            _Field(
              key: const ValueKey('swarm-new-project-agent'),
              label: 'Agent',
              value: swarmLeadEngineLabel(engine),
              detail: swarmLeadModelLabel(engine, leadModelOn: _leadModelOn),
              onTap: startSent || _busy
                  ? null
                  : () => setState(() => _picking = _Pick.engine),
            ),
          ],
        ),
        if (_maybeMade)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.m,
              AppSpace.xs,
              0,
            ),
            child: SwarmRow.line(
              swarmNewProjectMaybeMade,
              key: const ValueKey('swarm-new-project-maybe-made'),
              lines: 3,
            ),
          ),
        if (_unreachableLine case final line?) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.m,
              AppSpace.xs,
              0,
            ),
            child: SwarmRow.line(
              line,
              key: const ValueKey('swarm-new-project-unreachable'),
              lines: 4,
            ),
          ),
          _copyMessage(line),
        ]
        // Why it stopped, under what it is about; scrolled into sight when
        // it appears (_showError).
        else if (_error case final error?)
          Padding(
            key: _errorKey,
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
      ],
      // Create in sight however short the phone, the keyboard up too.
      footer: [
        const SizedBox(height: AppSpace.l),
        if (_madeUnreachable case final made?)
          SwarmButton(
            key: const ValueKey('swarm-new-project-open-made'),
            label: 'Open the project',
            style: SwarmButtonStyle.fill,
            wide: true,
            onPressed: () {
              _closing = true;
              Navigator.of(context).pop(made);
            },
          )
        // Out in GitHub: what it waits for, and a way to look again.
        else if (creating != null && _error == null && !_busy) ...[
          SwarmButton(
            key: const ValueKey('swarm-new-project-create'),
            label: 'Creating ${creating.owner}/${creating.name}…',
            style: SwarmButtonStyle.fill,
            wide: true,
            onPressed: null,
          ),
          const SizedBox(height: AppSpace.s),
          SwarmButton(
            key: const ValueKey('swarm-new-project-check-again'),
            label: 'Check again',
            style: SwarmButtonStyle.link,
            wide: true,
            onPressed: machineId == null
                ? null
                : () => unawaited(
                    _create(swarmId, reader, repository, machineId),
                  ),
          ),
        ] else
          SwarmButton(
            key: const ValueKey('swarm-new-project-create'),
            label: _error != null
                ? 'Try again'
                : newRepository != null
                ? 'Create and continue in GitHub'
                : 'Create',
            style: SwarmButtonStyle.fill,
            wide: true,
            busy: _busy,
            busyLabel: 'Creating…',
            onPressed:
                blocked == null &&
                    (repository != null || newRepository != null) &&
                    machineId != null &&
                    (machine != null || startSent)
                ? () =>
                      unawaited(_create(swarmId, reader, repository, machineId))
                : null,
          ),
        // Steps left that nothing runs: the way out of them, whatever stops
        // them (Lead's re-review).
        if (steps != null && steps.sent && steps.running == null && !_busy) ...[
          const SizedBox(height: AppSpace.s),
          SwarmButton(
            key: const ValueKey('swarm-new-project-start-over'),
            label: 'Start over',
            style: SwarmButtonStyle.link,
            wide: true,
            onPressed: _startOver,
          ),
        ],
      ],
    );
  }

  /// + and the files going with the brief, in a row under it (Desktop's 📎
  /// and its chips); fixed, as the brief is, once the project was asked for.
  Widget _attachments({required bool locked}) => Row(
    children: [
      SwarmAttachButton(
        key: const ValueKey('swarm-new-project-attach'),
        onTap: locked || _files.room <= 0 ? null : () => unawaited(_attach()),
      ),
      if (_files.files.isNotEmpty) ...[
        const SizedBox(width: AppSpace.s),
        Expanded(
          child: IgnorePointer(
            ignoring: locked,
            child: SwarmOutgoingChips(box: this),
          ),
        ),
      ],
    ],
  );

  /// Lets the Swarm's steps go: the fields open again, and the next Create
  /// makes a new project. One already made stays in the list; one whose
  /// create was never answered may be there too, and the sheet says so.
  void _startOver() {
    if (_busy) return;
    setState(() {
      _maybeMade = _steps?.createUnanswered ?? false;
      _steps?.forget();
      _error = null;
    });
  }

  /// What the server says of [owner]'s GitHub, asked once per Swarm and
  /// owner; null until it answers, and when it could not say.
  SwarmOwnerCheck? _ownerCheck(
    String swarmId,
    SwarmReader reader,
    String owner,
  ) {
    final key = '$swarmId/${owner.toLowerCase()}';
    // Too many checks: kept a minute, then asked again on the next look.
    if (_ownerLimitedAt[key] case final at?
        when widget.now().difference(at) >= const Duration(minutes: 1)) {
      _ownerLimitedAt.remove(key);
      _ownerAsked.remove(key);
    }
    if (_ownerAsked.add(key)) {
      unawaited(
        swarmCheckGitHubOwner(reader, owner).then((check) {
          if (!mounted) return;
          setState(() {
            _ownerChecks[key] = check;
            if (check?.state == 'rate-limited') {
              _ownerLimitedAt[key] = widget.now();
            }
          });
        }),
      );
    }
    return _ownerChecks[key];
  }

  /// Whether Repository offers New repository: the Swarm uses a GitHub
  /// organization, and the server can make repositories (not an older one,
  /// nor one without GitHub sign-in).
  bool _newRepositoryOffered(
    String swarmId,
    SwarmReader reader,
    List<String> repositories,
  ) {
    final owner = swarmGitHubOwners(repositories).firstOrNull;
    if (owner == null) return false;
    final check = _ownerCheck(swarmId, reader, owner);
    return check != null && check.state != 'not-configured';
  }

  /// Copy message, for an owner of the organization to act on [line].
  Widget _copyMessage(String line, {String? link}) => Align(
    alignment: AlignmentDirectional.centerStart,
    child: SwarmButton(
      key: const ValueKey('swarm-new-repo-copy'),
      label: 'Copy message',
      icon: LucideIcons.copy300,
      style: SwarmButtonStyle.link,
      onPressed: () => unawaited(
        Clipboard.setData(
          ClipboardData(text: link == null ? line : '$line $link'),
        ),
      ),
    ),
  );

  /// New repository (the design's phone mockup): Owner, Name with the
  /// address it will have under it, Private on by default, then Use this
  /// name. The name's rule shows as it is typed (F1), and the organization's
  /// check before anything is made (F4, F5).
  Widget _newRepositoryPage(Widget header, String swarmId, SwarmReader reader) {
    final owners = swarmGitHubOwners(swarmProjectRepositories(reader));
    final owner = _newOwner ?? owners.firstOrNull ?? '';
    final name = _newName.text.trim();
    final problem = swarmRepositoryNameProblem(name);
    final check = owner.isEmpty ? null : _ownerCheck(swarmId, reader, owner);
    final ownerLine = check == null ? null : swarmOwnerProblem(owner, check);
    final usable =
        name.isNotEmpty && problem == null && check?.state == 'ready';
    void use() {
      if (!usable) return;
      setState(() {
        _newRepository = (owner: owner, name: name, private: _newPrivate);
        _repository = null;
        _repositoryPicked = true;
        _error = null;
        _picking = null;
      });
    }

    return _frame(
      header: header,
      children: [
        SwarmGroup(
          children: [
            _Field(
              key: const ValueKey('swarm-new-repo-owner'),
              label: 'Owner',
              value: owner.isEmpty ? 'Choose' : owner,
              onTap: () => setState(() => _picking = _Pick.owner),
            ),
          ],
        ),
        const SizedBox(height: AppSpace.m),
        TextField(
          key: const ValueKey('swarm-new-repo-name'),
          controller: _newName,
          autofocus: true,
          autocorrect: false,
          enableSuggestions: false,
          textInputAction: TextInputAction.done,
          onChanged: (_) => setState(() {}),
          onSubmitted: (_) => use(),
          style: AppType.body(color: AppPalette.textPrimary),
          decoration: InputDecoration(
            hintText: 'Name',
            hintStyle: TextStyle(color: AppPalette.textFaint),
            filled: true,
            fillColor: AppPalette.swarmField,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AppControl.radius),
              borderSide: BorderSide.none,
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.xs,
            AppSpace.s,
            AppSpace.xs,
            0,
          ),
          child: problem != null
              ? SwarmRow.line(
                  problem,
                  key: const ValueKey('swarm-new-repo-name-error'),
                  lines: 2,
                  color: AppColors.danger,
                )
              : SwarmRow.line(
                  'github.com/${owner.isEmpty ? 'owner' : owner}/'
                  '${name.isEmpty ? 'name' : name}',
                  key: const ValueKey('swarm-new-repo-address'),
                ),
        ),
        const SizedBox(height: AppSpace.m),
        SwarmGroup(
          children: [
            _Option(
              key: const ValueKey('swarm-new-repo-private-row'),
              leading: Icon(
                LucideIcons.lock300,
                size: 20,
                color: AppPalette.textSecondary,
              ),
              title: 'Private',
              detail: 'Only people with access on GitHub see it',
              trailing: Switch.adaptive(
                key: const ValueKey('swarm-new-repo-private'),
                value: _newPrivate,
                activeTrackColor: AppPalette.swarmAccent,
                onChanged: (on) => setState(() => _newPrivate = on),
              ),
              onTap: () => setState(() => _newPrivate = !_newPrivate),
            ),
          ],
        ),
        if (ownerLine != null) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.xs,
              AppSpace.m,
              AppSpace.xs,
              0,
            ),
            child: SwarmRow.line(
              ownerLine,
              key: const ValueKey('swarm-new-repo-owner-note'),
              lines: 3,
            ),
          ),
          if (check?.installUrl case final install?
              when check?.state == 'not-installed')
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: SwarmButton(
                key: const ValueKey('swarm-new-repo-install'),
                label: 'Install on GitHub',
                icon: LucideIcons.externalLink300,
                style: SwarmButtonStyle.link,
                onPressed: () => unawaited(swarmOpenGitHub(Uri.parse(install))),
              ),
            ),
          _copyMessage(
            ownerLine,
            link: check?.state == 'not-installed' ? check?.installUrl : null,
          ),
        ],
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.xs,
            AppSpace.m,
            AppSpace.xs,
            0,
          ),
          child: SwarmRow.line(
            'GitHub asks you to confirm, then Harness creates it with you as '
            'its admin.',
            lines: 2,
          ),
        ),
      ],
      footer: [
        const SizedBox(height: AppSpace.l),
        SwarmButton(
          key: const ValueKey('swarm-new-repo-use'),
          label: 'Use this name',
          style: SwarmButtonStyle.fill,
          wide: true,
          onPressed: usable ? use : null,
        ),
      ],
    );
  }

  /// New repository's Owner: the organizations the Swarm's projects use,
  /// most recent first, and another one by its name.
  Widget _ownerPage(Widget header, SwarmReader reader) {
    final owners = swarmGitHubOwners(swarmProjectRepositories(reader));
    final chosen = _newOwner ?? owners.firstOrNull;
    void other() {
      final owner = _otherOwner.text.trim();
      if (!swarmRepositoryOwnerValid(owner)) return;
      setState(() {
        _newOwner = owner;
        _picking = _Pick.newRepository;
      });
    }

    return _frame(
      header: header,
      children: [
        if (owners.isNotEmpty) ...[
          SwarmGroup(
            children: [
              for (final owner in owners)
                _Option(
                  key: ValueKey('swarm-new-repo-pick-owner-$owner'),
                  leading: Icon(
                    LucideIcons.building2300,
                    size: 20,
                    color: AppPalette.textSecondary,
                  ),
                  title: owner,
                  trailing: owner == chosen
                      ? Icon(
                          LucideIcons.check300,
                          size: 20,
                          color: AppPalette.swarmAccent,
                        )
                      : null,
                  onTap: () => setState(() {
                    _newOwner = owner;
                    _picking = _Pick.newRepository;
                  }),
                ),
            ],
          ),
          const SizedBox(height: AppSpace.m),
        ],
        TextField(
          key: const ValueKey('swarm-new-repo-other-owner'),
          controller: _otherOwner,
          autocorrect: false,
          enableSuggestions: false,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => other(),
          style: AppType.body(color: AppPalette.textPrimary),
          decoration: InputDecoration(
            hintText: 'Another organization',
            hintStyle: TextStyle(color: AppPalette.textFaint),
            filled: true,
            fillColor: AppPalette.swarmField,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(AppControl.radius),
              borderSide: BorderSide.none,
            ),
          ),
        ),
      ],
      footer: [
        const SizedBox(height: AppSpace.l),
        SwarmButton(
          key: const ValueKey('swarm-new-repo-other-use'),
          label: 'Use this organization',
          style: SwarmButtonStyle.fill,
          wide: true,
          onPressed: other,
        ),
      ],
    );
  }

  /// New repository's outcome came back in the Swarm state while the steps
  /// wait for it: they go on, once for each outcome (made: its Product
  /// Manager starts; otherwise it says why).
  void _goOnFromOutcome(
    String swarmId,
    SwarmReader reader,
    SuperTabSnapshot snapshot,
    SwarmNewProjectSteps? steps,
    String? machineId,
  ) {
    final at = steps?.creationAt;
    final projectId = steps?.projectId;
    if (at == null || projectId == null || machineId == null) return;
    if (_busy || _error != null || steps!.running != null) return;
    final outcome = snapshot.projectById(projectId)?.repositoryCreation;
    final state = outcome?['state'];
    if (outcome?['at'] != at ||
        state is! String ||
        state == 'waiting' ||
        state == 'creating') {
      return;
    }
    final key = '$at/$state';
    if (_outcomeRun == key) return;
    _outcomeRun = key;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_create(swarmId, reader, null, machineId));
    });
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
    // A start sent is repeated as it was, or is done, whatever the list
    // says now: the Product Manager it started may fill its machine.
    if (_steps?.startSent ?? false) return null;
    if (!machines.any((m) => m.startable)) return swarmLeadNoMachine;
    if (machine == null) return swarmLeadChooseMachine;
    if (!machine.startable) {
      return '${machine.name} cannot start the Product Manager. '
          'Choose another machine.';
    }
    if (_engine case final engine?) {
      if (machine.engineRefusals[engine] case final why?) {
        return '${machine.name} can’t run ${swarmLeadEngineLabel(engine)}: '
            '$why. Choose another engine.';
      }
    }
    return null;
  }

  Future<void> _create(
    String swarmId,
    SwarmReader reader,
    String? repository,
    String machineId,
  ) async {
    if (_busy) return;
    final newRepository = repository == null ? _newRepository : null;
    if (repository == null && newRepository == null) return;
    // Held by the Swarm's reader: a sheet opened again resumes them.
    final steps = SwarmNewProjectSteps.of(reader)
      ..chosenMachine = machineId
      ..chosenRepository = repository
      ..chosenNewRepository = newRepository
      ..chosenEngine = _engine
      ..failure = null;
    setState(() {
      _busy = true;
      _error = null;
      _maybeMade = false;
    });
    try {
      final projectId = await steps.run(
        brief: _brief.text,
        visibility: _visibility,
        machineId: machineId,
        repositoryUrl: repository,
        newRepository: newRepository,
        engine: _engine,
        files: _files.files,
        live: () => _live(swarmId, reader),
        machinesOf: (snapshot) => _machinesOf(swarmId, snapshot),
      );
      if (!mounted || !_live(swarmId, reader)) return;
      // Made, but Harness can't reach it yet (F7): the Product Manager was
      // started all the same, and the sheet says what its owner does.
      if (steps.unreachable && newRepository != null) {
        setState(() {
          _madeUnreachable = (swarmId: swarmId, projectId: projectId);
          _unreachableLine = swarmRepositoryUnreachable(
            newRepository.owner,
            newRepository.name,
          );
        });
        return;
      }
      _closing = true;
      Navigator.of(context).pop((swarmId: swarmId, projectId: projectId));
    } on SwarmRepositoryWaiting {
      // Out in GitHub: its outcome comes back in the Swarm state.
    } on SwarmRepositoryFailure catch (failure) {
      // Said in the design's words, as they are (F2 to F11).
      steps.failure = failure.line;
      if (!_live(swarmId, reader)) return;
      setState(() => _error = failure.line);
      _showError();
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
  /// stays, as Desktop leaves it in the list. Kept with [steps], for a sheet
  /// that opens on them again.
  void _fail(
    String swarmId,
    SwarmReader reader,
    SwarmNewProjectSteps steps,
    String why,
  ) {
    final error = steps.projectId == null
        ? 'Couldn’t create the project: $why'
        // Its project deleted meanwhile, the steps were let go: the next
        // Create starts afresh.
        : !identical(SwarmNewProjectSteps.heldBy(reader), steps)
        ? why
        : steps.started
        ? 'The project is made and its Product Manager is starting. '
              'Naming it didn’t finish: $why'
        : 'The project is made. Its Product Manager didn’t start: $why';
    steps.failure = error;
    if (!_live(swarmId, reader)) return;
    setState(() => _error = error);
    _showError();
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
      _picking = switch (pick) {
        _Pick.link || _Pick.newRepository => _Pick.repository,
        _Pick.owner => _Pick.newRepository,
        _ => null,
      };
      _linkError = null;
    });
    final header = _header(
      switch (pick) {
        _Pick.swarm => 'Swarm',
        _Pick.visibility => 'Visibility',
        _Pick.repository => 'Repository',
        _Pick.link => 'Enter a link',
        _Pick.newRepository => 'New repository',
        _Pick.owner => 'Owner',
        _Pick.machine => 'PM runs on',
        _Pick.engine => 'Agent',
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
                    // Still choosable: it may resume before Create.
                    detail: _paused(id) ? 'Paused' : null,
                    trailing: id == swarmId ? tick() : null,
                    onTap: () => setState(() {
                      _picking = null;
                      if (id == _swarmId) return;
                      // Another Swarm: its own repositories and machines.
                      _dropUnsent();
                      _swarmId = id;
                      _error = null;
                      _maybeMade = false;
                      _repository = null;
                      _repositoryPicked = false;
                      _machineId = null;
                      _engine = null;
                      _modelList = const {};
                      _leadModelOn = true;
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
                      _newRepository = null;
                      _repositoryPicked = true;
                      _picking = null;
                    }),
                  ),
                // Only where the server can make one (Task 6's organization
                // check: an older server answers 404, and one with no GitHub
                // sign-in says not-configured, F6).
                if (_newRepositoryOffered(swarmId, reader, repositories))
                  _Option(
                    key: const ValueKey('swarm-new-project-pick-new-repo'),
                    leading: Icon(
                      LucideIcons.plus300,
                      size: 20,
                      color: AppPalette.textSecondary,
                    ),
                    title: 'New repository',
                    trailing: _newRepository == null
                        ? null
                        : Icon(
                            LucideIcons.check300,
                            size: 20,
                            color: AppPalette.swarmAccent,
                          ),
                    onTap: () => setState(() {
                      _picking = _Pick.newRepository;
                      _newOwner ??= swarmGitHubOwners(repositories).firstOrNull;
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
      case _Pick.newRepository:
        return _newRepositoryPage(header, swarmId, reader);
      case _Pick.owner:
        return _ownerPage(header, reader);
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
            _newRepository = null;
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
          ],
          footer: [
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
                      detail: m.detailFor(_engine),
                      trailing: m.id == _machineId ? tick() : null,
                      onTap: m.startable
                          ? () => setState(() {
                              _machineId = m.id;
                              // The machine chosen last wins over an engine
                              // it cannot run (Desktop's chooseLeadMachine).
                              if (_engine case final engine?
                                  when !m.runs(engine)) {
                                _engine = null;
                              }
                              _picking = null;
                              _error = null;
                            })
                          : null,
                    ),
                ],
              ),
          ],
        );
      case _Pick.engine:
        final machine = _machinesOf(
          swarmId,
          snapshot,
        ).where((m) => m.id == _machineId).firstOrNull;
        final chosen = _engineOf(swarmId, machine);
        // Each engine a Product Manager runs on, with the model it gets; one
        // the machine chosen (or, before one is, the Swarm's model list)
        // rules out says why.
        Widget option(String engine) {
          final why =
              (machine?.engineRefusals ?? _modelListOf(swarmId))[engine];
          return _Option(
            key: ValueKey('swarm-new-project-pick-agent-$engine'),
            leading: EngineMark(engine: engine, size: AppIconSize.besideText),
            title: swarmLeadEngineLabel(engine),
            detail:
                why ?? swarmLeadModelLabel(engine, leadModelOn: _leadModelOn),
            trailing: engine == chosen ? tick() : null,
            onTap: why == null
                ? () => setState(() {
                    _engine = engine;
                    _picking = null;
                    _error = null;
                  })
                : null,
          );
        }

        return _frame(
          header: header,
          children: [
            SwarmGroup(
              children: [for (final engine in swarmLeadEngines) option(engine)],
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
    this.hint,
    required this.onTap,
  });

  final String label, value;
  final String? detail;

  /// A faint line under it all: what else a tap offers.
  final String? hint;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final enabled = onTap != null;
    return Semantics(
      button: true,
      enabled: enabled,
      label: ['$label: $value', ?detail, ?hint].join(', '),
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
                        if (hint case final hint?) ...[
                          const SizedBox(height: 3),
                          Text(
                            hint,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            textAlign: TextAlign.end,
                            style: AppType.caption(
                              color: AppPalette.textFaint,
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
