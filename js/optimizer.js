// SPX Route Optimizer & CSV Parser
// Organizes stops by street in monotonic numbering order (increasing or decreasing)
// Eliminates zig-zags and backtracking.

const RouteOptimizer = (function () {
  function haversineMeters(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function normalizeStreet(raw) {
    if (!raw) return "";
    let s = raw.trim();
    // Expand prefixes
    s = s.replace(/^r\.\s*/i, "Rua ")
         .replace(/^r\s+/i, "Rua ")
         .replace(/^av\.\s*/i, "Avenida ")
         .replace(/^av\s+/i, "Avenida ")
         .replace(/^al\.\s*/i, "Alameda ")
         .replace(/^al\s+/i, "Alameda ")
         .replace(/^tv\.\s*/i, "Travessa ")
         .replace(/^tv\s+/i, "Travessa ")
         .replace(/\bprf\b\.?/i, "Professor")
         .replace(/\bprof\b\.?/i, "Professor")
         .replace(/\bguido i\b\.?/i, "Guido Inácio");

    // Standardize spacing and casing
    s = s.replace(/\s+/g, " ");
    return s.trim();
  }

  function parseAddress(rawAddress) {
    if (!rawAddress) return { street: "Desconhecido", number: 0, complement: "" };
    const parts = rawAddress.split(",").map((p) => p.trim()).filter(Boolean);
    const street = normalizeStreet(parts[0] || "");
    let number = 0;
    let complement = "";

    if (parts.length > 1) {
      const numMatch = parts[1].match(/\d+/);
      if (numMatch) {
        number = parseInt(numMatch[0], 10);
      }
      const rest = parts.slice(2).join(", ");
      const numSuffix = parts[1].replace(/^\d+/, "").trim();
      complement = [numSuffix, rest].filter(Boolean).join(" - ").trim() || "Sem complemento";
    } else {
      complement = "Sem complemento";
    }

    return { street, number, complement };
  }

  // Parse CSV (supports comma or semicolon, quoted fields)
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];

    // Detect delimiter in header
    const headerLine = lines[0];
    const delimiter = (headerLine.match(/;/g) || []).length > (headerLine.match(/,/g) || []).length ? ";" : ",";

    function splitLine(line) {
      const result = [];
      let cur = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (c === delimiter && !inQuotes) {
          result.push(cur.trim());
          cur = "";
        } else {
          cur += c;
        }
      }
      result.push(cur.trim());
      return result;
    }

    const headers = splitLine(lines[0]).map((h) => h.toLowerCase().replace(/[\s/_-]+/g, ""));
    const colMap = {
      tn: headers.findIndex((h) => h.includes("spxtn") || h.includes("tn") || h.includes("rastreio") || h.includes("pacote")),
      address: headers.findIndex((h) => h.includes("destinationaddress") || h.includes("address") || h.includes("endereco")),
      bairro: headers.findIndex((h) => h.includes("bairro") || h.includes("neighborhood")),
      city: headers.findIndex((h) => h.includes("city") || h.includes("cidade")),
      zipcode: headers.findIndex((h) => h.includes("zip") || h.includes("cep") || h.includes("postal")),
      lat: headers.findIndex((h) => h.includes("latitude") || h.includes("lat")),
      lon: headers.findIndex((h) => h.includes("longitude") || h.includes("lon") || h.includes("lng")),
      atId: headers.findIndex((h) => h.includes("atid") || h.includes("id"))
    };

    // Defaults if headers not matched standard names
    if (colMap.tn === -1) colMap.tn = 3;
    if (colMap.address === -1) colMap.address = 4;
    if (colMap.bairro === -1) colMap.bairro = 5;
    if (colMap.city === -1) colMap.city = 6;
    if (colMap.zipcode === -1) colMap.zipcode = 7;
    if (colMap.lat === -1) colMap.lat = 8;
    if (colMap.lon === -1) colMap.lon = 9;

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = splitLine(lines[i]);
      if (cols.length <= Math.max(colMap.tn, colMap.address)) continue;
      const tn = cols[colMap.tn] || "";
      const rawAddress = cols[colMap.address] || "";
      if (!tn || !rawAddress) continue;

      const lat = parseFloat(cols[colMap.lat]) || 0;
      const lon = parseFloat(cols[colMap.lon]) || 0;
      const bairro = cols[colMap.bairro] || "Não inf.";
      const city = cols[colMap.city] || "Não inf.";
      const zipcode = cols[colMap.zipcode] || "";
      const atId = cols[colMap.atId] || "";

      rows.push({ tn, address: rawAddress, bairro, city, zipcode, lat, lon, atId });
    }
    return rows;
  }

  // Optimize and build stops
  function buildOptimizedRoute(rows, options = {}) {
    if (!rows || rows.length === 0) return { stops: [], totalPackages: 0, streets: [] };

    // 1. Group into physical stops by (Normalized Street + Number)
    const stopMap = new Map();
    rows.forEach((r) => {
      const { street, number, complement } = parseAddress(r.address);
      const key = `${street.toLowerCase()}|${number}`;

      if (!stopMap.has(key)) {
        stopMap.set(key, {
          street,
          number,
          title: number ? `${street}, ${number}` : street,
          bairro: r.bairro,
          city: r.city,
          zipcode: r.zipcode,
          lat: r.lat,
          lon: r.lon,
          items: []
        });
      }
      stopMap.get(key).items.push({
        tn: r.tn,
        address: r.address,
        complement: complement || "Sem complemento",
        atId: r.atId
      });
    });

    const stops = Array.from(stopMap.values());

    // 2. Group stops by Street
    const streetsMap = new Map();
    stops.forEach((s) => {
      if (!streetsMap.has(s.street)) streetsMap.set(s.street, []);
      streetsMap.get(s.street).push(s);
    });

    // 3. For each street, sort by door number (asc and desc)
    const streetSegments = [];
    streetsMap.forEach((streetStops, streetName) => {
      streetStops.sort((a, b) => a.number - b.number);
      const asc = [...streetStops];
      const desc = [...streetStops].reverse();
      streetSegments.push({
        street: streetName,
        asc,
        desc,
        startAsc: asc[0],
        endAsc: asc[asc.length - 1],
        startDesc: desc[0],
        endDesc: desc[desc.length - 1]
      });
    });

    // 4. Determine start point
    let unvisited = [...streetSegments];
    let currentPos = null;

    if (options.userLocation && options.userLocation.lat && options.userLocation.lon) {
      currentPos = { lat: options.userLocation.lat, lon: options.userLocation.lon };
    }

    const orderedStops = [];

    // If no initial GPS pos, start at the most peripheral street (furthest or closest to reference)
    if (!currentPos && unvisited.length > 0) {
      let bestStartIdx = 0;
      let minLon = Infinity;
      unvisited.forEach((seg, idx) => {
        if (seg.startAsc.lon && seg.startAsc.lon < minLon) {
          minLon = seg.startAsc.lon;
          bestStartIdx = idx;
        }
      });
      const firstSeg = unvisited.splice(bestStartIdx, 1)[0];
      firstSeg.asc.forEach((s) => orderedStops.push(s));
      currentPos = firstSeg.endAsc;
    }

    // 5. Chained Nearest Neighbor across streets
    while (unvisited.length > 0) {
      let bestDist = Infinity;
      let bestSegIdx = 0;
      let bestDir = "asc";

      unvisited.forEach((seg, idx) => {
        const dAsc = haversineMeters(currentPos.lat, currentPos.lon, seg.startAsc.lat, seg.startAsc.lon);
        const dDesc = haversineMeters(currentPos.lat, currentPos.lon, seg.startDesc.lat, seg.startDesc.lon);

        if (dAsc < bestDist) {
          bestDist = dAsc;
          bestSegIdx = idx;
          bestDir = "asc";
        }
        if (dDesc < bestDist) {
          bestDist = dDesc;
          bestSegIdx = idx;
          bestDir = "desc";
        }
      });

      const chosen = unvisited.splice(bestSegIdx, 1)[0];
      const sequence = bestDir === "asc" ? chosen.asc : chosen.desc;
      sequence.forEach((s) => orderedStops.push(s));
      currentPos = sequence[sequence.length - 1];
    }

    // If reverse option requested
    if (options.reverse) {
      orderedStops.reverse();
    }

    // 6. Assign IDs and sequential metadata
    let packageSeq = 0;
    orderedStops.forEach((s, idx) => {
      s.id = idx + 1;
      s.items.forEach((it) => {
        packageSeq += 1;
        it.seq = packageSeq;
        it.stopId = s.id;
      });
    });

    return {
      stops: orderedStops,
      totalPackages: packageSeq,
      streetsCount: streetsMap.size
    };
  }

  // Named stop label for Google Maps & Android Auto
  function formatStopLabel(stop) {
    const address = stop.title || (stop.number ? `${stop.street}, ${stop.number}` : stop.street);
    const bairro = stop.bairro && stop.bairro !== "Não inf." ? stop.bairro : "";
    let city = stop.city && stop.city !== "Não inf." ? stop.city : "";
    if (city && !city.includes("-") && !city.includes("/")) {
      city = `${city} - PR`;
    }
    const parts = [address, bairro, city].filter(Boolean);
    return parts.join(", ");
  }

  // Google Maps multi-stop URL builder with named destinations (Android Auto ready)
  // Generates https://www.google.com/maps/dir/Stop1/Stop2/Stop3/...
  function buildGoogleMapsRouteUrl(stops, startIdx = 0, count = null) {
    if (!stops || stops.length === 0) return "#";
    const slice = count ? stops.slice(startIdx, startIdx + count) : stops.slice(startIdx);
    if (slice.length === 0) return "#";

    const segments = slice.map((s) => encodeURIComponent(formatStopLabel(s)));
    return "https://www.google.com/maps/dir/" + segments.join("/") + "/";
  }

  function buildSingleStopGoogleMapsUrl(stop) {
    const query = encodeURIComponent(formatStopLabel(stop));
    return `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lon}&travelmode=driving&query=${query}`;
  }

  return {
    parseCSV,
    buildOptimizedRoute,
    formatStopLabel,
    buildGoogleMapsRouteUrl,
    buildSingleStopGoogleMapsUrl,
    haversineMeters
  };
})();

if (typeof window !== "undefined") {
  window.RouteOptimizer = RouteOptimizer;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = RouteOptimizer;
}
