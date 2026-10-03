import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/notify/agent_notice.dart' show NoticeKind;
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/pending_question.dart';
import 'package:harness_mobile/terminal/terminal_binary.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import 'sample_harness.dart';
import 'sample_notifier.dart';
import 'sample_screen.dart';
import 'sample_scripts.dart';
import 'sample_text.dart';
import 'sample_voice.dart';

/// Everything sample mode runs: its app state, the two computers answering it, the harnesses on
/// them, and every timer any of it holds.
///
/// It plays the part of the harness daemon on each computer. A terminal opened on a sample
/// harness is answered with a stream — `terminal_ready`, then a keyframe of what that harness has
/// on screen, then its output as it happens — through the same [TerminalSession] a real machine
/// would reach, so the phone draws it with the same code. What is typed comes back the same way,
/// as input frames, and becomes keystrokes in the harness.
///
/// [dispose] ends all of it at once: every timer the sample started is on [_timers], so leaving
/// cannot leave one running.
class SampleRuntime implements SampleHarnessHost {
  SampleRuntime({DateTime? now}) {
    notifier = SampleNotifier(
      connections: _connectionFor,
      machinesOnFile: () => machines,
      transcribe: () => transcriber.transcribe(),
    );
    _seed(now ?? DateTime.now());
  }

  late final SampleNotifier notifier;

  late final SampleTranscriber transcriber = SampleTranscriber(
    after: schedule,
    answering: _focusedIsAsking,
  );

  final Map<String, SampleConnection> _connections = {};
  final Map<String, SampleHarness> _harnesses = {};
  final Map<String, _Stream> _streams = {};
  final Map<String, Map<String, dynamic>> _creations = {};
  final Set<Timer> _timers = {};
  final Random _random = Random();
  int _created = 0;
  int _questions = 0;
  bool _disposed = false;

  /// The sample's computers, as the account lists them.
  List<Machine> get machines => [
    for (final computer in sampleComputers)
      Machine(
        machineId: computer.id,
        authMode: MachineAuthMode.remote,
        name: computer.name,
        hostname: computer.name,
        status: 'online',
      ),
  ];

  /// Every harness in the sample, keyed `machineId/agentId`.
  @visibleForTesting
  Map<String, SampleHarness> get harnesses => Map.unmodifiable(_harnesses);

  SampleHarness? harnessOf(String machineId, String agentId) =>
      _harnesses['$machineId/$agentId'];

  /// The connection to one sample computer — what the notifier dials.
  SampleConnection connectionFor(String machineId) => _connectionFor(machineId);

  /// Voice input for the sample's pager: a microphone that records nothing, heard as
  /// [transcriber] says.
  VoiceInputController voiceController() => VoiceInputController(
    transcriber: (_, _) => transcriber.transcribe(),
    recorder: SampleVoiceRecorder(every: every),
  );

  // ── the clock ──────────────────────────────────────────────────────────────────────────────

  @override
  Timer schedule(Duration delay, void Function() run) {
    late final Timer timer;
    timer = Timer(delay, () {
      _timers.remove(timer);
      if (!_disposed) run();
    });
    _track(timer);
    return timer;
  }

  @override
  Timer every(Duration period, void Function() run) {
    final timer = Timer.periodic(period, (_) {
      if (!_disposed) run();
    });
    _track(timer);
    return timer;
  }

  void _track(Timer timer) {
    if (_disposed) {
      timer.cancel();
      return;
    }
    _timers
      ..removeWhere((held) => !held.isActive)
      ..add(timer);
  }

  // ── the starting state ─────────────────────────────────────────────────────────────────────

  void _seed(DateTime now) {
    notifier.machines = machines;
    for (final machine in notifier.machines) {
      notifier.machineStates[machine.machineId] = MachineState(machine)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..terminalCapabilityLoaded = true
        ..terminalCapabilityAvailable = true
        ..terminalNoTakeoverAvailable = true
        ..projectFolderAvailable = true;
    }
    final seeds = sampleSeeds(now);
    for (final seed in seeds) {
      final harness = SampleHarness(
        machineId: seed.computer.id,
        agent: seed.agent,
        host: this,
        transcript: seed.transcript,
        loop: seed.loop,
      );
      _harnesses['${harness.machineId}/${harness.agentId}'] = harness;
      _publish(harness);
      for (final entry in seed.transcript) {
        if (entry is UserEntry) harness.asks.insert(0, entry.text);
      }
      if (seed.finished case final reply?) {
        harness.replies.insert(0, reply);
        // News nobody has read: marked without the chime a live turn ending would make.
        notifier.agentNotices.unread.mark((
          machineId: harness.machineId,
          agentId: harness.agentId,
        ), NoticeKind.done);
      }
    }
    for (final seed in seeds) {
      final harness = harnessOf(seed.computer.id, seed.agent['id'] as String)!;
      if (seed.ask != null) {
        harness.begin(ask: seed.ask, then: seed.then);
      } else if (seed.loop != null) {
        harness.begin(verb: 'Tracing');
      }
    }
  }

  // ── what the harnesses report ─────────────────────────────────────────────────────────────

  @override
  void appended(SampleHarness harness, List<SampleEntry> entries) {
    for (final stream in _streamsOf(harness)) {
      _write(stream, entries);
    }
  }

  @override
  void liveChanged(SampleHarness harness) {
    for (final stream in _streamsOf(harness)) {
      _write(stream, const []);
    }
  }

  @override
  void workingChanged(SampleHarness harness, bool working) {
    final machine = notifier.stateOf(harness.machineId);
    if (machine == null) return;
    if (working) {
      machine.processingAgentIds.add(harness.agentId);
    } else {
      machine.processingAgentIds.remove(harness.agentId);
    }
    machine.agentActivityAt[harness.agentId] = DateTime.now();
    _publish(harness);
    notifier.changed();
  }

  @override
  void askChanged(SampleHarness harness, SampleAsk? ask) {
    final machine = notifier.stateOf(harness.machineId);
    if (machine == null) return;
    final ref = (machineId: harness.machineId, agentId: harness.agentId);
    if (ask == null) {
      machine.blockedAgents.remove(harness.agentId);
      notifier.agentNotices.unread.clear(ref, kind: NoticeKind.question);
    } else {
      machine.blockedAgents[harness.agentId] = PendingQuestion(
        machineId: harness.machineId,
        agentId: harness.agentId,
        requestId: 'sample-question-${++_questions}',
        answerKey: ask.announced,
        prompt: ask.announced,
        options: ask.options,
        multi: false,
        since: DateTime.now(),
      );
      if (!_watching(ref)) {
        notifier.agentNotices.unread.mark(ref, NoticeKind.question);
      }
    }
    notifier.changed();
  }

  @override
  void turnEnded(SampleHarness harness, String? reply) {
    _publish(harness);
    final machine = notifier.stateOf(harness.machineId);
    if (reply != null && machine != null) {
      final ref = (machineId: harness.machineId, agentId: harness.agentId);
      notifier.agentNotices.turnEnded(
        (
          ref: ref,
          name: harness.agent['name'] as String? ?? 'harness',
          machine: machine.machine.displayName,
        ),
        (aborted: false, replay: false, subagent: false, reply: reply),
        watching: () => _watching(ref),
      );
    }
    notifier.changed();
  }

  @override
  List<SampleStep> replyTo(SampleHarness harness, String text) =>
      sampleReply(harness, text);

  bool _watching(({String machineId, String agentId}) ref) {
    final pane = notifier.focusedPane;
    return pane != null &&
        pane.machineId == ref.machineId &&
        pane.agentId == ref.agentId;
  }

  bool _focusedIsAsking() {
    final pane = notifier.focusedPane;
    final agentId = pane?.agentId;
    if (pane == null || agentId == null) return false;
    return harnessOf(pane.machineId, agentId)?.asking ?? false;
  }

  /// [harness]'s agent, as its machine now describes it, into the notifier's list.
  void _publish(SampleHarness harness) {
    final machine = notifier.stateOf(harness.machineId);
    if (machine == null) return;
    final agent = Agent.fromJson(Map<String, dynamic>.from(harness.agent));
    final agents = [...machine.agents];
    final at = agents.indexWhere((known) => known.id == agent.id);
    if (at < 0) {
      agents.add(agent);
    } else {
      agents[at] = agent;
    }
    machine.agents = agents;
  }

  // ── the machines' side of the wire ────────────────────────────────────────────────────────

  SampleConnection _connectionFor(String machineId) => _connections.putIfAbsent(
    machineId,
    () => SampleConnection._(this, machineId),
  );

  Future<Map<String, dynamic>> _request(
    String machineId,
    String type,
    Map<String, dynamic> payload,
  ) async {
    if (_disposed) {
      throw WsRequestFailure(responseType: '${type}_result', code: 'CLOSED');
    }
    final agentId = payload['agentId'] as String?;
    final harness = agentId == null ? null : harnessOf(machineId, agentId);
    switch (type) {
      case 'agents_list':
        return {
          'agents': [
            for (final harness in _harnesses.values)
              if (harness.machineId == machineId) {...harness.agent},
          ],
        };
      case 'terminal_capabilities':
        return {
          'protocolVersion': TerminalSession.protocolVersion,
          'backend': 'tmux',
          'available': true,
          'features': {'noTakeover': true, 'projectFolder': true},
        };
      case 'engines_probe':
        final asked = payload['engines'];
        return {
          'engines': [
            for (final engine
                in asked is List ? asked : const ['claude', 'codex'])
              {
                'engine': engine,
                'installed': engine == 'claude' || engine == 'codex',
                'installable': true,
                'command': engine,
                if (engine == 'codex') 'supportsCodexHome': true,
              },
          ],
        };
      case 'codex_profiles_list':
        return {'profiles': const []};
      case 'fs_list_dir':
        return _listDir(payload['path']);
      case 'git_project_info':
        return _gitInfo(payload['path']);
      case 'agent_create':
        return _create(machineId, payload);
      case 'agent_create_status':
        return _creations[payload['creationId']] ??
            {'creationId': payload['creationId'], 'state': 'missing'};
      case 'agent_update':
        if (harness == null) break;
        if (payload['name'] case final String name
            when name.trim().isNotEmpty) {
          harness.agent['name'] = name.trim();
        }
        if (payload['opened'] == true) {
          harness.agent['lastOpenedAt'] = DateTime.now()
              .toUtc()
              .toIso8601String();
        }
        _publish(harness);
        notifier.changed();
        return {};
      case 'agent_delete':
        if (harness == null) break;
        _forget(harness);
        return {};
      case 'agent_restart':
      case 'agent_resume':
        if (harness == null) break;
        harness.restart();
        return {
          'agent': {...harness.agent},
          'resumed': true,
        };
      case 'agent_recent':
        if (harness == null) break;
        return {
          'agentId': harness.agentId,
          'asks': [...harness.asks],
          'events': [
            for (final reply in harness.replies)
              {'kind': 'summary', 'text': reply},
          ],
        };
      case 'usage_read':
        return {};
      case 'grid_models_list':
        // Find's `:` — the models a sample harness could run on: this computer's own, as a
        // real machine lists them.
        return {
          'supportsModelLaunch': true,
          'gridName': 'home',
          'localModelEngines': ['claude', 'codex', 'opencode'],
          'grids': [
            {
              'name': 'home',
              'own': true,
              'models': [
                // A node by the name the computer goes by, as a real one reports it — the
                // sample's machine ids (`sample-studio`) are fixture plumbing, not names.
                {
                  'id': 'qwen3-coder-30b',
                  'node': machineId.replaceFirst('sample-', ''),
                },
                {
                  'id': 'gpt-oss-20b',
                  'node': machineId.replaceFirst('sample-', ''),
                },
                {'id': 'devstral-small', 'node': 'laptop'},
              ],
            },
          ],
        };
    }
    throw WsRequestFailure(
      responseType: '${type}_result',
      code: harness == null && agentId != null
          ? 'AGENT_NOT_FOUND'
          : 'UNSUPPORTED',
      detail: 'Not part of the sample.',
    );
  }

  /// `agent_create`: a new harness on [machineId], started on its first task when it was given one.
  Map<String, dynamic> _create(String machineId, Map<String, dynamic> payload) {
    final creationId = payload['creationId'];
    final engine = payload['engine'] as String? ?? 'claude';
    if (engine != 'claude' && engine != 'codex') {
      throw const WsRequestFailure(
        responseType: 'agent_create_result',
        code: 'INVALID_ENGINE',
        detail: 'The sample runs Claude Code and Codex.',
      );
    }
    final number = ++_created;
    final cwd = _cwdFor(payload, number);
    final project = cwd.split('/').where((part) => part.isNotEmpty).last;
    final branchRef = payload['branchRef'] as String?;
    final branch =
        payload['branchName'] as String? ??
        branchRef?.replaceFirst(RegExp(r'^refs/(heads|remotes/[^/]+)/'), '') ??
        'main';
    final task = (payload['prompt'] as String?)?.trim();
    final agent = sampleAgentJson(
      id: 'sample-new-$number',
      // Named for its task the way the others are named — `dark-mode-toggle` — or numbered.
      name: (task == null ? null : sampleSlug(task)) ?? 'harness-${number + 5}',
      engine: engine,
      project: project,
      branch: branch,
      updatedAt: DateTime.now(),
    );
    (agent['project'] as Map)['cwd'] = cwd;
    (agent['project'] as Map)['root'] = cwd;
    if (payload['gridModel'] case final String model) {
      agent['grid'] = {'model': model, 'gridName': payload['gridName']};
    }
    final harness = SampleHarness(
      machineId: machineId,
      agent: agent,
      host: this,
      transcript: [BannerEntry(cwd)],
    );
    _harnesses['$machineId/${harness.agentId}'] = harness;
    // Every app hears about a new harness, not only the one that asked for it.
    _publish(harness);
    notifier.changed();
    if (task != null && task.isNotEmpty) {
      // The engine starts, and the task is typed into it.
      schedule(const Duration(milliseconds: 900), () => harness.submit(task));
    }
    final reply = {
      'creationId': creationId,
      'state': 'created',
      'agent': {...agent},
    };
    if (creationId is String) _creations[creationId] = reply;
    return reply;
  }

  String _cwdFor(Map<String, dynamic> payload, int number) {
    final cwd = payload['cwd'];
    if (cwd is String && cwd.trim().isNotEmpty) return cwd.trim();
    final source = payload['gitSource'];
    if (source is String && source.isNotEmpty) return source;
    final url = payload['repositoryUrl'];
    if (url is String && url.isNotEmpty) {
      final name = url
          .split(RegExp(r'[/:]'))
          .where((part) => part.isNotEmpty)
          .last
          .replaceFirst(RegExp(r'\.git$'), '');
      return '~/code/$name';
    }
    return '~/code/new-project-$number';
  }

  void _forget(SampleHarness harness) {
    harness.dispose();
    _harnesses.remove('${harness.machineId}/${harness.agentId}');
    _streams.removeWhere((_, stream) => identical(stream.harness, harness));
    final machine = notifier.stateOf(harness.machineId);
    machine?.processingAgentIds.remove(harness.agentId);
    machine?.blockedAgents.remove(harness.agentId);
  }

  static const _folders = <String, List<String>>{
    '~': ['code', 'Desktop', 'Documents', 'Downloads'],
    '~/code': ['api', 'docs', 'mobile', 'web', 'scratch'],
    '~/code/api': ['db', 'src', 'tests'],
    '~/code/docs': ['public', 'src'],
    '~/code/mobile': ['android', 'ios', 'lib', 'test'],
    '~/code/web': ['public', 'src', 'test'],
    '~/code/scratch': [],
  };

  Map<String, dynamic> _listDir(Object? raw) {
    var path = raw is String ? raw.trim() : '';
    if (path.endsWith('/') && path.length > 1) {
      path = path.substring(0, path.length - 1);
    }
    // Somewhere the sample has no folder for is the home folder — including `.`, which is
    // where going up from `~` leads.
    if (!_folders.containsKey(path) && !path.startsWith('~/code/')) path = '~';
    return {
      'path': path,
      'entries': [
        for (final name in _folders[path] ?? const <String>[])
          {'name': name, 'isDir': true},
      ],
      'truncated': false,
    };
  }

  Map<String, dynamic> _gitInfo(Object? raw) {
    final path = raw is String ? raw : '';
    final project = RegExp(r'^~/code/([^/]+)$').firstMatch(path)?.group(1);
    if (project == null || project == 'scratch') return {'isGit': false};
    return {
      'isGit': true,
      'branch': 'main',
      'defaultRef': 'refs/remotes/origin/main',
      'branches': [
        {'ref': 'refs/heads/main', 'name': 'main'},
        {'ref': 'refs/heads/dev', 'name': 'dev'},
        {
          'ref': 'refs/remotes/origin/main',
          'name': 'origin/main',
          'remote': true,
        },
      ],
    };
  }

  // ── terminals ─────────────────────────────────────────────────────────────────────────────

  bool _terminalFrame(
    String machineId,
    String type,
    Map<String, dynamic> payload,
  ) {
    if (_disposed) return false;
    final stream = _streams[payload['streamId']];
    switch (type) {
      case 'terminal_open':
        _open(machineId, payload);
      case 'terminal_resize':
        if (stream == null) break;
        stream
          ..cols = (payload['cols'] as num?)?.toInt() ?? stream.cols
          ..rows = (payload['rows'] as num?)?.toInt() ?? stream.rows;
        _keyframe(stream);
      case 'terminal_resync':
        if (stream != null) _keyframe(stream);
      case 'terminal_close':
        _streams.remove(payload['streamId']);
      case 'message':
        final agentId = payload['agentId'];
        final content = payload['content'];
        if (agentId is String && content is String) {
          harnessOf(machineId, agentId)?.submit(content);
        }
    }
    return true;
  }

  bool _terminalBinary(Uint8List bytes) {
    if (_disposed) return false;
    final frame = decodeTerminalLocal(bytes);
    if (frame == null) return true;
    final stream = _streams[frame.streamId];
    if (stream == null) return true;
    if (frame.kind == TerminalBinaryKind.input ||
        frame.kind == TerminalBinaryKind.paste) {
      stream.harness.keys(utf8.decode(frame.bytes, allowMalformed: true));
    }
    return true;
  }

  void _open(String machineId, Map<String, dynamic> payload) {
    final agentId = payload['agentId'];
    final requestId = payload['requestId'];
    final harness = agentId is String ? harnessOf(machineId, agentId) : null;
    // A beat, as a real attach takes one — and after `send` has returned, as a reply would.
    schedule(const Duration(milliseconds: 160), () {
      if (harness == null) {
        _toSessions(machineId, 'terminal_error', {
          'requestId': requestId,
          'code': 'AGENT_NOT_FOUND',
          'message': 'That harness is not in the sample.',
        });
        return;
      }
      final stream = _Stream(
        id: _streamId(),
        harness: harness,
        cols: (payload['cols'] as num?)?.toInt() ?? 80,
        rows: (payload['rows'] as num?)?.toInt() ?? 24,
      );
      _streams[stream.id] = stream;
      _toSessions(machineId, 'terminal_ready', {
        'protocolVersion': TerminalSession.protocolVersion,
        'requestId': requestId,
        'agentId': agentId,
        'streamId': stream.id,
      });
      _keyframe(stream);
    });
  }

  /// A JSON frame, to every session on [machineId] — each one matches its own request, as it does
  /// with a real machine's.
  void _toSessions(
    String machineId,
    String type,
    Map<String, dynamic> payload,
  ) {
    for (final pane in notifier.panesFor(machineId).toList()) {
      final session = pane.session;
      if (session != null) unawaited(session.handleFrame(type, payload));
    }
  }

  Iterable<_Stream> _streamsOf(SampleHarness harness) => _streams.values
      .where((stream) => identical(stream.harness, harness))
      .toList();

  /// Everything [stream]'s harness has on screen, at [stream]'s width — after the modes both
  /// CLIs set: the cursor hidden (they draw their own caret) and bracketed paste on, so a paste
  /// arrives as one piece rather than as lines that each press Return.
  void _keyframe(_Stream stream) {
    final width = SampleText.fit(stream.cols);
    final harness = stream.harness;
    final live = harness.look.live(harness.live, width);
    final lines = [
      ...harness.look.transcript(harness.transcript, width),
      ...live,
    ];
    stream.live = live.length;
    _send(
      stream,
      TerminalBinaryKind.keyframe,
      '\x1b[?25l\x1b[?2004h${lines.join('\r\n')}',
    );
  }

  /// [entries] added above the live region, and the live region drawn again under them — the
  /// cursor walks back up to where the live region starts, clears to the end of the screen, and
  /// writes.
  void _write(_Stream stream, List<SampleEntry> entries) {
    final width = SampleText.fit(stream.cols);
    final harness = stream.harness;
    final live = harness.look.live(harness.live, width);
    // A live region taller than the pane cannot be walked back over: the top of it has scrolled
    // off. A keyframe says the same thing in one go.
    if (stream.live >= stream.rows || live.length >= stream.rows) {
      _keyframe(stream);
      return;
    }
    final lines = [
      for (final entry in entries) ...[...harness.look.entry(entry, width), ''],
      ...live,
    ];
    final back = stream.live > 1 ? '\x1b[${stream.live - 1}A' : '';
    stream.live = live.length;
    _send(
      stream,
      TerminalBinaryKind.output,
      '\r$back\x1b[J${lines.join('\r\n')}',
    );
  }

  void _send(_Stream stream, TerminalBinaryKind kind, String text) {
    final holders = [
      for (final pane in notifier.panesFor(stream.harness.machineId))
        if (pane.session case final session? when session.streamId == stream.id)
          session,
    ];
    if (holders.isEmpty) {
      // Nobody reads it any more — the page reopened, or went.
      _streams.remove(stream.id);
      return;
    }
    final keyframe = kind == TerminalBinaryKind.keyframe;
    final frame = TerminalBinaryFrame(
      kind: kind,
      streamId: stream.id,
      seq: stream.seq++,
      bytes: utf8.encode(text),
      compressed: false,
      cols: keyframe ? stream.cols : null,
      rows: keyframe ? stream.rows : null,
    );
    for (final session in holders) {
      unawaited(session.handleBinary(frame));
    }
  }

  /// Stream ids are UUIDs: the binary frames carry them as 16 bytes.
  String _streamId() {
    final hex = [
      for (var i = 0; i < 16; i++)
        _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ].join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-'
        '${hex.substring(16, 20)}-${hex.substring(20)}';
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    for (final timer in _timers) {
      timer.cancel();
    }
    _timers.clear();
    for (final harness in _harnesses.values) {
      harness.dispose();
    }
    _streams.clear();
    notifier.dispose();
  }
}

class _Stream {
  _Stream({
    required this.id,
    required this.harness,
    required this.cols,
    required this.rows,
  });

  final String id;
  final SampleHarness harness;
  int cols;
  int rows;
  int seq = 0;

  /// How many lines of live region the pane is showing — how far a redraw walks back up.
  int live = 0;
}

/// One sample computer's end of the wire: everything the app sends a machine is answered here,
/// in-process, and nothing is sent anywhere.
class SampleConnection extends WsConn {
  SampleConnection._(this._runtime, String machineId)
    : super(
        wsBaseUrl: 'wss://sample.invalid',
        autonomousEnv: 'sample',
        machineId: machineId,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final SampleRuntime _runtime;

  @override
  bool get isReady => !_runtime._disposed;

  @override
  Future<void> connect() async {}

  @override
  void reconnectNow() {}

  @override
  Future<void> forceReconnect() async {}

  @override
  Future<void> close() async {}

  // ⚠️ Every answer comes back on a LATER microtask, never inside the call. A machine's reply
  // always arrives after the send returns, and the app is written for that: an answer given
  // synchronously lands in the middle of whatever asked — a widget's `initState`, a build — and
  // its notification rebuilds a tree that is still being built.

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    await Future<void>.value();
    return _runtime._request(machineId, type, payload);
  }

  @override
  void sendRaw(String type, Map<String, dynamic> payload) =>
      unawaited(sendTerminalFrame(type, payload));

  @override
  Future<void> sendFrame(Map<String, dynamic> frame) async {
    await Future<void>.value();
    final type = frame['type'];
    final payload = frame['payload'];
    if (type is String && payload is Map<String, dynamic>) {
      _runtime._terminalFrame(machineId, type, payload);
    }
  }

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    await Future<void>.value();
    return _runtime._terminalFrame(machineId, type, payload);
  }

  @override
  Future<bool> sendTerminalBinary(Uint8List bytes) async {
    await Future<void>.value();
    return _runtime._terminalBinary(bytes);
  }
}
