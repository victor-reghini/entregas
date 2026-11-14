// Main Application Logic - SPX Express Route Delivery System
// Mobile First, Modular, Clean Header Dropdown, XLSX Support, User Data Isolation

(function () {
  const THEME_KEY = "spx_theme_preference";
  const WALK_DIST_KEY = "spx_max_walk_distance";
  const NAV_APP_KEY = "spx_nav_app_preference";
  const WAKE_LOCK_KEY = "spx_wake_lock_enabled";
  const TURN_HUD_KEY = "spx_show_turn_instructions";

  let wakeLockSentinel = null;
  let wakeLockEnabled = localStorage.getItem(WAKE_LOCK_KEY) !== "false";
  let turnHudEnabled = localStorage.getItem(TURN_HUD_KEY) !== "false";

  function getSavedNavApp() {
    return localStorage.getItem(NAV_APP_KEY) === "waze" ? "waze" : "maps";
  }

  function getSavedWalkDistance() {
    const raw = localStorage.getItem(WALK_DIST_KEY);
    if (raw === null) return 150;
    const parsed = parseInt(raw, 10);
    return isNaN(parsed) || parsed < 0 ? 150 : parsed;
  }

  // Dynamic storage key scoped to current authenticated user
  function getStorageKey() {
    const user = FirebaseService.getUser();
    const uid = user && !user.isLocal && user.uid ? user.uid : "guest";
    return `spx_route_${uid}`;
  }

  // Application State
  const state = {
    theme: localStorage.getItem(THEME_KEY) || "dark",
    started: false,
    finished: false,
    activeTab: "map",     // 'map' | 'current' | 'all' | 'loading' | 'organize' | 'home'
    route: null,          // { stops: [], totalPackages: 0, streetsCount: 0 }
    activeStopIdx: 0,
    arrivedCurrent: false,
    startTime: null,
    endTime: null,
    results: {},          // tn -> { status: 'delivered'|'failed'|'pending', reason: '', time: '' }
    photos: {},           // tn -> dataUrl (armazenadas localmente no IndexedDB)
    loadedPackages: {},   // tn -> true (marcado como conferido/carregado no carro)
    packageLocations: {}, // tn -> texto de localização física no veículo
    packageSpecs: {},     // tn -> { size: 'xs'|'s'|'m'|'l'|'xl', weight: 'light'|'medium'|'heavy' }
    walkedStops: [],      // paradas adiantadas a pé e removidas da fila
    maxWalkDistanceMeters: getSavedWalkDistance(),
    navApp: getSavedNavApp(), // 'maps' | 'waze'
    dismissedWalkKeys: {},
    pendingWalkCandidate: null,
    walkChecklistOpen: false,
    mapItemsDrawerOpen: false,
    hadInitialGpsRouteOrder: false,
    loadingFilter: "all", // 'all' | 'pending' | 'checked' | 'photo'
    userCoords: null,
    watchId: null,
    autoArrivedStopId: null,
    followGps: false,
    map: null,
    markers: {
      routeLine: null,
      routeBorderLine: null,
      walkLines: [],
      gpsUser: null,
      allStops: [],
      allHubs: [],
      animatedVehicle: null
    }
  };

  let currentPhotoTn = null;
  let swWaitingWorker = null;
  let swRefreshing = false;
  let walkRebuildTimer = null;
  let walkCheckInFlight = false;
  let recalculateInFlight = false;

  // --- TOAST NOTIFICATIONS (No native browser alerts) ---
  function showToast(msg) {
    const toast = document.getElementById("toastNotice");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.remove("hidden");
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
      toast.classList.add("hidden");
    }, 3200);
  }

  // --- THEME MANAGEMENT ---
  function initTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    updateThemeUI();
  }

  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, state.theme);
    document.documentElement.setAttribute("data-theme", state.theme);
    updateThemeUI();
    closeDropdown();
    showToast(state.theme === "dark" ? "Tema Escuro ativado" : "Tema Claro ativado");
  }

  function updateThemeUI() {
    const iconContainer = document.getElementById("menuThemeIcon");
    const label = document.getElementById("menuThemeLabel");
    if (iconContainer) {
      iconContainer.innerHTML = state.theme === "dark" ? renderIcon("sun", 16) : renderIcon("moon", 16);
    }
    if (label) {
      label.textContent = state.theme === "dark" ? "Tema Claro" : "Tema Escuro";
    }
  }

  // --- SCREEN WAKE LOCK (MANTER TELA LIGADA INDEFINIDAMENTE) ---
  async function requestWakeLock() {
    if (!wakeLockEnabled) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      updateWakeLockUI();
      return;
    }
    if (wakeLockSentinel && !wakeLockSentinel.released) {
      updateWakeLockUI();
      return;
    }
    try {
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      wakeLockSentinel.addEventListener("release", () => {
        updateWakeLockUI();
      });
      updateWakeLockUI();
    } catch (_) {
      updateWakeLockUI();
    }
  }

  async function releaseWakeLock() {
    if (wakeLockSentinel) {
      try {
        await wakeLockSentinel.release();
      } catch (_) { }
      wakeLockSentinel = null;
    }
    updateWakeLockUI();
  }

  function updateWakeLockUI() {
    const label = document.getElementById("menuWakeLockLabel");
    if (!label) return;
    if (typeof navigator !== "undefined" && !("wakeLock" in navigator)) {
      label.textContent = "Tela Sempre Ligada: Indisponível";
      return;
    }
    label.textContent = wakeLockEnabled
      ? "Tela Sempre Ligada: Ativo"
      : "Tela Sempre Ligada: Desativado";
  }

  function toggleWakeLock() {
    wakeLockEnabled = !wakeLockEnabled;
    localStorage.setItem(WAKE_LOCK_KEY, String(wakeLockEnabled));
    closeDropdown();
    if (wakeLockEnabled) {
      requestWakeLock();
      showToast("🔆 Tela sempre ligada ativada!");
    } else {
      releaseWakeLock();
      showToast("Tela sempre ligada desativada.");
    }
  }

  function initWakeLock() {
    updateWakeLockUI();
    requestWakeLock();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && wakeLockEnabled) {
        requestWakeLock();
      }
    });
    const reacquireOnGesture = () => {
      if (wakeLockEnabled && (!wakeLockSentinel || wakeLockSentinel.released)) {
        requestWakeLock();
      }
    };
    document.addEventListener("click", reacquireOnGesture, { passive: true });
    document.addEventListener("touchstart", reacquireOnGesture, { passive: true });
  }

  // --- TURN-BY-TURN HUD TOGGLE (OCULTAR/MOSTRAR INSTRUÇÕES PASSO A PASSO) ---
  function updateTurnHudUI() {
    const hud = document.getElementById("mapNavHud");
    const fabStack = document.getElementById("mapFabStack") || document.querySelector(".gmaps-fab-stack");
    const fabBtn = document.getElementById("btnToggleTurnHud");
    const menuLabel = document.getElementById("menuTurnHudLabel");

    if (hud) {
      hud.classList.toggle("hidden", !turnHudEnabled);
    }
    if (fabStack) {
      fabStack.classList.toggle("turn-hud-hidden", !turnHudEnabled);
    }
    if (fabBtn) {
      fabBtn.classList.toggle("active", turnHudEnabled);
    }
    if (menuLabel) {
      menuLabel.textContent = turnHudEnabled
        ? "Instruções Passo a Passo: Ativo"
        : "Instruções Passo a Passo: Oculto";
    }
  }

  function toggleTurnInstructions() {
    turnHudEnabled = !turnHudEnabled;
    localStorage.setItem(TURN_HUD_KEY, String(turnHudEnabled));
    closeDropdown();
    updateTurnHudUI();
    showToast(turnHudEnabled
      ? "🧭 Instruções passo a passo ativadas."
      : "Instruções passo a passo ocultadas para ampliar o mapa.");
  }

  // --- STATE PERSISTENCE (PER-USER DATA ISOLATION) ---
  function saveState() {
    try {
      const serialized = {
        started: state.started,
        finished: state.finished,
        activeStopIdx: state.activeStopIdx,
        arrivedCurrent: state.arrivedCurrent,
        startTime: state.startTime,
        endTime: state.endTime,
        results: state.results,
        loadedPackages: state.loadedPackages,
        packageLocations: state.packageLocations,
        packageSpecs: state.packageSpecs,
        walkedStops: state.walkedStops,
        maxWalkDistanceMeters: state.maxWalkDistanceMeters,
        navApp: state.navApp,
        route: state.route
      };
      localStorage.setItem(getStorageKey(), JSON.stringify(serialized));
    } catch (e) {
      console.warn("Save state error", e);
    }
  }

  function loadState() {
    try {
      const saved = localStorage.getItem(getStorageKey());
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.route && parsed.route.stops && (parsed.route.stops.length > 0 || (parsed.walkedStops && parsed.walkedStops.length > 0))) {
          state.route = parsed.route;
          if (!state.route.totalDistinctAddresses || !state.route.estimatedDurationStr) {
            let totalDist = 0;
            state.route.stops.forEach((s) => {
              if (typeof s.distinctAddresses === "undefined") {
                s.items.forEach((it) => {
                  if (!it.apartmentInfo) {
                    it.apartmentInfo = RouteOptimizer.extractApartmentInfo(it.complement, it.address);
                  }
                });
                s.distinctAddresses = RouteOptimizer.countDistinctAddresses(s.items);
                s.estimatedMinutes = s.distinctAddresses * 3;
              }
              totalDist += s.distinctAddresses || 1;
            });
            state.route.totalDistinctAddresses = totalDist;
            state.route.serviceMinutes = totalDist * 3;
            if (typeof state.route.transitMinutes === "undefined") {
              state.route.transitMinutes = Math.max(0, (state.route.stops.length - 1) * 2);
            }
            state.route.estimatedMinutes = state.route.serviceMinutes + state.route.transitMinutes;
            state.route.estimatedDurationStr = RouteOptimizer.formatDuration(state.route.estimatedMinutes);
          }
          ensureUniqueRouteItems(state.route);
          state.started = parsed.started !== undefined ? parsed.started : true;
          state.finished = parsed.finished || false;
          state.activeStopIdx = parsed.activeStopIdx || 0;
          state.arrivedCurrent = parsed.arrivedCurrent || false;
          state.startTime = parsed.startTime || null;
          state.endTime = parsed.endTime || null;
          state.results = parsed.results || {};
          state.loadedPackages = parsed.loadedPackages || {};
          state.packageLocations = parsed.packageLocations || {};
          state.packageSpecs = parsed.packageSpecs || {};
          state.walkedStops = parsed.walkedStops || [];
          state.hadInitialGpsRouteOrder = !!(state.route && state.route.originLocation);
          if (typeof parsed.maxWalkDistanceMeters === "number") {
            state.maxWalkDistanceMeters = parsed.maxWalkDistanceMeters;
          }
          if (parsed.navApp === "waze" || parsed.navApp === "maps") {
            state.navApp = parsed.navApp;
          }

          // Carrega fotos salvas localmente no IndexedDB para a rota
          if (typeof PhotoStorage !== "undefined") {
            PhotoStorage.getAllPhotos().then((photos) => {
              state.photos = photos || {};
              renderLoadingOrderList();
              if (state.activeTab === "current") {
                renderCurrentStopView();
              } else if (state.activeTab === "map") {
                renderMapBottomSheet();
              }
            });
          }
          return;
        }
      }
    } catch (e) {
      console.warn("Load state error", e);
    }

    // Default clean state if no route saved for this user
    state.route = null;
    state.started = false;
    state.finished = false;
    state.activeStopIdx = 0;
    state.arrivedCurrent = false;
    state.startTime = null;
    state.endTime = null;
    state.results = {};
    state.photos = {};
    state.loadedPackages = {};
    state.packageLocations = {};
    state.walkedStops = [];
    state.dismissedWalkKeys = {};
    state.pendingWalkCandidate = null;
    state.walkChecklistOpen = false;
  }

  function ensureUniqueRouteItems(routeObj) {
    if (!routeObj || !Array.isArray(routeObj.stops)) return;
    const seen = new Set();
    let seq = 0;
    routeObj.stops.forEach((s) => {
      (s.items || []).forEach((it) => {
        seq += 1;
        if (!it.seq) it.seq = seq;
        const base = String(it.tn || `ITEM-${seq}`).trim();
        it.tn = seen.has(base) ? `${base}#${seq}` : base;
        seen.add(it.tn);
      });
    });
  }

  function ensureUserLocationAsync(timeoutMs = 3500) {
    if (state.userCoords && state.userCoords.latitude && state.userCoords.longitude) {
      return Promise.resolve(state.userCoords);
    }
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(state.userCoords || null);
        }
      }, timeoutMs);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          state.userCoords = pos.coords;
          resolve(pos.coords);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(state.userCoords || null);
        },
        { enableHighAccuracy: true, maximumAge: 15000, timeout: timeoutMs }
      );
    });
  }

  // --- ROUTE GENERATION & FILE PARSING (XLSX, XLS, CSV) ---
  async function handleGenerateRouteFromCSV(csvText, useGPS = true, reverse = false) {
    const rows = RouteOptimizer.parseCSV(csvText);
    if (!rows || rows.length === 0) {
      showToast("Nenhum pacote válido encontrado na planilha.");
      return;
    }

    const initialSpecs = {};
    rows.forEach((r) => {
      if (r.size || r.weight) {
        initialSpecs[r.tn] = {
          size: RouteOptimizer.normalizePackageSize(r.size),
          weight: RouteOptimizer.normalizePackageWeight(r.weight)
        };
      }
    });
    state.packageSpecs = initialSpecs;

    showToast("Obtendo sua localização GPS e calculando rota pelas calçadas...");
    const userPos = useGPS ? await ensureUserLocationAsync(3500) : null;

    const options = {
      userLocation: userPos || state.userCoords || null,
      reverse: reverse,
      maxWalkDistanceMeters: state.maxWalkDistanceMeters,
      packageSpecs: state.packageSpecs
    };

    const optimized = await RouteOptimizer.buildOptimizedRouteAsync(rows, options);
    ensureUniqueRouteItems(optimized);
    optimized.sourceRows = rows;
    optimized.reverseOrder = !!reverse;
    optimized.walkRadiusUsed = state.maxWalkDistanceMeters;
    optimized.schemaVersion = 3;
    state.route = optimized;
    state.started = true;
    state.finished = false;
    state.activeStopIdx = 0;
    state.arrivedCurrent = false;
    state.startTime = new Date().toLocaleString("pt-BR");
    state.endTime = null;
    state.results = {};
    state.photos = {};
    state.loadedPackages = {};
    state.packageLocations = {};
    state.walkedStops = [];
    state.dismissedWalkKeys = {};
    state.pendingWalkCandidate = null;
    state.walkChecklistOpen = false;
    state.hadInitialGpsRouteOrder = !!(options.userLocation);
    if (typeof PhotoStorage !== "undefined") {
      PhotoStorage.clearAllPhotos();
    }
    saveState();

    renderHomePreview();
    switchScreen("active");
    switchTab("map");
    initGPS();
    const hubCount = optimized.hubs ? optimized.hubs.length : optimized.stops.length;
    const geoTxt = optimized.geocodedCount > 0 ? ` • ${optimized.geocodedCount} endereços` : "";
    showToast(optimized.usedRoadRouting
      ? `Rota pronta no Mapa: ${hubCount} ponto(s) de parada${geoTxt} a partir de você.`
      : `Rota (offline): ${hubCount} ponto(s) de parada e ${optimized.totalPackages} pacotes.`);
  }

  function handleFileSelect(file) {
    if (!file) return;
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith(".xlsx") || fileName.endsWith(".xls")) {
      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          if (typeof XLSX === "undefined") {
            showToast("Biblioteca XLSX ainda carregando. Tente novamente em alguns segundos.");
            return;
          }
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: "array" });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          const csvText = XLSX.utils.sheet_to_csv(worksheet);
          handleGenerateRouteFromCSV(csvText);
        } catch (err) {
          showToast("Erro ao processar planilha XLSX.");
          console.error(err);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // CSV or plain text
      const reader = new FileReader();
      reader.onload = function (e) {
        handleGenerateRouteFromCSV(e.target.result);
      };
      reader.readAsText(file, "UTF-8");
    }
  }

  function getCarRoutingPoints() {
    if (!state.route) return [];
    return (state.route.hubs && state.route.hubs.length > 0)
      ? state.route.hubs
      : (state.route.stops || []);
  }

  function getStopHub(stop) {
    if (!stop || !state.route || !Array.isArray(state.route.hubs)) return null;
    return state.route.hubs.find((h) => (h.hubId || h.id) === stop.hubId) || null;
  }

  function getEffectivePackageSpec(item) {
    const saved = state.packageSpecs[item.tn] || {};
    return {
      size: RouteOptimizer.normalizePackageSize(saved.size || item.size || "m"),
      weight: RouteOptimizer.normalizePackageWeight(saved.weight || item.weight || "medium")
    };
  }

  function buildPackageSpecControls(item) {
    const spec = getEffectivePackageSpec(item);
    const sizeOpts = Object.entries(RouteOptimizer.PACKAGE_SIZE_LABELS)
      .map(([k, label]) => `<option value="${k}" ${spec.size === k ? "selected" : ""}>${label}</option>`)
      .join("");
    const weightOpts = Object.entries(RouteOptimizer.PACKAGE_WEIGHT_LABELS)
      .map(([k, label]) => `<option value="${k}" ${spec.weight === k ? "selected" : ""}>${label}</option>`)
      .join("");
    return `
      <div class="pkg-spec-row" onclick="event.stopPropagation()">
        <select class="pkg-spec-select" aria-label="Tamanho do pacote ${item.tn}" onchange="app.setPackageSpec('${item.tn}', 'size', this.value)">
          ${sizeOpts}
        </select>
        <select class="pkg-spec-select" aria-label="Peso do pacote ${item.tn}" onchange="app.setPackageSpec('${item.tn}', 'weight', this.value)">
          ${weightOpts}
        </select>
      </div>
    `;
  }

  function setPackageSpec(tn, field, val) {
    const prev = state.packageSpecs[tn] || {};
    state.packageSpecs[tn] = {
      size: field === "size" ? RouteOptimizer.normalizePackageSize(val) : RouteOptimizer.normalizePackageSize(prev.size),
      weight: field === "weight" ? RouteOptimizer.normalizePackageWeight(val) : RouteOptimizer.normalizePackageWeight(prev.weight)
    };
    if (state.route && Array.isArray(state.route.hubs)) {
      state.route.hubs.forEach((hub) => {
        hub.walkPlan = RouteOptimizer.buildHubWalkPlan(hub, state.packageSpecs, state.results);
      });
      RouteOptimizer.fetchWalkGeometriesForHubsAsync(state.route.hubs).then((polylines) => {
        if (!state.route) return;
        state.route.walkPolylines = polylines;
        saveState();
        if (state.map) updateMapMarkers();
      }).catch(() => { });
    }
    saveState();
    if (state.route && state.route.stops[state.activeStopIdx]) {
      renderHubWalkPlanCard(state.route.stops[state.activeStopIdx]);
      renderPackageChecklist(state.route.stops[state.activeStopIdx]);
    }
    showToast("Dimensão do pacote atualizada e caminhada recalculada.");
  }

  function renderHubWalkPlanCard(stop) {
    const card = document.getElementById("hubWalkPlanCard");
    if (!card) return;
    const hub = getStopHub(stop);
    if (!hub) {
      card.classList.add("hidden");
      return;
    }

    const plan = RouteOptimizer.buildHubWalkPlan(hub, state.packageSpecs, state.results);
    hub.walkPlan = plan;
    card.classList.remove("hidden");

    const titleEl = document.getElementById("hubWalkCardTitle");
    const badgeEl = document.getElementById("hubWalkTripsBadge");
    const hintEl = document.getElementById("hubWalkCardHint");
    const listEl = document.getElementById("hubWalkTripsList");

    if (titleEl) {
      titleEl.textContent = `Ponto #${hub.id}: ${hub.title} (${hub.stops.length} entrega${hub.stops.length > 1 ? "s" : ""})`;
    }
    if (badgeEl) {
      const returnTxt = plan.returnCount > 0 ? ` • ${plan.returnCount} volta${plan.returnCount > 1 ? "s" : ""} ao carro` : "";
      badgeEl.textContent = `${plan.trips.length} viagem${plan.trips.length > 1 ? "ns" : ""}${returnTxt}`;
    }
    if (hintEl) {
      hintEl.textContent = state.arrivedCurrent
        ? `Você chegou ao Ponto de Parada #${hub.id}! Separe os pacotes por saída e abra a rota a pé pelas calçadas/vias:`
        : `Estacione o carro no Ponto #${hub.id} e siga os trajetos otimizados a pé (considerando tamanho e peso dos pacotes):`;
    }
    if (listEl) {
      const hubActionsHtml = `
        <div style="display:flex; gap:6px; margin-top:8px;">
          <button type="button" class="btn btn-outline btn-xs" style="flex:1;" onclick="app.sendHubToFront(${hub.id})">
            ⏮ Enviar Ponto p/ Frente
          </button>
          <button type="button" class="btn btn-outline btn-xs" style="flex:1;" onclick="app.sendHubToEnd(${hub.id})">
            ⏭ Enviar Ponto p/ Final
          </button>
        </div>
      `;
      if (plan.trips.length === 0) {
        listEl.innerHTML = `<div class="meta-text" style="font-size:0.8rem;">Todos os pacotes deste ponto já foram atendidos.</div>${hubActionsHtml}`;
        return;
      }
      listEl.innerHTML = plan.trips.map((trip) => {
        const stopLabels = trip.units.map((u) => `#${u.stop.id} ${u.stop.title}${u.splitPart ? ` (${u.splitPart})` : ""}`).join(" • ");
        const divider = trip.returnToCarAfter
          ? `<div class="hub-return-divider">🚗 Voltar ao carro no Ponto #${hub.id} para buscar o próximo lote</div>`
          : "";
        return `
          <div class="hub-trip-box">
            <div class="hub-trip-header">
              <span>${plan.trips.length > 1 ? `Saída #${trip.tripNumber}` : "Rota a Pé"} • ${trip.items.length} pct (~${trip.walkMetersEstimate}m)</span>
              <a href="${trip.walkUrl}" target="_blank" rel="noopener" class="btn btn-maps btn-xs" style="width:auto;">
                🚶 Rota a Pé
              </a>
            </div>
            <div class="hub-trip-stops">${stopLabels}</div>
          </div>
          ${divider}
        `;
      }).join("") + hubActionsHtml;
    }
  }

  function syncNavAppUI() {
    const isWaze = state.navApp === "waze";

    document.querySelectorAll("#navAppPills .filter-pill").forEach((pill) => {
      pill.classList.toggle("active", pill.dataset.navApp === state.navApp);
    });

    const hint = document.getElementById("navAppHint");
    if (hint) {
      hint.textContent = isWaze
        ? "Exibe os atalhos diretos para o Waze até o ponto de parada."
        : "Exibe a Rota Completa entre Pontos de Parada no Google Maps e a Lista de Paradas.";
    }

    const menuLabel = document.getElementById("menuNavAppLabel");
    if (menuLabel) {
      menuLabel.textContent = isWaze ? "Navegação: Waze" : "Navegação: Google Maps";
    }

    const toggleHidden = (id, hide) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("hidden", hide);
    };

    toggleHidden("btnOpenFullRouteDirect", isWaze);
    toggleHidden("btnOpenMultiBatchModal", isWaze);
    toggleHidden("btnOpenFirstStopWaze", !isWaze);
    toggleHidden("btnCurrentStopFullRoute", isWaze);
    toggleHidden("btnNavigateWaze", !isWaze);
    toggleHidden("btnAllStopsFullMaps", isWaze);

    const btnMapCar = document.getElementById("btnMapLaunchCarNav");
    if (btnMapCar && state.route && state.route.stops && state.route.stops.length > 0) {
      const activeStop = state.route.stops[state.activeStopIdx] || state.route.stops[0];
      const activeTarget = getStopHub(activeStop) || activeStop;
      if (isWaze) {
        btnMapCar.href = RouteOptimizer.buildWazeUrl(activeTarget);
        btnMapCar.className = "btn btn-waze btn-xs";
        btnMapCar.textContent = "🚗 Waze";
      } else {
        btnMapCar.href = RouteOptimizer.buildGoogleMapsRouteUrl(getCarRoutingPoints(), 0, null, state.userCoords || state.route.originLocation);
        btnMapCar.className = "btn btn-maps btn-xs";
        btnMapCar.textContent = "🚗 Maps";
      }
    }
  }

  function setNavApp(appName) {
    state.navApp = appName === "waze" ? "waze" : "maps";
    localStorage.setItem(NAV_APP_KEY, state.navApp);
    syncNavAppUI();
    saveState();
    if (state.route && state.route.stops.length > 0) {
      renderFullStopsList();
    }
  }

  function toggleNavApp() {
    setNavApp(state.navApp === "waze" ? "maps" : "waze");
    showToast(state.navApp === "waze" ? "Navegação definida para Waze." : "Navegação definida para Google Maps.");
  }

  function syncWalkDistanceUI() {
    const val = Math.max(0, parseInt(state.maxWalkDistanceMeters, 10) || 0);
    const input = document.getElementById("maxWalkDistanceInput");
    if (input) input.value = val;

    document.querySelectorAll("#walkPresetPills .filter-pill").forEach((pill) => {
      const pVal = parseInt(pill.dataset.walkMeters, 10);
      pill.classList.toggle("active", pVal === val);
    });

    const inlineLabel = document.getElementById("walkRadiusInlineLabel");
    if (inlineLabel) {
      inlineLabel.textContent = val > 0
        ? `🚶 Atalho a pé: até ${val}m`
        : "🚶 Atalho a pé: desativado";
    }
  }

  function extractSourceRowsFromRoute() {
    if (!state.route) return [];
    const walkedTns = new Set();
    (state.walkedStops || []).forEach((ws) => {
      (ws.items || []).forEach((it) => walkedTns.add(it.tn));
    });

    if (Array.isArray(state.route.sourceRows) && state.route.sourceRows.length > 0) {
      return state.route.sourceRows.filter((r) => !walkedTns.has(r.tn));
    }

    const rows = [];
    (state.route.stops || []).forEach((s) => {
      (s.items || []).forEach((it) => {
        if (walkedTns.has(it.tn)) return;
        const spec = getEffectivePackageSpec(it);
        rows.push({
          tn: it.tn,
          address: it.address || s.title || "",
          bairro: s.bairro || "Não inf.",
          city: s.city || "Não inf.",
          zipcode: s.zipcode || "",
          lat: s.csvLat || s.lat || 0,
          lon: s.csvLon || s.lon || 0,
          atId: it.atId || "",
          recipient: it.recipient || "",
          notes: it.notes || "",
          sortCode: it.sortCode || "",
          size: spec.size,
          weight: spec.weight
        });
      });
    });
    return rows;
  }

  function setRecalculateButtonsLoading(loading) {
    const ids = ["btnRecalculateRoutesHome", "btnRecalculateRoutesAll", "btnRecalculateRoutesMap"];
    ids.forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
      btn.disabled = loading;
      btn.innerHTML = loading ? "Recalculando..." : btn.dataset.origHtml;
    });
  }

  async function recalculateAllRoutes() {
    if (recalculateInFlight) return;
    if (!state.route || (!state.route.stops.length && !(state.route.sourceRows && state.route.sourceRows.length))) {
      showToast("Carregue uma planilha antes de recalcular as rotas.");
      return;
    }

    const rows = extractSourceRowsFromRoute();
    if (rows.length === 0) {
      showToast("Não há entregas pendentes para recalcular.");
      return;
    }

    const prevSourceRows = state.route.sourceRows || rows;
    const prevReverse = !!state.route.reverseOrder;

    recalculateInFlight = true;
    setRecalculateButtonsLoading(true);
    showToast("Recalculando todas as rotas (endereços, calçadas e vias)...");

    try {
      const optCheck = document.getElementById("optReverseOrder");
      const reverse = optCheck ? optCheck.checked : prevReverse;
      const userPos = await ensureUserLocationAsync(3000);
      const effectiveUserPos = userPos || state.userCoords || (state.route && state.route.originLocation) || null;

      const rebuilt = await RouteOptimizer.buildOptimizedRouteAsync(rows, {
        userLocation: effectiveUserPos,
        reverse,
        maxWalkDistanceMeters: state.maxWalkDistanceMeters,
        packageSpecs: state.packageSpecs
      });
      ensureUniqueRouteItems(rebuilt);
      rebuilt.sourceRows = prevSourceRows;
      rebuilt.reverseOrder = reverse;
      rebuilt.walkRadiusUsed = state.maxWalkDistanceMeters;
      rebuilt.schemaVersion = 3;

      const walkedPkgCount = (state.walkedStops || []).reduce((sum, s) => sum + (s.items ? s.items.length : 0), 0);
      rebuilt.totalPackages = (rebuilt.totalPackages || 0) + walkedPkgCount;

      state.route = rebuilt;
      state.hadInitialGpsRouteOrder = !!effectiveUserPos;
      state.dismissedWalkKeys = {};
      state.pendingWalkCandidate = null;
      state.walkChecklistOpen = false;
      state.arrivedCurrent = false;
      state.autoArrivedStopId = null;

      // Focus first stop that still has pending items when already started
      if (state.started && Array.isArray(rebuilt.stops) && rebuilt.stops.length > 0) {
        const firstPendingIdx = rebuilt.stops.findIndex((s) =>
          (s.items || []).some((it) => !state.results[it.tn] || state.results[it.tn].status === "pending")
        );
        state.activeStopIdx = firstPendingIdx >= 0 ? firstPendingIdx : 0;
      } else {
        state.activeStopIdx = 0;
      }

      saveState();
      updateHeader();
      renderHomePreview();
      renderLoadingOrderList();
      if (state.started && !state.finished) {
        renderCurrentStopView();
        renderFullStopsList();
        renderMapBottomSheet();
      }
      if (state.map) updateMapMarkers();
      syncNavAppUI();

      const hubCount = rebuilt.hubs ? rebuilt.hubs.length : rebuilt.stops.length;
      showToast(rebuilt.usedRoadRouting
        ? `✓ Rotas recalculadas: ${hubCount} ponto(s) de parada pelas calçadas/vias.`
        : `Rotas recalculadas (offline): ${hubCount} ponto(s) de parada.`);
    } catch (err) {
      console.error("Erro ao recalcular rotas:", err);
      showToast("Não foi possível recalcular as rotas agora.");
    } finally {
      recalculateInFlight = false;
      setRecalculateButtonsLoading(false);
    }
  }

  function setMaxWalkDistance(meters) {
    const parsed = Math.max(0, Math.min(1000, parseInt(meters, 10) || 0));
    state.maxWalkDistanceMeters = parsed;
    localStorage.setItem(WALK_DIST_KEY, String(parsed));
    syncWalkDistanceUI();
    saveState();

    // Always rebuild route (whether on Home or Active screen) when walk distance changes
    if (state.route && ((state.route.stops && state.route.stops.length > 0) || (state.route.sourceRows && state.route.sourceRows.length > 0))) {
      clearTimeout(walkRebuildTimer);
      walkRebuildTimer = setTimeout(() => {
        recalculateAllRoutes();
      }, 300);
    }

    if (state.started && !state.finished && state.arrivedCurrent) {
      checkNearbyWalkDelivery();
    }
  }

  function promptAdjustWalkDistance() {
    const bar = document.getElementById("walkRadiusInlineBar");
    if (!bar) return;
    let editor = document.getElementById("walkRadiusInlineEditor");
    if (editor) {
      editor.remove();
      return;
    }

    editor = document.createElement("div");
    editor.id = "walkRadiusInlineEditor";
    editor.className = "walk-config-box";
    editor.style.marginTop = "6px";
    editor.style.marginBottom = "0";
    editor.innerHTML = `
      <div class="walk-config-header" style="margin-bottom:6px;">
        <span style="font-size:0.78rem; font-weight:800;">Raio máximo a pé (m)</span>
        <div class="walk-input-wrap">
          <input type="number" id="inlineWalkDistInput" class="input-field walk-distance-input" min="0" max="1000" step="10" value="${state.maxWalkDistanceMeters}" />
          <button type="button" class="btn btn-primary btn-sm" style="width:auto; padding:6px 10px;" onclick="app.applyInlineWalkDistance()">OK</button>
        </div>
      </div>
      <div class="walk-presets">
        ${[0, 50, 80, 150, 250, 400].map((m) => `
          <button type="button" class="filter-pill ${state.maxWalkDistanceMeters === m ? "active" : ""}" onclick="app.setMaxWalkDistance(${m}); app.closeInlineWalkEditor();">
            ${m === 0 ? "Desativado" : m + "m"}
          </button>
        `).join("")}
      </div>
    `;
    bar.insertAdjacentElement("afterend", editor);
  }

  function closeInlineWalkEditor() {
    const editor = document.getElementById("walkRadiusInlineEditor");
    if (editor) editor.remove();
  }

  function applyInlineWalkDistance() {
    const input = document.getElementById("inlineWalkDistInput");
    if (input) {
      setMaxWalkDistance(input.value);
      showToast(state.maxWalkDistanceMeters > 0
        ? `Atalho a pé ajustado para ${state.maxWalkDistanceMeters}m.`
        : "Atalho a pé desativado.");
    }
    closeInlineWalkEditor();
  }

  function startActiveRoute() {
    if (!state.route || state.route.stops.length === 0) {
      showToast("Carregue uma planilha antes de iniciar.");
      return;
    }
    const walkInput = document.getElementById("maxWalkDistanceInput");
    if (walkInput) {
      const val = Math.max(0, Math.min(1000, parseInt(walkInput.value, 10) || 0));
      state.maxWalkDistanceMeters = val;
      localStorage.setItem(WALK_DIST_KEY, String(val));
    }
    state.started = true;
    state.finished = false;
    if (!state.startTime) state.startTime = new Date().toLocaleString("pt-BR");
    saveState();
    switchScreen("active");
    switchTab("map");
    initGPS();
  }

  // --- SCREEN & TAB NAVIGATION ---
  function switchScreen(screenName) {
    const home = document.getElementById("screenHome");
    const active = document.getElementById("screenActive");
    const report = document.getElementById("screenReport");

    home.classList.add("hidden");
    active.classList.add("hidden");
    report.classList.add("hidden");

    if (screenName === "home") {
      home.classList.remove("hidden");
      renderHomePreview();
    } else if (screenName === "active") {
      active.classList.remove("hidden");
      renderActiveView();
    } else if (screenName === "report") {
      report.classList.remove("hidden");
      renderReportScreen();
    }
    updateHeader();
  }

  function switchTab(tabName) {
    if (tabName === "organize") tabName = "loading";
    if (state.activeTab === "map" && tabName !== "map") {
      stopRouteAnimation();
    }
    if (state.activeTab === "loading" && tabName !== "loading") {
      stopScanner();
    }

    state.activeTab = tabName;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    if (tabName === "home") {
      switchScreen("home");
      return;
    }

    const home = document.getElementById("screenHome");
    const active = document.getElementById("screenActive");
    const report = document.getElementById("screenReport");
    if (home) home.classList.add("hidden");
    if (report && !state.finished) report.classList.add("hidden");
    if (active) active.classList.remove("hidden");

    const tabCurrent = document.getElementById("tabCurrentStop");
    const tabLoading = document.getElementById("tabLoading");
    const tabAll = document.getElementById("tabAllStops");
    const tabOrganize = document.getElementById("tabOrganize");
    const tabMap = document.getElementById("tabMap");

    if (tabCurrent) tabCurrent.classList.add("hidden");
    if (tabLoading) tabLoading.classList.add("hidden");
    if (tabAll) tabAll.classList.add("hidden");
    if (tabOrganize) tabOrganize.classList.add("hidden");
    if (tabMap) tabMap.classList.add("hidden");

    if (tabName === "current") {
      if (tabCurrent) tabCurrent.classList.remove("hidden");
      renderCurrentStopView();
    } else if (tabName === "loading") {
      if (tabLoading) tabLoading.classList.remove("hidden");
      renderLoadingOrderList();
    } else if (tabName === "all") {
      if (tabAll) tabAll.classList.remove("hidden");
      renderFullStopsList();
      setTimeout(scrollActiveStopIntoView, 100);
    } else if (tabName === "map") {
      if (tabMap) tabMap.classList.remove("hidden");
      renderMapBottomSheet();
      initLeafletMap();
      setTimeout(() => {
        if (state.map) {
          state.map.invalidateSize();
          updateMapMarkers();
        }
      }, 150);
    }
    updateHeader();
  }

  function scrollActiveStopIntoView() {
    const activeCard = document.querySelector(".stop-row-card.active-stop");
    if (activeCard) {
      activeCard.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function updateHeader() {
    const badge = document.getElementById("headerProgressBadge");
    const progressBar = document.getElementById("progressBar");
    const btnFinishHeader = document.getElementById("btnHeaderFinishRoute");

    if (!state.route || !state.route.stops || state.route.stops.length === 0) {
      badge.classList.add("hidden");
      if (btnFinishHeader) btnFinishHeader.classList.add("hidden");
      progressBar.style.width = "0%";
      return;
    }

    const total = state.route.totalPackages || 0;
    const done = Object.values(state.results).filter(
      (r) => r && (r.status === "delivered" || r.status === "failed")
    ).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    badge.classList.remove("hidden");
    badge.textContent = `${done}/${total} (${pct}%)`;
    progressBar.style.width = `${pct}%`;
    if (btnFinishHeader) {
      btnFinishHeader.classList.toggle("hidden", !!state.finished);
    }
  }

  // --- HOME / SETUP SCREEN ---
  function renderHomePreview() {
    syncWalkDistanceUI();
    const summaryBox = document.getElementById("homeRouteSummary");
    const listContainer = document.getElementById("homePreviewStopsList");

    if (!state.route || state.route.stops.length === 0) {
      summaryBox.classList.add("hidden");
      listContainer.innerHTML = "";
      return;
    }

    summaryBox.classList.remove("hidden");

    document.getElementById("statTotalStops").textContent = state.route.stops.length;
    const statAddrs = document.getElementById("statTotalAddresses");
    if (statAddrs) statAddrs.textContent = state.route.totalDistinctAddresses || state.route.stops.length;
    document.getElementById("statTotalPackages").textContent = state.route.totalPackages;
    const statTime = document.getElementById("statEstimatedTime");
    if (statTime) statTime.textContent = state.route.estimatedDurationStr || `${((state.route.totalDistinctAddresses || state.route.stops.length) * 3)} min`;
    const statTimeSub = document.getElementById("statEstimatedTimeSub");
    if (statTimeSub) {
      const addrs = state.route.totalDistinctAddresses || state.route.stops.length;
      const sMin = state.route.serviceMinutes || (addrs * 3);
      const tMin = state.route.transitMinutes || 0;
      statTimeSub.textContent = `⏱️ ${addrs} endereços (3 min/end = ${sMin}m) + trânsito (${tMin}m)`;
    }

    const routeModeBadge = document.getElementById("routeModeBadge");
    if (routeModeBadge) {
      const hubCount = state.route.hubs ? state.route.hubs.length : state.route.stops.length;
      const walkCount = state.route.stops.filter((s) => s.isWalkStop).length;
      const walkTxt = walkCount > 0 ? ` • ${walkCount} a pé` : "";
      const geoTxt = state.route.geocodedCount > 0 ? ` • ${state.route.geocodedCount} endereços` : "";
      const footTxt = state.route.usedFootDistance ? " / calçadas" : "";
      routeModeBadge.textContent = state.route.usedRoadRouting
        ? `✓ ${hubCount} pontos de parada (vias${footTxt}${geoTxt})${walkTxt}`
        : `Modo offline: ${hubCount} pontos de parada${walkTxt}`;
    }

    const carPoints = getCarRoutingPoints();
    const btnFullRoute = document.getElementById("btnOpenFullRouteDirect");
    if (btnFullRoute) {
      btnFullRoute.href = RouteOptimizer.buildGoogleMapsRouteUrl(carPoints);
    }

    const btnFirstWaze = document.getElementById("btnOpenFirstStopWaze");
    if (btnFirstWaze && carPoints[0]) {
      btnFirstWaze.href = RouteOptimizer.buildWazeUrl(carPoints[0]);
    }

    syncNavAppUI();

    listContainer.innerHTML = state.route.stops
      .map(
        (s) => {
          const aptSub = (s.distinctAddresses && s.distinctAddresses > 1)
            ? `<div class="meta-text" style="font-size:0.75rem; color:var(--info, #0284c7);">${s.distinctAddresses} apts/endereços • ~${s.distinctAddresses * 3} min</div>`
            : `<div class="meta-text" style="font-size:0.75rem;">~${(s.distinctAddresses || 1) * 3} min</div>`;
          const walkTag = s.isWalkStop
            ? `<div class="walk-stop-tag">🚶 Percurso a pé: ~${s.walkDistanceMeters || 0}m (Ponto #${s.hubId || s.walkFromStopId || "-"})</div>`
            : "";

          return `
      <div class="stop-row-card" style="padding:8px 12px; margin-bottom:4px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="stop-idx-badge" style="width:26px; height:26px; font-size:0.75rem;">#${s.id}</span>
          <div>
            <div style="font-weight:700; font-size:0.85rem;">${s.title}</div>
            ${aptSub}
            ${walkTag}
          </div>
        </div>
        <span class="badge" style="font-size:0.75rem;">${s.items.length} ${s.items.length > 1 ? "pacotes" : "pacote"}</span>
      </div>
    `;
        }
      )
      .join("");
  }

  // --- ACTIVE DELIVERY VIEW ---
  function renderActiveView() {
    updateHeader();
    renderCurrentStopView();
  }

  function renderCurrentStopView() {
    if (!state.route || state.route.stops.length === 0) return;
    const stop = state.route.stops[state.activeStopIdx];
    if (!stop) return;

    // Header kicker
    document.getElementById("currentStopCounter").innerHTML = `
      ${renderIcon("mapPin", 14)} PARADA ${stop.id} DE ${state.route.stops.length}
    `;
    const stopAddresses = stop.distinctAddresses || 1;
    const addrLabel = stopAddresses > 1 ? ` • ${stopAddresses} apts (~${stopAddresses * 3} min)` : ` (~${stopAddresses * 3} min)`;
    document.getElementById("currentStopPkgCount").textContent = `${stop.items.length} ${stop.items.length > 1 ? "pacotes" : "pacote"}${addrLabel}`;
    document.getElementById("currentStopTitle").textContent = stop.title;
    document.getElementById("currentStopMeta").textContent = `${stop.bairro} • ${stop.city} - CEP ${stop.zipcode}`;

    const walkBanner = document.getElementById("currentStopWalkBanner");
    if (walkBanner) {
      if (stop.isWalkStop) {
        walkBanner.textContent = `🚶 Percurso a pé: ~${stop.walkDistanceMeters || 0}m${stop.walkAnchorTitle ? ` • ${stop.walkAnchorTitle}` : ""}`;
        walkBanner.classList.remove("hidden");
      } else {
        walkBanner.classList.add("hidden");
      }
    }

    // Special notes check
    const specialNotes = stop.items
      .map((it) => it.address)
      .filter((addr) => /manhã|tarde|sindico|interfonar|fundos|portaria|ap|apartamento/i.test(addr));
    const noteEl = document.getElementById("currentStopNotes");
    if (specialNotes.length > 0) {
      noteEl.innerHTML = `
        ${renderIcon("alertTriangle", 16, "icon-warning")}
        <div><strong>Instruções de entrega:</strong> ${stop.items.map((it) => it.complement).join(" • ")}</div>
      `;
      noteEl.classList.remove("hidden");
    } else {
      noteEl.classList.add("hidden");
    }

    // Waze Navigation Link (only visible when navApp === "waze")
    const btnWaze = document.getElementById("btnNavigateWaze");
    if (btnWaze) {
      btnWaze.href = RouteOptimizer.buildWazeUrl(getStopHub(stop) || stop);
    }

    // Full Google Maps Route Link (only visible when navApp === "maps")
    const btnCurFull = document.getElementById("btnCurrentStopFullRoute");
    if (btnCurFull) {
      btnCurFull.href = RouteOptimizer.buildGoogleMapsRouteUrl(getCarRoutingPoints());
    }

    syncNavAppUI();
    renderHubWalkPlanCard(stop);

    // Arrival button state & Package List (Always visible as preview)
    const btnArrived = document.getElementById("btnMarkArrived");
    const checklistBox = document.getElementById("stopChecklistBox");

    checklistBox.classList.remove("hidden");
    renderPackageChecklist(stop);

    if (state.arrivedCurrent) {
      btnArrived.innerHTML = `${renderIcon("checkCircle", 18)} Você está no local`;
      btnArrived.className = "btn btn-secondary";
    } else {
      btnArrived.innerHTML = `${renderIcon("mapPin", 18)} Cheguei no Endereço`;
      btnArrived.className = "btn btn-success";
    }

    // Preview of the next stop in sequence
    const nextBox = document.getElementById("nextStopPreviewCard");
    if (state.activeStopIdx + 1 < state.route.stops.length) {
      const nxt = state.route.stops[state.activeStopIdx + 1];
      nextBox.classList.remove("hidden");
      document.getElementById("nextStopTitle").textContent = `#${nxt.id} ${nxt.title}`;
      const nxtAddresses = nxt.distinctAddresses || 1;
      const nxtApt = nxtAddresses > 1 ? ` • ${nxtAddresses} apts (~${nxtAddresses * 3} min)` : ` (~${nxtAddresses * 3} min)`;
      const nxtWalk = nxt.isWalkStop ? ` • 🚶 A pé (~${nxt.walkDistanceMeters || 0}m)` : "";
      document.getElementById("nextStopDetails").textContent = `${nxt.items.length} ${nxt.items.length > 1 ? "pacotes" : "pacote"}${nxtApt}${nxtWalk} • ${nxt.bairro}`;
    } else {
      nextBox.classList.add("hidden");
    }

    // Update GPS distance pill & walk radius label
    syncWalkDistanceUI();
    if (state.userCoords) {
      updateDistanceUI(state.userCoords.latitude, state.userCoords.longitude);
    }
  }

  // Audio Synthesizer & Haptics
  const audioCtx = (function () {
    let ctx = null;
    return () => {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    };
  })();

  function playSuccessChime() {
    try {
      const ctx = audioCtx();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.12); // G5
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
      if (navigator.vibrate) navigator.vibrate([30, 20, 30]);
    } catch (_) { }
  }

  function playWarningChime() {
    try {
      const ctx = audioCtx();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, now); // A4
      osc.frequency.linearRampToValueAtTime(330, now + 0.15); // E4
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
      if (navigator.vibrate) navigator.vibrate(60);
    } catch (_) { }
  }

  function copyCurrentAddress() {
    if (!state.route || state.route.stops.length === 0) return;
    const stop = state.route.stops[state.activeStopIdx];
    if (!stop) return;
    const text = RouteOptimizer.formatStopLabel(stop);
    navigator.clipboard.writeText(text).then(() => {
      showToast("Endereço copiado para a área de transferência!");
      if (navigator.vibrate) navigator.vibrate(25);
    }).catch(() => {
      showToast("Não foi possível copiar o endereço.");
    });
  }

  const SPX_FAIL_REASONS = [
    "Cliente Ausente",
    "Endereço Incorreto",
    "Destinatário Mudou",
    "Recusado",
    "Sem Acesso"
  ];

  function buildPackageChecklistHtml(stop) {
    if (!stop || !stop.items) return "";
    return stop.items
      .map((it, idx) => {
        const res = state.results[it.tn] || { status: "pending", reason: "" };
        const status = res.status || "pending";
        const isDelivered = status === "delivered";
        const isFailed = status === "failed";
        const isPending = status === "pending";

        const badgeClass = isDelivered ? "badge-success" : (isFailed ? "badge-danger" : "badge-warning");
        const badgeLabel = isDelivered ? "Entregue" : (isFailed ? "Não Entregue" : "Pendente");

        const aptTag = (it.apartmentInfo && it.apartmentInfo.hasApartment)
          ? `<span class="badge" style="background:rgba(238,77,45,0.12); color:var(--primary); font-weight:800; font-size:0.75rem; border:1px solid rgba(238,77,45,0.3);">🏢 ${it.apartmentInfo.displayLabel}</span>`
          : "";

        const carLoc = state.packageLocations[it.tn] || "";
        const carLocTag = carLoc
          ? `<span class="badge" style="background:var(--surface); font-size:0.72rem;">📍 ${carLoc}</span>`
          : "";

        const extraDetails = [
          it.recipient ? `<strong>Dest.:</strong> ${it.recipient}` : "",
          it.sortCode ? `<strong>Setor:</strong> ${it.sortCode}` : "",
          it.notes ? `<strong>Obs:</strong> ${it.notes}` : ""
        ].filter(Boolean).join(" • ");

        const photoUrl = state.photos[it.tn] || null;
        const photoBoxHtml = photoUrl
          ? `
            <div class="delivery-photo-preview-box">
              <div style="display:flex; align-items:center; gap:8px;">
                <img src="${photoUrl}" alt="Foto da embalagem" class="delivery-photo-thumb" onclick="app.viewPhotoLarge(this.src, 'Parada #${stop.id} • Seq #${it.seq} • ${it.tn}')" />
                <div>
                  <div style="font-size:0.8rem; font-weight:800; color:var(--primary); display:flex; align-items:center; gap:4px;">
                    ${renderIcon("camera", 14)} Foto da Embalagem
                  </div>
                  <div class="meta-text" style="font-size:0.72rem;">Toque para ampliar e identificar</div>
                </div>
              </div>
              <button type="button" class="btn btn-ghost btn-xs" onclick="app.capturePhotoForTn('${it.tn}')">Trocar</button>
            </div>
          `
          : `
            <div style="margin:4px 0 6px 0;">
              <button type="button" class="btn btn-outline btn-xs" onclick="app.capturePhotoForTn('${it.tn}')" style="font-size:0.75rem; padding:4px 8px; gap:4px;">
                ${renderIcon("camera", 14)} Tirar Foto
              </button>
            </div>
          `;

        return `
        <div class="package-item">
          <div class="package-item-header">
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span class="tn-code">#${idx + 1} • ${it.tn}</span>
              ${aptTag}
              ${carLocTag}
            </div>
            <span class="badge ${badgeClass}">
              ${badgeLabel}
            </span>
          </div>
          <div class="complement-pill"><strong>Complemento:</strong> ${it.complement}</div>
          ${extraDetails ? `<div class="meta-text" style="font-size:0.76rem;">${extraDetails}</div>` : ""}
          ${buildPackageSpecControls(it)}
          ${photoBoxHtml}
          
          <!-- Seletor de 3 Estados: Entregue, Pendente e Não Entregue + Adiar p/ Final -->
          <div class="status-toggles">
            <button type="button" class="status-opt-btn ${isDelivered ? "active-ok" : ""}" onclick="app.setItemStatus('${it.tn}', 'delivered')">
              ${renderIcon("check", 14)} Entregue
            </button>
            <button type="button" class="status-opt-btn ${isPending ? "active-pending" : ""}" onclick="app.setItemStatus('${it.tn}', 'pending')">
              ${renderIcon("package", 14)} Pendente
            </button>
            <button type="button" class="status-opt-btn ${isFailed ? "active-fail" : ""}" onclick="app.setItemStatus('${it.tn}', 'failed')">
              ${renderIcon("x", 14)} Falha
            </button>
            <button type="button" class="status-opt-btn" onclick="app.sendItemToEnd('${it.tn}')" title="Enviar esta entrega para o final da rota">
              ⏭ Final
            </button>
          </div>

          <div class="${isFailed ? "" : "hidden"}" style="margin-top:8px;">
            <div style="font-size:0.75rem; font-weight:700; color:var(--text-muted); margin-bottom:4px;">Motivo do Insucesso:</div>
            <div class="reason-tags-grid">
              ${SPX_FAIL_REASONS.map(
          (reason) => `
                <button type="button" class="reason-tag-pill ${res.reason === reason ? "active" : ""}" onclick="app.setItemReason('${it.tn}', '${reason}')">
                  ${reason}
                </button>
              `
        ).join("")}
            </div>
            <input
              type="text"
              class="reason-input"
              style="margin-top:6px;"
              placeholder="Ou digite outro motivo..."
              value="${(res.reason || "").replace(/"/g, "&quot;")}"
              oninput="app.setItemReason('${it.tn}', this.value)"
            />
          </div>
        </div>
      `;
      })
      .join("");
  }

  function renderPackageChecklist(stop) {
    const container = document.getElementById("packageItemsContainer");
    if (!container) return;
    container.innerHTML = buildPackageChecklistHtml(stop);
  }

  function refreshActiveChecklists() {
    if (state.route && state.route.stops[state.activeStopIdx]) {
      renderPackageChecklist(state.route.stops[state.activeStopIdx]);
    }
    if (state.walkChecklistOpen && state.pendingWalkCandidate) {
      const walkContainer = document.getElementById("walkPackageItemsContainer");
      if (walkContainer) {
        walkContainer.innerHTML = buildPackageChecklistHtml(state.pendingWalkCandidate.stop);
      }
    }
  }

  function markArrived(isAuto = false) {
    state.arrivedCurrent = true;
    saveState();
    renderCurrentStopView();
    const checklistBox = document.getElementById("stopChecklistBox");
    if (checklistBox) {
      checklistBox.classList.remove("hidden");
      checklistBox.scrollIntoView({ behavior: "smooth" });
    }
    if (isAuto) {
      playSuccessChime();
      showToast("📍 Chegada detectada via GPS! Lista de pacotes aberta.");
    }
    checkNearbyWalkDelivery();
  }

  function buildCompactItemStatusRowsHtml(stop) {
    if (!stop || !Array.isArray(stop.items) || stop.items.length === 0) return "";
    return stop.items
      .map((it) => {
        const res = state.results[it.tn] || { status: "pending", reason: "" };
        const st = res.status || "pending";
        const isDelivered = st === "delivered";
        const isPending = st === "pending";
        const isFailed = st === "failed";
        const aptBadge = it.apartmentInfo && it.apartmentInfo.hasApartment
          ? `<span class="badge" style="background:rgba(238,77,45,0.14); color:var(--primary); font-size:0.7rem; font-weight:800;">🏢 ${it.apartmentInfo.displayLabel}</span>`
          : "";
        const carLoc = state.packageLocations[it.tn] || "";
        const carLocBadge = carLoc
          ? `<span class="badge" style="background:var(--surface); font-size:0.68rem;">📍 ${carLoc}</span>`
          : "";
        const compl = it.complement && it.complement !== "Sem complemento" ? it.complement : "";
        const extraMeta = [
          it.recipient ? `👤 ${it.recipient}` : "",
          it.notes ? `📝 ${it.notes}` : ""
        ].filter(Boolean).join(" • ");
        const safeTn = String(it.tn).replace(/'/g, "\\'");

        return `
          <div class="inline-pkg-row" onclick="event.stopPropagation()">
            <div class="inline-pkg-info">
              <div class="inline-pkg-top">
                <span class="inline-pkg-tn">Entrega #${it.seq || "-"} • ${it.tn}</span>
                <div style="display:flex; align-items:center; gap:4px; flex-wrap:wrap;">
                  ${aptBadge}
                  ${carLocBadge}
                </div>
              </div>
              <div class="inline-pkg-addr">${stop.title}${stop.bairro ? ` • <span class="meta-text">${stop.bairro}</span>` : ""}</div>
              ${compl ? `<div class="inline-pkg-compl"><strong>Compl:</strong> ${compl}</div>` : ""}
              ${extraMeta ? `<div class="meta-text" style="font-size:0.72rem;">${extraMeta}</div>` : ""}
            </div>
            <div class="inline-pkg-btns">
              <button type="button" class="inline-status-btn ${isDelivered ? "active-ok" : ""}" onclick="event.stopPropagation(); app.setItemStatus('${safeTn}', 'delivered')">
                ✓ Entregue
              </button>
              <button type="button" class="inline-status-btn ${isPending ? "active-pending" : ""}" onclick="event.stopPropagation(); app.setItemStatus('${safeTn}', 'pending')">
                Pendente
              </button>
              <button type="button" class="inline-status-btn ${isFailed ? "active-fail" : ""}" onclick="event.stopPropagation(); app.setItemStatus('${safeTn}', 'failed')">
                ✕ Falha
              </button>
              <button type="button" class="inline-status-btn" onclick="event.stopPropagation(); app.sendItemToEnd('${safeTn}')" title="Enviar esta entrega para o final da rota">
                ⏭ Final
              </button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function setItemStatus(tn, targetStatus) {
    if (!tn) return;
    const prev = state.results[tn] || { status: "pending", reason: "" };
    // Clicking the already-active non-pending status toggles back to pending; affects ONLY this item (tn)
    const newStatus = (prev.status === targetStatus && targetStatus !== "pending") ? "pending" : targetStatus;

    state.results[tn] = {
      status: newStatus,
      reason: newStatus === "failed" ? (prev.reason || "Cliente Ausente") : "",
      time: new Date().toLocaleTimeString("pt-BR")
    };

    if (newStatus === "delivered") {
      playSuccessChime();
    } else if (newStatus === "failed") {
      playWarningChime();
    } else {
      if (navigator.vibrate) navigator.vibrate(20);
    }

    saveState();
    refreshActiveChecklists();
    renderMapBottomSheet();
    if (state.activeTab === "all") {
      renderFullStopsList();
    }
    if (state.activeTab === "loading") {
      renderLoadingOrderList();
    }
    if (state.route && state.route.stops[state.activeStopIdx]) {
      renderHubWalkPlanCard(state.route.stops[state.activeStopIdx]);
    }
    if (state.map) {
      updateMapMarkers(false);
    }
    updateHeader();
  }

  function setItemReason(tn, reason) {
    if (!state.results[tn]) {
      state.results[tn] = { status: "failed", reason: "", time: new Date().toLocaleTimeString("pt-BR") };
    }
    state.results[tn].reason = reason;
    saveState();
    refreshActiveChecklists();
  }

  function resequenceRouteAfterDeferral() {
    if (!state.route || !Array.isArray(state.route.stops)) return;
    let seq = 0;
    state.route.stops.forEach((s, i) => {
      s.id = i + 1;
      (s.items || []).forEach((it) => {
        seq += 1;
        it.seq = seq;
      });
    });

    if (Array.isArray(state.route.hubs) && state.route.hubs.length > 0) {
      const frontHubs = [];
      const middleHubs = [];
      const endHubs = [];

      state.route.stops.forEach((s) => {
        if (s.movedToFront) {
          frontHubs.push({
            id: 0,
            lat: s.lat,
            lon: s.lon,
            lng: s.lon,
            title: `Ponto (próx. ${s.title})`,
            address: s.address,
            street: s.street,
            number: s.number,
            bairro: s.bairro,
            city: s.city,
            zipcode: s.zipcode,
            stops: [s]
          });
          s.movedToFront = false;
        }
      });

      state.route.hubs.forEach((h) => {
        const remaining = state.route.stops.filter((s) => s.hubId === h.id && !s.deferredToEnd && !s.movedToFront);
        if (remaining.length > 0) {
          middleHubs.push({
            ...h,
            stops: remaining
          });
        }
      });

      state.route.stops.forEach((s) => {
        if (s.deferredToEnd || !s.hubId) {
          endHubs.push({
            id: 0,
            lat: s.lat,
            lon: s.lon,
            lng: s.lon,
            title: `Ponto (próx. ${s.title})`,
            address: s.address,
            street: s.street,
            number: s.number,
            bairro: s.bairro,
            city: s.city,
            zipcode: s.zipcode,
            stops: [s]
          });
          s.deferredToEnd = false;
        }
      });

      const rebuiltHubs = [...frontHubs, ...middleHubs, ...endHubs];

      rebuiltHubs.forEach((h, idx) => {
        h.id = idx + 1;
        const firstStop = h.stops[0];
        if (firstStop) {
          h.title = `Ponto #${h.id} (próx. ${firstStop.title})`;
        }
        h.stops.forEach((s, sIdx) => {
          s.hubId = h.id;
          s.hubTitle = h.title;
          s.hubLat = h.lat;
          s.hubLon = h.lon;
          if (sIdx === 0 && h.stops.length === 1) {
            s.isWalkStop = false;
            s.walkDistanceMeters = 0;
          }
        });
        h.walkPlan = RouteOptimizer.buildHubWalkPlan(h, state.packageSpecs, state.results);
      });

      state.route.hubs = rebuiltHubs;
      RouteOptimizer.fetchRoadDataForHubs(
        state.route.hubs,
        state.userCoords || state.route.originLocation
      ).then((roadData) => {
        if (!roadData || !state.route) return;
        state.route.routeGeometry = roadData.routeGeometry;
        state.route.maneuvers = roadData.maneuvers;
        state.route.usedRoadRouting = true;
        saveState();
        if (state.map) {
          updateMapMarkers(false);
          startRouteAnimation();
        }
      }).catch(() => { });
    }

    state.route.walkSegments = RouteOptimizer.buildWalkSegments(state.route.stops);
    saveState();
    renderCurrentStopView();
    renderMapBottomSheet();
    if (state.activeTab === "all") {
      renderFullStopsList();
    }
    if (state.activeTab === "loading") {
      renderLoadingOrderList();
    }
    if (state.map) {
      updateMapMarkers(true);
      startRouteAnimation();
    }
    updateHeader();
  }

  function sendStopToEnd(stopIdx) {
    if (!state.route || !Array.isArray(state.route.stops) || state.route.stops.length <= 1) {
      showToast("Não há outras paradas para reordenar.");
      return;
    }
    const idx = typeof stopIdx === "number" ? stopIdx : state.activeStopIdx;
    if (idx < 0 || idx >= state.route.stops.length) return;
    if (idx === state.route.stops.length - 1) {
      showToast("Esta parada já está no final da rota.");
      return;
    }

    const [movedStop] = state.route.stops.splice(idx, 1);
    movedStop.isWalkStop = false;
    movedStop.walkDistanceMeters = 0;
    movedStop.deferredToEnd = true;
    movedStop.hubId = null;
    state.route.stops.push(movedStop);

    if (idx < state.activeStopIdx) {
      state.activeStopIdx = Math.max(0, state.activeStopIdx - 1);
    } else if (idx === state.activeStopIdx) {
      state.activeStopIdx = Math.min(state.activeStopIdx, state.route.stops.length - 1);
      state.arrivedCurrent = false;
    }

    if (navigator.vibrate) navigator.vibrate(30);
    resequenceRouteAfterDeferral();
    showToast(`⏭ "${movedStop.title}" enviada para o final da rota!`);
  }

  function sendStopToFront(stopIdx) {
    if (!state.route || !Array.isArray(state.route.stops) || state.route.stops.length <= 1) {
      showToast("Não há outras paradas para reordenar.");
      return;
    }
    const idx = typeof stopIdx === "number" ? stopIdx : state.activeStopIdx;
    if (idx < 0 || idx >= state.route.stops.length) return;
    if (idx === 0) {
      showToast("Esta parada já está no início da rota.");
      return;
    }

    const [movedStop] = state.route.stops.splice(idx, 1);
    movedStop.isWalkStop = false;
    movedStop.walkDistanceMeters = 0;
    movedStop.movedToFront = true;
    movedStop.deferredToEnd = false;
    movedStop.hubId = null;
    state.route.stops.unshift(movedStop);
    state.activeStopIdx = 0;
    state.arrivedCurrent = false;

    if (navigator.vibrate) navigator.vibrate(30);
    resequenceRouteAfterDeferral();
    showToast(`⏮ "${movedStop.title}" movida para a frente da rota!`);
  }

  function sendHubToEnd(hubId) {
    if (!state.route || !Array.isArray(state.route.hubs) || state.route.hubs.length <= 1) {
      sendStopToEnd();
      return;
    }
    const hIdx = state.route.hubs.findIndex((h) => h.id === hubId);
    if (hIdx === -1) return;
    if (hIdx === state.route.hubs.length - 1) {
      showToast("Este ponto já está no final da rota.");
      return;
    }

    const [movedHub] = state.route.hubs.splice(hIdx, 1);
    state.route.hubs.push(movedHub);

    const hubStops = state.route.stops.filter((s) => s.hubId === hubId);
    const otherStops = state.route.stops.filter((s) => s.hubId !== hubId);
    state.route.stops = [...otherStops, ...hubStops];
    state.activeStopIdx = Math.min(state.activeStopIdx, Math.max(0, otherStops.length - 1));
    state.arrivedCurrent = false;

    if (navigator.vibrate) navigator.vibrate(30);
    resequenceRouteAfterDeferral();
    showToast(`⏭ Ponto enviado para o final da rota!`);
  }

  function sendHubToFront(hubId) {
    if (!state.route || !Array.isArray(state.route.hubs) || state.route.hubs.length <= 1) {
      sendStopToFront();
      return;
    }
    const hIdx = state.route.hubs.findIndex((h) => h.id === hubId);
    if (hIdx === -1) return;
    if (hIdx === 0) {
      showToast("Este ponto já está na frente da rota.");
      return;
    }

    const [movedHub] = state.route.hubs.splice(hIdx, 1);
    state.route.hubs.unshift(movedHub);

    const hubStops = state.route.stops.filter((s) => s.hubId === hubId);
    const otherStops = state.route.stops.filter((s) => s.hubId !== hubId);
    state.route.stops = [...hubStops, ...otherStops];
    state.activeStopIdx = 0;
    state.arrivedCurrent = false;

    if (navigator.vibrate) navigator.vibrate(30);
    resequenceRouteAfterDeferral();
    showToast(`⏮ Ponto movido para a frente da rota!`);
  }

  function sendItemToEnd(tn) {
    if (!tn || !state.route || !Array.isArray(state.route.stops)) return;
    let foundStopIdx = -1;
    let foundItemIdx = -1;
    for (let sIdx = 0; sIdx < state.route.stops.length; sIdx++) {
      const items = state.route.stops[sIdx].items || [];
      const iIdx = items.findIndex((it) => it.tn === tn);
      if (iIdx !== -1) {
        foundStopIdx = sIdx;
        foundItemIdx = iIdx;
        break;
      }
    }
    if (foundStopIdx === -1) return;

    const sourceStop = state.route.stops[foundStopIdx];
    if (sourceStop.items.length <= 1) {
      sendStopToEnd(foundStopIdx);
      return;
    }

    const [movedItem] = sourceStop.items.splice(foundItemIdx, 1);
    sourceStop.distinctAddresses = RouteOptimizer.countDistinctAddresses(sourceStop.items);
    sourceStop.estimatedMinutes = sourceStop.distinctAddresses * 3;

    const newEndStop = {
      ...sourceStop,
      id: state.route.stops.length + 1,
      items: [movedItem],
      distinctAddresses: 1,
      estimatedMinutes: 3,
      isWalkStop: false,
      walkDistanceMeters: 0,
      deferredToEnd: true,
      hubId: null
    };
    state.route.stops.push(newEndStop);

    if (navigator.vibrate) navigator.vibrate(30);
    resequenceRouteAfterDeferral();
    showToast(`⏭ Pacote ${movedItem.tn} enviado para o final da rota!`);
  }

  function confirmStopAndNext() {
    if (!state.route || !state.route.stops || state.route.stops.length === 0) return;
    // Never overwrite item statuses and never finish the route automatically
    if (state.activeStopIdx < state.route.stops.length - 1) {
      nextStop();
    } else {
      showToast("Você está na última parada. Use o botão 'Encerrar Rota' quando desejar finalizar.");
    }
  }

  function prevStop() {
    if (!state.route || !state.route.stops) return;
    if (state.activeStopIdx > 0) {
      state.activeStopIdx -= 1;
      state.arrivedCurrent = false;
      saveState();
      renderCurrentStopView();
      renderMapBottomSheet();
      if (state.activeTab === "all") {
        renderFullStopsList();
        setTimeout(scrollActiveStopIntoView, 100);
      }
      if (state.map) {
        updateMapMarkers(true);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function openFinishRouteModal() {
    if (!state.route || !state.route.stops || state.route.stops.length === 0) {
      showToast("Nenhuma rota ativa para encerrar.");
      return;
    }

    let delivered = 0;
    let failed = 0;
    let pending = 0;
    const allStops = [
      ...(state.walkedStops || []),
      ...(state.route ? state.route.stops : [])
    ];
    allStops.forEach((s) => {
      (s.items || []).forEach((it) => {
        const st = (state.results[it.tn] && state.results[it.tn].status) || "pending";
        if (st === "delivered") delivered += 1;
        else if (st === "failed") failed += 1;
        else pending += 1;
      });
    });

    const elDel = document.getElementById("finishModalDeliveredCount");
    const elPen = document.getElementById("finishModalPendingCount");
    const elFail = document.getElementById("finishModalFailedCount");
    const warnBox = document.getElementById("finishModalPendingWarning");

    if (elDel) elDel.textContent = String(delivered);
    if (elPen) elPen.textContent = String(pending);
    if (elFail) elFail.textContent = String(failed);
    if (warnBox) {
      warnBox.classList.toggle("hidden", pending === 0);
    }

    openModal("modalConfirmFinishRoute");
  }

  function confirmFinishRoute() {
    closeModal("modalConfirmFinishRoute");
    finishRoute(true);
  }

  function finishRoute(confirmedByUser = false) {
    if (confirmedByUser !== true) {
      openFinishRouteModal();
      return;
    }

    state.finished = true;
    state.endTime = new Date().toLocaleString("pt-BR");

    // Limpa as fotos temporárias da rota finalizada (libera espaço no dispositivo)
    if (typeof PhotoStorage !== "undefined") {
      PhotoStorage.clearAllPhotos();
    }
    state.photos = {};

    saveState();

    const summary = getRouteSummary();
    FirebaseService.saveRouteToHistory(summary);

    switchScreen("report");
    showToast("Rota concluída e salva no histórico!");
  }

  function getRouteSummary() {
    let delivered = 0;
    let failed = 0;
    const details = [];
    const allStops = [
      ...(state.walkedStops || []),
      ...(state.route ? state.route.stops : [])
    ];

    allStops.forEach((s) => {
      s.items.forEach((it) => {
        const res = state.results[it.tn] || { status: "failed", reason: "Não visitado" };
        if (res.status === "delivered") {
          delivered += 1;
        } else {
          failed += 1;
        }
        details.push({
          tn: it.tn || "",
          address: it.address || "",
          stopId: s.originalId || s.id || 0,
          status: res.status || "delivered",
          reason: res.reason || "",
          time: res.time || ""
        });
      });
    });

    const totalPackages = state.route ? Math.max(state.route.totalPackages, details.length) : details.length;
    const successRate = totalPackages > 0 ? Math.round((delivered / totalPackages) * 100) : 0;
    const firstStop = allStops[0];

    return {
      startTime: state.startTime || "-",
      endTime: state.endTime || "-",
      totalStops: allStops.length,
      totalPackages,
      deliveredCount: delivered,
      failedCount: failed,
      successRate,
      region: firstStop ? `${firstStop.bairro} • ${firstStop.city}` : "SPX Route",
      details
    };
  }

  // --- FULL SEQUENTIAL STOPS TAB ---
  function renderFullStopsList() {
    const list = document.getElementById("fullStopsListContainer");
    if (!state.route) return;

    const btnAllFull = document.getElementById("btnAllStopsFullMaps");
    if (btnAllFull) {
      btnAllFull.href = RouteOptimizer.buildGoogleMapsRouteUrl(getCarRoutingPoints(), 0, null, state.userCoords || state.route.originLocation);
    }
    syncNavAppUI();

    const isWaze = state.navApp === "waze";

    list.innerHTML = state.route.stops
      .map((s, idx) => {
        const isActive = idx === state.activeStopIdx;
        const allDelivered = s.items.every((it) => state.results[it.tn] && state.results[it.tn].status === "delivered");
        const allFailed = s.items.every((it) => state.results[it.tn] && state.results[it.tn].status === "failed");
        const isDone = allDelivered;
        const aptSummary = s.distinctAddresses > 1 ? ` • ${s.distinctAddresses} apts (~${s.distinctAddresses * 3} min)` : ` (~${(s.distinctAddresses || 1) * 3} min)`;
        const walkTagHtml = s.isWalkStop
          ? `<div class="walk-stop-tag">🚶 Ponto #${s.hubId || s.walkFromStopId || "-"} (~${s.walkDistanceMeters || 0}m)</div>`
          : "";
        const wazeBtnHtml = isWaze
          ? `<a href="${RouteOptimizer.buildWazeUrl(getStopHub(s) || s)}" target="_blank" rel="noopener" class="btn btn-waze btn-xs" onclick="event.stopPropagation()">Waze</a>`
          : "";
        const inlineItemsHtml = buildCompactItemStatusRowsHtml(s);

        return `
        <div class="stop-row-card ${isActive ? "active-stop" : ""} ${isDone && !isActive ? "done-stop" : ""}" style="flex-direction:column; align-items:stretch; gap:8px;" onclick="app.jumpToStop(${idx})">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%;">
            <div style="display:flex; align-items:center; gap:10px; min-width:0;">
              <div class="stop-idx-badge">
                ${isDone && !isActive ? renderIcon("check", 16) : `#${s.id}`}
              </div>
              <div style="min-width:0;">
                <div style="font-weight:700; font-size:0.9rem;">${s.title}</div>
                <div class="meta-text">${s.bairro} • ${s.items.length} ${s.items.length > 1 ? "pacotes" : "pacote"}${aptSummary}</div>
                ${walkTagHtml}
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
              ${wazeBtnHtml}
              ${idx > 0 ? `<button type="button" class="btn btn-outline btn-xs" style="width:auto; padding:3px 7px; font-size:0.7rem;" onclick="event.stopPropagation(); app.sendStopToFront(${idx})" title="Trazer parada para a frente da rota">⏮ Frente</button>` : ""}
              ${idx < state.route.stops.length - 1 ? `<button type="button" class="btn btn-outline btn-xs" style="width:auto; padding:3px 7px; font-size:0.7rem;" onclick="event.stopPropagation(); app.sendStopToEnd(${idx})" title="Enviar parada para o final da rota">⏭ Final</button>` : ""}
              <span class="badge ${isActive ? "badge-primary" : isDone ? "badge-success" : (allFailed ? "badge-danger" : "")}">
                ${isActive ? "Atual" : isDone ? "Entregue" : (allFailed ? "Falha" : "Pendente")}
              </span>
            </div>
          </div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            ${inlineItemsHtml}
          </div>
        </div>
      `;
      })
      .join("");
  }

  function jumpToStop(idx) {
    if (!state.route || !state.route.stops[idx]) return;
    state.activeStopIdx = idx;
    state.arrivedCurrent = false;
    saveState();
    renderCurrentStopView();
    renderMapBottomSheet();
    if (state.activeTab === "map") {
      if (state.map) updateMapMarkers(true);
    } else {
      switchTab("current");
    }
  }

  function openStopDetails(idx) {
    if (!state.route || !state.route.stops[idx]) return;
    state.activeStopIdx = idx;
    state.arrivedCurrent = false;
    saveState();
    renderCurrentStopView();
    renderMapBottomSheet();
    switchTab("current");
  }

  // --- ORGANIZE / SCANNER TAB & REVERSE LOADING ORDER ---
  function getReverseLoadingItems() {
    if (!state.route || !state.route.stops || state.route.stops.length === 0) return [];
    const items = [];
    // Ordem inversa de entrega: da última parada para a primeira
    for (let sIdx = state.route.stops.length - 1; sIdx >= 0; sIdx--) {
      const stop = state.route.stops[sIdx];
      // Dentro da parada, ordem inversa dos itens
      for (let pIdx = stop.items.length - 1; pIdx >= 0; pIdx--) {
        const item = stop.items[pIdx];
        items.push({
          item,
          stop,
          stopIndex: sIdx,
          packageIndex: pIdx,
          loadIndex: items.length + 1 // 1º a carregar, 2º a carregar...
        });
      }
    }
    return items;
  }

  function renderLoadingOrderList() {
    const container = document.getElementById("loadingOrderListContainer");
    if (!container) return;

    if (!state.route || !state.route.stops || state.route.stops.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:20px; text-align:center;">
          <div class="meta-text">Nenhuma rota carregada no momento.</div>
        </div>
      `;
      return;
    }

    const allItems = getReverseLoadingItems();
    const totalCount = allItems.length;

    let countChecked = 0;
    let countPhoto = 0;
    allItems.forEach((entry) => {
      const isChecked = !!(state.loadedPackages[entry.item.tn] || PackageScanner.isScanned(entry.item.tn));
      const hasPhoto = !!state.photos[entry.item.tn];
      if (isChecked) countChecked++;
      if (hasPhoto) countPhoto++;
    });
    const countPending = totalCount - countChecked;

    const elAll = document.getElementById("loadFilterCountAll");
    const elPending = document.getElementById("loadFilterCountPending");
    const elChecked = document.getElementById("loadFilterCountChecked");
    const elPhoto = document.getElementById("loadFilterCountPhoto");
    const progressBadge = document.getElementById("organizeLoadingProgressBadge");
    const countEl = document.getElementById("organizeScannedCount");

    if (elAll) elAll.textContent = totalCount;
    if (elPending) elPending.textContent = countPending;
    if (elChecked) elChecked.textContent = countChecked;
    if (elPhoto) elPhoto.textContent = countPhoto;

    const pct = totalCount > 0 ? Math.round((countChecked / totalCount) * 100) : 0;
    if (progressBadge) progressBadge.textContent = `${countChecked}/${totalCount} no carro (${pct}%)`;
    if (countEl) countEl.textContent = `${countChecked} de ${totalCount} no carro`;

    // Active filter pill
    document.querySelectorAll(".load-filter-pills .filter-pill").forEach((pill) => {
      pill.classList.toggle("active", pill.dataset.loadFilter === state.loadingFilter);
    });

    const loadingSearchInput = document.getElementById("loadingSearchInput");
    const scannerSearchInput = document.getElementById("scannerSearchInput");
    const rawQuery = (loadingSearchInput && loadingSearchInput.value.trim())
      || (scannerSearchInput && scannerSearchInput.value.trim())
      || "";
    const query = rawQuery.toLowerCase();

    const filtered = allItems.filter((entry) => {
      const isChecked = !!(state.loadedPackages[entry.item.tn] || PackageScanner.isScanned(entry.item.tn));
      const hasPhoto = !!state.photos[entry.item.tn];

      if (state.loadingFilter === "pending" && isChecked) return false;
      if (state.loadingFilter === "checked" && !isChecked) return false;
      if (state.loadingFilter === "photo" && !hasPhoto) return false;

      if (query) {
        const text = [
          entry.item.tn,
          entry.item.address,
          entry.item.complement,
          entry.item.recipient,
          entry.item.notes,
          entry.item.sortCode,
          state.packageLocations[entry.item.tn],
          entry.stop.title,
          entry.stop.bairro,
          entry.stop.zipcode,
          `parada ${entry.stop.id}`,
          `#${entry.stop.id}`,
          `pacote ${entry.item.seq}`,
          entry.item.apartmentInfo && entry.item.apartmentInfo.displayLabel
        ].filter(Boolean).join(" ").toLowerCase();

        if (!text.includes(query)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding:20px; background:var(--surface-2); border-radius:var(--radius-md); border:1px dashed var(--border);">
          <div class="meta-text">Nenhum pacote encontrado para o filtro selecionado.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map((entry) => {
      const { item, stop, packageIndex } = entry;
      const isChecked = !!(state.loadedPackages[item.tn] || PackageScanner.isScanned(item.tn));
      const photoUrl = state.photos[item.tn] || null;
      const carLocation = state.packageLocations[item.tn] || "";

      const aptLabel = (item.apartmentInfo && item.apartmentInfo.hasApartment) ? item.apartmentInfo.displayLabel : "";
      const aptBadge = aptLabel
        ? `<div class="load-apt-highlight">🏢 ${aptLabel}</div>`
        : "";

      const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const hasComplement = item.complement && item.complement !== "Sem complemento";
      const showComplement = hasComplement && (!aptLabel || norm(item.complement) !== norm(aptLabel));

      const stopMultiLabel = stop.items.length > 1
        ? ` • Pct ${packageIndex + 1}/${stop.items.length}`
        : "";

      const extraPills = [
        item.recipient ? `<span class="load-extra-pill">👤 ${item.recipient}</span>` : "",
        item.sortCode ? `<span class="load-extra-pill">🏷️ ${item.sortCode}</span>` : "",
        item.notes ? `<span class="load-extra-pill">📝 ${item.notes}</span>` : ""
      ].filter(Boolean).join("");

      return `
        <div class="loading-item-card ${isChecked ? "is-checked" : ""}" id="loadCard-${item.tn}">
          <div class="loading-item-top">
            <div class="load-top-badges">
              <span class="load-seq-badge">Entrega #${item.seq}</span>
              <span class="load-stop-badge">Parada #${stop.id}${stopMultiLabel}</span>
            </div>

            <label class="load-check-corner" title="Marcar como conferido no carro">
              <input
                type="checkbox"
                class="load-check-input"
                ${isChecked ? "checked" : ""}
                onchange="app.toggleItemChecked('${item.tn}')"
                aria-label="Conferir pacote ${item.tn}"
              />
            </label>
          </div>

          <div class="loading-item-body">
            <div class="load-address-block">
              <div class="load-address">${stop.title}</div>
              <div class="load-subaddress">
                <span>${stop.bairro}</span>
                ${stop.zipcode ? `<span>• CEP ${stop.zipcode}</span>` : ""}
              </div>
              ${aptBadge}
            </div>

            ${showComplement ? `
              <div class="load-complement"><strong>Compl:</strong> ${item.complement}</div>
            ` : ""}

            ${extraPills ? `<div class="load-meta-extras">${extraPills}</div>` : ""}

            <div class="load-tn-row">
              <div class="load-tn-codes">
                <span class="load-tn">Rastreio: <strong>${item.tn}</strong></span>
                ${item.atId ? `<span class="load-atid">ID: ${item.atId}</span>` : ""}
              </div>
              <button type="button" class="btn-copy-tn" onclick="app.copyTrackingCode('${item.tn}')">Copiar</button>
            </div>

            <div class="load-location-bar">
              <span>${carLocation ? `📍 <strong>Local no carro:</strong> ${carLocation}` : `<span class="meta-text">📍 Local no carro não definido</span>`}</span>
              <button type="button" class="btn-copy-tn" onclick="app.togglePackageLocationEditor('${item.tn}')">
                ${carLocation ? "Alterar local" : "+ Local no carro"}
              </button>
            </div>
            <div id="locEditor-${item.tn}" class="hidden" style="display:flex; flex-direction:column; gap:6px; padding-top:4px;">
              <div style="display:flex; gap:6px;">
                <input type="text" id="locInput-${item.tn}" class="input-field" style="padding:6px 8px; font-size:0.8rem;" placeholder="Ex: Banco frente, Caixa 1, Lado esq..." value="${carLocation.replace(/"/g, "&quot;")}" />
                <button type="button" class="btn btn-primary btn-sm" style="width:auto; padding:6px 10px;" onclick="app.savePackageLocation('${item.tn}')">Salvar</button>
              </div>
              <div style="display:flex; flex-wrap:wrap; gap:4px;">
                ${["Banco frente", "Porta-malas esq.", "Porta-malas dir.", "Fundo", "Sacola/Caixa"].map((preset) => `
                  <button type="button" class="filter-pill" style="font-size:0.7rem; padding:3px 8px;" onclick="app.setPackageLocationPreset('${item.tn}', '${preset}')">${preset}</button>
                `).join("")}
              </div>
            </div>
            ${buildPackageSpecControls(item)}
          </div>

          <div class="loading-item-photo-bar">
            ${photoUrl ? `
              <div class="load-photo-thumb-wrap" onclick="app.viewPhotoLarge('${photoUrl}', 'Parada #${stop.id} • Entrega #${item.seq} • ${item.tn}')">
                <img src="${photoUrl}" alt="Foto Pacote ${item.tn}" class="load-photo-thumb" />
                <span class="load-photo-badge">${renderIcon("camera", 14)} Ver Foto</span>
              </div>
              <button type="button" class="btn btn-ghost btn-xs" onclick="app.capturePhotoForTn('${item.tn}')">
                Trocar Foto
              </button>
            ` : `
              <button type="button" class="btn btn-outline btn-sm btn-load-photo" onclick="app.capturePhotoForTn('${item.tn}')">
                ${renderIcon("camera", 15)} Tirar Foto
              </button>
            `}
          </div>
        </div>
      `;
    }).join("");
  }

  function copyTrackingCode(tn) {
    if (!tn || !navigator.clipboard) return;
    navigator.clipboard.writeText(tn).then(() => {
      showToast(`Código ${tn} copiado!`);
    }).catch(() => {
      showToast("Não foi possível copiar o código.");
    });
  }

  function togglePackageLocationEditor(tn) {
    const el = document.getElementById(`locEditor-${tn}`);
    if (!el) return;
    el.classList.toggle("hidden");
    if (!el.classList.contains("hidden")) {
      const inp = document.getElementById(`locInput-${tn}`);
      if (inp) inp.focus();
    }
  }

  function savePackageLocation(tn) {
    const inp = document.getElementById(`locInput-${tn}`);
    const val = inp ? inp.value.trim() : "";
    if (val) {
      state.packageLocations[tn] = val;
    } else {
      delete state.packageLocations[tn];
    }
    saveState();
    renderLoadingOrderList();
    if (state.activeTab === "current") {
      renderCurrentStopView();
    }
    showToast(val ? `Local salvo: ${val}` : "Local removido.");
  }

  function setPackageLocationPreset(tn, preset) {
    state.packageLocations[tn] = preset;
    saveState();
    renderLoadingOrderList();
    if (state.activeTab === "current") {
      renderCurrentStopView();
    }
    showToast(`Local definido: ${preset}`);
  }

  function setLoadingFilter(filter) {
    state.loadingFilter = filter;
    renderLoadingOrderList();
  }

  function toggleItemChecked(tn) {
    const isCurrentlyChecked = !!(state.loadedPackages[tn] || PackageScanner.isScanned(tn));
    const nextState = !isCurrentlyChecked;
    state.loadedPackages[tn] = nextState;
    saveState();
    renderOrganizeView();
  }

  function renderOrganizeView() {
    renderLoadingOrderList();
  }

  // --- PHOTO CAPTURE & VIEWING ---
  function updateScanModalPhotoUI(tn) {
    const noPhotoBox = document.getElementById("modalScanNoPhotoBox");
    const hasPhotoBox = document.getElementById("modalScanHasPhotoBox");
    const photoImg = document.getElementById("modalScanPhotoImg");

    if (!tn) {
      if (noPhotoBox) noPhotoBox.classList.remove("hidden");
      if (hasPhotoBox) hasPhotoBox.classList.add("hidden");
      return;
    }

    const photoUrl = state.photos[tn] || null;
    if (photoUrl) {
      if (noPhotoBox) noPhotoBox.classList.add("hidden");
      if (hasPhotoBox) hasPhotoBox.classList.remove("hidden");
      if (photoImg) photoImg.src = photoUrl;
    } else {
      if (noPhotoBox) noPhotoBox.classList.remove("hidden");
      if (hasPhotoBox) hasPhotoBox.classList.add("hidden");
      if (photoImg) photoImg.src = "";
    }
  }

  function triggerPackagePhotoCapture() {
    if (!currentPhotoTn) return;
    const input = document.getElementById("packagePhotoFileInput");
    if (input) {
      input.value = "";
      input.click();
    }
  }

  function capturePhotoForTn(tn) {
    currentPhotoTn = tn;
    triggerPackagePhotoCapture();
  }

  async function handlePhotoFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file || !currentPhotoTn) return;

    try {
      showToast("Comprimindo e salvando foto...");
      const compressedDataUrl = await PhotoStorage.compressImageFile(file, 1080, 1080, 0.72);
      await PhotoStorage.savePhoto(currentPhotoTn, compressedDataUrl);
      state.photos[currentPhotoTn] = compressedDataUrl;

      updateScanModalPhotoUI(currentPhotoTn);
      renderLoadingOrderList();
      if (state.activeTab === "current") {
        renderCurrentStopView();
      }
      showToast("📸 Foto do pacote salva com sucesso!");
    } catch (err) {
      console.warn("Erro ao salvar foto:", err);
      showToast("Erro ao processar a foto.");
    }
  }

  async function deleteCurrentPackagePhoto() {
    if (!currentPhotoTn) return;
    try {
      await PhotoStorage.deletePhoto(currentPhotoTn);
      delete state.photos[currentPhotoTn];
      updateScanModalPhotoUI(currentPhotoTn);
      renderLoadingOrderList();
      if (state.activeTab === "current") {
        renderCurrentStopView();
      }
      showToast("Foto removida.");
    } catch (err) {
      console.warn("Erro ao remover foto:", err);
    }
  }

  function viewPhotoLarge(src, metaText = "") {
    if (!src) return;
    const modal = document.getElementById("modalPhotoViewer");
    const img = document.getElementById("photoViewerImg");
    const meta = document.getElementById("photoViewerMeta");

    if (img) img.src = src;
    if (meta) meta.textContent = metaText || "";
    if (modal) modal.classList.remove("hidden");
  }

  function showPackageModal(result) {
    currentPhotoTn = result.item.tn;
    // Marca automaticamente como conferido no veículo ao bipar
    state.loadedPackages[result.item.tn] = true;
    saveState();

    const stopNumEl = document.getElementById("modalScanStopNumber");
    const orderEl = document.getElementById("modalScanPackageOrder");
    const aptEl = document.getElementById("modalScanApartment");
    const addrEl = document.getElementById("modalScanAddress");
    const compEl = document.getElementById("modalScanComplement");
    const tnEl = document.getElementById("modalScanTnCode");

    if (stopNumEl) stopNumEl.textContent = `PARADA #${result.stop.id}`;
    if (orderEl) orderEl.textContent = `Pacote #${result.item.seq} de ${state.route.totalPackages}`;
    if (aptEl) {
      if (result.item.apartmentInfo && result.item.apartmentInfo.hasApartment) {
        aptEl.textContent = `🏢 ${result.item.apartmentInfo.displayLabel}`;
        aptEl.classList.remove("hidden");
      } else {
        aptEl.classList.add("hidden");
      }
    }
    if (addrEl) addrEl.textContent = result.stop.title;
    if (compEl) {
      if (result.item.apartmentInfo && result.item.apartmentInfo.hasApartment) {
        compEl.innerHTML = `<span style="display:inline-block; background:rgba(238,77,45,0.12); color:var(--primary); padding:2px 8px; border-radius:4px; font-weight:800; font-size:0.85rem; margin-bottom:4px;">🏢 ${result.item.apartmentInfo.displayLabel}</span><br>Complemento: ${result.item.complement || "Sem complemento"}`;
      } else {
        compEl.textContent = result.item.complement ? `Complemento: ${result.item.complement}` : "Sem complemento";
      }
    }
    if (tnEl) tnEl.textContent = result.item.tn;

    // Atualiza foto no modal (permite tirar foto se não tiver, ou ver se já tiver)
    updateScanModalPhotoUI(currentPhotoTn);

    // Atualiza também o cartão inferior para conferência rápida
    const resultCard = document.getElementById("scanResultDisplay");
    if (resultCard) {
      resultCard.classList.remove("hidden");
      const cardStop = document.getElementById("scanStopNumber");
      const cardOrder = document.getElementById("scanPackageOrder");
      const cardAddr = document.getElementById("scanAddress");
      const cardComp = document.getElementById("scanComplement");
      const cardTn = document.getElementById("scanTnCode");
      if (cardStop) cardStop.textContent = `PARADA #${result.stop.id}`;
      if (cardOrder) cardOrder.textContent = `Pacote #${result.item.seq} de ${state.route.totalPackages}`;
      if (cardAddr) cardAddr.textContent = result.stop.title;
      if (cardComp) {
        if (result.item.apartmentInfo && result.item.apartmentInfo.hasApartment) {
          cardComp.textContent = `🏢 ${result.item.apartmentInfo.displayLabel} • ${result.item.complement}`;
        } else {
          cardComp.textContent = result.item.complement || "";
        }
      }
      if (cardTn) cardTn.textContent = result.item.tn;
    }

    renderOrganizeView();
    openModal("modalScanPackage");
  }

  function closeScanModal() {
    closeModal("modalScanPackage");
    PackageScanner.resumeScanning();
  }

  function startScanner() {
    if (!state.route) {
      showToast("Carregue uma rota primeiro.");
      return;
    }
    const startBtn = document.getElementById("scannerStartBtn");
    const stopBtn = document.getElementById("scannerStopBtn");
    const qrBox = document.getElementById("qrReaderElement");
    if (startBtn) startBtn.classList.add("hidden");
    if (stopBtn) stopBtn.classList.remove("hidden");
    if (qrBox) qrBox.classList.remove("hidden");

    PackageScanner.startCamera("qrReaderElement", state.route.stops, (result, found) => {
      if (found) {
        showPackageModal(result);
      } else {
        const resultCard = document.getElementById("scanResultDisplay");
        if (resultCard) {
          resultCard.classList.remove("hidden");
          document.getElementById("scanStopNumber").textContent = "CÓDIGO NÃO LOCALIZADO";
          document.getElementById("scanPackageOrder").textContent = result.rawCode || "Desconhecido";
          document.getElementById("scanAddress").textContent = "Este pacote não pertence à rota atual.";
          document.getElementById("scanComplement").textContent = "";
          document.getElementById("scanTnCode").textContent = "";
        }
        showToast("Código não encontrado nesta rota.");
      }
    });
  }

  function stopScanner() {
    if (typeof PackageScanner !== "undefined") {
      PackageScanner.stopCamera();
    }
    closeModal("modalScanPackage");
    const startBtn = document.getElementById("scannerStartBtn");
    const stopBtn = document.getElementById("scannerStopBtn");
    const qrBox = document.getElementById("qrReaderElement");
    if (startBtn) startBtn.classList.remove("hidden");
    if (stopBtn) stopBtn.classList.add("hidden");
    if (qrBox) qrBox.classList.add("hidden");
  }

  function triggerManualScanFromInput() {
    const inp = document.getElementById("loadingSearchInput") || document.getElementById("scannerSearchInput");
    if (!inp || !inp.value.trim()) {
      showToast("Digite ou bipe o código de rastreio do pacote.");
      return;
    }
    handleManualSearch(inp.value.trim());
    renderLoadingOrderList();
  }

  function handleManualSearch(query) {
    if (!state.route || !query.trim()) return;
    const match = PackageScanner.manualSearch(query, state.route.stops);
    if (match) {
      PackageScanner.playBeep(true);
      showPackageModal(match);
    } else {
      PackageScanner.playBeep(false);
      const resultCard = document.getElementById("scanResultDisplay");
      if (resultCard) {
        resultCard.classList.remove("hidden");
        document.getElementById("scanStopNumber").textContent = "NÃO ENCONTRADO";
        document.getElementById("scanPackageOrder").textContent = query;
        document.getElementById("scanAddress").textContent = "Verifique o código digitado.";
        document.getElementById("scanComplement").textContent = "";
        document.getElementById("scanTnCode").textContent = "";
      }
      showToast("Pacote não encontrado nesta rota.");
    }
  }

  // --- LEAFLET MAP COM TODAS AS PARADAS E ANIMAÇÃO DE PERCURSO ---
  let mapAnim = {
    frameId: null,
    totalDistance: 0,
    segments: [],
    startTime: null,
    durationMs: 14000
  };

  function toggleMapItemsDrawer() {
    state.mapItemsDrawerOpen = !state.mapItemsDrawerOpen;
    const drawer = document.getElementById("mapSheetItemsDrawer");
    if (drawer) drawer.classList.toggle("hidden", !state.mapItemsDrawerOpen);
    renderMapBottomSheet();
  }

  function renderMapBottomSheet() {
    const emptyOverlay = document.getElementById("mapEmptyOverlay");
    const bottomSheet = document.getElementById("mapBottomStopSheet");

    if (!state.route || !state.route.stops || state.route.stops.length === 0) {
      if (emptyOverlay) emptyOverlay.classList.remove("hidden");
      if (bottomSheet) bottomSheet.classList.add("hidden");
      return;
    }

    if (emptyOverlay) emptyOverlay.classList.add("hidden");
    if (bottomSheet) bottomSheet.classList.remove("hidden");

    const stop = state.route.stops[state.activeStopIdx] || state.route.stops[0];
    if (!stop) return;
    const hub = getStopHub(stop);

    const stopBadge = document.getElementById("mapSheetStopBadge");
    const hubBadge = document.getElementById("mapSheetHubBadge");
    const walkTag = document.getElementById("mapSheetWalkTag");
    const titleEl = document.getElementById("mapSheetStopTitle");
    const metaEl = document.getElementById("mapSheetStopMeta");
    const btnWalk = document.getElementById("btnMapWalkRoute");
    const btnDrawer = document.getElementById("btnToggleMapItemsDrawer");
    const drawer = document.getElementById("mapSheetItemsDrawer");
    const itemsContainer = document.getElementById("mapSheetItemsContainer");

    if (stopBadge) stopBadge.textContent = `Parada #${stop.id} de ${state.route.stops.length}`;
    if (hubBadge) {
      if (hub) {
        hubBadge.textContent = `🅿️ Ponto #${hub.id}`;
        hubBadge.classList.remove("hidden");
      } else {
        hubBadge.classList.add("hidden");
      }
    }
    if (walkTag) {
      walkTag.textContent = stop.isWalkStop ? `🚶 ~${stop.walkDistanceMeters || 0}m a pé` : "";
    }
    if (titleEl) titleEl.textContent = stop.title;
    if (metaEl) {
      metaEl.textContent = `${stop.bairro} • ${stop.items.length} ${stop.items.length > 1 ? "pacotes" : "pacote"}`;
    }

    if (btnWalk) {
      if (hub) {
        const plan = hub.walkPlan || RouteOptimizer.buildHubWalkPlan(hub, state.packageSpecs, state.results);
        btnWalk.href = plan.walkUrl || RouteOptimizer.buildWalkingTripUrl(hub, hub.stops, false);
      } else {
        btnWalk.href = RouteOptimizer.buildWalkingTripUrl(stop, [stop], false);
      }
    }

    if (btnDrawer) {
      btnDrawer.textContent = `📦 Ver Pacotes (${stop.items.length}) ${state.mapItemsDrawerOpen ? "▾" : "▸"}`;
    }
    if (drawer) {
      drawer.classList.toggle("hidden", !state.mapItemsDrawerOpen);
    }
    if (itemsContainer) {
      itemsContainer.innerHTML = buildCompactItemStatusRowsHtml(stop);
    }

    syncNavAppUI();
  }

  function initLeafletMap() {
    renderMapBottomSheet();
    const mapEl = document.getElementById("map");
    if (!mapEl || typeof L === "undefined") return;

    if (state.map) {
      if (state.route && state.route.stops && state.route.stops.length > 0) {
        updateMapMarkers();
        startRouteAnimation();
      } else if (state.userCoords && state.userCoords.latitude && state.userCoords.longitude) {
        updateGpsMapMarker(state.userCoords.latitude, state.userCoords.longitude);
        state.map.setView([state.userCoords.latitude, state.userCoords.longitude], 15);
      }
      return;
    }

    let initLat = -23.420999;
    let initLon = -51.933056;
    if (state.userCoords && state.userCoords.latitude && state.userCoords.longitude) {
      initLat = state.userCoords.latitude;
      initLon = state.userCoords.longitude;
    } else if (state.route && state.route.stops && state.route.stops[0]) {
      initLat = state.route.stops[0].lat || initLat;
      initLon = state.route.stops[0].lon || initLon;
    }

    state.map = L.map("map", {
      zoomControl: false,
      attributionControl: false
    }).setView([initLat, initLon], 15);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19
    }).addTo(state.map);

    if (state.route && state.route.stops && state.route.stops.length > 0) {
      updateMapMarkers();
      startRouteAnimation();
    } else if (state.userCoords && state.userCoords.latitude && state.userCoords.longitude) {
      updateGpsMapMarker(state.userCoords.latitude, state.userCoords.longitude);
    }
  }

  function updateMapNavHud() {
    if (!state.route || state.route.stops.length === 0) return;
    const stop = state.route.stops[state.activeStopIdx] || state.route.stops[0];
    const kickerEl = document.getElementById("mapRouteModeKicker");
    const turnEl = document.getElementById("mapNextTurnInstruction");
    const pillEl = document.getElementById("mapActiveStopPill");

    const hub = getStopHub(stop);
    if (kickerEl) {
      const hubTag = hub ? ` • Ponto #${hub.id} (${hub.stops.length} entrega${hub.stops.length > 1 ? "s" : ""})` : "";
      kickerEl.textContent = (state.route.usedRoadRouting
        ? "Trajeto pelas vias a partir de você"
        : "Modo offline (aproximação local)") + hubTag;
    }
    if (pillEl && stop) {
      pillEl.textContent = hub
        ? `P#${hub.id} • #${stop.id}`
        : `Parada #${stop.id}`;
    }
    if (!turnEl || !stop) return;

    if (stop.isWalkStop) {
      turnEl.textContent = `🚶 Siga a pé ~${stop.walkDistanceMeters || 0}m até ${stop.title}`;
      return;
    }

    const maneuvers = state.route.maneuvers || [];
    if (maneuvers.length > 0 && state.userCoords) {
      const uLat = state.userCoords.latitude;
      const uLon = state.userCoords.longitude;
      let nearest = null;
      let bestDist = Infinity;
      for (const m of maneuvers) {
        if (m.toStopId && m.toStopId < stop.id) continue;
        const d = RouteOptimizer.haversineMeters(uLat, uLon, m.lat, m.lon);
        if (d < bestDist && d >= 15) {
          bestDist = d;
          nearest = m;
        }
      }
      if (nearest) {
        const dLabel = bestDist >= 1000 ? `${(bestDist / 1000).toFixed(1)}km` : `${Math.round(bestDist)}m`;
        turnEl.textContent = `${nearest.instruction} • em ${dLabel}`;
        return;
      }
    }

    const nextStopManeuver = maneuvers.find((m) => m.toStopId === stop.id && m.instruction && !m.instruction.startsWith("Chegada"));
    turnEl.textContent = nextStopManeuver
      ? `${nextStopManeuver.instruction} ➔ Parada #${stop.id}`
      : `Destino: ${stop.title}`;
  }

  function updateGpsMapMarker(lat, lon) {
    if (!state.map || !lat || !lon) return;
    if (state.markers.gpsUser) {
      state.markers.gpsUser.setLatLng([lat, lon]);
    } else {
      const gpsIcon = L.divIcon({
        className: "map-vehicle-icon-wrap",
        html: `
          <div class="map-vehicle-dot" title="Sua posição atual (Entregador)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff">
              <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10l-1.5-3H9c-1.1 0-2 .9-2 2v2H3c-.6 0-1 .4-1 1v5c0 .6.4 1 1 1h2c0 1.7 1.3 3 3 3s3-1.3 3-3h6c0 1.7 1.3 3 3 3s3-1.3 3-3zM7 18.5c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zm11 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5z"/>
            </svg>
          </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      });
      state.markers.gpsUser = L.marker([lat, lon], { icon: gpsIcon, zIndexOffset: 1500 })
        .addTo(state.map)
        .bindPopup('<div class="map-stop-popup"><div class="map-stop-badge" style="color:#2563eb;">🚗 SUA POSIÇÃO ATUAL</div><div class="map-stop-title">Localização do Entregador (Ponto de Partida)</div></div>');
    }
    if (state.followGps) {
      state.map.panTo([lat, lon], { animate: true });
    }
  }

  function toggleFollowGps() {
    state.followGps = !state.followGps;
    const btn = document.getElementById("btnToggleFollowGps");
    if (btn) btn.classList.toggle("active", state.followGps);
    if (state.followGps) {
      if (!state.userCoords) initGPS();
      if (state.map && state.userCoords) {
        state.map.setView([state.userCoords.latitude, state.userCoords.longitude], 17);
      }
      showToast("Câmera seguindo sua posição GPS.");
    }
  }

  function updateMapMarkers(recenter = true) {
    renderMapBottomSheet();
    if (!state.map || !state.route || state.route.stops.length === 0) return;

    const stops = state.route.stops;
    const hubs = Array.isArray(state.route.hubs) ? state.route.hubs : [];
    const hasRoadGeo = Array.isArray(state.route.routeGeometry) && state.route.routeGeometry.length > 1;
    const originCoord = (state.userCoords && state.userCoords.latitude && state.userCoords.longitude)
      ? [state.userCoords.latitude, state.userCoords.longitude]
      : (state.route.originLocation && state.route.originLocation.lat && state.route.originLocation.lon
        ? [state.route.originLocation.lat, state.route.originLocation.lon]
        : null);
    const fallbackHubCoords = hubs.length > 0
      ? hubs.map((h) => [h.lat, h.lon])
      : stops.filter((s) => !s.isWalkStop).map((s) => [s.lat, s.lon]);
    const fallbackWithOrigin = originCoord ? [originCoord, ...fallbackHubCoords] : fallbackHubCoords;
    const driveLatlngs = hasRoadGeo ? state.route.routeGeometry : fallbackWithOrigin;
    const pathLatlngs = driveLatlngs.length > 1 ? driveLatlngs : stops.map((s) => [s.lat, s.lon]);

    // Linha de Traçado das Vias (sólida quando calculada pelo OSRM, tracejada no modo offline)
    if (state.markers.routeBorderLine) state.map.removeLayer(state.markers.routeBorderLine);
    if (state.markers.routeLine) state.map.removeLayer(state.markers.routeLine);
    if (state.markers.walkLines && state.markers.walkLines.length > 0) {
      state.markers.walkLines.forEach((wl) => state.map.removeLayer(wl));
    }
    state.markers.walkLines = [];

    state.markers.routeBorderLine = L.polyline(pathLatlngs, {
      color: "#0f172a",
      weight: 7,
      opacity: 0.72,
      lineCap: "round",
      lineJoin: "round"
    }).addTo(state.map);

    state.markers.routeLine = L.polyline(pathLatlngs, {
      color: "#ee4d2d",
      weight: 4,
      opacity: 0.95,
      dashArray: hasRoadGeo ? null : "8, 6",
      lineCap: "round",
      lineJoin: "round"
    }).addTo(state.map);

    // Caminhos tracejados a pé seguindo calçadas/vias a partir de cada Ponto de Parada
    const walkPolylines = Array.isArray(state.route.walkPolylines) ? state.route.walkPolylines : [];
    const walkPaths = walkPolylines.length > 0
      ? walkPolylines.map((wp) => wp.coords).filter((c) => Array.isArray(c) && c.length > 1)
      : (state.route.walkSegments || RouteOptimizer.buildWalkSegments(stops));

    walkPaths.forEach((seg) => {
      const wl = L.polyline(seg, {
        color: "#10b981",
        weight: 3.5,
        opacity: 0.92,
        dashArray: "5, 6",
        lineCap: "round",
        lineJoin: "round"
      }).addTo(state.map);
      state.markers.walkLines.push(wl);
    });

    // Remove marcadores anteriores de Pontos de Parada e Entregas
    if (state.markers.allHubs && state.markers.allHubs.length > 0) {
      state.markers.allHubs.forEach((m) => state.map.removeLayer(m));
    }
    state.markers.allHubs = [];

    if (state.markers.allStops && state.markers.allStops.length > 0) {
      state.markers.allStops.forEach((m) => state.map.removeLayer(m));
    }
    state.markers.allStops = [];

    const activeStopObj = stops[state.activeStopIdx];
    const activeHubId = activeStopObj ? activeStopObj.hubId : null;

    // Plota Pontos de Parada (Hubs) no mapa
    hubs.forEach((hub) => {
      const isActiveHub = hub.id === activeHubId;
      const plan = hub.walkPlan || RouteOptimizer.buildHubWalkPlan(hub, state.packageSpecs, state.results);
      const hubIcon = L.divIcon({
        className: "custom-stop-marker-wrap",
        html: `<div class="map-hub-pin ${isActiveHub ? "active-hub" : ""}">P${hub.id}</div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
        popupAnchor: [0, -16]
      });
      const firstStopIdx = hub.stops && hub.stops[0]
        ? stops.findIndex((s) => s.id === hub.stops[0].id)
        : 0;
      const hubPkgCount = (hub.stops || []).reduce((acc, s) => acc + (s.items ? s.items.length : 0), 0);
      const hubPopupHtml = `
        <div class="map-stop-popup map-popup-compact">
          <div class="map-stop-badge" style="color:#0284c7;">🅿️ PONTO #${hub.id}</div>
          <div class="map-stop-title">${hub.title}</div>
          <div class="map-stop-desc">${hubPkgCount} ${hubPkgCount === 1 ? "pacote" : "pacotes"} (${hub.stops.length} ${hub.stops.length === 1 ? "endereço" : "endereços"})</div>
          ${firstStopIdx >= 0 ? `<button type="button" class="btn btn-primary btn-xs" style="margin-top:5px; width:100%; font-size:0.7rem; padding:3px 8px;" onclick="app.openStopDetails(${firstStopIdx})">Detalhes do Ponto</button>` : ""}
        </div>
      `;
      const hMarker = L.marker([hub.lat, hub.lon], {
        icon: hubIcon,
        zIndexOffset: isActiveHub ? 1100 : 500
      })
        .addTo(state.map)
        .bindPopup(hubPopupHtml);
      state.markers.allHubs.push(hMarker);
    });

    let currentMarker = null;

    // Plota TODAS as paradas da rota no mapa
    stops.forEach((stop, idx) => {
      const isCurrent = idx === state.activeStopIdx;
      const isDelivered = stop.items.every(
        (it) => state.results[it.tn] && state.results[it.tn].status === "delivered"
      );
      const isFailed = stop.items.every(
        (it) => state.results[it.tn] && state.results[it.tn].status === "failed"
      );

      let pinClass = stop.isWalkStop ? "route-pin-walk" : "route-pin-pending";
      let statusBadge = stop.isWalkStop ? `🚶 PARADA #${stop.id} (A PÉ)` : `PARADA #${stop.id}`;
      let badgeStyle = stop.isWalkStop ? "color:#0d9488;" : "color:#64748b;";

      if (isCurrent) {
        pinClass = "route-pin-current";
        statusBadge = stop.isWalkStop ? "🚶 📍 PARADA ATUAL (A PÉ)" : "📍 PARADA ATUAL";
        badgeStyle = "color:#ee4d2d;";
      } else if (isDelivered) {
        pinClass = "route-pin-delivered";
        statusBadge = "✓ ENTREGUE";
        badgeStyle = "color:#10b981;";
      } else if (isFailed) {
        pinClass = "route-pin-failed";
        statusBadge = "✕ NÃO ENTREGUE";
        badgeStyle = "color:#ef4444;";
      }

      const iconHtml = isCurrent
        ? `<div class="map-stop-pin ${pinClass}"><div class="map-pin-pulse"></div><span class="map-pin-num">${stop.id}</span></div>`
        : `<div class="map-stop-pin ${pinClass}"><span class="map-pin-num">${stop.id}</span></div>`;

      const customIcon = L.divIcon({
        className: "custom-stop-marker-wrap",
        html: iconHtml,
        iconSize: isCurrent ? [34, 34] : [28, 28],
        iconAnchor: isCurrent ? [17, 17] : [14, 14],
        popupAnchor: [0, isCurrent ? -18 : -14]
      });

      const popupHtml = `
        <div class="map-stop-popup map-popup-compact">
          <div class="map-stop-badge" style="${badgeStyle}">${statusBadge}</div>
          <div class="map-stop-title">${stop.title}</div>
          <div class="map-stop-desc">${stop.items.length} ${stop.items.length === 1 ? "pacote" : "pacotes"}</div>
          <button type="button" class="btn btn-primary btn-xs" style="margin-top:5px; width:100%; font-size:0.7rem; padding:3px 8px;" onclick="app.openStopDetails(${idx})">Detalhes do Ponto</button>
        </div>
      `;

      const marker = L.marker([stop.lat, stop.lon], {
        icon: customIcon,
        zIndexOffset: isCurrent ? 1000 : 100
      })
        .addTo(state.map)
        .bindPopup(popupHtml);

      state.markers.allStops.push(marker);

      if (isCurrent) {
        currentMarker = marker;
      }
    });

    // Centraliza na parada atual quando recenter === true e followGps estiver desligado (sem abrir balão automaticamente para não obstruir o mapa)
    const currentStop = stops[state.activeStopIdx];
    if (recenter && currentStop && !state.followGps) {
      state.map.setView([currentStop.lat, currentStop.lon], 16);
    }

    if (state.userCoords && state.userCoords.latitude && state.userCoords.longitude) {
      updateGpsMapMarker(state.userCoords.latitude, state.userCoords.longitude);
    } else if (state.route.originLocation && state.route.originLocation.lat && state.route.originLocation.lon) {
      updateGpsMapMarker(state.route.originLocation.lat, state.route.originLocation.lon);
    }

    updateMapNavHud();
    syncNavAppUI();
    prepareRouteSegments(pathLatlngs);
  }

  function prepareRouteSegments(latlngs) {
    mapAnim.segments = [];
    mapAnim.totalDistance = 0;
    if (latlngs.length < 2) return;

    for (let i = 0; i < latlngs.length - 1; i++) {
      const p1 = latlngs[i];
      const p2 = latlngs[i + 1];
      const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      mapAnim.segments.push({
        p1,
        p2,
        dist,
        startDist: mapAnim.totalDistance
      });
      mapAnim.totalDistance += dist;
    }
  }

  function startRouteAnimation() {
    stopRouteAnimation();
    if (!state.map || !state.route || state.route.stops.length < 2 || mapAnim.totalDistance <= 0) return;

    const hasRoadGeo = Array.isArray(state.route.routeGeometry) && state.route.routeGeometry.length > 1;
    const latlngs = hasRoadGeo ? state.route.routeGeometry : state.route.stops.map((s) => [s.lat, s.lon]);

    if (state.markers.animatedVehicle) {
      state.map.removeLayer(state.markers.animatedVehicle);
    }

    const routeLightIcon = L.divIcon({
      className: "map-vehicle-icon-wrap",
      html: `<div class="map-route-light"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });

    state.markers.animatedVehicle = L.marker([latlngs[0][0], latlngs[0][1]], {
      icon: routeLightIcon,
      interactive: false,
      zIndexOffset: 1200
    }).addTo(state.map);

    mapAnim.startTime = performance.now();

    function step(now) {
      if (!state.map || !state.markers.animatedVehicle) return;

      const elapsed = (now - mapAnim.startTime) % mapAnim.durationMs;
      const progress = elapsed / mapAnim.durationMs;
      const targetDist = progress * mapAnim.totalDistance;

      let curLat = latlngs[0][0];
      let curLon = latlngs[0][1];

      for (let i = 0; i < mapAnim.segments.length; i++) {
        const seg = mapAnim.segments[i];
        if (targetDist >= seg.startDist && targetDist <= seg.startDist + seg.dist) {
          const frac = seg.dist > 0 ? (targetDist - seg.startDist) / seg.dist : 0;
          curLat = seg.p1[0] + frac * (seg.p2[0] - seg.p1[0]);
          curLon = seg.p1[1] + frac * (seg.p2[1] - seg.p1[1]);
          break;
        }
      }

      state.markers.animatedVehicle.setLatLng([curLat, curLon]);
      mapAnim.frameId = requestAnimationFrame(step);
    }

    mapAnim.frameId = requestAnimationFrame(step);
  }

  function stopRouteAnimation() {
    if (mapAnim.frameId) {
      cancelAnimationFrame(mapAnim.frameId);
      mapAnim.frameId = null;
    }
  }

  function centerMapOnCurrent() {
    if (!state.map || !state.route) return;
    const stop = state.route.stops[state.activeStopIdx];
    if (stop) {
      state.map.setView([stop.lat, stop.lon], 17);
      const marker = state.markers.allStops[state.activeStopIdx];
      if (marker) marker.openPopup();
    }
  }

  function fitAllStopsMap() {
    if (!state.map || !state.markers.routeLine) return;
    state.map.fitBounds(state.markers.routeLine.getBounds(), { padding: [32, 32] });
  }

  // --- GPS & GEOFENCING ---
  function initGPS() {
    const textEl = document.getElementById("gpsDistanceText");
    if (!("geolocation" in navigator)) {
      if (textEl) textEl.textContent = "Geolocalização não suportada";
      return;
    }

    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);

    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const isFirstFix = !state.userCoords;
        state.userCoords = pos.coords;
        updateDistanceUI(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);

        // Ensure route starts at user's current location and 1st Ponto de Parada is the closest to user
        if ((isFirstFix || !state.hadInitialGpsRouteOrder) && state.route && !state.finished && !recalculateInFlight) {
          state.hadInitialGpsRouteOrder = true;
          recalculateAllRoutes();
        }
      },
      () => {
        if (textEl) textEl.textContent = "GPS indisponível. Use o botão Cheguei.";
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  function updateDistanceUI(lat, lon) {
    if (state.map) {
      updateGpsMapMarker(lat, lon);
      if (state.route && !state.finished) updateMapNavHud();
    }
    if (!state.route || !state.started || state.finished) return;
    const stop = state.route.stops[state.activeStopIdx];
    if (!stop) return;

    const distStop = RouteOptimizer.haversineMeters(lat, lon, stop.lat, stop.lon);
    const hub = getStopHub(stop);
    const distHub = hub ? RouteOptimizer.haversineMeters(lat, lon, hub.lat, hub.lon) : distStop;
    const dist = Math.round(Math.min(distStop, distHub));
    const pill = document.getElementById("gpsDistancePill");
    const textEl = document.getElementById("gpsDistanceText");

    // Proximidade <= 65m da parada ou do ponto de parada aciona automaticamente a chegada
    if (dist <= 65) {
      if (pill) pill.classList.add("gps-near");
      if (textEl) textEl.textContent = hub
        ? `📍 Você chegou ao Ponto #${hub.id}! (${dist}m)`
        : `📍 Você chegou! (${dist}m)`;
      if (!state.arrivedCurrent && state.autoArrivedStopId !== stop.id) {
        state.autoArrivedStopId = stop.id;
        markArrived(true);
      } else if (state.arrivedCurrent) {
        checkNearbyWalkDelivery();
      }
      return;
    }

    // Se já está em atendimento no local atual, verifica entregas próximas a pé antes de qualquer troca automática
    if (state.arrivedCurrent) {
      checkNearbyWalkDelivery();
    } else {
      // Identificação de chegada em outra parada da rota (caso o entregador chegue diretamente nela)
      for (let i = 0; i < state.route.stops.length; i++) {
        if (i === state.activeStopIdx) continue;
        const otherStop = state.route.stops[i];
        const hasPending = otherStop.items.some(
          (it) => !state.results[it.tn] || state.results[it.tn].status === "pending"
        );
        if (!hasPending) continue;

        const otherDist = Math.round(RouteOptimizer.haversineMeters(lat, lon, otherStop.lat, otherStop.lon));
        if (otherDist <= 45) {
          state.activeStopIdx = i;
          state.autoArrivedStopId = otherStop.id;
          if (pill) pill.classList.add("gps-near");
          if (textEl) textEl.textContent = `📍 Chegou na Parada #${otherStop.id}! (${otherDist}m)`;
          markArrived(true);
          return;
        }
      }
    }

    if (pill) pill.classList.remove("gps-near");
    const distStr = dist >= 1000 ? `${(dist / 1000).toFixed(2)} km` : `${dist} m`;
    if (textEl) textEl.textContent = `Distância até parada #${stop.id}: ${distStr}`;
  }

  // --- DYNAMIC WALKING SHORTCUT DELIVERY ---
  function getWalkOriginCoords(currentStop) {
    if (state.userCoords && state.userCoords.latitude && state.userCoords.longitude) {
      if (currentStop && currentStop.lat && currentStop.lon) {
        const d = RouteOptimizer.haversineMeters(
          state.userCoords.latitude,
          state.userCoords.longitude,
          currentStop.lat,
          currentStop.lon
        );
        if (d <= 300) {
          return { lat: state.userCoords.latitude, lon: state.userCoords.longitude };
        }
      } else {
        return { lat: state.userCoords.latitude, lon: state.userCoords.longitude };
      }
    }
    if (currentStop && currentStop.lat && currentStop.lon) {
      return { lat: currentStop.lat, lon: currentStop.lon };
    }
    return null;
  }

  async function checkNearbyWalkDelivery() {
    if (walkCheckInFlight) return;
    if (!state.route || !state.started || state.finished) return;
    if (!state.maxWalkDistanceMeters || state.maxWalkDistanceMeters <= 0) return;

    const modal = document.getElementById("modalWalkDelivery");
    if (modal && !modal.classList.contains("hidden")) return;

    const currentStop = state.route.stops[state.activeStopIdx];
    if (!currentStop) return;

    // Só sugere atalho a pé quando o entregador já está em uma entrega (chegou no local X ou GPS <= 65m)
    let isAtDeliveryLocation = state.arrivedCurrent;
    if (!isAtDeliveryLocation && state.userCoords && currentStop.lat && currentStop.lon) {
      const distToCurrent = RouteOptimizer.haversineMeters(
        state.userCoords.latitude,
        state.userCoords.longitude,
        currentStop.lat,
        currentStop.lon
      );
      if (distToCurrent <= 65) isAtDeliveryLocation = true;
    }
    if (!isAtDeliveryLocation) return;

    const origin = getWalkOriginCoords(currentStop);
    if (!origin) return;

    walkCheckInFlight = true;
    try {
      const candidate = await RouteOptimizer.findNearbyWalkCandidateAsync(
        state.route.stops,
        state.activeStopIdx,
        origin,
        state.maxWalkDistanceMeters,
        state.results,
        state.dismissedWalkKeys
      );
      if (!candidate) return;
      if (!state.started || state.finished) return;
      state.pendingWalkCandidate = candidate;
      state.walkChecklistOpen = false;
      openWalkPromptModal(candidate);
    } finally {
      walkCheckInFlight = false;
    }
  }

  function openWalkPromptModal(candidate) {
    const { stop, distanceMeters } = candidate;
    const summaryBox = document.getElementById("walkCandidateSummary");
    const promptStep = document.getElementById("walkPromptStep");
    const checklistStep = document.getElementById("walkChecklistStep");

    if (promptStep) promptStep.classList.remove("hidden");
    if (checklistStep) checklistStep.classList.add("hidden");

    if (summaryBox) {
      const tns = stop.items.map((it) => it.tn).join(", ");
      const complements = stop.items
        .map((it) => (it.apartmentInfo && it.apartmentInfo.displayLabel) || it.complement)
        .filter((c) => c && c !== "Sem complemento")
        .join(" • ");

      summaryBox.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
          <span class="load-stop-badge">PARADA #${stop.id}</span>
          <span class="badge badge-success">🚶 ~${distanceMeters}m pelas vias</span>
        </div>
        <div style="font-weight:800; font-size:1rem;">${stop.title}</div>
        <div class="meta-text">${stop.bairro} • ${stop.items.length} ${stop.items.length > 1 ? "pacotes" : "pacote"}</div>
        ${complements ? `<div style="font-size:0.8rem;"><strong>Detalhe:</strong> ${complements}</div>` : ""}
        <div style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-muted);">Rastreio: ${tns}</div>
      `;
    }

    playSuccessChime();
    openModal("modalWalkDelivery");
  }

  function acceptWalkDelivery() {
    if (!state.pendingWalkCandidate) return;
    state.walkChecklistOpen = true;

    const { stop, distanceMeters } = state.pendingWalkCandidate;
    const promptStep = document.getElementById("walkPromptStep");
    const checklistStep = document.getElementById("walkChecklistStep");
    const header = document.getElementById("walkChecklistHeader");
    const container = document.getElementById("walkPackageItemsContainer");

    if (promptStep) promptStep.classList.add("hidden");
    if (checklistStep) checklistStep.classList.remove("hidden");
    if (header) {
      header.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
          <div>
            <div class="kicker">Entrega a Pé • ~${distanceMeters}m</div>
            <div style="font-weight:800; font-size:1rem;">#${stop.id} ${stop.title}</div>
          </div>
          <span class="badge badge-primary">${stop.items.length} ${stop.items.length > 1 ? "pacotes" : "pacote"}</span>
        </div>
      `;
    }
    if (container) {
      container.innerHTML = buildPackageChecklistHtml(stop);
    }
  }

  function declineWalkDelivery() {
    if (state.pendingWalkCandidate && state.pendingWalkCandidate.pairKey) {
      state.dismissedWalkKeys[state.pendingWalkCandidate.pairKey] = true;
    }
    state.pendingWalkCandidate = null;
    state.walkChecklistOpen = false;
    closeModal("modalWalkDelivery");
  }

  function cancelWalkDelivery() {
    state.walkChecklistOpen = false;
    declineWalkDelivery();
  }

  function confirmWalkDelivery() {
    if (!state.pendingWalkCandidate || !state.route) return;
    const { stopIndex } = state.pendingWalkCandidate;

    const currentStop = state.route.stops[state.activeStopIdx];
    const originPos = getWalkOriginCoords(currentStop);
    const recalc = RouteOptimizer.recalculateRouteAfterWalk(
      state.route.stops,
      state.activeStopIdx,
      stopIndex,
      originPos
    );

    if (!recalc) return;

    state.walkedStops.push(recalc.walkedStop);
    const walkedPackageCount = state.walkedStops.reduce((sum, s) => sum + (s.items ? s.items.length : 0), 0);

    state.route.stops = recalc.stops;
    state.route.walkSegments = recalc.walkSegments || [];
    state.route.streetsCount = recalc.metrics.streetsCount;
    state.route.totalDistinctAddresses = recalc.metrics.totalDistinctAddresses;
    state.route.serviceMinutes = recalc.metrics.serviceMinutes;
    state.route.transitMinutes = recalc.metrics.transitMinutes;
    state.route.totalDistanceKm = recalc.metrics.totalDistanceKm;
    state.route.estimatedMinutes = recalc.metrics.estimatedMinutes;
    state.route.estimatedDurationStr = recalc.metrics.estimatedDurationStr;
    state.route.totalPackages = recalc.metrics.totalPackages + walkedPackageCount;
    state.activeStopIdx = recalc.newActiveIdx;

    RouteOptimizer.fetchRoadDataForStops(state.route.stops).then((roadData) => {
      if (!roadData || !state.route) return;
      state.route.routeGeometry = roadData.routeGeometry;
      state.route.maneuvers = roadData.maneuvers;
      state.route.usedRoadRouting = true;
      saveState();
      if (state.map) updateMapMarkers();
    }).catch(() => { });

    state.pendingWalkCandidate = null;
    state.walkChecklistOpen = false;
    closeModal("modalWalkDelivery");
    saveState();

    playSuccessChime();
    updateHeader();
    showToast(`🚶 Entrega #${recalc.walkedStop.originalId || recalc.walkedStop.id} adiantada a pé! Rota recalculada.`);

    if (state.route.stops.length === 0) {
      showToast("Todas as paradas foram visitadas. Use 'Encerrar Rota' quando desejar finalizar.");
      return;
    }

    renderCurrentStopView();
    renderMapBottomSheet();
    renderLoadingOrderList();
    if (state.activeTab === "all") renderFullStopsList();
    if (state.map) updateMapMarkers();

    checkNearbyWalkDelivery();
  }

  // --- REPORT SCREEN ---
  function renderReportScreen() {
    const summary = getRouteSummary();

    document.getElementById("repDeliveredCount").textContent = summary.deliveredCount;
    document.getElementById("repFailedCount").textContent = summary.failedCount;
    document.getElementById("repSuccessRate").textContent = `${summary.successRate}%`;
    document.getElementById("reportTimestamp").textContent = `Início: ${summary.startTime} • Conclusão: ${summary.endTime}`;

    const failedBox = document.getElementById("reportFailedListBox");
    const failedItems = summary.details.filter((d) => d.status === "failed");

    if (failedItems.length === 0) {
      failedBox.innerHTML = `
        <div style="color:var(--success-text); padding:8px 0; font-weight:700;">
          ${renderIcon("checkCircle", 18)} Todos os ${summary.totalPackages} pacotes foram entregues com sucesso!
        </div>
      `;
    } else {
      failedBox.innerHTML = failedItems
        .map(
          (f) => `
        <div class="package-item" style="border-color:var(--danger); margin-bottom:6px;">
          <div style="font-weight:700;">${f.tn}</div>
          <div class="meta-text">${f.address}</div>
          <div style="color:var(--danger-text); font-size:0.8rem; font-weight:700;">Motivo: ${f.reason || "Não informado"}</div>
        </div>
      `
        )
        .join("");
    }

    const tbody = document.getElementById("reportTableBody");
    tbody.innerHTML = summary.details
      .map(
        (d, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td><code>${d.tn}</code></td>
        <td>${d.address}</td>
        <td style="color:${d.status === "delivered" ? "var(--success-text)" : "var(--danger-text)"}; font-weight:700;">
          ${d.status === "delivered" ? "Entregue" : "Não entregue"}
          ${d.reason ? `<br><small style="color:var(--text-muted);">${d.reason}</small>` : ""}
        </td>
      </tr>
    `
      )
      .join("");
  }

  function exportCSV() {
    const summary = getRouteSummary();
    const lines = [["Ordem", "Parada", "SPX_TN", "Endereco", "Status", "Motivo", "Horario"].join(";")];

    summary.details.forEach((d, idx) => {
      const statusLabel = d.status === "delivered" ? "Entregue" : "Nao Entregue";
      const cleanReason = (d.reason || "").replace(/;/g, ",");
      lines.push([idx + 1, d.stopId, d.tn, `"${d.address}"`, statusLabel, `"${cleanReason}"`, d.time].join(";"));
    });

    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `relatorio-spx-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Relatório CSV baixado!");
  }

  function copyRouteSummary() {
    const summary = getRouteSummary();
    const fails = summary.details
      .filter((d) => d.status === "failed")
      .map((d) => `• ${d.tn} (${d.address}): ${d.reason || "Não visitado"}`);

    const estTime = state.route && state.route.estimatedDurationStr
      ? `⏱️ Tempo Estimado: ${state.route.estimatedDurationStr} (${state.route.totalDistinctAddresses || state.route.stops.length} endereços a 3 min/end)`
      : "";

    const text = [
      `📦 *ORGANIZA ENTREGAS — RELATÓRIO DO DIA*`,
      `📅 Data: ${new Date().toLocaleDateString("pt-BR")}`,
      estTime,
      `✅ Pacotes Entregues: ${summary.deliveredCount} / ${summary.totalPackages} (${summary.successRate}%)`,
      `❌ Não Entregues: ${summary.failedCount}`,
      fails.length > 0 ? `\n*Pendências:*\n${fails.join("\n")}` : `\n🎉 100% de sucesso!`
    ].filter(Boolean).join("\n");

    navigator.clipboard.writeText(text).then(() => {
      showToast("Resumo da rota copiado!");
    }).catch(() => {
      showToast("Não foi possível copiar.");
    });
  }

  function resetRoute() {
    localStorage.removeItem(getStorageKey());
    if (typeof PhotoStorage !== "undefined") {
      PhotoStorage.clearAllPhotos();
    }
    state.photos = {};
    state.loadedPackages = {};
    state.packageLocations = {};
    state.walkedStops = [];
    state.dismissedWalkKeys = {};
    state.pendingWalkCandidate = null;
    state.walkChecklistOpen = false;
    state.started = false;
    state.finished = false;
    state.activeStopIdx = 0;
    state.arrivedCurrent = false;
    state.startTime = null;
    state.endTime = null;
    state.results = {};
    state.route = null;
    switchScreen("home");
    showToast("Rota reiniciada.");
  }

  // --- MODALS & FIREBASE DIALOGS ---
  function openModal(modalId) {
    document.getElementById(modalId).classList.remove("hidden");
    closeDropdown();
  }

  function closeModal(modalId) {
    document.getElementById(modalId).classList.add("hidden");
  }

  function closeDropdown() {
    const menu = document.getElementById("accountDropdownMenu");
    const btn = document.getElementById("btnAccountMenu");
    if (menu) menu.classList.add("hidden");
    if (btn) btn.classList.remove("active");
  }

  async function openHistoryModal() {
    const list = document.getElementById("historyListContainer");
    list.innerHTML = `<div style="text-align:center; padding:16px;">Carregando histórico...</div>`;
    openModal("modalHistory");

    const history = await FirebaseService.fetchRoutesHistory();
    if (!history || history.length === 0) {
      list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted);">Nenhuma rota concluída salva ainda.</div>`;
      return;
    }

    list.innerHTML = history
      .map(
        (h) => `
      <div class="card" style="padding:12px; margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong>${h.dateLabel} • ${h.region || "Zona 07"}</strong>
            <div class="meta-text">${h.startTime} às ${h.endTime}</div>
          </div>
          <span class="badge ${h.successRate >= 95 ? "badge-success" : "badge-warning"}">
            ${h.deliveredCount}/${h.totalPackages} (${h.successRate}%)
          </span>
        </div>
      </div>
    `
      )
      .join("");
  }

  function openMultiBatchModal() {
    if (!state.route || state.route.stops.length === 0) return;
    const container = document.getElementById("multiBatchList");
    const points = getCarRoutingPoints();
    const usingHubs = !!(state.route.hubs && state.route.hubs.length > 0);
    const pointNoun = usingHubs ? "Pontos de Parada" : "Paradas";
    const fullRouteUrl = RouteOptimizer.buildGoogleMapsRouteUrl(points);
    const batchSize = 10;
    const batches = [];

    // Continuous overlapping legs: leg 0: 0..9 (points 1..10), leg 1: 9..18 (points 10..19), etc.
    for (let i = 0; i < points.length; i += (batchSize - 1)) {
      const slice = points.slice(i, i + batchSize);
      if (slice.length <= 1 && batches.length > 0) break;
      const startId = slice[0].id;
      const endId = slice[slice.length - 1].id;
      const url = RouteOptimizer.buildGoogleMapsRouteUrl(points, i, batchSize);
      batches.push({ startId, endId, count: slice.length, url });
      if (i + batchSize >= points.length) break;
    }

    container.innerHTML = `
      <div style="background:var(--bg-subtle); border:1px solid var(--border); border-radius:var(--radius); padding:12px; margin-bottom:10px;">
        <div style="font-weight:800; font-size:0.95rem; margin-bottom:4px; display:flex; align-items:center; gap:6px;">
          ${renderIcon("mapPin", 16, "icon-primary")} Rota Completa Única (${points.length} ${pointNoun})
        </div>
        <p class="meta-text" style="margin-bottom:10px; font-size:0.8rem;">
          Gera um único link com todos os pontos de parada configurados para navegação direta no Google Maps e Android Auto.
        </p>
        <a href="${fullRouteUrl}" target="_blank" rel="noopener" class="btn btn-maps" style="text-align:center;">
          ${renderIcon("externalLink", 16)} Abrir Todos os ${points.length} ${pointNoun} no Maps
        </a>
      </div>

      <div style="font-size:0.75rem; font-weight:800; color:var(--text-muted); text-transform:uppercase; margin:8px 0 6px 0;">
        Trechos Contínuos (10 pontos - recomendado para navegação no carro):
      </div>

      <div style="display:flex; flex-direction:column; gap:8px;">
        ${batches
        .map(
          (b) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);">
            <div>
              <div style="font-weight:700; font-size:0.88rem;">Trecho #${b.startId} até #${b.endId}</div>
              <div class="meta-text" style="font-size:0.78rem;">${b.count} ${pointNoun.toLowerCase()} sequenciais</div>
            </div>
            <a href="${b.url}" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="width:auto; padding:6px 12px;">
              ${renderIcon("navigation", 14)} Navegar
            </a>
          </div>
        `
        )
        .join("")}
      </div>
    `;

    openModal("modalMultiBatch");
  }

  function nextStop() {
    if (!state.route) return;
    if (state.activeStopIdx < state.route.stops.length - 1) {
      state.activeStopIdx += 1;
      state.arrivedCurrent = false;
      if (navigator.vibrate) navigator.vibrate(25);
      saveState();
      renderCurrentStopView();
      renderMapBottomSheet();
      if (state.map) updateMapMarkers(true);
      if (state.activeTab === "all") {
        renderFullStopsList();
        setTimeout(scrollActiveStopIntoView, 100);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      showToast("Última parada alcançada. Para finalizar, clique em Encerrar Rota.");
    }
  }

  function updateOnlineStatus() {
    const banner = document.getElementById("offlineBanner");
    if (!banner) return;
    if (navigator.onLine) {
      banner.classList.add("hidden");
    } else {
      banner.classList.remove("hidden");
    }
  }

  function initSwipeGestures() {
    const card = document.getElementById("currentStopSwipeCard");
    if (!card) return;

    let startX = 0;
    let startY = 0;
    let deltaX = 0;
    let isTracking = false;

    card.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        deltaX = 0;
        isTracking = true;
      },
      { passive: true }
    );

    card.addEventListener(
      "touchmove",
      (e) => {
        if (!isTracking || e.touches.length !== 1) return;
        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        deltaX = currentX - startX;
        const deltaY = currentY - startY;

        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 20) {
          if (deltaX < 0) {
            card.classList.add("swiping-left");
            card.classList.remove("swiping-right");
          } else {
            card.classList.add("swiping-right");
            card.classList.remove("swiping-left");
          }
        }
      },
      { passive: true }
    );

    const handleSwipeEnd = () => {
      if (!isTracking) return;
      isTracking = false;
      card.classList.remove("swiping-left", "swiping-right");

      if (deltaX < -60) {
        nextStop();
      } else if (deltaX > 60) {
        prevStop();
      }
    };

    card.addEventListener("touchend", handleSwipeEnd, { passive: true });
    card.addEventListener("touchcancel", handleSwipeEnd, { passive: true });
  }

  function initQuickSearch() {
    const input = document.getElementById("quickSearchInput");
    const clearBtn = document.getElementById("btnClearQuickSearch");
    const dropdown = document.getElementById("quickSearchResults");
    if (!input || !dropdown) return;

    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      if (!query || !state.route) {
        dropdown.classList.add("hidden");
        dropdown.innerHTML = "";
        if (clearBtn) clearBtn.classList.add("hidden");
        return;
      }
      if (clearBtn) clearBtn.classList.remove("hidden");

      const matches = [];
      state.route.stops.forEach((stop, stopIdx) => {
        const stopMatch =
          stop.title.toLowerCase().includes(query) ||
          (stop.bairro && stop.bairro.toLowerCase().includes(query));
        stop.items.forEach((item) => {
          const tnMatch = item.tn.toLowerCase().includes(query);
          const complMatch = item.complement && item.complement.toLowerCase().includes(query);
          if (stopMatch || tnMatch || complMatch) {
            matches.push({ stop, stopIdx, item });
          }
        });
      });

      if (matches.length === 0) {
        dropdown.innerHTML = `<div style="padding:12px; font-size:0.82rem; color:var(--text-muted); text-align:center;">Nenhum pacote encontrado para "${query}"</div>`;
        dropdown.classList.remove("hidden");
        return;
      }

      dropdown.innerHTML = matches
        .slice(0, 15)
        .map((m) => {
          const res = state.results[m.item.tn];
          const isDone = res && res.status === "delivered";
          return `
          <div class="quick-search-item" onclick="app.jumpFromSearch(${m.stopIdx})">
            <div>
              <div style="font-weight:700; font-size:0.85rem;">Parada #${m.stop.id} • ${m.stop.title}</div>
              <div class="meta-text" style="font-size:0.75rem;">${m.item.tn} • ${m.item.complement}</div>
            </div>
            <span class="badge ${isDone ? "badge-success" : "badge-warning"}" style="font-size:0.72rem;">
              ${isDone ? "Entregue" : "Pendente"}
            </span>
          </div>
        `;
        })
        .join("");
      dropdown.classList.remove("hidden");
    });

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        input.value = "";
        dropdown.classList.add("hidden");
        dropdown.innerHTML = "";
        clearBtn.classList.add("hidden");
        input.focus();
      });
    }

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#quickSearchBox")) {
        dropdown.classList.add("hidden");
      }
    });
  }

  function jumpFromSearch(stopIdx) {
    jumpToStop(stopIdx);
    const dropdown = document.getElementById("quickSearchResults");
    const input = document.getElementById("quickSearchInput");
    const clearBtn = document.getElementById("btnClearQuickSearch");
    if (dropdown) dropdown.classList.add("hidden");
    if (input) input.value = "";
    if (clearBtn) clearBtn.classList.add("hidden");
  }

  function openAuthModal() {
    const user = FirebaseService.getUser();
    const loggedInView = document.getElementById("authLoggedInView");
    const loginForm = document.getElementById("authLoginForm");
    const userEmailEl = document.getElementById("loggedUserEmail");

    if (user && !user.isLocal) {
      if (loggedInView) loggedInView.classList.remove("hidden");
      if (loginForm) loginForm.classList.add("hidden");
      if (userEmailEl) userEmailEl.textContent = user.email || user.displayName || "Usuário";
    } else {
      if (loggedInView) loggedInView.classList.add("hidden");
      if (loginForm) loginForm.classList.remove("hidden");
    }
    openModal("modalAuth");
  }

  function toggleAccountMenu(e) {
    if (e) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
    }
    const dropdownMenu = document.getElementById("accountDropdownMenu");
    const btnAccountMenu = document.getElementById("btnAccountMenu");
    if (!dropdownMenu) return;

    const isHidden = dropdownMenu.classList.contains("hidden");
    if (isHidden) {
      dropdownMenu.classList.remove("hidden");
      if (btnAccountMenu) btnAccountMenu.classList.add("active");
    } else {
      dropdownMenu.classList.add("hidden");
      if (btnAccountMenu) btnAccountMenu.classList.remove("active");
    }
  }

  function logout() {
    closeDropdown();
    FirebaseService.logout().then(() => {
      showToast("Você saiu da conta.");
      resetRoute();
    });
  }

  // --- BOOTSTRAP ---
  function init() {
    initTheme();
    initWakeLock();
    updateTurnHudUI();
    initSwipeGestures();
    initQuickSearch();

    // PWA Service Worker & Update Detection + Online detection
    initServiceWorkerUpdates();
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    updateOnlineStatus();

    // Firebase Auth sync & User Data Isolation
    FirebaseService.onAuthChange((user) => {
      const menuLogin = document.getElementById("menuItemLogin");
      const avatarText = document.getElementById("userAvatarText");
      const menuName = document.getElementById("menuUserName");
      const menuEmail = document.getElementById("menuUserEmail");
      const authSection = document.getElementById("menuAuthActionSection");

      if (user && !user.isLocal) {
        // User is logged in: HIDE login item in menu, show avatar initial & profile info
        if (menuLogin) menuLogin.classList.add("hidden");
        const initial = (user.displayName || user.email || "U").charAt(0).toUpperCase();
        if (avatarText) avatarText.textContent = initial;
        if (menuName) menuName.textContent = user.displayName || user.email.split("@")[0];
        if (menuEmail) menuEmail.textContent = user.email;
        if (authSection) authSection.classList.remove("hidden");
      } else {
        // User is guest: SHOW login item in menu, show default guest menu
        if (menuLogin) menuLogin.classList.remove("hidden");
        if (avatarText) avatarText.textContent = "?";
        if (menuName) menuName.textContent = "Visitante";
        if (menuEmail) menuEmail.textContent = "Não conectado";
        if (authSection) authSection.classList.add("hidden");
      }

      // Reload state specifically for this user
      loadState();
      initGPS();
      if (state.finished) {
        switchScreen("report");
      } else {
        switchScreen("active");
        switchTab(state.activeTab || "map");
      }

      // Auto-recalculate if stored route uses an older schema or mismatched walk distance
      if (
        state.route &&
        !state.finished &&
        state.route.stops &&
        state.route.stops.length > 0 &&
        (state.route.schemaVersion !== 3 ||
          state.route.walkRadiusUsed !== state.maxWalkDistanceMeters ||
          !Array.isArray(state.route.hubs) ||
          state.route.stops.some((s) => s.isWalkStop && (s.walkDistanceMeters || 0) > state.maxWalkDistanceMeters))
      ) {
        setTimeout(() => {
          recalculateAllRoutes();
        }, 150);
      }
    });

    FirebaseService.initFirebase();

    // Account Dropdown Menu Toggle
    const btnAccountMenu = document.getElementById("btnAccountMenu");
    const dropdownMenu = document.getElementById("accountDropdownMenu");

    if (btnAccountMenu) {
      btnAccountMenu.addEventListener("click", (e) => {
        toggleAccountMenu(e);
      });
    }

    if (dropdownMenu) {
      dropdownMenu.addEventListener("click", (e) => {
        e.stopPropagation();
      });
    }

    document.addEventListener("click", (e) => {
      if (dropdownMenu && !dropdownMenu.classList.contains("hidden")) {
        if (!dropdownMenu.contains(e.target) && btnAccountMenu && !btnAccountMenu.contains(e.target)) {
          closeDropdown();
        }
      }
    });

    updateInstallUiState();

    // Menu Actions
    const menuLogin = document.getElementById("menuItemLogin");
    if (menuLogin) {
      menuLogin.addEventListener("click", () => {
        closeDropdown();
        openAuthModal();
      });
    }

    const menuInstall = document.getElementById("menuItemInstallApp");
    if (menuInstall) menuInstall.addEventListener("click", installPwa);

    const menuHist = document.getElementById("menuItemHistory");
    if (menuHist) menuHist.addEventListener("click", openHistoryModal);

    const menuTheme = document.getElementById("menuItemTheme");
    if (menuTheme) menuTheme.addEventListener("click", toggleTheme);

    const menuLogout = document.getElementById("menuItemLogout");
    if (menuLogout) menuLogout.addEventListener("click", logout);

    // File Upload (XLSX, XLS, CSV)
    const fileInput = document.getElementById("spreadsheetFileInput");
    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files.length > 0) {
          handleFileSelect(e.target.files[0]);
        }
      });
    }

    // Dropzone Drag/Drop (Desktop drag support; click handled natively by label)
    const dropzone = document.getElementById("uploadDropzone");
    if (dropzone) {
      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("drag-over");
      });
      dropzone.addEventListener("dragleave", () => {
        dropzone.classList.remove("drag-over");
      });
      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("drag-over");
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleFileSelect(e.dataTransfer.files[0]);
        }
      });
    }

    // Paste CSV Text
    const btnParse = document.getElementById("btnParsePastedCSV");
    if (btnParse) {
      btnParse.addEventListener("click", () => {
        const txt = document.getElementById("csvPasteArea").value;
        if (txt.trim()) handleGenerateRouteFromCSV(txt);
      });
    }

    // Route Actions
    const btnStart = document.getElementById("btnStartRoute");
    if (btnStart) btnStart.addEventListener("click", startActiveRoute);

    const btnArrive = document.getElementById("btnMarkArrived");
    if (btnArrive) btnArrive.addEventListener("click", markArrived);

    const btnConfirm = document.getElementById("btnConfirmStopAndNext");
    if (btnConfirm) btnConfirm.addEventListener("click", confirmStopAndNext);

    const btnPrev = document.getElementById("btnPrevStop");
    if (btnPrev) btnPrev.addEventListener("click", prevStop);

    const btnFinish = document.getElementById("btnFinishEarly");
    if (btnFinish) {
      btnFinish.addEventListener("click", openFinishRouteModal);
    }

    // Tabs
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // Scanner
    const btnScanStart = document.getElementById("scannerStartBtn");
    if (btnScanStart) btnScanStart.addEventListener("click", startScanner);

    const btnScanStop = document.getElementById("scannerStopBtn");
    if (btnScanStop) btnScanStop.addEventListener("click", stopScanner);

    const scanInput = document.getElementById("scannerSearchInput");
    if (scanInput) {
      scanInput.addEventListener("input", (e) => {
        handleManualSearch(e.target.value);
        renderLoadingOrderList();
      });
    }

    const loadingSearch = document.getElementById("loadingSearchInput");
    if (loadingSearch) {
      loadingSearch.addEventListener("input", () => {
        renderLoadingOrderList();
      });
      loadingSearch.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && loadingSearch.value.trim()) {
          e.preventDefault();
          triggerManualScanFromInput();
        }
      });
    }

    const maxWalkInput = document.getElementById("maxWalkDistanceInput");
    if (maxWalkInput) {
      maxWalkInput.addEventListener("input", (e) => {
        setMaxWalkDistance(e.target.value);
      });
    }

    const walkPresetPills = document.getElementById("walkPresetPills");
    if (walkPresetPills) {
      walkPresetPills.addEventListener("click", (e) => {
        const pill = e.target.closest("[data-walk-meters]");
        if (!pill) return;
        setMaxWalkDistance(pill.dataset.walkMeters);
      });
    }

    const navAppPills = document.getElementById("navAppPills");
    if (navAppPills) {
      navAppPills.addEventListener("click", (e) => {
        const pill = e.target.closest("[data-nav-app]");
        if (!pill) return;
        setNavApp(pill.dataset.navApp);
      });
    }

    syncNavAppUI();

    // Input de captura de foto do pacote
    const photoFileInput = document.getElementById("packagePhotoFileInput");
    if (photoFileInput) {
      photoFileInput.addEventListener("change", handlePhotoFileSelected);
    }

    // Report
    const btnExport = document.getElementById("btnExportCSV");
    if (btnExport) btnExport.addEventListener("click", exportCSV);

    const btnCopySum = document.getElementById("btnCopySummary");
    if (btnCopySum) btnCopySum.addEventListener("click", copyRouteSummary);

    const btnReset = document.getElementById("btnResetRoute");
    if (btnReset) btnReset.addEventListener("click", resetRoute);

    const btnCenter = document.getElementById("btnCenterMap");
    if (btnCenter) btnCenter.addEventListener("click", centerMapOnCurrent);

    const btnFitAll = document.getElementById("btnFitAllMap");
    if (btnFitAll) btnFitAll.addEventListener("click", fitAllStopsMap);

    const btnMultiModal = document.getElementById("btnOpenMultiBatchModal");
    if (btnMultiModal) btnMultiModal.addEventListener("click", openMultiBatchModal);
  }

  // --- PWA INSTALLATION PROMPT & SMART MOBILE GUIDE ---
  let deferredInstallPrompt = null;

  function isIos() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
  }

  function updateInstallUiState() {
    const isApp = isStandalone();
    const btn = document.getElementById("btnInstallPwa");
    const banner = document.getElementById("pwaHomeInstallBanner");
    const menuInstall = document.getElementById("menuItemInstallApp");

    if (isApp) {
      if (btn) btn.classList.add("hidden");
      if (banner) banner.classList.add("hidden");
      if (menuInstall) menuInstall.classList.add("hidden");
    } else {
      if (btn) btn.classList.remove("hidden");
      if (banner) banner.classList.remove("hidden");
      if (menuInstall) menuInstall.classList.remove("hidden");
    }
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updateInstallUiState();
  });

  window.addEventListener("appinstalled", () => {
    showToast("Organiza Entregas instalado com sucesso!");
    deferredInstallPrompt = null;
    updateInstallUiState();
  });

  function installPwa() {
    closeDropdown();

    if (isStandalone()) {
      showToast("O aplicativo já está instalado no seu celular!");
      return;
    }

    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then((choice) => {
        if (choice.outcome === "accepted") {
          showToast("Instalação iniciada!");
        }
        deferredInstallPrompt = null;
        updateInstallUiState();
      });
      return;
    }

    // Se estiver no iOS / Safari ou o prompt automático não estiver ativo, exibe o modal com passos visuais
    const guideIos = document.getElementById("installGuideIos");
    const guideAndroid = document.getElementById("installGuideAndroid");

    if (isIos()) {
      if (guideIos) guideIos.classList.remove("hidden");
      if (guideAndroid) guideAndroid.classList.add("hidden");
    } else {
      if (guideIos) guideIos.classList.add("hidden");
      if (guideAndroid) guideAndroid.classList.remove("hidden");
    }

    openModal("modalInstallApp");
  }

  // --- PWA VERSION UPDATE DETECTION & USER-CONFIRMED AUTO-UPDATE ---
  function showUpdateAvailableBanner(waitingWorker) {
    if (!waitingWorker) return;
    swWaitingWorker = waitingWorker;
    const banner = document.getElementById("pwaUpdateBanner");
    const menuUpdate = document.getElementById("menuItemUpdateApp");
    if (banner) banner.classList.remove("hidden");
    if (menuUpdate) menuUpdate.classList.remove("hidden");
  }

  function dismissPwaUpdate() {
    const banner = document.getElementById("pwaUpdateBanner");
    if (banner) banner.classList.add("hidden");
    showToast("Você pode atualizar depois pelo menu da conta.");
  }

  function applyPwaUpdate() {
    if (!swWaitingWorker) {
      window.location.reload();
      return;
    }
    closeDropdown();
    saveState();

    const applyBtn = document.getElementById("btnApplyPwaUpdate");
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = "Atualizando...";
    }
    showToast("Atualizando para a nova versão...");

    swWaitingWorker.postMessage({ type: "SKIP_WAITING" });

    // Garante recarregamento mesmo se controllerchange atrasar em algum navegador mobile
    setTimeout(() => {
      if (!swRefreshing) {
        swRefreshing = true;
        window.location.reload();
      }
    }, 2500);
  }

  function monitorRegistrationUpdates(reg) {
    if (!reg) return;

    if (reg.waiting && navigator.serviceWorker.controller) {
      showUpdateAvailableBanner(reg.waiting);
    }

    reg.addEventListener("updatefound", () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdateAvailableBanner(newWorker);
        }
      });
    });
  }

  function initServiceWorkerUpdates() {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (swRefreshing) return;
      swRefreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then((reg) => {
        monitorRegistrationUpdates(reg);

        const checkUpdate = () => {
          if (navigator.onLine) {
            reg.update().catch(() => { });
          }
        };

        checkUpdate();
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") checkUpdate();
        });
        window.addEventListener("online", checkUpdate);
        setInterval(checkUpdate, 30 * 60 * 1000);
      })
      .catch(() => { });
  }

  // Expose global app methods
  window.app = {
    setItemStatus,
    setItemReason,
    jumpToStop,
    openStopDetails,
    openModal,
    closeModal,
    closeScanModal,
    showPackageModal,
    setLoadingFilter,
    toggleItemChecked,
    copyTrackingCode,
    togglePackageLocationEditor,
    savePackageLocation,
    setPackageLocationPreset,
    setMaxWalkDistance,
    setNavApp,
    toggleNavApp,
    promptAdjustWalkDistance,
    closeInlineWalkEditor,
    applyInlineWalkDistance,
    acceptWalkDelivery,
    declineWalkDelivery,
    cancelWalkDelivery,
    confirmWalkDelivery,
    applyPwaUpdate,
    dismissPwaUpdate,
    triggerPackagePhotoCapture,
    capturePhotoForTn,
    deleteCurrentPackagePhoto,
    viewPhotoLarge,
    openAuthModal,
    toggleAccountMenu,
    openHistoryModal,
    logout,
    startActiveRoute,
    toggleTheme,
    switchScreen,
    switchTab,
    initGPS,
    confirmStopAndNext,
    nextStop,
    prevStop,
    copyCurrentAddress,
    copyRouteSummary,
    centerMapOnCurrent,
    fitAllStopsMap,
    toggleFollowGps,
    setPackageSpec,
    recalculateAllRoutes,
    installPwa,
    jumpFromSearch,
    openMultiBatchModal,
    openFinishRouteModal,
    confirmFinishRoute,
    toggleMapItemsDrawer,
    renderMapBottomSheet,
    triggerManualScanFromInput,
    sendStopToEnd,
    sendStopToFront,
    sendHubToEnd,
    sendHubToFront,
    sendItemToEnd,
    toggleWakeLock,
    toggleTurnInstructions,
    showToast
  };

  // Safe bootstrap (handles interactive / complete readyState on fast mobile caches)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
