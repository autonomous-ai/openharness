import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

/// A realistic catalog, including identical tasks on different engines and
/// machines. Nothing connects to a real daemon or creates an agent.
void seedMixedAgents(AppNotifier app) {
  const local = Machine(
    machineId: 'm',
    name: 'M2',
    authMode: MachineAuthMode.remote,
  );
  const remote = Machine(
    machineId: 'studio',
    name: 'iMac · Office',
    authMode: MachineAuthMode.remote,
  );
  const offline = Machine(
    machineId: 'build',
    name: 'build-box',
    authMode: MachineAuthMode.remote,
  );
  const project = AgentProject(
    name: 'openharness',
    cwd: '/work/openharness',
    branch: 'feature/login-redirect',
    remote: 'github.com/team/openharness',
  );
  app.machines = [local, remote, offline];
  app.machineStates['m'] = MachineState(local)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = const [
      Agent(
        id: 'a0',
        name: 'Fix login redirect',
        engine: 'codex',
        terminalAvailable: true,
        project: project,
      ),
      Agent(
        id: 'a1',
        name: 'Fix login redirect',
        engine: 'claude',
        terminalAvailable: true,
        project: project,
      ),
      Agent(
        id: 'a2',
        name: 'Review the release notes',
        engine: 'codex',
        dsh: 'autonomous/typst',
        terminalAvailable: true,
        project: AgentProject(
          name: 'release-notes',
          cwd: '/work/release-notes',
        ),
      ),
      Agent(
        id: 'a3',
        name: 'Calibrate the arm',
        engine: 'claude',
        dsh: 'studio/arm',
        terminalAvailable: true,
        project: AgentProject(name: 'robotics', cwd: '/work/robotics'),
      ),
    ];
  app.machineStates['m']!.dsh.replace(const [
    DshEntry(
      id: 'studio/arm',
      name: 'Robot Studio',
      engine: 'claude',
      category: 'Robotics',
      installed: true,
    ),
  ]);
  app.machineStates['studio'] = MachineState(remote)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = const [
      Agent(
        id: 'focus',
        name: 'Improve keyboard focus after reconnect',
        engine: 'opencode',
        terminalAvailable: true,
        project: AgentProject(
          name: 'openharness',
          cwd: '/work/openharness/.worktrees/keyboard',
          branch: 'worktree/keyboard-navigation',
          remote: 'github.com/team/openharness',
        ),
      ),
      Agent(
        id: 'helmet',
        name: 'Aero bicycle helmet',
        engine: 'claude',
        dsh: 'autonomous/blender',
        terminalAvailable: true,
        project: AgentProject(name: 'helmet', cwd: '/work/helmet'),
      ),
    ];
  app.machineStates['build'] = MachineState(offline)
    ..nodeOnline = false
    ..agentLoadStatus = AgentLoadStatus.loaded
    ..agents = const [
      Agent(
        id: 'login',
        name: 'Fix login redirect',
        engine: 'codex',
        terminalAvailable: true,
        project: project,
      ),
    ];
}
