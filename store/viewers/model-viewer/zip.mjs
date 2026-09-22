// A bounded, UTF-8 ZIP writer for portable saved designs. No external archiver or service.
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
export function writeProjectZip(root, destination) {
  const body = [],
    directory = []
  let offset = 0,
    total = 0,
    count = 0
  function visit(path = '') {
    for (const name of readdirSync(join(root, path)).sort()) {
      const entry = path ? path + '/' + name : name
      const full = join(root, entry),
        stat = lstatSync(full)
      if (full === destination) continue
      if (stat.isSymbolicLink()) throw new Error('Project archives cannot include symbolic links')
      if (stat.isDirectory()) {
        visit(entry)
        continue
      }
      if (!stat.isFile()) throw new Error('Unsupported project archive entry')
      total += stat.size
      if (++count > 10000 || total > 512 * 1024 * 1024)
        throw new Error('The project archive exceeds 512 MB or 10,000 files')
      const data = readFileSync(full),
        compressed = deflateRawSync(data),
        filename = Buffer.from(entry)
      const crc = crc32(data),
        header = Buffer.alloc(30),
        central = Buffer.alloc(46)
      header.writeUInt32LE(0x04034b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(0x800, 6)
      header.writeUInt16LE(8, 8)
      header.writeUInt16LE(33, 12)
      header.writeUInt32LE(crc, 14)
      header.writeUInt32LE(compressed.length, 18)
      header.writeUInt32LE(data.length, 22)
      header.writeUInt16LE(filename.length, 26)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(20, 4)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(0x800, 8)
      central.writeUInt16LE(8, 10)
      central.writeUInt16LE(33, 14)
      central.writeUInt32LE(crc, 16)
      central.writeUInt32LE(compressed.length, 20)
      central.writeUInt32LE(data.length, 24)
      central.writeUInt16LE(filename.length, 28)
      central.writeUInt32LE(offset, 42)
      body.push(header, filename, compressed)
      directory.push(central, filename)
      offset += header.length + filename.length + compressed.length
    }
  }
  visit()
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  writeFileSync(destination, Buffer.concat([...body, central, end]))
}
