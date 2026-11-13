// Organiza Entregas - Photo Storage (IndexedDB Local Storage)
// Armazena fotos dos pacotes localmente apenas durante a rota ativa.
// Ao finalizar ou reiniciar a rota, as fotos são apagadas automaticamente.

const PhotoStorage = (function () {
  const DB_NAME = "organiza_entregas_photos_db";
  const DB_VERSION = 1;
  const STORE_NAME = "package_photos";
  let dbPromise = null;

  function getDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) {
          console.warn("IndexedDB não suportado neste navegador.");
          resolve(null);
          return;
        }

        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "tn" });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => {
          console.warn("Erro ao abrir IndexedDB de fotos:", e.target.error);
          resolve(null);
        };
      });
    }
    return dbPromise;
  }

  async function savePhoto(tn, dataUrl) {
    if (!tn || !dataUrl) return false;
    try {
      const db = await getDB();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.put({ tn, dataUrl, updatedAt: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = (err) => {
          console.warn("Erro ao salvar foto no IndexedDB:", err);
          resolve(false);
        };
      });
    } catch (err) {
      console.warn("PhotoStorage savePhoto error:", err);
      return false;
    }
  }

  async function getPhoto(tn) {
    if (!tn) return null;
    try {
      const db = await getDB();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(tn);
        req.onsuccess = () => resolve(req.result ? req.result.dataUrl : null);
        req.onerror = () => resolve(null);
      });
    } catch (err) {
      return null;
    }
  }

  async function getAllPhotos() {
    try {
      const db = await getDB();
      if (!db) return {};
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const map = {};
          (req.result || []).forEach((item) => {
            if (item && item.tn && item.dataUrl) {
              map[item.tn] = item.dataUrl;
            }
          });
          resolve(map);
        };
        req.onerror = () => resolve({});
      });
    } catch (err) {
      return {};
    }
  }

  async function deletePhoto(tn) {
    if (!tn) return false;
    try {
      const db = await getDB();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.delete(tn);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (err) {
      return false;
    }
  }

  async function clearAllPhotos() {
    try {
      const db = await getDB();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (err) {
      return false;
    }
  }

  // Redimensiona e comprime a foto capturada da câmera para economizar memória e agilizar renderização
  function compressImageFile(file, maxWidth = 1080, maxHeight = 1080, quality = 0.72) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width;
          let h = img.height;

          if (w > maxWidth || h > maxHeight) {
            if (w > h) {
              h = Math.round((h * maxWidth) / w);
              w = maxWidth;
            } else {
              w = Math.round((w * maxHeight) / h);
              h = maxHeight;
            }
          }

          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);

          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = () => reject(new Error("Falha ao carregar imagem para compressão"));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error("Falha ao ler arquivo de imagem"));
      reader.readAsDataURL(file);
    });
  }

  return {
    savePhoto,
    getPhoto,
    getAllPhotos,
    deletePhoto,
    clearAllPhotos,
    compressImageFile
  };
})();

if (typeof window !== "undefined") {
  window.PhotoStorage = PhotoStorage;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = PhotoStorage;
}
