/* ============================================================
   script.js
   Wires calendar.js / calculator.js / storage.js / excel.js
   together for the Dealer Quotes screen.

   INPUT MODEL — two fully flexible, addable/removable lists:
     - Rate Entries:    { node, rate }         a plain Bid/Offer rate
                                                for one value date
     - Premium Entries: { from, to, premium,   Payer/Receiver points
                          perDay }             between any two dates

   Odd / Broken Dates are FULL graph nodes ("bd:<id>"): they can carry
   their own typed Rate (an anchor), connect to any tenor through a
   Premium Entry, receive created prices, feed further chains, and show
   on the ladder exactly like a standard tenor (colour, source tag,
   challenger number, curves, click-to-edit). They only fall back to
   piecewise interpolation ("·i") when nothing connects to them.

   Premium Entries are always stored chronologically (from = earlier
   date, to = later date): rate(later) = rate(earlier) + premium.

   PAYER / RECEIVER = Sell-now/Buy-forward vs Buy-now/Sell-forward
   (standard FX swap terminology) — Payer pays the premium, Receiver
   receives it. Rate = plain Bid/Offer, not tied to Payer/Receiver.
   ============================================================ */

(function () {
  const TENORS = FXCalculator.TENOR_ORDER;

  /**
   * Shared "shortcut key" notation used both for the keyboard shortcuts
   * (wireKeyboardShortcuts) and for the small numbers shown on the
   * ladder marking which row a created value came from.
   * Index 0-9 map to that same digit; index 10+ map to letters a, b, c…
   */
  function shortcutKeyFor(idx) {
    if (idx < 0) return null;
    return idx < 10 ? String(idx) : String.fromCharCode(97 + (idx - 10));
  }
  function shortcutIndexFor(key) {
    if (/^[0-9]$/.test(key)) return parseInt(key, 10);
    if (/^[a-z]$/.test(key)) return 10 + (key.charCodeAt(0) - 97);
    return null;
  }
  const LABELS = FXCalculator.TENOR_LABELS;
  const NEAR_DATES = ['cash', 'tom'];

  const state = {
    // Midnight, not "now": every value date is built from this, and a
    // leftover time-of-day made same-day Odd Dates sort ahead of Cash.
    tradeDate: (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); })(),
    pair: 'USD/LKR',
    bigFigure: '',
    rateEntries: [],     // [{ id, node, rate: '30/40' }]
    premiumEntries: [],  // [{ id, from, to, premium: '5/5.5', perDay: bool }]
    brokenDates: [],     // [{ id, dateStr: 'YYYY-MM-DD', rate }] — odd/custom tenor dates
    valueDateOverrides: {}, // { tenor: 'YYYY-MM-DD' } — manual correction if the computed date is wrong
    valueDates: null,
    solved: null,
    matches: [],
    mismatches: [],
  };

  let nextRateId = 1;
  let nextPremiumId = 1;
  let nextBrokenDateId = 1;

  function todayKey() {
    return FXCalendar.fmt(state.tradeDate);
  }

  function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }

  /**
   * Fast rate entry: as soon as exactly 2 digits have been typed as the
   * bid, a "/" is added automatically so the next keystrokes are the
   * offer ("50" -> "50/" -> type "60" -> "50/60"). Only for typed
   * keystrokes with the caret at the end (never on delete/paste), and
   * only when a Big Figure is set (shorthand mode) — with no Big Figure
   * the dealer types full rates like 336.20, where 2 digits is not the
   * whole bid. Must be attached BEFORE a field's own input listener so
   * that listener sees the value with the "/" already in it.
   */
  function attachAutoSlash(input, needsBigFigure = true) {
    input.addEventListener('input', (e) => {
      if (e.inputType !== 'insertText') return;
      // Premiums are literal points (no Big Figure involved), so the
      // Premium boxes pass needsBigFigure = false.
      if (needsBigFigure && !isFinite(parseFloat(state.bigFigure))) return;
      // Rates: exactly 2 digits ("50"). Premiums: a number with exactly
      // two decimal places ("4.35", "27.75") — the form premiums are
      // actually typed in, so "4.3" / "27" are never cut short. A whole
      // or one-decimal premium ("5", "5.5") needs its "/" typed by hand.
      const trigger = needsBigFigure ? /^\d{2}$/ : /^\d{1,3}\.\d{2}$/;
      if (trigger.test(input.value) && input.selectionStart === input.value.length) {
        input.value += '/';
      }
    });
  }

  function isCashHidden() {
    return !!(state.valueDates && state.valueDates.cashHidden);
  }

  function isTomHidden() {
    return !!(state.valueDates && state.valueDates.tomHidden);
  }

  function visibleTenors() {
    return TENORS.filter((t) => !((t === 'cash' && isCashHidden()) || (t === 'tom' && isTomHidden())));
  }

  /**
   * Accepts DD-MM-YYYY, DD/MM/YYYY, or YYYY-MM-DD (any of - / . as
   * separators) and returns ISO 'YYYY-MM-DD', or null if not a real date.
   */
  function parseFlexibleDateToISO(str) {
    if (!str || !str.trim()) return null;
    const parts = str.trim().split(/[-/.]/).map((p) => p.trim());
    if (parts.length !== 3) return null;
    let y, m, d;
    if (parts[0].length === 4) { [y, m, d] = parts; }
    else { [d, m, y] = parts; }
    y = parseInt(y, 10); m = parseInt(m, 10); d = parseInt(d, 10);
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return null;
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function isoToDisplayDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    if (!y || !m || !d) return '';
    return `${d}-${m}-${y}`;
  }
  function roundsToSame(a, b, dp = 2) {
    return isNum(a) && isNum(b) && a.toFixed(dp) === b.toFixed(dp);
  }

  function isBrokenNode(node) {
    return typeof node === 'string' && node.indexOf('bd:') === 0;
  }
  function brokenById(node) {
    const id = Number(String(node).slice(3));
    return (state.brokenDates || []).find((b) => b.id === id) || null;
  }

  /** Resolves a graph node's value date — standard tenor or Odd/Broken Date ("bd:<id>"). */
  function nodeDate(node) {
    if (state.valueDates.dates[node]) return state.valueDates.dates[node];
    if (isBrokenNode(node)) {
      const bd = brokenById(node);
      return bd ? FXCalendar.parse(bd.dateStr) : null;
    }
    return null;
  }

  function nodeLabel(node) {
    if (LABELS[node]) return LABELS[node];
    if (isBrokenNode(node)) {
      const bd = brokenById(node);
      return bd ? `Odd ${isoToDisplayDate(bd.dateStr)}` : 'Odd Date';
    }
    return node;
  }

  /** Returns [from, to] ordered chronologically (earlier date first). */
  function orderChronologically(a, b) {
    const da = nodeDate(a);
    const db = nodeDate(b);
    if (da && db && FXCalendar.fmt(da) > FXCalendar.fmt(db)) return [b, a];
    return [a, b];
  }

  /* ---------------- Shorthand parsing ---------------- */

  /**
   * The Big Figure the dealer types is for Spot. Near-dates (Cash/Tom)
   * share Spot's Big Figure unchanged. Forward tenors accumulate swap
   * points day by day and CAN cross a hundred, so when nothing better
   * is known, estimate the rollover at ~5.5 points/day from Spot.
   */
  const TYPICAL_PTS_PER_DAY = 5.5;
  function estimateBigFigureForTenor(tenor, baseBF, days) {
    if (!isFinite(baseBF)) return baseBF;
    if (tenor === 'spot' || NEAR_DATES.includes(tenor)) return baseBF;
    const d = days[tenor] || 0;
    const estimatedPts = TYPICAL_PTS_PER_DAY * d;
    const rollover = Math.floor(estimatedPts / 100);
    return baseBF + rollover;
  }

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

  /** "5/5.5" -> {payer:5, receiver:5.5}. A single value with NO slash is Payer-only. */
  function parsePremiumShorthand(str) {
    const empty = { payer: null, receiver: null };
    if (!str || !str.trim()) return empty;
    const parts = str.split('/').map((s) => s.trim());
    const resolve = (p) => { const v = parseFloat(p); return isFinite(v) ? v : null; };
    if (parts.length === 1) { const v = resolve(parts[0]); return { payer: v, receiver: null }; }
    return { payer: resolve(parts[0]), receiver: resolve(parts[1]) };
  }

  /** Turns a typed premium value into the graph edge value (from -> to), chronologically additive. */
  function premiumToEdgeValue(fromNode, toNode, rawVal, perDay) {
    if (rawVal === null) return null;
    const scaled = rawVal / 100;
    if (!perDay) return scaled;
    const fromDate = nodeDate(fromNode);
    const toDate = nodeDate(toNode);
    if (!fromDate || !toDate) return null;
    const days = FXCalendar.calendarDaysBetween(fromDate, toDate);
    return scaled * days;
  }

  /* ---------------- Solve ---------------- */
  function recompute() {
    state.valueDates = FXCalculator.buildValueDates(state.tradeDate);

    // Drop any Rate/Premium entries pointing at a tenor/date that no
    // longer exists (hidden Cash/Tom today, or a deleted Odd Date).
    const hasValueDate = (t) => !!nodeDate(t);
    state.rateEntries = state.rateEntries.filter((re) => hasValueDate(re.node));
    state.premiumEntries = state.premiumEntries.filter((pe) => hasValueDate(pe.from) && hasValueDate(pe.to));

    Object.keys(state.valueDateOverrides).forEach((t) => {
      const iso = state.valueDateOverrides[t];
      if (!iso || !state.valueDates.dates[t]) return;
      const d = FXCalendar.parse(iso);
      state.valueDates.dates[t] = d;
      state.valueDates.days[t] = FXCalendar.calendarDaysBetween(state.valueDates.spot, d);
      state.valueDates.daysFromCash[t] = FXCalendar.calendarDaysBetween(
        state.valueDates.cash || state.valueDates.referenceDate, d
      );
      if (t === 'spot') state.valueDates.spot = d;
      if (t === 'cash') state.valueDates.cash = d;
      if (t === 'tom') state.valueDates.tom = d;
    });

    const edges = [];
    state.premiumEntries.forEach((pe) => {
      const prem = parsePremiumShorthand(pe.premium);
      const payerEdge = premiumToEdgeValue(pe.from, pe.to, prem.payer, pe.perDay);
      const receiverEdge = premiumToEdgeValue(pe.from, pe.to, prem.receiver, pe.perDay);
      if (payerEdge !== null || receiverEdge !== null) {
        edges.push({ from: pe.from, to: pe.to, payer: payerEdge, receiver: receiverEdge });
      }
    });

    const baseBF = parseFloat(state.bigFigure);

    // Pass 1: resolve every Rate Entry with a best-guess Big Figure.
    const guesses = state.rateEntries.map((re) => {
      const override = parseFloat(re.bigFigureOverride);
      const hasOverride = isFinite(override);
      let bfGuess = hasOverride ? override : estimateBigFigureForTenor(re.node, baseBF, state.valueDates.days);

      if (!hasOverride) {
        const parts = (re.rate || '').split('/').map((s) => s.trim());
        if (parts.length > 1) {
          const bidRaw = parseFloat(parts[0]);
          const offerRaw = parseFloat(parts[1]);
          const bidTyped = isFinite(bidRaw) && Math.abs(bidRaw) < 100;
          const offerTyped = isFinite(offerRaw) && Math.abs(offerRaw) < 100;
          const priorRow = (state.swapBest || {})[re.node];

          if (offerTyped && !bidTyped && priorRow && priorRow.bid && isNum(priorRow.bid.val)) {
            const bidBF = Math.floor(priorRow.bid.val);
            const bidPips = Math.round((priorRow.bid.val - bidBF) * 100);
            bfGuess = offerRaw < bidPips ? bidBF + 1 : bidBF;
          } else if (bidTyped && !offerTyped && priorRow && priorRow.offer && isNum(priorRow.offer.val)) {
            const offerBF = Math.floor(priorRow.offer.val);
            const offerPips = Math.round((priorRow.offer.val - offerBF) * 100);
            bfGuess = bidRaw > offerPips ? offerBF - 1 : offerBF;
          }
        }
      }

      const r = parseRateShorthand(re.rate, bfGuess);
      return { node: re.node, rateStr: re.rate, bid: r.bid, offer: r.offer, hasOverride };
    });
    const provisionalAnchors = guesses.filter((g) => g.bid !== null || g.offer !== null);
    const provisional = FXCalculator.solveMarket(edges, provisionalAnchors, state.valueDates);

    // Pass 2: settle each typed shorthand rate's Big Figure against the
    // premium chain, hop by hop from the earliest typed tenor.
    const premOf = (node) => {
      const row = provisional.curve[node];
      if (!row) return null;
      return isNum(row.payerPremium) ? row.payerPremium : (isNum(row.receiverPremium) ? row.receiverPremium : null);
    };
    const settled = guesses.map((g) => g);
    const typedOrder = guesses
      .map((g, i) => i)
      .filter((i) => guesses[i].bid !== null || guesses[i].offer !== null)
      .sort((a, b) => TENORS.indexOf(guesses[a].node) - TENORS.indexOf(guesses[b].node));
    const done = [];
    typedOrder.forEach((i) => {
      const g = guesses[i];
      let out = g;
      const gPrem = premOf(g.node);
      if (!g.hasOverride && done.length && isNum(gPrem)) {
        const parts = (g.rateStr || '').split('/');
        const bidRaw = parseFloat(parts[0]);
        const offerRaw = parts.length > 1 ? parseFloat(parts[1]) : NaN;
        const rawPart = isFinite(bidRaw) ? bidRaw : offerRaw;
        if (isFinite(rawPart) && Math.abs(rawPart) < 100) {
          for (let k = done.length - 1; k >= 0; k--) {
            const ref = done[k];
            const rPrem = premOf(ref.node);
            const refVal = isNum(ref.bid) ? ref.bid : ref.offer;
            if (!isNum(rPrem) || !isNum(refVal)) continue;
            const expected = refVal + (gPrem - rPrem);
            const refinedBF = Math.round(expected - rawPart / 100);
            const r = parseRateShorthand(g.rateStr, refinedBF);
            out = { node: g.node, rateStr: g.rateStr, bid: r.bid, offer: r.offer };
            break;
          }
        }
      }
      settled[i] = out;
      done.push(out);
    });
    const anchors = settled.filter((g) => g.bid !== null || g.offer !== null);

    // Odd/Broken Dates join the same premium graph as extra nodes
    // ("bd:<id>"). A typed Rate on the odd date is a real anchor for that
    // node, with the same Big Figure rollover estimate a forward tenor
    // gets (~5.5 pts/day from Spot), so it can also CREATE prices for
    // other tenors, not just receive one.
    const extraNodes = (state.brokenDates || []).map((bd) => ({
      key: `bd:${bd.id}`,
      date: FXCalendar.parse(bd.dateStr),
      label: `Odd ${isoToDisplayDate(bd.dateStr)}`,
    }));
    const brokenAnchors = (state.brokenDates || [])
      .map((bd) => {
        const dDays = FXCalendar.calendarDaysBetween(state.valueDates.spot, FXCalendar.parse(bd.dateStr));
        const bf = isFinite(baseBF) ? baseBF + Math.floor(Math.max(0, TYPICAL_PTS_PER_DAY * dDays) / 100) : baseBF;
        const typed = parseRateShorthand(bd.rate, bf);
        return { node: `bd:${bd.id}`, bid: typed.bid, offer: typed.offer };
      })
      .filter((a) => a.bid !== null || a.offer !== null);

    state.solved = FXCalculator.solveMarket(edges, anchors.concat(brokenAnchors), state.valueDates, extraNodes);

    state.anchors = anchors;
    state.anchorByNode = {};
    anchors.forEach((a) => { state.anchorByNode[a.node] = a; });
    // Odd-date typed rates are anchors too, so they compete and create
    // prices on the ladder exactly like a standard tenor's Outright.
    brokenAnchors.forEach((a) => { state.anchorByNode[a.node] = a; });

    const neededDecimalsFor = (v) => (isNum(v) && Math.abs(v - parseFloat(v.toFixed(2))) > 1e-9 ? 4 : 2);
    let rateDecimals = 2;
    anchors.forEach((a) => {
      rateDecimals = Math.max(rateDecimals, neededDecimalsFor(a.bid), neededDecimalsFor(a.offer));
    });
    brokenAnchors.forEach((a) => {
      rateDecimals = Math.max(rateDecimals, neededDecimalsFor(a.bid), neededDecimalsFor(a.offer));
    });
    state.rateDecimals = rateDecimals;

    state.swapBest = computeSwapBest();

    // A CREATED price can need more than 2 decimals too (e.g. a 4.35
    // per-day premium over several days gives 331.5435). If any price
    // actually shown on the ladder genuinely needs 3-4 decimals, the whole
    // ladder switches to 4dp so that price is never silently rounded off.
    Object.keys(state.swapBest).forEach((node) => {
      if ((node === 'cash' && isCashHidden()) || (node === 'tom' && isTomHidden())) return;
      const r = state.swapBest[node];
      [r.bid, r.offer].forEach((c) => {
        if (c && isNum(c.val)) state.rateDecimals = Math.max(state.rateDecimals, neededDecimalsFor(c.val));
      });
    });

    // Match detection (typed premium agrees with typed rates).
    const TOL = 0.005;
    state.matches = [];
    state.mismatches = [];
    state.premiumEntries.forEach((pe) => {
      const prem = parsePremiumShorthand(pe.premium);
      const payerEdge = premiumToEdgeValue(pe.from, pe.to, prem.payer, pe.perDay);
      const receiverEdge = premiumToEdgeValue(pe.from, pe.to, prem.receiver, pe.perDay);
      const fromAnchor = anchors.find((a) => a.node === pe.from);
      const toAnchor = anchors.find((a) => a.node === pe.to);
      if (!fromAnchor || !toAnchor) return;

      const fromDate = nodeDate(pe.from);
      const toDate = nodeDate(pe.to);
      if (!fromDate || !toDate) return;
      const days = FXCalendar.calendarDaysBetween(fromDate, toDate);
      const toDisplayUnit = (totalPts) => (pe.perDay && days !== 0 ? totalPts / days : totalPts);
      const unitLabel = pe.perDay ? 'p/day' : 'p';

      if (isNum(fromAnchor.bid) && isNum(toAnchor.bid) && isNum(payerEdge)) {
        const actualTotalPts = (toAnchor.bid - fromAnchor.bid) * 100;
        const typedDisplayPts = prem.payer;
        const actualDisplayPts = toDisplayUnit(actualTotalPts);
        const offPts = actualDisplayPts - typedDisplayPts;
        if (Math.abs((toAnchor.bid - fromAnchor.bid) - payerEdge) < TOL) {
          state.matches.push({ from: pe.from, to: pe.to, side: 'payer', direct: true });
        } else {
          const suggestedFromRate = toAnchor.bid - payerEdge;
          const suggestedToRate = fromAnchor.bid + payerEdge;
          const fromSuitable = (!isNum(fromAnchor.offer) || suggestedFromRate < fromAnchor.offer) && !roundsToSame(suggestedFromRate, fromAnchor.bid);
          const toSuitable = (!isNum(toAnchor.offer) || suggestedToRate < toAnchor.offer) && !roundsToSame(suggestedToRate, toAnchor.bid);
          state.mismatches.push({
            from: pe.from, to: pe.to, side: 'payer', unitLabel, direct: true,
            typedDisplayPts, actualDisplayPts, offPts,
            suggestedFromRate, suggestedToRate, fromSuitable, toSuitable,
          });
        }
      }
      if (isNum(fromAnchor.offer) && isNum(toAnchor.offer) && isNum(receiverEdge)) {
        const actualTotalPts = (toAnchor.offer - fromAnchor.offer) * 100;
        const typedDisplayPts = prem.receiver;
        const actualDisplayPts = toDisplayUnit(actualTotalPts);
        const offPts = actualDisplayPts - typedDisplayPts;
        if (Math.abs((toAnchor.offer - fromAnchor.offer) - receiverEdge) < TOL) {
          state.matches.push({ from: pe.from, to: pe.to, side: 'receiver', direct: true });
        } else {
          const suggestedFromRate = toAnchor.offer - receiverEdge;
          const suggestedToRate = fromAnchor.offer + receiverEdge;
          const fromSuitable = (!isNum(fromAnchor.bid) || suggestedFromRate > fromAnchor.bid) && !roundsToSame(suggestedFromRate, fromAnchor.offer);
          const toSuitable = (!isNum(toAnchor.bid) || suggestedToRate > toAnchor.bid) && !roundsToSame(suggestedToRate, toAnchor.offer);
          state.mismatches.push({
            from: pe.from, to: pe.to, side: 'receiver', unitLabel, direct: true,
            typedDisplayPts, actualDisplayPts, offPts,
            suggestedFromRate, suggestedToRate, fromSuitable, toSuitable,
          });
        }
      }
    });

    // Generalized cross-check across any two typed Rate Entries
    // connected through the premium graph.
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const a = anchors[i];
        const b = anchors[j];
        if (a.node === b.node) continue;
        const hasDirectEntry = state.premiumEntries.some((pe) =>
          (pe.from === a.node && pe.to === b.node) || (pe.from === b.node && pe.to === a.node));
        if (hasDirectEntry) continue;

        const idxA = TENORS.indexOf(a.node);
        const idxB = TENORS.indexOf(b.node);
        if (idxA === -1 || idxB === -1) continue;
        const [earlier, later] = idxA < idxB ? [a, b] : [b, a];
        const rowEarlier = state.solved.curve[earlier.node];
        const rowLater = state.solved.curve[later.node];

        if (isNum(earlier.bid) && isNum(later.bid) && isNum(rowEarlier.payerPremium) && isNum(rowLater.payerPremium)) {
          const chainPremium = rowLater.payerPremium - rowEarlier.payerPremium;
          const actualDiff = later.bid - earlier.bid;
          if (Math.abs(actualDiff - chainPremium) < TOL) {
            state.matches.push({ from: earlier.node, to: later.node, side: 'payer', direct: false });
          } else {
            const suggestedEarlierRate = later.bid - chainPremium;
            const suggestedLaterRate = earlier.bid + chainPremium;
            const earlierSuitable = (!isNum(earlier.offer) || suggestedEarlierRate < earlier.offer) && !roundsToSame(suggestedEarlierRate, earlier.bid);
            const laterSuitable = (!isNum(later.offer) || suggestedLaterRate < later.offer) && !roundsToSame(suggestedLaterRate, later.bid);
            state.mismatches.push({
              from: earlier.node, to: later.node, side: 'payer', direct: false,
              suggestedFromRate: suggestedEarlierRate, suggestedToRate: suggestedLaterRate,
              fromSuitable: earlierSuitable, toSuitable: laterSuitable,
            });
          }
        }
        if (isNum(earlier.offer) && isNum(later.offer) && isNum(rowEarlier.receiverPremium) && isNum(rowLater.receiverPremium)) {
          const chainPremium = rowLater.receiverPremium - rowEarlier.receiverPremium;
          const actualDiff = later.offer - earlier.offer;
          if (Math.abs(actualDiff - chainPremium) < TOL) {
            state.matches.push({ from: earlier.node, to: later.node, side: 'receiver', direct: false });
          } else {
            const suggestedEarlierRate = later.offer - chainPremium;
            const suggestedLaterRate = earlier.offer + chainPremium;
            const earlierSuitable = (!isNum(earlier.bid) || suggestedEarlierRate > earlier.bid) && !roundsToSame(suggestedEarlierRate, earlier.offer);
            const laterSuitable = (!isNum(later.bid) || suggestedLaterRate > later.bid) && !roundsToSame(suggestedLaterRate, later.offer);
            state.mismatches.push({
              from: earlier.node, to: later.node, side: 'receiver', direct: false,
              suggestedFromRate: suggestedEarlierRate, suggestedToRate: suggestedLaterRate,
              fromSuitable: earlierSuitable, toSuitable: laterSuitable,
            });
          }
        }
      }
    }
  }

  /**
   * DIRECTION-DEPENDENT theory, per the dealer's own convention:
   *   - Payer premium FORWARD  -> BID at the far tenor.
   *   - Payer premium BACKWARD -> OFFER at the near tenor.
   *   - Receiver premium FORWARD  -> OFFER at the far tenor.
   *   - Receiver premium BACKWARD -> BID at the near tenor.
   * Every candidate for a tenor's bid/offer slot (its own typed
   * Outright plus every chain-created price) competes on price: highest
   * bid wins, lowest offer wins. The winner's own source decides its
   * colour.
   *
   * MULTI-HOP: a created value can feed another Premium Entry, solved by
   * relaxing the whole set repeatedly until everything has propagated.
   *
   * Odd/Broken Dates ("bd:<id>") are ordinary nodes here — same
   * competition, same multi-hop propagation, same source tracking.
   */
  function computeSwapBest() {
    const NODES = TENORS.concat((state.brokenDates || []).map((bd) => `bd:${bd.id}`));

    const pickBest = (list, isBid) => {
      let b = null;
      list.forEach((cand) => {
        if (!isNum(cand.val)) return;
        if (!b || (isBid ? cand.val > b.val : cand.val < b.val)) b = cand;
      });
      return b || { val: null, source: null };
    };

    const empty = () => ({ val: null, source: null });
    let current = {};
    NODES.forEach((t) => {
      const anchor = (state.anchorByNode || {})[t];
      current[t] = {
        bid: isNum(anchor && anchor.bid) ? { source: 'outright', val: anchor.bid } : empty(),
        offer: isNum(anchor && anchor.offer) ? { source: 'outright', val: anchor.offer } : empty(),
      };
    });

    const maxIterations = NODES.length;
    let lastPools = null;
    for (let iter = 0; iter < maxIterations; iter++) {
      const pools = {};
      NODES.forEach((t) => {
        pools[t] = { bid: [], offer: [] };
        ['bid', 'offer'].forEach((k) => {
          if (isNum(current[t][k].val)) pools[t][k].push(current[t][k]);
        });
      });

      state.premiumEntries.forEach((pe) => {
        if (!current[pe.from] || !current[pe.to]) return;
        const prem = parsePremiumShorthand(pe.premium);
        const payerEdge = premiumToEdgeValue(pe.from, pe.to, prem.payer, pe.perDay);
        const receiverEdge = premiumToEdgeValue(pe.from, pe.to, prem.receiver, pe.perDay);
        const fromBest = current[pe.from];
        const toBest = current[pe.to];

        if (isNum(payerEdge)) {
          if (fromBest && isNum(fromBest.bid.val)) {
            pools[pe.to].bid.push({ source: pe.from, process: 'payer', val: fromBest.bid.val + payerEdge });
          }
          if (toBest && isNum(toBest.offer.val)) {
            pools[pe.from].offer.push({ source: pe.to, process: 'payer', val: toBest.offer.val - payerEdge });
          }
        }
        if (isNum(receiverEdge)) {
          if (fromBest && isNum(fromBest.offer.val)) {
            pools[pe.to].offer.push({ source: pe.from, process: 'receiver', val: fromBest.offer.val + receiverEdge });
          }
          if (toBest && isNum(toBest.bid.val)) {
            pools[pe.from].bid.push({ source: pe.to, process: 'receiver', val: toBest.bid.val - receiverEdge });
          }
        }
      });

      lastPools = pools;
      const next = {};
      NODES.forEach((t) => {
        next[t] = {
          bid: pickBest(pools[t].bid, true),
          offer: pickBest(pools[t].offer, false),
        };
      });
      current = next;
    }

    // "Created only": best candidate for this slot excluding this
    // node's OWN directly-typed Outright.
    NODES.forEach((t) => {
      const bidCreated = lastPools ? lastPools[t].bid.filter((c) => c.source !== 'outright') : [];
      const offerCreated = lastPools ? lastPools[t].offer.filter((c) => c.source !== 'outright') : [];
      current[t].bidCreatedOnly = pickBest(bidCreated, true);
      current[t].offerCreatedOnly = pickBest(offerCreated, false);
    });

    return current;
  }


  function loadDraft() {
    const draft = FXStorage.loadDraft();
    if (draft && draft.tradeDateKey === todayKey() && draft.rateEntries) {
      state.rateEntries = draft.rateEntries;
      state.premiumEntries = draft.premiumEntries || [];
      state.brokenDates = draft.brokenDates || [];
      state.valueDateOverrides = draft.valueDateOverrides || {};
      state.bigFigure = draft.bigFigure || '';
      nextRateId = Math.max(1, ...state.rateEntries.map((e) => e.id + 1), 1);
      nextPremiumId = Math.max(1, ...state.premiumEntries.map((e) => e.id + 1), 1);
      nextBrokenDateId = Math.max(1, ...state.brokenDates.map((e) => e.id + 1), 1);
    } else {
      state.rateEntries = [];
      state.premiumEntries = [];
      state.brokenDates = [];
      state.valueDateOverrides = {};
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
        brokenDates: state.brokenDates,
        valueDateOverrides: state.valueDateOverrides,
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

  /** [bid, offer] -> full-rate strings; decimals follow state.rateDecimals (2 normally, 4 when needed). */
  /** Decimals a single price needs: 4 only if rounding it to 2dp would change it, otherwise 2. */
  function decimalsFor(v) {
    return isNum(v) && Math.abs(v - parseFloat(v.toFixed(2))) > 1e-9 ? 4 : 2;
  }

  // Each price decides its own decimals: 2 normally, 4 only for a price
  // that genuinely has them (typed or created).
  function fmtRatePairParts(bid, offer, dp) {
    const full = (v) => (v === null ? '—' : fmtNum(v, dp || decimalsFor(v)));
    return [full(bid), full(offer)];
  }

  /** Just the digits past the decimal point, for the small created/outright comparison tag. */
  function fmtPipsOnly(v, dp) {
    const d = dp || decimalsFor(v);
    const scale = Math.pow(10, d);
    const p = Math.round((Math.abs(v) % 1) * scale);
    return String(p).padStart(d, '0');
  }

  function renderHeader() {
    document.getElementById('tradeDateDisplay').textContent = fmtDateLabel(state.tradeDate);
  }

  function populateTenorSelect(sel, fallback) {
    const prev = sel.value;
    sel.innerHTML = visibleTenors().map((t) => `<option value="${t}">${LABELS[t]}</option>`).join('');
    if (visibleTenors().includes(prev)) {
      sel.value = prev;
    } else if (fallback) {
      sel.value = fallback;
    }
  }

  /** Premium Entries dropdowns also offer every current Odd/Broken Date. */
  function populatePremiumSelect(sel, fallback) {
    const prev = sel.value;
    const brokenDatesSorted = (state.brokenDates || []).slice().sort((a, b) => (a.dateStr < b.dateStr ? -1 : 1));
    // Standard tenors and Odd Dates merged and sorted by real value date
    // (same order as the ladder); on a tie the standard tenor comes first.
    const items = visibleTenors().map((t) => ({ value: t, label: LABELS[t], date: state.valueDates.dates[t] }))
      .concat(brokenDatesSorted.map((bd) => ({ value: `bd:${bd.id}`, label: nodeLabel(`bd:${bd.id}`), date: FXCalendar.parse(bd.dateStr) })));
    items.sort((a, b) => {
      const ka = FXCalendar.fmt(a.date), kb = FXCalendar.fmt(b.date);
      return ka < kb ? -1 : ka > kb ? 1 : 0; // stable: standard tenor stays first on a tie
    });
    sel.innerHTML = items.map((it) => `<option value="${it.value}">${it.label}</option>`).join('');
    const validValues = items.map((it) => it.value);
    if (validValues.includes(prev)) {
      sel.value = prev;
    } else if (fallback) {
      sel.value = fallback;
    }
  }

  function refreshTenorSelects() {
    const nearFallback = isCashHidden() ? (isTomHidden() ? 'spot' : 'tom') : 'cash';
    const newRateNode = document.getElementById('newRateNode');
    if (newRateNode) populateTenorSelect(newRateNode, 'spot');
    const newPremiumFrom = document.getElementById('newPremiumFrom');
    const newPremiumTo = document.getElementById('newPremiumTo');
    if (newPremiumFrom) populatePremiumSelect(newPremiumFrom, nearFallback);
    if (newPremiumTo) populatePremiumSelect(newPremiumTo, 'spot');
    const bulkPremiumFrom = document.getElementById('bulkPremiumFrom');
    const bulkPremiumTo = document.getElementById('bulkPremiumTo');
    if (bulkPremiumFrom) populatePremiumSelect(bulkPremiumFrom, nearFallback);
    if (bulkPremiumTo) populatePremiumSelect(bulkPremiumTo);
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
        <td><span class="tenor-name">${LABELS[re.node]}</span><span class="tenor-date">${date ? fmtDateLabel(date) : '—'}</span></td>
        <td><input type="text" class="cell-input shorthand" data-rate-id="${re.id}" placeholder="30/40 or 75/ or /75"></td>
        <td><input type="text" class="cell-input" style="width:70px;" data-bf-id="${re.id}" placeholder="auto"></td>
        <td><button class="btn danger" data-remove-rate="${re.id}" style="padding:3px 8px;">✕</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('[data-rate-id]').forEach((input) => {
      const id = Number(input.dataset.rateId);
      const entry = state.rateEntries.find((e) => e.id === id);
      input.value = entry.rate;
      attachAutoSlash(input);
      input.addEventListener('input', () => {
        entry.rate = input.value;
        recompute();
        renderDownstream();
        scheduleSaveDraft();
      });
      input.addEventListener('keydown', (e) => handleEnterToNext(e, '#rateTableBody input[data-rate-id]'));
    });

    tbody.querySelectorAll('[data-bf-id]').forEach((input) => {
      const id = Number(input.dataset.bfId);
      const entry = state.rateEntries.find((e) => e.id === id);
      input.value = entry.bigFigureOverride || '';
      input.addEventListener('input', () => {
        entry.bigFigureOverride = input.value.trim();
        recompute();
        renderDownstream();
        scheduleSaveDraft();
      });
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
        <td class="tenor-name">${nodeLabel(pe.from)}</td>
        <td class="tenor-name">${nodeLabel(pe.to)}</td>
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
      attachAutoSlash(input, false);
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
    const visible = visibleTenors();
    const connectedCount = visible.filter((t) => state.solved.curve[t].payerPremium !== null || state.solved.curve[t].receiverPremium !== null).length;

    const hiddenLabel = isCashHidden() && isTomHidden() ? 'Cash & Tom hidden today'
      : isCashHidden() ? 'Cash hidden today' : isTomHidden() ? 'Tom hidden today' : '';
    const cashNote = hiddenLabel
      ? ` ${hiddenLabel} (US holiday) — Tom/Spot/forwards counted from today, ${fmtDateLabel(state.valueDates.referenceDate)}.`
      : '';

    if (!anySpot) {
      el.className = 'solver-status warn';
      el.textContent = (connectedCount > 1
        ? `${connectedCount} tenors linked by points, but no anchor yet — add a Rate for Spot (or any linked tenor) to see actual levels.`
        : 'Add a Rate for at least one value date, then a Premium between any two, and the rest chains off it.') + cashNote;
      return;
    }
    el.className = 'solver-status ok';
    el.textContent = `Spot solved — Payer ${fmtNum(payerSpotBid)}/${fmtNum(payerSpotOffer)} · Receiver ${fmtNum(receiverSpotBid)}/${fmtNum(receiverSpotOffer)} · ${connectedCount} of ${visible.length} tenors linked` + cashNote;
  }

  /* ==================================================================
     RENDER: Dealer Quote Screen (read-only big board)
     ================================================================== */
  function fmtPremiumPts(v) {
    if (!isNum(v)) return '';
    const pts = v * 100;
    return (pts >= 0 ? '+' : '') + fmtTrim(pts) + 'p from Spot';
  }
  function fmtPremiumPtsShort(v) {
    if (!isNum(v)) return '';
    const pts = v * 100;
    return (pts >= 0 ? '+' : '') + fmtTrim(pts) + 'p';
  }
  function fmtDiffPts(payerRate, receiverRate) {
    if (!isNum(payerRate) || !isNum(receiverRate)) return '—';
    const pts = (receiverRate - payerRate) * 100;
    return (pts >= 0 ? '+' : '') + fmtTrim(pts);
  }

  /**
   * Standard tenors AND Odd/Broken Dates merged into one list sorted
   * chronologically by real value date.
   */
  function buildDisplayRows() {
    const rows = visibleTenors().map((t) => ({
      key: t,
      kind: 'tenor',
      label: LABELS[t],
      date: state.valueDates.dates[t],
    }));
    (state.brokenDates || []).forEach((bd) => {
      const date = FXCalendar.parse(bd.dateStr);
      rows.push({ key: `bd:${bd.id}`, kind: 'broken', label: fmtDateLabel(date), date, bd });
    });
    // Compare by calendar day (ignoring any time-of-day); on the same day
    // a standard tenor stays above an Odd Date.
    rows.sort((a, b) => {
      const ka = FXCalendar.fmt(a.date), kb = FXCalendar.fmt(b.date);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return (a.kind === 'broken' ? 1 : 0) - (b.kind === 'broken' ? 1 : 0);
    });
    return rows;
  }

  /**
   * One column's price as a "bid/offer" pair (e.g. "20/30"). Each number
   * is coloured by its OWN winning source: green = typed Outright, blue =
   * created via Payer, red = created via Receiver.
   */
  function buildPairMarkup(bidCand, offerCand, bidTagMarkup = '', offerTagMarkup = '', bidCompareMarkup = '', offerCompareMarkup = '') {
    const bidStr = isNum(bidCand && bidCand.val) ? fmtRatePairParts(bidCand.val, null)[0] : '';
    const offerStr = isNum(offerCand && offerCand.val) ? fmtRatePairParts(null, offerCand.val)[1] : '';
    if (!bidStr && !offerStr) return '';
    const classFor = (cand) => {
      if (!cand || cand.source !== 'outright') {
        if (cand && cand.process === 'receiver') return 'ladder-src-created-receiver';
        if (cand && cand.process === 'payer') return 'ladder-src-created-payer';
        return 'ladder-src-created';
      }
      return 'ladder-src-outright';
    };
    const bidClass = classFor(bidCand);
    const offerClass = classFor(offerCand);
    return `${bidTagMarkup}<tspan class="${bidClass}">${bidStr}</tspan>${bidCompareMarkup}<tspan class="ladder-val-slash">/</tspan>${offerTagMarkup}<tspan class="${offerClass}">${offerStr}</tspan>${offerCompareMarkup}`;
  }

  function fmtSpreadPts(bidVal, offerVal) {
    if (!isNum(bidVal) || !isNum(offerVal)) return '—';
    return fmtTrim((offerVal - bidVal) * 100);
  }

  function buildLadderSVG(curve, matches, mismatches, anchorByNode) {
    const rows = buildDisplayRows();
    const n = rows.length;
    const rowH = 12;
    const slot = 14;
    const topPad = 8;
    const height = topPad + n * slot + 5;

    const viewW = 280;
    const tenorX = 3;
    const colW = 190;
    const railX = tenorX + colW + 8;
    const premRightX = viewW - 4;

    function diffTooltip(keyA, keyB) {
      const bestA = state.swapBest && state.swapBest[keyA];
      const bestB = state.swapBest && state.swapBest[keyB];
      const ca = curve[keyA];
      const cb = curve[keyB];
      const bidA = bestA && isNum(bestA.bid.val) ? bestA.bid.val : (ca && ca.payerBid);
      const bidB = bestB && isNum(bestB.bid.val) ? bestB.bid.val : (cb && cb.payerBid);
      const offerA = bestA && isNum(bestA.offer.val) ? bestA.offer.val : (ca && ca.receiverOffer);
      const offerB = bestB && isNum(bestB.offer.val) ? bestB.offer.val : (cb && cb.receiverOffer);

      const days = FXCalendar.calendarDaysBetween(nodeDate(keyA), nodeDate(keyB));
      const payerDiff = isNum(bidA) && isNum(bidB) ? (bidB - bidA) * 100 : null;
      const receiverDiff = isNum(offerA) && isNum(offerB) ? (offerB - offerA) * 100 : null;
      const payerPerDay = payerDiff !== null && days ? payerDiff / days : null;
      const receiverPerDay = receiverDiff !== null && days ? receiverDiff / days : null;
      const perDayTag = (v) => (v !== null ? ` (${fmtTrim(v, 4)} p/day)` : '');
      const dp = state.rateDecimals || 2;
      return `Payer diff: ${payerDiff !== null ? fmtTrim(payerDiff, dp) : '—'}${perDayTag(payerPerDay)}\nReceiver diff: ${receiverDiff !== null ? fmtTrim(receiverDiff, dp) : '—'}${perDayTag(receiverPerDay)}`;
    }

    const rowY = (i) => topPad + i * slot;
    const rowCenterY = (i) => rowY(i) + rowH / 2;

    let svg = `<svg class="ladder-svg" viewBox="0 0 ${viewW} ${height}" width="100%" role="img" aria-label="Rate ladder with bid/offer">`;
    svg += `<text x="${tenorX}" y="7" class="ladder-heading">Bid / Offer</text>`;

    // Pre-pass: link info for EVERY row (standard tenors and Odd Dates
    // alike), so a source appearing earlier in the ladder than the row
    // it feeds still gets the right tag number.
    const rowKeysAll = rows.map((r) => r.key);
    state.shortcutOrder = rowKeysAll;
    rows.forEach((row) => {
      const info = autoLinkInfoFor(row.key);
      row.bidLink = info.bid;
      row.offerLink = info.offer;
      row.bidChallengerLink = info.bidChallenger;
      row.offerChallengerLink = info.offerChallenger;
    });

    const linkTagNumber = {};
    rows.forEach((row) => {
      [row.bidLink, row.offerLink].forEach((link) => {
        if (!link) return;
        const srcIdx = rowKeysAll.indexOf(link.source);
        if (srcIdx === -1 || link.source === row.key) return;
        if (!linkTagNumber[link.source]) linkTagNumber[link.source] = shortcutKeyFor(srcIdx);
      });
    });

    rows.forEach((row, i) => {
      const t = row.key;
      const y = rowY(i);
      const cy = rowCenterY(i);

      let rowLabel, priceLine, isChainDerived = false,
        premLabel, bigFigLabel, rowExtraClass = '', showEditable = true, spreadLabel = '—';
      let valForBracket = null;

      // An Odd Date uses exactly the same price logic as a standard
      // tenor whenever the premium graph / a typed Rate gives it a
      // value; only with nothing at all does it fall back to
      // interpolation (the else branch below).
      const sb = (state.swapBest || {})[t];
      const hasChain = !!(sb && (isNum(sb.bid.val) || isNum(sb.offer.val)));

      if (row.kind === 'tenor' || hasChain) {
        const c = curve[t];
        rowLabel = row.kind === 'tenor' ? c.label : row.label;
        const swapBest = sb || {
          bid: { val: c ? c.payerBid : null, source: null },
          offer: { val: c ? c.receiverOffer : null, source: null },
        };

        const tagMarkup = (link) => {
          if (!link) return '';
          const num = linkTagNumber[link.source];
          if (!num) return '';
          const cls = link.process === 'receiver' ? 'ladder-link-tag-receiver' : 'ladder-link-tag-payer';
          return `<tspan class="${cls}">${num} </tspan>`;
        };
        const bidTagMarkup = tagMarkup(row.bidLink);
        const offerTagMarkup = tagMarkup(row.offerLink);

        const anchor = anchorByNode ? anchorByNode[t] : null;
        const compareTag = (cand, side, createdOnlyCand) => {
          if (!cand || !isNum(cand.val)) return '';
          if (cand.source === 'outright') {
            if (!createdOnlyCand || !isNum(createdOnlyCand.val) || roundsToSame(cand.val, createdOnlyCand.val)) return '';
            const cls = createdOnlyCand.process === 'receiver' ? 'ladder-compare-receiver'
              : createdOnlyCand.process === 'payer' ? 'ladder-compare-payer'
              : 'ladder-compare-inline';
            return `<tspan class="${cls}"> ${fmtPipsOnly(createdOnlyCand.val)}</tspan>`;
          }
          const outrightVal = anchor && isNum(anchor[side]) ? anchor[side] : null;
          if (outrightVal === null || roundsToSame(cand.val, outrightVal)) return '';
          return `<tspan class="ladder-compare-outright"> ${fmtPipsOnly(outrightVal)}</tspan>`;
        };
        const bidCompareMarkup = compareTag(swapBest.bid, 'bid', swapBest.bidCreatedOnly);
        const offerCompareMarkup = compareTag(swapBest.offer, 'offer', swapBest.offerCreatedOnly);

        priceLine = buildPairMarkup(swapBest.bid, swapBest.offer, bidTagMarkup, offerTagMarkup, bidCompareMarkup, offerCompareMarkup);
        spreadLabel = fmtSpreadPts(swapBest.bid.val, swapBest.offer.val);

        const primaryVal = isNum(swapBest.bid.val) ? swapBest.bid.val : swapBest.offer.val;
        const spotBest = (state.swapBest || {}).spot || {};
        const spotPrimary = isNum(spotBest.bid && spotBest.bid.val) ? spotBest.bid.val
          : (spotBest.offer ? spotBest.offer.val : null);
        premLabel = (isNum(primaryVal) && isNum(spotPrimary)) ? fmtPremiumPtsShort(primaryVal - spotPrimary) : '';
        bigFigLabel = isNum(primaryVal) ? `${Math.floor(primaryVal)}` : '';
        rowExtraClass = t === 'spot' ? ' ladder-row-spot' : (row.kind === 'broken' ? ' ladder-row-broken' : '');
        valForBracket = primaryVal;
      } else {
        // Odd/Broken Date with nothing typed and nothing linked to it:
        // auto-interpolated estimate, labelled "·i".
        const bd = row.bd;
        rowLabel = row.label;
        const typed = parseRateShorthand(bd.rate, parseFloat(state.bigFigure));
        const hasTypedBid = isNum(typed.bid);
        const hasTypedOffer = isNum(typed.offer);
        const result = FXCalculator.interpolateBrokenDate(curve, row.date, state.valueDates.spot);
        const interpBid = isNum(state.solved.payerSpotBid) && result && isNum(result.payerPremium)
          ? state.solved.payerSpotBid + result.payerPremium : null;
        const interpOffer = isNum(state.solved.receiverSpotOffer) && result && isNum(result.receiverPremium)
          ? state.solved.receiverSpotOffer + result.receiverPremium : null;
        const bidUsed = hasTypedBid ? typed.bid : interpBid;
        const offerUsed = hasTypedOffer ? typed.offer : interpOffer;

        const bidStr = isNum(bidUsed) ? fmtRatePairParts(bidUsed, null)[0] + (hasTypedBid ? '' : '·i') : '';
        const offerStr = isNum(offerUsed) ? fmtRatePairParts(null, offerUsed)[1] + (hasTypedOffer ? '' : '·i') : '';
        const bidCls = hasTypedBid ? 'ladder-src-outright' : 'ladder-src-created';
        const offerCls = hasTypedOffer ? 'ladder-src-outright' : 'ladder-src-created';
        priceLine = (bidStr || offerStr)
          ? `<tspan class="${bidCls}">${bidStr}</tspan><tspan class="ladder-val-slash">/</tspan><tspan class="${offerCls}">${offerStr}</tspan>`
          : '';
        spreadLabel = fmtSpreadPts(bidUsed, offerUsed);
        isChainDerived = !hasTypedBid && !hasTypedOffer;
        const bigFigSource = isNum(bidUsed) ? bidUsed : offerUsed;
        premLabel = (isNum(bigFigSource) && isNum(state.solved.payerSpotBid)) ? fmtPremiumPtsShort(bigFigSource - state.solved.payerSpotBid) : '';
        bigFigLabel = isNum(bigFigSource) ? `${Math.floor(bigFigSource)}` : 'ODD';
        rowExtraClass = ' ladder-row-broken';
        showEditable = true; // click the row to type a Rate straight onto this odd date
        valForBracket = bigFigSource;
      }
      row.val = valForBracket;

      const ownTagNum = linkTagNumber[t];
      const ownTag = ownTagNum ? `<tspan class="ladder-link-tag"> ${ownTagNum}</tspan>` : '';

      const shortcutIdx = rowKeysAll.indexOf(t);
      const shortcutLabel = shortcutKeyFor(shortcutIdx) || '';
      const shortcutTag = shortcutLabel ? `<tspan class="ladder-shortcut-hint"> [${shortcutLabel}]</tspan>` : '';

      const editRect = showEditable ? `
        <rect x="${tenorX + colW - 94}" y="${y}" width="91" height="${rowH}" fill="transparent" class="ladder-val-editable" style="cursor:pointer;" data-tenor="${t}"></rect>` : '';
      const outerClass = (row.kind === 'tenor' || hasChain) ? 'ladder-val' : `ladder-val ${isChainDerived ? 'ladder-src-created' : 'ladder-src-outright'}`;
      svg += `
        <rect x="${tenorX}" y="${y}" width="${colW}" height="${rowH}" rx="2" class="ladder-row${rowExtraClass}"></rect>
        <text x="${tenorX + 4}" y="${cy}" dominant-baseline="central" class="ladder-tenor">${rowLabel}${shortcutTag}<tspan class="ladder-bigfig"> ${bigFigLabel}</tspan>${ownTag}</text>
        <text x="${tenorX + colW - 4}" y="${cy}" text-anchor="end" dominant-baseline="central" class="${outerClass}" pointer-events="none">${priceLine}<tspan class="ladder-premium-inline"> ${premLabel}</tspan></text>
        ${editRect}

        <line x1="${tenorX + colW}" y1="${cy}" x2="${railX}" y2="${cy}" class="ladder-tick"></line>
      `;
    });

    svg += `<line x1="${railX}" y1="${rowCenterY(0)}" x2="${railX}" y2="${rowCenterY(n - 1)}" class="ladder-rail"></line>`;

    for (let i = 0; i < n - 1; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      const midY = (rowCenterY(i) + rowCenterY(i + 1)) / 2;
      const prem = isNum(a.val) && isNum(b.val) ? fmtTrim((b.val - a.val) * 100) : '—';
      const editablePremRect = `
        <rect x="${railX}" y="${midY - rowH / 2}" width="${premRightX - railX}" height="${rowH}" fill="transparent" class="ladder-prem-editable" style="cursor:pointer;" data-from="${a.key}" data-to="${b.key}"><title>${diffTooltip(a.key, b.key)}</title></rect>`;
      svg += `<text x="${railX + 6}" y="${midY}" dominant-baseline="central" class="ladder-premium" pointer-events="none">${prem}</text>${editablePremRect}`;
    }

    // Source curves: one thin dashed line from each source row to the
    // row it created (or, for a challenger, is being compared against).
    const rowKeys = rows.map((r) => r.key);
    const maxBulge = premRightX - railX - 10;
    const usedBulges = [];
    function pickBulge(lo, hi) {
      let bulge = Math.min(maxBulge, 10 + (hi - lo - 1) * 9);
      for (let guard = 0; guard < 30; guard++) {
        let changed = false;
        for (const u of usedBulges) {
          const overlaps = lo < u.hi && hi > u.lo;
          if (overlaps && Math.abs(u.bulge - bulge) < 7) {
            const next = Math.min(maxBulge, bulge + 9);
            if (next === bulge) continue;
            bulge = next;
            changed = true;
          }
        }
        if (!changed) break;
      }
      usedBulges.push({ lo, hi, bulge });
      return bulge;
    }
    rows.forEach((row, i) => {
      const links = [
        row.bidLink && { ...row.bidLink, isChallenger: false },
        row.offerLink && { ...row.offerLink, isChallenger: false },
        row.bidChallengerLink && { ...row.bidChallengerLink, isChallenger: true },
        row.offerChallengerLink && { ...row.offerChallengerLink, isChallenger: true },
      ].filter(Boolean);
      const seen = new Set();
      links.forEach((link) => {
        const sourceIdx = rowKeys.indexOf(link.source);
        if (sourceIdx === -1 || sourceIdx === i) return;
        const dedupeKey = `${sourceIdx}:${link.process}:${link.isChallenger ? 'c' : 'r'}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        const lo = Math.min(sourceIdx, i);
        const hi = Math.max(sourceIdx, i);
        const y1 = rowCenterY(lo);
        const y2 = rowCenterY(hi);
        const x = railX;
        const skips = hi - lo > 1;
        const bulge = skips ? pickBulge(lo, hi) : 0;
        const d = skips
          ? `M ${x} ${y1} Q ${x + bulge} ${(y1 + y2) / 2} ${x} ${y2}`
          : `M ${x} ${y1} L ${x} ${y2}`;
        const lineCls = (link.process === 'receiver' ? 'ladder-source-line-receiver' : 'ladder-source-line-payer')
          + (link.isChallenger ? ' ladder-source-line-challenger' : '');
        svg += `<path d="${d}" fill="none" class="${lineCls}"></path>`;

        const rowA = rowKeys[lo];
        const rowB = rowKeys[hi];
        const directEntry = state.premiumEntries.find(
          (pe) => (pe.from === rowA && pe.to === rowB) || (pe.from === rowB && pe.to === rowA)
        );
        const hitClass = directEntry ? 'ladder-prem-editable' : '';
        const hitCursor = directEntry ? 'cursor:pointer;' : '';
        svg += `<path d="${d}" fill="none" stroke="transparent" stroke-width="8" class="${hitClass}" style="${hitCursor}" data-from="${rowA}" data-to="${rowB}"><title>${diffTooltip(rowA, rowB)}</title></path>`;
      });
    });

    svg += `</svg>`;
    return svg;
  }

  function renderQuoteScreen() {
    const wrap = document.getElementById('quoteLadderWrap');
    wrap.innerHTML = buildLadderSVG(state.solved.curve, state.matches, state.mismatches, state.anchorByNode);
    attachLadderEditing(wrap);
    renderMatchBanner();
    renderMismatchBanner();
  }

  /** Click any rate / premium on the ladder to edit it directly. */
  function attachLadderEditing(wrap) {
    wrap.style.position = 'relative';
    wrap.querySelectorAll('.ladder-val-editable').forEach((el) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => openLadderEditor(el, wrap));
    });
    wrap.querySelectorAll('.ladder-prem-editable').forEach((el) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => openLadderPremiumEditor(el, wrap));
    });
  }

  /** The row above (step -1) or below (step +1) a row on the ladder, in on-screen order. */
  function neighbourRow(node, step) {
    const order = state.shortcutOrder || [];
    const i = order.indexOf(node);
    return i === -1 ? null : (order[i + step] || null);
  }

  /** Opens the Rate editor on a row by key (same as clicking its rate). */
  function openRateEditorForTenor(tenor) {
    const rect = document.querySelector(`.ladder-val-editable[data-tenor="${tenor}"]`);
    const wrap = document.getElementById('quoteLadderWrap');
    if (rect && wrap) openLadderEditor(rect, wrap);
  }

  /** Opens the Premium editor between two rows (any two, adjacent or not). */
  function openPremiumEditorBetween(tenorA, tenorB) {
    if (!tenorA || !tenorB || tenorA === tenorB) return;
    const wrap = document.getElementById('quoteLadderWrap');
    if (!wrap) return;
    let target = wrap.querySelector(`.ladder-prem-editable[data-from="${tenorA}"][data-to="${tenorB}"]`)
      || wrap.querySelector(`.ladder-prem-editable[data-from="${tenorB}"][data-to="${tenorA}"]`);
    if (target) { openLadderPremiumEditor(target, wrap); return; }
    const rectA = document.querySelector(`.ladder-val-editable[data-tenor="${tenorA}"]`);
    const rectB = document.querySelector(`.ladder-val-editable[data-tenor="${tenorB}"]`);
    if (!rectA || !rectB) return;
    const rA = rectA.getBoundingClientRect();
    const rB = rectB.getBoundingClientRect();
    const marker = document.createElement('div');
    marker.style.position = 'fixed';
    marker.style.left = `${(rA.left + rB.left) / 2}px`;
    marker.style.top = `${(rA.top + rB.top) / 2}px`;
    marker.dataset.from = tenorA;
    marker.dataset.to = tenorB;
    document.body.appendChild(marker);
    openLadderPremiumEditor(marker, wrap);
    marker.remove();
  }

  function openLadderEditor(targetEl, wrap) {
    if (wrap.querySelector('.ladder-edit-input')) return;
    const tenor = targetEl.dataset.tenor;
    const rect = targetEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-input ladder-edit-input';
    // An Odd Date keeps its rate on the Odd Date itself, not in Rate Entries.
    const bdObj = isBrokenNode(tenor) ? brokenById(tenor) : null;
    const entry = bdObj ? { rate: bdObj.rate } : state.rateEntries.find((e) => e.node === tenor);
    input.placeholder = '30/40';
    input.value = entry && entry.rate ? entry.rate : '';
    attachAutoSlash(input);
    input.style.position = 'absolute';
    input.style.left = `${rect.left - wrapRect.left - 20}px`;
    input.style.top = `${rect.top - wrapRect.top - 4}px`;
    input.style.width = '90px';
    input.style.zIndex = '5';

    wrap.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    function commit() {
      if (done) return;
      done = true;
      const raw = input.value.trim();
      input.remove();
      applyLadderEdit(tenor, raw);
    }
    function cancel() {
      if (done) return;
      done = true;
      input.remove();
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') cancel();
      // Up/Down: save this rate and jump straight to the row above/below.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = neighbourRow(tenor, e.key === 'ArrowDown' ? 1 : -1);
        if (!next) return;
        commit();
        openRateEditorForTenor(next);
      }
    });
    input.addEventListener('blur', commit);
  }

  /** Per-side link info for a row: { bid: {source, process}|null, offer: ..., bidChallenger, offerChallenger }. */
  function autoLinkInfoFor(tenor) {
    const best = (state.swapBest || {})[tenor] || {};
    const side = (cand) => (cand && cand.source && cand.source !== 'outright') ? { source: cand.source, process: cand.process } : null;
    const challenger = (winner, createdOnly) => {
      if (!winner || winner.source !== 'outright') return null;
      if (!createdOnly || !isNum(createdOnly.val) || !createdOnly.source) return null;
      if (roundsToSame(winner.val, createdOnly.val)) return null;
      return { source: createdOnly.source, process: createdOnly.process };
    };
    return {
      bid: side(best.bid),
      offer: side(best.offer),
      bidChallenger: challenger(best.bid, best.bidCreatedOnly),
      offerChallenger: challenger(best.offer, best.offerCreatedOnly),
    };
  }

  function applyLadderEdit(tenor, raw) {
    // Odd/Broken Date: write the typed rate onto the Odd Date itself.
    if (isBrokenNode(tenor)) {
      const bd = brokenById(tenor);
      if (bd) bd.rate = raw;
      recompute();
      renderPremiumTable();
      renderDownstream();
      scheduleSaveDraft();
      return;
    }

    let entry = state.rateEntries.find((e) => e.node === tenor);
    if (!raw) {
      if (entry) state.rateEntries = state.rateEntries.filter((e) => e.id !== entry.id);
    } else if (entry) {
      entry.rate = raw;
    } else {
      state.rateEntries.push({ id: nextRateId++, node: tenor, rate: raw });
    }
    recompute();
    renderRateTable();
    renderDownstream();
    scheduleSaveDraft();
  }

  function openLadderPremiumEditor(targetEl, wrap) {
    if (wrap.querySelector('.ladder-edit-input')) return;
    const fromNode = targetEl.dataset.from;
    const toNode = targetEl.dataset.to;
    const rect = targetEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();

    const entry = state.premiumEntries.find(
      (pe) => (pe.from === fromNode && pe.to === toNode) || (pe.from === toNode && pe.to === fromNode)
    );

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-input ladder-edit-input';
    input.placeholder = '5/5.5';
    input.value = entry ? entry.premium : '';
    attachAutoSlash(input, false);
    input.style.position = 'absolute';
    input.style.left = `${rect.left - wrapRect.left - 20}px`;
    input.style.top = `${rect.top - wrapRect.top - 4}px`;
    input.style.width = '90px';
    input.style.zIndex = '5';

    wrap.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    function commit() {
      if (done) return;
      done = true;
      const raw = input.value.trim();
      input.remove();
      applyLadderPremiumEdit(entry, fromNode, toNode, raw);
    }
    function cancel() {
      if (done) return;
      done = true;
      input.remove();
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') cancel();
      // Up/Down: save this premium and jump to the gap above/below.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const order = state.shortcutOrder || [];
        const iA = order.indexOf(fromNode);
        const iB = order.indexOf(toNode);
        if (iA === -1 || iB === -1) return;
        const lo = Math.min(iA, iB);
        const hi = Math.max(iA, iB);
        const pair = e.key === 'ArrowDown' ? [order[hi], order[hi + 1]] : [order[lo - 1], order[lo]];
        if (!pair[0] || !pair[1]) return;
        commit();
        openPremiumEditorBetween(pair[0], pair[1]);
      }
    });
    input.addEventListener('blur', commit);
  }

  function applyLadderPremiumEdit(existingEntry, fromNode, toNode, raw) {
    if (!raw) {
      if (existingEntry) state.premiumEntries = state.premiumEntries.filter((pe) => pe.id !== existingEntry.id);
    } else if (existingEntry) {
      existingEntry.premium = raw;
    } else {
      // Always stored chronologically (earlier -> later), whichever order
      // the two rows were picked in.
      const [f, t] = orderChronologically(fromNode, toNode);
      const perDay = NEAR_DATES.includes(f) || NEAR_DATES.includes(t);
      state.premiumEntries.push({ id: nextPremiumId++, from: f, to: t, premium: raw, perDay });
    }
    recompute();
    renderPremiumTable();
    renderDownstream();
    scheduleSaveDraft();
  }

  function renderMatchBanner() {
    const el = document.getElementById('matchBanner');
    if (!el) return;
    const matches = state.matches || [];
    if (!matches.length) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    el.innerHTML = matches.map((m) => `
      <div class="match-line match-${m.side}">
        ✓ ${nodeLabel(m.from)}→${nodeLabel(m.to)} ${m.side === 'payer' ? 'Payer' : 'Receiver'}
      </div>
    `).join('');
  }

  function renderMismatchBanner() {
    // Mismatch warnings turned off — detection still runs in recompute().
    const el = document.getElementById('mismatchBanner');
    if (!el) return;
    el.style.display = 'none';
    el.innerHTML = '';
  }

  /* ==================================================================
     RENDER: Odd / Broken Dates
     ================================================================== */

  /** Adds a new Odd/Broken Date (or reuses an existing row) and jumps to its Rate input. */
  function addOrFocusBrokenDate(iso, focusRate = true) {
    let entry = state.brokenDates.find((bd) => bd.dateStr === iso);
    if (!entry) {
      entry = { id: nextBrokenDateId++, dateStr: iso, rate: '' };
      state.brokenDates.push(entry);
      recompute();
      renderPremiumTable();
      renderDownstream();
      scheduleSaveDraft();
    }
    // A Rate is optional — an odd date can be added on its own and linked
    // later with a Premium, so only jump into the Rate box when asked to.
    if (!focusRate) return;
    requestAnimationFrame(() => {
      const rateInput = document.querySelector(`[data-broken-rate-id="${entry.id}"]`);
      if (!rateInput) return;
      rateInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => rateInput.focus(), 250);
    });
  }

  function renderBrokenDates() {
    const tbody = document.getElementById('brokenDateTableBody');
    if (!tbody) return;

    // This table is rebuilt on EVERY keystroke (typing a rate recomputes
    // and re-renders downstream). Without preserving state, the box being
    // typed in is destroyed after one character, focus drops to the page,
    // and the next digits fire the keyboard shortcuts instead. So snapshot
    // the focused field (with caret) and the mini premium forms first,
    // and put them back after the rebuild.
    const snap = { prem: {}, focus: null };
    tbody.querySelectorAll('[data-broken-prem-tenor]').forEach((el) => { snap.prem['t' + el.dataset.brokenPremTenor] = el.value; });
    tbody.querySelectorAll('[data-broken-prem-value]').forEach((el) => { snap.prem['v' + el.dataset.brokenPremValue] = el.value; });
    const activeEl = document.activeElement;
    if (activeEl && tbody.contains(activeEl)) {
      const attr = ['data-broken-rate-id', 'data-broken-date-id', 'data-broken-prem-value', 'data-broken-prem-tenor']
        .find((a) => activeEl.hasAttribute(a));
      if (attr) {
        snap.focus = { attr, id: activeEl.getAttribute(attr), start: activeEl.selectionStart, end: activeEl.selectionEnd };
      }
    }

    tbody.innerHTML = '';
    state.brokenDates
      .slice()
      .sort((a, b) => FXCalendar.parse(a.dateStr) - FXCalendar.parse(b.dateStr))
      .forEach((bd) => {
        const targetDate = FXCalendar.parse(bd.dateStr);
        const result = FXCalculator.interpolateBrokenDate(state.solved.curve, targetDate, state.valueDates.spot);
        const tr = document.createElement('tr');
        const dateInputCell = `<td><input type="text" class="cell-input" style="width:110px;" placeholder="DD-MM-YYYY" data-broken-date-id="${bd.id}" value="${isoToDisplayDate(bd.dateStr)}"></td>`;
        const rateInputCell = `<td><input type="text" class="cell-input shorthand" style="width:90px;" placeholder="typed rate" data-broken-rate-id="${bd.id}" value="${bd.rate || ''}"></td>`;

        // Priority: typed Rate (Outright) > value created through the
        // premium graph (swapBest, labelled "(chain)") > piecewise
        // interpolation (labelled "(interp)").
        const typedAnchor = (state.anchorByNode || {})[`bd:${bd.id}`] || {};
        const typed = { bid: typedAnchor.bid, offer: typedAnchor.offer };
        const hasTypedPayer = isNum(typed.bid);
        const hasTypedReceiver = isNum(typed.offer);
        const sb = (state.swapBest || {})[`bd:${bd.id}`];
        const chainPayer = sb && isNum(sb.bid.val) && sb.bid.source !== 'outright' ? sb.bid.val : null;
        const chainReceiver = sb && isNum(sb.offer.val) && sb.offer.source !== 'outright' ? sb.offer.val : null;

        const premiumMiniForm = `
          <td>
            <div style="display:flex; gap:4px; align-items:center;">
              <select class="cell-input" style="width:64px; padding:4px 2px;" data-broken-prem-tenor="${bd.id}">
                ${visibleTenors().map((t) => `<option value="${t}">${LABELS[t]}</option>`).join('')}
              </select>
              <input type="text" class="cell-input shorthand" style="width:56px;" placeholder="5/5.5" data-broken-prem-value="${bd.id}">
              <button class="btn" style="padding:3px 6px;" data-broken-prem-add="${bd.id}" title="Add/update this premium">+</button>
            </div>
          </td>`;

        if (!result && !hasTypedPayer && !hasTypedReceiver && chainPayer === null && chainReceiver === null) {
          tr.innerHTML = `
            ${dateInputCell}
            ${rateInputCell}
            <td colspan="3" class="val-muted">No rate needed yet — it is on the ladder; type a Rate, or link it with a Premium (right)</td>
            ${premiumMiniForm}
            <td><button class="btn danger" data-remove-broken="${bd.id}" style="padding:3px 8px;">✕</button></td>
          `;
        } else {
          const interpPayer = isNum(state.solved.payerSpotBid) && result && isNum(result.payerPremium)
            ? state.solved.payerSpotBid + result.payerPremium : null;
          const interpReceiver = isNum(state.solved.receiverSpotOffer) && result && isNum(result.receiverPremium)
            ? state.solved.receiverSpotOffer + result.receiverPremium : null;
          const payerRate = hasTypedPayer ? typed.bid : (chainPayer !== null ? chainPayer : interpPayer);
          const receiverRate = hasTypedReceiver ? typed.offer : (chainReceiver !== null ? chainReceiver : interpReceiver);
          const payerTag = hasTypedPayer ? '' : (chainPayer !== null ? ' (chain)' : ' (interp)');
          const receiverTag = hasTypedReceiver ? '' : (chainReceiver !== null ? ' (chain)' : ' (interp)');
          const daysLabel = result ? result.days : FXCalendar.calendarDaysBetween(state.valueDates.spot, targetDate);
          tr.innerHTML = `
            ${dateInputCell}
            ${rateInputCell}
            <td class="mono">${daysLabel}</td>
            <td class="mono ${hasTypedPayer ? 'ladder-src-outright' : 'ladder-src-created'}">${fmtNum(payerRate, decimalsFor(payerRate))}${payerTag}</td>
            <td class="mono ${hasTypedReceiver ? 'ladder-src-outright' : 'ladder-src-created'}">${fmtNum(receiverRate, decimalsFor(receiverRate))}${receiverTag}</td>
            ${premiumMiniForm}
            <td><button class="btn danger" data-remove-broken="${bd.id}" style="padding:3px 8px;">✕</button></td>
          `;
        }
        tbody.appendChild(tr);
      });


    tbody.querySelectorAll('[data-broken-prem-value]').forEach((el) => attachAutoSlash(el, false));

    tbody.querySelectorAll('[data-broken-prem-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bdId = Number(btn.dataset.brokenPremAdd);
        const row = btn.closest('tr');
        const tenorSel = row ? row.querySelector(`[data-broken-prem-tenor="${bdId}"]`) : null;
        const valInput = row ? row.querySelector(`[data-broken-prem-value="${bdId}"]`) : null;
        const tenor = tenorSel ? tenorSel.value : '';
        const raw = valInput ? valInput.value.trim() : '';
        if (!tenor || !raw) return;
        const bdNode = `bd:${bdId}`;
        // Premium Entries are always chronological (earlier -> later), so
        // an odd date that falls BEFORE the picked tenor goes odd -> tenor.
        const [fromN, toN] = orderChronologically(tenor, bdNode);
        let entry = state.premiumEntries.find((pe) => (pe.from === fromN && pe.to === toN) || (pe.from === toN && pe.to === fromN));
        if (entry) {
          entry.premium = raw;
        } else {
          state.premiumEntries.push({
            id: nextPremiumId++, from: fromN, to: toN, premium: raw,
            perDay: NEAR_DATES.includes(fromN) || NEAR_DATES.includes(toN),
          });
        }
        recompute();
        renderPremiumTable();
        renderDownstream();
        scheduleSaveDraft();
      });
    });

    tbody.querySelectorAll('[data-broken-date-id]').forEach((input) => {
      input.addEventListener('change', () => {
        const entry = state.brokenDates.find((e) => e.id === Number(input.dataset.brokenDateId));
        if (!entry) return;
        const iso = parseFlexibleDateToISO(input.value);
        if (!iso) { alert('Could not read that date — use DD-MM-YYYY, e.g. 15-09-2026.'); renderBrokenDates(); return; }
        entry.dateStr = iso;
        // A changed date can flip chronological order against linked
        // tenors, so re-orient any Premium Entry touching this node.
        const node = `bd:${entry.id}`;
        state.premiumEntries.forEach((pe) => {
          if (pe.from === node || pe.to === node) {
            const [f, t] = orderChronologically(pe.from, pe.to);
            pe.from = f; pe.to = t;
          }
        });
        recompute();
        renderPremiumTable();
        renderDownstream();
        scheduleSaveDraft();
      });
    });

    tbody.querySelectorAll('[data-broken-rate-id]').forEach((input) => {
      attachAutoSlash(input);
      input.addEventListener('input', () => {
        const entry = state.brokenDates.find((e) => e.id === Number(input.dataset.brokenRateId));
        if (!entry) return;
        entry.rate = input.value;
        recompute();
        renderPremiumTable();
        renderDownstream();
        scheduleSaveDraft();
      });
    });

    tbody.querySelectorAll('[data-remove-broken]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.brokenDates = state.brokenDates.filter((e) => e.id !== Number(btn.dataset.removeBroken));
        recompute();
        renderPremiumTable();
        renderDownstream();
        scheduleSaveDraft();
      });
    });

    // Restore what was typed in the mini premium forms, then focus + caret.
    Object.keys(snap.prem).forEach((k) => {
      const id = k.slice(1);
      const el = tbody.querySelector(k[0] === 't' ? `[data-broken-prem-tenor="${id}"]` : `[data-broken-prem-value="${id}"]`);
      if (el) el.value = snap.prem[k];
    });
    if (snap.focus) {
      const el = tbody.querySelector(`[${snap.focus.attr}="${snap.focus.id}"]`);
      if (el) {
        el.focus();
        try {
          if (snap.focus.start != null) el.setSelectionRange(snap.focus.start, snap.focus.end);
        } catch (e) { /* select elements have no caret */ }
      }
    }
  }

  /* ==================================================================
     RENDER: Value Dates
     ================================================================== */
  function renderValueDates() {
    const tbody = document.getElementById('valueDateTableBody');
    if (!tbody) return;
    tbody.innerHTML = visibleTenors().map((t) => {
      const d = state.valueDates.dates[t];
      const nod = NEAR_DATES.includes(t) || t === 'spot' ? state.valueDates.daysFromCash[t] : state.valueDates.days[t];
      const dateCell = d ? fmtDateLabel(d) : '—';
      return `
        <tr>
          <td class="tenor-name">${LABELS[t]}</td>
          <td class="mono">${dateCell}</td>
          <td class="mono" style="text-align:right;">${isNum(nod) ? nod : '—'}</td>
          <td><input type="text" class="cell-input" style="width:110px;" placeholder="DD-MM-YYYY" data-value-date-tenor="${t}" value="${isoToDisplayDate(state.valueDateOverrides[t])}"></td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-value-date-tenor]').forEach((input) => {
      input.addEventListener('change', () => {
        const t = input.dataset.valueDateTenor;
        if (!input.value.trim()) {
          delete state.valueDateOverrides[t];
        } else {
          const iso = parseFlexibleDateToISO(input.value);
          if (!iso) { alert('Could not read that date — use DD-MM-YYYY, e.g. 15-09-2026.'); return; }
          state.valueDateOverrides[t] = iso;
        }
        recompute();
        renderRateTable();
        renderPremiumTable();
        renderDownstream();
        renderValueDates();
        scheduleSaveDraft();
      });
    });
  }

  /* ==================================================================
     Theme
     ================================================================== */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('themeToggle').textContent = theme === 'dark' ? '☾ Dark' : '☀ Light';
    FXStorage.saveSettings({ theme });
  }

  function renderDownstream() {
    renderQuoteScreen();
    renderSolverStatus();
    renderBrokenDates();
    renderValueDates();
    refreshTenorSelects();
  }

  /* ==================================================================
     Wire up static controls
     ================================================================== */
  function wireStaticControls() {
    attachAutoSlash(document.getElementById('bulkPremiumValue'), false);

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

    populatePremiumSelect(document.getElementById('newPremiumFrom'));
    populatePremiumSelect(document.getElementById('newPremiumTo'));
    document.getElementById('newPremiumFrom').value = isCashHidden() ? (isTomHidden() ? 'spot' : 'tom') : 'cash';
    document.getElementById('newPremiumTo').value = 'spot';
    document.getElementById('addPremiumBtn').addEventListener('click', () => {
      const pickedFrom = document.getElementById('newPremiumFrom').value;
      const pickedTo = document.getElementById('newPremiumTo').value;
      if (pickedFrom === pickedTo) { alert('Pick two different value dates.'); return; }
      // Always stored earlier -> later, whichever order they were picked in.
      const [from, to] = orderChronologically(pickedFrom, pickedTo);
      state.premiumEntries.push({
        id: nextPremiumId++, from, to, premium: '',
        perDay: NEAR_DATES.includes(from) || NEAR_DATES.includes(to),
      });
      renderPremiumTable();
      scheduleSaveDraft();
      const inputs = document.querySelectorAll('#premiumTableBody input[type="text"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });

    populatePremiumSelect(document.getElementById('bulkPremiumFrom'));
    populatePremiumSelect(document.getElementById('bulkPremiumTo'));
    document.getElementById('bulkPremiumFrom').value = isCashHidden() ? (isTomHidden() ? 'spot' : 'tom') : 'cash';
    document.getElementById('addBulkPremiumBtn').addEventListener('click', () => {
      const from = document.getElementById('bulkPremiumFrom').value;
      const toSelect = document.getElementById('bulkPremiumTo');
      const targets = Array.from(toSelect.selectedOptions).map((o) => o.value).filter((v) => v !== from);
      const premiumVal = document.getElementById('bulkPremiumValue').value.trim();
      const perDay = document.getElementById('bulkPremiumPerDay').checked;
      if (!targets.length) { alert('Select at least one Tenor 2 (ctrl/cmd-click or drag to pick several).'); return; }
      if (!premiumVal) { alert('Type the premium value to apply to all selected tenors, e.g. 5/5.5.'); return; }
      let added = 0;
      targets.forEach((target) => {
        const [f, t] = orderChronologically(from, target);
        const existing = state.premiumEntries.find((e) => e.from === f && e.to === t);
        if (existing) {
          existing.premium = premiumVal;
          existing.perDay = perDay;
        } else {
          state.premiumEntries.push({ id: nextPremiumId++, from: f, to: t, premium: premiumVal, perDay });
        }
        added++;
      });
      Array.from(toSelect.options).forEach((o) => { o.selected = false; });
      document.getElementById('bulkPremiumValue').value = '';
      document.getElementById('bulkPremiumPerDay').checked = false;
      recompute();
      renderPremiumTable();
      renderDownstream();
      scheduleSaveDraft();
      alert(`Added premium ${premiumVal} to ${added} tenor${added === 1 ? '' : 's'}.`);
    });

    // Typed date: add it with NO rate and keep the cursor in the date box,
    // so several odd dates can be added back to back (Enter or the button).
    const addTypedBrokenDate = () => {
      const input = document.getElementById('newBrokenDateInput');
      if (!input.value.trim()) { alert('Type a date first, e.g. 15-09-2026.'); return; }
      const iso = parseFlexibleDateToISO(input.value);
      if (!iso) { alert('Could not read that date — use DD-MM-YYYY, e.g. 15-09-2026.'); return; }
      input.value = '';
      addOrFocusBrokenDate(iso, false);
      input.focus();
    };
    document.getElementById('addBrokenDateBtn').addEventListener('click', addTypedBrokenDate);
    document.getElementById('newBrokenDateInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addTypedBrokenDate(); }
    });

    const newBrokenDatePicker = document.getElementById('newBrokenDatePicker');
    if (newBrokenDatePicker) {
      newBrokenDatePicker.addEventListener('change', () => {
        const iso = newBrokenDatePicker.value;
        if (!iso) return;
        addOrFocusBrokenDate(iso);
        newBrokenDatePicker.value = '';
      });

      const openPicker = () => {
        try {
          if (typeof newBrokenDatePicker.showPicker === 'function') newBrokenDatePicker.showPicker();
          else newBrokenDatePicker.focus();
        } catch (e) { newBrokenDatePicker.focus(); }
      };
      newBrokenDatePicker.addEventListener('click', openPicker);
      const openBtn = document.getElementById('openDatePickerBtn');
      if (openBtn) openBtn.addEventListener('click', openPicker);
    }

    document.getElementById('clearInputsBtn').addEventListener('click', () => {
      if (!confirm('Clear every input field?')) return;
      state.rateEntries = [];
      state.premiumEntries = [];
      state.brokenDates = [];
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

  function upsertRateEntry(node, rateStr) {
    const existing = state.rateEntries.find((e) => e.node === node);
    if (existing) { existing.rate = rateStr; }
    else { state.rateEntries.push({ id: nextRateId++, node, rate: rateStr }); }
  }

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
    wireTabs();
    wireKeyboardShortcuts();
    renderAllViews();
  }

  /**
   * Single-key shortcuts: every ladder row gets one character based on
   * its ACTUAL on-screen position (0-9, then a, b, c…). One key opens
   * that row's Rate editor (Odd Dates included); two keys back to back
   * (e.g. "13" or "af") open the PREMIUM editor between those two rows.
   * A lone key waits PAIR_WAIT_MS to see whether a second one follows.
   * Suppressed while any input/textarea/select is focused.
   */
  function wireKeyboardShortcuts() {
    const PAIR_WAIT_MS = 450;
    let pendingIndex = null;
    let pendingTimer = null;

    function tenorAt(idx) { return (state.shortcutOrder || TENORS)[idx]; }

    function openRateEditorFor(idx) {
      const tenor = tenorAt(idx);
      if (!tenor) return;
      const rect = document.querySelector(`.ladder-val-editable[data-tenor="${tenor}"]`);
      const wrap = document.getElementById('quoteLadderWrap');
      if (rect && wrap) openLadderEditor(rect, wrap);
    }

    function openPremiumEditorFor(idxA, idxB) {
      const tenorA = tenorAt(idxA);
      const tenorB = tenorAt(idxB);
      if (!tenorA || !tenorB || tenorA === tenorB) return;
      const wrap = document.getElementById('quoteLadderWrap');
      if (!wrap) return;

      let target = wrap.querySelector(`.ladder-prem-editable[data-from="${tenorA}"][data-to="${tenorB}"]`)
        || wrap.querySelector(`.ladder-prem-editable[data-from="${tenorB}"][data-to="${tenorA}"]`);

      if (!target) {
        const rectA = document.querySelector(`.ladder-val-editable[data-tenor="${tenorA}"]`);
        const rectB = document.querySelector(`.ladder-val-editable[data-tenor="${tenorB}"]`);
        if (!rectA || !rectB) return;
        const rA = rectA.getBoundingClientRect();
        const rB = rectB.getBoundingClientRect();
        const marker = document.createElement('div');
        marker.style.position = 'fixed';
        marker.style.left = `${(rA.left + rB.left) / 2}px`;
        marker.style.top = `${(rA.top + rB.top) / 2}px`;
        marker.dataset.from = tenorA;
        marker.dataset.to = tenorB;
        document.body.appendChild(marker);
        openLadderPremiumEditor(marker, wrap);
        marker.remove();
        return;
      }

      openLadderPremiumEditor(target, wrap);
    }

    function resetPending() {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      pendingIndex = null;
    }

    function indexResolved(idx) {
      if (pendingIndex !== null) {
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
        const first = pendingIndex;
        pendingIndex = null;
        openPremiumEditorFor(first, idx);
      } else {
        pendingIndex = idx;
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          const idxToOpen = pendingIndex;
          pendingIndex = null;
          openRateEditorFor(idxToOpen);
        }, PAIR_WAIT_MS);
      }
    }

    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      const isEditing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);
      if (isEditing) { resetPending(); return; }

      const key = e.key.toLowerCase();
      const idx = shortcutIndexFor(key);

      if (idx !== null) {
        e.preventDefault();
        indexResolved(idx);
        return;
      }

      if (pendingIndex !== null) {
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
        const pending = pendingIndex;
        pendingIndex = null;
        openRateEditorFor(pending);
      }
    });
  }

  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.view).classList.add('active');
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
