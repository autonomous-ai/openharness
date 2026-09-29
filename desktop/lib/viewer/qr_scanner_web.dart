import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

import '../shared/widgets/app_dialog.dart';
import '../widgets/box_chrome.dart';
import '../widgets/terminal_text_action.dart';

/// The in-app "Scan its code" on the web: the phone's camera in a dialog, read with the browser's
/// own `BarcodeDetector`, or with jsQR (vendored, `web/vendor/jsQR.js`) where there is none — iOS
/// Safari. Resolves with the first code [accept] takes, or null if closed.
bool get qrScanSupported =>
    web.window.navigator.mediaDevices.isDefinedAndNotNull;

Future<String?> scanQrCode(
  BuildContext context, {
  bool Function(String)? accept,
}) => showAppDialog<String>(
  context: context,
  builder: (context) => Dialog(
    backgroundColor: Colors.transparent,
    elevation: 0,
    insetPadding: const EdgeInsets.all(16),
    child: _Scanner(
      accept: accept ?? (_) => true,
      onFound: (code) => Navigator.of(context).pop(code),
      onClose: () => Navigator.of(context).pop(),
    ),
  ),
);

@JS('BarcodeDetector')
extension type _BarcodeDetector._(JSObject _) implements JSObject {
  external factory _BarcodeDetector(JSObject options);
  external JSPromise<JSArray<_Detected>> detect(JSObject source);
}

extension type _Detected._(JSObject _) implements JSObject {
  external String get rawValue;
}

@JS('jsQR')
external _JsQrResult? _jsQR(JSUint8ClampedArray data, int width, int height);

extension type _JsQrResult._(JSObject _) implements JSObject {
  external String get data;
}

class _Scanner extends StatefulWidget {
  const _Scanner({
    required this.accept,
    required this.onFound,
    required this.onClose,
  });

  final bool Function(String) accept;
  final void Function(String) onFound;
  final VoidCallback onClose;

  @override
  State<_Scanner> createState() => _ScannerState();
}

class _ScannerState extends State<_Scanner> {
  web.HTMLVideoElement? _video;
  web.MediaStream? _stream;
  Timer? _tick;
  bool _busy = false;
  bool _done = false;
  String? _problem;
  _BarcodeDetector? _detector;
  final _canvas = web.HTMLCanvasElement();

  @override
  void initState() {
    super.initState();
    unawaited(_start());
  }

  Future<void> _start() async {
    try {
      if (web.window.has('BarcodeDetector')) {
        _detector = _BarcodeDetector(
          {
                'formats': ['qr_code'].jsify(),
              }.jsify()
              as JSObject,
        );
      } else {
        await _loadJsQr();
      }
      final constraints =
          {
                'video': {'facingMode': 'environment'},
                'audio': false,
              }.jsify()
              as web.MediaStreamConstraints;
      final stream = await web.window.navigator.mediaDevices
          .getUserMedia(constraints)
          .toDart;
      if (!mounted) {
        _stop(stream);
        return;
      }
      _stream = stream;
      final video = _video;
      if (video != null) _attach(video);
      _tick = Timer.periodic(
        const Duration(milliseconds: 250),
        (_) => unawaited(_scan()),
      );
    } catch (_) {
      if (mounted) {
        setState(
          () => _problem =
              'This browser can’t open the camera. Allow camera access, or scan the QR with the '
              'phone’s camera app instead.',
        );
      }
    }
  }

  static Future<void>? _jsQrLoading;
  Future<void> _loadJsQr() => _jsQrLoading ??= () {
    final done = Completer<void>();
    final script = web.HTMLScriptElement()
      ..src = 'vendor/jsQR.js'
      ..async = true;
    script.onload = ((web.Event _) => done.complete()).toJS;
    script.onerror = ((web.Event _) => done.completeError(
      StateError('jsQR'),
    )).toJS;
    web.document.head!.append(script);
    return done.future;
  }();

  void _attach(web.HTMLVideoElement video) {
    final stream = _stream;
    if (stream == null) return;
    video
      ..srcObject = stream
      ..muted = true
      ..autoplay = true
      ..setAttribute('playsinline', 'true');
    unawaited(video.play().toDart.catchError((_) => null));
  }

  Future<void> _scan() async {
    final video = _video;
    if (_busy || _done || video == null || video.readyState < 2) return;
    _busy = true;
    try {
      String? found;
      final detector = _detector;
      if (detector != null) {
        final hits = (await detector.detect(video).toDart).toDart;
        for (final hit in hits) {
          if (widget.accept(hit.rawValue)) found = hit.rawValue;
        }
      } else {
        final w = video.videoWidth, h = video.videoHeight;
        if (w > 0 && h > 0) {
          _canvas
            ..width = w
            ..height = h;
          final ctx = _canvas.getContext('2d') as web.CanvasRenderingContext2D;
          ctx.drawImage(video, 0, 0);
          final pixels = ctx.getImageData(0, 0, w, h).data;
          final hit = _jsQR(pixels, w, h);
          if (hit != null && widget.accept(hit.data)) found = hit.data;
        }
      }
      if (found != null && !_done) {
        _done = true;
        widget.onFound(found);
      }
    } catch (_) {
      // One unreadable frame; the next one is 250 ms away.
    } finally {
      _busy = false;
    }
  }

  void _stop(web.MediaStream? stream) {
    final tracks = stream?.getTracks().toDart ?? const [];
    for (final track in tracks) {
      track.stop();
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    _stop(_stream);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 420,
    child: TerminalBox(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Scan the machine’s code',
              style: boxMonoStyle(color: kBoxFaint),
            ),
            const SizedBox(height: 10),
            AspectRatio(
              aspectRatio: 1,
              child: _problem != null
                  ? Center(
                      child: Text(
                        _problem!,
                        textAlign: TextAlign.center,
                        style: boxMonoStyle(color: Colors.white70),
                      ),
                    )
                  : ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: HtmlElementView.fromTagName(
                        tagName: 'video',
                        onElementCreated: (element) {
                          final video = element as web.HTMLVideoElement;
                          video.style
                            ..width = '100%'
                            ..height = '100%'
                            ..objectFit = 'cover';
                          _video = video;
                          _attach(video);
                        },
                      ),
                    ),
            ),
            const SizedBox(height: 10),
            Text(
              'On the machine: harness link qr, or Add Phone in the desktop app.',
              style: boxMonoStyle(color: kBoxFaint),
            ),
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerRight,
              child: TerminalTextAction(
                label: 'Cancel',
                onPressed: widget.onClose,
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
