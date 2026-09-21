import {chromium} from '../toolchain/node_modules/playwright-core/index.mjs';
import {browserPath} from '../toolchain/browser.mjs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
const root=resolve(process.argv[2]),out=fileURLToPath(new URL('../../../showcase/voxel-worlds/',import.meta.url));await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:await browserPath(),headless:true,args:['--enable-unsafe-swiftshader']}),page=await browser.newPage({viewport:{width:1440,height:960}});
try{for(const [id,name,phase]of [['lantern-quay','starter','before'],['civic-court','civic-court','before'],['amber-vault','amber-vault','after']]){await page.goto(pathToFileURL(join(root,id,phase,'studio.html')).href);await page.waitForFunction(()=>window.tidelands);await page.waitForTimeout(500);await page.screenshot({path:join(out,name+'.jpg'),type:'jpeg',quality:91});}console.log(out);}finally{await browser.close();}
