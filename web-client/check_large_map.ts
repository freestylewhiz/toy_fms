import { chromium } from 'playwright';
import { Client } from 'colyseus.js';
import { strict as assert } from 'node:assert';
import { Database } from 'bun:sqlite';
import { fitCamera } from './src/camera.ts';
import { join } from 'node:path';

const base = process.env.ATLAS_WEB_URL ?? 'http://127.0.0.1:5174';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const errors: string[] = [];
page.on('pageerror', e=>errors.push(String(e)));
const host = new URL(base).hostname;
const large = await new Client('ws://'+host+':2569').joinOrCreate('floor');
const yard = await new Client('ws://'+host+':2568').joinOrCreate('floor');
let denied = '';
large.onMessage('error', msg=>{denied=msg.message;});
large.onMessage('editorAck', ()=>{});
large.onMessage('commandAck', ()=>{});
let id = '';
const name = 'large-map-check-'+crypto.randomUUID();
async function until(check:()=>boolean,label:string, timeout=15000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) { if(check())return; await Bun.sleep(50); }
  throw new Error('Timed out: '+label);
}
async function mapPoint(x:number,y:number) {
  await page.locator('#view-fit').click();
  const size=await page.locator('#viewport').evaluate(el=>({w:el.clientWidth,h:el.clientHeight}));
  const cam=fitCamera(size.w,size.h,10000,10000);
  return {x:cam.x+x*cam.scale,y:cam.y+y*cam.scale};
}
try {
  const started=Date.now();
  await page.goto(base+'/?map=large_lab');
  await page.locator('#outliner [data-id="q1-center"]').waitFor();
  console.log('Large map load ms:',Date.now()-started);
  assert.equal(await page.locator('#map-context-id').textContent(),'large_lab');
  await page.locator('#tools-scene [data-tool="waypoint"]').click();
  await page.locator('#map').click({position:await mapPoint(8200,2200)});
  await page.locator('#insp-name').fill(name);
  await page.locator('#btn-properties-save').click();
  await until(()=>[...(large.state as any).waypoints.values()].some((w:any)=>w.name===name),'UI save');
  id=[...(large.state as any).waypoints.values()].find((w:any)=>w.name===name).id;
  assert(!(yard.state as any).waypoints.has(id),'yard must not receive large-map edits');
  const db=new Database(join(import.meta.dir,'../data/large_lab/editor.sqlite'),{readonly:true});
  assert.equal((db.query('SELECT name FROM waypoints WHERE id=?').get(id) as any)?.name,name);
  db.close();
  await page.reload();
  await page.locator('#outliner [data-id="'+id+'"]').waitFor();
  // Fit zoom is below the old 12% minimum. Wheel must remain smooth at this scale.
  await page.locator('#map').hover();
  await page.mouse.wheel(0,150);
  await page.mouse.wheel(0,-150);
  await page.keyboard.press('g'); await page.waitForTimeout(200);
  await page.keyboard.press('g'); await page.waitForTimeout(200);
  await page.keyboard.press('g');
  large.send('editorUpsert',{kind:'waypoint',id:'blocked-'+id,name:'blocked',x:5000,y:5000,theta:0});
  await until(()=>denied==='not free','pillar rejects placement');
  assert(!(large.state as any).waypoints.has('blocked-'+id));
  await page.selectOption('#map-select','yard');
  const yardId=[...(yard.state as any).waypoints.keys()][0];
  assert(yardId, 'yard fixture needs an existing waypoint');
  await page.locator('#outliner [data-id="'+yardId+'"]').waitFor();
  assert.equal(await page.locator('#outliner [data-id="'+id+'"]').count(),0);
  await page.selectOption('#map-select','1st_floor');
  await until(()=>page.url().includes('map=1st_floor'),'preview switch');
  await page.selectOption('#map-select','large_lab');
  await page.locator('#outliner [data-id="'+id+'"]').waitFor();
  await until(()=>(large.state as any).robots.get('robot-1')?.controlReady,'live robot',20000);
  const r=(large.state as any).robots.get('robot-1');
  const startX=r.x, startY=r.y;
  large.send('commandRobot',{robotId:'robot-1',kind:'move',x:startX+24,y:startY,theta:0});
  await until(()=>r.commandState==='completed'&&Math.abs(r.x-startX-24)<0.5,'large-map local drive',20000);
  await page.locator('#view-fit').click();
  await page.screenshot({path:'/tmp/fms-large-map-verified.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS: browser save/reload, SQLite persistence, map isolation, pillar rejection, zoom/overlays, preview round-trip, live robot movement');
} finally {
  if(id) {large.send('editorDelete',{kind:'waypoint',id}); await until(()=>!(large.state as any).waypoints.has(id),'cleanup');}
  await large.leave(); await yard.leave(); await browser.close();
}
