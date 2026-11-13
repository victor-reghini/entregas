// QR Code & Barcode Scanner for Package Organization
// Helps SPX drivers scan packages before loading their vehicle,
// informing the exact delivery order and stop number.

const PackageScanner = (function () {
  let html5QrCode = null;
  let isScanning = false;
  let scannedSet = new Set();
  let onScanCallback = null;

  // Sound feedback using Web Audio API
  function playBeep(success = true) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (success) {
        osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
        osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      } else {
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      }
    } catch (e) {
      // AudioContext may be blocked before gesture
    }

    // Vibration on mobile
    if ("vibrate" in navigator) {
      navigator.vibrate(success ? [80, 40, 80] : [200]);
    }
  }

  // Find package in route by code or TN fragment
  function findPackage(code, stops) {
    if (!code || !stops) return null;
    const clean = code.trim().toUpperCase();

    for (let sIdx = 0; sIdx < stops.length; sIdx++) {
      const stop = stops[sIdx];
      for (let pIdx = 0; pIdx < stop.items.length; pIdx++) {
        const item = stop.items[pIdx];
        if (clean.includes(item.tn) || item.tn.includes(clean)) {
          return {
            item,
            stop,
            stopIndex: sIdx,
            packageIndexInStop: pIdx,
            totalStops: stops.length
          };
        }
      }
    }
    return null;
  }

  async function startCamera(elementId, stops, onResult) {
    if (isScanning) return;
    onScanCallback = onResult;

    if (typeof Html5Qrcode === "undefined") {
      console.warn("Html5Qrcode not loaded yet");
      return;
    }

    try {
      html5QrCode = new Html5Qrcode(elementId);
      const config = {
        fps: 15,
        qrbox: { width: 260, height: 260 },
        aspectRatio: 1.0
      };

      await html5QrCode.start(
        { facingMode: "environment" },
        config,
        (decodedText) => {
          handleDecodedCode(decodedText, stops);
        },
        () => {}
      );
      isScanning = true;
    } catch (err) {
      console.warn("Camera start failed, falling back to manual input", err);
      isScanning = false;
    }
  }

  async function stopCamera() {
    if (!isScanning || !html5QrCode) return;
    try {
      await html5QrCode.stop();
      html5QrCode.clear();
    } catch (e) {
      console.warn(e);
    }
    isScanning = false;
  }

  function handleDecodedCode(decodedText, stops) {
    const match = findPackage(decodedText, stops);
    if (match) {
      playBeep(true);
      scannedSet.add(match.item.tn);
      if (onScanCallback) {
        onScanCallback(match, true);
      }
    } else {
      playBeep(false);
      if (onScanCallback) {
        onScanCallback({ rawCode: decodedText }, false);
      }
    }
  }

  function manualSearch(query, stops) {
    return findPackage(query, stops);
  }

  function getScannedCount() {
    return scannedSet.size;
  }

  function isScanned(tn) {
    return scannedSet.has(tn);
  }

  function resetScanned() {
    scannedSet.clear();
  }

  return {
    startCamera,
    stopCamera,
    handleDecodedCode,
    manualSearch,
    getScannedCount,
    isScanned,
    resetScanned,
    playBeep
  };
})();

if (typeof window !== "undefined") {
  window.PackageScanner = PackageScanner;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = PackageScanner;
}
