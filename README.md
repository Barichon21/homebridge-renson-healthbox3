# homebridge-renson-healthbox3

[![npm](https://img.shields.io/npm/v/homebridge-renson-healthbox3)](https://www.npmjs.com/package/homebridge-renson-healthbox3)
[![Homebridge](https://img.shields.io/badge/homebridge-%E2%89%A52.0-blueviolet)](https://homebridge.io)

A dynamic [Homebridge](https://homebridge.io) plugin for the **Renson Healthbox 3** ventilation unit.

The plugin polls the local Healthbox HTTP API and automatically creates HomeKit accessories matching the sensors actually exposed by your unit — no static configuration of rooms required.

## Features

- **Per-room sensors** — temperature, humidity, CO₂, VOC / air quality index
- **Per-room ventilation** — real-time flow rate, nominal flow rate, ventilation rate (%)
- **Global fan** — flow rate, pressure (Pa), power (W), RPM, voltage (V)
- **Boost control** — per-room boost on/off switch (optional, off by default)
- **Profile control** — switch between *eco / health / intense* ventilation profiles per room (optional)
- **Advanced API** — automatically activates the Renson local sensor API when an API key is provided, unlocking all electrical fan metrics
- **Dynamic accessories** — accessories are created and removed automatically as rooms appear or disappear in the API response

## Installation

Search for **Renson Healthbox 3** in the Homebridge UI, or run:

```bash
npm install -g homebridge-renson-healthbox3
```

## Configuration

Use the Homebridge UI config editor, or add the following block to your `config.json`:

```json
{
  "platform": "HealthBoxHomebridgePlugin",
  "name": "Renson Healthbox 3",
  "host": "192.168.x.x",
  "apiKey": "YOUR_ADVANCED_API_KEY",
  "pollInterval": 30,
  "enableBoostControl": false,
  "enableProfileControl": false
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `host` | ✅ | — | IP address or hostname of the Healthbox unit |
| `healthBoxUri` | — | — | Legacy URI format, e.g. `http://192.168.1.x` |
| `apiKey` | — | — | Advanced local API key (activates electrical fan metrics) |
| `pollInterval` | — | `30` | Seconds between data refreshes (min 5) |
| `requestTimeout` | — | `10` | HTTP timeout in seconds |
| `enableBoostControl` | — | `false` | Expose room boost as a controllable switch |
| `boostFanSpeed` | — | `100` | Boost fan level (10–200 %) |
| `boostDuration` | — | `600` | Boost duration in seconds (300–86400) |
| `enableProfileControl` | — | `false` | Expose ventilation profile selector per room (eco / health / intense) |
| `roomBoostOverrides` | — | — | Per-room boost level / duration overrides |
| `disableLogging` | — | `false` | Silence info/debug messages |

### Advanced API key

The Renson Healthbox 3 exposes additional sensor data (fan power, pressure, RPM, voltage) only when a privileged API key is activated. Contact Renson or refer to the [local API documentation](https://support.renson.net) to obtain your key. Once set in the config, the plugin activates it automatically on startup.

### Per-room boost overrides

```json
"roomBoostOverrides": [
  { "room": "1", "boostLevel": 150, "boostDuration": 900 },
  { "room": "3", "boostDuration": 1800 }
]
```

`room` is the numeric room ID returned by `/v2/api/data/current` (visible in Homebridge logs at startup).

## Exposed accessories

### Per room
| Accessory | Service | Condition |
|---|---|---|
| `{Room} Temperature` | TemperatureSensor | Room has temperature sensor |
| `{Room} Humidity` | HumiditySensor | Room has humidity sensor |
| `{Room} CO2` | CarbonDioxideSensor | Room has CO₂ sensor |
| `{Room} Air Quality` | AirQualitySensor | Room has AQI or VOC sensor |
| `{Room} Ventilation` | Fanv2 | Room has air valve |
| `{Room} Boost` | OccupancySensor or Switch | Always (switch if `enableBoostControl`) |
| `{Room} Profile` | Fanv2 | Only if `enableProfileControl` |

### Global
| Accessory | Service |
|---|---|
| `{Name} Air Quality` | AirQualitySensor (global AQI) |
| `{Name} Fan` | Fanv2 + custom metrics (power, pressure, RPM, voltage) |
| `{Name} Connectivity` | ContactSensor (WiFi status) |

## Custom characteristics (visible in Eve)

Room ventilation accessories expose a **PERSONNALISÉ** section with:
- Flow Rate (m³/h), Nominal Flow Rate (m³/h), Ventilation Rate (%)

The global fan accessory exposes:
- Flow Rate, Fan Pressure (Pa), Fan Power (W), Fan RPM, Fan Voltage (V)

## Notes

- Accessories are created/removed dynamically — no static room list needed.
- Room names, profile, firmware version and serial number are pulled live from the API.
- Emoji in room names (as returned by some Healthbox firmware versions) are automatically stripped to comply with HomeKit Name characteristic rules.

## License

MIT © barichon21
