import { resize } from './resize.js'
import { put } from './storage.js'

export async function handleUpload(photoId, image) {
  const thumbs = await resize(image)
  const urls = {}
  for (const thumb of thumbs) urls[thumb.name] = await put(`${photoId}/${thumb.name}.jpg`, thumb.pixels)
  return urls
}
