import {mkdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '../toolchain/node_modules/playwright-core/index.mjs';
import {browserPath} from '../toolchain/browser.mjs';
const root=resolve(process.argv[2]||'work/experience-evidence/vector-acceptance'),output=resolve('store/showcase/drone-pilot');await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:await browserPath(),headless:true});
try{
  for(const [site,stage,name,mode]of [['alder-orchard','before','starter','capture'],['works-yard','before','works-yard','plan'],['estuary-plots','after','estuary-evidence','evidence']]){
    const page=await browser.newPage({viewport:{width:1536,height:980}});await page.goto(pathToFileURL(join(root,site,stage,'delivery/planner.html')).href);await page.waitForFunction(()=>window.vector?.plan);
    if(mode==='capture')await page.locator('[data-sortie="1"]').click();
    if(mode==='evidence'){await page.locator('#evidence-tab').click();await page.locator('#show-coverage').check();}
    await page.screenshot({path:join(output,name+'.jpg'),type:'jpeg',quality:90});await page.close();
  }
}finally{await browser.close();}
