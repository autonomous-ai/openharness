export const SIZES = { small: 160, medium: 480, large: 1280 }

// Scales by the width only, keeping the aspect ratio; never upscales.
export function thumbnailsFor(image) {
  return Object.entries(SIZES).map(([name, width]) => {
    const w = Math.min(width, image.width)
    return { name, width: w, height: Math.round((image.height * w) / image.width) }
  })
}

export async function resize(image) {
  return thumbnailsFor(image).map((size) => ({ ...size, pixels: scale(image, size) }))
}

// Nearest neighbour on 8-bit grey pixels: cheap, and good enough for thumbnails.
function scale(image, { width, height }) {
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y * image.height) / height) * image.width
    for (let x = 0; x < width; x++) out[y * width + x] = image.pixels[row + Math.floor((x * image.width) / width)]
  }
  return out
}
