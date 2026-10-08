import Cocoa
import os

/// Stops Flutter's macOS back-buffer cache from handing a frame a surface of
/// another size — the raster-thread crash tracked upstream as
/// https://github.com/flutter/flutter/issues/185394 (open as of Flutter 3.47.2).
///
/// `-[FlutterBackBufferCache removeSurfaceForSize:]` (FlutterSurfaceManager.mm)
/// purges itself only when its FIRST surface has another size, then returns its
/// youngest free surface without looking at that one's size; `returnSurfaces:`
/// appends the previous frame's surfaces whatever theirs. So when the window
/// goes A → B → A — a live resize dragged back, a display unplugged and
/// replugged — while a web pane puts more than one layer on screen, a frame
/// drawn at A can be given a surface still sized B. Impeller wraps that texture
/// under the frame's size, the wrapped texture marks itself invalid, the render
/// target drops it without a word, and `Canvas::SetupRenderPass` dereferences
/// the missing color texture: EXC_BAD_ACCESS at 0x0 on io.flutter.raster.
/// Skia, which Intel builds use, is handed the same wrong-size texture.
///
/// The replacement below turns such a surface away: it empties the cache and
/// answers nil, which is an ordinary cache miss — the surface manager then
/// allocates a fresh surface of the requested size on its own path, with its
/// own device and color space. A surface of the right size passes through
/// untouched, so a normal frame costs one size comparison.
///
/// The cache is engine-private, so every class, selector and type encoding is
/// checked first; a Flutter release that renames or reshapes any of them leaves
/// the cache as it was and says so in the log. Delete this file once the pinned
/// Flutter carries the upstream fix.
enum SurfaceCacheGuard {
  private static let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "ai.autonomous.harness",
    category: "SurfaceCacheGuard"
  )
  private static var installed = false

  private typealias RemoveSurface = @convention(c) (AnyObject, Selector, CGSize) -> AnyObject?
  private typealias Flush = @convention(c) (AnyObject, Selector) -> Void
  private typealias SurfaceSize = @convention(c) (AnyObject, Selector) -> CGSize

  /// Call before the first FlutterViewController exists: the engine's first
  /// frame already draws from this cache. Main thread only; repeat calls are
  /// no-ops.
  static func install() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard !installed else { return }
    installed = true

    let removeSelector = NSSelectorFromString("removeSurfaceForSize:")
    let flushSelector = NSSelectorFromString("flush")
    let sizeSelector = NSSelectorFromString("size")
    let sizeType = String(cString: NSValue(size: .zero).objCType)
    guard
      let cacheClass = NSClassFromString("FlutterBackBufferCache"),
      let surfaceClass = NSClassFromString("FlutterSurface"),
      let removeMethod = class_getInstanceMethod(cacheClass, removeSelector),
      let flushMethod = class_getInstanceMethod(cacheClass, flushSelector),
      let sizeMethod = class_getInstanceMethod(surfaceClass, sizeSelector),
      types(of: removeMethod) == ["@", "@", ":", sizeType],
      types(of: flushMethod) == ["v", "@", ":"],
      types(of: sizeMethod) == [sizeType, "@", ":"]
    else {
      log.error("Not installed: Flutter's back-buffer cache API has changed")
      return
    }

    let original = unsafeBitCast(method_getImplementation(removeMethod), to: RemoveSurface.self)
    let flush = unsafeBitCast(method_getImplementation(flushMethod), to: Flush.self)
    let surfaceSize = unsafeBitCast(method_getImplementation(sizeMethod), to: SurfaceSize.self)

    // Runs on the raster thread, once per backing store a frame asks for.
    let guarded: @convention(block) (AnyObject, CGSize) -> AnyObject? = { cache, size in
      guard let surface = original(cache, removeSelector, size) else { return nil }
      // Only a FlutterSurface is known to answer `size` through that IMP.
      guard let object = surface as? NSObject, object.isKind(of: surfaceClass) else {
        return surface
      }
      let actual = surfaceSize(object, sizeSelector)
      if actual == size { return surface }
      // The rest of the cache is likely just as stale; a miss on every
      // request until the next commit refills it with current-size surfaces.
      flush(cache, flushSelector)
      log.notice(
        "Dropped a \(Int(actual.width))x\(Int(actual.height)) back buffer for a \(Int(size.width))x\(Int(size.height)) frame"
      )
      return nil
    }
    method_setImplementation(removeMethod, imp_implementationWithBlock(guarded))
    log.info("Installed")
  }

  /// The method's return type followed by its argument types, self and _cmd
  /// included.
  private static func types(of method: Method) -> [String] {
    let returnType = method_copyReturnType(method)
    var types = [String(cString: returnType)]
    free(returnType)
    for index in 0..<method_getNumberOfArguments(method) {
      guard let argumentType = method_copyArgumentType(method, index) else { return [] }
      types.append(String(cString: argumentType))
      free(argumentType)
    }
    return types
  }
}
