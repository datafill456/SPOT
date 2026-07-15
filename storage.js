/* ============================================================
   storage.js
   Everything that touches localStorage: the working draft (so a
   refresh doesn't lose typed quotes), the daily history archive
   used for the Premium History screen and charts, and simple
   settings like theme.
   ============================================================ */

const FXStorage = (function () {
  const DRAFT_KEY = 'fx_terminal_draft_v1';
  const HISTORY_KEY = 'fx_terminal_history_v1';
  const SETTINGS_KEY = 'fx_terminal_settings_v1';

  function saveDraft(state) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error('saveDraft failed', e);
      return false;
    }
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('loadDraft failed', e);
      return null;
    }
  }

  function clearDraft() {
    localStorage.removeItem(DRAFT_KEY);
  }

  /** History is keyed by trade date (YYYY-MM-DD) -> snapshot of raw input + solved curve summary. */
  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveHistorySnapshot(dateKey, snapshot) {
    const history = getHistory();
    history[dateKey] = snapshot;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

  function getSnapshot(dateKey) {
    const history = getHistory();
    return history[dateKey] || null;
  }

  function listSnapshotDates() {
    return Object.keys(getHistory()).sort();
  }

  function deleteSnapshot(dateKey) {
    const history = getHistory();
    delete history[dateKey];
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

  function exportHistoryJSON() {
    return JSON.stringify(getHistory(), null, 2);
  }

  function getSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveSettings(settings) {
    const merged = { ...getSettings(), ...settings };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  }

  return {
    saveDraft, loadDraft, clearDraft,
    getHistory, saveHistorySnapshot, getSnapshot, listSnapshotDates, deleteSnapshot,
    exportHistoryJSON,
    getSettings, saveSettings,
  };
})();
