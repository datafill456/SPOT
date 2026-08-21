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
    brokenDates: [],     // [{ id, dateStr: 'YYYY-MM-DD' }] — odd/custom tenor dates
    selectedTenors: [], // up to 2 tenors picked via the 🔗 button — [first=anchor, second=compare] shows one curve + a detail message
    valueDateOverrides: {}, // { tenor: 'YYYY-MM-DD' } — manual correction if the computed date is wrong
    valueDates: null,
    solved: null,
    tenorRelations: [],
    matches: [], // [{ from, to, side }] — typed rate agrees with typed premium
    mismatches: [], // [{ from, to, side, typedPremiumPts, actualDiffPts, offPts, suggestedFromRate, suggestedToRate }]
  };

  let nextRateId = 1;
  let nextPremiumId = 1;
  let nextBrokenDateId = 1;

  function todayKey() {
    return FXCalendar.fmt(state.tradeDate);
  }

  function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }

  /**
   * Native <input type="date"> pickers can be awkward to type a year into
   * on some browsers/devices, so date correction/entry fields use a plain
   * text input instead. Accepts DD-MM-YYYY, DD/MM/YYYY, or YYYY-MM-DD
   * (typed with any of -, /, . as separators) and returns ISO
   * 'YYYY-MM-DD', or null if it doesn't look like a real date.
   */
  function parseFlexibleDateToISO(str) {
    if (!str || !str.trim()) return null;
    const parts = str.trim().split(/[-/.]/).map((p) => p.trim());
    if (parts.length !== 3) return null;
    let y, m, d;
    if (parts[0].length === 4) { [y, m, d] = parts; } // YYYY-MM-DD
    else { [d, m, y] = parts; } // DD-MM-YYYY
    y = parseInt(y, 10); m = parseInt(m, 10); d = parseInt(d, 10);
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return null;
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null; // rejects e.g. 31-02-2026
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  /** ISO 'YYYY-MM-DD' -> 'DD-MM-YYYY' for display in the text date fields. */
  function isoToDisplayDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    if (!y || !m || !d) return '';
    return `${d}-${m}-${y}`;
  }
  function roundsToSame(a, b, dp = 2) {
    return isNum(a) && isNum(b) && a.toFixed(dp) === b.toFixed(dp);
  }

  /* ---------------- Shorthand parsing ---------------- */

  /** "30/40" + bigFigure "336" -> {bid:336.30, offer:336.40}, with big-figure rollover
   *  ("30/10" with BF 336 -> 336.30/337.10, since offer's points < bid's points). */
  /**
   * The Big Figure the dealer types is for Spot. Near-dates (Cash/Tom)
   * virtually never accumulate enough premium to cross into the next
   * hundred, so they share Spot's Big Figure unchanged. Forward tenors
   * (1W and beyond) accumulate real swap points day by day and CAN cross
   * a hundred over enough calendar days — so when there's no other way
   * to know that tenor's Big Figure yet (no premium chain solved to it),
   * estimate the rollover using a typical desk premium of ~5.5 points/day
   * (the middle of the ~4-6 short-leg / ~5-6 per-day forward range) times
   * the tenor's real calendar days from Spot.
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

  /** "5/5.5" -> {payer:5, receiver:5.5}, literal (no big-figure scaling). A single value with NO slash means only a Payer premium was actually quoted — it is NOT duplicated onto Receiver. */
  function parsePremiumShorthand(str) {
    const empty = { payer: null, receiver: null };
    if (!str || !str.trim()) return empty;
    const parts = str.split('/').map((s) => s.trim());
    const resolve = (p) => { const v = parseFloat(p); return isFinite(v) ? v : null; };
    if (parts.length === 1) { const v = resolve(parts[0]); return { payer: v, receiver: null }; }
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

    // Manual correction for any tenor whose computed date is wrong (a
    // missing holiday, an edge case in the roll convention, etc.) —
    // everything downstream reads dates/days straight off this map, so
    // overriding here is enough to correct premium math too.
    Object.keys(state.valueDateOverrides).forEach((t) => {
      const iso = state.valueDateOverrides[t];
      if (!iso || !state.valueDates.dates[t]) return;
      const d = FXCalendar.parse(iso);
      state.valueDates.dates[t] = d;
      state.valueDates.days[t] = FXCalendar.calendarDaysBetween(state.valueDates.spot, d);
      state.valueDates.daysFromCash[t] = FXCalendar.calendarDaysBetween(state.valueDates.cash, d);
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

    // Pass 1: resolve every Rate Entry with a best-guess Big Figure —
    // Spot and near-dates use the typed Big Figure unchanged; forward
    // tenors get a rollover estimate from typical desk premium sizes, as
    // a fallback for when nothing better is available yet. A dealer-set
    // override on that specific Rate Entry always wins over both.
    const guesses = state.rateEntries.map((re) => {
      const override = parseFloat(re.bigFigureOverride);
      const hasOverride = isFinite(override);
      const bfGuess = hasOverride ? override : estimateBigFigureForTenor(re.node, baseBF, state.valueDates.days);
      const r = parseRateShorthand(re.rate, bfGuess);
      return { node: re.node, rateStr: re.rate, bid: r.bid, offer: r.offer, hasOverride };
    });
    const provisionalAnchors = guesses.filter((g) => g.bid !== null || g.offer !== null);
    const provisional = FXCalculator.solveMarket(edges, provisionalAnchors, state.valueDates);
    const spotGuess = guesses.find((g) => g.node === 'spot');

    // Pass 2: wherever the premium graph independently connects a forward
    // tenor back to Spot (regardless of any Big Figure guess), that's a
    // far more reliable Big Figure than the flat per-day estimate —
    // re-resolve the same typed shorthand against Spot's real rate plus
    // that actual premium instead. Skipped entirely for a Rate Entry with
    // its own explicit override — that's the dealer overruling both
    // guesses on purpose, so it's never auto-corrected back.
    const anchors = guesses.map((g) => {
      if (g.hasOverride || g.node === 'spot' || NEAR_DATES.includes(g.node) || !spotGuess) return g;
      const provRow = provisional.curve[g.node];
      const premRel = isNum(provRow.payerPremium) ? provRow.payerPremium : provRow.receiverPremium;
      if (!isNum(premRel)) return g; // no better info yet — keep the heuristic guess
      const expected = isNum(spotGuess.bid) ? spotGuess.bid + premRel
        : isNum(spotGuess.offer) ? spotGuess.offer + premRel : null;
      if (expected === null) return g;
      const firstRaw = parseFloat((g.rateStr || '').split('/')[0]);
      if (!isFinite(firstRaw) || Math.abs(firstRaw) >= 100) return g; // was a full rate, not shorthand
      const refinedBF = Math.round(expected - firstRaw / 100);
      const r = parseRateShorthand(g.rateStr, refinedBF);
      return { node: g.node, rateStr: g.rateStr, bid: r.bid, offer: r.offer };
    }).filter((g) => g.bid !== null || g.offer !== null);

    state.solved = FXCalculator.solveMarket(edges, anchors, state.valueDates);
    // The solver only keeps ONE anchor per connected component (whichever
    // came first), so a tenor with its OWN directly-typed rate can still
    // get silently overridden by a value derived from a different
    // tenor's anchor + the premium chain. Keep the raw typed anchors here
    // so the ladder can always show what was actually typed for a tenor
    // that has one, rather than a derived figure the dealer never entered.
    state.anchors = anchors;
    state.anchorByNode = {};
    anchors.forEach((a) => { state.anchorByNode[a.node] = a; });
    state.tenorRelations = FXCalculator.computeTenorRelations(anchors, state.valueDates.days);
    state.swapBest = computeSwapBest();

    // Match detection: a Premium Entry "confirms" against the board when
    // BOTH its endpoints also have a directly-typed Rate Entry (not a
    // derived value) and that typed difference agrees with the typed
    // premium, within a small rounding tolerance.
    const TOL = 0.005; // half a point — rates display to 2dp (1pt precision), so anything tighter than this is just rounding noise, not a real mismatch
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
          state.matches.push({ from: pe.from, to: pe.to, side: 'payer', direct: true });
        } else {
          const suggestedFromRate = toAnchor.bid - payerEdge;
          const suggestedToRate = fromAnchor.bid + payerEdge;
          // Only offer a rate suggestion if it wouldn't invert that
          // tenor's own market (a bid can't end up above its own offer).
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

    // Generalized cross-check: ANY two directly-typed Rate Entries that
    // are connected through the premium graph — even with no single
    // Premium Entry directly between them, e.g. Cash to 1M via Spot/1W —
    // get checked against the graph's own chained premium between them.
    // Pairs that already have a direct Premium Entry are skipped here
    // since those were just handled above with an editable suggestion.
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
   * For a tenor reachable through more than one direct Premium Entry
   * (e.g. Cash→1M, Spot→1M, and Tom→1M all typed), the single graph
   * solve only ever follows ONE of those paths — the rest are silently
   * ignored for display purposes. This works out every direct-entry
   * candidate for a given (chain, price) combination and keeps the best
   * one: the LARGER value for a bid, the SMALLER value for an offer —
   * since a higher bid or a lower offer is the more competitive price.
   *
   * chain is which premium (Payer or Receiver points) built the edge;
   * price is which side of the resulting rate we're deriving (bid or
   * offer). These are independent: e.g. a Payer-points chain run against
   * an OFFER anchor (curve.payerOffer) is exactly how you'd build an
   * offer price for an earlier tenor when only a future tenor's offer
   * was ever typed — the bid chain has nothing to anchor to, but the
   * offer chain does, and that's still a real, usable number.
   *
   * Each candidate is built from the OTHER tenor's own main-solve price
   * shifted by that entry's premium, so this never recurses. The
   * tenor's own single-path main-solve result is always included as one
   * candidate too, so with only one connecting entry nothing changes.
   */
  function computeCandidateBest(t, chain, price) {
    const curve = state.solved.curve;
    const key = chain + (price === 'bid' ? 'Bid' : 'Offer'); // payerBid / payerOffer / receiverBid / receiverOffer
    const candidates = [{ source: null, val: curve[t] ? curve[t][key] : null }];

    state.premiumEntries.forEach((pe) => {
      if (pe.from !== t && pe.to !== t) return;
      const other = pe.from === t ? pe.to : pe.from;
      const otherC = curve[other];
      if (!otherC || !isNum(otherC[key])) return;
      const prem = parsePremiumShorthand(pe.premium);
      const rawVal = chain === 'payer' ? prem.payer : prem.receiver;
      const edge = premiumToEdgeValue(pe.from, pe.to, rawVal, pe.perDay); // value from pe.from -> pe.to
      if (!isNum(edge)) return;
      const goingForward = pe.to === t; // true: other is earlier, edge adds onto other to reach t
      const val = goingForward ? otherC[key] + edge : otherC[key] - edge;
      candidates.push({ source: other, val });
    });

    let best = null;
    candidates.forEach((cand) => {
      if (!isNum(cand.val)) return;
      if (!best || (price === 'bid' ? cand.val > best.val : cand.val < best.val)) best = cand;
    });
    return best ? { val: best.val, source: best.source } : { val: null, source: null };
  }

  function computeSwapBest() {
    const best = {};
    TENORS.forEach((t) => {
      best[t] = {
        payerBid: computeCandidateBest(t, 'payer', 'bid'),
        payerOffer: computeCandidateBest(t, 'payer', 'offer'),
        receiverBid: computeCandidateBest(t, 'receiver', 'bid'),
        receiverOffer: computeCandidateBest(t, 'receiver', 'offer'),
      };
    });
    return best;
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

  /**
   * The ladder shows standard tenors AND any Odd/Broken Dates the dealer
   * has added, merged into one list and sorted chronologically by real
   * value date — so an odd date slots in exactly where it belongs in
   * time (e.g. between 1M and 2M if that's where it falls), not bolted
   * on at the end.
   */
  function buildDisplayRows() {
    const rows = TENORS.map((t) => ({
      key: t,
      kind: 'tenor',
      label: LABELS[t],
      date: state.valueDates.dates[t],
    }));
    (state.brokenDates || []).forEach((bd) => {
      const date = FXCalendar.parse(bd.dateStr);
      rows.push({ key: `bd:${bd.id}`, kind: 'broken', label: fmtDateLabel(date), date, bd });
    });
    rows.sort((a, b) => a.date - b.date);
    return rows;
  }

  function buildLadderSVG(curve, matches, mismatches, anchorByNode, selectedTenors) {
    const rows = buildDisplayRows();
    const n = rows.length;
    const rowH = 48;
    const slot = 62;
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

    let svg = `<svg class="ladder-svg" viewBox="0 0 620 ${height}" width="100%" role="img" aria-label="Payer and Receiver rate ladder with premium brackets">`;
    svg += `<text x="${payerX}" y="14" class="ladder-heading">Payer</text>`;
    svg += `<text x="${receiverX + colW}" y="14" text-anchor="end" class="ladder-heading">Receiver</text>`;

    rows.forEach((row, i) => {
      const t = row.key;
      const y = rowY(i);
      const cy = rowCenterY(i);
      const nameY = y + 17;
      const bigfigY = y + 33;
      const outrightY = y + 14;
      const swapY = y + 29;
      const premY = y + 43;

      let rowLabel, outrightPayerVal, outrightReceiverVal, swapPayerVal, swapReceiverVal,
        swapPayerIsFallback = false, swapReceiverIsFallback = false,
        payerPremLabel, receiverPremLabel, bigFigLabel, rowExtraClass = '', showRelationsBtn = true;
      let payerValForBracket = null, receiverValForBracket = null;

      if (row.kind === 'tenor') {
        const c = curve[t];
        rowLabel = c.label;
        // Two separate price lines per tenor, so it's obvious how the deal
        // was actually done:
        //  - Outright: ONLY what the dealer directly typed as a Rate Entry
        //    for this exact tenor — blank if nothing was typed here. This
        //    is a real quoted outright, i.e. a deal that could be dealt as
        //    an outright as-is.
        //  - Swap: the price built purely from the Payer/Receiver premium
        //    chain (today's payerBid / receiverOffer), regardless of
        //    whether this tenor also has its own outright. This is the
        //    price a swap deal (near-date rate + forward points) implies.
        // When both are present and agree, the tenor is confirmed either
        // way; when they disagree, that's a live mismatch (see banners).
        const anchor = (anchorByNode || {})[t];
        const swapBest = (state.swapBest || {})[t] || {
          payerBid: { val: c.payerBid, source: null },
          payerOffer: { val: c.payerOffer, source: null },
          receiverBid: { val: c.receiverBid, source: null },
          receiverOffer: { val: c.receiverOffer, source: null },
        };
        outrightPayerVal = isNum(anchor && anchor.bid) ? fmtRatePairParts(anchor.bid, null)[0] : '';
        outrightReceiverVal = isNum(anchor && anchor.offer) ? fmtRatePairParts(null, anchor.offer)[1] : '';
        // A node that IS the anchor for its own component (e.g. Spot with
        // no premium entries touching it at all) mechanically solves back
        // to exactly its own outright — that's not an independently
        // "derived via swap points" price, it's just an echo. Only show
        // the Swap line when it actually carries different information
        // than the Outright line (a real chain result, or a genuine
        // mismatch worth flagging) — never as a same-value duplicate.
        // When a tenor is reachable via more than one direct Premium Entry
        // (e.g. Cash→1M, Spot→1M, Tom→1M all typed), swapBest already
        // picked the best candidate per side — the larger bid, the
        // smaller offer — see computeSwapBest().
        //
        // A single Payer-points chain can independently produce BOTH a
        // bid (chained onto bid anchors) and an offer (chained onto
        // offer anchors) — they're two different numbers built from the
        // same edge. So the Payer column shows them together as a real
        // bid/offer pair (e.g. "58/62"), same shorthand format as any
        // typed rate, rather than picking just one. Same for Receiver
        // using the Receiver-points chain.
        const payerPair = fmtRatePairParts(swapBest.payerBid.val, swapBest.payerOffer.val);
        swapPayerVal = isNum(swapBest.payerBid.val) && isNum(swapBest.payerOffer.val)
          ? `${payerPair[0]}/${payerPair[1]}`
          : (isNum(swapBest.payerBid.val) ? payerPair[0] : (isNum(swapBest.payerOffer.val) ? payerPair[1] : ''));
        const receiverPair = fmtRatePairParts(swapBest.receiverBid.val, swapBest.receiverOffer.val);
        swapReceiverVal = isNum(swapBest.receiverBid.val) && isNum(swapBest.receiverOffer.val)
          ? `${receiverPair[0]}/${receiverPair[1]}`
          : (isNum(swapBest.receiverOffer.val) ? receiverPair[1] : (isNum(swapBest.receiverBid.val) ? receiverPair[0] : ''));
        if (outrightPayerVal && outrightPayerVal === swapPayerVal) swapPayerVal = '';
        if (outrightReceiverVal && outrightReceiverVal === swapReceiverVal) swapReceiverVal = '';
        swapPayerIsFallback = swapPayerVal.includes('/');
        swapReceiverIsFallback = swapReceiverVal.includes('/');
        payerPremLabel = fmtPremiumPts(c.payerPremium);
        receiverPremLabel = fmtPremiumPts(c.receiverPremium);
        // Show the whole-number "Big Figure" actually in use for this
        // tenor — whichever value is available — so it's obvious at a
        // glance whether the auto-detected/refined figure looks right,
        // without having to open Rate Entries to check.
        const bigFigSource = isNum(anchor && anchor.bid) ? anchor.bid
          : (isNum(swapBest.payerBid.val) ? swapBest.payerBid.val
            : (isNum(swapBest.receiverOffer.val) ? swapBest.receiverOffer.val
              : (isNum(swapBest.payerOffer.val) ? swapBest.payerOffer.val : swapBest.receiverBid.val)));
        bigFigLabel = isNum(bigFigSource) ? `BF ${Math.floor(bigFigSource)}` : '';
        rowExtraClass = t === 'spot' ? ' ladder-row-spot' : '';
        payerValForBracket = c.payerBid;
        receiverValForBracket = c.receiverOffer;
      } else {
        // Odd/Broken Date row — same Outright/Swap-style two-line format
        // as a standard tenor, just sourced differently: Outright is a
        // typed Rate on that Broken Date row, "Swap" here is really the
        // auto-interpolated figure (labeled "(interp)"), and there's no
        // 🔗 relations link since it isn't part of the premium graph.
        const bd = row.bd;
        rowLabel = row.label;
        const typed = parseRateShorthand(bd.rate, parseFloat(state.bigFigure));
        const hasTypedPayer = isNum(typed.bid);
        const hasTypedReceiver = isNum(typed.offer);
        const result = FXCalculator.interpolateBrokenDate(curve, row.date, state.valueDates.spot);
        const interpPayer = isNum(state.solved.payerSpotBid) && result && isNum(result.payerPremium)
          ? state.solved.payerSpotBid + result.payerPremium : null;
        const interpReceiver = isNum(state.solved.receiverSpotOffer) && result && isNum(result.receiverPremium)
          ? state.solved.receiverSpotOffer + result.receiverPremium : null;
        const payerUsed = hasTypedPayer ? typed.bid : interpPayer;
        const receiverUsed = hasTypedReceiver ? typed.offer : interpReceiver;

        outrightPayerVal = hasTypedPayer ? fmtRatePairParts(typed.bid, null)[0] : '';
        outrightReceiverVal = hasTypedReceiver ? fmtRatePairParts(null, typed.offer)[1] : '';
        swapPayerVal = (!hasTypedPayer && isNum(interpPayer)) ? fmtRatePairParts(interpPayer, null)[0] + ' (interp)' : '';
        swapReceiverVal = (!hasTypedReceiver && isNum(interpReceiver)) ? fmtRatePairParts(null, interpReceiver)[1] + ' (interp)' : '';
        if (swapPayerVal) swapPayerIsFallback = true;
        if (swapReceiverVal) swapReceiverIsFallback = true;
        payerPremLabel = (isNum(payerUsed) && isNum(state.solved.payerSpotBid)) ? fmtPremiumPts(payerUsed - state.solved.payerSpotBid) : '';
        receiverPremLabel = (isNum(receiverUsed) && isNum(state.solved.receiverSpotOffer)) ? fmtPremiumPts(receiverUsed - state.solved.receiverSpotOffer) : '';
        const bigFigSource = isNum(payerUsed) ? payerUsed : receiverUsed;
        bigFigLabel = isNum(bigFigSource) ? `ODD · BF ${Math.floor(bigFigSource)}` : 'ODD';
        rowExtraClass = ' ladder-row-broken';
        showRelationsBtn = false;
        payerValForBracket = payerUsed;
        receiverValForBracket = receiverUsed;
      }
      row.payerVal = payerValForBracket;
      row.receiverVal = receiverValForBracket;

      const relationsBtn = showRelationsBtn ? `
        <circle cx="${(payerRailX + receiverRailX) / 2}" cy="${cy}" r="7" class="ladder-relations-btn${(selectedTenors || []).includes(t) ? ' active' : ''}" data-tenor="${t}"></circle>
        <text x="${(payerRailX + receiverRailX) / 2}" y="${cy}" text-anchor="middle" dominant-baseline="central" class="ladder-relations-glyph" pointer-events="none">🔗</text>` : '';
      const editRects = showRelationsBtn ? `
        <rect x="${payerX + colW - 110}" y="${y}" width="106" height="18" fill="transparent" class="ladder-val-editable" style="cursor:pointer;" data-tenor="${t}" data-side="payer"></rect>
        <rect x="${receiverX + colW - 110}" y="${y}" width="106" height="18" fill="transparent" class="ladder-val-editable" style="cursor:pointer;" data-tenor="${t}" data-side="receiver"></rect>` : '';
      svg += `
        <rect x="${payerX}" y="${y}" width="${colW}" height="${rowH}" rx="3" class="ladder-row${rowExtraClass}"></rect>
        <text x="${payerX + 8}" y="${nameY}" dominant-baseline="central" class="ladder-tenor">${rowLabel}</text>
        <text x="${payerX + 8}" y="${bigfigY}" dominant-baseline="central" class="ladder-bigfig">${bigFigLabel}</text>
        <text x="${payerX + colW - 8}" y="${outrightY}" text-anchor="end" dominant-baseline="central" class="ladder-val val-outright" pointer-events="none">${outrightPayerVal}</text>
        <text x="${payerX + colW - 8}" y="${swapY}" text-anchor="end" dominant-baseline="central" class="ladder-val val-bid ladder-val-swap${swapPayerIsFallback ? ' ladder-val-swap-cross' : ''}">${swapPayerVal}</text>
        <text x="${payerX + colW - 8}" y="${premY}" text-anchor="end" dominant-baseline="central" class="ladder-premium-inline">${payerPremLabel}</text>

        <rect x="${receiverX}" y="${y}" width="${colW}" height="${rowH}" rx="3" class="ladder-row${rowExtraClass}"></rect>
        <text x="${receiverX + 8}" y="${nameY}" dominant-baseline="central" class="ladder-tenor">${rowLabel}</text>
        <text x="${receiverX + 8}" y="${bigfigY}" dominant-baseline="central" class="ladder-bigfig">${bigFigLabel}</text>
        <text x="${receiverX + colW - 8}" y="${outrightY}" text-anchor="end" dominant-baseline="central" class="ladder-val val-outright" pointer-events="none">${outrightReceiverVal}</text>
        <text x="${receiverX + colW - 8}" y="${swapY}" text-anchor="end" dominant-baseline="central" class="ladder-val val-offer ladder-val-swap${swapReceiverIsFallback ? ' ladder-val-swap-cross' : ''}">${swapReceiverVal}</text>
        <text x="${receiverX + colW - 8}" y="${premY}" text-anchor="end" dominant-baseline="central" class="ladder-premium-inline">${receiverPremLabel}</text>
        ${editRects}

        <line x1="${payerX + colW}" y1="${cy}" x2="${payerRailX}" y2="${cy}" class="ladder-tick"></line>
        <line x1="${receiverRailX}" y1="${cy}" x2="${receiverX}" y2="${cy}" class="ladder-tick"></line>
        ${relationsBtn}
      `;
    });

    svg += `<line x1="${payerRailX}" y1="${rowCenterY(0)}" x2="${payerRailX}" y2="${rowCenterY(n - 1)}" class="ladder-rail"></line>`;
    svg += `<line x1="${receiverRailX}" y1="${rowCenterY(0)}" x2="${receiverRailX}" y2="${rowCenterY(n - 1)}" class="ladder-rail"></line>`;

    for (let i = 0; i < n - 1; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      const midY = (rowCenterY(i) + rowCenterY(i + 1)) / 2;
      const payerPrem = isNum(a.payerVal) && isNum(b.payerVal) ? fmtTrim((b.payerVal - a.payerVal) * 100) : '—';
      const receiverPrem = isNum(a.receiverVal) && isNum(b.receiverVal) ? fmtTrim((b.receiverVal - a.receiverVal) * 100) : '—';
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

    // A curve is drawn ONLY for the exact pair the dealer has picked by
    // clicking the 🔗 button on two rows (first click = anchor tenor,
    // second click = the tenor to compare it against) — one curve, one
    // pair, instead of the old "every relation from one tenor" clutter.
    // Payer and Receiver are drawn independently: a confirmed match gets
    // a solid glowing ✓ line, a mismatch gets a pulsing ⚠ line, and if
    // neither Premium Entry nor cross-check touched that pair but both
    // tenors still have a directly-typed rate on that side, a neutral
    // informational line shows the implied premium anyway. The matching
    // detail message (total + per-day, Payer & Receiver) is rendered
    // separately, below the ladder, by renderPairDetail().
    if (selectedTenors && selectedTenors.length === 2) {
      const rowKeys = rows.map((r) => r.key);
      const rawIdxA = rowKeys.indexOf(selectedTenors[0]);
      const rawIdxB = rowKeys.indexOf(selectedTenors[1]);
      if (rawIdxA !== -1 && rawIdxB !== -1 && rawIdxA !== rawIdxB) {
        const [fromNode, toNode] = rawIdxA < rawIdxB ? [selectedTenors[0], selectedTenors[1]] : [selectedTenors[1], selectedTenors[0]];
        const fromIdx = rowKeys.indexOf(fromNode);
        const toIdx = rowKeys.indexOf(toNode);
        const samePair = (m) => (m.from === fromNode && m.to === toNode) || (m.from === toNode && m.to === fromNode);

        ['payer', 'receiver'].forEach((side) => {
          const p = matchPath(fromIdx, toIdx, side);
          const anchorAttr = side === 'payer' ? 'start' : 'end';
          const labelX = side === 'payer' ? p.labelX + 6 : p.labelX - 6;
          const match = (matches || []).find((m) => m.side === side && samePair(m));
          const mismatch = (mismatches || []).find((m) => m.side === side && samePair(m));

          if (match) {
            svg += `<path d="${p.d}" fill="none" class="ladder-match-line ladder-match-${side}"></path>`;
            svg += `<text x="${labelX}" y="${p.labelY}" text-anchor="${anchorAttr}" dominant-baseline="central" class="ladder-match-label">✓</text>`;
          } else if (mismatch) {
            svg += `<path d="${p.d}" fill="none" class="ladder-mismatch-line ladder-mismatch-${side}"></path>`;
            svg += `<text x="${labelX}" y="${p.labelY}" text-anchor="${anchorAttr}" dominant-baseline="central" class="ladder-mismatch-label">⚠</text>`;
          } else {
            const fromA = (anchorByNode || {})[fromNode];
            const toA = (anchorByNode || {})[toNode];
            const key = side === 'payer' ? 'bid' : 'offer';
            if (fromA && toA && isNum(fromA[key]) && isNum(toA[key])) {
              const totalPts = (toA[key] - fromA[key]) * 100;
              const days = state.valueDates.days[toNode] - state.valueDates.days[fromNode];
              const perDay = days !== 0 ? totalPts / days : null;
              const label = `${side === 'payer' ? 'Payer' : 'Receiver'} ${fmtSigned(totalPts)}p${perDay !== null ? ` (${fmtSigned(perDay)}p/d)` : ''}`;
              svg += `<path d="${p.d}" fill="none" class="ladder-relation-line"></path>`;
              svg += `<text x="${labelX}" y="${p.labelY}" text-anchor="${anchorAttr}" dominant-baseline="central" class="ladder-relation-label ladder-implied-${side}">${label}</text>`;
            }
          }
        });
      }
    }

    svg += `</svg>`;
    return svg;
  }

  function renderQuoteScreen() {
    const wrap = document.getElementById('quoteLadderWrap');
    wrap.innerHTML = buildLadderSVG(state.solved.curve, state.matches, state.mismatches, state.anchorByNode, state.selectedTenors);
    attachLadderEditing(wrap);
    renderMatchBanner();
    renderMismatchBanner();
    renderPairDetail();
  }

  /**
   * Works out the Payer / Receiver total premium + per-day between the
   * two tenors the dealer has picked with the 🔗 button, in chronological
   * order — using whatever price each tenor actually has (a typed
   * Outright if one exists, otherwise its chain-derived Swap price).
   * This is what lets a pair like Cash → 1 Week work even when Cash was
   * never typed directly, only reached via a premium chain off Spot.
   * Returns null if either tenor has no price at all yet (unconnected
   * and untyped).
   */
  function computePairDetail(fromNode, toNode) {
    const curve = state.solved.curve;
    const anchorByNode = state.anchorByNode || {};
    const cFrom = curve[fromNode];
    const cTo = curve[toNode];
    if (!cFrom || !cTo) return null;
    const priceOf = (c, anchor, key) => (isNum(anchor && anchor[key]) ? anchor[key] : c[key === 'bid' ? 'payerBid' : 'receiverOffer']);
    const fromA = anchorByNode[fromNode];
    const toA = anchorByNode[toNode];
    const days = state.valueDates.days[toNode] - state.valueDates.days[fromNode];

    let payer = null;
    const fromBid = priceOf(cFrom, fromA, 'bid');
    const toBid = priceOf(cTo, toA, 'bid');
    if (isNum(fromBid) && isNum(toBid)) {
      const total = (toBid - fromBid) * 100;
      payer = { total, perDay: days !== 0 ? total / days : null };
    }
    let receiver = null;
    const fromOffer = priceOf(cFrom, fromA, 'offer');
    const toOffer = priceOf(cTo, toA, 'offer');
    if (isNum(fromOffer) && isNum(toOffer)) {
      const total = (toOffer - fromOffer) * 100;
      receiver = { total, perDay: days !== 0 ? total / days : null };
    }
    if (!payer && !receiver) return null;
    return { fromNode, toNode, days, payer, receiver };
  }

  function ensurePairDetailEl() {
    let el = document.getElementById('pairDetailBox');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pairDetailBox';
      el.className = 'pair-detail-box';
      const wrap = document.getElementById('quoteLadderWrap');
      wrap.parentNode.insertBefore(el, wrap.nextSibling);
    }
    return el;
  }

  /** Big, clear Payer/Receiver detail message for the two tenors picked via 🔗. */
  function renderPairDetail() {
    const el = ensurePairDetailEl();
    const sel = state.selectedTenors || [];
    if (sel.length < 2) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    const idxA = TENORS.indexOf(sel[0]);
    const idxB = TENORS.indexOf(sel[1]);
    if (idxA === -1 || idxB === -1 || idxA === idxB) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    const [fromNode, toNode] = idxA < idxB ? [sel[0], sel[1]] : [sel[1], sel[0]];
    const detail = computePairDetail(fromNode, toNode);
    el.style.display = '';

    if (!detail || (!detail.payer && !detail.receiver)) {
      el.innerHTML = `<div class="pair-detail-empty">${LABELS[fromNode]} → ${LABELS[toNode]}: no rate or premium chain connects these two yet.</div>`;
      return;
    }

    const absDays = Math.abs(detail.days);
    const daysLabel = `${absDays} day${absDays === 1 ? '' : 's'}`;
    const line = (side, data) => {
      const label = side === 'payer' ? 'Payer' : 'Receiver';
      if (!data) {
        return `<div class="pair-detail-line pair-detail-${side} pair-detail-muted"><span class="pair-detail-label">${label}</span><span class="pair-detail-value">—</span></div>`;
      }
      const perDay = data.perDay !== null ? `<span class="pair-detail-sub">(${fmtSigned(data.perDay)}p/day)</span>` : '';
      return `<div class="pair-detail-line pair-detail-${side}"><span class="pair-detail-label">${label}</span><span class="pair-detail-value">${fmtSigned(data.total)}p</span>${perDay}</div>`;
    };

    el.innerHTML = `
      <div class="pair-detail-header">${LABELS[fromNode]} → ${LABELS[toNode]} <span class="pair-detail-days">${daysLabel}</span></div>
      ${line('payer', detail.payer)}
      ${line('receiver', detail.receiver)}
    `;
  }

  /**
   * Click any Payer/Receiver value on the ladder to edit it directly.
   * The edit writes straight back into the matching Rate Entry (creating
   * one if that tenor didn't have one yet) — so it's a real input, not
   * just a display, and shows up correctly in Rate Entries and on reload.
   * Also wires the 🔗 relations button on each row — click it to show
   * (and re-click to hide) just that tenor's match/mismatch curves,
   * instead of every relation being drawn at once.
   */
  function attachLadderEditing(wrap) {
    wrap.style.position = 'relative';
    wrap.querySelectorAll('.ladder-val-editable').forEach((el) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => openLadderEditor(el, wrap));
    });
    wrap.querySelectorAll('.ladder-relations-btn').forEach((el) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const tenor = el.dataset.tenor;
        const sel = state.selectedTenors;
        const pos = sel.indexOf(tenor);
        if (pos !== -1) {
          sel.splice(pos, 1); // clicking an already-selected tenor deselects it
        } else if (sel.length >= 2) {
          state.selectedTenors = [tenor]; // a 3rd click starts a fresh pair, this tenor as the new anchor
        } else if (sel.length === 0) {
          // First click: if this tenor's Swap price actually came from a
          // specific other tenor (the winning candidate in swapBest),
          // auto-select that pair immediately — no need to hunt for and
          // click the 2nd tenor by hand to see how the best rate was built.
          const best = (state.swapBest || {})[tenor] || {};
          const autoSource = (best.payerBid && best.payerBid.source)
            || (best.receiverOffer && best.receiverOffer.source)
            || (best.payerOffer && best.payerOffer.source)
            || (best.receiverBid && best.receiverBid.source);
          state.selectedTenors = autoSource ? [tenor, autoSource] : [tenor];
        } else {
          sel.push(tenor); // 2nd click on a different tenor = manual compare
        }
        renderQuoteScreen();
      });
    });
  }

  function openLadderEditor(targetEl, wrap) {
    if (wrap.querySelector('.ladder-edit-input')) return; // one editor at a time
    const tenor = targetEl.dataset.tenor;
    const side = targetEl.dataset.side;
    const rect = targetEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-input ladder-edit-input';
    const anchor = (state.anchorByNode || {})[tenor];
    const anchorVal = anchor && isNum(anchor[side === 'payer' ? 'bid' : 'offer']) ? anchor[side === 'payer' ? 'bid' : 'offer'] : null;
    const current = anchorVal !== null
      ? fmtRatePairParts(side === 'payer' ? anchorVal : null, side === 'receiver' ? anchorVal : null)[side === 'payer' ? 0 : 1]
      : '';
    input.value = current;
    input.style.position = 'absolute';
    input.style.left = `${rect.left - wrapRect.left - 60}px`;
    input.style.top = `${rect.top - wrapRect.top - 4}px`;
    input.style.width = '70px';
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
      // Clearing the field to empty is a real edit too — it should erase
      // that side of the typed rate, not silently keep the old value.
      applyLadderEdit(tenor, side, raw);
    }
    function cancel() {
      if (done) return;
      done = true;
      input.remove();
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') cancel();
    });
    input.addEventListener('blur', commit);
  }

  function applyLadderEdit(tenor, side, raw) {
    let entry = state.rateEntries.find((e) => e.node === tenor);
    if (!entry) {
      if (!raw) return; // cleared a field that had no Rate Entry anyway — nothing to do
      entry = { id: nextRateId++, node: tenor, rate: '' };
      state.rateEntries.push(entry);
    }
    const parts = (entry.rate || '').split('/');
    const bidPart = (parts[0] || '').trim();
    const offerPart = (parts.length > 1 ? parts[1] : '').trim();
    const newBid = side === 'payer' ? raw : bidPart;
    const newOffer = side === 'receiver' ? raw : offerPart;
    entry.rate = `${newBid}/${newOffer}`;
    if (!newBid && !newOffer) {
      // Both sides are now blank — drop the Rate Entry entirely so the
      // Outright line, Big Figure, and match/mismatch checks for this
      // tenor all clear completely instead of leaving a stale "/" row.
      state.rateEntries = state.rateEntries.filter((e) => e.id !== entry.id);
    }
    recompute();
    renderRateTable();
    renderDownstream();
    scheduleSaveDraft();
  }

  /** Only match/mismatch entries touching the exact 2 tenors currently picked via 🔗 (either order). Empty when fewer than 2 are selected. */
  function selectedPairEntries(list) {
    const sel = state.selectedTenors || [];
    if (sel.length !== 2) return [];
    const [a, b] = sel;
    return (list || []).filter((m) => (m.from === a && m.to === b) || (m.from === b && m.to === a));
  }

  function renderMatchBanner() {
    const el = document.getElementById('matchBanner');
    if (!el) return;
    const matches = selectedPairEntries(state.matches);
    if (!matches.length) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    el.innerHTML = matches.map((m) => `
      <div class="match-line match-${m.side}">
        ✓ ${LABELS[m.from]}→${LABELS[m.to]} ${m.side === 'payer' ? 'Payer' : 'Receiver'}
      </div>
    `).join('');
  }

  function renderMismatchBanner() {
    const el = document.getElementById('mismatchBanner');
    if (!el) return;
    const mismatches = selectedPairEntries(state.mismatches);
    if (!mismatches.length) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    el.innerHTML = mismatches.map((m) => {
      const sideLabel = m.side === 'payer' ? 'Payer' : 'Receiver';
      const parts = [];
      if (m.direct) parts.push(`Δ${fmtTrim(m.actualDisplayPts)}${m.unitLabel || 'p'}`);
      if (m.toSuitable) parts.push(`${LABELS[m.to]} ${fmtNum(m.suggestedToRate)}`);
      if (m.fromSuitable) parts.push(`${LABELS[m.from]} ${fmtNum(m.suggestedFromRate)}`);
      const text = parts.length ? parts.join(' / ') : '—';
      return `
      <div class="match-line mismatch-${m.side} mismatch-big">
        ⚠ ${LABELS[m.from]}→${LABELS[m.to]} ${sideLabel}: ${text}
      </div>`;
    }).join('');
  }

  /* ==================================================================
     RENDER: Odd / Broken Dates (custom value dates, interpolated)
     ================================================================== */
  function renderBrokenDates() {
    const tbody = document.getElementById('brokenDateTableBody');
    if (!tbody) return;
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

        // A typed Rate on a broken date is a real Outright, just like a
        // typed Rate Entry — it always wins over the auto-interpolated
        // figure. No Rate typed yet? Fall back to interpolation as before.
        const typedBF = parseFloat(state.bigFigure);
        const typed = parseRateShorthand(bd.rate, typedBF);
        const hasTypedPayer = isNum(typed.bid);
        const hasTypedReceiver = isNum(typed.offer);

        if (!result && !hasTypedPayer && !hasTypedReceiver) {
          tr.innerHTML = `
            ${dateInputCell}
            ${rateInputCell}
            <td colspan="3" class="val-muted">Need at least 2 solved tenors to interpolate, or type a Rate</td>
            <td><button class="btn danger" data-remove-broken="${bd.id}" style="padding:3px 8px;">✕</button></td>
          `;
        } else {
          const interpPayer = isNum(state.solved.payerSpotBid) && result && isNum(result.payerPremium)
            ? state.solved.payerSpotBid + result.payerPremium : null;
          const interpReceiver = isNum(state.solved.receiverSpotOffer) && result && isNum(result.receiverPremium)
            ? state.solved.receiverSpotOffer + result.receiverPremium : null;
          const payerRate = hasTypedPayer ? typed.bid : interpPayer;
          const receiverRate = hasTypedReceiver ? typed.offer : interpReceiver;
          const daysLabel = result ? result.days : FXCalendar.calendarDaysBetween(state.valueDates.spot, targetDate);
          tr.innerHTML = `
            ${dateInputCell}
            ${rateInputCell}
            <td class="mono">${daysLabel}</td>
            <td class="mono ${hasTypedPayer ? 'val-outright' : 'val-bid'}">${fmtNum(payerRate)}${hasTypedPayer ? '' : ' (interp)'}</td>
            <td class="mono ${hasTypedReceiver ? 'val-outright' : 'val-offer'}">${fmtNum(receiverRate)}${hasTypedReceiver ? '' : ' (interp)'}</td>
            <td><button class="btn danger" data-remove-broken="${bd.id}" style="padding:3px 8px;">✕</button></td>
          `;
        }
        tbody.appendChild(tr);
      });

    tbody.querySelectorAll('[data-broken-date-id]').forEach((input) => {
      input.addEventListener('change', () => {
        const entry = state.brokenDates.find((e) => e.id === Number(input.dataset.brokenDateId));
        if (!entry) return;
        const iso = parseFlexibleDateToISO(input.value);
        if (!iso) { alert('Could not read that date — use DD-MM-YYYY, e.g. 15-09-2026.'); renderBrokenDates(); return; }
        entry.dateStr = iso;
        renderBrokenDates();
        renderQuoteScreen();
        scheduleSaveDraft();
      });
    });

    tbody.querySelectorAll('[data-broken-rate-id]').forEach((input) => {
      input.addEventListener('input', () => {
        const entry = state.brokenDates.find((e) => e.id === Number(input.dataset.brokenRateId));
        if (!entry) return;
        entry.rate = input.value;
        renderBrokenDates();
        renderQuoteScreen();
        scheduleSaveDraft();
      });
    });

    tbody.querySelectorAll('[data-remove-broken]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.brokenDates = state.brokenDates.filter((e) => e.id !== Number(btn.dataset.removeBroken));
        renderBrokenDates();
        renderQuoteScreen();
        scheduleSaveDraft();
      });
    });
  }

  /* ==================================================================
     RENDER: Value Dates (computed dates for every standard tenor, with
     a manual override for whenever the calendar engine gets one wrong)
     ================================================================== */
  function renderValueDates() {
    const tbody = document.getElementById('valueDateTableBody');
    if (!tbody) return;
    tbody.innerHTML = TENORS.map((t) => {
      const d = state.valueDates.dates[t];
      const nod = NEAR_DATES.includes(t) || t === 'spot' ? state.valueDates.daysFromCash[t] : state.valueDates.days[t];
      return `
        <tr>
          <td class="tenor-name">${LABELS[t]}</td>
          <td class="mono">${d ? fmtDateLabel(d) : '—'}</td>
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
     RENDER: Implied Premiums (from 2+ direct rates)
     ================================================================== */
  function renderImpliedPremiums() {
    const card = document.getElementById('impliedCard');
    const tbody = document.getElementById('impliedTableBody');
    const relations = state.tenorRelations;
    if (!relations.length) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    tbody.innerHTML = relations.map((ip) => {
      const payerPts = isNum(ip.payerPremium) ? ip.payerPremium * 100 : null;
      const receiverPts = isNum(ip.receiverPremium) ? ip.receiverPremium * 100 : null;
      const payerPerDay = isNum(ip.payerPremiumPerDay) ? ip.payerPremiumPerDay * 100 : null;
      const receiverPerDay = isNum(ip.receiverPremiumPerDay) ? ip.receiverPremiumPerDay * 100 : null;
      return `
      <tr>
        <td class="tenor-name">${LABELS[ip.from]} → ${LABELS[ip.to]}</td>
        <td class="mono val-bid">${payerPts !== null ? fmtSigned(payerPts) : '—'}</td>
        <td class="mono val-bid">${payerPerDay !== null ? fmtSigned(payerPerDay) : '—'}</td>
        <td class="mono val-offer">${receiverPts !== null ? fmtSigned(receiverPts) : '—'}</td>
        <td class="mono val-offer">${receiverPerDay !== null ? fmtSigned(receiverPerDay) : '—'}</td>
      </tr>
    `;
    }).join('');
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
    renderBrokenDates();
    renderValueDates();
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

    document.getElementById('addBrokenDateBtn').addEventListener('click', () => {
      const input = document.getElementById('newBrokenDateInput');
      if (!input.value.trim()) { alert('Type a date first, e.g. 15-09-2026.'); return; }
      const iso = parseFlexibleDateToISO(input.value);
      if (!iso) { alert('Could not read that date — use DD-MM-YYYY, e.g. 15-09-2026.'); return; }
      state.brokenDates.push({ id: nextBrokenDateId++, dateStr: iso, rate: '' });
      input.value = '';
      renderBrokenDates();
      renderQuoteScreen();
      scheduleSaveDraft();
    });

    document.getElementById('clearInputsBtn').addEventListener('click', () => {
      if (!confirm('Clear every input field?')) return;
      state.rateEntries = [];
      state.premiumEntries = [];
      state.brokenDates = [];
      state.bigFigure = '';
      state.selectedTenors = [];
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
    wireTabs();
    renderAllViews();
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
