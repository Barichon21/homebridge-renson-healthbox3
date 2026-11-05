const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createServer} = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {platform} = require('./helpers.cjs');
const {numberOrNull, normalizeRooms, normalizeData, endpointUrl, vocDensity} = require('../lib/api-data');
const state = (room={},fan=null)=>({baseData:{room},fan,wifi:null,errors:[],coreData:null,boosts:new Map()});
const room = (value=22)=>({'3':{name:'Shower',sensor:[{type:'indoor temperature',parameter:{temperature:{value}}}]}});

test('numbers reject missing, empty, booleans, containers and nonfinite values; real zero remains valid',()=>{
  for(const value of [null,undefined,'',' ',true,false,[],{},Infinity,'nan']) assert.equal(numberOrNull(value),null);
  for(const value of [0,'0']) assert.equal(numberOrNull(value),0);
  assert.equal(numberOrNull('21.5'),21.5);
});
test('all supported inventories share explicit room IDs; malformed inventories are rejected',()=>{
  for(const data of [{room:{3:{name:'Shower'}}},{room:[{id:3,name:'Shower'}]},{home:{room:[{id:3,name:'Shower'}]}}]) assert.deepEqual(Object.keys(normalizeRooms(data)),['3']);
  for(const data of [null,{}, {room:null},{room:[{name:'missing ID'}]},{room:[{id:3},{id:3}]},{room:{3:null}}]) assert.throws(()=>normalizeRooms(data));
  assert.equal(endpointUrl(' 192.168.1.2/legacy/ '),'http://192.168.1.2');
  assert.throws(()=>endpointUrl('http://user:pass@localhost'));
});
test('transient fan failure retains its identity and reports unavailable; recovery clears errors',async()=>{
  const {p,api}=await platform();let removed=0;api.unregisterPlatformAccessories=()=>removed++;
  await p.syncAccessories(state({}, {rpm:1000}));const a=[...p.accessories.values()][0];const c=a.getService(api.hap.Service.Fanv2).getCharacteristic(api.hap.Characteristic.Active);
  await p.syncAccessories(state());assert.equal(p.accessories.size,1);assert.equal(removed,0);assert.equal(c.statusCode,api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  await p.syncAccessories(state({}, {rpm:1000}));assert.equal([...p.accessories.values()][0],a);assert.equal(c.statusCode,0);
});
test('incomplete room data and invalid readings retain sensors but mark readings unavailable',async()=>{
  const {p,api}=await platform();await p.syncAccessories(state(room()));const a=[...p.accessories.values()][0];const c=a.getService(api.hap.Service.TemperatureSensor).getCharacteristic(api.hap.Characteristic.CurrentTemperature);
  await p.syncAccessories(state(room(null)));assert.equal(c.value,22);assert.equal(c.statusCode,api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  await p.syncAccessories(state());assert.equal(p.accessories.size,1);
  await p.syncAccessories(state(room(23)));assert.equal(c.value,23);assert.equal(c.statusCode,0);
});
test('complete primary failure marks existing sensors unavailable without deleting them',async()=>{
  const {p,api}=await platform();await p.syncAccessories(state(room()));p.requestJson=async()=>{throw Error('offline')};await p.refreshData();
  const c=[...p.accessories.values()][0].getService(api.hap.Service.TemperatureSensor).getCharacteristic(api.hap.Characteristic.CurrentTemperature);assert.notEqual(c.statusCode,0);assert.equal(p.accessories.size,1);
});
test('recreated Boost and profile objects get fresh command handlers at their existing UUID',async()=>{
  const {p,api}=await platform({enableBoostControl:true,enableProfileControl:true});
  const meta={roomId:'3',roomName:'Shower'};
  for(let n=0;n<2;n++){
    p.syncBoostValveAccessory(meta,{enabled:false,level:100},new Set());p.syncProfileAccessory(meta,'health',new Set());
    for(const a of p.accessories.values()){
      const svc=a.getService(api.hap.Service.Switch)||a.getService(api.hap.Service.Fanv2);
      assert.equal(typeof svc.getCharacteristic(a.context.kind==='profile'?api.hap.Characteristic.RotationSpeed:api.hap.Characteristic.On).setHandler,'function');
    }
    p.removeStaleAccessories(new Set());
  }
});
test('profile errors reach HomeKit and successful writes do not wait for settling',async()=>{
  const {p,api}=await platform({enableProfileControl:true});p.syncProfileAccessory({roomId:'3',roomName:'Shower'},'health',new Set());const c=[...p.accessories.values()][0].getService(api.hap.Service.Fanv2).getCharacteristic(api.hap.Characteristic.RotationSpeed);
  p.setRoomProfile=async()=>{throw Error('failure')};await assert.rejects(c.handleSetRequest(100));
  p.setRoomProfile=async()=>{};p.sleep=()=>new Promise(()=>{});await c.handleSetRequest(33);api.emit('shutdown');
});
test('array inventory uses explicit IDs for Boost HTTP requests',async()=>{
  const {p}=await platform();const ids=[];p.requestJson=async()=>({room:[{id:3,name:'Shower'}]});p.safeRequest=async()=>null;p.fetchRoomBoost=async id=>{ids.push(id);return null};p.syncAccessories=async()=>{};await p.refreshData();assert.deepEqual(ids,['3']);
});
test('unknown AQI scale stays unknown; explicit scales are monotonic and reject missing values',async()=>{
  const {p,api}=await platform();assert.equal(p.mapAirQualityIndex(5),api.hap.Characteristic.AirQuality.UNKNOWN);
  p.airQualityScale='index';assert.equal(p.mapAirQualityIndex(null),0);assert.equal(p.mapAirQualityIndex(5),1);assert.equal(p.mapAirQualityIndex(6),1);assert.equal(p.mapAirQualityIndex(90),5);
  p.airQualityScale='categories';assert.equal(p.mapAirQualityIndex(5),5);assert.equal(p.mapAirQualityIndex(6),0);
});
test('VOC density uses only declared mass density units; ppm and raw values are not guessed',()=>{
  assert.equal(vocDensity({value:12,unit:'µg/m³'}),12);assert.equal(vocDensity({value:0.2,unit:'mg/m3'}),200);
  for(const unit of ['ppm','ppb','',undefined]) assert.equal(vocDensity({value:12,unit}),null);
});
test('invalid MQTT settings do not prevent HomeKit polling',async()=>{
  const {p,api}=await platform({host:'127.0.0.1',mqttEnabled:true,mqttBroker:'mqtt://['});p.enableAdvancedApiIfNeeded=async()=>false;p.refreshData=async()=>{};
  await p.initialize();assert.ok(p.pollTimer);api.emit('shutdown');
});
test('MQTT shutdown waits for QoS1 completion then closes gracefully',async()=>{
  const {p}=await platform();let ack,ended; p.mqttClient={connected:true,publish(_topic,_payload,options,cb){assert.equal(options.qos,1);ack=cb;},end(force){ended=force;}};
  p.mqttShutdown();assert.equal(ended,undefined);assert.equal(p.mqttClient,null);ack();assert.equal(ended,false);
});
test('failed boost read is unknown rather than OFF and is not published',async()=>{
  const {p}=await platform();p.fetchRoomBoost=async()=>null;p.boostCache.set('3',{enabled:true});await p.refreshBoosts(['3'],Date.now());assert.equal(p.collectBoosts(['3']).get('3').unknown,true);
});
test('failed error read preserves known errors and failed static reads retry sooner',async()=>{
  const {p}=await platform();p.cachedErrors=[{error:'known'}];p.requestJson=async()=>({room:{}});p.safeRequest=async()=>null;p.syncAccessories=async()=>{};await p.refreshData();assert.equal(p.cachedErrors.length,1);assert.equal(p.lastStaticFetch,0);assert.ok(p.staticRetryAt>Date.now()-1000);assert.equal(p.lastErrorPoll,0);
});
test('shutdown aborts in-flight HTTP and cancels settling timers',async t=>{
  const server=createServer(()=>{});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const {p,api}=await platform({host:`127.0.0.1:${server.address().port}`});const request=p.requestJson('GET','/hang');const rejection=assert.rejects(request,{name:'AbortError'});const sleeping=p.sleep(60000);api.emit('shutdown');await rejection;await sleeping;assert.equal(p.pendingSleeps.size,0);assert.equal(p.requestControllers.size,0);
});
test('concurrent initialize starts exactly one poller',async()=>{
  const {p,api}=await platform();let refreshes=0;p.enableAdvancedApiIfNeeded=async()=>false;p.refreshData=async()=>{refreshes++};await Promise.all([p.initialize(),p.initialize()]);assert.equal(refreshes,1);api.emit('shutdown');
});
test('room IDs are encoded before constructing command URLs',async()=>{
  const {p}=await platform();let endpoint;p.requestJson=async(_method,url)=>{endpoint=url};await p.setRoomProfile('3/../4','eco');assert.equal(endpoint,'/v2/api/data/current/room/3%2F..%2F4/profile_name');
});
test('invalid out-of-range readings are unavailable instead of silently clamped',async()=>{
  const {p,api}=await platform();await p.syncAccessories(state(room(500)));const service=[...p.accessories.values()][0].getService(api.hap.Service.TemperatureSensor);assert.notEqual(service.getCharacteristic(api.hap.Characteristic.CurrentTemperature).statusCode,0);assert.equal(service.getCharacteristic(api.hap.Characteristic.StatusActive).value,false);
});
test('fan missing RPM and flow is unavailable, not an invented stopped fan',async()=>{
  const {p,api}=await platform();await p.syncAccessories(state({}, {pressure:50}));const service=[...p.accessories.values()][0].getService(api.hap.Service.Fanv2);assert.notEqual(service.getCharacteristic(api.hap.Characteristic.Active).statusCode,0);assert.notEqual(service.getCharacteristic(api.hap.Characteristic.RotationSpeed).statusCode,0);
});
test('MQTT room name collisions are separated and unique legacy topics are retained',async()=>{
  const {p}=await platform();const topics=[];p.mqttClient={connected:true,publish(topic){topics.push(topic)}};
  const data=normalizeData({room:{3:{name:'Same',sensor:[{type:'indoor temperature',parameter:{temperature:{value:22}}}]},4:{name:'Same',sensor:[{type:'indoor temperature',parameter:{temperature:{value:23}}}]},5:{name:'Kitchen',sensor:[{type:'indoor temperature',parameter:{temperature:{value:24}}}]}}});
  p.publishAllToMqtt({...state(),baseData:data});assert.ok(topics.includes('home/healthbox/same_33/temperature'));assert.ok(topics.includes('home/healthbox/same_34/temperature'));assert.ok(topics.includes('home/healthbox/kitchen/temperature'));
});
test('malformed boost values and unknown Wi-Fi status are not reported as OFF',async()=>{
  const {p}=await platform();p.safeRequest=async()=>({enable:'false'});assert.equal(await p.fetchRoomBoost('3'),null);assert.equal(p.isWifiConnected({}),null);assert.equal(p.isWifiConnected({status:'disconnected'}),false);
});
test('real MQTT client publishes and completes graceful shutdown against a local protocol simulator',async t=>{
  const net=require('node:net');const mqttPacket=require('mqtt-packet');const packets=[];const sockets=new Set();let closedResolve;const disconnected=new Promise(resolve=>closedResolve=resolve);
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));const parser=mqttPacket.parser();socket.on('data',chunk=>parser.parse(chunk));
    parser.on('packet',packet=>{
      packets.push(packet);
      if(packet.cmd==='connect') socket.write(mqttPacket.generate({cmd:'connack',returnCode:0,sessionPresent:false}));
      if(packet.cmd==='publish'&&packet.qos===1) socket.write(mqttPacket.generate({cmd:'puback',messageId:packet.messageId}));
      if(packet.cmd==='disconnect'){closedResolve();socket.end();}
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {p}=await platform({host:'127.0.0.1',mqttEnabled:true,mqttBroker:`mqtt://127.0.0.1:${server.address().port}`});
  t.after(()=>{p.mqttClient?.end(true);for(const s of sockets)s.destroy();server.close();});
  p.initMqtt();await new Promise((resolve,reject)=>{p.mqttClient.once('connect',resolve);p.mqttClient.once('error',reject);});
  p.mqttShutdown();await disconnected;
  assert.ok(packets.some(packet=>packet.cmd==='publish'&&packet.topic==='home/healthbox/status'&&packet.payload.toString()==='down'));
  assert.equal(packets.at(-1).cmd,'disconnect');
});
test('full HTTP polling and HomeKit Boost command use the same explicit room ID',async t=>{
  const requests=[];let boost=false;
  const server=createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      requests.push({method:req.method,url:req.url,body});res.setHeader('Content-Type','application/json');
      if(req.url==='/v2/api/data/current')return res.end(JSON.stringify({room:[{id:3,name:'Shower',sensor:[{type:'indoor temperature',parameter:{temperature:{value:22}}}]}]}));
      if(req.url==='/v2/device/fan')return res.end(JSON.stringify({rpm:1000}));
      if(req.url==='/v2/device/error')return res.end('[]');
      if(req.url==='/renson_core/v1/wifi/client/status')return res.end(JSON.stringify({status:'connected'}));
      if(req.url==='/v2/api/boost/3'){
        if(req.method==='PUT') boost=JSON.parse(body).enable;
        return res.end(JSON.stringify({enable:boost,level:100,remaining:boost?600:0}));
      }
      res.end('{}');
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {p,api,errors}=await platform({host:`127.0.0.1:${server.address().port}`,enableBoostControl:true});
  t.after(()=>{api.emit('shutdown');server.closeAllConnections();server.close();});await p.initialize();
  const accessory=[...p.accessories.values()].find(a=>a.context.kind==='boost-switch');assert.equal(accessory.context.roomId,'3');
  await accessory.getService(api.hap.Service.Switch).getCharacteristic(api.hap.Characteristic.On).handleSetRequest(true);
  assert.equal(boost,true);assert.ok(requests.some(r=>r.method==='PUT'&&r.url==='/v2/api/boost/3'));assert.deepEqual(errors,[]);
});
