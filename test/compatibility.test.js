const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { platform } = require('./helpers.cjs');
test('exact target versions and both legacy platform aliases', async () => {
  assert.ok([22, 24, 26].includes(Number(process.versions.node.split('.')[0])));
  const { api, aliases } = await platform();
  assert.equal(api.serverVersion, '2.5.0');
  assert.equal(aliases.length, 2);
});
test('real Homebridge HAP services, cache restore and stable UUIDs', async () => {
  const { p, api } = await platform({host:'127.0.0.1'});
  const state = {baseData:{serial:'SIMULATED', room:{'1':{name:'Bathroom', sensor:[
    {type:'indoor temperature', parameter:{temperature:{value:21.5}}},
    {type:'indoor relative humidity', parameter:{humidity:{value:55}}},
    {type:'indoor CO2', parameter:{concentration:{value:650}}}
  ]}}}, fan:{rpm:1000}, wifi:null, errors:[], coreData:null, boosts:new Map()};
  await p.syncAccessories(state);
  assert.ok(p.accessories.size >= 4);
  const ids = [...p.accessories.keys()];
  for (const a of p.accessories.values()) p.configureAccessory(a);
  await p.syncAccessories(state);
  assert.deepEqual([...p.accessories.keys()], ids);
  const temperature = [...p.accessories.values()].find(a => a.getService(api.hap.Service.TemperatureSensor));
  assert.equal(temperature.getService(api.hap.Service.TemperatureSensor).getCharacteristic(api.hap.Characteristic.CurrentTemperature).value,21.5);
  api.emit('shutdown');
});
test('HTTP JSON, POST body, HTTP errors, invalid JSON and timeout', async t => {
  const requests = [];
  const server = http.createServer((req,res) => {
    let body=''; req.on('data', c => body+=c); req.on('end', () => {
      requests.push({url:req.url, body});
      if(req.url==='/hang') return;
      if(req.url==='/error') {res.writeHead(503);res.end();return;}
      res.end(req.url==='/bad' ? 'invalid' : JSON.stringify({ok:true}));
    });
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => {server.closeAllConnections();server.close();});
  const {p} = await platform({host:`127.0.0.1:${server.address().port}`});
  assert.deepEqual(await p.requestJson('GET','/ok'),{ok:true});
  await p.requestJson('POST','/post',{data:{enable:true}});
  assert.equal(requests[1].body,'{"enable":true}');
  await assert.rejects(p.requestJson('GET','/error'),/503/);
  await assert.rejects(p.requestJson('GET','/bad'),SyntaxError);
  p.requestTimeout=0.03;
  await assert.rejects(p.requestJson('GET','/hang'),{name:'AbortError'});
});
test('shutdown clears polling and prevents interval after pending initialization', async () => {
  const {p,api} = await platform();
  p.enableAdvancedApiIfNeeded=async()=>false;
  p.refreshData=async()=>{};
  await p.initialize();
  assert.ok(p.pollTimer);
  api.emit('shutdown');
  assert.equal(p.pollTimer,null);
  const second=await platform();
  let finish;
  second.p.enableAdvancedApiIfNeeded=()=>new Promise(resolve=>finish=resolve);
  const init=second.p.initialize();
  second.api.emit('shutdown'); finish(false); await init;
  assert.equal(second.p.pollTimer,null);
});
test('discovery timeout covers a stalled response body and clears timer', async () => {
  let ui, cleared=0;
  class Ui { constructor(){ui=this;} onRequest(){} ready(){} }
  const source=fs.readFileSync(path.join(__dirname,'../homebridge-ui/server.js'),'utf8');
  vm.runInNewContext(source,{
    require:name=>name === "@homebridge/plugin-ui-utils" ? ({HomebridgePluginUiServer:Ui}) : require("../lib/api-data"), AbortController,
    setTimeout:fn=>setTimeout(fn,20), clearTimeout:id=>{cleared++;clearTimeout(id);},
    fetch:async(_url,{signal})=>({ok:true,json:()=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error(),{name:'AbortError'}))))})
  });
  await assert.rejects(ui.discoverRooms({host:'127.0.0.1'}),/Timeout/);
  assert.equal(cleared,1);
});
test('tiered polling skips static endpoints and stops network after shutdown', async () => {
  const {p,api,errors}=await platform({host:'127.0.0.1'});
  const calls=[];
  p.requestJson=async (_method,url)=>{calls.push(url);return url==='/v2/api/data/current'?{room:{}}:url==='/v2/device/error'?[]:{};};
  p.syncAccessories=async()=>{};
  await p.refreshData();
  assert.ok(calls.includes('/renson_core/v2/global'));
  calls.length=0;
  await p.refreshData();
  assert.deepEqual(calls,['/v2/api/data/current','/v2/device/fan']);
  api.emit('shutdown'); calls.length=0;
  await p.refreshData();
  assert.equal(calls.length,0);
  assert.deepEqual(errors,[]);
});
test('boost acknowledges PUT without waiting for settling; failures reach HomeKit', async () => {
  const {p,api}=await platform();
  const a=new api.platformAccessory('Test Boost',api.hap.uuid.generate('test-boost'));
  a.context={roomId:'3',roomName:'Shower'};
  const service=a.addService(api.hap.Service.Switch,'Test Boost');
  p.attachBoostSwitchHandlers(a,service);
  let release; p.sleep=()=>new Promise(resolve=>release=resolve);
  let sent=false; p.setRoomBoost=async()=>{sent=true;};
  const c=service.getCharacteristic(api.hap.Characteristic.On);
  await c.handleSetRequest(true);
  assert.equal(sent,true);
  assert.equal(p.boostWatch.has('3'),true);
  release();
  p.setRoomBoost=async()=>{throw new Error('simulated device failure');};
  await assert.rejects(c.handleSetRequest(false));
  api.emit('shutdown');
});
