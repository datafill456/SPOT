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
    matches: [], // [{ from, to, side }] — typed rate agrees with typed premium
    mismatches: [], // [{ from, to, side, typedPremiumPts, actualDiffPts, offPts, suggestedFromRate, suggestedToRate }]
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

    // Match detection: a Premium Entry "confirms" against the board when
    // BOTH its endpoints also have a directly-typed Rate Entry (not a
    // derived value) and that typed difference agrees with the typed
    // premium, within a small rounding tolerance.
    const TOL = 0.0009; // ~0.09 points
    state.matches = [];
    state.mismatches = [];
    state.premiumEntries.forEach((pe) => {
      const prem = parsePremiumShorthand(pe.premium);
      const payerEdge = premiumToEdgeValue(pe.from, pe.to, prem.payer, pe.perDay);
      const receiverEdge = premiumToEdgeValue(pe.from, pe.to, prem.receiver, pe.perDay);
      const fromAnchor = anchors.find((a) => a.node === pe.from);
      const toAnchor = anchors.find((a) => a.node === pe.to);
      if (!fromAnchor || !toAnchor) return;

      const fromDate = state.valueDates.dates[pe.from];
      const toDate = state.valueDates.dates[pe.to];
      const days = FXCalendar.calendarDaysBetween(fromDate, toDate);
      // If Per Day is ticked, "the premium" the dealer typed is points-PER-DAY,
      // not the flat total — suggestions must be converted back to that same
      // per-day unit, not left as the day-scaled total used internally.
      const toDisplayUnit = (totalPts) => (pe.perDay && days !== 0 ? totalPts / days : totalPts);
      const unitLabel = pe.perDay ? 'p/day' : 'p';

      if (isNum(fromAnchor.bid) && isNum(toAnchor.bid) && isNum(payerEdge)) {
        const actualTotalPts = (toAnchor.bid - fromAnchor.bid) * 100;
        const typedDisplayPts = prem.payer; // as literally typed, already in the right unit
        const actualDisplayPts = toDisplayUnit(actualTotalPts);
        const offPts = actualDisplayPts - typedDisplayPts;
        if (Math.abs((toAnchor.bid - fromAnchor.bid) - payerEdge) < TOL) {
          state.matches.push({ from: pe.from, to: pe.to, side: 'payer' });
        } else {
          state.mismatches.push({
            from: pe.from, to: pe.to, side: 'payer', unitLabel,
            typedDisplayPts, actualDisplayPts, offPts,
            suggestedFromRate: toAnchor.bid - payerEdge,
            suggestedToRate: fromAnchor.bid + payerEdge,
          });
        }
      }
      if (isNum(fromAnchor.offer) && isNum(toAnchor.offer) && isNum(receiverEdge)) {
        const actualTotalPts = (toAnchor.offer - fromAnchor.offer) * 100;
        const typedDisplayPts = prem.receiver;
        const actualDisplayPts = toDisplayUnit(actualTotalPts);
        const offPts = actualDisplayPts - typedDisplayPts;
        if (Math.abs((toAnchor.offer - fromAnchor.offer) - receiverEdge) < TOL) {
          state.matches.push({ from: pe.from, to: pe.to, side: 'receiver' });
        } else {
          state.mismatches.push({
            from: pe.from, to: pe.to, side: 'receiver', unitLabel,
            typedDisplayPts, actualDisplayPts, offPts,
            suggestedFromRate: toAnchor.offer - receiverEdge,
            suggestedToRate: fromAnchor.offer + receiverEdge,
          });
        }
      }
    });
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
        <td><input type="text" class="cell-input shorthand" data-id="${re.id}" placeholder="30/40 or 75/ or /75"></td>
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
  /**
   * Builds the ladder-and-bracket view: one row per tenor, Payer's single
   * dealing rate (bid-anchored chain) on the left, Receiver's (offer-
   * anchored chain) on the right, a small "premium from Spot" figure
   * under each rate, a Diff column in the middle showing the Receiver-
   * minus-Payer spread at that tenor, and a bracket rail on the inner
   * edge of each column with a premium label between EVERY consecutive
   * tenor pair (Cash-Tom, Tom-Spot, Spot-1W, 1W-2W, 2W-1M, 1M-2M, 2M-3M,
   * 3M-6M, 6M-12M) — drawn always, showing "—" wherever either side of
   * that pair isn't solved yet.
   */
  function fmtPremiumPts(v) {
    if (!isNum(v)) return '';
    const pts = v * 100;
    return (pts >= 0 ? '+' : '') + fmtTrim(pts) + 'p from Spot';
  }
  function fmtDiffPts(payerRate, receiverRate) {
    if (!isNum(payerRate) || !isNum(receiverRate)) return '—';
    const pts = (receiverRate - payerRate) * 100;
    return (pts >= 0 ? '+' : '') + fmtTrim(pts);
  }

  function buildLadderSVG(curve, matches, mismatches) {
    const n = TENORS.length;
    const rowH = 34;
    const slot = 44;
    const topPad = 26;
    const height = topPad + n * slot + 14;

    const colW = 210;
    const payerX = 4;
    const payerRailX = payerX + colW + 26;
    const receiverX = 616 - colW;
    const receiverRailX = receiverX - 26;
    const diffX = (payerRailX + receiverRailX) / 2;
    const matchPayerX = payerRailX + 18;
    const matchReceiverX = receiverRailX - 18;

    const rowY = (i) => topPad + i * slot;
    const rowCenterY = (i) => rowY(i) + rowH / 2;

    let svg = `<svg class="ladder-svg" viewBox="0 0 620 ${height}" width="100%" role="img" aria-label="Payer and Receiver rate ladder with premium brackets and spread">`;
    svg += `<text x="${payerX}" y="14" class="ladder-heading">Payer</text>`;
    svg += `<text x="${diffX}" y="14" text-anchor="middle" class="ladder-heading">Diff</text>`;
    svg += `<text x="${receiverX + colW}" y="14" text-anchor="end" class="ladder-heading">Receiver</text>`;

    TENORS.forEach((t, i) => {
      const c = curve[t];
      const y = rowY(i);
      const cy = rowCenterY(i);
      const valY = y + 14;
      const premY = y + 27;
      const payerVal = fmtRatePairParts(c.payerBid, null)[0];
      const receiverVal = fmtRatePairParts(null, c.receiverOffer)[1];
      const payerPremLabel = fmtPremiumPts(c.payerPremium);
      const receiverPremLabel = fmtPremiumPts(c.receiverPremium);
      const diffLabel = fmtDiffPts(c.payerBid, c.receiverOffer);
      const spotClass = t === 'spot' ? ' ladder-row-spot' : '';
      svg += `
        <rect x="${payerX}" y="${y}" width="${colW}" height="${rowH}" rx="3" class="ladder-row${spotClass}"></rect>
        <text x="${payerX + 8}" y="${cy}" dominant-baseline="central" class="ladder-tenor">${c.label}</text>
        <text x="${payerX + colW - 8}" y="${valY}" text-anchor="end" dominant-baseline="central" class="ladder-val val-bid">${payerVal}</text>
        <text x="${payerX + colW - 8}" y="${premY}" text-anchor="end" dominant-baseline="central" class="ladder-premium-inline">${payerPremLabel}</text>

        <text x="${diffX}" y="${cy}" text-anchor="middle" dominant-baseline="central" class="ladder-diff">${diffLabel}</text>

        <rect x="${receiverX}" y="${y}" width="${colW}" height="${rowH}" rx="3" class="ladder-row${spotClass}"></rect>
        <text x="${receiverX + 8}" y="${cy}" dominant-baseline="central" class="ladder-tenor">${c.label}</text>
        <text x="${receiverX + colW - 8}" y="${valY}" text-anchor="end" dominant-baseline="central" class="ladder-val val-offer">${receiverVal}</text>
        <text x="${receiverX + colW - 8}" y="${premY}" text-anchor="end" dominant-baseline="central" class="ladder-premium-inline">${receiverPremLabel}</text>

        <line x1="${payerX + colW}" y1="${cy}" x2="${payerRailX}" y2="${cy}" class="ladder-tick"></line>
        <line x1="${receiverRailX}" y1="${cy}" x2="${receiverX}" y2="${cy}" class="ladder-tick"></line>
      `;
    });

    svg += `<line x1="${payerRailX}" y1="${rowCenterY(0)}" x2="${payerRailX}" y2="${rowCenterY(n - 1)}" class="ladder-rail"></line>`;
    svg += `<line x1="${receiverRailX}" y1="${rowCenterY(0)}" x2="${receiverRailX}" y2="${rowCenterY(n - 1)}" class="ladder-rail"></line>`;

    for (let i = 0; i < n - 1; i++) {
      const a = curve[TENORS[i]];
      const b = curve[TENORS[i + 1]];
      const midY = (rowCenterY(i) + rowCenterY(i + 1)) / 2;
      const payerPrem = isNum(a.payerBid) && isNum(b.payerBid) ? fmtTrim((b.payerBid - a.payerBid) * 100) : '—';
      const receiverPrem = isNum(a.receiverOffer) && isNum(b.receiverOffer) ? fmtTrim((b.receiverOffer - a.receiverOffer) * 100) : '—';
      svg += `<text x="${payerRailX + 6}" y="${midY}" dominant-baseline="central" class="ladder-premium">${payerPrem}</text>`;
      svg += `<text x="${receiverRailX - 6}" y="${midY}" text-anchor="end" dominant-baseline="central" class="ladder-premium">${receiverPrem}</text>`;
    }

    // A straight line for an adjacent pair reads fine sitting on the rail.
    // But a pair that SKIPS a tenor (Cash->Spot skipping Tom, 1W->1M
    // skipping 2W) drawn as the same straight line looks like it's just
    // running past the skipped row rather than jumping over it — so those
    // get an outward-bulging curve instead, making the skip obvious.
    function matchPath(fromIdx, toIdx, side) {
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      const y1 = rowCenterY(lo);
      const y2 = rowCenterY(hi);
      const x = side === 'payer' ? matchPayerX : matchReceiverX;
      const skips = hi - lo > 1;
      if (!skips) {
        return { d: `M ${x} ${y1} L ${x} ${y2}`, labelX: x, labelY: (y1 + y2) / 2 };
      }
      const bulge = side === 'payer' ? 22 : -22;
      const cx = x + bulge;
      const midY = (y1 + y2) / 2;
      return {
        d: `M ${x} ${y1} Q ${cx} ${midY} ${x} ${y2}`,
        labelX: cx, labelY: midY,
      };
    }

    (matches || []).forEach((m) => {
      const fromIdx = TENORS.indexOf(m.from);
      const toIdx = TENORS.indexOf(m.to);
      if (fromIdx === -1 || toIdx === -1) return;
      const anchor = m.side === 'payer' ? 'start' : 'end';
      const p = matchPath(fromIdx, toIdx, m.side);
      const labelX = m.side === 'payer' ? p.labelX + 6 : p.labelX - 6;
      svg += `<path d="${p.d}" fill="none" class="ladder-match-line ladder-match-${m.side}"></path>`;
      svg += `<text x="${labelX}" y="${p.labelY}" text-anchor="${anchor}" dominant-baseline="central" class="ladder-match-label">✓</text>`;
    });

    (mismatches || []).forEach((m) => {
      const fromIdx = TENORS.indexOf(m.from);
      const toIdx = TENORS.indexOf(m.to);
      if (fromIdx === -1 || toIdx === -1) return;
      const anchor = m.side === 'payer' ? 'start' : 'end';
      const p = matchPath(fromIdx, toIdx, m.side);
      const labelX = m.side === 'payer' ? p.labelX + 6 : p.labelX - 6;
      svg += `<path d="${p.d}" fill="none" class="ladder-mismatch-line ladder-mismatch-${m.side}"></path>`;
      svg += `<text x="${labelX}" y="${p.labelY}" text-anchor="${anchor}" dominant-baseline="central" class="ladder-mismatch-label">⚠</text>`;
    });

    svg += `</svg>`;
    return svg;
  }

  function renderQuoteScreen() {
    const wrap = document.getElementById('quoteLadderWrap');
    wrap.innerHTML = buildLadderSVG(state.solved.curve, state.matches, state.mismatches);
    renderMatchBanner();
    renderMismatchBanner();
  }

  function renderMatchBanner() {
    const el = document.getElementById('matchBanner');
    if (!el) return;
    if (!state.matches.length) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    el.innerHTML = state.matches.map((m) => `
      <div class="match-line match-${m.side}">
        ✓ ${LABELS[m.from]} → ${LABELS[m.to]} <strong>${m.side === 'payer' ? 'Payer' : 'Receiver'}</strong>
        premium matches your quoted rates exactly.
      </div>
    `).join('');
  }

  function renderMismatchBanner() {
    const el = document.getElementById('mismatchBanner');
    if (!el) return;
    if (!state.mismatches.length) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    el.innerHTML = state.mismatches.map((m) => {
      const sideLabel = m.side === 'payer' ? 'Payer' : 'Receiver';
      const priceKind = m.side === 'payer' ? 'bid' : 'offer';
      return `
      <div class="match-line mismatch-${m.side}">
        ⚠ ${LABELS[m.from]} → ${LABELS[m.to]} <strong>${sideLabel}</strong>:
        your rates imply ${fmtSigned(m.actualDisplayPts)}${m.unitLabel} but the premium is typed as ${fmtSigned(m.typedDisplayPts)}${m.unitLabel}
        (off by ${fmtSigned(m.offPts)}${m.unitLabel}). To fix it, do ONE of:
        set the premium to <strong>${fmtTrim(m.actualDisplayPts)}</strong>,
        or set ${LABELS[m.to]} ${priceKind} to <strong>${fmtNum(m.suggestedToRate)}</strong>,
        or set ${LABELS[m.from]} ${priceKind} to <strong>${fmtNum(m.suggestedFromRate)}</strong>.
      </div>`;
    }).join('');
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
