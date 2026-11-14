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
      tn: headers.findIndex((h) => h.includes("spxtn") || h.includes("tn") || h.includes("rastreio") || h.includes("pacote")),
      address: headers.findIndex((h) => h.includes("destinationaddress") || h.includes("address") || h.includes("endereco")),
      bairro: headers.findIndex((h) => h.includes("bairro") || h.includes("neighborhood")),
      city: headers.findIndex((h) => h.includes("city") || h.includes("cidade")),
      zipcode: headers.findIndex((h) => h.includes("zip") || h.includes("cep") || h.includes("postal")),
      lat: headers.findIndex((h) => h.includes("latitude") || h.includes("lat")),
      lon: headers.findIndex((h) => h.includes("longitude") || h.includes("lon") || h.includes("lng")),
      atId: headers.findIndex((h) => h.includes("atid") || h.includes("id")),
      recipient: headers.findIndex((h) => h.includes("buyer") || h.includes("destinatario") || h.includes("receiver") || h.includes("recipient") || h.includes("cliente") || h === "nome"),
      notes: headers.findIndex((h) => h.includes("remark") || h.includes("observa") || h.includes("obs") || h.includes("instruc") || h.includes("referencia") || h.includes("note")),
      sortCode: headers.findIndex((h) => h.includes("sortcode") || h.includes("gaiola") || h.includes("corredor") || h.includes("zona") || h.includes("zone") || h.includes("lote"))
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

      rows.push({ tn, address: rawAddress, bairro, city, zipcode, lat, lon, atId, recipient, notes, sortCode });
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

  // Group nearby stops within walkRadiusMeters around dense parking anchors
  function buildWalkClusters(stops, walkRadiusMeters = 0) {
    if (!stops || stops.length === 0) return [];
    const radius = Math.max(0, parseInt(walkRadiusMeters, 10) || 0);

    const cloned = stops.map((s) => ({
      ...s,
      isWalkStop: false,
      walkFromStopId: null,
      walkAnchorTitle: "",
      walkDistanceMeters: 0,
      walkClusterSize: 1
    }));

    if (radius <= 0) {
      return cloned.map((s) => ({ anchor: s, stops: [s] }));
    }

    const withCoords = [];
    const withoutCoords = [];
    cloned.forEach((s) => {
      if (s.lat && s.lon) withCoords.push(s);
      else withoutCoords.push(s);
    });

    const assigned = new Set();
    const clusters = [];

    while (assigned.size < withCoords.length) {
      let bestIdx = -1;
      let bestNeighbors = [];

      for (let i = 0; i < withCoords.length; i++) {
        if (assigned.has(i)) continue;
        const neighbors = [];
        for (let j = 0; j < withCoords.length; j++) {
          if (i === j || assigned.has(j)) continue;
          const d = haversineMeters(
            withCoords[i].lat,
            withCoords[i].lon,
            withCoords[j].lat,
            withCoords[j].lon
          );
          if (d <= radius) neighbors.push(j);
        }
        if (neighbors.length > bestNeighbors.length || bestIdx === -1) {
          bestIdx = i;
          bestNeighbors = neighbors;
        }
      }

      if (bestIdx === -1) break;
      assigned.add(bestIdx);
      const anchor = withCoords[bestIdx];
      const clusterIndices = [];
      bestNeighbors.forEach((j) => {
        assigned.add(j);
        clusterIndices.push(j);
      });

      // Chain walk stops from anchor by nearest walking hop
      const clusterStops = [anchor];
      const pendingWalk = clusterIndices.map((idx) => withCoords[idx]);
      let walkPos = anchor;
      while (pendingWalk.length > 0) {
        let nearIdx = 0;
        let nearDist = Infinity;
        for (let k = 0; k < pendingWalk.length; k++) {
          const d = haversineMeters(walkPos.lat, walkPos.lon, pendingWalk[k].lat, pendingWalk[k].lon);
          if (d < nearDist) {
            nearDist = d;
            nearIdx = k;
          }
        }
        const nextWalk = pendingWalk.splice(nearIdx, 1)[0];
        nextWalk.isWalkStop = true;
        nextWalk.walkAnchorTitle = anchor.title;
        nextWalk.walkDistanceMeters = Math.round(
          haversineMeters(anchor.lat, anchor.lon, nextWalk.lat, nextWalk.lon)
        );
        clusterStops.push(nextWalk);
        walkPos = nextWalk;
      }

      clusterStops.forEach((st) => {
        st.walkClusterSize = clusterStops.length;
      });
      clusters.push({ anchor, stops: clusterStops });
    }

    withoutCoords.forEach((s) => clusters.push({ anchor: s, stops: [s] }));
    return clusters;
  }

  function buildWalkSegments(stops) {
    if (!stops || stops.length === 0) return [];
    const segments = [];
    let activeAnchor = null;
    stops.forEach((s) => {
      if (!s.isWalkStop) {
        activeAnchor = s;
      } else if (activeAnchor && activeAnchor.lat && activeAnchor.lon && s.lat && s.lon) {
        s.walkFromStopId = activeAnchor.id || null;
        s.walkAnchorTitle = activeAnchor.title || s.walkAnchorTitle;
        segments.push([[activeAnchor.lat, activeAnchor.lon], [s.lat, s.lon]]);
      }
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

  function flattenClustersWithAnchorChain(clusters, orderedAnchors) {
    const clusterByAnchor = new Map();
    clusters.forEach((c) => clusterByAnchor.set(c.anchor, c));
    const orderedStops = [];
    orderedAnchors.forEach((a) => {
      const cluster = clusterByAnchor.get(a);
      if (cluster) {
        cluster.stops.forEach((st) => orderedStops.push(st));
      } else {
        orderedStops.push(a);
      }
    });
    return orderedStops;
  }

  function finalizeOrderedStops(orderedStops, reverse = false, roadData = null) {
    if (reverse) {
      orderedStops.reverse();
    }

    let packageSeq = 0;
    orderedStops.forEach((s, idx) => {
      s.id = idx + 1;
      s.originalId = s.id;
      sortItemsByApartment(s.items);
      s.distinctAddresses = countDistinctAddresses(s.items);
      s.estimatedMinutes = s.distinctAddresses * 3;

      s.items.forEach((it) => {
        packageSeq += 1;
        it.seq = packageSeq;
        it.stopId = s.id;
      });
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
      stops: orderedStops,
      walkSegments,
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

  async function optimizeClustersWithOsrm(clusters, userLocation = null) {
    if (!clusters || clusters.length <= 1) return clusters;
    const valid = clusters.filter((c) => c.anchor && c.anchor.lat && c.anchor.lon);
    const invalid = clusters.filter((c) => !c.anchor || !c.anchor.lat || !c.anchor.lon);
    if (valid.length <= 1 || valid.length > 85) return null;

    const hasOrigin = !!(userLocation && (userLocation.latitude || userLocation.lat) && (userLocation.longitude || userLocation.lon));
    const originLat = hasOrigin ? (userLocation.latitude || userLocation.lat) : null;
    const originLon = hasOrigin ? (userLocation.longitude || userLocation.lon) : null;

    const coordPoints = hasOrigin
      ? [{ lat: originLat, lon: originLon }, ...valid.map((c) => c.anchor)]
      : valid.map((c) => c.anchor);

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

  async function fetchRoadDataForStops(stops) {
    if (!stops || stops.length < 2) return null;
    const drivingStops = stops.filter((s) => !s.isWalkStop && s.lat && s.lon);
    if (drivingStops.length < 2) return null;

    const chunkSize = 45;
    const combinedCoords = [];
    const maneuvers = [];
    let totalDist = 0;
    let totalDur = 0;

    for (let i = 0; i < drivingStops.length; i += (chunkSize - 1)) {
      const slice = drivingStops.slice(i, i + chunkSize);
      if (slice.length < 2) break;
      const coordsStr = slice.map((s) => `${s.lon},${s.lat}`).join(";");
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
        const destStop = slice[legIdx + 1];
        (leg.steps || []).forEach((step) => {
          if (!step.maneuver || !step.maneuver.location) return;
          const [mLon, mLat] = step.maneuver.location;
          maneuvers.push({
            lat: mLat,
            lon: mLon,
            instruction: formatOsrmManeuver(step),
            distanceMeters: Math.round(step.distance || 0),
            toStopId: destStop ? destStop.id : null
          });
        });
      });

      if (i + chunkSize >= drivingStops.length) break;
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
        apartmentInfo
      });
    });
    return Array.from(stopMap.values());
  }

  // Synchronous route builder (offline-ready, supports walk-radius clustering)
  function buildOptimizedRoute(rows, options = {}) {
    if (!rows || rows.length === 0) {
      return { stops: [], totalPackages: 0, streets: [], walkSegments: [], routeGeometry: null, maneuvers: [], usedRoadRouting: false };
    }

    const physicalStops = groupRowsIntoPhysicalStops(rows);
    const clusters = buildWalkClusters(physicalStops, options.maxWalkDistanceMeters || 0);
    const anchorStartPos = options.userLocation
      ? { lat: options.userLocation.latitude || options.userLocation.lat, lon: options.userLocation.longitude || options.userLocation.lon }
      : null;
    const orderedAnchors = orderStopsByStreetChain(clusters.map((c) => c.anchor), anchorStartPos);
    const orderedStops = flattenClustersWithAnchorChain(clusters, orderedAnchors);

    return finalizeOrderedStops(orderedStops, !!options.reverse, null);
  }

  // Asynchronous road-network optimizer: follows one-way street flow (OSRM) + walk-radius clustering
  async function buildOptimizedRouteAsync(rows, options = {}) {
    if (!rows || rows.length === 0) {
      return { stops: [], totalPackages: 0, streets: [], walkSegments: [], routeGeometry: null, maneuvers: [], usedRoadRouting: false };
    }

    const physicalStops = groupRowsIntoPhysicalStops(rows);
    const clusters = buildWalkClusters(physicalStops, options.maxWalkDistanceMeters || 0);
    let orderedClusters = await optimizeClustersWithOsrm(clusters, options.userLocation);

    let orderedStops;
    if (orderedClusters) {
      orderedStops = [];
      orderedClusters.forEach((c) => c.stops.forEach((st) => orderedStops.push(st)));
    } else {
      const anchorStartPos = options.userLocation
        ? { lat: options.userLocation.latitude || options.userLocation.lat, lon: options.userLocation.longitude || options.userLocation.lon }
        : null;
      const orderedAnchors = orderStopsByStreetChain(clusters.map((c) => c.anchor), anchorStartPos);
      orderedStops = flattenClustersWithAnchorChain(clusters, orderedAnchors);
    }

    const finalized = finalizeOrderedStops(orderedStops, !!options.reverse, null);
    const roadData = await fetchRoadDataForStops(finalized.stops);
    if (!roadData) return finalized;

    const metrics = {
      ...calculateRouteMetrics(finalized.stops),
      totalDistanceKm: parseFloat((roadData.roadDistanceMeters / 1000).toFixed(1)),
      transitMinutes: Math.max(1, Math.round(roadData.roadDurationSeconds / 60))
    };
    metrics.estimatedMinutes = metrics.serviceMinutes + metrics.transitMinutes;
    metrics.estimatedDurationStr = formatDuration(metrics.estimatedMinutes);

    return {
      ...finalized,
      ...metrics,
      routeGeometry: roadData.routeGeometry,
      maneuvers: roadData.maneuvers,
      usedRoadRouting: true
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

  function buildWazeUrl(stop) {
    if (stop.lat && stop.lon && stop.lat !== 0 && stop.lon !== 0) {
      return `https://waze.com/ul?ll=${stop.lat},${stop.lon}&navigate=yes`;
    }
    const query = encodeURIComponent(formatStopLabel(stop));
    return `https://waze.com/ul?q=${query}&navigate=yes`;
  }

  return {
    parseCSV,
    buildOptimizedRoute,
    buildOptimizedRouteAsync,
    fetchRoadDataForStops,
    buildWalkClusters,
    buildWalkSegments,
    solveAsymmetricOpenTsp,
    orderStopsAlongStreetGeo,
    findNearbyWalkCandidate,
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
