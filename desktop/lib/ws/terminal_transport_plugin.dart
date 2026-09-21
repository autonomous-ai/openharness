import 'dart:typed_data';

import 'relay_codec.dart';

/// Which wire a frame is forced onto, when the plugin asks for one rather than
/// leaving the choice to its own routing table.
enum TransportVia { ws, plugin }

/// What a [TerminalTransportPlugin] needs from the relay [WsConn] it rides on.
///
/// Every method here lands the plugin's traffic on the SAME FIFOs the socket's own
/// frames use — the outbound one so the E2EE counters are taken in send order
/// whichever wire carries a frame, and the inbound one so replay-window commits and
/// `onEvent` ordering stay serial with what arrives over the WebSocket.
abstract interface class TerminalTransportHost {
  /// The connection's E2EE session, minted per connect.
  RelayCodec get codec;

  /// A plain `{type, payload}` frame of the plugin's own, sealed by the codec where
  /// its type requires it and queued on the outbound FIFO like any other. Without
  /// [force] it is routed the ordinary way (offered back to [TerminalTransportPlugin.sendJson]);
  /// with one, that wire is used. False when it could not go at all.
  Future<bool> send(Map<String, dynamic> frame, {TransportVia? force});

  /// Runs [task] on the inbound FIFO, after everything already queued.
  void enqueueInbound(Future<void> Function() task);

  /// A decoded `{type, payload}` frame, delivered as if it had arrived over the
  /// WebSocket: request/reply matching first, `onEvent` otherwise.
  Future<void> dispatch(Map<String, dynamic> plain);

  /// A loopback (HTRL) binary frame, delivered as if it had arrived over the WebSocket.
  Future<void> deliverBinary(Uint8List localFrame);
}

/// A second wire beside the relay WebSocket — the phone's WebRTC data channel to the
/// machine — that a relay [WsConn] offers every terminal frame to before falling back
/// to the socket. Pure interface: nothing in the shared package knows what the wire
/// is, only where in the socket's life it gets a say.
///
/// The harness CLI plays this role for the desktop (`remoteRelay.ts`); a viewer build
/// that wants the same plugs one of these in through `ViewerServices`.
abstract interface class TerminalTransportPlugin {
  /// The relay's ack to `machine_select` — before the E2EE hello goes out. The
  /// payload carries the backend's transport policy (`p2p`), if any.
  void onConnectedAck(Map<String, dynamic> payload);

  /// The E2EE session is up: `codec.terminalP2pVersion` is now known.
  void onSessionReady();

  /// True for a frame type the plugin owns outright (signaling); such a frame goes
  /// to [handleInbound] and never reaches `onEvent`.
  bool consumesInbound(String type);
  Future<void> handleInbound(String type, Map<String, dynamic> payload);

  /// A decoded WebSocket frame, AFTER it was dispatched to the app. Awaited on the
  /// inbound FIFO, so anything the plugin dispatches from here lands in order.
  Future<void> observeWsFrame(Map<String, dynamic> plain);

  /// A decoded WebSocket binary frame (HTRL), BEFORE it is delivered to the app.
  Future<void> observeWsBinary(Uint8List localFrame);

  /// Called before a `terminal_open` is queued: the plugin may wait (bounded) for its
  /// wire to be ready. True means the open should ride the plugin's wire.
  Future<bool> prepareOpen(String requestId);

  /// Inside the outbound FIFO, once the codec sealed the frame. True: the plugin took
  /// it — sent on its wire, or (a frame [force]d onto a wire that just went away)
  /// deliberately dropped. False: the socket sends it — and the plugin has already
  /// recorded whatever that means for its routing (a stream it thought was its own, say).
  bool sendJson(
    String type,
    Map<String, dynamic> payload,
    String sealedJson, {
    required bool openViaPlugin,
    TransportVia? force,
  });

  /// Inside the outbound FIFO, once the codec sealed the frame. Same contract as
  /// [sendJson]; may wait briefly for backpressure to clear.
  Future<bool> sendBinary(Uint8List localFrame, Uint8List sealedFrame);

  /// The socket is gone (closed, redialing, or refused). Tear the wire down.
  void dispose({bool notifyPeer = false});
}

/// One plugin per relay connection, built once the codec exists.
typedef TerminalTransportPluginFactory = TerminalTransportPlugin Function(
  TerminalTransportHost host,
  String machineId,
);
