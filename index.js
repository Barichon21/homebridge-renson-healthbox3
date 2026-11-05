const { URL } = require("url");
const mqtt = require("mqtt");

const PLUGIN_NAME = "homebridge-renson-healthbox3";
const PLATFORM_ALIASES = ["HealthBoxHomebridgePlugin", "HealthboxPlatform"];

const DEFAULT_NAME = "Renson Healthbox 3";
const DEFAULT_POLL_INTERVAL = 30;
const DEFAULT_REQUEST_TIMEOUT = 10;
const DEFAULT_BOOST_LEVEL = 100;
const DEFAULT_BOOST_DURATION = 600;
const BOOST_LEVEL_MIN = 10;
const BOOST_LEVEL_MAX = 200;
const BOOST_DURATION_MIN = 300;
const BOOST_DURATION_MAX = 86400;

// Tiered polling cadences (ms). The fast loop (every pollInterval) only hits the
// two endpoints that actually change: /v2/api/data/current (all room sensors /
// IAQ / flows / profiles) and /v2/device/fan (central fan). Everything else is
// quasi-static and polled far less often, which cuts ~9 calls/cycle down to ~2.
const STATIC_REFRESH_MS = 30 * 60 * 1000; // firmware + wifi: ~never change
const ERROR_POLL_MS = 5 * 60 * 1000;      // device error list: rare
const BOOST_SWEEP_MS = 60 * 1000;         // sweep all rooms to catch app/manual boosts

// Profile speed positions used by the profile fan accessory.
// eco=33%, health=67%, intense=100% — spans the slider into 3 equal thirds.
const PROFILE_SPEEDS = { eco: 33, health: 67, intense: 100 };

module.exports = (api) => {
  for (const alias of PLATFORM_ALIASES) {
    api.registerPlatform(alias, HealthboxPlatform);
  }
};

class HealthboxPlatform {
  constructor(log, config, api) {
    this.config = config || {};
    this.log = this.wrapLog(log, Boolean(this.config.disableLogging));
    this.api = api;
    this.hap = api.hap;
    this.customTypes = this.createCustomTypes();
    this.accessories = new Map();
    this.boostHandlersAttached = new Set();
    this.profileHandlersAttached = new Set();
    this.accessoriesToForceUpdate = [];
    this.refreshing = false;
    this.pollTimer = null;
    this.stopped = false;
    this.advancedEnabled = false;

    // Tiered-polling state. boostWatch = rooms with an active boost we must poll
    // every cycle; boostCache = last full boost object per room (so idle rooms
    // keep their real level instead of being re-fetched each cycle).
    this.boostWatch = new Set();
    this.boostCache = new Map();
    this.cachedCore = null;
    this.cachedWifi = null;
    this.cachedErrors = [];
    this.lastStaticFetch = 0;
    this.lastErrorPoll = 0;
    this.lastBoostSweep = 0;
    this.platformName = this.config.platform || PLATFORM_ALIASES[0];
    this.mqttClient = null;

    const normalized = this.normalizeConfig(this.config);
    this.name = normalized.name;
    this.baseUrl = normalized.baseUrl;
    this.host = normalized.host;
    this.apiKey = normalized.apiKey;
    this.pollInterval = normalized.pollInterval;
    this.requestTimeout = normalized.requestTimeout;
    this.enableBoostControl = normalized.enableBoostControl;
    this.enableProfileControl = normalized.enableProfileControl;
    this.boostLevel = normalized.boostLevel;
    this.boostDuration = normalized.boostDuration;
    this.roomBoostOverrides = normalized.roomBoostOverrides;
    this.disableLogging = normalized.disableLogging;
    this.mqttEnabled = normalized.mqttEnabled;
    this.mqttBroker = normalized.mqttBroker;
    this.mqttUsername = normalized.mqttUsername;
    this.mqttPassword = normalized.mqttPassword;
    this.mqttTopicPrefix = normalized.mqttTopicPrefix;

    this.api.on("didFinishLaunching", () => {
      if (this.accessoriesToForceUpdate.length > 0) {
        this.api.updatePlatformAccessories(this.accessoriesToForceUpdate);
        this.accessoriesToForceUpdate = [];
      }
      if (!this.baseUrl) return;
      this.log.info(`Starting Healthbox monitoring for ${this.baseUrl}`);
      void this.initialize();
    });

    this.api.on("shutdown", () => {
      this.stopped = true;
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.mqttShutdown();
    });

    if (!this.baseUrl) {
      this.log.warn(
        "No Healthbox host configured. Set host or healthBoxUri to enable the plugin."
      );
    }
  }

  wrapLog(log, disable) {
    if (!disable) {
      return log;
    }
    const noop = () => {};
    return {
      info: noop,
      debug: noop,
      log: noop,
      success: noop,
      warn: (...args) => log.warn(...args),
      error: (...args) => log.error(...args),
    };
  }

  configureAccessory(accessory) {
    // Sanitize the cached display name before HAP validates it.
    // Stale cached accessories may carry emoji names from a previous plugin
    // version or from a Healthbox device that had emoji in its room names.
    // HAP v2 rejects emoji in the Name characteristic, which can prevent the
    // accessory from being visible in HomeKit / Eve.
    const rawName = accessory.displayName;
    const sanitized = this.sanitizeName(rawName);
    let needsCacheFlush = false;
    if (sanitized && sanitized !== rawName) {
      accessory.updateDisplayName(sanitized);
      needsCacheFlush = true;
      this.log.info(
        `Restoring cached accessory (sanitized): ${rawName} → ${sanitized}`
      );
    } else {
      this.log.info(`Restoring cached accessory: ${accessory.displayName}`);
    }
    // Also sanitize service.displayName and the Name characteristic on every
    // cached service. HAP v2's Service constructor validates displayName at
    // deserialization time (Service.js line 379), and the AccessoryInformation
    // service's Name characteristic is validated at publish time.
    for (const service of accessory.services || []) {
      const rawSvcDisplay = service.displayName;
      if (typeof rawSvcDisplay === "string") {
        const sanitizedSvcDisplay = this.sanitizeName(rawSvcDisplay);
        if (sanitizedSvcDisplay && sanitizedSvcDisplay !== rawSvcDisplay) {
          service.displayName = sanitizedSvcDisplay;
          needsCacheFlush = true;
        }
      }
      const nameChar = service.getCharacteristic(
        this.hap.Characteristic.Name
      );
      if (!nameChar) continue;
      const rawServiceName = nameChar.value;
      if (typeof rawServiceName !== "string") continue;
      const sanitizedServiceName = this.sanitizeName(rawServiceName);
      if (sanitizedServiceName !== rawServiceName) {
        nameChar.updateValue(sanitizedServiceName);
        needsCacheFlush = true;
      }
    }
    if (needsCacheFlush) {
      this.accessoriesToForceUpdate.push(accessory);
    }
    accessory.registered = true;
    this.accessories.set(accessory.UUID, accessory);
  }

  normalizeConfig(config) {
    const rawEndpoint = config.healthBoxUri || config.baseUrl || config.host;
    if (!rawEndpoint) {
      return {
        name: config.name || DEFAULT_NAME,
        baseUrl: null,
        host: null,
        apiKey: config.apiKey || null,
        pollInterval: DEFAULT_POLL_INTERVAL,
        requestTimeout: DEFAULT_REQUEST_TIMEOUT,
        enableBoostControl: Boolean(config.enableBoostControl),
        enableProfileControl: Boolean(config.enableProfileControl),
        boostLevel: DEFAULT_BOOST_LEVEL,
        boostDuration: DEFAULT_BOOST_DURATION,
        roomBoostOverrides: this.parseRoomBoostOverrides(config.roomBoostOverrides),
        disableLogging: Boolean(config.disableLogging),
        ...this.normalizeMqttConfig(config),
      };
    }

    let parsed;
    try {
      parsed = rawEndpoint.startsWith("http://") ||
        rawEndpoint.startsWith("https://")
        ? new URL(rawEndpoint)
        : new URL(`http://${rawEndpoint}`);
    } catch (error) {
      this.log.warn(
        `Invalid Healthbox endpoint "${rawEndpoint}": ${
          error.message || error
        }`
      );
      return {
        name: config.name || DEFAULT_NAME,
        baseUrl: null,
        host: null,
        apiKey: config.apiKey || null,
        pollInterval: DEFAULT_POLL_INTERVAL,
        requestTimeout: DEFAULT_REQUEST_TIMEOUT,
        enableBoostControl: Boolean(config.enableBoostControl),
        enableProfileControl: Boolean(config.enableProfileControl),
        boostLevel: DEFAULT_BOOST_LEVEL,
        boostDuration: DEFAULT_BOOST_DURATION,
        roomBoostOverrides: this.parseRoomBoostOverrides(config.roomBoostOverrides),
        disableLogging: Boolean(config.disableLogging),
        ...this.normalizeMqttConfig(config),
      };
    }

    return {
      name: config.name || DEFAULT_NAME,
      baseUrl: parsed.origin,
      host: parsed.host,
      apiKey: config.apiKey || null,
      pollInterval: this.clampInt(
        config.pollInterval,
        5,
        3600,
        DEFAULT_POLL_INTERVAL
      ),
      requestTimeout: this.clampInt(
        config.requestTimeout,
        1,
        120,
        DEFAULT_REQUEST_TIMEOUT
      ),
      enableBoostControl: Boolean(config.enableBoostControl),
      enableProfileControl: Boolean(config.enableProfileControl),
      boostLevel: this.clampInt(
        config.boostFanSpeed ?? config.boostLevel,
        10,
        200,
        DEFAULT_BOOST_LEVEL
      ),
      boostDuration: this.clampInt(
        config.boostDuration ?? config.boostTimeout,
        BOOST_DURATION_MIN,
        BOOST_DURATION_MAX,
        DEFAULT_BOOST_DURATION
      ),
      roomBoostOverrides: this.parseRoomBoostOverrides(config.roomBoostOverrides),
      disableLogging: Boolean(config.disableLogging),
      ...this.normalizeMqttConfig(config),
    };
  }

  normalizeMqttConfig(config) {
    return {
      mqttEnabled: Boolean(config.mqttEnabled),
      mqttBroker: config.mqttBroker || "mqtt://127.0.0.1:1883",
      mqttUsername: config.mqttUsername || null,
      mqttPassword: config.mqttPassword || null,
      mqttTopicPrefix: (config.mqttTopicPrefix || "home/healthbox").replace(/\/$/, ""),
    };
  }

  parseRoomBoostOverrides(rawList) {
    if (!Array.isArray(rawList)) {
      return [];
    }

    const overrides = [];
    for (const entry of rawList) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const room = this.truthyString(entry.room);
      if (!room) {
        continue;
      }

      const level =
        entry.boostLevel === undefined || entry.boostLevel === null
          ? null
          : this.clampInt(
              entry.boostLevel,
              BOOST_LEVEL_MIN,
              BOOST_LEVEL_MAX,
              DEFAULT_BOOST_LEVEL
            );

      const duration =
        entry.boostDuration === undefined || entry.boostDuration === null
          ? null
          : this.clampInt(
              entry.boostDuration,
              BOOST_DURATION_MIN,
              BOOST_DURATION_MAX,
              DEFAULT_BOOST_DURATION
            );

      if (level === null && duration === null) {
        continue;
      }

      overrides.push({
        match: room,
        matchLower: room.toLowerCase(),
        level,
        duration,
      });
    }

    return overrides;
  }

  getRoomBoostConfig(roomId, roomName) {
    const idStr = roomId !== undefined && roomId !== null ? String(roomId) : "";
    const nameLower =
      typeof roomName === "string" ? roomName.toLowerCase() : "";

    let level = this.boostLevel;
    let duration = this.boostDuration;

    for (const override of this.roomBoostOverrides || []) {
      if (override.match === idStr || override.matchLower === nameLower) {
        if (override.level !== null) {
          level = override.level;
        }
        if (override.duration !== null) {
          duration = override.duration;
        }
        break;
      }
    }

    return { level, duration };
  }

  // ---------------------------------------------------------------------------
  // Custom HAP types
  //
  // Three purpose-specific metrics services replace the old monolithic
  // HealthboxMetricsService (D6E00001). Splitting them avoids showing 0.0 for
  // characteristics that don't apply to a given accessory type (e.g. FanPower
  // on a room-ventilation accessory).
  //
  // UUID map:
  //   D6E00001 — OLD monolithic service (cleaned up on first run after upgrade)
  //   D6E00021 — HealthboxAirMetricsService  (AQI + VOC)
  //   D6E00022 — HealthboxVentMetricsService (FlowRate, NominalFlowRate, VentilationRate)
  //   D6E00023 — HealthboxFanMetricsService  (FlowRate, FanPressure, FanPower, FanRpm, FanVoltage)
  //
  // Characteristic UUIDs (D6E000xx) are unchanged.
  // ---------------------------------------------------------------------------
  createCustomTypes() {
    const { Characteristic, Service, Formats, Perms } = this.hap;

    // UUID of the legacy monolithic service — used only for migration cleanup.
    const OLD_METRICS_SERVICE_UUID = "D6E00001-8C61-4E84-BE8C-0E9E23D5A001";

    const createFloatCharacteristic = ({
      displayName,
      uuid,
      minValue = 0,
      maxValue = 100000,
      minStep = 0.1,
    }) =>
      class extends Characteristic {
        static UUID = uuid;

        constructor() {
          super(displayName, uuid, {
            format: Formats.FLOAT,
            perms: [Perms.NOTIFY, Perms.PAIRED_READ],
            minValue,
            maxValue,
            minStep,
          });
          this.value = this.getDefaultValue();
        }
      };

    const AirQualityIndex = createFloatCharacteristic({
      displayName: "Air Quality Index",
      uuid: "D6E00010-8C61-4E84-BE8C-0E9E23D5A001",
      maxValue: 1000,
      minStep: 0.01,
    });

    const VocLevelPpm = createFloatCharacteristic({
      displayName: "VOC Level (ppm)",
      uuid: "D6E00011-8C61-4E84-BE8C-0E9E23D5A001",
      maxValue: 1000000,
      minStep: 0.01,
    });

    const FlowRate = createFloatCharacteristic({
      displayName: "Flow Rate (m3/h)",
      uuid: "D6E00012-8C61-4E84-BE8C-0E9E23D5A001",
      maxValue: 10000,
      minStep: 0.01,
    });

    const NominalFlowRate = createFloatCharacteristic({
      displayName: "Nominal Flow Rate (m3/h)",
      uuid: "D6E00013-8C61-4E84-BE8C-0E9E23D5A001",
      maxValue: 10000,
      minStep: 0.01,
    });

    const VentilationRate = createFloatCharacteristic({
      displayName: "Ventilation Rate (%)",
      uuid: "D6E00014-8C61-4E84-BE8C-0E9E23D5A001",
      maxValue: 200,
      minStep: 0.1,
    });

    const FanPressure = createFloatCharacteristic({
      displayName: "Fan Pressure (Pa)",
      uuid: "D6E00015-8C61-4E84-BE8C-0E9E23D5A001",
      maxValue: 10000,
      minStep: 0.01,
    });

    const FanPower = createFloatCharacteristic({
      displayName: "Fan Power (W)",
      uuid: "D6E00016-8C61-4E84-BE8C-0E9E23D5A001",
      maxValue: 10000,
      minStep: 0.01,
    });

    const FanRpm = createFloatCharacteristic({
      displayName: "Fan RPM",
      uuid: "D6E00017-8C61-4E84-BE8C-0E9E23D5A001",
      maxValue: 100000,
      minStep: 1,
    });

    const FanVoltage = createFloatCharacteristic({
      displayName: "Fan Voltage (V)",
      uuid: "D6E00018-8C61-4E84-BE8C-0E9E23D5A001",
      maxValue: 1000,
      minStep: 0.01,
    });

    // Air quality metrics: AQI + VOC — used by global AQ and room AQ accessories.
    class HealthboxAirMetricsService extends Service {
      static UUID = "D6E00021-8C61-4E84-BE8C-0E9E23D5A001";

      constructor(displayName, subtype) {
        super(displayName, HealthboxAirMetricsService.UUID, subtype);
        this.addCharacteristic(AirQualityIndex);
        this.addCharacteristic(VocLevelPpm);
      }
    }

    // Ventilation metrics: flow rates — used by room ventilation accessories.
    class HealthboxVentMetricsService extends Service {
      static UUID = "D6E00022-8C61-4E84-BE8C-0E9E23D5A001";

      constructor(displayName, subtype) {
        super(displayName, HealthboxVentMetricsService.UUID, subtype);
        this.addCharacteristic(FlowRate);
        this.addCharacteristic(NominalFlowRate);
        this.addCharacteristic(VentilationRate);
      }
    }

    // Fan hardware metrics: electrical + flow — used only by the global fan accessory.
    class HealthboxFanMetricsService extends Service {
      static UUID = "D6E00023-8C61-4E84-BE8C-0E9E23D5A001";

      constructor(displayName, subtype) {
        super(displayName, HealthboxFanMetricsService.UUID, subtype);
        this.addCharacteristic(FlowRate);
        this.addCharacteristic(FanPressure);
        this.addCharacteristic(FanPower);
        this.addCharacteristic(FanRpm);
        this.addCharacteristic(FanVoltage);
      }
    }

    return {
      OLD_METRICS_SERVICE_UUID,
      AirQualityIndex,
      VocLevelPpm,
      FlowRate,
      NominalFlowRate,
      VentilationRate,
      FanPressure,
      FanPower,
      FanRpm,
      FanVoltage,
      HealthboxAirMetricsService,
      HealthboxVentMetricsService,
      HealthboxFanMetricsService,
    };
  }

  clampInt(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Math.round(number)));
  }

  numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  clampNumber(value, min, max) {
    const number = this.numberOrNull(value);
    if (number === null) {
      return null;
    }

    return Math.min(max, Math.max(min, number));
  }

  truthyString(value) {
    if (value === undefined || value === null) {
      return null;
    }

    const text = String(value).trim();
    return text ? text : null;
  }

  slugify(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
  }

  // HAP v2 rejects accessory/service Name characteristics that contain emojis
  // or non-alphanumeric characters (except spaces and apostrophes). Strip them
  // so room names from the Healthbox API (which can include emoji) don't
  // prevent accessories from being registered in HomeKit.
  sanitizeName(value) {
    return String(value || "")
      // Extended_Pictographic covers all actual emoji glyphs without matching
      // ASCII chars (unlike \p{Emoji} which matches digits/# too).
      .replace(/\p{Extended_Pictographic}/gu, "")
      // Remove ZWJ (U+200D), variation selectors (U+FE0E/FE0F), combining
      // enclosing keycap (U+20E3), and tags block used in flag sequences.
      .replace(/[‍︎️⃣\u{E0000}-\u{E007F}]/gu, "")
      // Collapse leftover whitespace gaps.
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // -------------------------------------------------------------------------
  // MQTT
  // -------------------------------------------------------------------------

  initMqtt() {
    if (!this.mqttEnabled) return;

    const opts = {
      clientId: `homebridge-healthbox-${(this.host || "unknown").replace(/[^a-z0-9]/gi, "-")}`,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      will: {
        topic: `${this.mqttTopicPrefix}/status`,
        payload: "down",
        retain: true,
        qos: 1,
      },
    };
    if (this.mqttUsername) opts.username = this.mqttUsername;
    if (this.mqttPassword) opts.password = this.mqttPassword;

    this.mqttClient = mqtt.connect(this.mqttBroker, opts);

    this.mqttClient.on("connect", () => {
      this.log.info(`MQTT connecté à ${this.mqttBroker} (préfixe: ${this.mqttTopicPrefix})`);
      this.mqttClient.publish(`${this.mqttTopicPrefix}/status`, "up", { retain: true, qos: 1 });
    });

    this.mqttClient.on("error", (err) => {
      this.log.warn(`MQTT erreur : ${err.message || err}`);
    });

    this.mqttClient.on("offline", () => {
      this.log.debug("MQTT client hors ligne");
    });

    this.mqttClient.on("reconnect", () => {
      this.log.debug("MQTT reconnexion en cours…");
    });
  }

  mqttShutdown() {
    if (!this.mqttClient) return;
    try {
      this.mqttClient.publish(`${this.mqttTopicPrefix}/status`, "down", { retain: true, qos: 1 });
      this.mqttClient.end(true);
    } catch (_) {
      // best-effort
    }
    this.mqttClient = null;
  }

  // Slug pour les topics MQTT : underscores, minuscules.
  // Convention identique à l'ancien healthbox2mqtt.js :
  //   "WC Bas" → "wc_bas", "SDB Haut" → "sdb_haut"
  mqttSlug(name) {
    return String(name || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }

  mqttPub(topic, value) {
    if (!this.mqttClient || !this.mqttClient.connected) return;
    if (value === null || value === undefined) return;
    let payload;
    if (typeof value === "boolean") {
      payload = value ? "true" : "false";
    } else if (typeof value === "number") {
      // Round to 2 decimal places, strip trailing zeros
      payload = parseFloat(value.toFixed(2)).toString();
    } else {
      payload = String(value);
    }
    this.mqttClient.publish(`${this.mqttTopicPrefix}/${topic}`, payload, { retain: true });
  }

  publishAllToMqtt(state) {
    if (!this.mqttClient || !this.mqttClient.connected) return;

    // ── Ventilateur global ──────────────────────────────────────────────
    if (state.fan) {
      const flow = this.numberOrNull(
        state.fan.flow ?? state.fan.flow_rate ?? state.fan.airflow
      );
      const rpm = this.numberOrNull(
        state.fan.rpm ?? state.fan.rotation_speed ?? state.fan.speed
      );
      const pressure = this.numberOrNull(
        state.fan.pressure ?? state.fan.fan_pressure ?? state.fan.static_pressure
      );
      const power = this.numberOrNull(
        state.fan.power ?? state.fan.fan_power ?? state.fan.consumption ?? state.fan.watt
      );
      const voltage = this.numberOrNull(
        state.fan.voltage ?? state.fan.fan_voltage ?? state.fan.volt
      );

      this.mqttPub("fan/flow_rate", flow);
      this.mqttPub("fan/pressure",  pressure);
      this.mqttPub("fan/power",     power);
      this.mqttPub("fan/rpm",       rpm);
      this.mqttPub("fan/voltage",   voltage);
    }

    // ── Qualité d'air globale ───────────────────────────────────────────
    for (const sensor of state.baseData.sensor || []) {
      if (sensor.type === "global air quality index") {
        const aqi = this.numberOrNull(
          sensor.parameter && sensor.parameter.index && sensor.parameter.index.value
        );
        this.mqttPub("air_quality/index", aqi);
        break;
      }
    }

    // ── Connectivité Wi-Fi ──────────────────────────────────────────────
    if (state.wifi) {
      const connected = this.isWifiConnected(state.wifi);
      if (connected !== null) {
        this.mqttPub("connectivity/wifi", connected ? "connected" : "disconnected");
      }
    }

    // ── Pièces ──────────────────────────────────────────────────────────
    // Topics publiés sous home/healthbox/<slug>/<metric> (4 niveaux)
    // pour être consommés par Telegraf (home/healthbox/+/+).
    // Noms de métriques alignés sur l'ancien healthbox2mqtt.js :
    //   concentration (pas co2), index (pas aqi),
    //   boost_enable ON|OFF, boost_remaining (pas boost/remaining).
    for (const [roomId, roomData] of Object.entries(state.baseData.room || {})) {
      const roomName =
        this.sanitizeName(this.truthyString(roomData.name) || `Room ${roomId}`) ||
        `Room ${roomId}`;
      const sensors = Array.isArray(roomData.sensor) ? roomData.sensor : [];
      const p = this.mqttSlug(roomName);  // ex. "SDB Haut" → "sdb_haut"

      // Capteurs environnementaux
      const temp = this.extractSensorValue(sensors, "indoor temperature", "temperature");
      this.mqttPub(`${p}/temperature`, temp);

      const hum = this.extractSensorValue(sensors, "indoor relative humidity", "humidity");
      this.mqttPub(`${p}/humidity`, hum);

      const co2 = this.extractSensorValue(sensors, "indoor CO2", "concentration");
      this.mqttPub(`${p}/concentration`, co2);  // Telegraf attend "concentration"

      const aqi = this.extractSensorValue(sensors, "indoor air quality index", "index");
      this.mqttPub(`${p}/index`, aqi);           // Telegraf attend "index"

      const vocMetric = this.extractSensorMetric(sensors, "indoor volatile organic compounds", [
        "voc_calc_embedded", "concentration", "total_filtered",
        "smooth_voc", "logic_filtered", "raw",
      ]);
      if (vocMetric) this.mqttPub(`${p}/voc`, vocMetric.value);

      // Ventilation
      const ventMetrics = this.extractRoomVentilationMetrics(roomData);
      if (ventMetrics) {
        this.mqttPub(`${p}/flow_rate`,         ventMetrics.flowRate);
        this.mqttPub(`${p}/nominal_flow_rate`, ventMetrics.nominal);
        this.mqttPub(`${p}/ventilation_rate`,
          Math.round(ventMetrics.ventilationRate * 1000) / 10  // → % arrondi à 0.1
        );
      }

      // Profil
      if (roomData.profile_name) {
        this.mqttPub(`${p}/profile`, roomData.profile_name);
      }

      // Boost — noms de métriques compatibles Telegraf
      const boost = state.boosts.get(roomId);
      if (boost) {
        this.mqttPub(`${p}/boost_enable`,    boost.enabled ? "ON" : "OFF");
        this.mqttPub(`${p}/boost_level`,     boost.level);
        this.mqttPub(`${p}/boost_remaining`, boost.remaining);
      }
    }
  }

  async initialize() {
    if (this.stopped) return;
    this.initMqtt();
    this.advancedEnabled = await this.enableAdvancedApiIfNeeded();
    if (this.stopped) return;
    await this.refreshData();
    if (this.stopped) return;

    this.pollTimer = setInterval(() => {
      void this.refreshData();
    }, this.pollInterval * 1000);
  }

  async requestJson(method, endpoint, options = {}) {
    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    };
    let body;

    if (options.data !== undefined) {
      if (
        typeof options.data === "string" ||
        options.data instanceof String ||
        options.data instanceof Buffer
      ) {
        body = options.data;
      } else {
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
        body = JSON.stringify(options.data);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.requestTimeout * 1000
    );

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const payload = await response.text();
      return payload ? JSON.parse(payload) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async safeRequest(method, endpoint, options = {}) {
    try {
      return await this.requestJson(method, endpoint, options);
    } catch (error) {
      this.log.debug(
        `Request failed for ${endpoint}: ${error.message || String(error)}`
      );
      return null;
    }
  }

  async enableAdvancedApiIfNeeded() {
    if (!this.apiKey) {
      return false;
    }

    const statusValid = async () => {
      try {
        const status = await this.requestJson("GET", "/v2/api/api_key/status");
        return status && status.state === "valid";
      } catch (error) {
        this.log.debug(
          `Unable to verify advanced API status: ${error.message || error}`
        );
        return false;
      }
    };

    if (await statusValid()) {
      this.log.info("Advanced API already enabled.");
      return true;
    }

    try {
      await this.requestJson("POST", "/v2/api/api_key", {
        data: JSON.stringify(this.apiKey),
        headers: {
          "Content-Type": "application/json",
        },
      });
      this.log.info("API key sent, waiting for validation...");
      await this.sleep(10000);
    } catch (error) {
      this.log.warn(`Failed to enable advanced API: ${error.message || error}`);
      return false;
    }

    if (await statusValid()) {
      this.log.info("Advanced API enabled.");
      return true;
    }

    this.log.warn("Advanced API key was not validated.");
    return false;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  extractSensorMetric(sensors, sensorType, parameterKeys) {
    const keys = Array.isArray(parameterKeys) ? parameterKeys : [parameterKeys];

    for (const sensor of sensors || []) {
      if (!(sensor.type || "").includes(sensorType)) {
        continue;
      }

      const parameter = sensor.parameter || {};
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(parameter, key)) {
          continue;
        }

        const value = this.numberOrNull(parameter[key] && parameter[key].value);
        if (value === null) {
          continue;
        }

        return {
          key,
          value,
          unit: this.truthyString(parameter[key] && parameter[key].unit),
        };
      }
    }

    return null;
  }

  extractSensorValue(sensors, sensorType, parameterKey) {
    const metric = this.extractSensorMetric(sensors, sensorType, parameterKey);
    return metric ? metric.value : null;
  }

  extractRoomVentilationMetrics(roomData) {
    const params = roomData && roomData.parameter ? roomData.parameter : {};
    const nominal = this.numberOrNull(params.nominal && params.nominal.value);
    if (nominal === null) {
      return null;
    }

    const offset = this.numberOrNull(params.offset && params.offset.value) || 0;
    const actuators = Array.isArray(roomData.actuator) ? roomData.actuator : [];
    const valve = actuators.find((actuator) => actuator.type === "air valve");
    if (!valve) {
      return null;
    }

    const flowRate = this.numberOrNull(
      valve.parameter &&
        valve.parameter.flow_rate &&
        valve.parameter.flow_rate.value
    );

    const denominator = nominal + offset;
    if (flowRate === null || !denominator) {
      return null;
    }

    return {
      flowRate,
      nominal,
      offset,
      ventilationRate: flowRate / denominator,
    };
  }

  computeAirflowRate(roomData) {
    const metrics = this.extractRoomVentilationMetrics(roomData);
    return metrics ? metrics.ventilationRate : null;
  }

  async fetchRoomBoost(roomId) {
    const data = await this.safeRequest("GET", `/v2/api/boost/${roomId}`);
    if (!data) {
      return null;
    }

    return {
      level: this.numberOrNull(data.level),
      enabled: Boolean(data.enable),
      remaining: this.numberOrNull(data.remaining) || 0,
    };
  }

  async setRoomBoost(roomId, enabled, levelOverride, durationOverride) {
    const payload = enabled
      ? {
          enable: true,
          level: this.clampInt(
            levelOverride,
            BOOST_LEVEL_MIN,
            BOOST_LEVEL_MAX,
            this.boostLevel
          ),
          timeout: this.clampInt(
            durationOverride,
            BOOST_DURATION_MIN,
            BOOST_DURATION_MAX,
            this.boostDuration
          ),
        }
      : { enable: false };

    await this.requestJson("PUT", `/v2/api/boost/${roomId}`, {
      data: payload,
      headers: { "Content-Type": "application/json" },
    });
  }

  // API documented: PUT /v2/api/data/current/room/{room_id}/profile_name
  // Accepted values: "eco", "health", "intense"
  async setRoomProfile(roomId, profileName) {
    await this.requestJson(
      "PUT",
      `/v2/api/data/current/room/${roomId}/profile_name`,
      {
        data: JSON.stringify(profileName),
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  profileFromSpeed(speed) {
    const s = Number(speed);
    if (s <= 33) return "eco";
    if (s <= 67) return "health";
    return "intense";
  }

  speedFromProfile(name) {
    return PROFILE_SPEEDS[name] ?? 67; // default to health
  }

  mapAirQualityIndex(value) {
    const { AirQuality } = this.hap.Characteristic;
    const number = this.numberOrNull(value);

    if (number === null) {
      return AirQuality.UNKNOWN;
    }

    if (number <= 5) {
      if (number <= 1) {
        return AirQuality.EXCELLENT;
      }
      if (number <= 2) {
        return AirQuality.GOOD;
      }
      if (number <= 3) {
        return AirQuality.FAIR;
      }
      if (number <= 4) {
        return AirQuality.INFERIOR;
      }

      return AirQuality.POOR;
    }

    if (number <= 20) {
      return AirQuality.EXCELLENT;
    }
    if (number <= 40) {
      return AirQuality.GOOD;
    }
    if (number <= 60) {
      return AirQuality.FAIR;
    }
    if (number <= 80) {
      return AirQuality.INFERIOR;
    }

    return AirQuality.POOR;
  }

  normalizeVocDensity(value) {
    const density = this.clampNumber(value, 0, 1000);
    return density === null ? null : Math.round(density);
  }

  // -------------------------------------------------------------------------
  // Metrics service helpers
  //
  // Each helper removes the legacy D6E00001 monolithic service (if present on
  // the accessory from a previous plugin version) before returning the
  // appropriate purpose-specific service.
  // -------------------------------------------------------------------------

  removeOldMetricsService(accessory, subtype) {
    const { OLD_METRICS_SERVICE_UUID } = this.customTypes;
    for (const svc of accessory.services) {
      if (svc.UUID === OLD_METRICS_SERVICE_UUID && svc.subtype === subtype) {
        accessory.removeService(svc);
        this.log.debug(
          `Removed legacy HealthboxMetricsService (${subtype}) from ${accessory.displayName}`
        );
        break;
      }
    }
  }

  getAirMetricsService(accessory, name, subtype) {
    this.removeOldMetricsService(accessory, subtype);
    return (
      accessory.getServiceById(
        this.customTypes.HealthboxAirMetricsService,
        subtype
      ) ||
      accessory.addService(
        this.customTypes.HealthboxAirMetricsService,
        name,
        subtype
      )
    );
  }

  getVentMetricsService(accessory, name, subtype) {
    this.removeOldMetricsService(accessory, subtype);
    return (
      accessory.getServiceById(
        this.customTypes.HealthboxVentMetricsService,
        subtype
      ) ||
      accessory.addService(
        this.customTypes.HealthboxVentMetricsService,
        name,
        subtype
      )
    );
  }

  getFanMetricsService(accessory, name, subtype) {
    this.removeOldMetricsService(accessory, subtype);
    return (
      accessory.getServiceById(
        this.customTypes.HealthboxFanMetricsService,
        subtype
      ) ||
      accessory.addService(
        this.customTypes.HealthboxFanMetricsService,
        name,
        subtype
      )
    );
  }

  updateMetricsCharacteristic(service, characteristicType, value) {
    if (value === null || value === undefined) {
      return;
    }

    service.updateCharacteristic(characteristicType, Number(value));
  }

  isWifiConnected(wifi) {
    if (!wifi) {
      return null;
    }

    return (
      wifi.status === "connected" ||
      wifi.internet_connection === "connected" ||
      wifi.internet_connection === true
    );
  }

  getInfoValue(source, candidates) {
    if (!source || typeof source !== "object") {
      return null;
    }

    for (const candidate of candidates) {
      if (Object.prototype.hasOwnProperty.call(source, candidate)) {
        const value = this.truthyString(source[candidate]);
        if (value) {
          return value;
        }
      }
    }

    return null;
  }

  getGlobalMetadata(baseData, coreData) {
    const mainPollutant = Array.isArray(baseData.sensor)
      ? baseData.sensor.find(
          (sensor) => sensor.type === "global air quality index"
        )
      : null;

    const mainPollutantName = this.truthyString(
      mainPollutant &&
        mainPollutant.parameter &&
        mainPollutant.parameter.main_pollutant &&
        mainPollutant.parameter.main_pollutant.value
    );

    const mainPollutantRoom = this.truthyString(
      mainPollutant &&
        mainPollutant.parameter &&
        mainPollutant.parameter.room &&
        mainPollutant.parameter.room.value
    );

    // Serial and warranty_number are top-level fields in /v2/api/data/current
    // (documented in the Renson local-API PDF). Use them as primary source;
    // fall back to the renson_core endpoint which may not be present on all
    // firmware versions.
    const serialNumber =
      this.truthyString(baseData.serial) ||
      this.getInfoValue(coreData, [
        "serial number",
        "serial_number",
        "serial",
      ]) ||
      this.host;

    const warrantyNumber =
      this.truthyString(baseData.warranty_number) ||
      this.getInfoValue(coreData, [
        "warranty number",
        "warranty_number",
        "warranty",
      ]);

    const firmwareRevision =
      this.getInfoValue(coreData, [
        "firmware version",
        "firmware_version",
        "firmware",
      ]) || "Unknown";

    return {
      serialNumber,
      warrantyNumber,
      firmwareRevision,
      mainPollutantName,
      mainPollutantRoom,
    };
  }

  async refreshData() {
    if (this.stopped || this.refreshing) {
      return;
    }

    this.refreshing = true;

    try {
      const now = Date.now();

      // --- Fast loop: the only two endpoints whose data actually changes ---
      const baseData = await this.requestJson("GET", "/v2/api/data/current");
      const roomIds = Object.keys(baseData.room || {});
      const fan = await this.safeRequest("GET", "/v2/device/fan");

      // --- Quasi-static: firmware + wifi (once, then every STATIC_REFRESH_MS) ---
      if (now - this.lastStaticFetch >= STATIC_REFRESH_MS) {
        const [coreData, wifi] = await Promise.all([
          this.safeRequest("GET", "/renson_core/v2/global"),
          this.safeRequest("GET", "/renson_core/v1/wifi/client/status"),
        ]);
        if (coreData) this.cachedCore = coreData;
        if (wifi) this.cachedWifi = wifi;
        this.lastStaticFetch = now;
      }

      // --- Error list: every ERROR_POLL_MS ---
      if (now - this.lastErrorPoll >= ERROR_POLL_MS) {
        const errors = await this.safeRequest("GET", "/v2/device/error");
        this.cachedErrors = Array.isArray(errors) ? errors : [];
        this.lastErrorPoll = now;
      }

      // --- Boost: sweep all rooms periodically, else only active ones ---
      await this.refreshBoosts(roomIds, now);

      await this.syncAccessories({
        baseData,
        fan,
        wifi: this.cachedWifi,
        errors: this.cachedErrors,
        coreData: this.cachedCore,
        boosts: this.collectBoosts(roomIds),
      });
    } catch (error) {
      this.log.error(`Failed to refresh data: ${error.message || error}`);
    } finally {
      this.refreshing = false;
    }
  }

  // Poll boost endpoints intelligently. A full sweep (all rooms) runs at most
  // every BOOST_SWEEP_MS to catch boosts started from the Renson app or the
  // physical button; between sweeps we only poll rooms we know are boosting.
  async refreshBoosts(roomIds, now) {
    const sweepDue = now - this.lastBoostSweep >= BOOST_SWEEP_MS;
    const targets = sweepDue ? roomIds : [...this.boostWatch];

    if (sweepDue) {
      this.lastBoostSweep = now;
    }
    if (targets.length === 0) {
      return;
    }

    await Promise.all(
      targets.map(async (roomId) => {
        const boost = await this.fetchRoomBoost(roomId);
        if (boost) {
          this.boostCache.set(roomId, boost);
          this.updateBoostWatch(roomId, boost);
        }
      })
    );
  }

  // Keep/drop a room in the active-boost watch set from its latest reading.
  updateBoostWatch(roomId, boost) {
    const active =
      boost &&
      (boost.enabled === true ||
        (typeof boost.remaining === "number" && boost.remaining > 0));
    if (active) {
      this.boostWatch.add(roomId);
    } else {
      this.boostWatch.delete(roomId);
    }
  }

  // Build the per-room boost map syncAccessories expects, from cache. A room with
  // no reading yet (before the first sweep) falls back to an inactive placeholder.
  collectBoosts(roomIds) {
    const boosts = new Map();
    for (const roomId of roomIds) {
      boosts.set(
        roomId,
        this.boostCache.get(roomId) || {
          level: null,
          enabled: false,
          remaining: 0,
        }
      );
    }
    return boosts;
  }

  async syncAccessories(state) {
    const activeUuids = new Set();
    const metadata = this.getGlobalMetadata(state.baseData, state.coreData);

    this.syncGlobalAirQualityAccessory(state, metadata, activeUuids);
    this.syncGlobalFanAccessory(state, metadata, activeUuids);
    this.syncConnectivityAccessory(state, metadata, activeUuids);
    await this.syncRoomAccessories(state, metadata, activeUuids);
    this.removeStaleAccessories(activeUuids);
    this.publishAllToMqtt(state);
  }

  syncGlobalAirQualityAccessory(state, metadata, activeUuids) {
    let aqiValue = null;
    for (const sensor of state.baseData.sensor || []) {
      if (sensor.type === "global air quality index") {
        aqiValue = this.numberOrNull(
          sensor.parameter && sensor.parameter.index && sensor.parameter.index.value
        );
        break;
      }
    }

    if (aqiValue === null) {
      return;
    }

    const name = `${this.name} Air Quality`;
    const accessory = this.prepareAccessory({
      uuidSeed: "global-air-quality",
      name,
      category: this.hap.Categories.AIR_PURIFIER,
      context: {
        kind: "global-air-quality",
      },
    });

    const service =
      accessory.getService(this.hap.Service.AirQualitySensor) ||
      accessory.addService(this.hap.Service.AirQualitySensor, name);

    service.updateCharacteristic(
      this.hap.Characteristic.AirQuality,
      this.mapAirQualityIndex(aqiValue)
    );
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, true);
    service.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      state.errors.length
        ? this.hap.Characteristic.StatusFault.GENERAL_FAULT
        : this.hap.Characteristic.StatusFault.NO_FAULT
    );

    const metricsService = this.getAirMetricsService(
      accessory,
      `${name} Metrics`,
      "global-air-quality"
    );
    this.updateMetricsCharacteristic(
      metricsService,
      this.customTypes.AirQualityIndex,
      aqiValue
    );

    this.applyAccessoryInformation(accessory, {
      serialNumber: metadata.serialNumber,
      firmwareRevision: metadata.firmwareRevision,
      model:
        metadata.mainPollutantName && metadata.mainPollutantRoom
          ? `AQI: ${metadata.mainPollutantName} in ${metadata.mainPollutantRoom}`
          : "Global Air Quality Sensor",
      manufacturer: "Renson",
    });

    this.finalizeAccessory(accessory, activeUuids);
  }

  syncGlobalFanAccessory(state, metadata, activeUuids) {
    if (!state.fan) {
      return;
    }

    // Log the raw fan payload at debug level so field names can be verified.
    // Fan endpoint (/v2/device/fan) is not documented in the Renson API PDF;
    // this makes it easy to diagnose unexpected field names.
    this.log.debug(`Fan raw data: ${JSON.stringify(state.fan)}`);

    const name = `${this.name} Fan`;
    const accessory = this.prepareAccessory({
      uuidSeed: "global-fan",
      name,
      category: this.hap.Categories.FAN,
      context: {
        kind: "global-fan",
      },
    });

    const service =
      accessory.getService(this.hap.Service.Fanv2) ||
      accessory.addService(this.hap.Service.Fanv2, name);

    // Try multiple field-name variants for each metric.
    // The /v2/device/fan endpoint is undocumented; field names may vary
    // across firmware versions. The first non-null value wins.
    const flow =
      this.numberOrNull(
        state.fan.flow ?? state.fan.flow_rate ?? state.fan.airflow
      ) || 0;

    const rpm =
      this.numberOrNull(
        state.fan.rpm ?? state.fan.rotation_speed ?? state.fan.speed
      ) || 0;

    const pressure = this.numberOrNull(
      state.fan.pressure ?? state.fan.fan_pressure ?? state.fan.static_pressure
    );

    const power = this.numberOrNull(
      state.fan.power ?? state.fan.fan_power ?? state.fan.consumption ?? state.fan.watt
    );

    const voltage = this.numberOrNull(
      state.fan.voltage ?? state.fan.fan_voltage ?? state.fan.volt
    );

    const active = flow > 0 || rpm > 0;

    this.attachReadOnlyFanHandlers(accessory, service);

    service.updateCharacteristic(
      this.hap.Characteristic.Active,
      active
        ? this.hap.Characteristic.Active.ACTIVE
        : this.hap.Characteristic.Active.INACTIVE
    );
    service.updateCharacteristic(
      this.hap.Characteristic.CurrentFanState,
      active
        ? this.hap.Characteristic.CurrentFanState.BLOWING_AIR
        : this.hap.Characteristic.CurrentFanState.IDLE
    );
    service.updateCharacteristic(
      this.hap.Characteristic.RotationSpeed,
      Math.min(100, Math.max(0, Math.round(rpm / 20)))
    );
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, true);
    service.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      state.errors.length
        ? this.hap.Characteristic.StatusFault.GENERAL_FAULT
        : this.hap.Characteristic.StatusFault.NO_FAULT
    );

    const metricsService = this.getFanMetricsService(
      accessory,
      `${name} Metrics`,
      "global-fan"
    );
    this.updateMetricsCharacteristic(metricsService, this.customTypes.FlowRate, flow);
    this.updateMetricsCharacteristic(metricsService, this.customTypes.FanPressure, pressure);
    this.updateMetricsCharacteristic(metricsService, this.customTypes.FanPower, power);
    this.updateMetricsCharacteristic(metricsService, this.customTypes.FanRpm, rpm);
    this.updateMetricsCharacteristic(metricsService, this.customTypes.FanVoltage, voltage);

    this.applyAccessoryInformation(accessory, {
      serialNumber: metadata.serialNumber,
      firmwareRevision: metadata.firmwareRevision,
      model: "Ventilation Fan",
      manufacturer: "Renson",
    });

    this.finalizeAccessory(accessory, activeUuids);
  }

  syncConnectivityAccessory(state, metadata, activeUuids) {
    if (!state.wifi) {
      return;
    }

    const connected = this.isWifiConnected(state.wifi);
    if (connected === null) {
      return;
    }

    const name = `${this.name} Connectivity`;
    const accessory = this.prepareAccessory({
      uuidSeed: "global-connectivity",
      name,
      category: this.hap.Categories.SENSOR,
      context: {
        kind: "global-connectivity",
      },
    });

    const service =
      accessory.getService(this.hap.Service.ContactSensor) ||
      accessory.addService(this.hap.Service.ContactSensor, name);

    service.updateCharacteristic(
      this.hap.Characteristic.ContactSensorState,
      connected
        ? this.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
        : this.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
    );
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, true);
    service.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      connected
        ? this.hap.Characteristic.StatusFault.NO_FAULT
        : this.hap.Characteristic.StatusFault.GENERAL_FAULT
    );

    this.applyAccessoryInformation(accessory, {
      serialNumber: metadata.serialNumber,
      firmwareRevision: metadata.firmwareRevision,
      model: this.truthyString(state.wifi.ssid) || "Connectivity Sensor",
      manufacturer: "Renson",
    });

    this.finalizeAccessory(accessory, activeUuids);
  }

  async syncRoomAccessories(state, metadata, activeUuids) {
    for (const [roomId, roomData] of Object.entries(state.baseData.room || {})) {
      // Sanitize the room name: the Healthbox API can return names that contain
      // emoji (e.g. "WC 🚽"), which HAP v2 rejects as invalid Name characteristics.
      const roomName =
        this.sanitizeName(this.truthyString(roomData.name) || `Room ${roomId}`) ||
        `Room ${roomId}`;
      const roomMeta = {
        roomId,
        roomName,
        profileName: this.truthyString(roomData.profile_name),
        roomType: this.truthyString(roomData.type),
        serialRoot: metadata.serialNumber,
      };
      const sensors = Array.isArray(roomData.sensor) ? roomData.sensor : [];

      const temperature = this.extractSensorValue(
        sensors,
        "indoor temperature",
        "temperature"
      );
      if (temperature !== null) {
        this.syncTemperatureAccessory(roomMeta, temperature, activeUuids);
      }

      const humidity = this.extractSensorValue(
        sensors,
        "indoor relative humidity",
        "humidity"
      );
      if (humidity !== null) {
        this.syncHumidityAccessory(roomMeta, humidity, activeUuids);
      }

      const co2 = this.extractSensorValue(
        sensors,
        "indoor CO2",
        "concentration"
      );
      if (co2 !== null) {
        this.syncCo2Accessory(roomMeta, co2, activeUuids);
      }

      const aqi = this.extractSensorValue(
        sensors,
        "indoor air quality index",
        "index"
      );
      const voc = this.extractSensorMetric(
        sensors,
        "indoor volatile organic compounds",
        [
          "voc_calc_embedded",
          "concentration",
          "total_filtered",
          "smooth_voc",
          "logic_filtered",
          "raw",
        ]
      );
      if (aqi !== null || voc) {
        this.syncRoomAirQualityAccessory(roomMeta, aqi, voc, activeUuids);
      }

      const ventilationMetrics = this.extractRoomVentilationMetrics(roomData);
      if (ventilationMetrics) {
        this.syncVentilationAccessory(
          roomMeta,
          ventilationMetrics,
          activeUuids
        );
      }

      const boost = state.boosts.get(roomId);
      if (boost) {
        if (this.enableBoostControl) {
          this.syncBoostValveAccessory(roomMeta, boost, activeUuids);
        } else {
          this.syncBoostSensorAccessory(roomMeta, boost, activeUuids);
        }
      }

      // Profile control (eco / health / intense) — only if enabled in config.
      if (this.enableProfileControl && roomMeta.profileName) {
        this.syncProfileAccessory(roomMeta, roomMeta.profileName, activeUuids);
      }
    }
  }

  syncTemperatureAccessory(roomMeta, value, activeUuids) {
    const name = `${roomMeta.roomName} Temperature`;
    const accessory = this.prepareAccessory({
      uuidSeed: `${roomMeta.roomId}-temperature`,
      name,
      category: this.hap.Categories.SENSOR,
      context: {
        kind: "temperature",
        roomId: roomMeta.roomId,
      },
    });

    const service =
      accessory.getService(this.hap.Service.TemperatureSensor) ||
      accessory.addService(this.hap.Service.TemperatureSensor, name);

    service.updateCharacteristic(
      this.hap.Characteristic.CurrentTemperature,
      Number(value)
    );
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, true);

    this.applyRoomInformation(accessory, roomMeta, "Temperature Sensor");
    this.finalizeAccessory(accessory, activeUuids);
  }

  syncHumidityAccessory(roomMeta, value, activeUuids) {
    const name = `${roomMeta.roomName} Humidity`;
    const accessory = this.prepareAccessory({
      uuidSeed: `${roomMeta.roomId}-humidity`,
      name,
      category: this.hap.Categories.SENSOR,
      context: {
        kind: "humidity",
        roomId: roomMeta.roomId,
      },
    });

    const service =
      accessory.getService(this.hap.Service.HumiditySensor) ||
      accessory.addService(this.hap.Service.HumiditySensor, name);

    service.updateCharacteristic(
      this.hap.Characteristic.CurrentRelativeHumidity,
      Number(value)
    );
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, true);

    this.applyRoomInformation(accessory, roomMeta, "Humidity Sensor");
    this.finalizeAccessory(accessory, activeUuids);
  }

  syncCo2Accessory(roomMeta, value, activeUuids) {
    const name = `${roomMeta.roomName} CO2`;
    const accessory = this.prepareAccessory({
      uuidSeed: `${roomMeta.roomId}-co2`,
      name,
      category: this.hap.Categories.SENSOR,
      context: {
        kind: "co2",
        roomId: roomMeta.roomId,
      },
    });

    const service =
      accessory.getService(this.hap.Service.CarbonDioxideSensor) ||
      accessory.addService(this.hap.Service.CarbonDioxideSensor, name);

    const co2Level = Number(value);
    service.updateCharacteristic(
      this.hap.Characteristic.CarbonDioxideLevel,
      co2Level
    );
    service.updateCharacteristic(
      this.hap.Characteristic.CarbonDioxideDetected,
      co2Level >= 1000
        ? this.hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
        : this.hap.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL
    );
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, true);

    this.applyRoomInformation(accessory, roomMeta, "CO2 Sensor");
    this.finalizeAccessory(accessory, activeUuids);
  }

  syncRoomAirQualityAccessory(roomMeta, aqiValue, vocMetric, activeUuids) {
    const name = `${roomMeta.roomName} Air Quality`;
    const accessory = this.prepareAccessory({
      uuidSeed: `${roomMeta.roomId}-air-quality`,
      name,
      category: this.hap.Categories.AIR_PURIFIER,
      context: {
        kind: "air-quality",
        roomId: roomMeta.roomId,
      },
    });

    const service =
      accessory.getService(this.hap.Service.AirQualitySensor) ||
      accessory.addService(this.hap.Service.AirQualitySensor, name);

    service.updateCharacteristic(
      this.hap.Characteristic.AirQuality,
      this.mapAirQualityIndex(aqiValue)
    );
    if (vocMetric) {
      const normalizedVoc = this.normalizeVocDensity(vocMetric.value);
      service.updateCharacteristic(
        this.hap.Characteristic.VOCDensity,
        normalizedVoc
      );
    }
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, true);

    // Air-quality metrics: AQI + VOC only (no fan electrical data for room accessories).
    const metricsService = this.getAirMetricsService(
      accessory,
      `${name} Metrics`,
      `${roomMeta.roomId}-air-quality`
    );
    this.updateMetricsCharacteristic(
      metricsService,
      this.customTypes.AirQualityIndex,
      aqiValue
    );
    this.updateMetricsCharacteristic(
      metricsService,
      this.customTypes.VocLevelPpm,
      vocMetric && vocMetric.value
    );

    this.applyRoomInformation(accessory, roomMeta, "Air Quality Sensor");
    this.finalizeAccessory(accessory, activeUuids);
  }

  syncVentilationAccessory(roomMeta, ventilationMetrics, activeUuids) {
    const name = `${roomMeta.roomName} Ventilation`;
    const accessory = this.prepareAccessory({
      uuidSeed: `${roomMeta.roomId}-ventilation`,
      name,
      category: this.hap.Categories.FAN,
      context: {
        kind: "ventilation",
        roomId: roomMeta.roomId,
      },
    });

    const service =
      accessory.getService(this.hap.Service.Fanv2) ||
      accessory.addService(this.hap.Service.Fanv2, name);

    const rotationSpeed = Math.min(
      100,
      Math.max(0, Math.round(Number(ventilationMetrics.ventilationRate) * 100))
    );

    this.attachReadOnlyFanHandlers(accessory, service);

    service.updateCharacteristic(
      this.hap.Characteristic.Active,
      rotationSpeed > 0
        ? this.hap.Characteristic.Active.ACTIVE
        : this.hap.Characteristic.Active.INACTIVE
    );
    service.updateCharacteristic(
      this.hap.Characteristic.CurrentFanState,
      rotationSpeed > 0
        ? this.hap.Characteristic.CurrentFanState.BLOWING_AIR
        : this.hap.Characteristic.CurrentFanState.IDLE
    );
    service.updateCharacteristic(
      this.hap.Characteristic.RotationSpeed,
      rotationSpeed
    );
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, true);

    // Ventilation metrics: flow rates only — no fan electrical characteristics.
    // Fan electrical data (power, pressure, RPM, voltage) belongs exclusively
    // to the global fan accessory (syncGlobalFanAccessory) which reads from
    // /v2/device/fan. Keeping them separate avoids misleading 0.0 readings
    // on per-room accessories.
    const metricsService = this.getVentMetricsService(
      accessory,
      `${name} Metrics`,
      `${roomMeta.roomId}-ventilation`
    );
    this.updateMetricsCharacteristic(
      metricsService,
      this.customTypes.FlowRate,
      ventilationMetrics.flowRate
    );
    this.updateMetricsCharacteristic(
      metricsService,
      this.customTypes.NominalFlowRate,
      ventilationMetrics.nominal
    );
    // Force bounds refresh for accessories restored from cache.
    metricsService
      .getCharacteristic(this.customTypes.VentilationRate)
      .setProps({ minValue: 0, maxValue: 200, minStep: 0.1 });
    this.updateMetricsCharacteristic(
      metricsService,
      this.customTypes.VentilationRate,
      Math.min(200, Math.max(0, Number(ventilationMetrics.ventilationRate) * 100))
    );

    this.applyRoomInformation(accessory, roomMeta, "Ventilation Rate");
    this.finalizeAccessory(accessory, activeUuids);
  }

  syncBoostSensorAccessory(roomMeta, boost, activeUuids) {
    const name = `${roomMeta.roomName} Boost`;
    const accessory = this.prepareAccessory({
      uuidSeed: `${roomMeta.roomId}-boost-sensor`,
      name,
      category: this.hap.Categories.SENSOR,
      context: {
        kind: "boost-sensor",
        roomId: roomMeta.roomId,
      },
    });

    const service =
      accessory.getService(this.hap.Service.OccupancySensor) ||
      accessory.addService(this.hap.Service.OccupancySensor, name);

    service.updateCharacteristic(
      this.hap.Characteristic.OccupancyDetected,
      boost.enabled
        ? this.hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
    );
    service.updateCharacteristic(this.hap.Characteristic.StatusActive, true);

    this.applyRoomInformation(
      accessory,
      roomMeta,
      boost.level !== null ? `Boost ${boost.level}%` : "Boost Status"
    );
    this.finalizeAccessory(accessory, activeUuids);
  }

  syncBoostValveAccessory(roomMeta, boost, activeUuids) {
    const name = `${roomMeta.roomName} Boost`;
    const accessory = this.prepareAccessory({
      uuidSeed: `${roomMeta.roomId}-boost-switch`,
      name,
      category: this.hap.Categories.SWITCH,
      context: {
        kind: "boost-switch",
        roomId: roomMeta.roomId,
        roomName: roomMeta.roomName,
      },
    });

    const service =
      accessory.getService(this.hap.Service.Switch) ||
      accessory.addService(this.hap.Service.Switch, name);

    this.attachBoostSwitchHandlers(accessory, service);

    service.updateCharacteristic(
      this.hap.Characteristic.On,
      Boolean(boost.enabled)
    );

    this.applyRoomInformation(
      accessory,
      roomMeta,
      boost.level !== null ? `Boost ${boost.level}%` : "Boost Switch"
    );
    this.finalizeAccessory(accessory, activeUuids);
  }

  // -------------------------------------------------------------------------
  // Profile control accessory
  //
  // Exposed as a FanV2 with a read-only Active state (always ACTIVE) and a
  // writable RotationSpeed that maps to the three Renson profiles:
  //   1–33 %  → eco
  //   34–67 % → health
  //   68–100% → intense
  //
  // When the user moves the speed slider, the plugin sends a PUT to
  // /v2/api/data/current/room/{id}/profile_name and refreshes.
  // -------------------------------------------------------------------------
  syncProfileAccessory(roomMeta, profileName, activeUuids) {
    const name = `${roomMeta.roomName} Profile`;
    const accessory = this.prepareAccessory({
      uuidSeed: `${roomMeta.roomId}-profile`,
      name,
      category: this.hap.Categories.FAN,
      context: {
        kind: "profile",
        roomId: roomMeta.roomId,
        roomName: roomMeta.roomName,
      },
    });

    const service =
      accessory.getService(this.hap.Service.Fanv2) ||
      accessory.addService(this.hap.Service.Fanv2, name);

    this.attachProfileFanHandlers(accessory, service);

    const speed = this.speedFromProfile(profileName);
    // Active is always ACTIVE — this accessory is a profile selector, not
    // an on/off control.
    service.updateCharacteristic(
      this.hap.Characteristic.Active,
      this.hap.Characteristic.Active.ACTIVE
    );
    service.updateCharacteristic(
      this.hap.Characteristic.CurrentFanState,
      this.hap.Characteristic.CurrentFanState.BLOWING_AIR
    );
    service.updateCharacteristic(this.hap.Characteristic.RotationSpeed, speed);

    this.applyRoomInformation(accessory, roomMeta, `Profile: ${profileName}`);
    this.finalizeAccessory(accessory, activeUuids);
  }

  attachProfileFanHandlers(accessory, service) {
    if (this.profileHandlersAttached.has(accessory.UUID)) {
      return;
    }

    // Active is read-only — the profile fan is always conceptually running.
    service.getCharacteristic(this.hap.Characteristic.Active).setProps({
      perms: [this.hap.Perms.NOTIFY, this.hap.Perms.PAIRED_READ],
    });

    // RotationSpeed slider drives the profile selection.
    service
      .getCharacteristic(this.hap.Characteristic.RotationSpeed)
      .onSet(async (value) => {
        const profile = this.profileFromSpeed(Number(value));
        const { roomId } = accessory.context;
        this.log.info(
          `Profile change requested for room ${roomId}: ${Math.round(value)}% → "${profile}"`
        );
        try {
          await this.setRoomProfile(roomId, profile);
        } catch (error) {
          this.log.error(
            `Failed to set profile for room ${roomId}: ${error.message || error}`
          );
          return;
        }
        await this.sleep(1000);
        void this.refreshData();
      });

    this.profileHandlersAttached.add(accessory.UUID);
  }

  prepareAccessory({ uuidSeed, name, category, context }) {
    const uuid = this.hap.uuid.generate(`healthbox:${uuidSeed}`);

    if (this.accessories.has(uuid)) {
      const accessory = this.accessories.get(uuid);
      if (accessory.displayName !== name) {
        accessory.updateDisplayName(name);
        this.api.updatePlatformAccessories([accessory]);
      }
      accessory.context = {
        ...accessory.context,
        ...(context || {}),
      };
      return accessory;
    }

    const accessory = new this.api.platformAccessory(name, uuid, category);
    accessory.context = {
      ...(context || {}),
    };
    this.accessories.set(uuid, accessory);
    return accessory;
  }

  applyAccessoryInformation(accessory, info) {
    const service =
      accessory.getService(this.hap.Service.AccessoryInformation) ||
      accessory.addService(this.hap.Service.AccessoryInformation);

    service.updateCharacteristic(
      this.hap.Characteristic.Manufacturer,
      info.manufacturer || "Renson"
    );
    service.updateCharacteristic(
      this.hap.Characteristic.Model,
      info.model || "Healthbox 3"
    );
    service.updateCharacteristic(
      this.hap.Characteristic.SerialNumber,
      info.serialNumber || this.host || "Unknown"
    );
    service.updateCharacteristic(
      this.hap.Characteristic.FirmwareRevision,
      info.firmwareRevision || "Unknown"
    );
  }

  applyRoomInformation(accessory, roomMeta, model) {
    const roomDetails = [roomMeta.roomType, roomMeta.profileName]
      .filter(Boolean)
      .join(" / ");

    this.applyAccessoryInformation(accessory, {
      manufacturer: "Renson",
      model: roomDetails ? `${model} (${roomDetails})` : model,
      serialNumber: `${roomMeta.serialRoot || this.host || "healthbox"}-${
        roomMeta.roomId
      }-${this.slugify(accessory.context.kind || "room")}`,
      firmwareRevision: "dynamic",
    });
  }

  attachReadOnlyFanHandlers(accessory, service) {
    const readOnlyPerms = [this.hap.Perms.NOTIFY, this.hap.Perms.PAIRED_READ];

    service.getCharacteristic(this.hap.Characteristic.Active).setProps({
      perms: readOnlyPerms,
    });
    service
      .getCharacteristic(this.hap.Characteristic.RotationSpeed)
      .setProps({
        perms: readOnlyPerms,
      });
  }

  attachBoostSwitchHandlers(accessory, service) {
    if (this.boostHandlersAttached.has(accessory.UUID)) {
      return;
    }

    service
      .getCharacteristic(this.hap.Characteristic.On)
      .onSet(async (value) => {
        const enabled = Boolean(value);
        const { roomId, roomName } = accessory.context;
        const { level, duration } = this.getRoomBoostConfig(roomId, roomName);
        this.log.info(
          `Boost ${enabled ? "ON" : "OFF"} requested for room ${roomId}` +
            (enabled ? ` (level=${level}%, duration=${duration}s)` : "")
        );
        try {
          await this.setRoomBoost(roomId, enabled, level, duration);
        } catch (error) {
          this.log.error(
            `Failed to set boost for room ${roomId}: ${error.message || error}`
          );
          throw new this.hap.HapStatusError(
            this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
          );
        }
        // Watch this room immediately so the countdown is polled every cycle
        // without waiting for the next full sweep.
        if (enabled) {
          this.boostWatch.add(roomId);
        }
        // Acknowledge the completed PUT immediately. The settling delay must
        // not keep the HomeKit write handler pending.
        void this.sleep(1500).then(() => {
          if (!this.stopped) return this.refreshData();
        }).catch((error) => {
          this.log.error(`Failed to refresh after boost: ${error.message || error}`);
        });
      });

    this.boostHandlersAttached.add(accessory.UUID);
  }

  finalizeAccessory(accessory, activeUuids) {
    this.registerAccessory(accessory);
    activeUuids.add(accessory.UUID);
  }

  registerAccessory(accessory) {
    if (accessory.registered) {
      return;
    }

    this.api.registerPlatformAccessories(PLUGIN_NAME, this.platformName, [
      accessory,
    ]);
    accessory.registered = true;
  }

  removeStaleAccessories(activeUuids) {
    const staleAccessories = [];

    for (const [uuid, accessory] of this.accessories.entries()) {
      if (activeUuids.has(uuid)) {
        continue;
      }

      staleAccessories.push(accessory);
      this.accessories.delete(uuid);
    }

    if (!staleAccessories.length) {
      return;
    }

    this.log.info(
      `Removing ${staleAccessories.length} stale Healthbox accessory${
        staleAccessories.length > 1 ? "ies" : "y"
      }.`
    );

    this.api.unregisterPlatformAccessories(
      PLUGIN_NAME,
      this.platformName,
      staleAccessories
    );
  }
}
