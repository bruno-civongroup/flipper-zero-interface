/**
 * localStorage-based signal library.
 * Replaces signals.json and subghz_signals.json from the Python backend.
 *
 * Create two instances: one for IR signals, one for Sub-GHz signals.
 */

export class SignalStore {
  constructor(storageKey) {
    this._key = storageKey;
  }

  getAll() {
    try {
      return JSON.parse(localStorage.getItem(this._key)) || [];
    } catch {
      return [];
    }
  }

  getById(id) {
    return this.getAll().find(s => s.id === id) || null;
  }

  save(signal) {
    const signals = this.getAll();
    if (!signal.id) {
      signal.id = crypto.randomUUID().slice(0, 8);
    }
    signals.push(signal);
    localStorage.setItem(this._key, JSON.stringify(signals));
    return signal;
  }

  delete(id) {
    const signals = this.getAll();
    const filtered = signals.filter(s => s.id !== id);
    if (filtered.length === signals.length) return false;
    localStorage.setItem(this._key, JSON.stringify(filtered));
    return true;
  }

  importBulk(signalList) {
    const signals = this.getAll();
    const imported = [];
    for (const sig of signalList) {
      const entry = { ...sig, id: crypto.randomUUID().slice(0, 8) };
      signals.push(entry);
      imported.push(entry);
    }
    localStorage.setItem(this._key, JSON.stringify(signals));
    return imported;
  }

  clear() {
    localStorage.removeItem(this._key);
  }
}

export const irStore = new SignalStore('flipper_ir_signals');
export const subghzStore = new SignalStore('flipper_subghz_signals');
export const nfcStore = new SignalStore('flipper_nfc_signals');
export const rfidStore = new SignalStore('flipper_rfid_signals');
