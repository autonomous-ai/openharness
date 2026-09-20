// Small, bounded, deterministic ZIP writer. No global npm or Python dependency.
import {deflateRawSync,inflateRawSync} from 'node:zlib';
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
    if (total>128*1024*1024) throw new Error('Portable project exceeds 128 MiB uncompressed.');
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

// Read ZIP members in memory, never extract paths. Orca's 3MF is a ZIP container.
export function unzip(input) {
  const data=Buffer.from(input);if(data.length>32*1024*1024)throw new Error('ZIP exceeds 32 MiB.');
  let end=-1;for(let p=data.length-22;p>=Math.max(0,data.length-65557);p--)if(data.readUInt32LE(p)===0x06054b50&&p+22+data.readUInt16LE(p+20)===data.length){end=p;break;}
  if(end<0)throw new Error('Missing ZIP directory.');
  const count=data.readUInt16LE(end+10),size=data.readUInt32LE(end+12),start=data.readUInt32LE(end+16);
  if(data.readUInt16LE(end+4)||data.readUInt16LE(end+6)||count!==data.readUInt16LE(end+8)||!count||count>256||start+size!==end)throw new Error('Unsupported ZIP directory.');
  const result=new Map(),seen=new Set(),ranges=[];let cursor=start,total=0;
  for(let i=0;i<count;i++){
    if(cursor+46>end||data.readUInt32LE(cursor)!==0x02014b50)throw new Error('Invalid ZIP entry.');
    const flags=data.readUInt16LE(cursor+8),method=data.readUInt16LE(cursor+10),crc=data.readUInt32LE(cursor+16),compressed=data.readUInt32LE(cursor+20),length=data.readUInt32LE(cursor+24),n=data.readUInt16LE(cursor+28),extra=data.readUInt16LE(cursor+30),comment=data.readUInt16LE(cursor+32),offset=data.readUInt32LE(cursor+42);
    if(flags&1||![0,8].includes(method)||compressed===0xffffffff||length===0xffffffff||offset===0xffffffff||data.readUInt16LE(cursor+34))throw new Error('Encrypted, split or ZIP64 files are unsupported.');
    if(cursor+46+n+extra+comment>end)throw new Error('Truncated ZIP entry.');
    const name=data.subarray(cursor+46,cursor+46+n).toString('utf8'),key=name.toLowerCase();
    if(!name||name.includes('\\')||name.includes('\0')||name.startsWith('/')||name.includes(':')||name.split('/').some(v=>v==='.'||v==='..'||!v)||seen.has(key))throw new Error('Unsafe or duplicate ZIP path.');
    if((data.readUInt32LE(cursor+38)>>>16&0xf000)===0xa000)throw new Error('ZIP symlinks are unsupported.');
    seen.add(key);total+=length;if(total>128*1024*1024)throw new Error('Expanded ZIP exceeds 128 MiB.');
    if(offset+30>start||data.readUInt32LE(offset)!==0x04034b50||data.readUInt16LE(offset+6)!==flags||data.readUInt16LE(offset+8)!==method)throw new Error('ZIP local header mismatch.');
    const ln=data.readUInt16LE(offset+26),le=data.readUInt16LE(offset+28),body=offset+30+ln+le,finish=body+compressed;
    if(finish>start||!data.subarray(offset+30,offset+30+ln).equals(Buffer.from(name)))throw new Error('ZIP member bounds/name mismatch.');
    if(ranges.some(([a,b])=>offset<b&&finish>a))throw new Error('Overlapping ZIP members.');ranges.push([offset,finish]);
    const bytes=method===0?data.subarray(body,finish):inflateRawSync(data.subarray(body,finish),{maxOutputLength:Math.max(1,length)});
    if(bytes.length!==length||crc32(bytes)!==crc)throw new Error('ZIP member checksum mismatch.');result.set(name,bytes);cursor+=46+n+extra+comment;
  }
  if(cursor!==end)throw new Error('Unexpected ZIP directory data.');return result;
}
