// Small, bounded, deterministic ZIP writer. No global npm or Python dependency.
import {deflateRawSync} from 'node:zlib';
const table=Uint32Array.from({length:256},(_,value)=>{
  for (let i=0;i<8;i++) value=value&1 ? 0xedb88320^(value>>>1) : value>>>1;
  return value>>>0;
});
function crc32(bytes) {
  let crc=0xffffffff;
  for (const byte of bytes) crc=table[(crc^byte)&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
export function zip(files) {
  if (!files.length || files.length>256) throw new Error('Archive needs 1–256 files.');
  const chunks=[], central=[], names=new Set(); let offset=0, total=0;
  for (const {name,bytes:input} of files) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) || name.split('/').some(p=>!p || p==='.' || p==='..') || names.has(name.toLowerCase())) throw new Error('Unsafe or duplicate archive path: '+name);
    names.add(name.toLowerCase());
    const bytes=Buffer.from(input), filename=Buffer.from(name), compressed=deflateRawSync(bytes), crc=crc32(bytes);
    total+=bytes.length;
    if (total>32*1024*1024) throw new Error('Portable project exceeds 32 MiB uncompressed.');
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(8,8);
    header.writeUInt16LE(33,12); header.writeUInt32LE(crc,14); header.writeUInt32LE(compressed.length,18); header.writeUInt32LE(bytes.length,22); header.writeUInt16LE(filename.length,26);
    const entry=Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50,0); entry.writeUInt16LE(20,4); entry.writeUInt16LE(20,6); entry.writeUInt16LE(0x800,8); entry.writeUInt16LE(8,10); entry.writeUInt16LE(33,14);
    entry.writeUInt32LE(crc,16); entry.writeUInt32LE(compressed.length,20); entry.writeUInt32LE(bytes.length,24); entry.writeUInt16LE(filename.length,28); entry.writeUInt32LE(offset,42);
    chunks.push(header,filename,compressed); central.push(entry,filename); offset+=header.length+filename.length+compressed.length;
  }
  const directory=Buffer.concat(central), end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  const output=Buffer.concat([...chunks,directory,end]);
  if (output.length>32*1024*1024) throw new Error('Portable project exceeds the 32 MiB download limit.');
  return output;
}
