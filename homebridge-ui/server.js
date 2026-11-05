"use strict";

const { HomebridgePluginUiServer } = require("@homebridge/plugin-ui-utils");

class HealthboxUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest("/discover-rooms", this.discoverRooms.bind(this));
    this.ready();
  }

  async discoverRooms(payload) {
    const { host, healthBoxUri } = payload || {};

    // Build base URL from either field
    let baseUrl = "";
    if (host) {
      const trimmed = host.trim();
      baseUrl = trimmed.startsWith("http") ? trimmed.replace(/\/$/, "") : `http://${trimmed}`;
    } else if (healthBoxUri) {
      baseUrl = healthBoxUri.trim().replace(/\/$/, "");
    }

    if (!baseUrl) {
      throw new Error("Aucune adresse Healthbox fournie (host ou healthBoxUri requis).");
    }

    const url = `${baseUrl}/v2/api/data/current`;

    // Node's built-in fetch (Node ≥18) is available in the Homebridge environment
    let data;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const response = await fetch(url, { signal: ctrl.signal });
      if (!response.ok) {
        throw new Error(`L'API Healthbox a répondu ${response.status} ${response.statusText}`);
      }
      try {
        data = await response.json();
      } catch (err) {
        if (err.name === "AbortError") throw err;
        throw new Error("La réponse de la Healthbox n'est pas du JSON valide.");
      }
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`Timeout : impossible de joindre ${baseUrl} en 8 secondes.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Accept both { room: [...] } and { home: { room: [...] } } layouts
    const roomList =
      (Array.isArray(data.room) && data.room) ||
      (data.home && Array.isArray(data.home.room) && data.home.room) ||
      [];

    if (!roomList.length) {
      throw new Error("Aucune pièce trouvée dans la réponse de la Healthbox.");
    }

    // Strip emoji from names (same logic as the main plugin)
    const sanitize = (str) =>
      String(str || "")
        .replace(/\p{Extended_Pictographic}/gu, "")
        .replace(/[‍︎️⃣\u{E0000}-\u{E007F}]/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim();

    const rooms = roomList.map((r) => ({
      id: String(r.id),
      name: sanitize(r.name) || `Room ${r.id}`,
      type: r.parameter?.find?.((p) => p.type === "room type")?.data?.value || r.type || "",
    }));

    return { rooms };
  }
}

(() => new HealthboxUiServer())();
