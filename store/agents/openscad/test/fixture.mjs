// A transport fixture only, never evidence of a real OpenSCAD render.
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export const tetra='solid tetra\n'+[[[0,0,0],[0,1,0],[1,0,0]],[[0,0,0],[1,0,0],[0,0,1]],[[0,0,0],[0,0,1],[0,1,0]],[[1,0,0],[0,1,0],[0,0,1]]].map(face=>'facet normal 0 0 0\nouter loop\n'+face.map(v=>'vertex '+v.join(' ')).join('\n')+'\nendloop\nendfacet').join('\n')+'\nendsolid tetra\n';
export function compiler(fixture,body=''){
  return '#!'+process.execPath+'\n'+
    'import {copyFileSync,writeFileSync} from "node:fs";\n'+
    'const a=process.argv.slice(2);if(a[0]==="--version"){console.log("OpenSCAD version transport-fixture");process.exit(0);}\n'+
    body+'\n'+
    'const out=a[a.indexOf("-o")+1];copyFileSync('+JSON.stringify(fixture)+',out);\n'+
    'if(a.includes("-d"))writeFileSync(a[a.indexOf("-d")+1],out+": "+a.at(-1)+"\\n");\n';
}
export async function fakeCompiler(workspace,body=''){
  const fixture=join(workspace,'fixture.stl'),bin=join(workspace,'fake-openscad.mjs');
  await writeFile(fixture,tetra);await writeFile(bin,compiler(fixture,body),{mode:0o755});return bin;
}
