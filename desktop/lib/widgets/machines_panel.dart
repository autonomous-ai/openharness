import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../auth/cli_link.dart';
import '../core/models.dart';
import '../core/machine_resources.dart';
import '../screens/login_screen.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../state/app_state.dart';
import '../state/workspace_onboarding.dart';
import 'onboarding_card.dart';
import '../terminal/terminal_text.dart';
import 'box_chrome.dart' show ReadlineKeys;
import 'link_another_machine_dialog.dart'
    show
        kHarnessDownloadUrl,
        kLinkServerInstallCommand,
        kLinkServerLoginCommand,
        kLinkServerStartCommand;
import 'link_machine_dialog.dart';
import 'machine_actions.dart';
import 'terminal_name_prompt.dart';
import 'terminal_prompt.dart';
import 'transient_menus.dart';

/// One place to connect out and make this computer available. The notifier
/// owns every operation; closing this surface never cancels a link or save.
/// Returns the machine on which the user wants to open a harness.
Future<String?> showMachinesPanel(
  BuildContext context,
  AppNotifier notifier, {
  AppKeymap? keymap,
  String? initialMachineId,
}) => openMachinesPanel(
  context,
  notifier,
  keymap: keymap,
  initialMachineId: initialMachineId,
).closed;

/// An anchored toolbar surface, on the same overlay and with the same bounds
/// as Harnesses. It never pushes a route or dims the workspace.
MachinesPanelHandle openMachinesPanel(
  BuildContext context,
  AppNotifier notifier, {
  AppKeymap? keymap,
  String? initialMachineId,
  double toolbarHeight = 0,
  WorkspaceOnboarding? onboarding,
}) {
  if (initialMachineId != null) notifier.revisitLinkPrompt(initialMachineId);
  final activeKeymap = keymap ?? KeymapTheme.of(context, listen: false);
  final handle = MachinesPanelHandle._(notifier, initialMachineId);
  handle._entry = OverlayEntry(
    builder: (context) => LayoutBuilder(
      builder: (context, constraints) {
        final panel = _MachinesPanel(
          notifier: notifier,
          onboarding: onboarding,
          initialMachineId: initialMachineId,
          onClose: () => handle.close(),
          onOpen: (id) => handle.close(destination: id, restoreFocus: false),
          onModalChanged: handle.hideForModal,
          active: !handle._hidden,
        );
        return Offstage(
          offstage: handle._hidden,
          child: Stack(
            children: [
              Positioned.fill(
                top: toolbarHeight,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => handle.close(),
                  child: const SizedBox.expand(),
                ),
              ),
              Positioned(
                top: toolbarHeight + 8,
                right: 10,
                width: (constraints.maxWidth - 20).clamp(0, 640),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: (constraints.maxHeight - toolbarHeight - 20)
                        .clamp(0, 620),
                  ),
                  child: activeKeymap == null
                      ? panel
                      : KeymapProvider(keymap: activeKeymap, child: panel),
                ),
              ),
            ],
          ),
        );
      },
    ),
  );
  Overlay.of(context).insert(handle._entry);
  handle._entry.addListener(() {
    if (!handle._entry.mounted) {
      scheduleMicrotask(() => handle.close(restoreFocus: false));
    }
  });
  handle._unregister = registerTransientMenu(
    () => handle.close(restoreFocus: false),
  );
  return handle;
}

class MachinesPanelHandle {
  MachinesPanelHandle._(this._app, this._initialMachineId);
  final AppNotifier _app;
  final String? _initialMachineId;
  final _result = Completer<String?>();
  late final OverlayEntry _entry;
  VoidCallback? _unregister;
  bool restoreFocus = true;
  bool _hidden = false;
  Future<String?> get closed => _result.future;

  void rebuild() {
    if (!_result.isCompleted) _entry.markNeedsBuild();
  }

  void hideForModal(bool hidden) {
    _hidden = hidden;
    rebuild();
  }

  void close({String? destination, bool restoreFocus = true}) {
    if (_result.isCompleted) return;
    this.restoreFocus = restoreFocus;
    _unregister?.call();
    _unregister = null;
    if (_initialMachineId case final id?
        when _app.stateOf(id)?.needsLink == true) {
      _app.dismissLinkPrompt(id);
    }
    _entry.remove();
    _entry.dispose();
    _result.complete(destination);
  }
}

class _MachinesPanel extends StatefulWidget {
  const _MachinesPanel({
    required this.notifier,
    this.onboarding,
    this.initialMachineId,
    required this.onClose,
    required this.onOpen,
    required this.onModalChanged,
    required this.active,
  });
  final AppNotifier notifier;
  final WorkspaceOnboarding? onboarding;
  final String? initialMachineId;
  final VoidCallback onClose;
  final ValueChanged<String> onOpen;
  final ValueChanged<bool> onModalChanged;
  final bool active;

  @override
  State<_MachinesPanel> createState() => _MachinesPanelState();
}

class _MachinesPanelState extends State<_MachinesPanel>
    with WidgetsBindingObserver {
  AppNotifier get app => widget.notifier;
  final _panelFocus = FocusNode(debugLabel: 'Machines');
  bool _showSetup = false, _server = false, _signingIn = false;
  bool _downloadFailed = false;
  String? _expandedMachine;
  String? _focusMachine;
  final _resources = <String, MachineResources>{};
  final _resourceMachines = <String, MachineState>{};
  final _nextResourceRead = <String, int>{};
  final _resourceRequests = <String, Object>{};
  Timer? _resourceTimer;
  int _resourceTick = 0;

  bool get _canReadResources =>
      widget.active &&
      !app.isGuest &&
      (WidgetsBinding.instance.lifecycleState == null ||
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed);

  bool _readable(MachineState machine) =>
      !machine.machine.isShared &&
      !machine.needsLink &&
      machine.nodeOnline != false &&
      machine.connectionStatus == ConnectionStatus.connected;

  void _syncResourcePolling() {
    _resourceTimer?.cancel();
    _resourceTimer = null;
    if (!_canReadResources) return;
    _nextResourceRead.clear();
    _refreshResources();
    _resourceTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      _resourceTick++;
      _refreshResources();
    });
  }

  void _machinesChanged() {
    if (_canReadResources != (_resourceTimer != null)) {
      _syncResourcePolling();
    } else {
      _refreshResources();
    }
  }

  void _refreshResources() {
    if (!mounted) return;
    for (final id in {
      ..._nextResourceRead.keys,
      ..._resources.keys,
      ..._resourceRequests.keys,
    }) {
      final machine = app.stateOf(id);
      if (machine == null ||
          !identical(machine, _resourceMachines[id]) ||
          !_readable(machine)) {
        _resources.remove(id);
        _resourceMachines.remove(id);
        _nextResourceRead.remove(id);
        _resourceRequests.remove(id);
      }
    }
    if (!_canReadResources) return;
    for (final machine in app.machineStates.values) {
      final id = machine.machine.machineId;
      if (!_readable(machine) ||
          _resourceRequests.containsKey(id) ||
          (_nextResourceRead[id] ?? 0) > _resourceTick) {
        continue;
      }
      final request = Object();
      _resourceMachines[id] = machine;
      _resourceRequests[id] = request;
      _nextResourceRead[id] = _resourceTick + 1;
      unawaited(_readResources(machine, request));
    }
  }

  Future<void> _readResources(MachineState machine, Object request) async {
    final id = machine.machine.machineId;
    final reading = await app.readMachineResources(id);
    if (!mounted || _resourceRequests[id] != request) return;
    _resourceRequests.remove(id);
    if (!identical(app.stateOf(id), machine) || !_readable(machine)) return;
    // Older machines should not be asked every tick for a reply they cannot send.
    if (reading == null) {
      _nextResourceRead[id] = _resourceTick + 6;
    }
    setState(() {
      if (reading == null) {
        _resources.remove(id);
      } else {
        _resources[id] = reading;
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      _syncResourcePolling();

  @override
  void didUpdateWidget(covariant _MachinesPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active != widget.active) _syncResourcePolling();
  }

  List<MachineState> get _remotes =>
      app.machineStates.values.where((m) => !m.isLocalMachine).toList()
        ..sort((a, b) {
          int order(MachineState m) => m.nodeOnline == false
              ? 2
              : m.needsLink && !m.machine.isShared
              ? 0
              : 1;
          final availability = order(a).compareTo(order(b));
          return availability != 0
              ? availability
              : a.machine.displayName.toLowerCase().compareTo(
                  b.machine.displayName.toLowerCase(),
                );
        });

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    app.addListener(_machinesChanged);
    _syncResourcePolling();
    _expandedMachine =
        widget.initialMachineId ??
        _remotes
            .where((m) => app.pendingMachineLink(m.machine.machineId) != null)
            .firstOrNull
            ?.machine
            .machineId;
    _focusMachine = _expandedMachine;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _panelFocus.requestFocus();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    app.removeListener(_machinesChanged);
    _resourceTimer?.cancel();
    _panelFocus.dispose();
    super.dispose();
  }

  Future<void> _signIn() async {
    setState(() => _signingIn = true);
    await _modal(
      () => showSignInSheet(
        context,
        app,
        reason:
            'Sign in with the same account on both computers to connect them.',
      ),
    );
    if (!mounted) return;
    setState(() => _signingIn = false);
    if (!app.isGuest) unawaited(app.retryMachines());
  }

  Future<T> _modal<T>(Future<T> Function() show) async {
    widget.onModalChanged(true);
    try {
      return await show();
    } finally {
      if (mounted) _reveal();
    }
  }

  void _reveal() {
    widget.onModalChanged(false);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _panelFocus.requestFocus();
    });
  }

  Future<void> _machineAction(String action, MachineState machine) async {
    final id = machine.machine.machineId;
    switch (action) {
      case 'rename':
        await showTerminalPrompt<String>(
          context,
          builder: (_) => TerminalNamePrompt(
            title: 'Rename Machine',
            name: app.pendingMachineName(id) ?? machine.machine.displayName,
            fieldKey: const Key('machine-rename-input'),
            fieldLabel: 'Machine name',
            pending: app.pendingMachineRename(id),
            save: (name) => app.renameMachine(id, name),
          ),
        );
      case 'delete':
        await confirmDeleteMachine(
          context,
          app,
          machineId: id,
          displayName: machine.machine.displayName,
        );
      case 'advanced':
        await showLinkMachineDialog(context, app);
        // The advanced surface can change or clear the incoming password.
        if (mounted) setState(() => _passwordRevision++);
    }
  }

  int _passwordRevision = 0;
  int _setupRequest = 0;
  bool _shareSetup = false;
  String? _onboardingConnect;

  Widget _introduction() {
    final receiving = !widget.onboarding!.completed(OnboardingStep.harnesses);
    final source = receiving
        ? _remotes.where((m) => !m.machine.isShared).firstOrNull
        : null;
    final local = app.localMachineState;
    final name = source?.machine.displayName;
    final offline = source?.nodeOnline == false;
    final linked =
        source != null &&
        !source.needsLink &&
        source.connectionStatus == ConnectionStatus.connected;
    return OnboardingCard(
      title: source == null
          ? 'Use your harnesses from another computer'
          : 'Use your harnesses here',
      description: source == null
          ? 'They keep running here. Open them on your other computer.'
          : offline
          ? 'Open Harness on $name, then check again.'
          : 'Connect to $name and open its existing harnesses.',
      action: app.isGuest
          ? 'Sign in'
          : source != null
          ? offline
                ? 'Check again'
                : linked
                ? 'Open harnesses'
                : 'Connect to $name'
          : 'Set up access',
      onAction: app.isGuest
          ? () => unawaited(_signIn())
          : offline
          ? () => unawaited(app.retryMachines())
          : source != null
          ? () {
              if (linked) {
                widget.onOpen(source.machine.machineId);
              } else {
                setState(() {
                  _onboardingConnect = source.machine.machineId;
                  _expandedMachine = source.machine.machineId;
                  _focusMachine = source.machine.machineId;
                });
              }
            }
          : local == null
          ? null
          : () => setState(() {
              _shareSetup = true;
              _setupRequest++;
            }),
      onDismiss: () => widget.onboarding!.dismiss(OnboardingStep.machines),
    );
  }

  Widget _shareInstructions(MachineState local) {
    final name = local.machine.displayName;
    final email = app.currentUser?.email;
    return Padding(
      padding: const EdgeInsets.fromLTRB(46, 4, 16, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('On your other computer'),
          const SizedBox(height: 8),
          _Detail(
            email == null
                ? '1. Open Harness and sign in with the same account.'
                : '1. Open Harness and sign in as $email.',
          ),
          const SizedBox(height: 6),
          _CopyButton('Copy download link', kHarnessDownloadUrl.toString()),
          const SizedBox(height: 8),
          _Detail(
            '2. Open Machines → Connect to $name. Enter the password you set here.',
          ),
          const SizedBox(height: 8),
          _Detail('Keep $name awake and Harness running.'),
          TextButton(
            onPressed: () => setState(() => _shareSetup = false),
            child: const Text('Hide setup steps'),
          ),
        ],
      ),
    );
  }

  Widget _actions(MachineState machine) => SizedBox(
    width: 32,
    height: 32,
    child: PopupMenuButton<String>(
      tooltip: 'Options for ${machine.machine.displayName}',
      padding: EdgeInsets.zero,
      icon: Icon(
        LucideIcons.ellipsis,
        semanticLabel: 'Options for ${machine.machine.displayName}',
        size: 16,
        color: grid.AppPalette.textFaint,
      ),
      onOpened: () => widget.onModalChanged(true),
      onCanceled: _reveal,
      onSelected: (action) =>
          unawaited(_modal(() => _machineAction(action, machine))),
      itemBuilder: (_) => [
        const PopupMenuItem(value: 'rename', child: Text('Rename')),
        if (!machine.isLocalMachine)
          const PopupMenuItem(
            value: 'delete',
            child: Text('Remove from account…'),
          ),
        if (machine.isLocalMachine)
          const PopupMenuItem(
            value: 'advanced',
            child: Text('Connection settings…'),
          ),
      ],
    ),
  );

  Widget _setup() {
    final email = app.currentUser?.email;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('1. Open Harness on your other computer.'),
        const SizedBox(height: 6),
        _Detail(
          email == null
              ? 'Sign in with the same account.'
              : 'Sign in as $email.',
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            _button('Download Harness', () async {
              var opened = false;
              try {
                opened = await launchUrl(
                  kHarnessDownloadUrl,
                  mode: LaunchMode.externalApplication,
                );
              } catch (_) {
                // The adjacent copy action still works without a browser.
              }
              if (mounted) setState(() => _downloadFailed = !opened);
            }, primary: true),
            _CopyButton('Copy download link', kHarnessDownloadUrl.toString()),
          ],
        ),
        if (_downloadFailed) ...[
          const SizedBox(height: 6),
          const _Feedback(
            'Couldn’t open your browser. Copy the link instead.',
            error: true,
          ),
        ],
        const SizedBox(height: 16),
        const Text('2. Open Machines and choose Set password.'),
        const SizedBox(height: 6),
        const _Detail('Back here, click Connect and enter that password.'),
        const SizedBox(height: 12),
        _button(
          _server ? 'Hide server setup' : 'Set up a server…',
          () => setState(() => _server = !_server),
        ),
        if (_server) ...[
          const SizedBox(height: 6),
          const _Detail('Run these on your server over SSH:'),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
            decoration: BoxDecoration(
              color: grid.AppPalette.textPrimary.withValues(alpha: .05),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: grid.AppPalette.textPrimary.withValues(alpha: .10),
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(child: _Detail('Terminal')),
                    _CopyButton(
                      'Copy commands',
                      '$kLinkServerInstallCommand\n$kLinkServerLoginCommand\n$kLinkServerStartCommand',
                      iconOnly: true,
                    ),
                  ],
                ),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: SelectableText(
                    '$kLinkServerInstallCommand\n$kLinkServerLoginCommand\n$kLinkServerStartCommand',
                    style: grid.AppType.monoLabel(
                      color: grid.AppPalette.textSecondary,
                    ).copyWith(height: 1.6),
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  Widget _remote(MachineState machine) {
    final id = machine.machine.machineId;
    final name = machine.machine.displayName;
    final offline = machine.nodeOnline == false;
    final linking = app.pendingMachineLink(id) != null;
    final connected = machine.connectionStatus == ConnectionStatus.connected;
    final ready = connected && !machine.needsLink && !linking;
    final canConnect =
        !offline && machine.needsLink && !machine.machine.isShared;
    final status = offline
        ? 'Offline'
        : linking
        ? 'Connecting…'
        : machine.needsLink
        ? 'Online'
        : connected
        ? 'Connected'
        : 'Connecting…';
    final options = machine.machine.isShared ? null : _actions(machine);
    if (!offline &&
        (machine.needsLink || linking) &&
        _expandedMachine == id &&
        !machine.machine.isShared) {
      return _MachinePassword(
        key: ValueKey('connect-password-$id'),
        app: app,
        machine: machine,
        options: options,
        autofocus: _focusMachine == id,
        onLinked: _onboardingConnect == id ? () => widget.onOpen(id) : null,
        resources: _resources[id],
        onClose: widget.onClose,
      );
    }
    void connect() => setState(() {
      _expandedMachine = id;
      _focusMachine = id;
      _showSetup = false;
    });
    return _MachineRow(
      key: ValueKey('machine-$id'),
      name: name,
      annotation: offline
          ? 'Offline'
          : linking || !connected && !machine.needsLink
          ? 'Connecting…'
          : machine.machine.isShared
          ? 'Shared with you'
          : null,
      onTap: !offline && ready
          ? () => widget.onOpen(id)
          : canConnect
          ? connect
          : null,
      subtitle: Tooltip(
        message: offline ? 'Open Harness on $name to bring it online.' : status,
        child: _MachineDetails(machine: machine, resources: _resources[id]),
      ),
      action:
          !offline &&
              ready &&
              machine.agents.isEmpty &&
              !machine.machine.isShared
          ? _button(
              'New harness',
              () => widget.onOpen(id),
              key: ValueKey('open-machine-$id'),
              primary: true,
            )
          : canConnect
          ? _button(
              'Connect',
              connect,
              key: ValueKey('connect-machine-$id'),
              primary: true,
            )
          : null,
      options: options,
    );
  }

  Widget _local(MachineState? machine) {
    if (machine != null && !app.isGuest) {
      return _MachinePassword(
        key: ValueKey(
          'local-password-$_passwordRevision-${machine.machine.machineId}',
        ),
        app: app,
        machine: machine,
        resources: _resources[machine.machine.machineId],
        setupRequest: _setupRequest,
        options: _actions(machine),
        onClose: widget.onClose,
      );
    }
    return _MachineRow(
      name: machine?.machine.displayName ?? 'This computer',
      local: machine != null,
      subtitle: _MachineStatus(
        app.isGuest ? 'Sign in to connect your machines' : 'Starting Harness…',
      ),
      action: app.isGuest
          ? _button(
              _signingIn ? 'Signing in…' : 'Sign in',
              _signingIn ? null : () => unawaited(_signIn()),
              primary: true,
            )
          : null,
    );
  }

  Widget _addMachine(bool empty) {
    void toggle() => setState(() => _showSetup = !_showSetup);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _MachineRow(
          key: const ValueKey('add-machine'),
          name: empty ? 'Add a second machine' : 'Add machine',
          icon: LucideIcons.plus,
          subtitle: empty
              ? const _MachineStatus('Run harnesses on another computer')
              : null,
          onTap: toggle,
          action: IconButton(
            tooltip: _showSetup ? 'Hide setup steps' : 'Add a machine',
            onPressed: toggle,
            icon: Icon(
              _showSetup ? LucideIcons.chevronUp : LucideIcons.chevronRight,
              semanticLabel: _showSetup ? 'Hide setup steps' : 'Add a machine',
              size: 18,
            ),
          ),
        ),
        if (_showSetup)
          Padding(
            padding: const EdgeInsets.fromLTRB(46, 0, 16, 12),
            child: _setup(),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([
        app,
        terminalFontStore,
        if (widget.onboarding != null) widget.onboarding!,
      ]),
      builder: (context, _) {
        final local = app.localMachineState;
        final remotes = _remotes;
        // New arrivals must not replace a password someone is already typing.
        if (!remotes.any((m) => m.machine.machineId == _expandedMachine)) {
          _expandedMachine = null;
        }
        final empty = remotes.isEmpty;
        return FocusScope(
          child: TerminalPromptKeys(
            focusNode: _panelFocus,
            cancel: widget.onClose,
            refresh: app.isGuest ? null : () => unawaited(app.retryMachines()),
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(14),
                border: Border.all(
                  color: grid.AppPalette.textPrimary.withValues(alpha: .12),
                ),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: .35),
                    blurRadius: 36,
                    offset: const Offset(0, 12),
                  ),
                ],
              ),
              child: Padding(
                padding: const EdgeInsets.all(1),
                child: Material(
                  key: const ValueKey('machines-panel'),
                  color: grid.AppPalette.panelBg,
                  borderRadius: BorderRadius.circular(14),
                  clipBehavior: Clip.antiAlias,
                  child: DefaultTextStyle(
                    style: _panelText(),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(20, 10, 12, 8),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  'Machines',
                                  style: grid.AppType.heading(),
                                ),
                              ),
                              IconButton(
                                tooltip: 'Close Machines',
                                onPressed: widget.onClose,
                                icon: Icon(
                                  LucideIcons.x,
                                  semanticLabel: 'Close Machines',
                                  size: 18,
                                  color: grid.AppPalette.textFaint,
                                ),
                              ),
                            ],
                          ),
                        ),
                        if (widget.onboarding?.next ==
                                OnboardingStep.machines &&
                            !_shareSetup &&
                            _onboardingConnect == null)
                          _introduction(),
                        Divider(
                          height: 1,
                          color: grid.AppPalette.textPrimary.withValues(
                            alpha: .10,
                          ),
                        ),
                        Flexible(
                          child: SingleChildScrollView(
                            padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                _local(local),
                                if (_shareSetup && local != null)
                                  _shareInstructions(local),
                                if (!app.isGuest) ...[
                                  for (final machine in remotes)
                                    _remote(machine),
                                  if (app.machineListError case final error?)
                                    Padding(
                                      padding: const EdgeInsets.fromLTRB(
                                        12,
                                        8,
                                        12,
                                        8,
                                      ),
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          _Feedback(
                                            'Couldn’t update your machines. $error',
                                            error: true,
                                          ),
                                          _button(
                                            'Try again',
                                            () =>
                                                unawaited(app.retryMachines()),
                                          ),
                                        ],
                                      ),
                                    )
                                  else if (empty && app.machinesLoading)
                                    const Padding(
                                      padding: EdgeInsets.fromLTRB(
                                        46,
                                        12,
                                        12,
                                        12,
                                      ),
                                      child: _Detail(
                                        'Looking for your machines…',
                                      ),
                                    ),
                                  Divider(
                                    height: 13,
                                    indent: 12,
                                    endIndent: 12,
                                    color: grid.AppPalette.textPrimary
                                        .withValues(alpha: .10),
                                  ),
                                  _addMachine(empty),
                                ],
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Every computer has the same silhouette: icon, name, one detail line, action.
/// The detail line becomes the password field while setting up a connection.
class _MachineRow extends StatelessWidget {
  const _MachineRow({
    super.key,
    required this.name,
    this.local = false,
    this.annotation,
    this.icon = LucideIcons.monitor,
    this.subtitle,
    this.action,
    this.options,
    this.onTap,
  });
  final String name;
  final bool local;
  final String? annotation;
  String? get _annotation => annotation ?? (local ? 'This computer' : null);
  final IconData icon;
  final Widget? subtitle, action, options;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final row = Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 4, 12),
      child: LayoutBuilder(
        builder: (context, constraints) {
          // At larger text sizes, keep the details legible instead of squeezing
          // them into the space left by the fixed-width action column.
          final stacked =
              action != null &&
              action is! IconButton &&
              constraints.maxWidth <
                  MediaQuery.textScalerOf(context).scale(490);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Icon(icon, size: 22, color: grid.AppPalette.textSecondary),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            Flexible(
                              child: Tooltip(
                                message: name,
                                child: Text(
                                  name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: grid.AppType.label(height: 1.3),
                                ),
                              ),
                            ),
                            if (_annotation != null) ...[
                              const SizedBox(width: 8),
                              Flexible(
                                child: Text(
                                  '· $_annotation',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: grid.AppType.monoMeta(
                                    color: grid.AppPalette.textSecondary,
                                  ),
                                ),
                              ),
                            ],
                          ],
                        ),
                        if (subtitle != null) ...[
                          const SizedBox(height: 5),
                          subtitle!,
                        ],
                      ],
                    ),
                  ),
                  if (action != null && !stacked) ...[
                    const SizedBox(width: 12),
                    action!,
                  ],
                  const SizedBox(width: 4),
                  options ?? const SizedBox(width: 32),
                ],
              ),
              if (stacked)
                Padding(
                  padding: const EdgeInsets.only(top: 10, right: 36),
                  child: Align(alignment: Alignment.centerRight, child: action),
                ),
            ],
          );
        },
      ),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Semantics(
        container: true,
        explicitChildNodes: true,
        child: onTap == null
            ? row
            : InkWell(
                onTap: onTap,
                borderRadius: BorderRadius.circular(8),
                child: row,
              ),
      ),
    );
  }
}

class _MachineStatus extends StatelessWidget {
  const _MachineStatus(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: grid.AppType.monoMeta(
      height: 1.3,
      color: grid.AppPalette.textSecondary,
    ),
  );
}

class _MachineDetails extends StatelessWidget {
  const _MachineDetails({required this.machine, this.resources});
  final MachineState machine;
  final MachineResources? resources;

  String _gb(double bytes) {
    final gb = bytes / (1024 * 1024 * 1024);
    return gb
        .toStringAsFixed(gb < 10 ? 1 : 0)
        .replaceFirst(RegExp(r'\.0$'), '');
  }

  @override
  Widget build(BuildContext context) {
    final reachable =
        machine.nodeOnline != false &&
        !machine.needsLink &&
        machine.connectionStatus == ConnectionStatus.connected;
    final count =
        reachable &&
            (machine.agentLoadStatus == AgentLoadStatus.loaded ||
                machine.agents.isNotEmpty)
        ? machine.agents.length
        : null;
    final stats = reachable ? resources : null;
    final cpu = stats?.cpuPercent?.round();
    final used = stats?.memoryUsedBytes, total = stats?.memoryTotalBytes;
    final memory = used == null || total == null
        ? '—'
        : '${_gb(used)}/${_gb(total)} GB';
    return Text(
      '${count ?? '—'} ${count == 1 ? 'harness' : 'harnesses'} · CPU ${cpu == null ? '—' : '$cpu%'} · RAM $memory',
      key: ValueKey('machine-stats-${machine.machine.machineId}'),
      style: grid.AppType.monoMeta(
        height: 1.3,
        color: grid.AppPalette.textSecondary,
      ),
    );
  }
}

/// The same small, inline form for incoming passwords and outgoing links.
/// Password buffers belong only to this widget and are cleared on success.
class _MachinePassword extends StatefulWidget {
  const _MachinePassword({
    super.key,
    required this.app,
    required this.machine,
    required this.onClose,
    this.options,
    this.resources,
    this.autofocus = false,
    this.setupRequest = 0,
    this.onLinked,
  });
  final AppNotifier app;
  final MachineState machine;
  final VoidCallback onClose;
  final Widget? options;
  final MachineResources? resources;
  String? get machineId =>
      machine.isLocalMachine ? null : machine.machine.machineId;
  final bool autofocus;
  final int setupRequest;
  final VoidCallback? onLinked;
  @override
  State<_MachinePassword> createState() => _MachinePasswordState();
}

class _MachinePasswordState extends State<_MachinePassword> {
  final _password = TextEditingController();
  final _input = FocusNode(debugLabel: 'Machine password');
  RemotePasswordStatus? _status;
  bool _loading = false, _busy = false, _editing = false, _obscure = true;
  bool _showHelp = false;
  String? _error;
  bool get _local => widget.machineId == null;
  bool get _composing =>
      _password.value.composing.isValid &&
      !_password.value.composing.isCollapsed;

  @override
  void initState() {
    super.initState();
    if (_local) {
      if (widget.app.pendingRemotePasswordChange case final pending?) {
        _busy = true;
        unawaited(_finishPassword(pending));
      } else {
        unawaited(_load());
      }
    } else if (widget.app.pendingMachineLink(widget.machineId!)
        case final pending?) {
      _busy = true;
      unawaited(_finishLink(pending));
    }
    if (widget.autofocus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && ModalRoute.of(context)?.isCurrent != false) {
          _input.requestFocus();
        }
      });
    }
  }

  @override
  void dispose() {
    _password.dispose();
    _input.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant _MachinePassword oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.setupRequest > oldWidget.setupRequest &&
        _status?.hasPassword == false &&
        !_busy) {
      _editPassword();
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final status = await widget.app.remotePasswordStatus();
    if (!mounted) return;
    setState(() {
      _loading = false;
      _error = status.error;
      if (status.error == null) {
        _status = status;
        _editing = widget.setupRequest > 0 && !status.hasPassword;
      }
    });
    if (_editing) _editPassword();
  }

  Future<void> _finishPassword(Future<RemotePasswordStatus> request) async {
    final result = await request;
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = result.error;
      if (result.error == null) {
        _status = result;
        _editing = false;
        _password.clear();
        _obscure = true;
        _showHelp = false;
      }
    });
    // A reopened failed operation has no status yet. Never present it as unset.
    if (result.error != null && _status == null) {
      final status = await widget.app.remotePasswordStatus();
      if (!mounted) return;
      setState(() {
        if (status.error == null) {
          _status = status;
          _editing = true;
        }
      });
    }
  }

  Future<void> _finishLink(Future<String?> request) async {
    final error = await request;
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
    if (error == null) {
      _password.clear();
      widget.onLinked?.call();
    } else {
      _input.requestFocus();
    }
  }

  void _submit() {
    if (_busy || _loading || _composing) return;
    if (_password.text.isEmpty || _password.text.contains(RegExp(r'[\r\n]'))) {
      setState(
        () => _error = _password.text.isEmpty
            ? 'Enter a password.'
            : 'Use a password on one line.',
      );
      _input.requestFocus();
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    if (_local) {
      unawaited(
        _finishPassword(
          widget.app
              .setRemotePassword(_password.text)
              .then(
                (result) => RemotePasswordStatus(
                  error: result.error,
                  hasPassword: result.error == null,
                  fingerprint: result.fingerprint,
                ),
              ),
        ),
      );
    } else {
      unawaited(
        _finishLink(
          widget.app.connectWithPassword(widget.machineId!, _password.text),
        ),
      );
    }
  }

  void _editPassword() {
    setState(() {
      _editing = true;
      _error = null;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _input.requestFocus();
    });
  }

  Widget _row({required Widget subtitle, Widget? action, String? annotation}) =>
      _MachineRow(
        key: ValueKey('machine-${widget.machine.machine.machineId}'),
        name: widget.machine.machine.displayName,
        local: _local,
        annotation: annotation,
        subtitle: subtitle,
        action: action,
        options: widget.options,
      );

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return _row(subtitle: const _MachineStatus('Checking password…'));
    }
    if (_local && _status == null) {
      return _row(
        subtitle: _Feedback(
          _busy
              ? 'Saving password…'
              : _error ?? 'Couldn’t check your password.',
          error: !_busy,
        ),
        action: _busy ? null : _button('Try again', () => unawaited(_load())),
      );
    }
    if (_local && !_editing) {
      final available = _status!.hasPassword;
      return _row(
        annotation: available ? 'This computer · Available' : null,
        subtitle: _MachineDetails(
          machine: widget.machine,
          resources: widget.resources,
        ),
        action: _button(
          available ? 'Change password' : 'Set password',
          _editPassword,
          primary: true,
        ),
      );
    }
    final form = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LayoutBuilder(
          builder: (context, constraints) {
            final field = ReadlineKeys(
              controller: _password,
              enabled: !_busy,
              onChanged: (_) {
                if (_error != null) setState(() => _error = null);
              },
              child: TextField(
                key: ValueKey(
                  _local
                      ? 'make-available-password'
                      : 'connect-password-${widget.machineId}-input',
                ),
                controller: _password,
                focusNode: _input,
                autofocus: widget.autofocus,
                obscureText: _obscure,
                readOnly: _busy,
                autocorrect: false,
                enableSuggestions: false,
                style: grid.AppType.monoLabel(),
                textInputAction: TextInputAction.done,
                decoration: InputDecoration(
                  hintText: _local ? 'Choose a password' : 'Harness password',
                  hintStyle: grid.AppType.monoLabel(
                    color: grid.AppPalette.textFaint,
                  ),
                  isDense: true,
                  filled: false,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                  border: OutlineInputBorder(
                    borderSide: BorderSide(
                      color: grid.AppPalette.textPrimary.withValues(alpha: .20),
                    ),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderSide: BorderSide(
                      color: grid.AppPalette.textPrimary.withValues(alpha: .20),
                    ),
                  ),
                  suffixIconConstraints: const BoxConstraints(
                    minWidth: 64,
                    minHeight: 32,
                  ),
                  suffixIcon: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconButton(
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints.tightFor(
                          width: 32,
                          height: 32,
                        ),
                        tooltip: _obscure ? 'Show password' : 'Hide password',
                        onPressed: () => setState(() => _obscure = !_obscure),
                        icon: Icon(
                          _obscure ? LucideIcons.eye : LucideIcons.eyeOff,
                          semanticLabel: _obscure
                              ? 'Show password'
                              : 'Hide password',
                          size: 15,
                        ),
                      ),
                      IconButton(
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints.tightFor(
                          width: 32,
                          height: 32,
                        ),
                        tooltip: 'Password help',
                        isSelected: _showHelp,
                        onPressed: () => setState(() => _showHelp = !_showHelp),
                        icon: const Icon(
                          LucideIcons.circleHelp,
                          semanticLabel: 'Password help',
                          size: 15,
                        ),
                      ),
                    ],
                  ),
                ),
                onChanged: (_) {
                  if (_error != null) setState(() => _error = null);
                },
                onEditingComplete: () {},
                onSubmitted: (_) => _submit(),
              ),
            );
            final button = _button(
              _busy
                  ? (_local ? 'Saving…' : 'Connecting…')
                  : _local
                  ? 'Save'
                  : 'Connect',
              _busy ? null : _submit,
              primary: true,
            );
            if (constraints.maxWidth <
                340 * MediaQuery.textScalerOf(context).scale(1)) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  field,
                  const SizedBox(height: 8),
                  Align(alignment: Alignment.centerLeft, child: button),
                ],
              );
            }
            return Row(
              children: [
                Expanded(child: field),
                const SizedBox(width: 10),
                button,
              ],
            );
          },
        ),
        if (_error case final error?) ...[
          const SizedBox(height: 8),
          _Feedback(error, error: true),
        ],
        if (_showHelp) ...[
          const SizedBox(height: 8),
          _Detail(
            _local
                ? 'Use this password to connect to ${widget.machine.machine.displayName} from your other computers.'
                : 'On ${widget.machine.machine.displayName}, open Machines → Set password.',
          ),
        ],
        if (_local && _status?.hasPassword == true)
          Align(
            alignment: Alignment.centerLeft,
            child: _button(
              'Cancel',
              _busy
                  ? null
                  : () {
                      setState(() {
                        _editing = false;
                        _password.clear();
                        _error = null;
                        _obscure = true;
                      });
                    },
            ),
          ),
      ],
    );
    return TerminalPromptKeys(
      inputFocus: _input,
      composing: () => _composing,
      cancel: widget.onClose,
      accept: () {
        if (_input.hasFocus) {
          _submit();
        } else {
          activatePromptControl();
        }
      },
      child: _row(subtitle: form),
    );
  }
}

Widget _button(
  String label,
  VoidCallback? onPressed, {
  Key? key,
  bool primary = false,
}) {
  final button = TextButton(
    key: key,
    onPressed: onPressed,
    style: TextButton.styleFrom(
      foregroundColor: primary
          ? grid.AppPalette.textPrimary
          : grid.AppPalette.textSecondary,
      backgroundColor: primary
          ? grid.AppPalette.textPrimary.withValues(alpha: .10)
          : null,
      textStyle: grid.AppType.monoLabel(),
      minimumSize: const Size(0, 32),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
    ),
    child: Text(label),
  );
  if (!primary) return button;
  return Builder(
    builder: (context) => SizedBox(
      width: MediaQuery.textScalerOf(context).scale(140),
      child: button,
    ),
  );
}

class _Detail extends StatelessWidget {
  const _Detail(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Text(
    text,
    style: grid.AppType.body(color: grid.AppPalette.textSecondary),
  );
}

class _Feedback extends StatelessWidget {
  const _Feedback(this.text, {this.error = false});
  final String text;
  final bool error;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Text(
      text,
      style: _panelText(
        color: error
            ? grid.AppTheme.pick(const Color(0xffb24b17), Colors.orangeAccent)
            : grid.AppTheme.pick(
                const Color(0xff356522),
                const Color(0xffa5d786),
              ),
      ),
    ),
  );
}

class _CopyButton extends StatefulWidget {
  const _CopyButton(this.label, this.value, {this.iconOnly = false});
  final String label, value;
  final bool iconOnly;
  @override
  State<_CopyButton> createState() => _CopyButtonState();
}

class _CopyButtonState extends State<_CopyButton> {
  Timer? _timer;
  String? _message;
  int _attempt = 0;
  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    final attempt = ++_attempt;
    try {
      await Clipboard.setData(ClipboardData(text: widget.value));
      if (!mounted || attempt != _attempt) return;
      setState(() => _message = 'Copied');
    } catch (_) {
      if (!mounted || attempt != _attempt) return;
      setState(() => _message = 'Couldn’t copy. Try again');
    }
    _timer?.cancel();
    _timer = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _message = null);
    });
  }

  @override
  Widget build(BuildContext context) => widget.iconOnly
      ? IconButton(
          tooltip: _message ?? widget.label,
          onPressed: _copy,
          icon: Icon(
            _message == 'Copied'
                ? LucideIcons.check
                : _message == null
                ? LucideIcons.copy
                : LucideIcons.circleAlert,
            size: 16,
            semanticLabel: _message ?? widget.label,
          ),
        )
      : _button(_message ?? widget.label, _copy);
}

TextStyle _panelText({Color? color, FontWeight? weight}) => grid.AppType.label(
  color: color ?? grid.AppPalette.textPrimary,
  fontWeight: weight,
);
