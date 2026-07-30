/* ============================================================
   calculator.js
   Value-date generation + the "intelligent solver" that fills in
   every rate, premium and derived figure it can from whatever
   subset of fields the dealer has typed in.

   MODEL — points between ANY two value dates, chained
   ----------------------------------------------------
   Real desks don't quote premium against a fixed date; they quote
   SWAP POINTS FOR AN INTERVAL: Cash-Tom, Tom-Spot, Cash-Spot,
   Spot-1M, 1M-2M, Cash-3M, and so on. Points are additive along the
   date axis (Cash-Spot + Spot-1M = Cash-1M exactly), so the whole
   set of quoted intervals forms a graph: nodes = value dates
   (cash, tom, spot, 1W...12M), edges = a quoted interval with a
   points value going from the earlier date to the later one.

   Each side is solved independently and is called PAYER / RECEIVER
   rather than bid/offer — the side that pays the premium (buys the
   forward) vs. the side that receives it (sells the forward).

   Solving:
     1. Build a graph from every interval the dealer has typed
        points for (either side).
     2. Walk each connected component with a breadth-first search
        to get every node's value RELATIVE to an arbitrary root of
        its component — this alone gives "premium from Spot" (or
        from Cash, or between any two tenors in the same component)
        even with zero absolute rates typed in anywhere.
     3. If the dealer has also typed an actual outright rate for
        ANY one node (an "anchor"), that whole connected component
        gets shifted from relative to absolute: outright(node) =
        anchor + (relative value of node - relative value of anchor).
     4. Nodes with no path back to an anchor stay blank for
        outright, but can still show a premium/points figure if
        they're connected to Spot in the relative graph.

   Broken dates (arbitrary custom value date) are interpolated
   piecewise-linearly between the two nearest SOLVED standard
   tenors' premium-from-spot, which is standard market practice.
   ============================================================ */

const FXCalculator = (function () {
  const TENOR_ORDER = ['cash', 'tom', 'spot', '1W', '2W', '1M', '2M', '3M', '6M', '12M'];
  const TENOR_LABELS = {
    cash: 'Cash', tom: 'Tom', spot: 'Spot',
    '1W': '1 Week', '2W': '2 Weeks', '1M': '1 Month', '2M': '2 Months',
    '3M': '3 Months', '6M': '6 Months', '12M': '12 Months',
  };

  /** Build the full value-date ladder from today's trade date. */
  function buildValueDates(tradeDate) {
    const cal = FXCalendar;
    const cash = cal.isWorkingDay(tradeDate) ? new Date(tradeDate) : cal.rollFollowing(tradeDate);
    const tom = cal.addWorkingDays(cash, 1);
    const spot = cal.addWorkingDays(cash, 2);

    const dates = { cash, tom, spot };
    dates['1W'] = cal.addTenorWeeks(spot, 1);
    dates['2W'] = cal.addTenorWeeks(spot, 2);
    dates['1M'] = cal.addTenorMonths(spot, 1);
    dates['2M'] = cal.addTenorMonths(spot, 2);
    dates['3M'] = cal.addTenorMonths(spot, 3);
    dates['6M'] = cal.addTenorMonths(spot, 6);
    dates['12M'] = cal.addTenorMonths(spot, 12);

    const days = {};
    TENOR_ORDER.forEach((t) => {
      days[t] = cal.calendarDaysBetween(spot, dates[t]); // negative for cash/tom
    });

    return { cash, tom, spot, dates, days };
  }

  /**
   * Curated default set of intervals a Colombo money-broking desk
   * actually quotes: near-date pairs (Cash-Tom, Tom-Spot, Cash-Spot),
   * the standard Spot-based ladder, forward-to-forward rolls, and a
   * couple of common Cash-based skips. Dealers can add any other
   * pair with the "custom interval" row in the UI.
   */
  const FORWARD_TENORS = ['1W', '2W', '1M', '2M', '3M', '6M', '12M'];
  const FORWARD_POINTS = ['spot', ...FORWARD_TENORS];
  const DEFAULT_INTERVALS = [
    ['cash', 'tom'],
    ...['cash', 'tom'].flatMap((near) => FORWARD_POINTS.map((f) => [near, f])),
    ...FORWARD_TENORS.map((f) => ['spot', f]),
    ['1M', '2M'], ['2M', '3M'], ['3M', '6M'], ['6M', '12M'],
  ];

  /**
   * Solve one side (payer or receiver) of the interval graph.
   * edgeList:   [{ from, to, value }]   value = points from -> to
   * anchorList: [{ node, value }]        value = actual outright rate
   * Returns: { relFromSpot: {node: number|null}, absolute: {node: number|null} }
   */
  function solveSideGraph(edgeList, anchorList) {
    const adj = {};
    TENOR_ORDER.forEach((n) => { adj[n] = []; });
    edgeList.forEach(({ from, to, value }) => {
      if (!isNum(value) || !adj[from] || !adj[to]) return;
      adj[from].push({ to, w: value });
      adj[to].push({ to: from, w: -value });
    });

    // BFS every node into connected components, tracking value relative
    // to an arbitrary root (the first node visited in that component).
    const visited = {};
    const relFromRoot = {};
    const componentOf = {};
    let compId = 0;

    TENOR_ORDER.forEach((start) => {
      if (visited[start]) return;
      compId += 1;
      visited[start] = true;
      relFromRoot[start] = 0;
      componentOf[start] = compId;
      const queue = [start];
      while (queue.length) {
        const node = queue.shift();
        adj[node].forEach(({ to, w }) => {
          if (!visited[to]) {
            visited[to] = true;
            relFromRoot[to] = relFromRoot[node] + w;
            componentOf[to] = compId;
            queue.push(to);
          }
        });
      }
    });

    // Relative-to-Spot: only meaningful for nodes in Spot's component.
    const spotComp = componentOf.spot;
    const relFromSpot = {};
    TENOR_ORDER.forEach((n) => {
      relFromSpot[n] = componentOf[n] === spotComp ? relFromRoot[n] - relFromRoot.spot : null;
    });

    // Absolute rates: shift each component that contains an anchor.
    const absolute = {};
    TENOR_ORDER.forEach((n) => { absolute[n] = null; });
    const anchorByComponent = {};
    anchorList.forEach(({ node, value }) => {
      if (!isNum(value) || !(node in componentOf)) return;
      const comp = componentOf[node];
      if (!(comp in anchorByComponent)) anchorByComponent[comp] = { node, value };
    });
    Object.keys(anchorByComponent).forEach((comp) => {
      const anchor = anchorByComponent[comp];
      const base = anchor.value - relFromRoot[anchor.node];
      TENOR_ORDER.forEach((n) => {
        if (componentOf[n] === Number(comp)) absolute[n] = base + relFromRoot[n];
      });
    });

    return { relFromSpot, absolute };
  }

  /**
   * Full market solve.
   * edges:   [{ from, to, payer: number|null, receiver: number|null }]  premium points, from -> to
   * anchors: [{ node, bid: number|null, offer: number|null }]           a real traded Bid/Offer rate
   *
   * Each premium (Payer, Receiver) is a flat shift applied to BOTH the
   * Bid and the Offer side of whatever rate anchor is available, e.g.
   * Spot 20/30, Cash-Spot Payer premium 5 -> Payer Rate = (20-5·days)/(30-5·days).
   * Receiver premium 5.5 -> Receiver Rate = (20-5.5·days)/(30-5.5·days).
   * So every tenor gets FOUR numbers: payerBid, payerOffer, receiverBid,
   * receiverOffer — the same relative premium chain, anchored twice.
   */
  function solveMarket(edges, anchors, valueDates) {
    const days = valueDates.days;

    const payerEdges = edges.map((e) => ({ from: e.from, to: e.to, value: e.payer }));
    const receiverEdges = edges.map((e) => ({ from: e.from, to: e.to, value: e.receiver }));
    const bidAnchors = anchors.map((a) => ({ node: a.node, value: a.bid }));
    const offerAnchors = anchors.map((a) => ({ node: a.node, value: a.offer }));

    const payerBidSolve = solveSideGraph(payerEdges, bidAnchors);
    const payerOfferSolve = solveSideGraph(payerEdges, offerAnchors);
    const receiverBidSolve = solveSideGraph(receiverEdges, bidAnchors);
    const receiverOfferSolve = solveSideGraph(receiverEdges, offerAnchors);

    const curve = {};
    TENOR_ORDER.forEach((t) => {
      const d = days[t];
      const payerPremium = payerBidSolve.relFromSpot[t];
      const receiverPremium = receiverBidSolve.relFromSpot[t];

      const payerBid = payerBidSolve.absolute[t];
      const payerOffer = payerOfferSolve.absolute[t];
      const receiverBid = receiverBidSolve.absolute[t];
      const receiverOffer = receiverOfferSolve.absolute[t];

      curve[t] = {
        label: TENOR_LABELS[t],
        date: valueDates.dates[t],
        daysFromSpot: d,
        payerBid,
        payerOffer,
        receiverBid,
        receiverOffer,
        payerPremium,
        receiverPremium,
        payerSpread: numOrNull(payerOffer, payerBid, (a, c) => a - c),
        receiverSpread: numOrNull(receiverOffer, receiverBid, (a, c) => a - c),
        payerPremiumPerDay: d !== 0 && isNum(payerPremium) ? payerPremium / d : (d === 0 ? 0 : null),
        receiverPremiumPerDay: d !== 0 && isNum(receiverPremium) ? receiverPremium / d : (d === 0 ? 0 : null),
      };
    });

    return {
      payerSpotBid: payerBidSolve.absolute.spot,
      payerSpotOffer: payerOfferSolve.absolute.spot,
      receiverSpotBid: receiverBidSolve.absolute.spot,
      receiverSpotOffer: receiverOfferSolve.absolute.spot,
      curve,
    };
  }

  /** Points between any two nodes, using whichever side's relative graph is connected. */
  function intervalPremium(edges, anchors, fromNode, toNode) {
    const payerEdges = edges.map((e) => ({ from: e.from, to: e.to, value: e.payer }));
    const receiverEdges = edges.map((e) => ({ from: e.from, to: e.to, value: e.receiver }));
    const payerSolve = solveSideGraph(payerEdges, []);
    const receiverSolve = solveSideGraph(receiverEdges, []);
    const p = numOrNull(payerSolve.relFromSpot[toNode], payerSolve.relFromSpot[fromNode], (a, c) => a - c);
    const r = numOrNull(receiverSolve.relFromSpot[toNode], receiverSolve.relFromSpot[fromNode], (a, c) => a - c);
    return { payer: p, receiver: r };
  }

  function annualize(premium, spot, days) {
    if (!isNum(premium) || !isNum(spot) || !days || spot === 0) return null;
    return (premium / spot) * (365 / days) * 100;
  }

  /** Piecewise-linear interpolation of premium for an arbitrary broken date. */
  function interpolateBrokenDate(solvedCurve, targetDate, spotDate) {
    const cal = FXCalendar;
    const targetDays = cal.calendarDaysBetween(spotDate, targetDate);

    const points = TENOR_ORDER
      .map((t) => solvedCurve[t])
      .filter((row) => isNum(row.payerPremium) && isNum(row.receiverPremium))
      .map((row) => ({ days: row.daysFromSpot, payer: row.payerPremium, receiver: row.receiverPremium }))
      .sort((a, b) => a.days - b.days);

    if (points.length < 2) return null;

    let lower = null, upper = null;
    for (let i = 0; i < points.length - 1; i++) {
      if (targetDays >= points[i].days && targetDays <= points[i + 1].days) {
        lower = points[i]; upper = points[i + 1]; break;
      }
    }
    if (!lower) {
      if (targetDays < points[0].days) { lower = points[0]; upper = points[1]; }
      else { lower = points[points.length - 2]; upper = points[points.length - 1]; }
    }

    const span = upper.days - lower.days || 1;
    const frac = (targetDays - lower.days) / span;
    const payerPremium = lower.payer + frac * (upper.payer - lower.payer);
    const receiverPremium = lower.receiver + frac * (upper.receiver - lower.receiver);
    return { days: targetDays, payerPremium, receiverPremium };
  }

  /**
   * Given directly-entered rate anchors [{node, bid, offer}], work out the
   * implied premium between every pair that both have a real rate — e.g.
   * if the dealer types both Spot and 1M rates directly (no premium
   * entered), this recognizes the Payer premium (from the Bid sides) and
   * Receiver premium (from the Offer sides) between them.
   */
  function computeImpliedPremiums(anchors) {
    const valid = anchors.filter((a) => isNum(a.bid) && isNum(a.offer));
    const results = [];
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const a = valid[i], b = valid[j];
        const idxA = TENOR_ORDER.indexOf(a.node), idxB = TENOR_ORDER.indexOf(b.node);
        const [earlier, later] = idxA < idxB ? [a, b] : [b, a];
        results.push({
          from: earlier.node,
          to: later.node,
          payerPremium: later.bid - earlier.bid,
          receiverPremium: later.offer - earlier.offer,
        });
      }
    }
    return results;
  }

  function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }
  function numOrNull(a, b, fn) { return isNum(a) && isNum(b) ? fn(a, b) : null; }

  return {
    TENOR_ORDER,
    TENOR_LABELS,
    DEFAULT_INTERVALS,
    buildValueDates,
    solveMarket,
    intervalPremium,
    interpolateBrokenDate,
    computeImpliedPremiums,
  };
})();

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

      const dealAgreed = isNum(c.payerBid) && isNum(c.receiverBid) && isNum(c.payerOffer) && isNum(c.receiverOffer)
        && Math.abs(c.payerBid - c.receiverBid) < 1e-9 && Math.abs(c.payerOffer - c.receiverOffer) < 1e-9;

      if (dealAgreed) {
        const pair = fmtRatePairParts(c.payerBid, c.payerOffer);
        tr.innerHTML = `
          <td><span class="tenor-name">${c.label}</span><span class="tenor-date">${fmtDateLabel(c.date)}</span></td>
          <td class="mono" colspan="2"><span class="val-bid">${pair[0]}</span>/<span class="val-offer">${pair[1]}</span> <span class="hint">(deal)</span></td>
        `;
      } else {
        const payerPair = fmtRatePairParts(c.payerBid, c.payerOffer);
        const receiverPair = fmtRatePairParts(c.receiverBid, c.receiverOffer);
        tr.innerHTML = `
          <td><span class="tenor-name">${c.label}</span><span class="tenor-date">${fmtDateLabel(c.date)}</span></td>
          <td class="mono"><span class="val-bid">${payerPair[0]}</span>/<span class="val-offer">${payerPair[1]}</span></td>
          <td class="mono"><span class="val-bid">${receiverPair[0]}</span>/<span class="val-offer">${receiverPair[1]}</span></td>
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

# MVS FX Terminal — USD/LKR Money Broker Dealing Screen

A zero-backend, GitHub-Pages-ready dealing terminal for Sri Lankan interbank
money brokers. One screen — Dealer Quotes. Type a Big Figure, type
whatever rates/premiums you have, and the solver fills in the rest live.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup: Fast Entry ladder, Quote Screen, Excel/Reports |
| `style.css` | Bloomberg-inspired dark/light dealing-room theme |
| `calendar.js` | Sri Lanka bank-holiday engine + working-day date math |
| `calculator.js` | Value-date ladder generation + the interval-graph solver |
| `storage.js` | LocalStorage: draft autosave, theme setting |
| `excel.js` | Excel/CSV import & export, clipboard copy, paste-quotes, PDF report |
| `script.js` | Renders the screen and wires up all inputs/keyboard nav |

Deploy by pushing all files to a GitHub repository and enabling GitHub
Pages — there is no build step and no server.

## Value-date convention

- **Cash** = trade date (rolled to the next working day if the app is
  opened on a non-working day).
- **Tom** = 1 working day after Cash.
- **Spot** = 2 working days after Cash — the standard FX spot lag.
- **1W / 2W** = calendar days added to Spot, rolled forward to the next
  working day.
- **1M / 2M / 3M / 6M / 12M** = calendar months added to Spot, using the
  **modified-following** convention (roll forward to the next working
  day, but roll backward instead if that would cross into the next
  calendar month) and an **end-of-month rule** (if Spot is the last
  business day of its month, every month tenor lands on the last
  business day of its target month too).

Working days skip Saturdays, Sundays, and the holiday list in
`calendar.js` (`SL_HOLIDAYS_2026`), sourced from the CBSL/Gazette
2026 Public & Bank Holidays notification. **Update this array every
December for the following year** — nothing else in the code needs to
change. (The Settings screen for adding one-off holidays was part of
an earlier version and was removed to keep this to a single screen —
ask if you want it back; `FXCalendar.addCustomHoliday()` in
`calendar.js` still works if called from the console in the meantime.)

## Entering quotes — Rate Entries, Premium Entries, Implied Premiums

The Dealer Quotes screen is three flexible, fully editable lists — add
as many rows as you actually have, in any combination, no fixed grid:

**Rate Entries** — pick a value date, type its rate. `30/40` with Big
Figure `336` → Bid 336.30 / Offer 336.40 (a number under 100 is treated
as points off the Big Figure; leave Big Figure blank and type the full
rate instead, e.g. `336.30/336.40`). This is a plain **Bid/Offer**
rate, not tied to Payer or Receiver at all. **Big-figure rollover**:
if the offer's points are numerically smaller than the bid's, the
offer has crossed into the next hundred — `30/10` with Big Figure
`336` → 336.30/**337.10**, not 336.10.

**Premium Entries** — pick Tenor 1, Tenor 2, type the points between
them. `5/5.5` → Payer premium 5 / Receiver premium 5.5, always meaning
0.05/0.055 (premium is always in points — ÷100 — regardless of the
Per Day toggle). Tick **Per Day** to treat that number as points-per-
day, multiplied by the actual calendar days between the two chosen
dates, before being applied. A single value with no `/` applies to
both sides.

**Every premium is applied chronologically forward**: `rate(later) =
rate(earlier) + premium`. This is why Cash naturally comes out as a
discount to Spot with no special-casing anywhere in the code — Cash is
simply earlier, so solving *backward* from Spot subtracts the very
same premium that was added going forward. Add a Cash→Spot premium
entry and Cash's rate falls out correctly automatic — no sign
flipping to remember.

**Each premium shifts BOTH sides of its rate anchor equally** — given
Spot `20/30` and a Cash→Spot premium of Payer `5` / Receiver `5.5`
(Per Day off, so literal totals):

```
Payer Rate    = (20 − 5)   / (30 − 5)    = 15 / 25
Receiver Rate = (20 − 5.5) / (30 − 5.5)  = 14.5 / 24.5
```

i.e. the Payer premium produces its own full Bid/Offer pair, and the
Receiver premium produces a second, separate Bid/Offer pair — which is
why the Quote Screen shows two rate columns, **Payer Rate** and
**Receiver Rate**, each already a Bid/Offer pair, rather than one
blended rate.

**Implied Premiums**: the moment 2 or more Rate Entries exist, the
Payer/Receiver premium between every pair is worked out automatically
and shown in its own card — Payer from the Bid sides, Receiver from
the Offer sides. Type Spot's rate and 1M's rate directly (no premium
entry at all) and you'll see the implied Spot→1M premium appear on its
own, recognized without you doing the subtraction yourself.

If your desk's actual sign convention or point-scaling differs from
this, tell me one real worked example with the numbers you'd expect
and I'll adjust just that formula in `script.js` (`premiumToEdgeValue`)
or `calculator.js` (`solveMarket` / `computeImpliedPremiums`).

## How the solver works — swap points between any two dates

Real desks don't quote a premium "for a date" — they quote **points
for an interval**: Cash–Tom, Tom–Spot, Cash–Spot, Spot–1M, 1M–2M,
Cash–3M, and so on. Points are additive along the date axis
(Cash–Spot + Spot–1M = Cash–1M, exactly), so the whole set of
Premium Entries forms a graph: nodes are value dates (Cash, Tom, Spot,
1W…12M), edges are the entries you've added, in **Payer** points and
**Receiver** points (two parallel graphs, same edges, always applied
chronologically forward as above).

Rate Entries are plain **Bid/Offer** — not tied to Payer or Receiver.
Solving happens in four passes: the Payer premium graph is anchored
once to the Bid side and once to the Offer side of every Rate Entry
(giving Payer-Bid and Payer-Offer for every tenor), and the same for
the Receiver premium graph (Receiver-Bid, Receiver-Offer).

1. Every Premium Entry becomes a graph edge (once for Payer points,
   once for Receiver points). A breadth-first search over each graph
   gives every reachable node's value **relative to Spot** — this
   alone produces "premium from Spot" even with zero rates entered
   anywhere.
2. Every Rate Entry is an anchor. Each premium graph (Payer, Receiver)
   gets anchored twice — once via the Bid values, once via the Offer
   values — so a connected component shifts from relative to absolute
   twice: `rate(node) = anchor + (relative value of node − relative
   value of anchor)`.
3. Nodes with no path back to an anchor stay blank, but still show a
   premium/points figure if they're chained to Spot.
4. Separately, **Implied Premiums** compares every *pair* of Rate
   Entries directly (no graph needed) — `payer = laterBid − earlierBid`,
   `receiver = laterOffer − earlierOffer` — for whenever two real rates
   are known and the premium between them wasn't typed in at all.

**Broken dates**: `FXCalculator.interpolateBrokenDate()` in `calculator.js`
still does piecewise-linear interpolation between the two nearest solved
standard tenors for any arbitrary custom date — the dedicated Broken
Date screen that called it was removed to keep this to one screen, but
the function is there to wire back up on request.

## Data & persistence

Everything lives in the browser's LocalStorage — there is no backend
and no database. The current, unsaved quote grid autosaves as a
**draft** every time you type (debounced), so a refresh doesn't lose
today's work. Drafts only restore if the trade date matches — a new
calendar day starts with a clean sheet. The dark/light preference is
also stored here.

(An earlier version also had a "Save to History" archive with a
day-vs-day compare screen and premium charts — removed for now to keep
this to one screen. `storage.js` still has `saveHistorySnapshot()` /
`getHistory()` etc. if you want that back.)

## Keyboard

- **Tab** — native browser field order.
- **Enter** — save and move to the next field of the same kind (next
  Rate box, or next Premium box). Since Rate Entries and Premium
  Entries are free-form lists rather than a fixed grid, there's no
  fixed row/column to arrow-key between — Tab and Enter cover it.

## What's intentionally simple (future expansion)

The architecture leaves room to bolt on, without touching existing
files: FX Swaps/Options, T-Bill and T-Bond calculators, Repo/Reverse
Repo, Call Money, a Yield Curve Builder, a CBSL market dashboard, live
Reuters/Bloomberg feeds, a real backend/API, multi-user cloud sync, and
multi-currency (EUR/LKR, GBP/LKR, JPY/LKR) — each of those would be a
new module file plus a new tab, reusing `calendar.js` and the same
solver pattern in `calculator.js`.

The PDF report uses the browser's native print-to-PDF (via a
print-formatted popup window) rather than a heavy client-side PDF
library, keeping the app dependency-light while still producing a
clean, shareable report.
