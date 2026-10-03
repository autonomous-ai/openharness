import 'package:integration_test/integration_test.dart';

/// The integration-test binding, drawing frames the way the app's own binding
/// does: only when the framework asked for one.
///
/// ⚠️ **Without this every measurement here would be of a different app.**
/// [LiveTestWidgetsFlutterBinding] (which [IntegrationTestWidgetsFlutterBinding]
/// extends) ends every frame by asking the engine for another one, and under
/// `benchmarkLive`/`fullyLive` it draws each of them — so an idle terminal was
/// rebuilt, composited and rasterized at 60 Hz for the whole run, and a 20 Hz
/// output stream measured on top of 40 frames a second nobody asked for.
///
/// The fix is to skip a vsync the framework did not schedule. The framework's
/// own requests set `hasScheduledFrame` before the engine calls back, and it is
/// cleared inside `handleBeginFrame`, so it is still set when this override
/// runs. A skipped begin is paired with a skipped draw, which keeps the live
/// binding's begin/draw bookkeeping intact and — since its `handleDrawFrame`
/// never runs — stops the self-rescheduling loop. What is left is one idle vsync
/// callback after each real frame: no build, no scene, no raster.
class PerfBinding extends IntegrationTestWidgetsFlutterBinding {
  bool _skipped = false;

  /// Vsyncs the framework did not ask for, and so did not draw.
  int skippedVsyncs = 0;

  @override
  void handleBeginFrame(Duration? rawTimeStamp) {
    if (!hasScheduledFrame) {
      _skipped = true;
      skippedVsyncs++;
      return;
    }
    _skipped = false;
    super.handleBeginFrame(rawTimeStamp);
  }

  @override
  void handleDrawFrame() {
    if (_skipped) {
      _skipped = false;
      return;
    }
    super.handleDrawFrame();
  }
}
