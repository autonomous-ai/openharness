import 'dart:async';
import 'dart:convert';
import 'dart:math';

/// One `viewer_surface` request to the harness's machine (`AppNotifier.viewerSurface`).
typedef ViewerSurfaceRequest = Future<Map<String, dynamic>> Function(
  Map<String, dynamic> payload,
);

const _width = 1280, _height = 800;

/// Viewers draw after their page loads (pdf.js pages, a WebGL model), so the second frame is kept.
const viewerSettle = Duration(milliseconds: 1500);

/// A JPEG (base64) of the harness's live viewer, as its machine's daemon renders it in headless
/// Chrome, or null when it cannot: no viewer yet, no Chrome on that machine, or no connection.
/// This is how a native result (a Typst PDF, a Blender model) reaches the Hub as a picture.
Future<String?> captureViewer(
  ViewerSurfaceRequest send, {
  Duration settle = viewerSettle,
  Duration timeout = const Duration(seconds: 10),
}) async {
  // A picture is a convenience: a slow machine gives up rather than holding Publish.
  Future<Map<String, dynamic>> request(Map<String, dynamic> payload) =>
      send(payload).timeout(timeout);
  final id =
      'hub-publish-${Random.secure().nextInt(1 << 32).toRadixString(16)}';
  Map<String, dynamic> frame() => {
    'surfaceId': id,
    'op': 'frame',
    'width': _width,
    'height': _height,
    'dark': false,
    'events': const [],
  };
  try {
    if ((await request(frame()))['error'] != null) return null;
    await Future<void>.delayed(settle);
    final reply = await request(frame());
    final data = reply['data'];
    if (reply['error'] != null ||
        reply['mime'] != 'image/jpeg' ||
        data is! String ||
        data.length > 2 * 1024 * 1024) {
      return null;
    }
    return data;
  } catch (_) {
    return null;
  } finally {
    unawaited(
      request({'surfaceId': id, 'op': 'close'}).then((_) {}, onError: (_) {}),
    );
  }
}

/// A self-contained output page showing [jpeg]: the same shape as a featured starter's poster,
/// but of this version.
String viewerPosterPage(String title, String jpeg) {
  final alt = const HtmlEscape().convert(
    '$title, as its viewer showed it when published',
  );
  return '<!doctype html><html><head><meta charset="utf-8"><title>${const HtmlEscape().convert(title)}</title>'
      '<style>body{margin:0;background:#f7f7f7}img{display:block;width:100%;height:100vh;object-fit:contain}</style>'
      '</head><body><img alt="$alt" src="data:image/jpeg;base64,$jpeg"></body></html>';
}
