/* ============================================================
   script.js
   Wires calendar.js / calculator.js / storage.js / excel.js
   together for the Dealer Quotes screen.

   INPUT MODEL — two fully flexible, addable/removable lists:
     - Rate Entries:    { node, rate }         a plain Bid/Offer rate
                                                for one value date
     - Premium Entries: { from, to, premium,   Payer/Receiver points
                          perDay }             between any two dates

   Every Rate Entry feeds the solver as an ANCHOR (bid + offer).
   Every Premium Entry feeds it as an EDGE (Payer points + Receiver
   points) between the two chosen dates, always applied going
   chronologically forward: rate(later) = rate(earlier) + premium.
   This is why Cash naturally comes out as a discount to Spot without
   any special-casing — Cash is simply earlier, so solving backward
   from Spot subtracts the same premium that was added going forward.

   "Per Day" (available on any Premium Entry) treats the typed number
   as points-per-day, multiplied by the actual calendar days between
   the two chosen dates, before being added going forward in time.

   IMPLIED PREMIUMS: whenever 2+ Rate Entries exist, the Payer/Receiver
   premium between every pair is recognized automatically (Payer from
   the Bid sides, Receiver from the Offer sides) and shown read-only.

   PAYER / RECEIVER = Sell-now/Buy-forward vs Buy-now/Sell-forward
   (standard FX swap terminology) — Payer pays the premium, Receiver
   receives it. Rate = plain Bid/Offer, not tied to Payer/Receiver.
   ============================================================ */

(function () {
  const TENORS = FXCalculator.TENOR_ORDER;
  const LABELS = FXCalculator.TENOR_LABELS;
  const NEAR_DATES = ['cash', 'tom'];

  const state = {
    tradeDate: new Date(),
    pair: 'USD/LKR',
    bigFigure: '',
    rateEntries: [],     // [{ id, node, rate: '30/40' }]
    premiumEntries: [],  // [{ id, from, to, premium: '5/5.5', perDay: bool }]
    valueDates: null,
    solved: null,
    impliedPremiums: [],
  };

  let nextRateId = 1;
  let nextPremiumId = 1;

  function todayKey() {
    return FXCalendar.fmt(state.tradeDate);
  }

  function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }

  /* ---------------- Shorthand parsing ---------------- */

  /** "30/40" + bigFigure "336" -> {bid:336.30, offer:336.40}, with big-figure rollover
   *  ("30/10" with BF 336 -> 336.30/337.10, since offer's points < bid's points). */
  function parseRateShorthand(str, bigFigureStr) {
    const empty = { bid: null, offer: null };
    if (!str || !str.trim()) return empty;
    const bf = parseFloat(bigFigureStr);
    const hasBF = isFinite(bf);

    const resolveSingle = (p) => {
      const v = parseFloat(p);
      if (!isFinite(v)) return null;
      if (hasBF && Math.abs(v) < 100) return bf + v / 100;
      return v;
    };

    const parts = str.split('/').map((s) => s.trim());
    if (parts.length === 1) { const v = resolveSingle(parts[0]); return { bid: v, offer: v }; }

    const bidRaw = parseFloat(parts[0]);
    const offerRaw = parseFloat(parts[1]);
    if (!isFinite(bidRaw) || !isFinite(offerRaw)) {
      return { bid: resolveSingle(parts[0]), offer: resolveSingle(parts[1]) };
    }

    if (hasBF && Math.abs(bidRaw) < 100 && Math.abs(offerRaw) < 100) {
      const bid = bf + bidRaw / 100;
      const offerBigFigure = offerRaw < bidRaw ? bf + 1 : bf;
      const offer = offerBigFigure + offerRaw / 100;
      return { bid, offer };
    }
    return { bid: bidRaw, offer: offerRaw };
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

  /** Turns a typed premium value into the graph edge value (from -> to), always chronologically additive. */
  function premiumToEdgeValue(fromNode, toNode, rawVal, perDay) {
    if (rawVal === null) return null;
    const scaled = rawVal / 100; // premium is always points, e.g. 5 -> 0.05
    if (!perDay) return scaled;
    const fromDate = state.valueDates.dates[fromNode];
    const toDate = state.valueDates.dates[toNode];
    const days = FXCalendar.calendarDaysBetween(fromDate, toDate);
    return scaled * days;
  }

  /* ---------------- Solve ---------------- */
  function recompute() {
    state.valueDates = FXCalculator.buildValueDates(state.tradeDate);

    const edges = [];
    state.premiumEntries.forEach((pe) => {
      const prem = parsePremiumShorthand(pe.premium);
      const payerEdge = premiumToEdgeValue(pe.from, pe.to, prem.payer, pe.perDay);
      const receiverEdge = premiumToEdgeValue(pe.from, pe.to, prem.receiver, pe.perDay);
      if (payerEdge !== null || receiverEdge !== null) {
        edges.push({ from: pe.from, to: pe.to, payer: payerEdge, receiver: receiverEdge });
      }
    });

    const anchors = [];
    state.rateEntries.forEach((re) => {
      const r = parseRateShorthand(re.rate, state.bigFigure);
      if (r.bid !== null || r.offer !== null) {
        anchors.push({ node: re.node, bid: r.bid, offer: r.offer });
      }
    });

    state.solved = FXCalculator.solveMarket(edges, anchors, state.valueDates);
    state.impliedPremiums = FXCalculator.computeImpliedPremiums(anchors);
  }

  /* ---------------- Draft persistence ---------------- */
  function loadDraft() {
    const draft = FXStorage.loadDraft();
    if (draft && draft.tradeDateKey === todayKey() && draft.rateEntries) {
      state.rateEntries = draft.rateEntries;
      state.premiumEntries = draft.premiumEntries || [];
      state.bigFigure = draft.bigFigure || '';
      nextRateId = Math.max(1, ...state.rateEntries.map((e) => e.id + 1), 1);
      nextPremiumId = Math.max(1, ...state.premiumEntries.map((e) => e.id + 1), 1);
    } else {
      state.rateEntries = [];
      state.premiumEntries = [];
    }
  }

  let saveTimer = null;
  function scheduleSaveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      FXStorage.saveDraft({
        tradeDateKey: todayKey(),
        rateEntries: state.rateEntries,
        premiumEntries: state.premiumEntries,
        bigFigure: state.bigFigure,
        pair: state.pair,
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
  function fmtTrim(v, dp = 2) {
    return parseFloat(v.toFixed(dp)).toString();
  }
  function fmtDateLabel(d) {
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
  }

  /** [bid, offer] -> ["20","40"] shorthand within the shared Big Figure's hundred, else full rate. */
  function fmtRatePairParts(bid, offer) {
    const bf = parseFloat(state.bigFigure);
    const hasBF = isFinite(bf);
    const short = (v) => {
      if (v === null) return '—';
      if (hasBF) {
        const points = (v - bf) * 100;
        if (points >= 0 && points < 100) return fmtTrim(points);
      }
      return fmtNum(v);
    };
    return [short(bid), short(offer)];
  }

  function renderHeader() {
    document.getElementById('tradeDateDisplay').textContent = fmtDateLabel(state.tradeDate);
  }

  function populateTenorSelect(sel) {
    sel.innerHTML = TENORS.map((t) => `<option value="${t}">${LABELS[t]}</option>`).join('');
  }

  /* ==================================================================
     RENDER: Rate Entries (flexible list)
     ================================================================== */
  function renderRateTable() {
    const tbody = document.getElementById('rateTableBody');
    tbody.innerHTML = '';
    state.rateEntries.forEach((re) => {
      const date = state.valueDates.dates[re.node];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="tenor-name">${LABELS[re.node]}</span><span class="tenor-date">${fmtDateLabel(date)}</span></td>
        <td><input type="text" class="cell-input shorthand" data-id="${re.id}" placeholder="e.g. 30/40"></td>
        <td><button class="btn danger" data-remove-rate="${re.id}" style="padding:3px 8px;">✕</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('input').forEach((input) => {
      const id = Number(input.dataset.id);
      const entry = state.rateEntries.find((e) => e.id === id);
      input.value = entry.rate;
      input.addEventListener('input', () => {
        entry.rate = input.value;
        recompute();
        renderDownstream();
        scheduleSaveDraft();
      });
      input.addEventListener('keydown', (e) => handleEnterToNext(e, '#rateTableBody input[type="text"]'));
    });

    tbody.querySelectorAll('[data-remove-rate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.rateEntries = state.rateEntries.filter((e) => e.id !== Number(btn.dataset.removeRate));
        recompute();
        renderRateTable();
        renderDownstream();
        scheduleSaveDraft();
      });
    });
  }

  /* ==================================================================
     RENDER: Premium Entries (flexible list)
     ================================================================== */
  function renderPremiumTable() {
    const tbody = document.getElementById('premiumTableBody');
    tbody.innerHTML = '';
    state.premiumEntries.forEach((pe) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="tenor-name">${LABELS[pe.from]}</td>
        <td class="tenor-name">${LABELS[pe.to]}</td>
        <td><input type="text" class="cell-input shorthand" data-id="${pe.id}" data-kind="premium" placeholder="e.g. 5/5.5"></td>
        <td><input type="checkbox" data-id="${pe.id}" data-kind="perday"></td>
        <td><button class="btn danger" data-remove-premium="${pe.id}" style="padding:3px 8px;">✕</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('input[type="text"]').forEach((input) => {
      const id = Number(input.dataset.id);
      const entry = state.premiumEntries.find((e) => e.id === id);
      input.value = entry.premium;
      input.addEventListener('input', () => {
        entry.premium = input.value;
        recompute();
        renderDownstream();
        scheduleSaveDraft();
      });
      input.addEventListener('keydown', (e) => handleEnterToNext(e, '#premiumTableBody input[type="text"]'));
    });

    tbody.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      const id = Number(input.dataset.id);
      const entry = state.premiumEntries.find((e) => e.id === id);
      input.checked = !!entry.perDay;
      input.addEventListener('change', () => {
        entry.perDay = input.checked;
        recompute();
        renderDownstream();
        scheduleSaveDraft();
      });
    });

    tbody.querySelectorAll('[data-remove-premium]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.premiumEntries = state.premiumEntries.filter((e) => e.id !== Number(btn.dataset.removePremium));
        recompute();
        renderPremiumTable();
        renderDownstream();
        scheduleSaveDraft();
      });
    });
  }

  function handleEnterToNext(e, selector) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = Array.from(document.querySelectorAll(selector));
    const idx = inputs.indexOf(e.target);
    const next = inputs[idx + 1];
    if (next) next.focus();
  }

  /* ==================================================================
     RENDER: solver status banner
     ================================================================== */
  function renderSolverStatus() {
    const el = document.getElementById('solverStatus');
    const { payerSpotBid, payerSpotOffer, receiverSpotBid, receiverSpotOffer } = state.solved;
    const anySpot = payerSpotBid !== null || payerSpotOffer !== null || receiverSpotBid !== null || receiverSpotOffer !== null;
    const connectedCount = TENORS.filter((t) => state.solved.curve[t].payerPremium !== null || state.solved.curve[t].receiverPremium !== null).length;

    if (!anySpot) {
      el.className = 'solver-status warn';
      el.textContent = connectedCount > 1
        ? `${connectedCount} tenors linked by points, but no anchor yet — add a Rate for Spot (or any linked tenor) to see actual levels.`
        : 'Add a Rate for at least one value date, then a Premium between any two, and the rest chains off it.';
      return;
    }
    el.className = 'solver-status ok';
    el.textContent = `Spot solved — Payer ${fmtNum(payerSpotBid)}/${fmtNum(payerSpotOffer)} · Receiver ${fmtNum(receiverSpotBid)}/${fmtNum(receiverSpotOffer)} · ${connectedCount} of ${TENORS.length} tenors linked`;
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

      // Payer only ever deals on the bid-anchored chain (sell near @ bid,
      // buy back far @ bid + Payer premium). Receiver only ever deals on
      // the offer-anchored chain (buy near @ offer, sell back far @ offer
      // + Receiver premium). payerOffer/receiverBid are "cross" numbers
      // neither side actually trades on, so only one figure per side is
      // shown here, in the slot that matches which leg it came from.
      const payerRate = c.payerBid;
      const receiverRate = c.receiverOffer;
      const dealAgreed = isNum(payerRate) && isNum(receiverRate) && Math.abs(payerRate - receiverRate) < 1e-9;

      if (dealAgreed) {
        const single = fmtRatePairParts(payerRate, payerRate)[0];
        tr.innerHTML = `
          <td><span class="tenor-name">${c.label}</span><span class="tenor-date">${fmtDateLabel(c.date)}</span></td>
          <td class="mono" colspan="2"><span class="val-bid">${single}</span> <span class="hint">(deal)</span></td>
        `;
      } else {
        const payerShort = fmtRatePairParts(payerRate, null)[0];
        const receiverShort = fmtRatePairParts(null, receiverRate)[1];
        tr.innerHTML = `
          <td><span class="tenor-name">${c.label}</span><span class="tenor-date">${fmtDateLabel(c.date)}</span></td>
          <td class="mono"><span class="val-bid">${payerShort}</span>/<span class="val-offer">—</span></td>
          <td class="mono"><span class="val-bid">—</span>/<span class="val-offer">${receiverShort}</span></td>
        `;
      }
      tbody.appendChild(tr);
    });
  }

  /* ==================================================================
     RENDER: Implied Premiums (from 2+ direct rates)
     ================================================================== */
  function renderImpliedPremiums() {
    const card = document.getElementById('impliedCard');
    const tbody = document.getElementById('impliedTableBody');
    if (!state.impliedPremiums.length) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    tbody.innerHTML = state.impliedPremiums.map((ip) => `
      <tr>
        <td class="tenor-name">${LABELS[ip.from]} → ${LABELS[ip.to]}</td>
        <td class="mono val-bid">${fmtSigned(ip.payerPremium)}</td>
        <td class="mono val-offer">${fmtSigned(ip.receiverPremium)}</td>
      </tr>
    `).join('');
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
    renderImpliedPremiums();
  }

  /* ==================================================================
     Wire up static controls
     ================================================================== */
  function wireStaticControls() {
    document.getElementById('themeToggle').addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    document.getElementById('bigFigureInput').addEventListener('input', (e) => {
      state.bigFigure = e.target.value;
      recompute();
      renderRateTable();
      renderDownstream();
      scheduleSaveDraft();
    });

    populateTenorSelect(document.getElementById('newRateNode'));
    document.getElementById('newRateNode').value = 'spot';
    document.getElementById('addRateBtn').addEventListener('click', () => {
      const node = document.getElementById('newRateNode').value;
      state.rateEntries.push({ id: nextRateId++, node, rate: '' });
      renderRateTable();
      scheduleSaveDraft();
      const inputs = document.querySelectorAll('#rateTableBody input[type="text"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });

    populateTenorSelect(document.getElementById('newPremiumFrom'));
    populateTenorSelect(document.getElementById('newPremiumTo'));
    document.getElementById('newPremiumFrom').value = 'cash';
    document.getElementById('newPremiumTo').value = 'spot';
    document.getElementById('addPremiumBtn').addEventListener('click', () => {
      const from = document.getElementById('newPremiumFrom').value;
      const to = document.getElementById('newPremiumTo').value;
      if (from === to) { alert('Pick two different value dates.'); return; }
      state.premiumEntries.push({
        id: nextPremiumId++, from, to, premium: '',
        perDay: NEAR_DATES.includes(from) || NEAR_DATES.includes(to),
      });
      renderPremiumTable();
      scheduleSaveDraft();
      const inputs = document.querySelectorAll('#premiumTableBody input[type="text"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });

    document.getElementById('clearInputsBtn').addEventListener('click', () => {
      if (!confirm('Clear every input field?')) return;
      state.rateEntries = [];
      state.premiumEntries = [];
      state.bigFigure = '';
      document.getElementById('bigFigureInput').value = '';
      recompute();
      renderRateTable();
      renderPremiumTable();
      renderDownstream();
      scheduleSaveDraft();
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
        payerSpotBid: fmtNum(state.solved.payerSpotBid),
        payerSpotOffer: fmtNum(state.solved.payerSpotOffer),
        receiverSpotBid: fmtNum(state.solved.receiverSpotBid),
        receiverSpotOffer: fmtNum(state.solved.receiverSpotOffer),
      });
    });

    document.getElementById('applyPasteBtn').addEventListener('click', applyPasteAsRates);
  }

  /** Add-or-update a Rate Entry for a given tenor. */
  function upsertRateEntry(node, rateStr) {
    const existing = state.rateEntries.find((e) => e.node === node);
    if (existing) { existing.rate = rateStr; }
    else { state.rateEntries.push({ id: nextRateId++, node, rate: rateStr }); }
  }

  /** Excel import: expects columns Tenor, Bid (or Payer), Offer (or Receiver) — added/updated as Rate Entries. */
  function applyImportedRows(rows) {
    let applied = 0;
    rows.forEach((row) => {
      const label = String(row.Tenor || row.tenor || '').toLowerCase();
      const key = TENORS.find((t) => LABELS[t].toLowerCase() === label || t.toLowerCase() === label);
      if (!key) return;
      const bid = parseFloat(row.Bid ?? row.bid ?? row.Payer ?? row.payer);
      const offer = parseFloat(row.Offer ?? row.offer ?? row.Receiver ?? row.receiver);
      if (isFinite(bid) && isFinite(offer)) { upsertRateEntry(key, `${bid}/${offer}`); applied++; }
    });
    recompute();
    renderRateTable();
    renderDownstream();
    scheduleSaveDraft();
    alert(`Imported ${applied} tenor rows into Rate Entries.`);
  }

  function applyPasteAsRates() {
    const text = document.getElementById('pasteBox').value;
    const parsed = FXExcel.parsePastedQuotes(text);
    parsed.forEach((row) => {
      if (row.bid !== null && row.offer !== null) upsertRateEntry(row.tenorKey, `${row.bid}/${row.offer}`);
    });
    recompute();
    renderRateTable();
    renderDownstream();
    scheduleSaveDraft();
    alert(`Applied ${parsed.length} pasted rows into Rate Entries.`);
  }

  function renderAllViews() {
    renderHeader();
    renderRateTable();
    renderPremiumTable();
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
    document.getElementById('bigFigureInput').value = state.bigFigure;

    wireStaticControls();
    renderAllViews();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
