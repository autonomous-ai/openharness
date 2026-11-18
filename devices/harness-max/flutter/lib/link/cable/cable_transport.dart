// The cable's far end in dart:io (port of devices/harness-max/firmware/linux/cable/cable_linux.c): a daemon that dials
// TCP port 7531 (--live), or the Mac's daemon over the USB cable through the gadget's serial port /dev/ttyGS0 (--usb,
// made by linux/orangepi/harness-max-usb). Both carry the cable's frames as bytes; neither knows what is in them.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

/// The TCP port a daemon dials (HARNESS_CABLE_TCP=host:7531).
const int kCableTcpPort = 7531;

/// The serial port of the gadget harness-max-usb makes.
const String kCableUsbPort = '/dev/ttyGS0';

/// Bytes queued for a far end that is not reading, at most: a recording's PCM is the most that queues.
const int kCableQueueBytes = 64 * 1024;

abstract interface class CableTransport {
  /// Serves the far end: [onConnected] when one is there to talk to, [onBytes] with what it sends, [onClosed] when it
  /// goes. Never throws for a far end that is missing: it keeps trying.
  Future<void> start({
    required void Function() onConnected,
    required void Function(Uint8List bytes) onBytes,
    required void Function(String why) onClosed,
  });

  /// A far end is there.
  bool get connected;

  /// Queues a frame; false when there is no far end, or it has not taken the last [kCableQueueBytes].
  bool write(Uint8List frame);

  /// The far end holds the link and says nothing: let it start over.
  void replug();

  Future<void> stop();
}

/// Frames for one far end, written one batch at a time, bounded: a far end that stops reading costs the frames that do
/// not fit, never memory or a stalled caller. A batch that fails to write is dropped and reported; the next one is tried.
class FrameQueue {
  FrameQueue(this._write, {this.capacity = kCableQueueBytes, this.onError});

  final Future<void> Function(Uint8List bytes) _write;
  final int capacity;
  final void Function(Object error)? onError;
  final List<Uint8List> _frames = [];
  int _bytes = 0;
  bool _closed = false;
  Completer<void>? _flight;

  /// Bytes queued or being written.
  int get bytes => _bytes;

  /// Completes once no write is in flight: only then may the handle written to be closed.
  Future<void> get idle => _flight?.future ?? Future.value();

  bool add(Uint8List frame) {
    if (_closed || _bytes + frame.length > capacity) return false;
    _frames.add(frame);
    _bytes += frame.length;
    _pump();
    return true;
  }

  /// Drops what has not gone yet.
  void clear() {
    for (final f in _frames) {
      _bytes -= f.length;
    }
    _frames.clear();
  }

  void close() {
    _closed = true;
    clear();
  }

  Future<void> _pump() async {
    if (_flight != null) return;
    final flight = _flight = Completer<void>();
    while (_frames.isNotEmpty && !_closed) {
      final batch = BytesBuilder(copy: false);
      for (final f in _frames) {
        batch.add(f);
      }
      _frames.clear();
      final n = batch.length;
      try {
        await _write(batch.takeBytes());
      } catch (e) {
        onError?.call(e);
      }
      _bytes -= n;
    }
    _flight = null;
    flight.complete();
  }
}

typedef _Events = ({
  void Function() onConnected,
  void Function(Uint8List bytes) onBytes,
  void Function(String why) onClosed,
});

/// A daemon over TCP: one at a time, the newest connection replacing the last (a daemon that restarted is not locked
/// out by its own half-dead connection). Development only: the port takes anyone on the network, and the daemon
/// answers no permission prompt over it.
class TcpTransport implements CableTransport {
  TcpTransport({this.port = kCableTcpPort, this.log = _stderr});

  final int port;
  final void Function(String line) log;
  _Events? _events;
  ServerSocket? _server;
  Socket? _client;
  FrameQueue? _queue;
  Timer? _retry;
  bool _stopped = false, _toldBind = false;

  /// The port bound (the one asked for, or the system's pick for 0).
  int get boundPort => _server?.port ?? 0;

  @override
  bool get connected => _client != null;

  @override
  Future<void> start({
    required void Function() onConnected,
    required void Function(Uint8List bytes) onBytes,
    required void Function(String why) onClosed,
  }) async {
    _events = (onConnected: onConnected, onBytes: onBytes, onClosed: onClosed);
    _stopped = false;
    await _bind();
  }

  Future<void> _bind() async {
    if (_stopped) return;
    ServerSocket? server;
    for (final address in [InternetAddress.anyIPv6, InternetAddress.anyIPv4]) {
      try {
        // Every address, IPv4 too (as mapped addresses) where the system has IPv6.
        server = await ServerSocket.bind(address, port, v6Only: false);
        break;
      } on SocketException catch (e) {
        if (address == InternetAddress.anyIPv4 && !_toldBind) {
          log('cannot listen on port $port: ${e.message} (trying again)');
        }
      }
    }
    if (server == null) {
      _toldBind = true;
      _retry = Timer(const Duration(seconds: 2), _bind);
      return;
    }
    if (_stopped) {
      await server.close();
      return;
    }
    _server = server;
    server.listen(_accept, onError: (Object e) => log('listen: $e'));
    log('waiting for a daemon on TCP port ${server.port}');
  }

  void _accept(Socket socket) {
    final events = _events!;
    final old = _client;
    if (old != null) {
      log('daemon connected (replacing the last connection)');
      _drop(old, 'replaced');
    } else {
      log('daemon connected');
    }
    try {
      socket.setOption(SocketOption.tcpNoDelay, true);
    } on SocketException {
      // Latency only: the frames still arrive.
    }
    _client = socket;
    _queue = FrameQueue((bytes) async {
      socket.add(bytes);
      await socket.flush();
    }, onError: (e) => _lost(socket, 'write: $e'));
    socket.listen(
      (data) {
        if (_client == socket) events.onBytes(data);
      },
      onError: (Object e) => _lost(socket, 'error: $e'),
      onDone: () => _lost(socket, 'daemon disconnected'),
      cancelOnError: true,
    );
    events.onConnected();
  }

  // The far end went: forget it and say so (once per connection).
  void _lost(Socket socket, String why) {
    if (_client != socket) return;
    log(why);
    _drop(socket, why);
  }

  void _drop(Socket socket, String why) {
    if (_client == socket) {
      _client = null;
      _queue?.close();
      _queue = null;
      _events?.onClosed(why);
    }
    socket.destroy();
  }

  @override
  bool write(Uint8List frame) => _queue?.add(frame) ?? false;

  /// The daemon dials again.
  @override
  void replug() {
    final client = _client;
    if (client == null) return;
    log('re-plug: dropping the daemon\'s connection');
    _drop(client, 're-plug');
  }

  @override
  Future<void> stop() async {
    _stopped = true;
    _retry?.cancel();
    final client = _client;
    if (client != null) {
      _client = null;
      _queue?.close();
      client.destroy();
    }
    await _server?.close();
    _server = null;
  }
}

/// The cable over USB, as on the device: the board is a CDC-ACM gadget with the Harness devices' USB ids, so the Mac's
/// daemon finds it as it finds a Harness Max. Bytes go through the gadget's serial port; a host is there while the
/// device controller says "configured". The port is opened again whenever it dies (a host that leaves hangs it up).
class UsbTransport implements CableTransport {
  UsbTransport({this.port = kCableUsbPort, this.udcState, this.log = _stderr});

  final String port;

  /// The controller's state file (/sys/class/udc/`<controller>`/state); null reads the first controller's.
  final String? udcState;
  final void Function(String line) log;
  _Events? _events;
  String _state = '';
  RandomAccessFile? _rx, _tx;
  FrameQueue? _queue;
  Timer? _poll;
  bool _host = false, _opening = false, _stopped = false, _toldClosed = false, _connected = false;
  DateTime _reopenAt = DateTime.fromMillisecondsSinceEpoch(0);
  StreamSubscription<ProcessSignal>? _hangups;

  /// How often the controller's state is read, and how soon a port that would not open is tried again.
  static const Duration pollEvery = Duration(milliseconds: 250);
  static const Duration reopenAfter = Duration(seconds: 1);

  @override
  bool get connected => _connected;

  @override
  Future<void> start({
    required void Function() onConnected,
    required void Function(Uint8List bytes) onBytes,
    required void Function(String why) onClosed,
  }) async {
    _events = (onConnected: onConnected, onBytes: onBytes, onClosed: onClosed);
    _stopped = false;
    _state = udcState ?? _firstController();
    // Dart opens the port without O_NOCTTY. Should this process lead its session, the port becomes its terminal and a
    // host that leaves sends it SIGHUP, which would end the app: the hang-up is the port's to report, not the app's.
    if (Platform.isLinux) {
      try {
        _hangups = ProcessSignal.sighup.watch().listen((_) {});
      } on SignalException {
        // Not watchable here: then the port cannot be this process's terminal either.
      }
    }
    log('waiting for a host on $port (${_state.isEmpty ? 'no USB device controller' : _state})');
    _poll = Timer.periodic(pollEvery, (_) => _check());
    _check();
  }

  static String _firstController() {
    try {
      final names = Directory('/sys/class/udc').listSync().map((e) => e.path).toList()..sort();
      return names.isEmpty ? '' : '${names.first}/state';
    } on FileSystemException {
      return '';
    }
  }

  Future<void> _check() async {
    if (_stopped) return;
    _host = await _configured();
    if (_rx == null && !_opening && DateTime.now().isAfter(_reopenAt)) await _open();
    _update();
  }

  // A host has configured the gadget.
  Future<bool> _configured() async {
    if (_state.isEmpty) return false;
    try {
      return (await File(_state).readAsString()).startsWith('configured');
    } on FileSystemException {
      return false;
    }
  }

  // Says hello and goodbye as the host and the port come and go together.
  void _update() {
    final now = _host && _rx != null && !_stopped;
    if (now == _connected) return;
    _connected = now;
    log(now ? 'a host configured the gadget' : 'the host is gone');
    if (now) {
      _events?.onConnected();
    } else {
      // Nothing queued for the last host is for the next one.
      _queue?.clear();
      _events?.onClosed('host gone');
    }
  }

  Future<void> _open() async {
    _opening = true;
    RandomAccessFile? rx, tx;
    try {
      rx = await File(port).open();
      // Write-only without append: Dart seeks to the end of a file opened to append, which a tty refuses (ESPIPE);
      // the truncate that comes with this mode is ignored on a terminal.
      tx = await File(port).open(mode: FileMode.writeOnly);
      // Raw bytes, as cfmakeraw: no echo, no line editing, no CR/LF translation either way.
      final stty = await Process.run('stty', ['-F', port, 'raw', '-echo', '-echonl', '-iexten', 'cs8', '-parenb']);
      if (stty.exitCode != 0) log('stty on $port: ${stty.stderr.toString().trim()}');
    } on Object catch (e) {
      await rx?.close();
      await tx?.close();
      if (!_toldClosed) log('$port: $e (trying again each second)');
      _toldClosed = true;
      _reopenAt = DateTime.now().add(reopenAfter);
      _opening = false;
      return;
    }
    _opening = false;
    if (_stopped) {
      await rx.close();
      await tx.close();
      return;
    }
    log('$port open');
    _toldClosed = false;
    _rx = rx;
    _tx = tx;
    final writer = tx;
    var toldWrite = false;
    // A write fails with the host's hang-up, which the read reports too: the read ends the port, the write only says so.
    _queue = FrameQueue(
      (bytes) => writer.writeFrom(bytes),
      onError: (e) {
        if (!toldWrite) log('write on $port: $e');
        toldWrite = true;
      },
    );
    _read(rx);
  }

  // A blocking read on the port's own handle: it returns what came, and nothing once the host hung up. The reader owns
  // the port's end: a tty read cannot be interrupted from Dart, so only it knows when the handle is free to close.
  Future<void> _read(RandomAccessFile rx) async {
    var why = 'hung up';
    try {
      for (;;) {
        final data = await rx.read(4096);
        if (_rx != rx || data.isEmpty) break;
        if (_connected) _events?.onBytes(data);
      }
    } on Object catch (e) {
      why = 'read: $e';
    }
    if (_rx == rx) {
      log('$port closed ($why)');
      final queue = _queue, tx = _tx;
      _rx = _tx = null;
      _queue = null;
      queue?.close();
      _reopenAt = DateTime.now().add(reopenAfter);
      _update();
      queue?.idle.then((_) => tx?.close()).ignore();
    }
    rx.close().ignore();
  }

  @override
  bool write(Uint8List frame) => _connected ? _queue?.add(frame) ?? false : false;

  /// Without root the gadget cannot be enumerated again: what is queued for the host goes, the port stays.
  @override
  void replug() {
    log('re-plug: starting over on $port');
    _queue?.clear();
  }

  @override
  Future<void> stop() async {
    _stopped = true;
    _poll?.cancel();
    await _hangups?.cancel();
    final queue = _queue, tx = _tx;
    _queue = null;
    queue?.close();
    _rx = _tx = null;
    _connected = false;
    // The read handle is left to its pending read, which closes it when the read returns.
    await queue?.idle;
    await tx?.close();
  }
}

void _stderr(String line) => stderr.writeln('cable: $line');
