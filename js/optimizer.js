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

  // Extract apartment and unit information
  function extractApartmentInfo(complement, rawAddress = "") {
    const text = `${complement || ""} ${rawAddress || ""}`.trim();

    // Extract Bloco / Torre
    let block = null;
    const blockMatch = text.match(/\b(?:bloco|bl\.?|bl|torre)\s*[-:#]?\s*([0-9a-zA-Z]+)\b/i);
    if (blockMatch) {
      block = blockMatch[1].toUpperCase();
    }

    // Apartment: ap, apt, apto, apartamento
    const aptMatch = text.match(/\b(?:ap(?:to|t)?\.?|apartamento)\s*[-:#]?\s*([0-9]+[a-zA-Z]?|[a-zA-Z][0-9]+|[a-zA-Z]\b)/i);
    const salaMatch = !aptMatch ? text.match(/\b(?:sala|conjunto|cj\.?)\s*[-:#]?\s*([0-9]+[a-zA-Z]?)\b/i) : null;
    const casaMatch = !aptMatch && !salaMatch ? text.match(/\b(?:casa|sobrado)\s*[-:#]?\s*([0-9]+[a-zA-Z]?)\b/i) : null;
    // Pure number fallback in complement (e.g. "Rua X, 100, 102" -> complement is "102")
    const pureNumMatch = (!aptMatch && !salaMatch && !casaMatch && complement)
      ? complement.trim().match(/^(\d{1,5}[a-zA-Z]?)$/)
      : null;

    const match = aptMatch || salaMatch || casaMatch || pureNumMatch;

    if (match) {
      const rawVal = match[1].toUpperCase();
      let prefix = "Ap";
      if (salaMatch) prefix = "Sala";
      else if (casaMatch) prefix = "Casa";

      const numOnly = parseInt(rawVal.replace(/\D/g, ""), 10);
      const numVal = isNaN(numOnly) ? 0 : numOnly;
      const blockKey = block ? `BL_${block}` : "BL_NONE";
      const aptKey = `${prefix.toUpperCase()}_${rawVal}`;
      const groupKey = `${blockKey}|${aptKey}`;
      const displayLabel = block ? `Bl. ${block} • ${prefix} ${rawVal}` : `${prefix} ${rawVal}`;

      return {
        hasApartment: true,
        block,
        apartmentNumber: rawVal,
        numericValue: numVal,
        groupKey,
        displayLabel
      };
    }

    return {
      hasApartment: false,
      block: null,
      apartmentNumber: null,
      numericValue: 0,
      groupKey: "NO_APT",
      displayLabel: null
    };
  }

  // Sort packages inside a physical stop by apartment
  function sortItemsByApartment(items) {
    return items.sort((a, b) => {
      const aptA = a.apartmentInfo || { hasApartment: false };
      const aptB = b.apartmentInfo || { hasApartment: false };

      if (aptA.hasApartment && !aptB.hasApartment) return -1;
      if (!aptA.hasApartment && aptB.hasApartment) return 1;
      if (!aptA.hasApartment && !aptB.hasApartment) return 0;

      const blockA = (aptA.block || "").toUpperCase();
      const blockB = (aptB.block || "").toUpperCase();
      if (blockA !== blockB) {
        if (!blockA) return 1;
        if (!blockB) return -1;
        return blockA.localeCompare(blockB, undefined, { numeric: true });
      }

      if (aptA.numericValue && aptB.numericValue && aptA.numericValue !== aptB.numericValue) {
        return aptA.numericValue - aptB.numericValue;
      }

      return (aptA.apartmentNumber || "").localeCompare(aptB.apartmentNumber || "", undefined, { numeric: true });
    });
  }

  // Count distinct delivery addresses (each apartment counts as a different address)
  function countDistinctAddresses(items) {
    if (!items || items.length === 0) return 0;
    const aptSet = new Set();
    let hasNonApt = false;
    items.forEach((it) => {
      if (it.apartmentInfo && it.apartmentInfo.hasApartment) {
        aptSet.add(it.apartmentInfo.groupKey);
      } else {
        hasNonApt = true;
      }
    });
    return aptSet.size + (hasNonApt ? 1 : 0);
  }

  function formatDuration(totalMinutes) {
    if (!totalMinutes || totalMinutes <= 0) return "0 min";
    const hours = Math.floor(totalMinutes / 60);
    const mins = Math.round(totalMinutes % 60);
    if (hours > 0) {
      return mins > 0 ? `${hours}h ${String(mins).padStart(2, "0")}min` : `${hours}h`;
    }
    return `${mins} min`;
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
      tn: headers.findIndex((h) => h.includes("spxtn") || h.includes("tracking") || h.includes("tn") || h.includes("rastreio") || h.includes("pacote")),
      address: headers.findIndex((h) => h.includes("destinationaddress") || h.includes("address") || h.includes("endereco")),
      bairro: headers.findIndex((h) => h.includes("bairro") || h.includes("neighborhood")),
      city: headers.findIndex((h) => h.includes("city") || h.includes("cidade")),
      zipcode: headers.findIndex((h) => h.includes("zip") || h.includes("cep") || h.includes("postal")),
      lat: headers.findIndex((h) => h.includes("latitude") || h.includes("lat")),
      lon: headers.findIndex((h) => h.includes("longitude") || h.includes("lon") || h.includes("lng")),
      atId: headers.findIndex((h) => h.includes("atid") || h.includes("id")),
      recipient: headers.findIndex((h) => h.includes("buyer") || h.includes("destinatario") || h.includes("receiver") || h.includes("recipient") || h.includes("cliente") || h === "nome"),
      notes: headers.findIndex((h) => h.includes("remark") || h.includes("observa") || h.includes("obs") || h.includes("instruc") || h.includes("referencia") || h.includes("note")),
      sortCode: headers.findIndex((h) => h.includes("sortcode") || h.includes("gaiola") || h.includes("corredor") || h.includes("zona") || h.includes("zone") || h.includes("lote")),
      size: headers.findIndex((h) => h.includes("tamanho") || h.includes("porte") || h.includes("size") || h.includes("volume")),
      weight: headers.findIndex((h) => h.includes("peso") || h.includes("weight") || h === "kg")
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
      const atId = colMap.atId >= 0 ? (cols[colMap.atId] || "") : "";
      const recipient = colMap.recipient >= 0 ? (cols[colMap.recipient] || "") : "";
      const notes = colMap.notes >= 0 ? (cols[colMap.notes] || "") : "";
      const sortCode = colMap.sortCode >= 0 ? (cols[colMap.sortCode] || "") : "";
      const size = colMap.size >= 0 ? normalizePackageSize(cols[colMap.size]) : "m";
      const weight = colMap.weight >= 0 ? normalizePackageWeight(cols[colMap.weight]) : "light";

      rows.push({ tn, address: rawAddress, bairro, city, zipcode, lat, lon, atId, recipient, notes, sortCode, size, weight });
    }
    return rows;
  }

  function normalizeStreetKey(street) {
    return (street || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Sort stops on the same street by physical road progression rather than door number
  function orderStopsAlongStreetGeo(streetStops) {
    if (!streetStops || streetStops.length <= 1) return streetStops ? [...streetStops] : [];
    const remaining = streetStops.map((s) => s);

    // Find physical endpoint pair with largest separation
    let startIdx = 0;
    let bestSep = -1;
    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        const d = haversineMeters(remaining[i].lat, remaining[i].lon, remaining[j].lat, remaining[j].lon);
        if (d > bestSep) {
          bestSep = d;
          startIdx = i;
        }
      }
    }

    if (bestSep <= 0) {
      return [...streetStops].sort((a, b) => a.number - b.number);
    }

    const ordered = [remaining.splice(startIdx, 1)[0]];
    while (remaining.length > 0) {
      const cur = ordered[ordered.length - 1];
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = haversineMeters(cur.lat, cur.lon, remaining[i].lat, remaining[i].lon);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      ordered.push(remaining.splice(bestIdx, 1)[0]);
    }
    return ordered;
  }

  const PACKAGE_SIZE_UNITS = { xs: 1, s: 2, m: 4, l: 7, xl: 11 };
  const PACKAGE_WEIGHT_UNITS = { light: 1, medium: 2, heavy: 4 };
  const PACKAGE_SIZE_LABELS = {
    xs: "Muito Pequeno",
    s: "Pequeno",
    m: "Médio",
    l: "Grande",
    xl: "Muito Grande"
  };
  const PACKAGE_WEIGHT_LABELS = {
    light: "Leve",
    medium: "Médio",
    heavy: "Pesado"
  };
  const WALK_TRIP_MAX_SIZE = 12;
  const WALK_TRIP_MAX_WEIGHT = 6;
  const WALK_TRIP_MAX_ITEMS = 6;

  function normalizePackageSize(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return "m";
    if (s === "xs" || s.includes("muito peq") || s === "pp") return "xs";
    if (s === "s" || s === "p" || s.includes("pequeno")) return "s";
    if (s === "xl" || s === "gg" || s.includes("muito gra")) return "xl";
    if (s === "l" || s === "g" || s.includes("grande")) return "l";
    return "m";
  }

  function normalizePackageWeight(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return "light";
    if (s === "heavy" || s.includes("pesad")) return "heavy";
    if (s === "medium" || s.includes("medi") || s.includes("médi")) return "medium";
    const num = parseFloat(s.replace(",", "."));
    if (!Number.isNaN(num)) {
      if (num >= 8) return "heavy";
      if (num >= 3) return "medium";
      return "light";
    }
    return "light";
  }

  function getItemCarryCost(item, packageSpecs = {}) {
    const spec = (packageSpecs && item && packageSpecs[item.tn]) || {};
    const sizeKey = normalizePackageSize(spec.size || (item && item.size) || "m");
    const weightKey = normalizePackageWeight(spec.weight || (item && item.weight) || "light");
    return {
      sizeKey,
      weightKey,
      sizeUnits: PACKAGE_SIZE_UNITS[sizeKey] || 4,
      weightUnits: PACKAGE_WEIGHT_UNITS[weightKey] || 1
    };
  }

  function estimateOfflineWalkMeters(stopA, stopB) {
    if (!stopA || !stopB || !stopA.lat || !stopA.lon || !stopB.lat || !stopB.lon) return 0;
    const straight = haversineMeters(stopA.lat, stopA.lon, stopB.lat, stopB.lon);
    if (straight <= 1) return 0;
    const sameStreet = stopA.street && stopB.street && normalizeStreetKey(stopA.street) === normalizeStreetKey(stopB.street);
    return straight * (sameStreet ? 1.04 : 1.10);
  }

  // Max-coverage Parking Hubs based on cumulative walking route distance (percurso <= walkRadiusMeters)
  function buildParkingHubs(stops, walkRadiusMeters = 0, externalFootMatrix = null) {
    if (!stops || stops.length === 0) return [];
    const radius = Math.max(0, parseInt(walkRadiusMeters, 10) || 0);

    const cloned = stops.map((s) => ({
      ...s,
      isWalkStop: false,
      hubId: null,
      hubLat: s.lat,
      hubLon: s.lon,
      hubLabel: s.title,
      walkFromStopId: null,
      walkAnchorTitle: "",
      walkTripNumber: 1,
      walkDistanceMeters: 0,
      walkClusterSize: 1
    }));

    if (radius <= 0) {
      return cloned.map((s) => ({
        isParkingHub: true,
        lat: s.lat,
        lon: s.lon,
        street: s.street,
        bairro: s.bairro,
        city: s.city,
        streetHint: s.title,
        roadName: "",
        footDistances: {},
        footPairDistances: {},
        usedFootDistance: false,
        stops: [s]
      }));
    }

    const withCoords = [];
    const withoutCoords = [];
    cloned.forEach((s) => {
      if (s.lat && s.lon) withCoords.push(s);
      else withoutCoords.push(s);
    });

    const hasFootMat = Array.isArray(externalFootMatrix) && externalFootMatrix.length === withCoords.length;
    const stepWalkDist = (i, j) => {
      if (i === j) return 0;
      if (hasFootMat && externalFootMatrix[i] && typeof externalFootMatrix[i][j] === "number" && Number.isFinite(externalFootMatrix[i][j])) {
        return externalFootMatrix[i][j];
      }
      return estimateOfflineWalkMeters(withCoords[i], withCoords[j]);
    };

    const assigned = new Set();
    const hubs = [];

    while (assigned.size < withCoords.length) {
      const uncovered = [];
      for (let i = 0; i < withCoords.length; i++) {
        if (!assigned.has(i)) uncovered.push(i);
      }

      let bestChain = [];
      let bestPercursoMap = {};
      let bestTotalPercurso = Infinity;

      // Evaluate each uncovered stop as the start of a sequential walking route (percurso <= radius)
      for (const startIdx of uncovered) {
        const chain = [startIdx];
        const inChain = new Set([startIdx]);
        const percursoMap = { [startIdx]: 0 };
        let curIdx = startIdx;
        let cumPercurso = 0;

        while (true) {
          let nextIdx = -1;
          let bestStep = Infinity;
          for (const candIdx of uncovered) {
            if (inChain.has(candIdx)) continue;
            const dStep = stepWalkDist(curIdx, candIdx);
            const dFromOrigin = stepWalkDist(startIdx, candIdx);
            // Enforce both direct reach AND cumulative walking path (percurso) <= radius
            if (dFromOrigin <= radius && cumPercurso + dStep <= radius && dStep < bestStep) {
              bestStep = dStep;
              nextIdx = candIdx;
            }
          }
          if (nextIdx === -1) break;
          cumPercurso += bestStep;
          chain.push(nextIdx);
          inChain.add(nextIdx);
          percursoMap[nextIdx] = Math.round(cumPercurso);
          curIdx = nextIdx;
        }

        if (
          chain.length > bestChain.length ||
          (chain.length === bestChain.length && cumPercurso < bestTotalPercurso)
        ) {
          bestChain = chain;
          bestPercursoMap = percursoMap;
          bestTotalPercurso = cumPercurso;
        }
      }

      if (bestChain.length === 0) break;

      bestChain.forEach((idx) => assigned.add(idx));
      const memberStops = bestChain.map((idx) => withCoords[idx]);
      const firstStop = memberStops[0];

      // Shift parking point slightly toward the group centroid if cumulative percurso remains <= radius
      let hubLat = firstStop.lat;
      let hubLon = firstStop.lon;
      let initialOffsetMeters = 0;
      if (memberStops.length > 1) {
        const cLat = memberStops.reduce((s, st) => s + st.lat, 0) / memberStops.length;
        const cLon = memberStops.reduce((s, st) => s + st.lon, 0) / memberStops.length;
        const fullCentroidDist = estimateOfflineWalkMeters({ lat: cLat, lon: cLon, street: firstStop.street }, firstStop);
        if (fullCentroidDist + bestTotalPercurso <= radius) {
          hubLat = cLat;
          hubLon = cLon;
          initialOffsetMeters = Math.round(fullCentroidDist);
        } else {
          const blendLat = firstStop.lat * 0.9 + cLat * 0.1;
          const blendLon = firstStop.lon * 0.9 + cLon * 0.1;
          const blendDist = estimateOfflineWalkMeters({ lat: blendLat, lon: blendLon, street: firstStop.street }, firstStop);
          if (blendDist + bestTotalPercurso <= radius + 2) {
            hubLat = blendLat;
            hubLon = blendLon;
            initialOffsetMeters = Math.round(blendDist);
          }
        }
      }

      const footDistances = {};
      const footPairDistances = {};
      bestChain.forEach((idx) => {
        const st = withCoords[idx];
        footDistances[stopCoordKey(st)] = Math.min(radius, (bestPercursoMap[idx] || 0) + initialOffsetMeters);
      });
      for (let a = 0; a < bestChain.length; a++) {
        for (let b = 0; b < bestChain.length; b++) {
          if (a === b) continue;
          const idxA = bestChain[a];
          const idxB = bestChain[b];
          footPairDistances[`${stopCoordKey(withCoords[idxA])}=>${stopCoordKey(withCoords[idxB])}`] = Math.round(stepWalkDist(idxA, idxB));
        }
      }

      hubs.push({
        isParkingHub: true,
        lat: hubLat,
        lon: hubLon,
        street: firstStop.street,
        bairro: firstStop.bairro,
        city: firstStop.city,
        streetHint: firstStop.title,
        roadName: "",
        footDistances,
        footPairDistances,
        usedFootDistance: hasFootMat,
        stops: memberStops
      });
    }

    withoutCoords.forEach((s) => {
      hubs.push({
        isParkingHub: true,
        lat: s.lat,
        lon: s.lon,
        street: s.street,
        bairro: s.bairro,
        city: s.city,
        streetHint: s.title,
        roadName: "",
        footDistances: {},
        footPairDistances: {},
        usedFootDistance: false,
        stops: [s]
      });
    });

    return hubs;
  }

  function formatWalkingStopParam(stop) {
    if (stop && stop.street && stop.street !== "Desconhecido") {
      return encodeURIComponent(formatStopLabel({ ...stop, isParkingHub: false }));
    }
    return `${stop.lat},${stop.lon}`;
  }

  function buildWalkingTripUrl(hub, tripStops, includeReturnToCar = false) {
    if (!hub || !hub.lat || !hub.lon || !tripStops || tripStops.length === 0) return "#";
    const origin = `${hub.lat},${hub.lon}`;
    const validStops = tripStops.filter((s) => (s.lat && s.lon) || (s.street && s.street !== "Desconhecido"));
    if (validStops.length === 0) return "#";

    if (!includeReturnToCar && validStops.length === 1) {
      const d = validStops[0];
      return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${formatWalkingStopParam(d)}&travelmode=walking`;
    }

    const waypoints = validStops.map(formatWalkingStopParam);
    let destination;
    if (includeReturnToCar) {
      destination = origin;
    } else {
      destination = waypoints.pop();
    }
    const wpParam = waypoints.length > 0 ? `&waypoints=${waypoints.join("%7C")}` : "";
    return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${wpParam}&travelmode=walking`;
  }

  function stopCoordKey(stop) {
    if (!stop) return "";
    return `${stop.title || stop.street || ""}|${stop.lat || 0},${stop.lon || 0}`;
  }

  function getWalkStepMeters(hub, fromStop, toStop) {
    if (!toStop) return 0;
    const toKey = stopCoordKey(toStop);
    if (!fromStop) {
      if (hub && hub.footDistances && typeof hub.footDistances[toKey] === "number") {
        return hub.footDistances[toKey];
      }
      if (typeof toStop.walkDistanceMeters === "number" && toStop.walkDistanceMeters > 0) {
        return toStop.walkDistanceMeters;
      }
      return haversineMeters(hub.lat, hub.lon, toStop.lat, toStop.lon);
    }
    const fromKey = stopCoordKey(fromStop);
    const pairKey = `${fromKey}=>${toKey}`;
    if (hub && hub.footPairDistances && typeof hub.footPairDistances[pairKey] === "number") {
      return hub.footPairDistances[pairKey];
    }
    return haversineMeters(fromStop.lat, fromStop.lon, toStop.lat, toStop.lon);
  }

  // Build capacitated walking trips from a Parking Hub (splitting trips + adding returns to car)
  function buildHubWalkPlan(hub, packageSpecs = {}, results = {}) {
    if (!hub || !hub.stops || hub.stops.length === 0) {
      return { trips: [], walkUrl: "#", returnCount: 0, totalStops: 0, totalPackages: 0 };
    }

    const carryUnits = [];
    let totalPendingPackages = 0;

    hub.stops.forEach((stop) => {
      const pendingItems = (stop.items || []).filter(
        (it) => !results[it.tn] || results[it.tn].status === "pending"
      );
      if (pendingItems.length === 0) return;

      totalPendingPackages += pendingItems.length;
      const itemLoads = pendingItems.map((it) => ({
        item: it,
        ...getItemCarryCost(it, packageSpecs)
      }));

      const stopTotalSize = itemLoads.reduce((a, b) => a + b.sizeUnits, 0);
      const stopTotalWeight = itemLoads.reduce((a, b) => a + b.weightUnits, 0);

      // If all packages at this address fit in 1 single trip capacity, keep them together
      if (
        stopTotalSize <= WALK_TRIP_MAX_SIZE &&
        stopTotalWeight <= WALK_TRIP_MAX_WEIGHT &&
        itemLoads.length <= WALK_TRIP_MAX_ITEMS
      ) {
        carryUnits.push({
          stop,
          items: pendingItems,
          sizeUnits: stopTotalSize,
          weightUnits: stopTotalWeight,
          itemCount: pendingItems.length
        });
      } else {
        // Oversized multi-package address: split packages into carryable sub-batches returning to car
        let curItems = [];
        let curSize = 0;
        let curWeight = 0;
        for (const il of itemLoads) {
          if (
            curItems.length > 0 &&
            (curSize + il.sizeUnits > WALK_TRIP_MAX_SIZE ||
              curWeight + il.weightUnits > WALK_TRIP_MAX_WEIGHT ||
              curItems.length + 1 > WALK_TRIP_MAX_ITEMS)
          ) {
            carryUnits.push({
              stop,
              items: curItems,
              sizeUnits: curSize,
              weightUnits: curWeight,
              itemCount: curItems.length
            });
            curItems = [];
            curSize = 0;
            curWeight = 0;
          }
          curItems.push(il.item);
          curSize += il.sizeUnits;
          curWeight += il.weightUnits;
        }
        if (curItems.length > 0) {
          carryUnits.push({
            stop,
            items: curItems,
            sizeUnits: curSize,
            weightUnits: curWeight,
            itemCount: curItems.length
          });
        }
      }
    });

    if (carryUnits.length === 0) {
      return { trips: [], walkUrl: "#", returnCount: 0, totalStops: 0, totalPackages: 0 };
    }

    const remaining = carryUnits.slice();
    const trips = [];
    let tripNum = 0;

    while (remaining.length > 0) {
      tripNum++;
      const tripUnits = [];
      let remSize = WALK_TRIP_MAX_SIZE;
      let remWeight = WALK_TRIP_MAX_WEIGHT;
      let remItems = WALK_TRIP_MAX_ITEMS;
      let curStop = null;

      while (remaining.length > 0) {
        let bestIdx = -1;
        let bestScore = Infinity;

        for (let i = 0; i < remaining.length; i++) {
          const u = remaining[i];
          const fits =
            tripUnits.length === 0 ||
            (u.sizeUnits <= remSize && u.weightUnits <= remWeight && u.itemCount <= remItems);
          if (!fits) continue;

          const dist = getWalkStepMeters(hub, curStop, u.stop);
          // Slightly prefer dropping heavier/larger parcels earlier when distances are similar
          const heavyBonus = (u.weightUnits * 3 + u.sizeUnits) * 2;
          const score = dist - (tripUnits.length === 0 ? heavyBonus : 0);
          if (score < bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }

        if (bestIdx === -1) break;
        const chosen = remaining.splice(bestIdx, 1)[0];
        tripUnits.push(chosen);
        remSize -= chosen.sizeUnits;
        remWeight -= chosen.weightUnits;
        remItems -= chosen.itemCount;
        if (chosen.stop && chosen.stop.lat && chosen.stop.lon) {
          curStop = chosen.stop;
        }
      }

      const returnToCarAfter = remaining.length > 0;
      const tripStops = [];
      const seenStops = new Set();
      tripUnits.forEach((u) => {
        if (!seenStops.has(u.stop)) {
          seenStops.add(u.stop);
          tripStops.push(u.stop);
        }
      });

      // Compute pedestrian path walk estimate (preferring sidewalk distances over straight-line)
      let walkMeters = 0;
      let prevStop = null;
      tripStops.forEach((st) => {
        walkMeters += getWalkStepMeters(hub, prevStop, st);
        prevStop = st;
      });
      if (returnToCarAfter && prevStop) {
        walkMeters += getWalkStepMeters(hub, null, prevStop);
      }

      trips.push({
        tripNumber: tripNum,
        units: tripUnits,
        stops: tripStops,
        items: tripUnits.flatMap((u) => u.items),
        totalSizeUnits: tripUnits.reduce((a, b) => a + b.sizeUnits, 0),
        totalWeightUnits: tripUnits.reduce((a, b) => a + b.weightUnits, 0),
        returnToCarAfter,
        walkMetersEstimate: Math.round(walkMeters),
        walkUrl: buildWalkingTripUrl(hub, tripStops, returnToCarAfter),
        geometry: null,
        usedFootRouting: false
      });
    }

    const allTripStops = [];
    const seenAll = new Set();
    trips.forEach((tr) => tr.stops.forEach((st) => {
      if (!seenAll.has(st)) {
        seenAll.add(st);
        allTripStops.push(st);
      }
    }));

    return {
      trips,
      returnCount: trips.filter((t) => t.returnToCarAfter).length,
      totalStops: allTripStops.length,
      totalPackages: totalPendingPackages,
      walkUrl: buildWalkingTripUrl(hub, allTripStops, false)
    };
  }

  function buildWalkSegments(stops) {
    if (!stops || stops.length === 0) return [];
    const segments = [];
    const byHub = new Map();
    stops.forEach((s) => {
      if (!s.lat || !s.lon) return;
      const hKey = s.hubId || s.id;
      if (!byHub.has(hKey)) byHub.set(hKey, []);
      byHub.get(hKey).push(s);
    });
    byHub.forEach((hubStops) => {
      const first = hubStops[0];
      let prevLat = first.hubLat || first.lat;
      let prevLon = first.hubLon || first.lon;
      hubStops.forEach((s) => {
        if (s.isWalkStop || haversineMeters(prevLat, prevLon, s.lat, s.lon) > 5) {
          if (haversineMeters(prevLat, prevLon, s.lat, s.lon) > 2) {
            segments.push([[prevLat, prevLon], [s.lat, s.lon]]);
          }
          prevLat = s.lat;
          prevLon = s.lon;
        }
      });
    });
    return segments;
  }

  // Chain clusters offline by street geography (not relying on monotonic door numbering)
  function orderStopsByStreetChain(stops, startPos = null) {
    if (!stops || stops.length === 0) return [];

    const streetsMap = new Map();
    stops.forEach((s) => {
      if (!streetsMap.has(s.street)) streetsMap.set(s.street, []);
      streetsMap.get(s.street).push(s);
    });

    const unvisited = [];
    streetsMap.forEach((streetStops, streetName) => {
      const sortedFwd = orderStopsAlongStreetGeo(streetStops);
      const sortedRev = [...sortedFwd].reverse();
      unvisited.push({
        street: streetName,
        asc: sortedFwd,
        desc: sortedRev,
        startAsc: sortedFwd[0],
        endAsc: sortedFwd[sortedFwd.length - 1],
        startDesc: sortedRev[0],
        endDesc: sortedRev[sortedRev.length - 1]
      });
    });

    const orderedStops = [];
    let currentPos = startPos && startPos.lat && startPos.lon
      ? { lat: startPos.lat, lon: startPos.lon }
      : null;

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

    return orderedStops;
  }

  function calculateRouteMetrics(stops) {
    let totalDistinctAddresses = 0;
    let totalPackages = 0;
    const streetsSet = new Set();

    stops.forEach((s) => {
      streetsSet.add(normalizeStreetKey(s.street));
      totalDistinctAddresses += s.distinctAddresses || countDistinctAddresses(s.items);
      totalPackages += s.items ? s.items.length : 0;
    });

    let totalDistanceMeters = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      totalDistanceMeters += haversineMeters(
        stops[i].lat,
        stops[i].lon,
        stops[i + 1].lat,
        stops[i + 1].lon
      );
    }

    const serviceMinutes = totalDistinctAddresses * 3;
    const totalDistanceKm = parseFloat((totalDistanceMeters / 1000).toFixed(1));
    const transitMinutes = totalDistanceKm > 0
      ? Math.round((totalDistanceKm / 22) * 60)
      : Math.max(0, (stops.length - 1) * 2);
    const estimatedMinutes = serviceMinutes + transitMinutes;
    const estimatedDurationStr = formatDuration(estimatedMinutes);

    return {
      totalPackages,
      streetsCount: streetsSet.size,
      totalDistinctAddresses,
      serviceMinutes,
      transitMinutes,
      totalDistanceKm,
      estimatedMinutes,
      estimatedDurationStr
    };
  }

  function finalizeHubRoute(orderedHubs, packageSpecs = {}, reverse = false, roadData = null, walkPolylines = []) {
    const hubsWorking = reverse ? orderedHubs.slice().reverse() : orderedHubs.slice();
    const orderedStops = [];
    let packageSeq = 0;

    hubsWorking.forEach((hub, hIdx) => {
      hub.hubId = hIdx + 1;
      hub.id = hub.hubId;
      const pkgCount = hub.stops.reduce((sum, s) => sum + (s.items ? s.items.length : 0), 0);
      hub.packageCount = pkgCount;
      hub.addressCount = hub.stops.length;
      hub.label = hub.roadName
        ? `Ponto #${hub.hubId} • ${hub.roadName}`
        : `Ponto #${hub.hubId} (próx. ${hub.streetHint})`;
      hub.title = hub.label;

      const plan = buildHubWalkPlan(hub, packageSpecs, {});
      hub.walkPlan = plan;
      hub.walkUrl = plan.walkUrl;

      // Sort stops in the hub following optimized walking trip order
      const orderedInHub = [];
      const seen = new Set();
      plan.trips.forEach((tr) => {
        tr.stops.forEach((st) => {
          if (!seen.has(st)) {
            seen.add(st);
            st.walkTripNumber = tr.tripNumber;
            orderedInHub.push(st);
          }
        });
      });
      hub.stops.forEach((st) => {
        if (!seen.has(st)) orderedInHub.push(st);
      });
      hub.stops = orderedInHub;

      hub.stops.forEach((s) => {
        const footVal = hub.footDistances && hub.footDistances[stopCoordKey(s)];
        const distFromHub = typeof footVal === "number"
          ? Math.round(footVal)
          : ((hub.lat && hub.lon && s.lat && s.lon)
            ? Math.round(haversineMeters(hub.lat, hub.lon, s.lat, s.lon))
            : 0);
        s.hubId = hub.hubId;
        s.hubLat = hub.lat;
        s.hubLon = hub.lon;
        s.hubLabel = hub.label;
        s.walkDistanceMeters = distFromHub;
        s.walkAnchorTitle = hub.label;
        s.walkClusterSize = hub.stops.length;
        s.isWalkStop = hub.stops.length > 1 || distFromHub > 5;

        s.id = orderedStops.length + 1;
        s.originalId = s.id;
        sortItemsByApartment(s.items);
        s.distinctAddresses = countDistinctAddresses(s.items);
        s.estimatedMinutes = s.distinctAddresses * 3;
        s.items.forEach((it) => {
          packageSeq += 1;
          it.seq = packageSeq;
          it.stopId = s.id;
        });
        orderedStops.push(s);
      });

      hub.stopIds = hub.stops.map((s) => s.id);
    });

    const walkSegments = buildWalkSegments(orderedStops);
    const metrics = calculateRouteMetrics(orderedStops);

    if (roadData && roadData.roadDistanceMeters > 0) {
      metrics.totalDistanceKm = parseFloat((roadData.roadDistanceMeters / 1000).toFixed(1));
      metrics.transitMinutes = Math.max(1, Math.round(roadData.roadDurationSeconds / 60));
      metrics.estimatedMinutes = metrics.serviceMinutes + metrics.transitMinutes;
      metrics.estimatedDurationStr = formatDuration(metrics.estimatedMinutes);
    }

    return {
      hubs: hubsWorking,
      stops: orderedStops,
      walkSegments,
      walkPolylines,
      routeGeometry: roadData && roadData.routeGeometry ? roadData.routeGeometry : null,
      maneuvers: roadData && roadData.maneuvers ? roadData.maneuvers : [],
      usedRoadRouting: !!(roadData && roadData.usedRoadRouting),
      ...metrics
    };
  }

  // Asymmetric Open-Path TSP for directed driving-time matrices (respects one-way streets)
  function solveAsymmetricOpenTsp(durations, fixedStartIdx = null) {
    const n = durations.length;
    if (n <= 1) return n === 1 ? [0] : [];

    const edgeCost = (u, v) => {
      const d = durations[u] && durations[u][v];
      return typeof d === "number" && Number.isFinite(d) ? d : 1e7;
    };

    const tourCost = (order) => {
      let sum = 0;
      for (let i = 0; i < order.length - 1; i++) {
        sum += edgeCost(order[i], order[i + 1]);
      }
      return sum;
    };

    const runNN = (start) => {
      const used = new Uint8Array(n);
      const order = [start];
      used[start] = 1;
      while (order.length < n) {
        const cur = order[order.length - 1];
        let bestNext = -1;
        let bestCost = Infinity;
        for (let j = 0; j < n; j++) {
          if (used[j]) continue;
          const c = edgeCost(cur, j);
          if (c < bestCost) {
            bestCost = c;
            bestNext = j;
          }
        }
        order.push(bestNext);
        used[bestNext] = 1;
      }
      return order;
    };

    let bestOrder = null;
    let bestCost = Infinity;
    const startCandidates = fixedStartIdx !== null ? [fixedStartIdx] : Array.from({ length: n }, (_, i) => i);
    for (const s of startCandidates) {
      const ord = runNN(s);
      const c = tourCost(ord);
      if (c < bestCost) {
        bestCost = c;
        bestOrder = ord;
      }
    }

    // Directed Or-Opt-1 + Directed 2-Opt polish
    const minFixed = fixedStartIdx !== null ? 1 : 0;
    let improved = true;
    let passes = 0;
    while (improved && passes < 6) {
      improved = false;
      passes++;

      // Or-Opt-1: move node at idx to another position
      for (let i = minFixed; i < bestOrder.length; i++) {
        const node = bestOrder[i];
        const without = bestOrder.slice(0, i).concat(bestOrder.slice(i + 1));
        for (let pos = minFixed; pos <= without.length; pos++) {
          if (pos === i) continue;
          const candidate = without.slice(0, pos).concat([node], without.slice(pos));
          const c = tourCost(candidate);
          if (c + 0.5 < bestCost) {
            bestCost = c;
            bestOrder = candidate;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }

      if (improved) continue;

      // Directed 2-Opt: reverse slice [i..j] if directed cost drops
      for (let i = minFixed; i < bestOrder.length - 1; i++) {
        for (let j = i + 1; j < bestOrder.length; j++) {
          const candidate = bestOrder.slice(0, i)
            .concat(bestOrder.slice(i, j + 1).reverse(), bestOrder.slice(j + 1));
          const c = tourCost(candidate);
          if (c + 0.5 < bestCost) {
            bestCost = c;
            bestOrder = candidate;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
    }

    return bestOrder;
  }

  function formatOsrmManeuver(step) {
    if (!step || !step.maneuver) return "";
    const { type, modifier } = step.maneuver;
    const modMap = {
      left: "à esquerda",
      right: "à direita",
      "slight left": "levemente à esquerda",
      "slight right": "levemente à direita",
      "sharp left": "acentuada à esquerda",
      "sharp right": "acentuada à direita",
      straight: "em frente",
      uturn: "o retorno"
    };
    const dir = modMap[modifier] || "";

    let action = "Siga";
    if (type === "turn" || type === "end of road" || type === "fork") {
      action = modifier === "uturn" ? "Faça o retorno" : (dir ? `Vire ${dir}` : "Vire");
    } else if (type === "roundabout" || type === "rotary") {
      action = "Na rotatória, siga";
    } else if (type === "continue" || type === "new name") {
      action = dir ? `Continue ${dir}` : "Continue";
    } else if (type === "depart") {
      action = "Saia pela via";
    } else if (type === "arrive") {
      action = "Chegada na parada";
    }

    const road = step.name ? ` na ${step.name}` : "";
    return `${action}${road}`;
  }

  async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
    if (typeof fetch !== "function") return null;
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (!res || !res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const GEOCODE_CACHE_KEY = "entregas_geocode_cache_v1";
  const memoryGeocodeCache = new Map();

  function loadGeocodeCache() {
    if (memoryGeocodeCache.size > 0) return;
    try {
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem(GEOCODE_CACHE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      Object.entries(obj || {}).forEach(([k, v]) => {
        if (v && v.lat && v.lon) memoryGeocodeCache.set(k, v);
      });
    } catch {}
  }

  function saveGeocodeCache() {
    try {
      if (typeof localStorage === "undefined") return;
      const entries = Array.from(memoryGeocodeCache.entries()).slice(-500);
      localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {}
  }

  function buildAddressQuery(stop) {
    if (!stop || !stop.street || stop.street === "Desconhecido") return "";
    const addr = stop.number ? `${stop.street}, ${stop.number}` : stop.street;
    const bairro = stop.bairro && stop.bairro !== "Não inf." ? stop.bairro : "";
    const city = stop.city && stop.city !== "Não inf." ? stop.city : "";
    const zip = stop.zipcode || "";
    return [addr, bairro, city, zip, "Brasil"].filter(Boolean).join(", ");
  }

  // Primary address geocoder: ArcGIS World Geocoder -> Photon fallback.
  // CSV coordinates are kept only as offline fallback when address lookup returns nothing.
  async function geocodeStopsByAddressAsync(stops) {
    if (!stops || stops.length === 0 || typeof fetch !== "function") return 0;
    loadGeocodeCache();
    let geocodedCount = 0;
    const toFetch = [];

    stops.forEach((s) => {
      if (typeof s.csvLat === "undefined") s.csvLat = s.lat;
      if (typeof s.csvLon === "undefined") s.csvLon = s.lon;
      const q = buildAddressQuery(s);
      if (!q) {
        s.coordSource = "csv-fallback";
        return;
      }
      const key = q.toLowerCase();
      if (memoryGeocodeCache.has(key)) {
        const hit = memoryGeocodeCache.get(key);
        s.lat = hit.lat;
        s.lon = hit.lon;
        s.coordSource = hit.source || "address-cache";
        geocodedCount++;
      } else {
        toFetch.push({ stop: s, query: q, key });
      }
    });

    const batchSize = 10;
    for (let i = 0; i < toFetch.length; i += batchSize) {
      await Promise.all(toFetch.slice(i, i + batchSize).map(async ({ stop, query, key }) => {
        let resolved = null;
        const hasCsvCoords = !!(stop.csvLat && stop.csvLon);
        const arcUrl = `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=1&sourceCountry=BRA&SingleLine=${encodeURIComponent(query)}&outFields=Addr_type`;
        const arcData = await fetchJsonWithTimeout(arcUrl, 4500);
        const cand = arcData && arcData.candidates && arcData.candidates[0];
        if (cand && cand.location && cand.score >= 70) {
          const addrType = cand.attributes && cand.attributes.Addr_type;
          const isExactType = !addrType || addrType === "PointAddress" || addrType === "StreetAddress" || addrType === "Subaddress" || addrType === "BuildingName";
          if (isExactType || !hasCsvCoords) {
            resolved = { lat: cand.location.y, lon: cand.location.x, source: "address-arcgis" };
          }
        }
        if (!resolved && !hasCsvCoords) {
          const phUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`;
          const phData = await fetchJsonWithTimeout(phUrl, 4500);
          const feat = phData && phData.features && phData.features[0];
          if (feat && feat.geometry && Array.isArray(feat.geometry.coordinates)) {
            const [lon, lat] = feat.geometry.coordinates;
            if (lat && lon) resolved = { lat, lon, source: "address-photon" };
          }
        }
        if (resolved) {
          stop.lat = resolved.lat;
          stop.lon = resolved.lon;
          stop.coordSource = resolved.source;
          memoryGeocodeCache.set(key, resolved);
          geocodedCount++;
        } else {
          stop.coordSource = "csv-fallback";
        }
      }));
    }

    if (toFetch.length > 0 && geocodedCount > 0) saveGeocodeCache();
    return geocodedCount;
  }

  // Real sidewalk/road pedestrian distance matrix (meters & seconds) via OpenStreetMap routed-foot
  async function fetchFootDistanceMatrixAsync(points) {
    if (!points || points.length < 2) return null;
    const valid = points.every((p) => p && p.lat && p.lon);
    if (!valid) return null;

    if (points.length <= 100) {
      const coordsStr = points.map((p) => `${p.lon},${p.lat}`).join(";");
      const data = await fetchJsonWithTimeout(
        `https://routing.openstreetmap.de/routed-foot/table/v1/driving/${coordsStr}?annotations=distance,duration`,
        8500
      );
      if (!data || data.code !== "Ok" || !Array.isArray(data.distances)) return null;
      return { distances: data.distances, durations: data.durations || null };
    }

    // For > 100 points, compute overlapping spatial windows of 80 points
    const n = points.length;
    const distances = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (__, j) => (i === j ? 0 : estimateOfflineWalkMeters(points[i], points[j])))
    );
    const indexed = points.map((p, idx) => ({ p, idx })).sort((a, b) => (a.p.lat + a.p.lon) - (b.p.lat + b.p.lon));
    const winSize = 80;
    const step = 60;
    for (let start = 0; start < n; start += step) {
      const slice = indexed.slice(start, start + winSize);
      if (slice.length < 2) break;
      const coordsStr = slice.map((item) => `${item.p.lon},${item.p.lat}`).join(";");
      const data = await fetchJsonWithTimeout(
        `https://routing.openstreetmap.de/routed-foot/table/v1/driving/${coordsStr}?annotations=distance`,
        8500
      );
      if (data && data.code === "Ok" && Array.isArray(data.distances)) {
        for (let r = 0; r < slice.length; r++) {
          for (let c = 0; c < slice.length; c++) {
            const val = data.distances[r] && data.distances[r][c];
            if (typeof val === "number" && Number.isFinite(val)) {
              distances[slice[r].idx][slice[c].idx] = val;
            }
          }
        }
      }
      if (start + winSize >= n) break;
    }
    return { distances, durations: null };
  }

  async function fetchFootDistancePairAsync(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return null;
    const data = await fetchJsonWithTimeout(
      `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`,
      5000
    );
    const route = data && data.code === "Ok" && data.routes && data.routes[0];
    if (!route || typeof route.distance !== "number") return null;
    return {
      distanceMeters: Math.round(route.distance),
      durationSeconds: Math.round(route.duration || 0),
      usedFootRouting: true
    };
  }

  async function populateHubFootMetricsAsync(hub) {
    if (!hub || !hub.stops || hub.stops.length === 0 || !hub.lat || !hub.lon) return;
    const validStops = hub.stops.filter((s) => s.lat && s.lon);
    if (validStops.length === 0) return;

    const mat = await fetchFootDistanceMatrixAsync([hub, ...validStops]);
    if (!mat || !mat.distances) return;

    hub.footDistances = hub.footDistances || {};
    hub.footPairDistances = hub.footPairDistances || {};
    hub.directFootDistances = hub.directFootDistances || {};
    hub.usedFootDistance = true;

    for (let i = 0; i < validStops.length; i++) {
      const sKey = stopCoordKey(validStops[i]);
      const dHub = mat.distances[0] && mat.distances[0][i + 1];
      if (typeof dHub === "number" && Number.isFinite(dHub)) {
        hub.directFootDistances[sKey] = Math.round(dHub);
      }
      for (let j = 0; j < validStops.length; j++) {
        if (i === j) continue;
        const dPair = mat.distances[i + 1] && mat.distances[i + 1][j + 1];
        if (typeof dPair === "number" && Number.isFinite(dPair)) {
          hub.footPairDistances[`${sKey}=>${stopCoordKey(validStops[j])}`] = Math.round(dPair);
        }
      }
    }

    // Compute cumulative sequential walking path (percurso) along the stops in this hub
    let cumPercurso = 0;
    for (let i = 0; i < validStops.length; i++) {
      const curKey = stopCoordKey(validStops[i]);
      if (i === 0) {
        const d0 = hub.directFootDistances[curKey];
        cumPercurso = typeof d0 === "number" ? d0 : Math.round(estimateOfflineWalkMeters(hub, validStops[0]));
      } else {
        const prevKey = stopCoordKey(validStops[i - 1]);
        const dStep = hub.footPairDistances[`${prevKey}=>${curKey}`];
        cumPercurso += typeof dStep === "number"
          ? dStep
          : Math.round(estimateOfflineWalkMeters(validStops[i - 1], validStops[i]));
      }
      hub.footDistances[curKey] = Math.round(cumPercurso);
    }
  }

  // Max-coverage Parking Hubs validated strictly by REAL sidewalk route distance (percurso <= walkRadiusMeters)
  async function buildParkingHubsAsync(stops, walkRadiusMeters = 0) {
    if (!stops || stops.length === 0 || walkRadiusMeters <= 0 || typeof fetch !== "function") {
      const initial = buildParkingHubs(stops, walkRadiusMeters);
      await snapHubsToRoadAsync(initial, walkRadiusMeters);
      return initial;
    }

    const withCoords = stops.filter((s) => s.lat && s.lon);
    const allFootMat = withCoords.length >= 2 && withCoords.length <= 35
      ? await fetchFootDistanceMatrixAsync(withCoords)
      : null;

    const initialHubs = buildParkingHubs(stops, walkRadiusMeters, allFootMat ? allFootMat.distances : null);
    await snapHubsToRoadAsync(initialHubs, walkRadiusMeters);

    // Verify cumulative sidewalk walking path (percurso) from each snapped Parking Hub through its stops
    const multiHubs = initialHubs.filter((h) => h.stops && h.stops.length > 1);
    for (let i = 0; i < multiHubs.length; i += 4) {
      await Promise.all(multiHubs.slice(i, i + 4).map((hub) => populateHubFootMetricsAsync(hub)));
    }

    const keptHubs = [];
    const evictedStops = [];

    initialHubs.forEach((hub) => {
      if (!hub.stops || hub.stops.length <= 1) {
        if (hub.stops && hub.stops[0]) {
          hub.footDistances = { [stopCoordKey(hub.stops[0])]: 0 };
        }
        keptHubs.push(hub);
        return;
      }

      const staying = [];
      let cumPercurso = 0;

      hub.stops.forEach((st) => {
        const sKey = stopCoordKey(st);
        const directDist = hub.directFootDistances && typeof hub.directFootDistances[sKey] === "number"
          ? hub.directFootDistances[sKey]
          : Math.round(estimateOfflineWalkMeters(hub, st));

        let stepDist;
        if (staying.length === 0) {
          stepDist = directDist;
        } else {
          const prevStop = staying[staying.length - 1];
          const pairKey = `${stopCoordKey(prevStop)}=>${sKey}`;
          stepDist = (hub.footPairDistances && typeof hub.footPairDistances[pairKey] === "number")
            ? hub.footPairDistances[pairKey]
            : Math.round(estimateOfflineWalkMeters(prevStop, st));
        }

        if (directDist <= walkRadiusMeters && cumPercurso + stepDist <= walkRadiusMeters) {
          cumPercurso += stepDist;
          hub.footDistances[sKey] = Math.round(cumPercurso);
          staying.push(st);
        } else {
          evictedStops.push(st);
        }
      });

      if (staying.length > 0) {
        if (staying.length === 1) {
          hub.lat = staying[0].lat;
          hub.lon = staying[0].lon;
          hub.footDistances[stopCoordKey(staying[0])] = 0;
        }
        hub.stops = staying;
        keptHubs.push(hub);
      }
    });

    // Any stop evicted because its sidewalk percurso exceeded walkRadiusMeters gets its own validated hub(s)
    if (evictedStops.length > 0) {
      evictedStops.forEach((st) => {
        const sKey = stopCoordKey(st);
        keptHubs.push({
          isParkingHub: true,
          lat: st.lat,
          lon: st.lon,
          street: st.street,
          bairro: st.bairro,
          city: st.city,
          streetHint: st.title,
          roadName: "",
          footDistances: { [sKey]: 0 },
          footPairDistances: {},
          usedFootDistance: true,
          stops: [st]
        });
      });
    }

    return keptHubs;
  }

  async function snapHubsToRoadAsync(hubs, walkRadiusMeters = 0) {
    if (!hubs || hubs.length === 0 || walkRadiusMeters <= 0) return hubs;
    const batchSize = 4;
    for (let i = 0; i < hubs.length; i += batchSize) {
      await Promise.all(hubs.slice(i, i + batchSize).map(async (hub) => {
        if (!hub.lat || !hub.lon) return;
        const data = await fetchJsonWithTimeout(
          `https://router.project-osrm.org/nearest/v1/driving/${hub.lon},${hub.lat}`,
          4500
        );
        const wp = data && data.code === "Ok" && data.waypoints && data.waypoints[0];
        if (!wp || !Array.isArray(wp.location)) return;
        const [sLon, sLat] = wp.location;
        if (wp.name) hub.roadName = wp.name;
        const validSnap = hub.stops.every(
          (st) => !st.lat || !st.lon || haversineMeters(sLat, sLon, st.lat, st.lon) <= walkRadiusMeters + 15
        );
        if (validSnap) {
          hub.lat = sLat;
          hub.lon = sLon;
        }
      }));
    }
    return hubs;
  }

  async function optimizeHubsWithOsrm(hubs, userLocation = null) {
    if (!hubs || hubs.length <= 1) return hubs;
    const valid = hubs.filter((h) => h.lat && h.lon);
    const invalid = hubs.filter((h) => !h.lat || !h.lon);
    if (valid.length <= 1 || valid.length > 85) return null;

    const hasOrigin = !!(userLocation && (userLocation.latitude || userLocation.lat) && (userLocation.longitude || userLocation.lon));
    const originLat = hasOrigin ? (userLocation.latitude || userLocation.lat) : null;
    const originLon = hasOrigin ? (userLocation.longitude || userLocation.lon) : null;

    const coordPoints = hasOrigin
      ? [{ lat: originLat, lon: originLon }, ...valid]
      : valid;

    const coordsStr = coordPoints.map((p) => `${p.lon},${p.lat}`).join(";");
    const data = await fetchJsonWithTimeout(
      `https://router.project-osrm.org/table/v1/driving/${coordsStr}?annotations=duration`
    );
    if (!data || data.code !== "Ok" || !Array.isArray(data.durations)) return null;

    const order = solveAsymmetricOpenTsp(data.durations, hasOrigin ? 0 : null);
    const orderedValid = order
      .filter((idx) => !(hasOrigin && idx === 0))
      .map((idx) => valid[hasOrigin ? idx - 1 : idx])
      .filter(Boolean);

    return orderedValid.concat(invalid);
  }

  // Fetch road driving geometry connecting Parking Hubs strictly along roadways
  async function fetchRoadDataForHubs(hubs) {
    if (!hubs || hubs.length < 2) return null;
    const drivingPoints = hubs.filter((h) => h.lat && h.lon);
    if (drivingPoints.length < 2) return null;

    const chunkSize = 45;
    const combinedCoords = [];
    const maneuvers = [];
    let totalDist = 0;
    let totalDur = 0;

    for (let i = 0; i < drivingPoints.length; i += (chunkSize - 1)) {
      const slice = drivingPoints.slice(i, i + chunkSize);
      if (slice.length < 2) break;
      const coordsStr = slice.map((p) => `${p.lon},${p.lat}`).join(";");
      const data = await fetchJsonWithTimeout(
        `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true`
      );
      if (!data || data.code !== "Ok" || !data.routes || !data.routes[0]) {
        return null;
      }

      const route = data.routes[0];
      totalDist += route.distance || 0;
      totalDur += route.duration || 0;

      const geoCoords = (route.geometry && route.geometry.coordinates) || [];
      geoCoords.forEach(([lon, lat], idx) => {
        if (combinedCoords.length > 0 && idx === 0) return;
        combinedCoords.push([lat, lon]);
      });

      (route.legs || []).forEach((leg, legIdx) => {
        const destHub = slice[legIdx + 1];
        (leg.steps || []).forEach((step) => {
          if (!step.maneuver || !step.maneuver.location) return;
          const [mLon, mLat] = step.maneuver.location;
          maneuvers.push({
            lat: mLat,
            lon: mLon,
            instruction: formatOsrmManeuver(step),
            distanceMeters: Math.round(step.distance || 0),
            toHubId: destHub ? destHub.hubId : null,
            toStopId: destHub && destHub.stopIds ? destHub.stopIds[0] : (destHub ? destHub.id : null)
          });
        });
      });

      if (i + chunkSize >= drivingPoints.length) break;
    }

    if (combinedCoords.length < 2) return null;
    return {
      routeGeometry: combinedCoords,
      roadDistanceMeters: totalDist,
      roadDurationSeconds: totalDur,
      maneuvers,
      usedRoadRouting: true
    };
  }

  // Fetch real sidewalk/pedestrian polylines for every walking trip inside each Parking Hub
  async function fetchWalkGeometriesForHubsAsync(hubs) {
    if (!hubs || hubs.length === 0) return [];
    const walkPolylines = [];
    const tasks = [];

    hubs.forEach((hub) => {
      if (!hub.walkPlan || !hub.walkPlan.trips || !hub.lat || !hub.lon) return;
      hub.walkPlan.trips.forEach((trip) => {
        const waypoints = [{ lat: hub.lat, lon: hub.lon }];
        trip.stops.forEach((st) => {
          if (!st.lat || !st.lon) return;
          const last = waypoints[waypoints.length - 1];
          if (haversineMeters(last.lat, last.lon, st.lat, st.lon) > 2) {
            waypoints.push({ lat: st.lat, lon: st.lon });
          }
        });
        if (trip.returnToCarAfter) {
          waypoints.push({ lat: hub.lat, lon: hub.lon });
        }
        if (waypoints.length < 2) return;

        tasks.push(async () => {
          const coordsStr = waypoints.map((p) => `${p.lon},${p.lat}`).join(";");
          const data = await fetchJsonWithTimeout(
            `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`,
            5500
          );
          if (data && data.code === "Ok" && data.routes && data.routes[0] && data.routes[0].geometry) {
            trip.geometry = data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
            trip.usedFootRouting = true;
            if (data.routes[0].distance) {
              trip.walkMetersEstimate = Math.round(data.routes[0].distance);
            }
          } else {
            trip.geometry = waypoints.map((p) => [p.lat, p.lon]);
            trip.usedFootRouting = false;
          }
          walkPolylines.push({
            hubId: hub.hubId,
            tripNumber: trip.tripNumber,
            coords: trip.geometry,
            usedFootRouting: trip.usedFootRouting
          });
        });
      });
    });

    const concurrency = 4;
    for (let i = 0; i < tasks.length; i += concurrency) {
      await Promise.all(tasks.slice(i, i + concurrency).map((fn) => fn()));
    }

    return walkPolylines;
  }

  function fetchRoadDataForStops(stops) {
    return fetchRoadDataForHubs((stops || []).filter((s) => !s.isWalkStop));
  }

  function groupRowsIntoPhysicalStops(rows) {
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
      const apartmentInfo = extractApartmentInfo(complement, r.address);
      stopMap.get(key).items.push({
        tn: r.tn,
        address: r.address,
        complement: complement || "Sem complemento",
        atId: r.atId || "",
        recipient: r.recipient || "",
        notes: r.notes || "",
        sortCode: r.sortCode || "",
        size: r.size || "m",
        weight: r.weight || "light",
        apartmentInfo
      });
    });
    return Array.from(stopMap.values());
  }

  // Synchronous route builder based on Parking Hubs (offline-ready)
  function buildOptimizedRoute(rows, options = {}) {
    if (!rows || rows.length === 0) {
      return { hubs: [], stops: [], totalPackages: 0, streets: [], walkSegments: [], walkPolylines: [], routeGeometry: null, maneuvers: [], usedRoadRouting: false };
    }

    const physicalStops = groupRowsIntoPhysicalStops(rows);
    const hubs = buildParkingHubs(physicalStops, options.maxWalkDistanceMeters || 0);
    const hubStartPos = options.userLocation
      ? { lat: options.userLocation.latitude || options.userLocation.lat, lon: options.userLocation.longitude || options.userLocation.lon }
      : null;
    const orderedHubs = orderStopsByStreetChain(hubs, hubStartPos);

    return finalizeHubRoute(orderedHubs, options.packageSpecs || {}, !!options.reverse, null, []);
  }

  // Asynchronous road-network optimizer:
  // 1) Geocodes delivery stops primarily from street addresses (CSV lat/lon only as offline fallback)
  // 2) Computes max-coverage Parking Hubs verified by real sidewalk distances (routed-foot) & snaps to street
  // 3) Routes strictly between Parking Hubs following one-way street flow (OSRM)
  // 4) Plans capacitated walking trips + real sidewalk paths (routed-foot) from each Parking Hub
  async function buildOptimizedRouteAsync(rows, options = {}) {
    if (!rows || rows.length === 0) {
      return { hubs: [], stops: [], totalPackages: 0, streets: [], walkSegments: [], walkPolylines: [], routeGeometry: null, maneuvers: [], usedRoadRouting: false, geocodedCount: 0, usedFootDistance: false };
    }

    const walkRadius = options.maxWalkDistanceMeters || 0;
    const physicalStops = groupRowsIntoPhysicalStops(rows);
    const geocodedCount = await geocodeStopsByAddressAsync(physicalStops);
    const hubs = await buildParkingHubsAsync(physicalStops, walkRadius);
    const usedFootDistance = hubs.some((h) => !!h.usedFootDistance);

    let orderedHubs = await optimizeHubsWithOsrm(hubs, options.userLocation);
    if (!orderedHubs) {
      const hubStartPos = options.userLocation
        ? { lat: options.userLocation.latitude || options.userLocation.lat, lon: options.userLocation.longitude || options.userLocation.lon }
        : null;
      orderedHubs = orderStopsByStreetChain(hubs, hubStartPos);
    }

    const finalized = finalizeHubRoute(orderedHubs, options.packageSpecs || {}, !!options.reverse, null, []);
    const [roadData, walkPolylines] = await Promise.all([
      fetchRoadDataForHubs(finalized.hubs),
      fetchWalkGeometriesForHubsAsync(finalized.hubs)
    ]);

    const metrics = roadData
      ? {
          ...calculateRouteMetrics(finalized.stops),
          totalDistanceKm: parseFloat((roadData.roadDistanceMeters / 1000).toFixed(1)),
          transitMinutes: Math.max(1, Math.round(roadData.roadDurationSeconds / 60))
        }
      : {};
    if (roadData) {
      metrics.estimatedMinutes = metrics.serviceMinutes + metrics.transitMinutes;
      metrics.estimatedDurationStr = formatDuration(metrics.estimatedMinutes);
    }

    return {
      ...finalized,
      ...metrics,
      geocodedCount,
      usedFootDistance: usedFootDistance || !!(walkPolylines && walkPolylines.some((w) => w.usedFootRouting)),
      walkPolylines: walkPolylines || [],
      routeGeometry: roadData ? roadData.routeGeometry : null,
      maneuvers: roadData ? roadData.maneuvers : [],
      usedRoadRouting: !!(roadData && roadData.usedRoadRouting)
    };
  }

  /**
   * Find closest pending stop within maxWalkMeters from originCoords,
   * strictly excluding current stop, the immediate next pending stop, and any stop on the same street.
   */
  function findNearbyWalkCandidate(stops, activeStopIdx, originCoords, maxWalkMeters, results = {}, dismissedKeys = {}) {
    if (!stops || stops.length === 0 || !maxWalkMeters || maxWalkMeters <= 0) return null;
    const currentStop = stops[activeStopIdx];
    if (!currentStop) return null;

    const origin = originCoords && originCoords.lat && originCoords.lon
      ? originCoords
      : (currentStop.lat && currentStop.lon ? { lat: currentStop.lat, lon: currentStop.lon } : null);
    if (!origin) return null;

    const hasPendingItem = (stop) =>
      stop && stop.items && stop.items.some((it) => !results[it.tn] || results[it.tn].status === "pending");

    // Immediate next pending delivery in queue
    let nextPendingIdx = -1;
    for (let k = activeStopIdx + 1; k < stops.length; k++) {
      if (hasPendingItem(stops[k])) {
        nextPendingIdx = k;
        break;
      }
    }

    const currentStreetKey = normalizeStreetKey(currentStop.street);
    let best = null;

    for (let i = 0; i < stops.length; i++) {
      if (i === activeStopIdx || i === nextPendingIdx) continue;
      const cand = stops[i];
      if (!cand || !cand.lat || !cand.lon) continue;
      if (!hasPendingItem(cand)) continue;

      if (currentStreetKey && normalizeStreetKey(cand.street) === currentStreetKey) {
        continue;
      }

      const pairKey = `${currentStop.originalId || currentStop.id}->${cand.originalId || cand.id}`;
      if (dismissedKeys && dismissedKeys[pairKey]) continue;

      const dist = Math.round(haversineMeters(origin.lat, origin.lon, cand.lat, cand.lon));
      if (dist <= maxWalkMeters && (!best || dist < best.distanceMeters)) {
        best = {
          stop: cand,
          stopIndex: i,
          distanceMeters: dist,
          pairKey
        };
      }
    }

    return best;
  }

  /**
   * Real-time walk shortcut validator using actual pedestrian sidewalk routing (routed-foot).
   * Uses straight-line distance strictly as a mathematical lower-bound pre-filter.
   */
  async function findNearbyWalkCandidateAsync(stops, activeStopIdx, originCoords, maxWalkMeters, results = {}, dismissedKeys = {}) {
    if (!stops || stops.length === 0 || !maxWalkMeters || maxWalkMeters <= 0) return null;
    const currentStop = stops[activeStopIdx];
    if (!currentStop) return null;

    const origin = originCoords && originCoords.lat && originCoords.lon
      ? originCoords
      : (currentStop.lat && currentStop.lon ? { lat: currentStop.lat, lon: currentStop.lon } : null);
    if (!origin) return null;

    const hasPendingItem = (stop) =>
      stop && stop.items && stop.items.some((it) => !results[it.tn] || results[it.tn].status === "pending");

    let nextPendingIdx = -1;
    for (let k = activeStopIdx + 1; k < stops.length; k++) {
      if (hasPendingItem(stops[k])) {
        nextPendingIdx = k;
        break;
      }
    }

    const currentStreetKey = normalizeStreetKey(currentStop.street);
    const shortlist = [];

    for (let i = 0; i < stops.length; i++) {
      if (i === activeStopIdx || i === nextPendingIdx) continue;
      const cand = stops[i];
      if (!cand || !cand.lat || !cand.lon) continue;
      if (!hasPendingItem(cand)) continue;
      if (currentStreetKey && normalizeStreetKey(cand.street) === currentStreetKey) continue;

      const pairKey = `${currentStop.originalId || currentStop.id}->${cand.originalId || cand.id}`;
      if (dismissedKeys && dismissedKeys[pairKey]) continue;

      const lowerBound = haversineMeters(origin.lat, origin.lon, cand.lat, cand.lon);
      if (lowerBound <= maxWalkMeters + 15) {
        shortlist.push({ stop: cand, stopIndex: i, lowerBound, pairKey });
      }
    }

    shortlist.sort((a, b) => a.lowerBound - b.lowerBound);
    let best = null;
    for (const item of shortlist.slice(0, 6)) {
      const foot = await fetchFootDistancePairAsync(origin.lat, origin.lon, item.stop.lat, item.stop.lon);
      const dist = foot ? foot.distanceMeters : Math.round(item.lowerBound);
      const usedFoot = !!foot;
      if (dist <= maxWalkMeters && (!best || dist < best.distanceMeters)) {
        best = {
          stop: item.stop,
          stopIndex: item.stopIndex,
          distanceMeters: dist,
          usedFootRouting: usedFoot,
          pairKey: item.pairKey
        };
      }
    }
    return best;
  }

  /**
   * Remove an early-walked stop from the queue and re-optimize remaining upcoming stops.
   */
  function recalculateRouteAfterWalk(stops, activeStopIdx, walkedStopIdx, originPos = null) {
    if (!stops || walkedStopIdx < 0 || walkedStopIdx >= stops.length) return null;

    const working = stops.slice();
    const [walkedStop] = working.splice(walkedStopIdx, 1);

    let newActiveIdx = walkedStopIdx < activeStopIdx ? activeStopIdx - 1 : activeStopIdx;
    if (working.length === 0) {
      return {
        walkedStop,
        stops: [],
        newActiveIdx: 0,
        metrics: calculateRouteMetrics([])
      };
    }

    newActiveIdx = Math.max(0, Math.min(newActiveIdx, working.length - 1));
    const prefix = working.slice(0, newActiveIdx + 1);
    const tail = working.slice(newActiveIdx + 1);

    const anchorStop = working[newActiveIdx];
    const startPos = (originPos && originPos.lat && originPos.lon)
      ? originPos
      : (anchorStop && anchorStop.lat && anchorStop.lon ? anchorStop : null);

    const optimizedTail = tail.length > 1 ? orderStopsByStreetChain(tail, startPos) : tail;
    const newStops = [...prefix, ...optimizedTail];

    newStops.forEach((s, idx) => {
      if (!s.originalId) s.originalId = s.id;
      s.id = idx + 1;
      s.items.forEach((it) => {
        it.stopId = s.id;
      });
    });

    return {
      walkedStop,
      stops: newStops,
      newActiveIdx,
      walkSegments: buildWalkSegments(newStops),
      metrics: calculateRouteMetrics(newStops)
    };
  }

  // Named address label for stops (primary source) & Parking Hub routing target
  function formatStopLabel(point) {
    if (!point) return "";
    if (point.isParkingHub) {
      if (point.stops && point.stops.length === 1 && point.stops[0].street && point.stops[0].street !== "Desconhecido") {
        return formatStopLabel(point.stops[0]);
      }
      if (point.lat && point.lon) {
        return `${point.lat},${point.lon}`;
      }
    }
    if (!point.title && point.lat && point.lon) {
      return `${point.lat},${point.lon}`;
    }
    const address = point.title || (point.number ? `${point.street}, ${point.number}` : point.street);
    const bairro = point.bairro && point.bairro !== "Não inf." ? point.bairro : "";
    let city = point.city && point.city !== "Não inf." ? point.city : "";
    if (city && !city.includes("-") && !city.includes("/")) {
      city = `${city} - PR`;
    }
    const parts = [address, bairro, city].filter(Boolean);
    return parts.join(", ");
  }

  // Google Maps multi-stop URL builder (routes Parking Hubs when available)
  function buildGoogleMapsRouteUrl(points, startIdx = 0, count = null) {
    if (!points || points.length === 0) return "#";
    const slice = count ? points.slice(startIdx, startIdx + count) : points.slice(startIdx);
    if (slice.length === 0) return "#";

    const segments = slice.map((p) => encodeURIComponent(formatStopLabel(p)));
    return "https://www.google.com/maps/dir/" + segments.join("/") + "/";
  }

  function buildSingleStopGoogleMapsUrl(point) {
    if (!point) return "#";
    if (point.isParkingHub && point.stops && point.stops.length > 1) {
      return `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lon}&travelmode=driving`;
    }
    const query = encodeURIComponent(formatStopLabel(point));
    return `https://www.google.com/maps/dir/?api=1&destination=${query}&travelmode=driving`;
  }

  function buildWazeUrl(point) {
    if (point.lat && point.lon && point.lat !== 0 && point.lon !== 0) {
      return `https://waze.com/ul?ll=${point.lat},${point.lon}&navigate=yes`;
    }
    const query = encodeURIComponent(formatStopLabel(point));
    return `https://waze.com/ul?q=${query}&navigate=yes`;
  }

  return {
    parseCSV,
    buildOptimizedRoute,
    buildOptimizedRouteAsync,
    fetchRoadDataForHubs,
    fetchRoadDataForStops,
    fetchWalkGeometriesForHubsAsync,
    geocodeStopsByAddressAsync,
    fetchFootDistanceMatrixAsync,
    fetchFootDistancePairAsync,
    buildParkingHubs,
    buildParkingHubsAsync,
    buildHubWalkPlan,
    buildWalkingTripUrl,
    buildWalkSegments,
    normalizePackageSize,
    normalizePackageWeight,
    PACKAGE_SIZE_LABELS,
    PACKAGE_WEIGHT_LABELS,
    solveAsymmetricOpenTsp,
    orderStopsAlongStreetGeo,
    findNearbyWalkCandidate,
    findNearbyWalkCandidateAsync,
    recalculateRouteAfterWalk,
    normalizeStreetKey,
    formatStopLabel,
    buildGoogleMapsRouteUrl,
    buildSingleStopGoogleMapsUrl,
    buildWazeUrl,
    haversineMeters,
    extractApartmentInfo,
    sortItemsByApartment,
    countDistinctAddresses,
    formatDuration
  };
})();

if (typeof window !== "undefined") {
  window.RouteOptimizer = RouteOptimizer;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = RouteOptimizer;
}
