import 'windows_pipe.dart';

/// A browser has no Windows pipe; nothing in a viewer build dials one.
PipeIo kernel32PipeIo() =>
    throw UnsupportedError('A browser cannot open a Windows pipe.');
