/* ============================================================
   script.js
   Wires calendar.js / calculator.js / storage.js / excel.js /
   chart.js together into the running application.

   FAST ENTRY MODEL
   -----------------
   One row per standard tenor. Two shorthand boxes per row:
     - Rate      "30/40"  -> Big Figure + points -> payer/receiver outright
     - Premium   "5/5.5"  -> points vs Spot -> payer/receiver premium
   Cash & Tom carry a "Per Day" toggle: their premium is quoted PER DAY
   (in points, i.e. hundredths of a rate unit) and gets multiplied by
   the actual number of calendar days to Spot, then SUBTRACTED from
   Spot (near dates trade at a discount you subtract), e.g.:
     Spot 336.20/336.40, Cash premium 5/5.5 per day, 2 days to Spot
     -> Cash = 336.20 - 0.05*2 = 336.10 (payer), 336.40 - 0.055*2 = 336.29 (receiver)
   Forward tenors (1W...12M) add the premium to Spot directly, as
   typed (no day multiplication, no /100 scaling), matching how those
   are already quoted as whole points over the tenor.

   Every row's Rate feeds the solver as an ANCHOR; every row's
   Premium feeds it as an EDGE from Spot to that tenor. The solver
   itself (calculator.js) is the same general interval graph as
   before, so the "Advanced" panel can still add arbitrary extra
   intervals (e.g. 1M-2M) on top of this fast path.
   ============================================================ */

(function () {
  const TENORS = FXCalculator.TENOR_ORDER;
  const LABELS = FXCalculator.TENOR_LABELS;
  const NEAR_DATES = ['cash', 'tom'];

  const state = {
    tradeDate: new Date(),
    pair: 'USD/LKR',
    bigFigure: '',
    rows: {},          // tenor -> { rate: '', premium: '', perDay: bool }
    customEdges: [],   // [{ id, from, to, payer, receiver }] — Advanced panel only
    valueDates: null,
    solved: null,
  };

  let nextEdgeId = 1;

  function makeDefaultRows() {
    const rows = {};
    TENORS.forEach((t) => {
      rows[t] = { rate: '', premium: '', perDay: NEAR_DATES.includes(t) };
    });
    return rows;
  }

  function todayKey() {
    return FXCalendar.fmt(state.tradeDate);
  }

  /* ---------------- Shorthand parsing ---------------- */

  /** "30/40" + bigFigure "336" -> {payer:336.30, receiver:336.40}. Single value applies to both sides. "336.30/336.40" (no big figure) works too. */
  function parseRateShorthand(str, bigFigureStr) {
    const empty = { payer: null, receiver: null };
    if (!str || !str.trim()) return empty;
    const bf = parseFloat(bigFigureStr);
    const hasBF = isFinite(bf);
    const resolve = (p) => {
      const v = parseFloat(p);
      if (!isFinite(v)) return null;
      if (hasBF && Math.abs(v) < 100) return bf + v / 100;
      return v;
    };
    const parts = str.split('/').map((s) => s.trim());
    if (parts.length === 1) { const v = resolve(parts[0]); return { payer: v, receiver: v }; }
    return { payer: resolve(parts[0]), receiver: resolve(parts[1]) };
  }

  /** "5/5.5" -> {payer:5, receiver:5.5}, literal (no big-figure scaling). Single value applies to both sides. */
  function parsePremiumShorthand(str) {
    const empty = { payer: null, receiver: null };
    if (!str || !str.trim()) return empty;
    const parts = str.split('/').map((s) => s.trim());
    const resolve = (p) => { const v = parseFloat(p); return isFinite(v) ? v : null; };
    if (parts.length === 1) { const v = resolve(parts[0]); return { payer: v, receiver: v }; }
    return { payer: resolve(parts[0]), receiver: resolve(parts[1]) };
  }

  /** Turns a typed premium value into the graph edge value (Spot -> tenor). */
  function premiumToEdgeValue(t, val, days) {
    if (val === null) return null;
    const isNear = NEAR_DATES.includes(t);
    const perDay = isNear && state.rows[t].perDay;
    const scaled = perDay ? val / 100 : val;
    const mult = perDay ? Math.abs(days[t]) : 1;
    const sign = isNear ? -1 : 1;
    return sign * scaled * mult;
  }

  /* ---------------- Solve ---------------- */
  function recompute() {
    state.valueDates = FXCalculator.buildValueDates(state.tradeDate);
    const days = state.valueDates.days;

    const edges = [];
    const anchors = [];

    TENORS.forEach((t) => {
      const row = state.rows[t];

      const rate = parseRateShorthand(row.rate, state.bigFigure);
      if (rate.payer !== null || rate.receiver !== null) {
        anchors.push({ node: t, payer: rate.payer, receiver: rate.receiver });
      }

      if (t !== 'spot') {
        const prem = parsePremiumShorthand(row.premium);
        const payerEdge = premiumToEdgeValue(t, prem.payer, days);
        const receiverEdge = premiumToEdgeValue(t, prem.receiver, days);
        if (payerEdge !== null || receiverEdge !== null) {
          edges.push({ from: 'spot', to: t, payer: payerEdge, receiver: receiverEdge });
        }
      }
    });

    state.customEdges.forEach((e) => {
      if (e.payer !== null || e.receiver !== null) edges.push(e);
    });

    state.solved = FXCalculator.solveMarket(edges, anchors, state.valueDates);
  }

  /* ---------------- Draft persistence ---------------- */
  function loadDraft() {
    const draft = FXStorage.loadDraft();
    if (draft && draft.tradeDateKey === todayKey() && draft.rows) {
      state.rows = draft.rows;
      state.bigFigure = draft.bigFigure || '';
      state.customEdges = draft.customEdges || [];
      state.pair = draft.pair || state.pair;
      nextEdgeId = Math.max(1, ...state.customEdges.map((e) => e.id + 1), 1);
    } else {
      state.rows = makeDefaultRows();
      state.customEdges = [];
    }
  }

  let saveTimer = null;
  function scheduleSaveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      FXStorage.saveDraft({
        tradeDateKey: todayKey(), rows: state.rows, bigFigure: state.bigFigure,
        customEdges: state.customEdges, pair: state.pair,
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

  function renderHeader() {
    document.getElementById('tradeDateDisplay').textContent = fmtDateLabel(state.tradeDate);
  }

  /* ==================================================================
     RENDER: Fast Entry ladder
     ================================================================== */
  function renderLadderTable() {
    const tbody = document.getElementById('ladderTableBody');
    tbody.innerHTML = '';
    TENORS.forEach((t) => {
      const isNear = NEAR_DATES.includes(t);
      const date = state.valueDates.dates[t];
      const tr = document.createElement('tr');
      if (t === 'spot') tr.classList.add('row-spot');

      const premiumCell = t === 'spot'
        ? '<td class="val-muted mono">—</td>'
        : `<td><input type="text" class="cell-input shorthand" data-tenor="${t}" data-kind="premium" placeholder="e.g. 5/5.5"></td>`;
      const perDayCell = isNear
        ? `<td><input type="checkbox" data-tenor="${t}" data-kind="perday"></td>`
        : '<td class="val-muted small-text">—</td>';

      tr.innerHTML = `
        <td><span class="tenor-name">${LABELS[t]}</span><span class="tenor-date">${fmtDateLabel(date)}</span></td>
        <td><input type="text" class="cell-input shorthand" data-tenor="${t}" data-kind="rate" placeholder="e.g. 30/40"></td>
        ${premiumCell}
        ${perDayCell}
      `;
      tbody.appendChild(tr);
    });

    // populate typed values + checkboxes
    TENORS.forEach((t) => {
      const row = state.rows[t];
      const rateInput = tbody.querySelector(`input[data-tenor="${t}"][data-kind="rate"]`);
      if (rateInput) rateInput.value = row.rate;
      const premInput = tbody.querySelector(`input[data-tenor="${t}"][data-kind="premium"]`);
      if (premInput) premInput.value = row.premium;
      const perDayInput = tbody.querySelector(`input[data-tenor="${t}"][data-kind="perday"]`);
      if (perDayInput) perDayInput.checked = !!row.perDay;
    });

    tbody.querySelectorAll('input[type="text"]').forEach((input) => {
      input.addEventListener('input', () => {
        const t = input.dataset.tenor;
        state.rows[t][input.dataset.kind] = input.value;
        recompute();
        renderDownstream();
        applyAutoFill();
        scheduleSaveDraft();
      });
    });
    tbody.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        const t = input.dataset.tenor;
        state.rows[t].perDay = input.checked;
        recompute();
        renderDownstream();
        applyAutoFill();
        scheduleSaveDraft();
      });
    });

    attachLadderKeyboardNav();
    applyAutoFill();
  }

  /** When a box is empty, show the solver's answer in it (muted) instead of leaving it blank. */
  function applyAutoFill() {
    TENORS.forEach((t) => {
      const c = state.solved.curve[t];
      const row = state.rows[t];

      const rateInput = document.querySelector(`#ladderTableBody input[data-tenor="${t}"][data-kind="rate"]`);
      if (rateInput && document.activeElement !== rateInput) {
        if (!row.rate.trim() && (c.payerOutright !== null || c.receiverOutright !== null)) {
          rateInput.value = `${fmtNum(c.payerOutright)} / ${fmtNum(c.receiverOutright)}`;
          rateInput.classList.add('auto-filled');
        } else if (!row.rate.trim()) {
          rateInput.value = '';
          rateInput.classList.remove('auto-filled');
        } else {
          rateInput.classList.remove('auto-filled');
        }
      }

      if (t === 'spot') return;
      const premInput = document.querySelector(`#ladderTableBody input[data-tenor="${t}"][data-kind="premium"]`);
      if (premInput && document.activeElement !== premInput) {
        if (!row.premium.trim() && (c.payerPremium !== null || c.receiverPremium !== null)) {
          premInput.value = `${fmtSigned(c.payerPremium)} / ${fmtSigned(c.receiverPremium)}`;
          premInput.classList.add('auto-filled');
        } else if (!row.premium.trim()) {
          premInput.value = '';
          premInput.classList.remove('auto-filled');
        } else {
          premInput.classList.remove('auto-filled');
        }
      }
    });
  }

  function attachLadderKeyboardNav() {
    const inputs = Array.from(document.querySelectorAll('#ladderTableBody input[type="text"]'));
    inputs.forEach((input, idx) => {
      input.addEventListener('focus', () => { input.classList.remove('auto-filled'); if (isAutoText(input)) input.value = ''; });
      input.addEventListener('blur', applyAutoFill);
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
          const targetInput = targetRow && targetRow.children[colIndex] && targetRow.children[colIndex].querySelector('input[type="text"]');
          if (targetInput) targetInput.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const targetRow = allRows[rowIndex - 1];
          const targetInput = targetRow && targetRow.children[colIndex] && targetRow.children[colIndex].querySelector('input[type="text"]');
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
  function isAutoText(input) { return input.classList.contains('auto-filled'); }

  /* ==================================================================
     RENDER: Advanced custom interval panel
     ================================================================== */
  function intervalLabel(e) { return `${LABELS[e.from]} → ${LABELS[e.to]}`; }

  function renderIntervalTable() {
    const tbody = document.getElementById('intervalTableBody');
    tbody.innerHTML = '';
    state.customEdges.forEach((e) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="tenor-name">${intervalLabel(e)}</span></td>
        <td><input type="number" step="any" class="cell-input bid-input" data-id="${e.id}" data-side="payer" placeholder="—"></td>
        <td><input type="number" step="any" class="cell-input offer-input" data-id="${e.id}" data-side="receiver" placeholder="—"></td>
        <td><button class="btn danger" data-remove-edge="${e.id}" style="padding:3px 8px;">✕</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('input').forEach((input) => {
      const id = Number(input.dataset.id);
      const edge = state.customEdges.find((e) => e.id === id);
      const v = edge[input.dataset.side];
      input.value = v === null || v === undefined ? '' : v;
      input.addEventListener('input', () => {
        edge[input.dataset.side] = input.value.trim() === '' ? null : parseFloat(input.value);
        recompute();
        renderDownstream();
        applyAutoFill();
        scheduleSaveDraft();
      });
    });

    tbody.querySelectorAll('[data-remove-edge]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.customEdges = state.customEdges.filter((e) => e.id !== Number(btn.dataset.removeEdge));
        recompute();
        renderIntervalTable();
        renderDownstream();
        applyAutoFill();
        scheduleSaveDraft();
      });
    });
  }

  function populateTenorSelect(sel) {
    sel.innerHTML = TENORS.map((t) => `<option value="${t}">${LABELS[t]}</option>`).join('');
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
        ? `${connectedCount} tenors linked by points, but no anchor yet — type Spot's Rate to see actual levels.`
        : 'Set a Big Figure, then type Spot\'s rate — everything else can chain off it.';
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

    document.getElementById('bigFigureInput').addEventListener('input', (e) => {
      state.bigFigure = e.target.value;
      recompute();
      renderDownstream();
      applyAutoFill();
      scheduleSaveDraft();
    });

    populateTenorSelect(document.getElementById('customFrom'));
    populateTenorSelect(document.getElementById('customTo'));
    document.getElementById('customTo').value = TENORS[1];

    document.getElementById('addCustomIntervalBtn').addEventListener('click', () => {
      const from = document.getElementById('customFrom').value;
      const to = document.getElementById('customTo').value;
      if (from === to) { alert('Pick two different value dates.'); return; }
      state.customEdges.push({ id: nextEdgeId++, from, to, payer: null, receiver: null });
      renderIntervalTable();
      scheduleSaveDraft();
    });

    document.getElementById('clearInputsBtn').addEventListener('click', () => {
      if (!confirm('Clear every input field?')) return;
      state.rows = makeDefaultRows();
      state.customEdges = [];
      state.bigFigure = '';
      document.getElementById('bigFigureInput').value = '';
      recompute();
      renderLadderTable();
      renderIntervalTable();
      renderDownstream();
      scheduleSaveDraft();
    });

    document.getElementById('saveSnapshotBtn').addEventListener('click', () => {
      FXStorage.saveHistorySnapshot(todayKey(), {
        tradeDateKey: todayKey(),
        rows: JSON.parse(JSON.stringify(state.rows)),
        bigFigure: state.bigFigure,
        customEdges: JSON.parse(JSON.stringify(state.customEdges)),
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
      FXExcel.importFromExcel(file, (rows) => applyImportedRows(rows));
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

    document.getElementById('applyPasteBtn').addEventListener('click', applyPasteAsRates);

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

  /** Excel import: expects columns Tenor, Payer (or Bid), Receiver (or Offer) — applied straight into the Rate boxes. */
  function applyImportedRows(rows) {
    let applied = 0;
    rows.forEach((row) => {
      const label = String(row.Tenor || row.tenor || '').toLowerCase();
      const key = TENORS.find((t) => LABELS[t].toLowerCase() === label || t.toLowerCase() === label);
      if (!key) return;
      const payer = parseFloat(row.Payer ?? row.payer ?? row.Bid ?? row.bid);
      const receiver = parseFloat(row.Receiver ?? row.receiver ?? row.Offer ?? row.offer);
      if (isFinite(payer) && isFinite(receiver)) state.rows[key].rate = `${payer}/${receiver}`;
      applied++;
    });
    recompute();
    renderLadderTable();
    renderDownstream();
    scheduleSaveDraft();
    alert(`Imported ${applied} tenor rows into Rate boxes.`);
  }

  function applyPasteAsRates() {
    const text = document.getElementById('pasteBox').value;
    const parsed = FXExcel.parsePastedQuotes(text);
    parsed.forEach((row) => {
      if (row.bid !== null && row.offer !== null) {
        state.rows[row.tenorKey].rate = `${row.bid}/${row.offer}`;
      }
    });
    recompute();
    renderLadderTable();
    renderDownstream();
    scheduleSaveDraft();
    alert(`Applied ${parsed.length} pasted rows into Rate boxes.`);
  }

  function renderAllViews() {
    renderHeader();
    renderLadder();
    renderDateDetail();
    renderLadderTable();
    renderIntervalTable();
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
    document.getElementById('bigFigureInput').value = state.bigFigure;

    wireStaticControls();
    renderAllViews();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
