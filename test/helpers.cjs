const { pathToFileURL } = require('node:url');
const path = require('node:path');
const apiModule = import(pathToFileURL(path.join(path.dirname(require.resolve('homebridge')), 'api.js')));
async function platform(config = {}) {
  const { HomebridgeAPI } = await apiModule;
  const api = new HomebridgeAPI();
  const aliases = [];
  api.on('registerPlatform', (...args) => aliases.push(args));
  let Ctor;
  const register = api.registerPlatform.bind(api);
  api.registerPlatform = (...args) => { Ctor = args[1]; register(...args); };
  require('../index')(api);
  const errors = [];
  const log = { info(){}, warn(){}, debug(){}, error(e){ errors.push(e); } };
  return { p: new Ctor(log, config, api), api, aliases, errors };
}
module.exports = { platform };
