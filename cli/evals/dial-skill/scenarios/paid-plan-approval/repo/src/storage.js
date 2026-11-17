import { readFileSync } from 'node:fs'

const config = JSON.parse(readFileSync(new URL('../config/storage.json', import.meta.url), 'utf8'))

export function urlFor(key) {
  return `${config.endpoint}/${config.bucket}/${key}`
}

export async function put(key, bytes) {
  const res = await fetch(urlFor(key), {
    method: 'PUT',
    headers: { 'x-access-key': config.accessKey, 'x-secret-key': config.secretKey },
    body: bytes,
  })
  if (!res.ok) throw new Error(`object store answered ${res.status} for ${key}`)
  return urlFor(key)
}
