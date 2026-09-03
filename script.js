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
      // Offer rolls over to the next Big Figure whenever its points are
      // smaller than the bid's (e.g. "80/20" -> offer is +1.00 above
      // the bid's hundred) — this is the dealer's own convention.
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
   * DIRECTION-DEPENDENT theory, per the dealer's own convention:
   *   - A Payer premium calculated FORWARD (near tenor known → deriving
   *     the far one) produces a BID at the far tenor.
   *   - The SAME Payer premium calculated BACKWARD (far tenor known →
   *     deriving the near one) produces an OFFER at the near tenor —
   *     NOT a bid. E.g. Spot 60/90 typed + Cash→Spot Payer premium 4 →
   *     Cash gets an OFFER (82), Cash's bid stays blank.
   *   - A Receiver premium mirrors this: forward → OFFER, backward →
   *     BID.
   * Each tenor's own directly-typed Outright ALWAYS wins its own slot —
   * a chain-derived candidate never outcompetes a real typed rate just
   * by being numerically "better".
   *
   * MULTI-HOP: a tenor doesn't need its own Outright to feed further
   * chains — its own CREATED value (from one Premium Entry) can itself
   * be used by another Premium Entry to derive a third tenor. E.g. Cash
   * typed + Cash→Spot premium creates Spot's rate; Spot→1M premium then
   * creates 1M's rate too, chaining through Spot's created value even
   * though Spot itself was never typed. This is solved by relaxing the
   * whole set of Premium Entries repeatedly (like Bellman-Ford) until
   * every reachable value has propagated as far as the chain goes — safe
   * and bounded since tenor chains are chronological (no cycles).
   */
  function computeSwapBest() {
    const pickBest = (list, isBid) => {
      // A tenor's own directly-typed Outright ALWAYS wins on its own
      // row — it's the real, dealt rate. It should never lose to a
      // chain-derived candidate from some OTHER premium entry just
      // because that candidate happens to be numerically "better" (a
      // smaller offer, say) — that would silently substitute a
      // computed guess for what the dealer actually typed. Chain
      // candidates only compete with each other, and only fill the
      // slot when there's no Outright for it at all.
      const outright = list.find((c) => c.source === 'outright' && isNum(c.val));
      if (outright) return outright;
      let b = null;
      list.forEach((cand) => {
        if (!isNum(cand.val)) return;
        if (!b || (isBid ? cand.val > b.val : cand.val < b.val)) b = cand;
      });
      return b || { val: null, source: null };
    };

    const empty = () => ({ val: null, source: null });
    let current = {};
    TENORS.forEach((t) => {
      const anchor = (state.anchorByNode || {})[t];
      current[t] = {
        payerBid: isNum(anchor && anchor.bid) ? { source: 'outright', val: anchor.bid } : empty(),
        payerOffer: isNum(anchor && anchor.offer) ? { source: 'outright', val: anchor.offer } : empty(),
        receiverBid: isNum(anchor && anchor.bid) ? { source: 'outright', val: anchor.bid } : empty(),
        receiverOffer: isNum(anchor && anchor.offer) ? { source: 'outright', val: anchor.offer } : empty(),
      };
    });

    // One pass can only propagate one hop further than the previous
    // pass knew about, so repeat enough times for the longest possible
    // chain (bounded by the number of tenors) to fully settle.
    const maxIterations = TENORS.length;
    for (let iter = 0; iter < maxIterations; iter++) {
      const pools = {};
      TENORS.forEach((t) => {
        pools[t] = { payerBid: [], payerOffer: [], receiverBid: [], receiverOffer: [] };
        ['payerBid', 'payerOffer', 'receiverBid', 'receiverOffer'].forEach((k) => {
          if (isNum(current[t][k].val)) pools[t][k].push(current[t][k]); // carry forward what's already known
        });
      });

      state.premiumEntries.forEach((pe) => {
        const prem = parsePremiumShorthand(pe.premium);
        const payerEdge = premiumToEdgeValue(pe.from, pe.to, prem.payer, pe.perDay);
        const receiverEdge = premiumToEdgeValue(pe.from, pe.to, prem.receiver, pe.perDay);
        const fromBest = current[pe.from];
        const toBest = current[pe.to];

        if (isNum(payerEdge)) {
          if (fromBest && isNum(fromBest.payerBid.val)) {
            pools[pe.to].payerBid.push({ source: pe.from, val: fromBest.payerBid.val + payerEdge }); // forward -> bid
          }
          if (toBest && isNum(toBest.payerOffer.val)) {
            pools[pe.from].payerOffer.push({ source: pe.to, val: toBest.payerOffer.val - payerEdge }); // backward -> offer
          }
        }
        if (isNum(receiverEdge)) {
          if (fromBest && isNum(fromBest.receiverOffer.val)) {
            pools[pe.to].receiverOffer.push({ source: pe.from, val: fromBest.receiverOffer.val + receiverEdge }); // forward -> offer
          }
          if (toBest && isNum(toBest.receiverBid.val)) {
            pools[pe.from].receiverBid.push({ source: pe.to, val: toBest.receiverBid.val - receiverEdge }); // backward -> bid
          }
        }
      });

      const next = {};
      TENORS.forEach((t) => {
        next[t] = {
          payerBid: pickBest(pools[t].payerBid, true),
          payerOffer: pickBest(pools[t].payerOffer, false),
          receiverBid: pickBest(pools[t].receiverBid, true),
          receiverOffer: pickBest(pools[t].receiverOffer, false),
        };
      });
      current = next;
    }

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

  /** [bid, offer] -> ["20","40"] shorthand within the shared Big Figure's hundred, else full rate. */
  function fmtRatePairParts(bid, offer) {
    const bf = parseFloat(state.bigFigure);
    const hasBF = isFinite(bf);
    const shortBid = (v) => {
      if (v === null) return '—';
      if (hasBF) {
        const points = (v - bf) * 100;
        if (points >= 0 && points < 100) return fmtTrim(points);
      }
      return fmtNum(v);
    };
    // Offer now mirrors the Bid/Payer behavior above: only shown as
    // short points-off-the-Big-Figure when those points land inside
    // 0–100; otherwise it falls back to the full rate, so it never
    // shows a confusing/unexpected number after crossing a hundred
    // boundary (e.g. "102" or "-3").
    const shortOffer = (v) => {
      if (v === null) return '—';
      if (hasBF) {
        const points = (v - bf) * 100;
        if (points >= 0 && points < 100) return fmtTrim(points);
      }
      return fmtNum(v);
    };
    return [shortBid(bid), shortOffer(offer)];
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
  /** Compact form for tight single-line rows: "+27.75p" instead of "+27.75p from Spot". */
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

  /**
   * Renders one column's price as a real "bid/offer" pair (e.g. "20/30"),
   * same shorthand as any typed rate — "5/" if only a bid exists, "/10"
   * if only an offer exists, "" if neither. Each number is colored by
   * its OWN winning source independently (bidCand/offerCand are
   * {val, source} from computeCandidateBest): amber if the typed
   * Outright won that side, green (bid) / red (offer) if a
   * chain-computed price won — so one pair can legitimately show one
   * amber number next to one green/red number.
   */
  /**
   * Formats ONE price for one column — the Payer column only ever shows
   * a bid, the Receiver column only ever shows an offer (see the theory
   * note on computeCandidateBest). If the data genuinely can't decide
   * that side (no Outright, no valid chain candidate), this shows
   * nothing — never a fabricated placeholder. Colour signals source:
   * green for a rate typed directly (Outright), yellow for a price the
   * solver created from the premium chain.
   */
  /**
   * Renders one column's price as a real "bid/offer" pair (e.g. "20/30"),
   * same shorthand as any typed rate — "5/" if only a bid exists, "/10"
   * if only an offer exists, "" if neither. Each number is colored by
   * its OWN winning source independently (bidCand/offerCand are
   * {val, source} from computeCandidateBest): green if the typed
   * Outright won that side, yellow if a chain-computed price won it —
   * so one pair can legitimately show one green number next to one
   * yellow number.
   */
  /**
   * Renders one column's price as a real "bid/offer" pair (e.g. "20/30"),
   * same shorthand as any typed rate — "5/" if only a bid exists, "/10"
   * if only an offer exists, "" if neither. Each number is colored by
   * its OWN winning source independently: green if the typed Outright
   * won that side, yellow if a chain-computed price won it — so one
   * pair can legitimately show one green number next to one yellow one.
   */
  function buildPairMarkup(bidCand, offerCand) {
    const bidStr = isNum(bidCand && bidCand.val) ? fmtRatePairParts(bidCand.val, null)[0] : '';
    const offerStr = isNum(offerCand && offerCand.val) ? fmtRatePairParts(null, offerCand.val)[1] : '';
    if (!bidStr && !offerStr) return '';
    const bidClass = bidCand && bidCand.source === 'outright' ? 'ladder-src-outright' : 'ladder-src-created';
    const offerClass = offerCand && offerCand.source === 'outright' ? 'ladder-src-outright' : 'ladder-src-created';
    return `<tspan class="${bidClass}">${bidStr}</tspan><tspan class="ladder-val-slash">/</tspan><tspan class="${offerClass}">${offerStr}</tspan>`;
  }

  function buildLadderSVG(curve, matches, mismatches, anchorByNode) {
    const rows = buildDisplayRows();
    const n = rows.length;
    const rowH = 12;
    const slot = 14;
    const topPad = 8;
    const height = topPad + n * slot + 5;

    const colW = 78;
    const payerX = 3;
    const payerRailX = payerX + colW + 8;
    const receiverX = 260 - colW;
    const receiverRailX = receiverX - 8;
    const diffX = (payerRailX + receiverRailX) / 2;
    const matchPayerX = payerRailX + 6;
    const matchReceiverX = receiverRailX - 6;

    const rowY = (i) => topPad + i * slot;
    const rowCenterY = (i) => rowY(i) + rowH / 2;

    let svg = `<svg class="ladder-svg" viewBox="0 0 260 ${height}" width="100%" role="img" aria-label="Payer and Receiver rate ladder with premium brackets">`;
    svg += `<text x="${payerX}" y="7" class="ladder-heading">Payer</text>`;
    svg += `<text x="${receiverX + colW}" y="7" text-anchor="end" class="ladder-heading">Receiver</text>`;

    rows.forEach((row, i) => {
      const t = row.key;
      const y = rowY(i);
      const cy = rowCenterY(i);

      let rowLabel, priceLinePayer, priceLineReceiver,
        payerIsChainDerived = false, receiverIsChainDerived = false,
        payerPremLabel, receiverPremLabel, bigFigLabel, rowExtraClass = '', showEditable = true;
      let payerValForBracket = null, receiverValForBracket = null;

      if (row.kind === 'tenor') {
        const c = curve[t];
        rowLabel = c.label;
        // Each column shows a real bid/offer PAIR — the best available
        // bid and the best available offer, independently, same "20/30"
        // shorthand as any typed rate. Each side is chosen from the same
        // candidate pool (typed Outright competes on equal footing with
        // every chain-derived candidate — see computeCandidateBest /
        // computeSwapBest): highest bid wins, lowest offer wins. Colour
        // shows the source per number: green = your typed Outright won
        // that side, yellow = the premium chain created it.
        const swapBest = (state.swapBest || {})[t] || {
          payerBid: { val: c.payerBid, source: null },
          payerOffer: { val: c.payerOffer, source: null },
          receiverBid: { val: c.receiverBid, source: null },
          receiverOffer: { val: c.receiverOffer, source: null },
        };
        row.linkSource = autoLinkSourceFor(t);

        priceLinePayer = buildPairMarkup(swapBest.payerBid, swapBest.payerOffer);
        priceLineReceiver = buildPairMarkup(swapBest.receiverBid, swapBest.receiverOffer);

        payerPremLabel = fmtPremiumPtsShort(c.payerPremium);
        receiverPremLabel = fmtPremiumPtsShort(c.receiverPremium);
        // Show the whole-number "Big Figure" actually in use for this
        // tenor — whichever value is available — so it's obvious at a
        // glance whether the auto-detected/refined figure looks right,
        // without having to open Rate Entries to check.
        const bigFigSource = isNum(swapBest.payerBid.val) ? swapBest.payerBid.val
          : (isNum(swapBest.payerOffer.val) ? swapBest.payerOffer.val
            : (isNum(swapBest.receiverBid.val) ? swapBest.receiverBid.val : swapBest.receiverOffer.val));
        bigFigLabel = isNum(bigFigSource) ? `${Math.floor(bigFigSource)}` : '';
        rowExtraClass = t === 'spot' ? ' ladder-row-spot' : '';
        payerValForBracket = c.payerBid;
        receiverValForBracket = c.receiverOffer;
      } else {
        // Odd/Broken Date row — same single-merged-line idea as a
        // standard tenor: a typed Outright on this row always wins;
        // with nothing typed, it falls back to the auto-interpolated
        // estimate, labeled "(interp)" and coloured like a chain-derived
        // price so it's clearly an estimate, not a real quote. No 🔗
        // relations link since a broken date isn't part of the premium
        // graph.
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

        priceLinePayer = isNum(payerUsed) ? fmtRatePairParts(payerUsed, null)[0] + (hasTypedPayer ? '' : '·i') : '';
        priceLineReceiver = isNum(receiverUsed) ? fmtRatePairParts(null, receiverUsed)[1] + (hasTypedReceiver ? '' : '·i') : '';
        payerIsChainDerived = !hasTypedPayer;
        receiverIsChainDerived = !hasTypedReceiver;
        payerPremLabel = (isNum(payerUsed) && isNum(state.solved.payerSpotBid)) ? fmtPremiumPtsShort(payerUsed - state.solved.payerSpotBid) : '';
        receiverPremLabel = (isNum(receiverUsed) && isNum(state.solved.receiverSpotOffer)) ? fmtPremiumPtsShort(receiverUsed - state.solved.receiverSpotOffer) : '';
        const bigFigSource = isNum(payerUsed) ? payerUsed : receiverUsed;
        bigFigLabel = isNum(bigFigSource) ? `${Math.floor(bigFigSource)}` : 'ODD';
        rowExtraClass = ' ladder-row-broken';
        showEditable = false;
        payerValForBracket = payerUsed;
        receiverValForBracket = receiverUsed;
      }
      row.payerVal = payerValForBracket;
      row.receiverVal = receiverValForBracket;

      const editRects = showEditable ? `
        <rect x="${payerX + colW - 42}" y="${y}" width="39" height="${rowH}" fill="transparent" class="ladder-val-editable" style="cursor:pointer;" data-tenor="${t}"></rect>
        <rect x="${receiverX + colW - 42}" y="${y}" width="39" height="${rowH}" fill="transparent" class="ladder-val-editable" style="cursor:pointer;" data-tenor="${t}"></rect>` : '';
      const outerPayerClass = row.kind === 'tenor' ? 'ladder-val' : `ladder-val ${payerIsChainDerived ? 'ladder-src-created' : 'ladder-src-outright'}`;
      const outerReceiverClass = row.kind === 'tenor' ? 'ladder-val' : `ladder-val ${receiverIsChainDerived ? 'ladder-src-created' : 'ladder-src-outright'}`;
      // Single line per side: tenor name + Big Figure combined on the
      // left, price + premium-from-spot combined on the right — cuts
      // row height roughly in half versus stacking them.
      svg += `
        <rect x="${payerX}" y="${y}" width="${colW}" height="${rowH}" rx="2" class="ladder-row${rowExtraClass}"></rect>
        <text x="${payerX + 4}" y="${cy}" dominant-baseline="central" class="ladder-tenor">${rowLabel}<tspan class="ladder-bigfig"> ${bigFigLabel}</tspan></text>
        <text x="${payerX + colW - 4}" y="${cy}" text-anchor="end" dominant-baseline="central" class="${outerPayerClass}" pointer-events="none">${priceLinePayer}<tspan class="ladder-premium-inline"> ${payerPremLabel}</tspan></text>

        <rect x="${receiverX}" y="${y}" width="${colW}" height="${rowH}" rx="2" class="ladder-row${rowExtraClass}"></rect>
        <text x="${receiverX + 4}" y="${cy}" dominant-baseline="central" class="ladder-tenor">${rowLabel}<tspan class="ladder-bigfig"> ${bigFigLabel}</tspan></text>
        <text x="${receiverX + colW - 4}" y="${cy}" text-anchor="end" dominant-baseline="central" class="${outerReceiverClass}" pointer-events="none">${priceLineReceiver}<tspan class="ladder-premium-inline"> ${receiverPremLabel}</tspan></text>
        ${editRects}

        <line x1="${payerX + colW}" y1="${cy}" x2="${payerRailX}" y2="${cy}" class="ladder-tick"></line>
        <line x1="${receiverRailX}" y1="${cy}" x2="${receiverX}" y2="${cy}" class="ladder-tick"></line>
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

    // Automatic, non-interactive source curves: whenever a tenor's best
    // price is a CREATED one (yellow — built from another tenor via the
    // premium chain), draw one thin dashed line from that source row to
    // this row, no click needed and no text label — just a quiet visual
    // trace of where the number came from. One line per row max (the
    // same single winning source used for coloring), to keep it readable
    // rather than a tangle of every possible chain path.
    const rowKeys = rows.map((r) => r.key);
    rows.forEach((row, i) => {
      if (!row.linkSource) return;
      const sourceIdx = rowKeys.indexOf(row.linkSource);
      if (sourceIdx === -1 || sourceIdx === i) return;
      const lo = Math.min(sourceIdx, i);
      const hi = Math.max(sourceIdx, i);
      const y1 = rowCenterY(lo);
      const y2 = rowCenterY(hi);
      const x = (payerRailX + receiverRailX) / 2;
      const skips = hi - lo > 1;
      const d = skips
        ? `M ${x} ${y1} Q ${x + 16} ${(y1 + y2) / 2} ${x} ${y2}`
        : `M ${x} ${y1} L ${x} ${y2}`;
      svg += `<path d="${d}" fill="none" class="ladder-source-line"></path>`;
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

  /**
   * Click any Payer/Receiver value on the ladder to edit it directly.
   * The edit writes straight back into the matching Rate Entry (creating
   * one if that tenor didn't have one yet) — so it's a real input, not
   * just a display, and shows up correctly in Rate Entries and on reload.
   */
  function attachLadderEditing(wrap) {
    wrap.style.position = 'relative';
    wrap.querySelectorAll('.ladder-val-editable').forEach((el) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => openLadderEditor(el, wrap));
    });
  }

  function openLadderEditor(targetEl, wrap) {
    if (wrap.querySelector('.ladder-edit-input')) return; // one editor at a time
    const tenor = targetEl.dataset.tenor;
    const rect = targetEl.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();

    // One editor edits the WHOLE rate — both bid and offer together, same
    // shorthand as the Rate Entries table ("50/60", "75/", "/75") — since
    // both sides live on the same underlying Rate Entry regardless of
    // which column (Payer/Receiver) was clicked to open it.
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-input ladder-edit-input';
    const entry = state.rateEntries.find((e) => e.node === tenor);
    input.placeholder = '30/40';
    input.value = entry ? entry.rate : '';
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
    });
    input.addEventListener('blur', commit);
  }

  /** Same "which tenor produced the best price" logic as the 🔗 button, reused so editing a rate also reveals where a created price is coming from. */
  function autoLinkSourceFor(tenor) {
    const best = (state.swapBest || {})[tenor] || {};
    return (best.payerBid && best.payerBid.source) || (best.receiverOffer && best.receiverOffer.source);
  }

  function applyLadderEdit(tenor, raw) {
    let entry = state.rateEntries.find((e) => e.node === tenor);
    if (!raw) {
      // Cleared entirely — drop the Rate Entry so the row falls back
      // cleanly to whatever the premium chain can build, if anything.
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

  /** Only match/mismatch entries touching the exact 2 tenors currently picked via 🔗 (either order). Empty when fewer than 2 are selected. */
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
        ✓ ${LABELS[m.from]}→${LABELS[m.to]} ${m.side === 'payer' ? 'Payer' : 'Receiver'}
      </div>
    `).join('');
  }

  function renderMismatchBanner() {
    const el = document.getElementById('mismatchBanner');
    if (!el) return;
    const mismatches = state.mismatches || [];
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
            <td class="mono ${hasTypedPayer ? 'ladder-src-outright' : 'ladder-src-created'}">${fmtNum(payerRate)}${hasTypedPayer ? '' : ' (interp)'}</td>
            <td class="mono ${hasTypedReceiver ? 'ladder-src-outright' : 'ladder-src-created'}">${fmtNum(receiverRate)}${hasTypedReceiver ? '' : ' (interp)'}</td>
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

    // "Same premium to many tenors at once" — e.g. Cash → 1W, 2W, 3W, 1M
    // all sharing one typed premium, instead of adding each pair one at
    // a time and re-typing the same number into every row.
    populateTenorSelect(document.getElementById('bulkPremiumFrom'));
    populateTenorSelect(document.getElementById('bulkPremiumTo'));
    document.getElementById('bulkPremiumFrom').value = 'cash';
    document.getElementById('addBulkPremiumBtn').addEventListener('click', () => {
      const from = document.getElementById('bulkPremiumFrom').value;
      const toSelect = document.getElementById('bulkPremiumTo');
      const targets = Array.from(toSelect.selectedOptions).map((o) => o.value).filter((v) => v !== from);
      const premiumVal = document.getElementById('bulkPremiumValue').value.trim();
      const perDay = document.getElementById('bulkPremiumPerDay').checked;
      if (!targets.length) { alert('Select at least one Tenor 2 (ctrl/cmd-click or drag to pick several).'); return; }
      if (!premiumVal) { alert('Type the premium value to apply to all selected tenors, e.g. 5/5.5.'); return; }
      let added = 0;
      targets.forEach((to) => {
        const existing = state.premiumEntries.find((e) => e.from === from && e.to === to);
        if (existing) {
          existing.premium = premiumVal;
          existing.perDay = perDay;
        } else {
          state.premiumEntries.push({ id: nextPremiumId++, from, to, premium: premiumVal, perDay });
        }
        added++;
      });
      // Reset the form for the next batch, but leave Tenor 1 as-is since
      // it's common to add several batches off the same origin tenor.
      Array.from(toSelect.options).forEach((o) => { o.selected = false; });
      document.getElementById('bulkPremiumValue').value = '';
      document.getElementById('bulkPremiumPerDay').checked = false;
      recompute();
      renderPremiumTable();
      renderDownstream();
      scheduleSaveDraft();
      alert(`Added premium ${premiumVal} to ${added} tenor${added === 1 ? '' : 's'}.`);
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
