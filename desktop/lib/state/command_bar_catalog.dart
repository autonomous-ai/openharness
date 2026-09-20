import 'app_state.dart';
import 'command_bar.dart';
import 'swarm_navigation.dart';
import '../widgets/engine_identity.dart' show isTerminalEngine;

/// Curated effects the natural-language surface can actually perform. Closing sessions,
/// approvals, arbitrary shell commands and viewer controls are intentionally absent.
const commandBarCommands = {
  'navigation.needs_input':
      'Find live questions and agents waiting for your input.',
  'navigation.history': 'Return to previously opened harnesses and sessions.',
  'app.settings':
      'Change preferences, appearance, account or connection settings.',
  'machines.manage':
      'Open Machines, the harness that links, names and retires your computers.',
  'machines.list': 'See connected computers and their link state.',
  'machine.link': 'Open the setup dialog to connect another computer.',
  'swarm.new': 'Open a fresh empty tab.',
  'swarm.reopen': 'Reopen the most recently closed harness.',
  'agent.add': 'Browse existing harnesses and add one to this workspace.',
  'project.add': 'Choose a project folder to add to the workspace.',
  'pane.layout': 'Open the workspace layout chooser.',
  'pane.zoom': 'Toggle the focused pane between full size and the grid.',
  'pane.split_right': 'Choose a harness to open beside the current pane.',
  'pane.split_down': 'Choose a harness to open below the current pane.',
  'machines.refresh': 'Refresh the list of machines and running agents.',
};

// Full phrases only: "open settings and delete my project" cannot match "open settings".
const _commandPhrases = {
  'navigation.needs_input': [
    'needs input',
    'show pending questions',
    'which agents need my input',
  ],
  'navigation.history': ['history', 'show history', 'open history'],
  'app.settings': [
    'settings',
    'open settings',
    'show settings',
    'open preferences',
  ],
  'machines.manage': ['manage machines', 'open machines'],
  'machines.list': [
    'show machines',
    'machine list',
    'show connected computers',
  ],
  'machine.link': ['link machine', 'connect a computer'],
  'swarm.new': ['new tab', 'open a new tab', 'open a fresh tab'],
  'swarm.reopen': ['reopen last harness', 'reopen the last harness'],
  'agent.add': ['add existing harness', 'add an existing harness'],
  'project.add': ['add project folder', 'add a project folder'],
  'pane.layout': [
    'show layout options',
    'show me the layout options',
    'change layout',
  ],
  'pane.zoom': ['toggle pane zoom', 'zoom pane'],
  'pane.split_right': ['split right'],
  'pane.split_down': ['split down'],
  'machines.refresh': ['refresh machines', 'refresh agents'],
};

List<String> _openPhrases(String title) => [
  'open $title',
  'go to $title',
  'switch to $title',
  'take me back to $title',
];

Future<String?> Function()? _goBack(AppNotifier app, SwarmDestination target) {
  final origin = app.activeSwarm;
  final pane = app.focusedPane;
  if (target.current || (pane == null && target.swarmId == null)) return null;
  final machineId = pane?.machineId;
  final agentId = pane?.agentId;
  final sessionId = app
      .stateOf(machineId ?? '')
      ?.agents
      .where((a) => a.id == agentId)
      .firstOrNull
      ?.sessionId;
  return () async {
    if (!app.swarms.contains(origin) ||
        (pane == null && origin.panes.isNotEmpty) ||
        (pane != null &&
            (!origin.panes.contains(pane) ||
                pane.machineId != machineId ||
                pane.agentId != agentId ||
                app
                        .stateOf(machineId!)
                        ?.agents
                        .where((a) => a.id == agentId)
                        .firstOrNull
                        ?.sessionId !=
                    sessionId))) {
      return 'The previous view changed or was closed.';
    }
    app.selectSwarm(origin.id, attachPending: false);
    if (pane != null) app.focusPane(pane.id, reveal: true);
    return null;
  };
}

List<CommandBarAction> buildCommandBarCatalog(
  AppNotifier app, {
  required List<SwarmDestination> commands,
  required void Function(String id) runCommand,
  required Future<void> Function(
    String? machineId,
    String? engine,
    String prompt,
  )
  create,
  List<String> recent = const [],
}) {
  String short(String? text, int max) {
    final value = text?.trim() ?? '';
    return value.length <= max ? value : '${value.substring(0, max - 1)}…';
  }

  final workspace = '${app.activeSwarmId}:${app.focusedPaneId}';
  final actions = <CommandBarAction>[
    const CommandBarAction(
      id: 'semantic:search',
      kind: CommandKind.search,
      title: 'Find work by meaning',
      detail: 'Find sessions about a topic, blocked work, results ready to review, repeated failures or overlapping work. Show matching recent activity.',
      automatic: true,
    ),
    const CommandBarAction(
      id: 'semantic:watch',
      kind: CommandKind.watch,
      title: 'Watch for a change',
      detail: 'Watch the current sessions for a natural-language condition. Show matches in this window, checking changed activity at most once a minute. Stops when the window closes.',
    ),
    CommandBarAction(
      id: 'app:store',
      kind: CommandKind.command,
      title: 'Explore the Harness Store',
      detail: 'Browse specialized harnesses for coding, design, research, slides, 3D, and more.',
      automatic: true,
      phrases: [
        'harness store',
        'open the harness store',
        'show me the harness store',
      ],
      perform: (_) async {
        app.openStore();
        return null;
      },
    ),
    CommandBarAction(
      id: 'create:general',
      kind: CommandKind.create,
      title: 'Start a new harness',
      detail: 'Give a new agent this task. Choose the engine, computer and folder in setup.',
      version: workspace,
      perform: (prompt) async {
        await create(null, null, prompt);
        return null;
      },
    ),
    for (final command in commands)
      if (commandBarCommands.containsKey(command.commandId))
        CommandBarAction(
          id: command.id,
          kind: CommandKind.command,
          title: command.title,
          detail: commandBarCommands[command.commandId]!,
          version: workspace,
          automatic: true,
          phrases: _commandPhrases[command.commandId] ?? const [],
          perform: (_) async {
            runCommand(command.commandId!);
            return null;
          },
        ),
  ];

  final local = app.localMachineState;
  // Only advertised, compatible catalog entries; the existing creation dialog handles installation.
  if (local != null) {
    for (final harness
        in local.dsh.byId.values.where((h) => !h.isViewerPackage).take(24)) {
      actions.add(
        CommandBarAction(
          id: 'create:${local.machine.machineId}:${harness.id}',
          kind: CommandKind.create,
          title: 'Start ${short(harness.name, 130)}',
          detail: short(
            harness.description ?? harness.category ?? 'Specialized harness',
            350,
          ),
          context:
              'On ${local.machine.displayName}. ${harness.installed ? 'Installed' : 'Setup will install this harness'}.',
          version: workspace,
          perform: (prompt) async {
            await create(local.machine.machineId, harness.id, prompt);
            return null;
          },
        ),
      );
    }
  }

  // The same navigation identities power the ordinary picker; they are resolved again on use.
  final destinations = swarmDestinations(app, recent: recent);
  final sessions = destinations.where((d) => d.agentId != null).take(24);
  for (final d in sessions) {
    final machine = app.stateOf(d.machineId!);
    final agent = machine?.agents.where((a) => a.id == d.agentId).firstOrNull;
    if (agent == null) continue;
    final preview = d.previewKey == null
        ? null
        : app.sessionPreviews.read(d.previewKey!);
    final question = machine!.blockedAgents[agent.id];
    final context = [
      if (d.current) 'This is the currently focused session.',
      'Status: ${agent.status}; ${machine.nodeOnline == false ? 'offline' : 'available'}',
      if (question != null) 'Needs input: ${short(question.prompt, 140)}',
      if (agent.verdict != null)
        'Harness verdict: ready=${agent.verdict!.ready}, errors=${agent.verdict!.errors}. ${short(agent.verdict!.summary, 100)}',
      if (preview?.latestRequest != null)
        'Request: ${short(preview!.currentRequest ?? preview.latestRequest, 150)}',
      // A previous success is not evidence that the currently running turn finished.
      // Omit that reply while work is in progress; do not add live or older transcript text.
      if (preview?.responseExcerpt != null && preview?.turnOpen != true)
        'Response: ${short(preview!.responseExcerpt, 240)}',
      if (preview?.receivedAt != null)
        'Observed: ${preview!.receivedAt!.toIso8601String()}',
    ].join('\n');
    final version = '${d.machineId}:${agent.id}:${agent.sessionId ?? ''}';
    actions.add(
      CommandBarAction(
        id: 'open:${d.id}',
        kind: CommandKind.open,
        title: short(d.title, 140),
        detail: short(d.detail, 200),
        context: short(context, 650),
        version: version,
        isSession: true,
        automatic: true,
        phrases: _openPhrases(d.title),
        goBack: _goBack(app, d),
        perform: (_) async {
          final live = swarmDestinations(app)
              .where((a) => a.id == d.id)
              .firstOrNull;
          if (live == null) return 'That session is no longer available.';
          return await activateSwarmDestination(
                app,
                live,
                destinationSwarmId: app.activeSwarmId,
              )
              ? null
              : 'That session cannot be opened right now.';
        },
      ),
    );
    if (machine.nodeOnline != false &&
        !machine.machine.isShared &&
        !isTerminalEngine(agent.engine) &&
        agent.terminalAvailable &&
        agent.launchState == 'ready' &&
        question == null) {
      actions.add(
        CommandBarAction(
          id: 'send:${d.id}',
          kind: CommandKind.send,
          title: short(d.title, 140),
          detail:
              'Send your exact prompt to this agent · ${short(d.detail, 180)}',
          context: short(context, 300),
          version: version,
          perform: (prompt) =>
              app.sendRoutedTask(agent.id, d.machineId!, prompt),
        ),
      );
    }
  }
  for (final d
      in destinations
          .where((d) => d.isSwarm && d.hasView && !d.current)
          .take(8)) {
    actions.add(
      CommandBarAction(
        id: 'open:${d.id}',
        kind: CommandKind.open,
        title: short(d.title, 140),
        detail: short(d.detail, 200),
        automatic: true,
        phrases: _openPhrases(d.title),
        goBack: _goBack(app, d),
        perform: (_) async =>
            await activateSwarmDestination(
              app,
              d,
              destinationSwarmId: app.activeSwarmId,
            )
            ? null
            : 'That tab is no longer available.',
      ),
    );
  }
  return actions;
}
