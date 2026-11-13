// Firebase Service Layer (Auth & Firestore Sync)
// Works 100% offline/locally by default, and automatically syncs to Firebase
// once the user pastes their Firebase Project credentials.

const FirebaseService = (function () {
  // Pre-configured or user-provided Firebase configuration
  // You can paste your Firebase Config here directly, or enter it in the app Settings UI!
  // Default fallback configuration (Populated from window.__ENV__ or localStorage)
  const DEFAULT_CONFIG = {
    apiKey: "",
    authDomain: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: ""
  };

  let isInitialized = false;
  let auth = null;
  let db = null;
  let currentUser = null;
  let authCallbacks = [];

  function getEnvConfig() {
    const env = (typeof window !== "undefined" && window.__ENV__) || {};
    return {
      apiKey: env.FIREBASE_API_KEY || "",
      authDomain: env.FIREBASE_AUTH_DOMAIN || "",
      projectId: env.FIREBASE_PROJECT_ID || "",
      storageBucket: env.FIREBASE_STORAGE_BUCKET || "",
      messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || "",
      appId: env.FIREBASE_APP_ID || ""
    };
  }

  function getStoredConfig() {
    try {
      const stored = localStorage.getItem("spx_firebase_config");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && parsed.apiKey) return parsed;
      }
    } catch (e) {}
    const envCfg = getEnvConfig();
    if (envCfg && envCfg.apiKey) return envCfg;
    return DEFAULT_CONFIG;
  }

  function setStoredConfig(cfg) {
    try {
      localStorage.setItem("spx_firebase_config", JSON.stringify(cfg));
      initFirebase(cfg);
    } catch (e) {
      console.warn("Error saving config", e);
    }
  }

  function initFirebase(cfg = null) {
    const config = cfg || getStoredConfig();
    if (!config || !config.apiKey || !config.projectId) {
      // Offline / Local Mode
      isInitialized = false;
      loadLocalUser();
      return false;
    }

    if (typeof firebase === "undefined") {
      console.warn("Firebase scripts not loaded yet");
      loadLocalUser();
      return false;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }
      auth = firebase.auth();
      db = firebase.firestore();
      isInitialized = true;

      auth.onAuthStateChanged((user) => {
        currentUser = user;
        notifyAuthCallbacks(user);
      });
      return true;
    } catch (err) {
      console.warn("Firebase init failed, continuing in Local Mode", err);
      isInitialized = false;
      loadLocalUser();
      return false;
    }
  }

  function loadLocalUser() {
    try {
      const local = localStorage.getItem("spx_local_user");
      if (local) {
        currentUser = JSON.parse(local);
      } else {
        currentUser = {
          uid: "local-driver",
          displayName: "Entregador SPX",
          email: "entregador@spx.local",
          isLocal: true
        };
      }
    } catch (e) {
      currentUser = { uid: "local-driver", displayName: "Entregador SPX", isLocal: true };
    }
    notifyAuthCallbacks(currentUser);
  }

  function onAuthChange(cb) {
    authCallbacks.push(cb);
    if (currentUser !== null) cb(currentUser);
  }

  function notifyAuthCallbacks(user) {
    authCallbacks.forEach((cb) => {
      try { cb(user); } catch (e) {}
    });
  }

  async function loginEmail(email, password) {
    if (!isInitialized || !auth) {
      // Local simulated login
      currentUser = {
        uid: "user_" + btoa(email).slice(0, 10),
        email,
        displayName: email.split("@")[0],
        isLocal: true
      };
      localStorage.setItem("spx_local_user", JSON.stringify(currentUser));
      notifyAuthCallbacks(currentUser);
      return currentUser;
    }
    const res = await auth.signInWithEmailAndPassword(email, password);
    currentUser = res.user;
    return res.user;
  }

  async function registerEmail(email, password, displayName) {
    if (!isInitialized || !auth) {
      currentUser = {
        uid: "user_" + btoa(email).slice(0, 10),
        email,
        displayName: displayName || email.split("@")[0],
        isLocal: true
      };
      localStorage.setItem("spx_local_user", JSON.stringify(currentUser));
      notifyAuthCallbacks(currentUser);
      return currentUser;
    }
    const res = await auth.createUserWithEmailAndPassword(email, password);
    if (displayName && res.user.updateProfile) {
      await res.user.updateProfile({ displayName });
    }
    currentUser = res.user;
    return res.user;
  }

  async function loginGoogle() {
    if (!isInitialized || !auth) {
      throw new Error("Configure o Firebase para ativar o login com Google.");
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    const res = await auth.signInWithPopup(provider);
    currentUser = res.user;
    return res.user;
  }

  async function logout() {
    if (isInitialized && auth) {
      await auth.signOut();
    }
    localStorage.removeItem("spx_local_user");
    loadLocalUser();
  }

  // Route History Persistence
  const HISTORY_STORAGE_KEY = "spx_routes_history";

  function getLocalHistory() {
    try {
      const data = localStorage.getItem(HISTORY_STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  function saveLocalHistory(routes) {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(routes));
    } catch (e) {}
  }

  async function saveRouteToHistory(routeSummary) {
    const routeRecord = {
      id: "route_" + Date.now(),
      createdAt: new Date().toISOString(),
      dateLabel: new Date().toLocaleDateString("pt-BR"),
      timeLabel: new Date().toLocaleTimeString("pt-BR"),
      startTime: routeSummary.startTime || "-",
      endTime: routeSummary.endTime || "-",
      totalStops: routeSummary.totalStops || 0,
      totalPackages: routeSummary.totalPackages || 0,
      deliveredCount: routeSummary.deliveredCount || 0,
      failedCount: routeSummary.failedCount || 0,
      successRate: Math.round(((routeSummary.deliveredCount || 0) / (routeSummary.totalPackages || 1)) * 100),
      region: routeSummary.region || "Zona 07 • Maringá",
      details: routeSummary.details || []
    };

    // Always save locally
    const list = getLocalHistory();
    list.unshift(routeRecord);
    saveLocalHistory(list.slice(0, 50)); // keep last 50 routes

    // Sync to Firestore if authenticated
    if (isInitialized && db && currentUser && !currentUser.isLocal) {
      try {
        await db.collection("users").doc(currentUser.uid).collection("routes").doc(routeRecord.id).set(routeRecord);
      } catch (err) {
        console.warn("Failed to sync route to Firestore", err);
      }
    }

    return routeRecord;
  }

  async function fetchRoutesHistory() {
    // If online with Firestore, pull remote + local
    if (isInitialized && db && currentUser && !currentUser.isLocal) {
      try {
        const snap = await db.collection("users").doc(currentUser.uid).collection("routes").orderBy("createdAt", "desc").limit(30).get();
        const remote = [];
        snap.forEach((doc) => remote.push(doc.data()));
        if (remote.length > 0) {
          saveLocalHistory(remote);
          return remote;
        }
      } catch (err) {
        console.warn("Failed to fetch from Firestore, falling back to local history", err);
      }
    }
    return getLocalHistory();
  }

  async function deleteRouteFromHistory(routeId) {
    const list = getLocalHistory().filter((r) => r.id !== routeId);
    saveLocalHistory(list);

    if (isInitialized && db && currentUser && !currentUser.isLocal) {
      try {
        await db.collection("users").doc(currentUser.uid).collection("routes").doc(routeId).delete();
      } catch (err) {
        console.warn("Failed to delete from Firestore", err);
      }
    }
  }

  return {
    initFirebase,
    getStoredConfig,
    setStoredConfig,
    isConfigured: () => isInitialized,
    getUser: () => currentUser,
    onAuthChange,
    loginEmail,
    registerEmail,
    loginGoogle,
    logout,
    saveRouteToHistory,
    fetchRoutesHistory,
    deleteRouteFromHistory
  };
})();

if (typeof window !== "undefined") {
  window.FirebaseService = FirebaseService;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = FirebaseService;
}
