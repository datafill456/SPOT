/* ============================================================
   script.js
   Wires calendar.js / calculator.js / storage.js / excel.js /
   chart.js together into the running application: renders every
   view, listens for input, and re-solves the market on every
   keystroke (no Calculate button, per spec).
   ============================================================ */

(function () {
  const TENORS = FXCalculator.TENOR_ORDER;
  const LABELS = FXCalculator.TENOR_LABELS;

  const state = {
    tradeDate: new Date(),
    pair: 'USD/LKR',
    rawInput: {}, // tenor -> {bid:{outright,premium}, offer:{outright,premium}}
    valueDates: null,
    solved: null,
  };

  TENORS.forEach((t) => {
    state.rawInput[t] = { bid: { outright: null, premium: null }, offer: { outright: null, premium: null } };
  });

  function todayKey() {
    return FXCalendar.fmt(state.tradeDate);
  }

  function recompute() {
    state.valueDates = FXCalculator.buildValueDates(state.tradeDate);
    state.solved = FXCalculator.solveMarket(state.rawInput, state.valueDates);
  }

  /* ---------------- Draft persistence ---------------- */
  function loadDraft() {
    const draft = FXStorage.loadDraft();
    if (draft && draft.tradeDateKey === todayKey()) {
      state.rawInput = draft.rawInput;
      state.pair = draft.pair || state.pair;
    }
  }

  let saveTimer = null;
  function scheduleSaveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      FXStorage.saveDraft({ tradeDateKey: todayKey(), rawInput: state.rawInput, pair: state.pair });
    }, 300);
  }

  /* ---------------- Formatting helpers ---------------- */
  function fmtNum(v, dp = 2) {
    if (typeof v !== 'number' || Number.isNaN(v)) return '—';
    return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtSigned(v, dp = 2) {
    if (typeof v !== 'number' || Number.isNaN(v)) return '—';
    const s = v >= 0 ? '+' : '';
    return s + fmtNum(v, dp);
  }
  function fmtDateLabel(d) {
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
  }
  function weekdayLabel(d) {
    return d.toLocaleDateString('en-US', { weekday: 'short' });
  }

  /* ==================================================================
     RENDER: header
     ================================================================== */
  function renderHeader() {
    document.getElementById('tradeDateDisplay').textContent = fmtDateLabel(state.tradeDate);
  }

  /* ==================================================================
     RENDER: input table (Dealer Quotes tab)
     ================================================================== */
  function renderInputTable() {
    const tbody = document.getElementById('inputTableBody');
    tbody.innerHTML = '';
    TENORS.forEach((t) => {
      const tr = document.createElement('tr');
      if (t === 'spot') tr.classList.add('row-spot');
      const date = state.valueDates.dates[t];
      tr.innerHTML = `
        <td><span class="tenor-name">${LABELS[t]}</span><span class="tenor-date">${fmtDateLabel(date)}</span></td>
        <td><input type="number" step="any" class="cell-input bid-input" data-tenor="${t}" data-side="bid" data-field="outright" placeholder="—"></td>
        <td><input type="number" step="any" class="cell-input offer-input" data-tenor="${t}" data-side="offer" data-field="outright" placeholder="—"></td>
        <td><input type="number" step="any" class="cell-input bid-input" data-tenor="${t}" data-side="bid" data-field="premium" placeholder="—"></td>
        <td><input type="number" step="any" class="cell-input offer-input" data-tenor="${t}" data-side="offer" data-field="premium" placeholder="—"></td>
      `;
      tbody.appendChild(tr);
    });

    // populate values
    document.querySelectorAll('#inputTableBody input.cell-input').forEach((input) => {
      const { tenor, side, field } = input.dataset;
      const v = state.rawInput[tenor][side][field];
      input.value = v === null || v === undefined ? '' : v;
    });

    attachInputHandlers();
  }

  function attachInputHandlers() {
    const inputs = Array.from(document.querySelectorAll('#inputTableBody input.cell-input'));

    inputs.forEach((input, idx) => {
      input.addEventListener('input', () => {
        const { tenor, side, field } = input.dataset;
        const raw = input.value.trim();
        state.rawInput[tenor][side][field] = raw === '' ? null : parseFloat(raw);
        recompute();
        renderQuoteScreen();
        renderSolverStatus();
        renderCurveTable();
        scheduleSaveDraft();
      });

      input.addEventListener('keydown', (e) => {
        const cols = ['outright', 'outright', 'premium', 'premium']; // not used directly; navigation below is column-index based
        const colIndex = Array.from(input.parentElement.parentElement.children).indexOf(input.parentElement); // row's cell index of this input's <td>
        const rowEl = input.closest('tr');
        const rowIndex = Array.from(rowEl.parentElement.children).indexOf(rowEl);
        const allRows = Array.from(rowEl.parentElement.children);

        if (e.key === 'Enter') {
          e.preventDefault();
          const next = inputs[idx + 1];
          if (next) next.focus();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const targetRow = allRows[rowIndex + 1];
          if (targetRow) {
            const targetInput = targetRow.children[colIndex].querySelector('input');
            if (targetInput) targetInput.focus();
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const targetRow = allRows[rowIndex - 1];
          if (targetRow) {
            const targetInput = targetRow.children[colIndex].querySelector('input');
            if (targetInput) targetInput.focus();
          }
        } else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) {
          const next = inputs[idx + 1];
          if (next) { e.preventDefault(); next.focus(); }
        } else if (e.key === 'ArrowLeft' && input.selectionStart === 0) {
          const prev = inputs[idx - 1];
          if (prev) { e.preventDefault(); prev.focus(); }
        }
      });
    });
  }

  /* ==================================================================
     RENDER: solver status banner
     ================================================================== */
  function renderSolverStatus() {
    const el = document.getElementById('solverStatus');
    const { bidSpot, offerSpot, bidSlope, offerSlope } = state.solved;
    if (bidSpot === null && offerSpot === null) {
      el.className = 'solver-status warn';
      el.textContent = 'Enter a Spot rate (or Cash rate + one premium/outright) to begin. The solver will fill in everything else.';
      return;
    }
    const parts = [];
    parts.push(`Spot solved: ${fmtNum(bidSpot)} / ${fmtNum(offerSpot)}`);
    if (bidSlope !== null || offerSlope !== null) {
      parts.push(`curve slope ${fmtSigned(bidSlope, 4)} / ${fmtSigned(offerSlope, 4)} pts per day`);
    } else {
      parts.push('add one more premium or outright anywhere to project the forward curve');
    }
    el.className = 'solver-status ok';
    el.textContent = parts.join(' · ');
  }

  /* ==================================================================
     RENDER: Dealer Quote Screen (read-only big board)
     ================================================================== */
  function renderQuoteScreen() {
    const tbody = document.getElementById('quoteScreenBody');
    tbody.innerHTML = '';
    TENORS.forEach((t) => {
      const c = state.solved.curve[t];
      const tr = document.createElement('tr');
      if (t === 'spot') tr.classList.add('row-spot');
      tr.innerHTML = `
        <td><span class="tenor-name">${c.label}</span></td>
        <td class="mono val-muted">${fmtDateLabel(c.date)}</td>
        <td class="mono val-muted">${c.daysFromSpot}</td>
        <td class="mono val-bid">${fmtNum(c.bidOutright)}</td>
        <td class="mono val-offer">${fmtNum(c.offerOutright)}</td>
        <td class="mono val-bid">${fmtSigned(c.bidPremium)}</td>
        <td class="mono val-offer">${fmtSigned(c.offerPremium)}</td>
        <td class="mono val-muted">${fmtSigned(c.bidPremiumPerDay, 4)}</td>
        <td class="mono val-muted">${fmtSigned(c.offerPremiumPerDay, 4)}</td>
        <td class="mono val-blue">${fmtSigned(c.bidAnnualized)}%</td>
        <td class="mono val-blue">${fmtSigned(c.offerAnnualized)}%</td>
      `;
      tbody.appendChild(tr);
    });
  }

  /* ==================================================================
     RENDER: Premium Curve tab
     ================================================================== */
  function renderCurveTable() {
    const tbody = document.getElementById('curveTableBody');
    tbody.innerHTML = '';
    TENORS.forEach((t) => {
      const c = state.solved.curve[t];
      const tr = document.createElement('tr');
      if (t === 'spot') tr.classList.add('row-spot');
      tr.innerHTML = `
        <td class="tenor-name">${c.label}</td>
        <td class="mono val-bid">${fmtSigned(c.bidPremium)}</td>
        <td class="mono val-offer">${fmtSigned(c.offerPremium)}</td>
        <td class="mono val-muted">${fmtSigned(c.spreadPremium)}</td>
        <td class="mono val-bid">${fmtNum(c.bidOutright)}</td>
        <td class="mono val-offer">${fmtNum(c.offerOutright)}</td>
        <td class="mono val-muted">${fmtSigned(c.bidPremiumPerDay, 4)}</td>
        <td class="mono val-muted">${fmtSigned(c.offerPremiumPerDay, 4)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  /* ==================================================================
     RENDER: Value Dates tab
     ================================================================== */
  function renderLadder() {
    const box = document.getElementById('ladderBox');
    box.innerHTML = '';
    TENORS.forEach((t) => {
      const date = state.valueDates.dates[t];
      const days = state.valueDates.days[t];
      const chip = document.createElement('div');
      chip.className = 'ladder-chip';
      chip.innerHTML = `
        <div class="t">${LABELS[t]}</div>
        <div class="d mono">${fmtDateLabel(date)}</div>
        <div class="n">${weekdayLabel(date)} · ${days >= 0 ? '+' : ''}${days}d from Spot</div>
      `;
      box.appendChild(chip);
    });
  }

  function renderDateDetail() {
    const tbody = document.getElementById('dateDetailBody');
    tbody.innerHTML = '';
    const cashDate = state.valueDates.cash;
    TENORS.forEach((t) => {
      const date = state.valueDates.dates[t];
      const daysFromCash = FXCalendar.calendarDaysBetween(cashDate, date);
      const daysFromSpot = state.valueDates.days[t];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="tenor-name">${LABELS[t]}</td>
        <td class="mono">${fmtDateLabel(date)}</td>
        <td class="mono val-muted">${weekdayLabel(date)}</td>
        <td class="mono">${daysFromCash}</td>
        <td class="mono">${daysFromSpot}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  /* ==================================================================
     RENDER: Broken date tab
     ================================================================== */
  function renderBrokenDate() {
    const input = document.getElementById('brokenDateInput');
    const resultBox = document.getElementById('brokenResult');
    if (!input.value) { resultBox.innerHTML = '<div class="small-text">Pick a date above.</div>'; return; }
    const target = new Date(input.value + 'T00:00:00');
    const result = FXCalculator.interpolateBrokenDate(state.solved.curve, target, state.valueDates.spot);
    if (!result) {
      resultBox.innerHTML = '<div class="solver-status warn">Not enough of the curve is solved yet to interpolate this date.</div>';
      return;
    }
    const bidOutright = state.solved.bidSpot !== null ? state.solved.bidSpot + result.bidPremium : null;
    const offerOutright = state.solved.offerSpot !== null ? state.solved.offerSpot + result.offerPremium : null;
    resultBox.innerHTML = `
      <table class="dealer"><tbody>
        <tr><td class="tenor-name">Days from Spot</td><td class="mono">${result.days}</td></tr>
        <tr><td class="tenor-name">Interpolated Bid Premium</td><td class="mono val-bid">${fmtSigned(result.bidPremium)}</td></tr>
        <tr><td class="tenor-name">Interpolated Offer Premium</td><td class="mono val-offer">${fmtSigned(result.offerPremium)}</td></tr>
        <tr><td class="tenor-name">Bid Outright</td><td class="mono val-bid">${fmtNum(bidOutright)}</td></tr>
        <tr><td class="tenor-name">Offer Outright</td><td class="mono val-offer">${fmtNum(offerOutright)}</td></tr>
      </tbody></table>
    `;
  }

  /* ==================================================================
     RENDER: Charts tab
     ================================================================== */
  function renderCharts() {
    FXCharts.renderForwardCurve('chartForward', state.solved.curve);
    FXCharts.renderPremiumPerDay('chartPerDay', state.solved.curve);
    FXCharts.renderAnnualized('chartAnnualized', state.solved.curve);
    renderHistoryTenorSelect();
    renderHistoryChart();
  }

  function renderHistoryTenorSelect() {
    const sel = document.getElementById('historyTenorSelect');
    if (sel.dataset.built) return;
    sel.innerHTML = TENORS.filter((t) => t !== 'cash' && t !== 'tom')
      .map((t) => `<option value="${t}">${LABELS[t]}</option>`).join('');
    sel.dataset.built = '1';
    sel.addEventListener('change', renderHistoryChart);
  }

  function renderHistoryChart() {
    const tenor = document.getElementById('historyTenorSelect').value || 'spot';
    FXCharts.renderHistory('chartHistory', FXStorage.getHistory(), tenor);
  }

  /* ==================================================================
     RENDER: History tab
     ================================================================== */
  function renderHistoryList() {
    const box = document.getElementById('historyList');
    const dates = FXStorage.listSnapshotDates().reverse();
    if (!dates.length) {
      box.innerHTML = '<div class="small-text">No saved days yet. Use "Save Today\'s Quotes to History" on the Dealer Quotes tab.</div>';
    } else {
      box.innerHTML = dates.map((d) => {
        const snap = FXStorage.getSnapshot(d);
        const spotBid = snap.solved && snap.solved.bidSpot !== null ? fmtNum(snap.solved.bidSpot) : '—';
        return `<div class="history-row"><span class="mono">${d}</span><span>Spot Bid ${spotBid}</span><button class="btn danger" data-del="${d}" style="padding:3px 8px;">Delete</button></div>`;
      }).join('');
      box.querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', () => {
          FXStorage.deleteSnapshot(btn.dataset.del);
          renderHistoryList();
          renderCompareSelectors();
        });
      });
    }
    renderCompareSelectors();
  }

  function renderCompareSelectors() {
    const dates = FXStorage.listSnapshotDates();
    const opts = dates.map((d) => `<option value="${d}">${d}</option>`).join('');
    document.getElementById('compareA').innerHTML = opts;
    document.getElementById('compareB').innerHTML = opts;
  }

  function runCompare() {
    const a = document.getElementById('compareA').value;
    const b = document.getElementById('compareB').value;
    const box = document.getElementById('compareResult');
    if (!a || !b) { box.innerHTML = '<div class="small-text">Select two saved days.</div>'; return; }
    const snapA = FXStorage.getSnapshot(a);
    const snapB = FXStorage.getSnapshot(b);
    const rows = TENORS.map((t) => {
      const ca = snapA.solved.curve[t], cb = snapB.solved.curve[t];
      const diff = (typeof ca.bidPremium === 'number' && typeof cb.bidPremium === 'number') ? cb.bidPremium - ca.bidPremium : null;
      return `<tr>
        <td class="tenor-name">${LABELS[t]}</td>
        <td class="mono val-bid">${fmtSigned(ca.bidPremium)}</td>
        <td class="mono val-bid">${fmtSigned(cb.bidPremium)}</td>
        <td class="mono val-blue">${diff === null ? '—' : fmtSigned(diff)}</td>
      </tr>`;
    }).join('');
    box.innerHTML = `<table class="dealer"><thead><tr><th>Tenor</th><th>${a} Bid Prem.</th><th>${b} Bid Prem.</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  /* ==================================================================
     RENDER: Settings tab
     ================================================================== */
  function renderHolidayList() {
    const box = document.getElementById('holidayListBox');
    box.innerHTML = FXCalendar.listHolidays().map((iso) => `${iso} — ${SL_HOLIDAY_NAMES_2026[iso] || 'Custom holiday'}`).join('<br>');
  }

  /* ==================================================================
     Tabs
     ================================================================== */
  function switchTab(view) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    if (view === 'charts') renderCharts();
    if (view === 'history') renderHistoryList();
    if (view === 'broken') renderBrokenDate();
    if (view === 'settings') renderHolidayList();
  }

  /* ==================================================================
     Theme
     ================================================================== */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('themeToggle').textContent = theme === 'dark' ? '☾ Dark' : '☀ Light';
    FXStorage.saveSettings({ theme });
  }

  /* ==================================================================
     Wire up static controls
     ================================================================== */
  function wireStaticControls() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.view));
    });

    document.getElementById('themeToggle').addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    document.getElementById('clearInputsBtn').addEventListener('click', () => {
      if (!confirm('Clear every input field?')) return;
      TENORS.forEach((t) => {
        state.rawInput[t] = { bid: { outright: null, premium: null }, offer: { outright: null, premium: null } };
      });
      recompute();
      renderInputTable();
      renderQuoteScreen();
      renderSolverStatus();
      renderCurveTable();
      scheduleSaveDraft();
    });

    document.getElementById('saveSnapshotBtn').addEventListener('click', () => {
      FXStorage.saveHistorySnapshot(todayKey(), {
        tradeDateKey: todayKey(),
        rawInput: JSON.parse(JSON.stringify(state.rawInput)),
        solved: JSON.parse(JSON.stringify(state.solved)),
      });
      alert(`Saved quotes for ${todayKey()} to history.`);
      renderHistoryList();
    });

    document.getElementById('exportExcelBtn').addEventListener('click', () => {
      FXExcel.exportToExcel(state.solved.curve, todayKey());
    });
    document.getElementById('exportCSVBtn').addEventListener('click', () => {
      FXExcel.exportToCSV(state.solved.curve, todayKey());
    });
    document.getElementById('importExcelBtn').addEventListener('click', () => {
      document.getElementById('importExcelInput').click();
    });
    document.getElementById('importExcelInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      FXExcel.importFromExcel(file, (rows) => {
        applyImportedRows(rows);
      });
    });
    document.getElementById('copyTableBtn').addEventListener('click', () => {
      FXExcel.copyTableToClipboard(state.solved.curve);
      alert('Table copied to clipboard.');
    });
    document.getElementById('generatePdfBtn').addEventListener('click', () => {
      FXExcel.generatePDFReport(state.solved.curve, {
        pair: state.pair,
        tradeDateLabel: fmtDateLabel(state.tradeDate),
        spotBid: fmtNum(state.solved.bidSpot),
        spotOffer: fmtNum(state.solved.offerSpot),
      });
    });

    document.getElementById('applyPasteBtn').addEventListener('click', () => applyPaste('outright'));
    document.getElementById('applyPastePremiumBtn').addEventListener('click', () => applyPaste('premium'));

    document.getElementById('brokenDateInput').addEventListener('change', renderBrokenDate);

    document.getElementById('runCompareBtn').addEventListener('click', runCompare);
    document.getElementById('exportHistoryBtn').addEventListener('click', () => {
      const blob = new Blob([FXStorage.exportHistoryJSON()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'fx_premium_history.json'; a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById('pairInput').addEventListener('input', (e) => {
      state.pair = e.target.value;
      scheduleSaveDraft();
    });

    document.getElementById('addHolidayBtn').addEventListener('click', () => {
      const val = document.getElementById('customHolidayInput').value;
      if (!val) return;
      FXCalendar.addCustomHoliday(val);
      recompute();
      renderAllDateViews();
      renderHolidayList();
      alert(`Added ${val} as a bank holiday. Value dates recalculated.`);
    });
  }

  function applyImportedRows(rows) {
    let applied = 0;
    rows.forEach((row) => {
      const label = String(row.Tenor || row.tenor || '').toLowerCase();
      const key = TENORS.find((t) => LABELS[t].toLowerCase() === label || t.toLowerCase() === label);
      if (!key) return;
      const bid = parseFloat(row.Bid ?? row.bid);
      const offer = parseFloat(row.Offer ?? row.offer);
      if (isFinite(bid)) state.rawInput[key].bid.outright = bid;
      if (isFinite(offer)) state.rawInput[key].offer.outright = offer;
      applied++;
    });
    recompute();
    renderInputTable();
    renderQuoteScreen();
    renderSolverStatus();
    renderCurveTable();
    scheduleSaveDraft();
    alert(`Imported ${applied} tenor rows.`);
  }

  function applyPaste(field) {
    const text = document.getElementById('pasteBox').value;
    const parsed = FXExcel.parsePastedQuotes(text);
    parsed.forEach((row) => {
      if (row.bid !== null) state.rawInput[row.tenorKey].bid[field] = row.bid;
      if (row.offer !== null) state.rawInput[row.tenorKey].offer[field] = row.offer;
    });
    recompute();
    renderInputTable();
    renderQuoteScreen();
    renderSolverStatus();
    renderCurveTable();
    scheduleSaveDraft();
    alert(`Applied ${parsed.length} pasted rows to ${field}.`);
  }

  function renderAllDateViews() {
    renderHeader();
    renderLadder();
    renderDateDetail();
    renderInputTable();
    renderQuoteScreen();
    renderSolverStatus();
    renderCurveTable();
  }

  /* ==================================================================
     Init
     ================================================================== */
  function init() {
    loadDraft();
    recompute();

    const settings = FXStorage.getSettings();
    applyTheme(settings.theme || 'dark');
    document.getElementById('pairInput').value = state.pair;

    wireStaticControls();
    renderAllDateViews();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
