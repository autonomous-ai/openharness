//! The tray's image on macOS. Desktop's status icon has a dark artwork, a solid tile with the face cut out, that AppKit
//! picks as it draws: so on a dark bar, macOS 26's clear one too, it is a white tile. Tauri sets one image; this one
//! picks the artwork the same way, by the appearance it is drawn in.

use block2::RcBlock;
use objc2::AnyThread;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_app_kit::{NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSImage};
use objc2_foundation::{NSArray, NSData, NSRect, NSSize};

/// A template image of `size` points: `tray.png`, or `tray-dark.png` when drawn in a dark appearance.
pub fn image(size: NSSize) -> Option<Retained<NSImage>> {
    let artwork = |png: &[u8]| NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png));
    let light = artwork(include_bytes!("../icons/tray.png"))?;
    let dark = artwork(include_bytes!("../icons/tray-dark.png"))?;
    let draw = RcBlock::new(move |rect: NSRect| {
        // SAFETY: static names AppKit defines.
        let (aqua, dark_aqua) = unsafe { (NSAppearanceNameAqua, NSAppearanceNameDarkAqua) };
        let best = NSAppearance::currentDrawingAppearance()
            .bestMatchFromAppearancesWithNames(&NSArray::from_slice(&[aqua, dark_aqua]));
        let artwork = if best.is_some_and(|name| &*name == dark_aqua) { &dark } else { &light };
        artwork.drawInRect(rect);
        Bool::YES
    });
    let image = NSImage::imageWithSize_flipped_drawingHandler(size, false, &draw);
    image.setTemplate(true);
    Some(image)
}

#[cfg(test)]
mod tests {
    use super::image;
    use block2::RcBlock;
    use objc2::AnyThread;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSAppearance, NSAppearanceName, NSAppearanceNameAccessibilityHighContrastDarkAqua, NSAppearanceNameAqua,
        NSAppearanceNameDarkAqua, NSAppearanceNameVibrantDark, NSAppearanceNameVibrantLight, NSBitmapImageRep, NSImage,
        NSImageHintCTM,
    };
    use objc2_foundation::{NSAffineTransform, NSData, NSDictionary, NSPoint, NSRect, NSSize};
    use std::cell::RefCell;

    /// Each pixel's alpha, row by row: all of a picture a template image keeps.
    fn alpha(pixels: &NSBitmapImageRep) -> Vec<u8> {
        let (wide, high) = (pixels.pixelsWide(), pixels.pixelsHigh());
        (0..high)
            .flat_map(|y| (0..wide).map(move |x| (x, y)))
            .map(|(x, y)| (pixels.colorAtX_y(x, y).unwrap().alphaComponent() * 255.0).round() as u8)
            .collect()
    }

    /// The artwork as its file has it: two pixels a point, as a Retina menu bar draws it.
    fn artwork(png: &[u8]) -> Vec<u8> {
        alpha(&NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &NSData::with_bytes(png)).unwrap())
    }

    /// The image as AppKit draws it in an appearance, at two pixels a point.
    fn drawn(image: &NSImage, appearance: &NSAppearanceName) -> Vec<u8> {
        let scale = NSAffineTransform::transform();
        scale.scaleBy(2.0);
        let value: &AnyObject = &scale;
        // SAFETY: a static AppKit defines.
        let hints = NSDictionary::from_slices(&[unsafe { NSImageHintCTM }], &[value]);
        let pixels = RefCell::new(Vec::new());
        NSAppearance::appearanceNamed(appearance).unwrap().performAsCurrentDrawingAppearance(&RcBlock::new(|| {
            let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), image.size());
            // SAFETY: a rect that lives for the call, and the transform NSImageHintCTM takes.
            let drawn = unsafe { image.CGImageForProposedRect_context_hints(&mut rect, None, Some(&hints)) }.unwrap();
            *pixels.borrow_mut() = alpha(&NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &drawn));
        }));
        pixels.into_inner()
    }

    #[test]
    fn the_tray_draws_the_dark_artwork_in_a_dark_appearance() {
        let tray = image(NSSize::new(28.0, 18.0)).unwrap();
        assert!(tray.isTemplate());
        let (light, dark) =
            (artwork(include_bytes!("../icons/tray.png")), artwork(include_bytes!("../icons/tray-dark.png")));
        assert_ne!(light, dark);
        // SAFETY: statics AppKit defines.
        let (aqua, dark_aqua, vibrant_light, vibrant_dark, contrast_dark) = unsafe {
            (
                NSAppearanceNameAqua,
                NSAppearanceNameDarkAqua,
                NSAppearanceNameVibrantLight,
                NSAppearanceNameVibrantDark,
                NSAppearanceNameAccessibilityHighContrastDarkAqua,
            )
        };
        // Each twice, after the other: what AppKit keeps of one drawing never shows in the other.
        for _ in 0..2 {
            assert!(drawn(&tray, aqua) == light, "light");
            assert!(drawn(&tray, dark_aqua) == dark, "dark");
        }
        // The menu bar's own appearances.
        assert!(drawn(&tray, vibrant_light) == light, "vibrant light");
        assert!(drawn(&tray, vibrant_dark) == dark, "vibrant dark");
        assert!(drawn(&tray, contrast_dark) == dark, "high contrast dark");
    }
}
