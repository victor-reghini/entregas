// Main Application Logic - SPX Express Route Delivery System
// Mobile First, Modular, Clean Header Dropdown, XLSX Support, User Data Isolation

(function () {
  const THEME_KEY = "spx_theme_preference";

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
    activeTab: "current", // 'current' | 'all' | 'organize' | 'map'
    route: null,          // { stops: [], totalPackages: 0, streetsCount: 0 }
    activeStopIdx: 0,
    arrivedCurrent: false,
    startTime: null,
    endTime: null,
    results: {},          // tn -> { status: 'delivered'|'failed', reason: '', time: '' }
    userCoords: null,
    watchId: null,
    autoArrivedStopId: null,
    map: null,
    markers: {
      active: null,
      next: null,
      user: null,
      routeLine: null,
      allStops: []
    }
  };

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
        if (parsed.route && parsed.route.stops && parsed.route.stops.length > 0) {
          state.route = parsed.route;
          state.started = parsed.started || false;
          state.finished = parsed.finished || false;
          state.activeStopIdx = parsed.activeStopIdx || 0;
          state.arrivedCurrent = parsed.arrivedCurrent || false;
          state.startTime = parsed.startTime || null;
          state.endTime = parsed.endTime || null;
          state.results = parsed.results || {};
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
  }

  // --- ROUTE GENERATION & FILE PARSING (XLSX, XLS, CSV) ---
  function handleGenerateRouteFromCSV(csvText, useGPS = false, reverse = false) {
    const rows = RouteOptimizer.parseCSV(csvText);
    if (!rows || rows.length === 0) {
      showToast("Nenhum pacote válido encontrado na planilha.");
      return;
    }

    const options = {
      userLocation: useGPS && state.userCoords ? state.userCoords : null,
      reverse: reverse
    };

    const optimized = RouteOptimizer.buildOptimizedRoute(rows, options);
    state.route = optimized;
    state.started = false;
    state.finished = false;
    state.activeStopIdx = 0;
    state.arrivedCurrent = false;
    state.startTime = null;
    state.endTime = null;
    state.results = {};
    saveState();

    switchScreen("home");
    showToast(`Rota gerada: ${optimized.stops.length} paradas e ${optimized.totalPackages} pacotes.`);
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

  function startActiveRoute() {
    if (!state.route || state.route.stops.length === 0) {
      showToast("Carregue uma planilha antes de iniciar.");
      return;
    }
    state.started = true;
    state.finished = false;
    if (!state.startTime) state.startTime = new Date().toLocaleString("pt-BR");
    saveState();
    switchScreen("active");
    switchTab("current");
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
    state.activeTab = tabName;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    const tabCurrent = document.getElementById("tabCurrentStop");
    const tabAll = document.getElementById("tabAllStops");
    const tabOrganize = document.getElementById("tabOrganize");
    const tabMap = document.getElementById("tabMap");

    tabCurrent.classList.add("hidden");
    tabAll.classList.add("hidden");
    tabOrganize.classList.add("hidden");
    tabMap.classList.add("hidden");

    if (tabName === "current") {
      tabCurrent.classList.remove("hidden");
      renderCurrentStopView();
    } else if (tabName === "all") {
      tabAll.classList.remove("hidden");
      renderFullStopsList();
      setTimeout(scrollActiveStopIntoView, 100);
    } else if (tabName === "organize") {
      tabOrganize.classList.remove("hidden");
      renderOrganizeView();
    } else if (tabName === "map") {
      tabMap.classList.remove("hidden");
      initLeafletMap();
      setTimeout(() => {
        if (state.map) state.map.invalidateSize();
      }, 150);
    }
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

    if (!state.route) {
      badge.classList.add("hidden");
      progressBar.style.width = "0%";
      return;
    }

    const total = state.route.totalPackages;
    const done = Object.keys(state.results).length;
    const pct = Math.round((done / total) * 100);

    badge.classList.remove("hidden");
    badge.textContent = `${done}/${total} (${pct}%)`;
    progressBar.style.width = `${pct}%`;
  }

  // --- HOME / SETUP SCREEN ---
  function renderHomePreview() {
    const summaryBox = document.getElementById("homeRouteSummary");
    const listContainer = document.getElementById("homePreviewStopsList");

    if (!state.route || state.route.stops.length === 0) {
      summaryBox.classList.add("hidden");
      listContainer.innerHTML = "";
      return;
    }

    summaryBox.classList.remove("hidden");

    document.getElementById("statTotalStops").textContent = state.route.stops.length;
    document.getElementById("statTotalPackages").textContent = state.route.totalPackages;
    document.getElementById("statStreetsCount").textContent = state.route.streetsCount;

    const btnFullRoute = document.getElementById("btnOpenFullRouteDirect");
    if (btnFullRoute) {
      btnFullRoute.href = RouteOptimizer.buildGoogleMapsRouteUrl(state.route.stops);
    }

    listContainer.innerHTML = state.route.stops
      .map(
        (s) => `
      <div class="stop-row-card" style="padding:8px 12px; margin-bottom:4px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="stop-idx-badge" style="width:26px; height:26px; font-size:0.75rem;">#${s.id}</span>
          <span style="font-weight:700; font-size:0.85rem;">${s.title}</span>
        </div>
        <span class="badge" style="font-size:0.75rem;">${s.items.length} ${s.items.length > 1 ? "pacotes" : "pacote"}</span>
      </div>
    `
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
    document.getElementById("currentStopPkgCount").textContent = `${stop.items.length} ${stop.items.length > 1 ? "pacotes" : "pacote"}`;
    document.getElementById("currentStopTitle").textContent = stop.title;
    document.getElementById("currentStopMeta").textContent = `${stop.bairro} • ${stop.city} - CEP ${stop.zipcode}`;

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

    // Google Maps Navigation Links
    const btnNav = document.getElementById("btnNavigateSingle");
    btnNav.href = RouteOptimizer.buildSingleStopGoogleMapsUrl(stop);

    // Waze Navigation Link
    const btnWaze = document.getElementById("btnNavigateWaze");
    if (btnWaze) {
      btnWaze.href = RouteOptimizer.buildWazeUrl(stop);
    }

    // Multi-stop Batch Button (Android Auto compatible)
    const btnMulti = document.getElementById("btnNavigateMultiBatch");
    const nextStopsBatchCount = Math.min(10, state.route.stops.length - state.activeStopIdx);
    const endStop = state.route.stops[state.activeStopIdx + nextStopsBatchCount - 1];
    btnMulti.innerHTML = `
      ${renderIcon("navigation", 16)} Navegar Próximas ${nextStopsBatchCount} Paradas (#${stop.id} a #${endStop.id})
    `;
    btnMulti.href = RouteOptimizer.buildGoogleMapsRouteUrl(state.route.stops, state.activeStopIdx, 10);

    const btnCurFull = document.getElementById("btnCurrentStopFullRoute");
    if (btnCurFull) {
      btnCurFull.href = RouteOptimizer.buildGoogleMapsRouteUrl(state.route.stops);
    }

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
      document.getElementById("nextStopDetails").textContent = `${nxt.items.length} ${nxt.items.length > 1 ? "pacotes" : "pacote"} • ${nxt.bairro}`;
    } else {
      nextBox.classList.add("hidden");
    }

    // Update GPS distance pill
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
    } catch (_) {}
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
    } catch (_) {}
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

  function sendWhatsAppMessage(tn) {
    if (!state.route) return;
    const stop = state.route.stops[state.activeStopIdx];
    const addr = stop ? RouteOptimizer.formatStopLabel(stop) : "seu endereço";
    const code = tn || "";
    const msg = `Olá! Sou entregador da Shopee (SPX Express). Estou no endereço ${addr} para realizar a entrega do pacote ${code}. Por favor, me atenda no portão. Obrigado!`;
    const encoded = encodeURIComponent(msg);
    window.open(`https://api.whatsapp.com/send?text=${encoded}`, "_blank");
  }

  const SPX_FAIL_REASONS = [
    "Cliente Ausente",
    "Endereço Incorreto",
    "Destinatário Mudou",
    "Recusado",
    "Sem Acesso"
  ];

  function renderPackageChecklist(stop) {
    const container = document.getElementById("packageItemsContainer");
    container.innerHTML = stop.items
      .map((it, idx) => {
        const res = state.results[it.tn] || { status: "delivered", reason: "" };
        const isDelivered = res.status === "delivered";

        return `
        <div class="package-item">
          <div class="package-item-header">
            <span class="tn-code">#${idx + 1} • ${it.tn}</span>
            <div style="display:flex; align-items:center; gap:6px;">
              <button type="button" class="btn btn-outline btn-sm" style="width:auto; padding:3px 7px; font-size:0.72rem;" onclick="app.sendWhatsAppMessage('${it.tn}')" title="Avisar cliente no WhatsApp">
                ${renderIcon("phone", 12)} WhatsApp
              </button>
              <span class="badge ${isDelivered ? "badge-success" : "badge-warning"}">
                ${isDelivered ? "Entregue" : "Pendente"}
              </span>
            </div>
          </div>
          <div class="complement-pill"><strong>Complemento:</strong> ${it.complement}</div>
          <div class="status-toggles">
            <button type="button" class="status-opt-btn ${isDelivered ? "active-ok" : ""}" onclick="app.setItemStatus('${it.tn}', 'delivered')">
              ${renderIcon("check", 16)} Entregue
            </button>
            <button type="button" class="status-opt-btn ${!isDelivered ? "active-fail" : ""}" onclick="app.setItemStatus('${it.tn}', 'failed')">
              ${renderIcon("x", 16)} Não Entregue
            </button>
          </div>

          <div class="${!isDelivered ? "" : "hidden"}" style="margin-top:8px;">
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

  function markArrived() {
    state.arrivedCurrent = true;
    const stop = state.route.stops[state.activeStopIdx];

    // Pre-select 'delivered' for all items at this stop for 1-tap confirmation
    stop.items.forEach((it) => {
      if (!state.results[it.tn]) {
        state.results[it.tn] = {
          status: "delivered",
          reason: "",
          time: new Date().toLocaleTimeString("pt-BR")
        };
      }
    });

    saveState();
    renderCurrentStopView();
    document.getElementById("stopChecklistBox").scrollIntoView({ behavior: "smooth" });
  }

  function setItemStatus(tn, status) {
    const prev = state.results[tn] || { reason: "" };
    state.results[tn] = {
      status,
      reason: status === "delivered" ? "" : (prev.reason || "Cliente Ausente"),
      time: new Date().toLocaleTimeString("pt-BR")
    };
    if (status === "delivered") {
      playSuccessChime();
    } else {
      playWarningChime();
    }
    saveState();
    const stop = state.route.stops[state.activeStopIdx];
    renderPackageChecklist(stop);
    updateHeader();
  }

  function setItemReason(tn, reason) {
    if (!state.results[tn]) {
      state.results[tn] = { status: "failed", reason: "", time: new Date().toLocaleTimeString("pt-BR") };
    }
    state.results[tn].reason = reason;
    saveState();
    const stop = state.route.stops[state.activeStopIdx];
    renderPackageChecklist(stop);
  }

  function confirmStopAndNext() {
    const stop = state.route.stops[state.activeStopIdx];
    stop.items.forEach((it) => {
      if (!state.results[it.tn]) {
        state.results[it.tn] = { status: "delivered", reason: "", time: new Date().toLocaleTimeString("pt-BR") };
      }
    });

    playSuccessChime();

    if (state.activeStopIdx < state.route.stops.length - 1) {
      state.activeStopIdx += 1;
      state.arrivedCurrent = false;
      saveState();
      renderCurrentStopView();
      if (state.activeTab === "all") {
        renderFullStopsList();
        setTimeout(scrollActiveStopIntoView, 100);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      finishRoute();
    }
  }

  function prevStop() {
    if (state.activeStopIdx > 0) {
      state.activeStopIdx -= 1;
      state.arrivedCurrent = false;
      saveState();
      renderCurrentStopView();
      if (state.activeTab === "all") {
        renderFullStopsList();
        setTimeout(scrollActiveStopIntoView, 100);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function finishRoute() {
    state.finished = true;
    state.endTime = new Date().toLocaleString("pt-BR");
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

    if (state.route) {
      state.route.stops.forEach((s) => {
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
            stopId: s.id || 0,
            status: res.status || "delivered",
            reason: res.reason || "",
            time: res.time || ""
          });
        });
      });
    }

    return {
      startTime: state.startTime || "-",
      endTime: state.endTime || "-",
      totalStops: state.route ? state.route.stops.length : 0,
      totalPackages: state.route ? state.route.totalPackages : 0,
      deliveredCount: delivered,
      failedCount: failed,
      region: state.route && state.route.stops[0] ? `${state.route.stops[0].bairro} • ${state.route.stops[0].city}` : "SPX Route",
      details
    };
  }

  // --- FULL SEQUENTIAL STOPS TAB ---
  function renderFullStopsList() {
    const list = document.getElementById("fullStopsListContainer");
    if (!state.route) return;

    const btnAllFull = document.getElementById("btnAllStopsFullMaps");
    if (btnAllFull) {
      btnAllFull.href = RouteOptimizer.buildGoogleMapsRouteUrl(state.route.stops);
    }

    list.innerHTML = state.route.stops
      .map((s, idx) => {
        const isActive = idx === state.activeStopIdx;
        const allDelivered = s.items.every((it) => state.results[it.tn] && state.results[it.tn].status === "delivered");
        const isDone = idx < state.activeStopIdx || allDelivered;

        return `
        <div class="stop-row-card ${isActive ? "active-stop" : ""} ${isDone && !isActive ? "done-stop" : ""}" onclick="app.jumpToStop(${idx})">
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="stop-idx-badge">
              ${isDone && !isActive ? renderIcon("check", 16) : `#${s.id}`}
            </div>
            <div>
              <div style="font-weight:700; font-size:0.9rem;">${s.title}</div>
              <div class="meta-text">${s.bairro} • ${s.items.length} ${s.items.length > 1 ? "pacotes" : "pacote"}</div>
            </div>
          </div>
          <div style="text-align:right;">
            <span class="badge ${isActive ? "badge-primary" : isDone ? "badge-success" : ""}">
              ${isActive ? "Atual" : isDone ? "Concluída" : "Pendente"}
            </span>
          </div>
        </div>
      `;
      })
      .join("");
  }

  function jumpToStop(idx) {
    state.activeStopIdx = idx;
    state.arrivedCurrent = false;
    saveState();
    switchTab("current");
  }

  // --- ORGANIZE / SCANNER TAB ---
  function renderOrganizeView() {
    const countEl = document.getElementById("organizeScannedCount");
    if (countEl && state.route) {
      countEl.textContent = `${PackageScanner.getScannedCount()} de ${state.route.totalPackages} conferidos`;
    }
  }

  function startScanner() {
    if (!state.route) {
      showToast("Carregue uma rota primeiro.");
      return;
    }
    document.getElementById("scannerStartBtn").classList.add("hidden");
    document.getElementById("scannerStopBtn").classList.remove("hidden");

    PackageScanner.startCamera("qrReaderElement", state.route.stops, (result, found) => {
      const resultCard = document.getElementById("scanResultDisplay");
      resultCard.classList.remove("hidden");

      if (found) {
        document.getElementById("scanStopNumber").textContent = `PARADA #${result.stop.id}`;
        document.getElementById("scanPackageOrder").textContent = `Pacote #${result.item.seq} de ${state.route.totalPackages}`;
        document.getElementById("scanAddress").textContent = result.stop.title;
        document.getElementById("scanComplement").textContent = result.item.complement;
        document.getElementById("scanTnCode").textContent = result.item.tn;
        renderOrganizeView();
      } else {
        document.getElementById("scanStopNumber").textContent = "CÓDIGO NÃO LOCALIZADO";
        document.getElementById("scanPackageOrder").textContent = result.rawCode || "Desconhecido";
        document.getElementById("scanAddress").textContent = "Este pacote não pertence à rota atual.";
        document.getElementById("scanComplement").textContent = "";
        document.getElementById("scanTnCode").textContent = "";
      }
    });
  }

  function stopScanner() {
    PackageScanner.stopCamera();
    document.getElementById("scannerStartBtn").classList.remove("hidden");
    document.getElementById("scannerStopBtn").classList.add("hidden");
  }

  function handleManualSearch(query) {
    if (!state.route || !query.trim()) return;
    const match = PackageScanner.manualSearch(query, state.route.stops);
    const resultCard = document.getElementById("scanResultDisplay");
    resultCard.classList.remove("hidden");

    if (match) {
      PackageScanner.playBeep(true);
      document.getElementById("scanStopNumber").textContent = `PARADA #${match.stop.id}`;
      document.getElementById("scanPackageOrder").textContent = `Pacote #${match.item.seq} de ${state.route.totalPackages}`;
      document.getElementById("scanAddress").textContent = match.stop.title;
      document.getElementById("scanComplement").textContent = match.item.complement;
      document.getElementById("scanTnCode").textContent = match.item.tn;
    } else {
      PackageScanner.playBeep(false);
      document.getElementById("scanStopNumber").textContent = "NÃO ENCONTRADO";
      document.getElementById("scanPackageOrder").textContent = query;
      document.getElementById("scanAddress").textContent = "Verifique o código digitado.";
      document.getElementById("scanComplement").textContent = "";
      document.getElementById("scanTnCode").textContent = "";
    }
  }

  // --- LEAFLET MAP ---
  function initLeafletMap() {
    if (!state.route || state.route.stops.length === 0) return;
    if (state.map) {
      updateMapMarkers();
      return;
    }

    const first = state.route.stops[0];
    state.map = L.map("map").setView([first.lat, first.lon], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(state.map);

    const latlngs = state.route.stops.map((s) => [s.lat, s.lon]);
    state.markers.routeLine = L.polyline(latlngs, {
      color: "#ee4d2d",
      weight: 3.5,
      opacity: 0.7,
      dashArray: "6, 6"
    }).addTo(state.map);

    updateMapMarkers();
  }

  function updateMapMarkers() {
    if (!state.map || !state.route) return;
    const stop = state.route.stops[state.activeStopIdx];

    if (state.markers.active) state.map.removeLayer(state.markers.active);
    if (state.markers.next) state.map.removeLayer(state.markers.next);

    state.markers.active = L.circleMarker([stop.lat, stop.lon], {
      radius: 11,
      color: "#ffffff",
      weight: 2.5,
      fillColor: "#10b981",
      fillOpacity: 1
    })
      .addTo(state.map)
      .bindPopup(`<strong>#${stop.id} (Atual)</strong><br>${stop.title}`)
      .openPopup();

    if (state.activeStopIdx + 1 < state.route.stops.length) {
      const nxt = state.route.stops[state.activeStopIdx + 1];
      state.markers.next = L.circleMarker([nxt.lat, nxt.lon], {
        radius: 8,
        color: "#ffffff",
        weight: 1.5,
        fillColor: "#f59e0b",
        fillOpacity: 0.9
      })
        .addTo(state.map)
        .bindPopup(`<strong>#${nxt.id} (Próxima)</strong><br>${nxt.title}`);
    }

    state.map.setView([stop.lat, stop.lon], 16);
  }

  function centerMapOnCurrent() {
    if (!state.map || !state.route) return;
    const stop = state.route.stops[state.activeStopIdx];
    state.map.setView([stop.lat, stop.lon], 17);
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
        state.userCoords = pos.coords;
        updateDistanceUI(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      () => {
        if (textEl) textEl.textContent = "GPS indisponível. Use o botão Cheguei.";
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  function updateDistanceUI(lat, lon) {
    if (!state.route || !state.started || state.finished) return;
    const stop = state.route.stops[state.activeStopIdx];
    if (!stop) return;

    const dist = Math.round(RouteOptimizer.haversineMeters(lat, lon, stop.lat, stop.lon));
    const pill = document.getElementById("gpsDistancePill");
    const textEl = document.getElementById("gpsDistanceText");

    if (dist <= 65) {
      pill.classList.add("gps-near");
      textEl.textContent = `Você chegou! Distância: ${dist}m`;
      if (!state.arrivedCurrent && state.autoArrivedStopId !== stop.id) {
        state.autoArrivedStopId = stop.id;
        markArrived();
      }
    } else {
      pill.classList.remove("gps-near");
      const distStr = dist >= 1000 ? `${(dist / 1000).toFixed(2)} km` : `${dist} m`;
      textEl.textContent = `Distância até parada #${stop.id}: ${distStr}`;
    }
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

  function copyWhatsAppReport() {
    const summary = getRouteSummary();
    const fails = summary.details
      .filter((d) => d.status === "failed")
      .map((d) => `• ${d.tn} (${d.address}): ${d.reason || "Não visitado"}`);

    const text = [
      `📦 *RELATÓRIO DE ENTREGAS SPX EXPRESS*`,
      `📅 Data: ${new Date().toLocaleDateString("pt-BR")}`,
      `✅ Pacotes Entregues: ${summary.deliveredCount} / ${summary.totalPackages} (${summary.successRate}%)`,
      `❌ Não Entregues: ${summary.failedCount}`,
      fails.length > 0 ? `\n*Pendências:*\n${fails.join("\n")}` : `\n🎉 100% de sucesso!`
    ].join("\n");

    navigator.clipboard.writeText(text).then(() => {
      showToast("Resumo para WhatsApp copiado!");
    });
  }

  function resetRoute() {
    localStorage.removeItem(getStorageKey());
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
    const stops = state.route.stops;
    const fullRouteUrl = RouteOptimizer.buildGoogleMapsRouteUrl(stops);
    const batchSize = 10;
    const batches = [];

    // Continuous overlapping legs: leg 0: 0..9 (stops 1..10), leg 1: 9..18 (stops 10..19), etc.
    for (let i = 0; i < stops.length; i += (batchSize - 1)) {
      const slice = stops.slice(i, i + batchSize);
      if (slice.length <= 1 && batches.length > 0) break;
      const startId = slice[0].id;
      const endId = slice[slice.length - 1].id;
      const url = RouteOptimizer.buildGoogleMapsRouteUrl(stops, i, batchSize);
      batches.push({ startId, endId, count: slice.length, url });
      if (i + batchSize >= stops.length) break;
    }

    container.innerHTML = `
      <div style="background:var(--bg-subtle); border:1px solid var(--border); border-radius:var(--radius); padding:12px; margin-bottom:10px;">
        <div style="font-weight:800; font-size:0.95rem; margin-bottom:4px; display:flex; align-items:center; gap:6px;">
          ${renderIcon("mapPin", 16, "icon-primary")} Rota Completa Única (${stops.length} Paradas)
        </div>
        <p class="meta-text" style="margin-bottom:10px; font-size:0.8rem;">
          Gera um único link com todas as paradas nomeadas configuradas para navegação direta no Google Maps e Android Auto.
        </p>
        <a href="${fullRouteUrl}" target="_blank" rel="noopener" class="btn btn-maps" style="text-align:center;">
          ${renderIcon("externalLink", 16)} Abrir Todas as ${stops.length} Paradas no Google Maps
        </a>
      </div>

      <div style="font-size:0.75rem; font-weight:800; color:var(--text-muted); text-transform:uppercase; margin:8px 0 6px 0;">
        Trechos Contínuos (10 paradas - recomendado para navegação no carro):
      </div>

      <div style="display:flex; flex-direction:column; gap:8px;">
        ${batches
          .map(
            (b) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);">
            <div>
              <div style="font-weight:700; font-size:0.88rem;">Trecho #${b.startId} até #${b.endId}</div>
              <div class="meta-text" style="font-size:0.78rem;">${b.count} paradas sequenciais</div>
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
      if (state.activeTab === "all") {
        renderFullStopsList();
        setTimeout(scrollActiveStopIntoView, 100);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
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
    if (e && e.stopPropagation) e.stopPropagation();
    const dropdownMenu = document.getElementById("accountDropdownMenu");
    const btnAccountMenu = document.getElementById("btnAccountMenu");
    if (!dropdownMenu) return;
    dropdownMenu.classList.toggle("hidden");
    if (btnAccountMenu) {
      btnAccountMenu.classList.toggle("active", !dropdownMenu.classList.contains("hidden"));
    }
  }

  function openSettingsModal() {
    const cfg = FirebaseService.getStoredConfig();
    if (cfg) {
      document.getElementById("cfgApiKey").value = cfg.apiKey || "";
      document.getElementById("cfgAuthDomain").value = cfg.authDomain || "";
      document.getElementById("cfgProjectId").value = cfg.projectId || "";
      document.getElementById("cfgStorageBucket").value = cfg.storageBucket || "";
      document.getElementById("cfgMessagingSenderId").value = cfg.messagingSenderId || "";
      document.getElementById("cfgAppId").value = cfg.appId || "";
    }
    openModal("modalSettings");
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
    initSwipeGestures();
    initQuickSearch();

    // PWA Service Worker & Online detection
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    updateOnlineStatus();

    // Firebase Auth sync & User Data Isolation
    FirebaseService.onAuthChange((user) => {
      const btnLogin = document.getElementById("btnHeaderLogin");
      const avatarText = document.getElementById("userAvatarText");
      const menuName = document.getElementById("menuUserName");
      const menuEmail = document.getElementById("menuUserEmail");
      const authSection = document.getElementById("menuAuthActionSection");

      if (user && !user.isLocal) {
        // User is logged in: HIDE login button, show avatar initial & profile info
        if (btnLogin) btnLogin.classList.add("hidden");
        const initial = (user.displayName || user.email || "U").charAt(0).toUpperCase();
        if (avatarText) avatarText.textContent = initial;
        if (menuName) menuName.textContent = user.displayName || user.email.split("@")[0];
        if (menuEmail) menuEmail.textContent = user.email;
        if (authSection) authSection.classList.remove("hidden");
      } else {
        // User is guest: SHOW login button, show default guest menu
        if (btnLogin) btnLogin.classList.remove("hidden");
        if (avatarText) avatarText.textContent = "?";
        if (menuName) menuName.textContent = "Visitante";
        if (menuEmail) menuEmail.textContent = "Não conectado";
        if (authSection) authSection.classList.add("hidden");
      }

      // Reload state specifically for this user
      loadState();
      if (state.finished) {
        switchScreen("report");
      } else if (state.started && state.route) {
        switchScreen("active");
        switchTab(state.activeTab || "current");
      } else {
        switchScreen("home");
      }
    });

    FirebaseService.initFirebase();

    // Account Dropdown Menu Toggle
    const btnAccountMenu = document.getElementById("btnAccountMenu");
    const dropdownMenu = document.getElementById("accountDropdownMenu");

    if (btnAccountMenu && dropdownMenu) {
      btnAccountMenu.addEventListener("click", toggleAccountMenu);
    }

    document.addEventListener("click", (e) => {
      if (dropdownMenu && !dropdownMenu.contains(e.target) && btnAccountMenu && !btnAccountMenu.contains(e.target)) {
        closeDropdown();
      }
    });

    // Menu Actions
    const btnLogin = document.getElementById("btnHeaderLogin");
    if (btnLogin) btnLogin.addEventListener("click", openAuthModal);

    const menuHist = document.getElementById("menuItemHistory");
    if (menuHist) menuHist.addEventListener("click", openHistoryModal);

    const menuTheme = document.getElementById("menuItemTheme");
    if (menuTheme) menuTheme.addEventListener("click", toggleTheme);

    const menuSettings = document.getElementById("menuItemSettings");
    if (menuSettings) menuSettings.addEventListener("click", openSettingsModal);

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
      btnFinish.addEventListener("click", () => {
        if (confirm("Deseja encerrar a rota com o status atual?")) finishRoute();
      });
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
      scanInput.addEventListener("input", (e) => handleManualSearch(e.target.value));
    }

    // Report
    const btnExport = document.getElementById("btnExportCSV");
    if (btnExport) btnExport.addEventListener("click", exportCSV);

    const btnCopyWA = document.getElementById("btnCopyWhatsApp");
    if (btnCopyWA) btnCopyWA.addEventListener("click", copyWhatsAppReport);

    const btnReset = document.getElementById("btnResetRoute");
    if (btnReset) btnReset.addEventListener("click", resetRoute);

    const btnCenter = document.getElementById("btnCenterMap");
    if (btnCenter) btnCenter.addEventListener("click", centerMapOnCurrent);

    const btnMultiModal = document.getElementById("btnOpenMultiBatchModal");
    if (btnMultiModal) btnMultiModal.addEventListener("click", openMultiBatchModal);
  }

  // Expose global app methods
  window.app = {
    setItemStatus,
    setItemReason,
    jumpToStop,
    openModal,
    closeModal,
    openAuthModal,
    toggleAccountMenu,
    openHistoryModal,
    openSettingsModal,
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
    sendWhatsAppMessage,
    jumpFromSearch,
    openMultiBatchModal,
    showToast
  };

  // Safe bootstrap (handles interactive / complete readyState on fast mobile caches)
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
