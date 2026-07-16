/* ============================================================
   script.js
   Wires calendar.js / calculator.js / storage.js / excel.js /
   chart.js together into the running application: renders every
   view, listens for input, and re-solves the market on every
   keystroke (no Calculate button, per spec).

   INPUT MODEL: the dealer enters swap POINTS for whichever
   intervals they have (Cash-Tom, Spot-1M, 1M-2M, ...), labeled
   Payer/Receiver, plus one or more real outright ANCHOR rates that
   pin the whole chain to actual levels.
   ============================================================ */

(function () {
  const TENORS = FXCalculator.TENOR_ORDER;
  const LABELS = FXCalculator.TENOR_LABELS;

  const state = {
    tradeDate: new Date(),
    pair: 'USD/LKR',
    edges: [],   // [{ id, from, to, payer:number|null, receiver:number|null }]
    anchors: [], // [{ id, node, payer:number|null, receiver:number|null }]
    valueDates: null,
    solved: null,
  };

  let nextEdgeId = 1;
  let nextAnchorId = 1;

  function makeDefaultEdges() {
    return FXCalculator.DEFAULT_INTERVALS.map(([from, to]) => ({
      id: nextEdgeId++, from, to, payer: null, receiver: null,
    }));
  }

  function makeDefaultAnchors() {
    return [{ id: nextAnchorId++, node: 'spot', payer: null, receiver: null }];
  }

  function todayKey() {
    return FXCalendar.fmt(state.tradeDate);
  }

  function recompute() {
    state.valueDates = FXCalculator.buildValueDates(state.tradeDate);
    state.solved = FXCalculator.solveMarket(state.edges, state.anchors, state.valueDates);
  }

  /* ---------------- Draft persistence ---------------- */
  function loadDraft() {
    const draft = FXStorage.loadDraft();
    if (draft && draft.tradeDateKey === todayKey() && draft.edges && draft.anchors) {
      state.edges = draft.edges;
      state.anchors = draft.anchors;
      state.pair = draft.pair || state.pair;
      nextEdgeId = Math.max(1, ...state.edges.map((e) => e.id + 1));
      nextAnchorId = Math.max(1, ...state.anchors.map((a) => a.id + 1));
    } else {
      state.edges = makeDefaultEdges();
      state.anchors = makeDefaultAnchors();
    }
  }

  let saveTimer = null;
  function scheduleSaveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      FXStorage.saveDraft({
        tradeDateKey: todayKey(), edges: state.edges, anchors: state.anchors, pair: state.pair,
      });
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
     RENDER: Interval (swap points) table
     ================================================================== */
  function intervalLabel(e) {
    return `${LABELS[e.from]} → ${LABELS[e.to]}`;
  }

  function renderIntervalTable() {
    const tbody = document.getElementById('intervalTableBody');
    tbody.innerHTML = '';
    state.edges.forEach((e) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="tenor-name">${intervalLabel(e)}</span></td>
        <td><input type="number" step="any" class="cell-input bid-input edge-input" data-id="${e.id}" data-side="payer" placeholder="—"></td>
        <td><input type="number" step="any" class="cell-input offer-input edge-input" data-id="${e.id}" data-side="receiver" placeholder="—"></td>
        <td><button class="btn danger" data-remove-edge="${e.id}" style="padding:3px 8px;">✕</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('input.edge-input').forEach((input) => {
      const id = Number(input.dataset.id);
      const edge = state.edges.find((e) => e.id === id);
      const v = edge[input.dataset.side];
      input.value = v === null || v === undefined ? '' : v;
    });

    tbody.querySelectorAll('[data-remove-edge]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.edges = state.edges.filter((e) => e.id !== Number(btn.dataset.removeEdge));
        recompute();
        renderIntervalTable();
        renderDownstream();
        scheduleSaveDraft();
      });
    });

    attachGridKeyboardNav('#intervalTableBody', 'input.edge-input');

    tbody.querySelectorAll('input.edge-input').forEach((input) => {
      input.addEventListener('input', () => {
        const id = Number(input.dataset.id);
        const edge = state.edges.find((e) => e.id === id);
        const raw = input.value.trim();
        edge[input.dataset.side] = raw === '' ? null : parseFloat(raw);
        recompute();
        renderDownstream();
        scheduleSaveDraft();
      });
    });
  }

  /* ==================================================================
     RENDER: Anchor table
     ================================================================== */
  function renderAnchorTable() {
    const tbody = document.getElementById('anchorTableBody');
    tbody.innerHTML = '';
    state.anchors.forEach((a) => {
      const date = state.valueDates.dates[a.node];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="tenor-name">${LABELS[a.node]}</span><span class="tenor-date">${fmtDateLabel(date)}</span></td>
        <td><input type="number" step="any" class="cell-input bid-input anchor-input" data-id="${a.id}" data-side="payer" placeholder="—"></td>
        <td><input type="number" step="any" class="cell-input offer-input anchor-input" data-id="${a.id}" data-side="receiver" placeholder="—"></td>
        <td><button class="btn danger" data-remove-anchor="${a.id}" style="padding:3px 8px;">✕</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('input.anchor-input').forEach((input) => {
      const id = Number(input.dataset.id);
      const anchor = state.anchors.find((a) => a.id === id);
      const v = anchor[input.dataset.side];
      input.value = v === null || v === undefined ? '' : v;
    });

    tbody.querySelectorAll('[data-remove-anchor]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.anchors = state.anchors.filter((a) => a.id !== Number(btn.dataset.removeAnchor));
        recompute();
        renderAnchorTable();
        renderDownstream();
        scheduleSaveDraft();
      });
    });

    attachGridKeyboardNav('#anchorTableBody', 'input.anchor-input');

    tbody.querySelectorAll('input.anchor-input').forEach((input) => {
      input.addEventListener('input', () => {
        const id = Number(input.dataset.id);
        const anchor = state.anchors.find((a) => a.id === id);
        const raw = input.value.trim();
        anchor[input.dataset.side] = raw === '' ? null : parseFloat(raw);
        recompute();
        renderDownstream();
        scheduleSaveDraft();
      });
    });
  }

  function populateTenorSelect(sel) {
    sel.innerHTML = TENORS.map((t) => `<option value="${t}">${LABELS[t]}</option>`).join('');
  }

  /* Generic Tab/Enter/Arrow navigation shared by the interval & anchor grids. */
  function attachGridKeyboardNav(bodySelector, inputSelector) {
    const inputs = Array.from(document.querySelectorAll(`${bodySelector} ${inputSelector}`));
    inputs.forEach((input, idx) => {
      input.addEventListener('keydown', (e) => {
        const td = input.closest('td');
        const colIndex = Array.from(td.parentElement.children).indexOf(td);
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
          const targetInput = targetRow && targetRow.children[colIndex] && targetRow.children[colIndex].querySelector('input');
          if (targetInput) targetInput.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const targetRow = allRows[rowIndex - 1];
          const targetInput = targetRow && targetRow.children[colIndex] && targetRow.children[colIndex].querySelector('input');
          if (targetInput) targetInput.focus();
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
    const { payerSpot, receiverSpot } = state.solved;
    const connectedCount = TENORS.filter((t) => state.solved.curve[t].payerPremium !== null || state.solved.curve[t].receiverPremium !== null).length;

    if (payerSpot === null && receiverSpot === null) {
      el.className = 'solver-status warn';
      el.textContent = connectedCount > 1
        ? `${connectedCount} tenors linked by points, but no anchor yet — add one real outright rate to see actual levels.`
        : 'Add points for at least one interval, plus one real outright below to anchor it.';
      return;
    }
    el.className = 'solver-status ok';
    el.textContent = `Spot solved: Payer ${fmtNum(payerSpot)} / Receiver ${fmtNum(receiverSpot)} · ${connectedCount} of ${TENORS.length} tenors linked`;
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
        <td class="mono val-bid">${fmtNum(c.payerOutright)}</td>
        <td class="mono val-offer">${fmtNum(c.receiverOutright)}</td>
        <td class="mono val-bid">${fmtSigned(c.payerPremium)}</td>
        <td class="mono val-offer">${fmtSigned(c.receiverPremium)}</td>
        <td class="mono val-muted">${fmtSigned(c.payerPremiumPerDay, 4)}</td>
        <td class="mono val-muted">${fmtSigned(c.receiverPremiumPerDay, 4)}</td>
        <td class="mono val-blue">${fmtSigned(c.payerAnnualized)}%</td>
        <td class="mono val-blue">${fmtSigned(c.receiverAnnualized)}%</td>
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
        <td class="mono val-bid">${fmtSigned(c.payerPremium)}</td>
        <td class="mono val-offer">${fmtSigned(c.receiverPremium)}</td>
        <td class="mono val-muted">${fmtSigned(c.spreadPremium)}</td>
        <td class="mono val-bid">${fmtNum(c.payerOutright)}</td>
        <td class="mono val-offer">${fmtNum(c.receiverOutright)}</td>
        <td class="mono val-muted">${fmtSigned(c.payerPremiumPerDay, 4)}</td>
        <td class="mono val-muted">${fmtSigned(c.receiverPremiumPerDay, 4)}</td>
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
    const payerOutright = state.solved.payerSpot !== null ? state.solved.payerSpot + result.payerPremium : null;
    const receiverOutright = state.solved.receiverSpot !== null ? state.solved.receiverSpot + result.receiverPremium : null;
    resultBox.innerHTML = `
      <table class="dealer"><tbody>
        <tr><td class="tenor-name">Days from Spot</td><td class="mono">${result.days}</td></tr>
        <tr><td class="tenor-name">Interpolated Payer Premium</td><td class="mono val-bid">${fmtSigned(result.payerPremium)}</td></tr>
        <tr><td class="tenor-name">Interpolated Receiver Premium</td><td class="mono val-offer">${fmtSigned(result.receiverPremium)}</td></tr>
        <tr><td class="tenor-name">Payer Outright</td><td class="mono val-bid">${fmtNum(payerOutright)}</td></tr>
        <tr><td class="tenor-name">Receiver Outright</td><td class="mono val-offer">${fmtNum(receiverOutright)}</td></tr>
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
        const spotPayer = snap.solved && snap.solved.payerSpot !== null ? fmtNum(snap.solved.payerSpot) : '—';
        return `<div class="history-row"><span class="mono">${d}</span><span>Spot Payer ${spotPayer}</span><button class="btn danger" data-del="${d}" style="padding:3px 8px;">Delete</button></div>`;
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
      const diff = (typeof ca.payerPremium === 'number' && typeof cb.payerPremium === 'number') ? cb.payerPremium - ca.payerPremium : null;
      return `<tr>
        <td class="tenor-name">${LABELS[t]}</td>
        <td class="mono val-bid">${fmtSigned(ca.payerPremium)}</td>
        <td class="mono val-bid">${fmtSigned(cb.payerPremium)}</td>
        <td class="mono val-blue">${diff === null ? '—' : fmtSigned(diff)}</td>
      </tr>`;
    }).join('');
    box.innerHTML = `<table class="dealer"><thead><tr><th>Tenor</th><th>${a} Payer Prem.</th><th>${b} Payer Prem.</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>`;
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
     Downstream render bundle (everything that depends on state.solved)
     ================================================================== */
  function renderDownstream() {
    renderQuoteScreen();
    renderSolverStatus();
    renderCurveTable();
    if (document.getElementById('view-broken').classList.contains('active')) renderBrokenDate();
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

    populateTenorSelect(document.getElementById('customFrom'));
    populateTenorSelect(document.getElementById('customTo'));
    document.getElementById('customTo').value = TENORS[1];

    document.getElementById('addCustomIntervalBtn').addEventListener('click', () => {
      const from = document.getElementById('customFrom').value;
      const to = document.getElementById('customTo').value;
      if (from === to) { alert('Pick two different value dates.'); return; }
      state.edges.push({ id: nextEdgeId++, from, to, payer: null, receiver: null });
      renderIntervalTable();
      scheduleSaveDraft();
    });

    populateTenorSelect(document.getElementById('newAnchorNode'));
    document.getElementById('newAnchorNode').value = 'cash';

    document.getElementById('addAnchorBtn').addEventListener('click', () => {
      const node = document.getElementById('newAnchorNode').value;
      state.anchors.push({ id: nextAnchorId++, node, payer: null, receiver: null });
      renderAnchorTable();
      scheduleSaveDraft();
    });

    document.getElementById('clearInputsBtn').addEventListener('click', () => {
      if (!confirm('Clear every input field?')) return;
      state.edges = makeDefaultEdges();
      state.anchors = makeDefaultAnchors();
      recompute();
      renderIntervalTable();
      renderAnchorTable();
      renderDownstream();
      scheduleSaveDraft();
    });

    document.getElementById('saveSnapshotBtn').addEventListener('click', () => {
      FXStorage.saveHistorySnapshot(todayKey(), {
        tradeDateKey: todayKey(),
        edges: JSON.parse(JSON.stringify(state.edges)),
        anchors: JSON.parse(JSON.stringify(state.anchors)),
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
        spotBid: fmtNum(state.solved.payerSpot),
        spotOffer: fmtNum(state.solved.receiverSpot),
      });
    });

    document.getElementById('applyPasteBtn').addEventListener('click', applyPasteAsAnchors);

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
      renderAllViews();
      renderHolidayList();
      alert(`Added ${val} as a bank holiday. Value dates recalculated.`);
    });
  }

  /** Excel import: expects columns Tenor, Payer (or Bid), Receiver (or Offer) — applied as anchors. */
  function applyImportedRows(rows) {
    let applied = 0;
    rows.forEach((row) => {
      const label = String(row.Tenor || row.tenor || '').toLowerCase();
      const key = TENORS.find((t) => LABELS[t].toLowerCase() === label || t.toLowerCase() === label);
      if (!key) return;
      const payer = parseFloat(row.Payer ?? row.payer ?? row.Bid ?? row.bid);
      const receiver = parseFloat(row.Receiver ?? row.receiver ?? row.Offer ?? row.offer);
      const existing = state.anchors.find((a) => a.node === key);
      const target = existing || { id: nextAnchorId++, node: key, payer: null, receiver: null };
      if (isFinite(payer)) target.payer = payer;
      if (isFinite(receiver)) target.receiver = receiver;
      if (!existing) state.anchors.push(target);
      applied++;
    });
    recompute();
    renderAnchorTable();
    renderDownstream();
    scheduleSaveDraft();
    alert(`Imported ${applied} tenor rows as anchors.`);
  }

  function applyPasteAsAnchors() {
    const text = document.getElementById('pasteBox').value;
    const parsed = FXExcel.parsePastedQuotes(text);
    parsed.forEach((row) => {
      const existing = state.anchors.find((a) => a.node === row.tenorKey);
      const target = existing || { id: nextAnchorId++, node: row.tenorKey, payer: null, receiver: null };
      if (row.bid !== null) target.payer = row.bid;
      if (row.offer !== null) target.receiver = row.offer;
      if (!existing) state.anchors.push(target);
    });
    recompute();
    renderAnchorTable();
    renderDownstream();
    scheduleSaveDraft();
    alert(`Applied ${parsed.length} pasted rows as anchors.`);
  }

  function renderAllViews() {
    renderHeader();
    renderLadder();
    renderDateDetail();
    renderIntervalTable();
    renderAnchorTable();
    renderDownstream();
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
    renderAllViews();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
