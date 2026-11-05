"use strict";

function numberOrNull(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function endpointUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Healthbox address is required.");
  const input = value.trim();
  if (input.includes("://") && !/^https?:\/\//i.test(input)) throw new Error("Only HTTP(S) addresses are supported.");
  const url = new URL(/^https?:\/\//i.test(input) ? input : `http://${input}`);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("Use an HTTP(S) Healthbox address without embedded credentials.");
  }
  // The local API is rooted at the device origin, even if a legacy URL has a path.
  return url.origin;
}

function normalizeRooms(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Healthbox data.");
  const source = data.room ?? data.home?.room;
  if (!source || typeof source !== "object") throw new Error("Healthbox response has no valid room inventory.");
  const rooms = {};
  for (const [key, room] of Object.entries(source)) {
    if (!room || typeof room !== "object" || Array.isArray(room)) throw new Error("Invalid room entry.");
    const id = Array.isArray(source) ? room.id : key;
    if (id === undefined || id === null || !String(id).trim()) throw new Error("Room ID is missing.");
    const text = String(id).trim();
    if (Object.prototype.hasOwnProperty.call(rooms, text)) throw new Error(`Duplicate room ID: ${text}`);
    Object.defineProperty(rooms, text, { value: { ...room, id: text, sensor: Array.isArray(room.sensor) ? room.sensor.filter(isRecord) : [] }, enumerable: true });
  }
  return rooms;
}

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function normalizeData(data) {
  return { ...data, sensor: Array.isArray(data?.sensor) ? data.sensor.filter(isRecord) : [], room: normalizeRooms(data) };
}

function vocDensity(metric) {
  if (!metric) return null;
  const value = numberOrNull(metric.value);
  if (value === null || value < 0) return null;
  const unit = String(metric.unit || "").toLowerCase().replace(/[μµ]/g, "u").replace(/³/g, "3").replace(/\s/g, "");
  if (["ug/m3", "ug/m^3"].includes(unit)) return value;
  if (["mg/m3", "mg/m^3"].includes(unit)) return value * 1000;
  // ppm/ppb require a known compound/molar mass. Do not invent a conversion.
  return null;
}

module.exports = { numberOrNull, endpointUrl, normalizeRooms, normalizeData, vocDensity };
