import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../core/models.dart';
import '../logging/app_log.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../state/terminal_pane.dart';
import '../terminal/terminal_binary.dart';
import '../terminal/terminal_session.dart';
import '../widgets/terminal_panel.dart';
import '../ws/ws_conn.dart';
import '../viewer/observer_relay_codec.dart';
import 'harness_comments.dart';
import 'shared_harness_bar.dart';
import 'shared_terminal_watch.dart';
import 'shared_viewer_view.dart';

class SharedHarnessPanel extends StatefulWidget {
  const SharedHarnessPanel({
    super.key,
    required this.notifier,
    required this.pane,
    required this.grant,
    required this.hasAccess,
    required this.visible,
    required this.onClose,
    this.link = false,
    this.linkEnvironment,
    this.onSignIn,
  });
  final AppNotifier notifier;
  final TerminalPane pane;
  final SharedHarness grant;
  final bool hasAccess, visible;
  final VoidCallback onClose;
  final bool link;
  final String? linkEnvironment;
  final VoidCallback? onSignIn;
  @override
  State<SharedHarnessPanel> createState() => _SharedHarnessPanelState();
}

class _SharedHarnessPanelState extends State<SharedHarnessPanel> {
  late WsConn _connection;
  late TerminalSession _terminal;
  late SharedTerminalWatch _watch;
  ConnectionStatus _status = ConnectionStatus.connecting;
  String? _failure;
  String _viewerMessage = 'Waiting for the live viewer…';
  Uint8List? _image;
  bool _viewerSelected = false, _ended = false;

  /// The person picked Terminal or Viewer themselves. Until they do, the first
  /// live frame brings the viewer forward on a narrow pane — a shared Blender
  /// or Marp harness was shared for what it shows, and a "Viewer" tab nobody
  /// noticed left the person looking at a terminal they cannot type into
  /// (owner, 2026-09-18: "chỉ thấy màn hình terminal").
  bool _viewerChosen = false;
  String _lastViewerState = '';
  int _generation = 0;
  bool _commentsSelected = false, _commentsOpened = false;
  final _commentUpdates = ValueNotifier<int>(0);

  /// Terminal and viewer share the pane side by side from this width.
  static const _splitWidth = 880.0;

  /// Comments sit beside the output from this width, and replace it below.
  static const _commentsBesideWidth = 1000.0;

  /// Most harnesses never produce a viewer; theirs stays out of the layout
  /// until the owner machine says one is coming.
  bool get _hasViewer =>
      _image != null ||
      (_lastViewerState.isNotEmpty && _lastViewerState != 'waiting');

  @override
  void initState() {
    super.initState();
    _start();
  }

  void _start() {
    final generation = ++_generation;
    final viewer = widget.notifier.viewer;
    final uri = Uri.parse(widget.notifier.config.localCliBaseUrl)
        .replace(scheme: 'ws', path: '/api/local-ws');
    _terminal = TerminalSession(
      machineId: widget.pane.machineId,
      agentId: widget.grant.agentId,
      agentName: widget.grant.name,
      engineId: widget.grant.engine,
      readOnly: true,
      send: (type, payload) => _connection.sendTerminalFrame(type, payload),
      sendBinary: (_) async => false,
      onOpenStalled: () => _connection.forceReconnect(),
      resyncTimeout: const Duration(seconds: 15),
    );
    _watch = SharedTerminalWatch(
      _terminal,
      canRetry: () =>
          generation == _generation &&
          !_ended &&
          _status == ConnectionStatus.connected,
      onChanged: () {
        if (mounted && generation == _generation) setState(() {});
      },
    );
    _lastViewerState = '';
    _connection = WsConn(
      wsBaseUrl: widget.notifier.config.wsBaseUrl,
      autonomousEnv:
          widget.linkEnvironment ?? widget.notifier.config.autonomousEnv,
      machineId: widget.pane.machineId,
      observerShareId: widget.grant.id,
      observerLink: widget.link,
      transportKind: viewer == null
          ? WsTransportKind.localPlaintext
          : WsTransportKind.cloudE2ee,
      localWsUri: uri,
      localTransport: viewer == null
          ? widget.notifier.localDaemonTransport
          : null,
      accessTokenProvider: (force, failedToken) async => viewer == null
          ? ''
          : widget.link && !await viewer.auth.hasSession()
          ? ''
          : viewer.auth.accessToken(force: force, failedToken: failedToken),
      relayCodecs: viewer == null
          ? null
          : (_) async {
              final owner = widget.grant.ownerPublicKey;
              if (owner == null || owner.isEmpty) return null;
              return ObserverRelayCodec.create(
                machineId: widget.pane.machineId,
                shareId: widget.grant.id,
                ownerPublicKey: owner,
              );
            },
      onAuthFailure: (reason) {
        if (generation == _generation) _end(reason);
      },
      onLocalFailure: (code, reason) {
        if (generation == _generation) _end(reason);
      },
      onEvent: (frame) async {
        if (generation != _generation) return;
        final type = frame['type'] as String,
            payload = Map<String, dynamic>.from(frame['payload'] as Map);
        if (type == 'observer_viewer') {
          _onViewerFrame(payload);
        } else if (type == 'observer_comments') {
          _commentUpdates.value++;
        } else {
          await _terminal.handleFrame(type, payload);
        }
      },
      onStatus: (status) {
        if (!mounted || _ended || generation != _generation) return;
        setState(() {
          _status = status;
          _failure = null;
        });
        if (status == ConnectionStatus.connected) {
          unawaited(_terminal.reopen());
          unawaited(
            _connection.sendTerminalFrame('observer_viewer', {
              'agentId': widget.grant.agentId,
            }),
          );
        } else {
          _terminal.transportLost('Waiting for the owner to reconnect.');
        }
      },
    );
    _connection.onBinaryFrame = (bytes) async {
      if (generation != _generation) return;
      final frame = decodeTerminalLocal(bytes);
      if (frame != null && !_ended) await _terminal.handleBinary(frame);
    };
    if (widget.hasAccess) {
      unawaited(_connection.connect());
    } else {
      _ended = true;
      _failure = 'Access removed or invitation expired.';
    }
  }

  void _onViewerFrame(Map<String, dynamic> payload) {
    if (!mounted || _ended) {
      appLog.warn(
        'share',
        'pane ${widget.pane.id} dropped viewer frame ${payload['state']} (mounted=$mounted ended=$_ended)',
      );
      return;
    }
    Uint8List? next;
    try {
      if (payload['data'] is String) {
        next = base64Decode(payload['data'] as String);
      }
    } on FormatException catch (error) {
      appLog.warn(
        'share',
        'pane ${widget.pane.id} viewer frame did not decode: $error',
      );
      return;
    }
    // On change only: live frames come 2–3 a second, and a line per frame
    // would bury the one that matters — the first, and every refusal.
    final state = '${payload['state']}';
    if (state != _lastViewerState) {
      _lastViewerState = state;
      appLog.debug(
        'share',
        'pane ${widget.pane.id} viewer $state bytes=${next?.length ?? 0}'
            '${payload['message'] != null ? ' · ${payload['message']}' : ''}',
      );
    }
    setState(() {
      if (next != null) {
        if (_image == null && !_viewerChosen) _viewerSelected = true;
        _image = next;
      }
      _viewerMessage =
          payload['message'] as String? ??
          (payload['state'] == 'live' ? 'Live viewer' : 'Opening the viewer…');
    });
  }

  void _end(String reason) {
    if (!mounted || _ended) return;
    setState(() {
      _ended = true;
      _failure = reason;
      _image = null;
    });
    _terminal.transportLost(reason);
    unawaited(_connection.close());
  }

  @override
  void didUpdateWidget(SharedHarnessPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.hasAccess && !_ended) {
      _end('Access removed or invitation expired.');
    } else if (widget.hasAccess &&
        (!oldWidget.hasAccess ||
            widget.grant.id != oldWidget.grant.id ||
            widget.grant.ownerPublicKey != oldWidget.grant.ownerPublicKey)) {
      _closeSession();
      _ended = false;
      _failure = null;
      _image = null;
      _status = ConnectionStatus.connecting;
      _start();
    }
  }

  @override
  void dispose() {
    _closeSession();
    _commentUpdates.dispose();
    super.dispose();
  }

  void _closeSession() {
    unawaited(_connection.close());
    _watch.dispose();
    _terminal.dispose();
  }

  void _retry() {
    _closeSession();
    _ended = false;
    _failure = null;
    _status = ConnectionStatus.connecting;
    setState(_start);
  }

  void _toggleComments() => setState(() {
    _commentsSelected = !_commentsSelected;
    _commentsOpened = true;
  });

  void _selectViewer(bool viewer) => setState(() {
    _viewerChosen = true;
    _viewerSelected = viewer;
  });

  String? get _detail {
    final parts = [
      widget.grant.engine,
      widget.pane.sharedOwnerName,
    ].whereType<String>().where((part) => part.isNotEmpty);
    return parts.isEmpty ? null : parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    TerminalFontScope.watch(context);
    final status = SharedPaneStatus.of(
      ended: _ended,
      connected: _status == ConnectionStatus.connected,
      terminalStopped: _watch.stopped,
    );
    final notice = _failure ?? status.notice;
    return LayoutBuilder(
      builder: (context, size) {
        final commentsBeside = size.maxWidth >= _commentsBesideWidth;
        final commentsWidth = commentsBeside
            ? 360.0.clamp(280.0, size.maxWidth * .45)
            : size.maxWidth;
        final besideComments = _commentsSelected && commentsBeside;
        final outputWidth =
            size.maxWidth - (besideComments ? commentsWidth : 0);
        final split = _hasViewer && outputWidth >= _splitWidth;
        return Column(
          children: [
            SharedHarnessBar(
              name: widget.grant.name,
              detail: _detail,
              status: status,
              commentsSelected: _commentsSelected,
              onToggleComments: _toggleComments,
              onClose: widget.onClose,
              viewerSelected: _hasViewer && !split ? _viewerSelected : null,
              onSelectViewer: _selectViewer,
              onRetry: _ended && widget.hasAccess ? _retry : null,
            ),
            if (notice != null) SharedHarnessNotice(notice),
            Expanded(
              child: Stack(
                children: [
                  Positioned.fill(
                    right: besideComments ? commentsWidth : 0,
                    child: Offstage(
                      offstage: _commentsSelected && !commentsBeside,
                      child: _output(split),
                    ),
                  ),
                  if (_commentsOpened)
                    Positioned(
                      top: 0,
                      bottom: 0,
                      right: 0,
                      width: commentsWidth,
                      child: Offstage(
                        offstage: !_commentsSelected,
                        child: _comments(),
                      ),
                    ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _output(bool split) => LayoutBuilder(
    builder: (context, constraints) {
      final terminal = TerminalPanel(
        notifier: widget.notifier,
        session: _terminal,
        focused: widget.notifier.isPaneFocused(widget.pane.id),
        visible: widget.visible,
        showHeader: false,
        readOnly: true,
        viewportSize: constraints.biggest,
      );
      if (!_hasViewer) return terminal;
      final viewer = SharedViewerView(
        name: widget.grant.name,
        image: _image,
        message: _viewerMessage,
        ended: _ended,
      );
      if (!split) {
        return IndexedStack(
          index: _viewerSelected ? 1 : 0,
          children: [terminal, viewer],
        );
      }
      return Row(
        children: [
          Expanded(flex: 5, child: terminal),
          VerticalDivider(width: 1, color: grid.AppPalette.divider),
          Expanded(flex: 4, child: viewer),
        ],
      );
    },
  );

  Widget _comments() => DecoratedBox(
    decoration: BoxDecoration(
      color: grid.AppPalette.windowBg,
      border: Border(left: BorderSide(color: grid.AppPalette.divider)),
    ),
    child: HarnessComments(
      updates: _commentUpdates,
      onSignIn: widget.onSignIn,
      manage: (action, payload) => _connection.request(
        'observer_$action',
        payload: {'agentId': widget.grant.agentId, ...payload},
      ),
    ),
  );
}
