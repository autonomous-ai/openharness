import '../core/viewer_mode.dart';
import '../state/app_state.dart' show MachineState;

/// Why the Finder's row cannot be chosen on another machine.
const kFinderElsewhere =
    'Finder opens folders on This computer for now. Choose This computer.';

/// Whether a Finder tile can open on [machine]: this computer, in the
/// desktop app. A browser has no disk to read, and a remote machine's files
/// need the daemon to serve them first (see `FinderSource`).
bool canOpenFinderOn(MachineState? machine) =>
    !kViewerMode && machine != null && machine.isLocalMachine;
