import 'dart:async';
import 'dart:io';

/// The WebSocket a loopback fixture serves, or null for a request that is not
/// an upgrade, which is answered 400 while the fixture keeps serving.
///
/// A loopback port is open to every process on the computer, and in a
/// parallel suite something else's plain HTTP request can reach it.
/// `WebSocketTransformer.upgrade` alone throws on that request, and the throw
/// fails whichever test owned the port.
Future<WebSocket?> acceptWebSocket(
  HttpRequest request, {
  String? Function(List<String> protocols)? protocolSelector,
}) async {
  if (!WebSocketTransformer.isUpgradeRequest(request)) {
    request.response.statusCode = HttpStatus.badRequest;
    await request.response.close();
    return null;
  }
  return WebSocketTransformer.upgrade(
    request,
    protocolSelector: protocolSelector,
  );
}
