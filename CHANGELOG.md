# Changelog

All notable changes to this plugin are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-06-09

### Changed
- **Tiered polling** of the Healthbox local API. Each refresh cycle now issues
  only the two endpoints whose data actually changes — `/v2/api/data/current`
  (all room sensors, IAQ, flows, profiles) and `/v2/device/fan` (central fan) —
  instead of ~9 calls every cycle. This cuts the request load on the unit's
  embedded controller by roughly 70–80 %, reducing intermittent `502 Bad
  Gateway` responses and sensor stalls.
- **Boost endpoints** are polled on demand: only for rooms with an active boost,
  plus a lightweight full sweep at most once per minute to catch boosts started
  from the Renson app or the physical button. Boost triggered from HomeKit is
  watched immediately so the countdown is accurate without waiting for a sweep.
- **Quasi-static data** is decoupled from the fast loop: firmware/Wi-Fi status
  are fetched at startup and refreshed every 30 minutes; the device error list
  every 5 minutes.

### Notes
- No configuration changes required; fully backward compatible.
- Declares Homebridge 2.x compatibility (`engines.homebridge: ^1.8.0 || ^2.0.0`).

## [1.0.1] - 2026-05-31

### Added
- Initial public release: room temperature/humidity/CO₂/VOC and air-quality
  index sensors, per-room ventilation rate and flow, central fan metrics
  (voltage, pressure, flow, power, RPM), boost switches and profile control,
  optional MQTT publishing, and child-bridge support.
