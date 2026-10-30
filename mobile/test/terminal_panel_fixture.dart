import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

/// The notifier a lone `TerminalPanel` hangs off: no machines, no stored config.
AppNotifier panelNotifier() => AppNotifier(
  config: AppConfig.dev,
  authSession: AuthSession(),
  configStore: null,
);

/// A session already controlling its stream, so the pane takes input. Every
/// frame is accepted unless the test listens for it. [engineId] is an agent's
/// unless the test asks for a plain shell (`terminal`).
TerminalSession controllingSession({
  TerminalFrameSender? send,
  TerminalBinarySender? sendBinary,
  String engineId = 'claude',
}) =>
    TerminalSession(
        machineId: 'm',
        agentId: 'a',
        agentName: 'Agent',
        engineId: engineId,
        send: send ?? (_, _) async => true,
        sendBinary: sendBinary ?? (_) async => true,
      )
      ..status = TerminalSessionStatus.controlling
      ..streamId = 's';
