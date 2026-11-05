const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const {JSDOM}=require('jsdom');
async function form(config={},options={}){
  const html=fs.readFileSync(path.join(__dirname,'../homebridge-ui/public/index.html'),'utf8');
  const dom=new JSDOM(html,{runScripts:'outside-only'});let saved;const alerts=[];
  dom.window.alert=text=>alerts.push(text);
  dom.window.homebridge={getPluginConfig:options.getPluginConfig||(async()=>[config]),request:async()=>({rooms:options.rooms||[]}),updatePluginConfig:async patch=>{saved=Object.assign(config,patch[0]);},savePluginConfig:async()=>{}};
  dom.window.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  await new Promise(resolve=>setImmediate(resolve));
  return {dom,window:dom.window,$:id=>dom.window.document.getElementById(id),getSaved:()=>saved,alerts};
}
test('form clears API key and final override, preserving child bridge and custom fields',async t=>{
  const f=await form({host:'127.0.0.1',name:'Custom',_bridge:{username:'AA:BB:CC:DD:EE:FF'},apiKey:'example',roomBoostOverrides:[{room:'3',boostLevel:150}]});t.after(()=>f.dom.window.close());
  f.$('apiKey').value='';f.$('overrideTbody').innerHTML='';f.$('btnSave').click();await new Promise(r=>setImmediate(r));
  const saved=f.getSaved();assert.equal(saved.apiKey,'');assert.equal(saved.roomBoostOverrides.length,0);assert.equal(saved.name,'Custom');assert.equal(saved._bridge.username,'AA:BB:CC:DD:EE:FF');
});
test('legacy address and Boost settings load, host edits override legacy endpoint',async t=>{
  const f=await form({healthBoxUri:'http://127.0.0.1/old',boostLevel:150,boostTimeout:900,enableBoostControl:true});t.after(()=>f.dom.window.close());
  assert.equal(f.$('host').value,'http://127.0.0.1/old');assert.equal(f.$('boostFanSpeed').value,'150');assert.equal(f.$('boostDuration').value,'900');
  f.$('host').value='127.0.0.2';const config=f.window.eval('buildConfig()');assert.equal(config.host,'127.0.0.2');assert.equal(config.healthBoxUri,'');assert.equal(config.baseUrl,'');
});
test('discovery preserves name-based and currently missing override selections',async t=>{
  const f=await form({host:'127.0.0.1',roomBoostOverrides:[{room:'Shower',boostLevel:150},{room:'missing',boostLevel:120}]},{rooms:[{id:'3',name:'Shower'}]});t.after(()=>f.dom.window.close());
  const rows=f.$('overrideTbody').querySelectorAll('tr');assert.equal(rows[0].querySelector('select').value,'3');assert.equal(rows[1].querySelector('select').value,'missing');
});
test('save disabled while loading and after load errors',async t=>{
  let release;const f=await form({}, {getPluginConfig:()=>new Promise(resolve=>release=resolve)});t.after(()=>f.dom.window.close());assert.equal(f.$('btnSave').disabled,true);assert.throws(()=>f.window.eval('buildConfig()'));
  release([]);await new Promise(r=>setImmediate(r));assert.equal(f.$('btnSave').disabled,false);
  const bad=await form({}, {getPluginConfig:async()=>{throw Error('failed')}});t.after(()=>bad.dom.window.close());assert.equal(bad.$('btnSave').disabled,true);
});
test('numeric fields reject out of range settings; passwords are masked',async t=>{
  const f=await form({});t.after(()=>f.dom.window.close());f.$('pollInterval').value='-1';assert.throws(()=>f.window.eval('buildConfig()'));assert.equal(f.$('mqttPassword').type,'password');assert.equal(f.$('apiKey').type,'password');
});
test('discovery server handles object, array and nested room inventories consistently',async()=>{
  for(const data of [{room:{3:{name:'Shower'}}},{room:[{id:3,name:'Shower'}]},{home:{room:[{id:3,name:'Shower'}]}}]){
    let instance;class Server{constructor(){instance=this}onRequest(){}ready(){}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../homebridge-ui/server.js'),'utf8'),{require:name=>name==='@homebridge/plugin-ui-utils'?{HomebridgePluginUiServer:Server}:require('../lib/api-data'),AbortController,setTimeout,clearTimeout,fetch:async()=>({ok:true,json:async()=>data})});
    const result=await instance.discoverRooms({host:'127.0.0.1'});assert.equal(result.rooms[0].id,'3');
  }
});
test('older discovery responses cannot overwrite new host results or leave button disabled',async t=>{
  const f=await form({});t.after(()=>f.dom.window.close());const pending=[];f.window.homebridge.request=()=>new Promise(resolve=>pending.push(resolve));
  f.$('host').value='127.0.0.1';const first=f.window.eval('discoverRooms()');f.$('host').value='127.0.0.2';const second=f.window.eval('discoverRooms({silent:true})');
  pending[1]({rooms:[{id:'2',name:'New'}]});await second;pending[0]({rooms:[{id:'1',name:'Old'}]});await first;
  assert.equal(f.window.buildRoomCell().options[1].value,'2');assert.equal(f.$('btnDiscover').disabled,false);
});
