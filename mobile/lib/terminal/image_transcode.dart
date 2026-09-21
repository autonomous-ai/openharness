import 'dart:typed_data';
import 'dart:ui' as ui;

import 'terminal_binary.dart';

/// Turns a picture the phone picked into the PNG the terminal pipe accepts.
///
/// ⚠️ **PNG is not a preference here, it is the only format that survives the trip.** The bytes go
/// out as [TerminalBinaryKind.imagePaste], and on the far side the CLI hands them to the host's own
/// clipboard — `osascript … as «class PNGf»` on macOS, `wl-copy --type image/png` on Wayland,
/// `xclip -t image/png` on X11. All three name PNG outright, and the file the CLI writes is named
/// `<uuid>.png` whatever is inside it. A JPEG sent as-is therefore does not arrive as a smaller
/// picture — it fails the clipboard write, falls back to pasting a FILE PATH, and the agent is
/// handed a `.png` that is really a JPEG. The phone is the only place that can fix this, so it does.
///
/// A phone camera also shoots far larger than an agent needs to read: 4000px wide at 12MP, against a
/// terminal that will show it at a fraction of that. Downscaling first is what keeps the re-encode
/// from blowing through [terminalLocalImagePasteMaxPayloadBytes] — PNG is lossless, so a picture
/// that was 2MB as JPEG can be 20MB as PNG at full size.

/// The longest edge a picture is reduced to before it is encoded.
///
/// 1600px is a compromise between two real failures: smaller starts losing the text in a screenshot,
/// which is most of what anybody sends an agent; larger pushes a photographic image past the payload
/// ceiling even after the retries below.
const _preferredMaxEdge = 1600;

/// The edges tried, in order, if the first encode comes out too large.
///
/// Photographic noise is what makes a PNG big — a beach photo does not compress the way a screenshot
/// does — and halving the edge quarters the pixel count, so this converges fast. The last step is
/// small enough to be legible but is deliberately not tiny: failing is better than silently sending
/// something nobody can read.
const _fallbackMaxEdges = [1200, 800, 600];

/// The result of preparing a picture: the PNG to send, or why there is nothing to send.
sealed class ImageTranscodeResult {
  const ImageTranscodeResult();
}

/// Ready to go out over [TerminalSession.pasteImage].
class ImageTranscodeOk extends ImageTranscodeResult {
  const ImageTranscodeOk(this.pngBytes);

  final Uint8List pngBytes;
}

/// The bytes could not be read as a picture at all.
///
/// Not the same as [ImageTranscodeTooLarge], and they read differently to somebody holding a phone:
/// this one means "that file is not an image", which no amount of retrying fixes.
class ImageTranscodeUnreadable extends ImageTranscodeResult {
  const ImageTranscodeUnreadable();
}

/// A picture that is still over the ceiling at the smallest size this will try.
class ImageTranscodeTooLarge extends ImageTranscodeResult {
  const ImageTranscodeTooLarge(this.bytes);

  /// What the smallest attempt weighed, for a message that can say how far over it is.
  final int bytes;
}

/// Decodes [bytes] with the platform's own codec, downscales it, and re-encodes it as PNG.
///
/// The platform codec rather than a Dart decoder on purpose: it is the one that already knows HEIC,
/// which is what an iPhone camera produces by default, and it decodes on its own threads instead of
/// stalling the frame that is drawing the key bar. `targetWidth`/`targetHeight` are applied DURING
/// the decode, so a 12MP photo is never fully rasterised at native size just to be thrown away.
Future<ImageTranscodeResult> transcodeToPng(Uint8List bytes) async {
  if (bytes.isEmpty) return const ImageTranscodeUnreadable();

  final ui.ImageDescriptor descriptor;
  final ui.ImmutableBuffer buffer;
  try {
    buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
  } catch (_) {
    return const ImageTranscodeUnreadable();
  }
  try {
    descriptor = await ui.ImageDescriptor.encoded(buffer);
  } catch (_) {
    // `fromUint8List` takes anything; this is where a PDF, a HEIC the OS cannot read, or a
    // truncated download actually fails.
    buffer.dispose();
    return const ImageTranscodeUnreadable();
  }

  final width = descriptor.width;
  final height = descriptor.height;
  if (width <= 0 || height <= 0) {
    descriptor.dispose();
    return const ImageTranscodeUnreadable();
  }

  // Every attempt re-decodes from the same descriptor rather than re-scaling an already-scaled
  // bitmap: scaling twice softens edges that were sharp, and in a screenshot those edges are text.
  var smallest = -1;
  try {
    for (final maxEdge in [_preferredMaxEdge, ..._fallbackMaxEdges]) {
      final png = await _encodePngAtMaxEdge(
        descriptor: descriptor,
        width: width,
        height: height,
        maxEdge: maxEdge,
      );
      if (png == null) return const ImageTranscodeUnreadable();
      if (png.lengthInBytes <= terminalLocalImagePasteMaxPayloadBytes) {
        return ImageTranscodeOk(png);
      }
      smallest = png.lengthInBytes;
    }
  } finally {
    descriptor.dispose();
  }
  return ImageTranscodeTooLarge(smallest);
}

/// One attempt: decode at a size whose longest edge is at most [maxEdge], then encode PNG.
///
/// Returns null if the decode itself failed, which is not the same as the result being too big.
Future<Uint8List?> _encodePngAtMaxEdge({
  required ui.ImageDescriptor descriptor,
  required int width,
  required int height,
  required int maxEdge,
}) async {
  final longest = width > height ? width : height;
  // A picture already smaller than the target is left at its own size — upscaling would add bytes
  // and no detail. The ratio is applied to BOTH edges so the aspect is kept; passing only one lets
  // the engine pick the other, and it rounds independently.
  final scale = longest <= maxEdge ? 1.0 : maxEdge / longest;
  final targetWidth = scale == 1.0 ? width : (width * scale).round().clamp(1, width);
  final targetHeight = scale == 1.0 ? height : (height * scale).round().clamp(1, height);

  ui.Codec? codec;
  ui.FrameInfo? frame;
  try {
    codec = await descriptor.instantiateCodec(
      targetWidth: targetWidth,
      targetHeight: targetHeight,
    );
    frame = await codec.getNextFrame();
    final data = await frame.image.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) return null;
    // `.buffer.asUint8List()` would hand back the whole backing store, which for a view into a
    // larger buffer is more bytes than the image — and those bytes are what gets uploaded.
    return data.buffer.asUint8List(
      data.offsetInBytes,
      data.lengthInBytes,
    );
  } catch (_) {
    return null;
  } finally {
    // The frame's image holds GPU/native memory that the Dart GC does not account for, so a picture
    // per attempt adds up on a phone that is already holding a terminal's scrollback.
    frame?.image.dispose();
    codec?.dispose();
  }
}
