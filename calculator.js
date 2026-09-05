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
  const TENOR_ORDER = ['cash', 'tom', 'spot', '1W', '2W', '3W', '1M', '2M', '3M', '4M', '5M', '6M', '7M', '8M', '9M', '10M', '11M', '12M'];
  const TENOR_LABELS = {
    cash: 'Cash', tom: 'Tom', spot: 'Spot',
    '1W': '1 Week', '2W': '2 Weeks', '3W': '3 Weeks',
    '1M': '1 Month', '2M': '2 Months', '3M': '3 Months', '4M': '4 Months',
    '5M': '5 Months', '6M': '6 Months', '7M': '7 Months', '8M': '8 Months',
    '9M': '9 Months', '10M': '10 Months', '11M': '11 Months', '12M': '12 Months',
  };

  /**
   * Build the full value-date ladder from today's trade date.
   *
   * Cash (same-day) and Tom (next-day) both need the US side open to be
   * real settleable USD value dates — not just Sri Lanka.
   *
   * CASH: a day that's a US holiday but otherwise a normal Sri Lankan
   * working day (e.g. Labor Day, Thanksgiving) isn't "Cash rolls forward
   * to the next day" like a normal SL holiday/weekend gap would be;
   * there simply IS no Cash value date today, so it's dropped from the
   * ladder entirely (`cashHidden: true`, `cash: null`) and everything
   * else builds off the previous day that was a genuine working day on
   * BOTH sides (`referenceDate`) instead of from today.
   *
   * TOM: same idea, one slot over — the calendar day immediately after
   * Cash/referenceDate that Sri Lanka itself would treat as the next
   * business day. If THAT specific day is a pure US holiday, Tom can't
   * exist there either (`tomHidden: true`, `tom: null`) — and instead of
   * pushing Spot a further hop out past it, Spot collapses back to take
   * that same slot (the next day genuinely open on both sides), exactly
   * where Tom would otherwise have landed.
   *
   * A normal working day, with no US holiday sitting in either the Cash
   * or Tom slot, is completely unaffected — same dates as always.
   */
  function buildValueDates(tradeDate) {
    const cal = FXCalendar;

    // A "pure" US holiday: Sri Lanka itself is open (not a weekend, not
    // an SL bank holiday) but the US side isn't — this is the only case
    // that hides a value date outright rather than rolling it forward.
    // When a US holiday coincides with a weekend/SL holiday, that's just
    // an ordinary non-working day and dates roll forward as they always
    // have.
    const isPureUSHoliday = (d) => cal.isUSHoliday(d) && !cal.isWeekend(d) && !cal.isHoliday(d);

    let cash = null;
    const cashHidden = isPureUSHoliday(tradeDate);
    let referenceDate;

    if (cashHidden) {
      // No Cash date exists today, but "today" is still today — Tom
      // should be measured forward from the actual trade date, not from
      // some earlier already-passed working day. (Walking backward here
      // was the bug: it could land Tom's candidate slot back on the very
      // same holiday, wrongly cascading the hide down to Tom too.)
      referenceDate = new Date(tradeDate);
    } else {
      cash = cal.isWorkingDay(tradeDate) ? new Date(tradeDate) : cal.rollFollowing(tradeDate);
      referenceDate = cash;
    }

    // The "natural" T+1 slot: the very next day Sri Lanka itself would
    // call a business day (weekend/SL-holiday skipped), before even
    // considering whether the US is open that day.
    let candidateTom = cal.addDays(referenceDate, 1);
    while (cal.isWeekend(candidateTom) || cal.isHoliday(candidateTom)) {
      candidateTom = cal.addDays(candidateTom, 1);
    }
    // candidateTom is already guaranteed SL-open, so a US holiday there
    // is necessarily a "pure" one.
    const tomHidden = cal.isUSHoliday(candidateTom);

    let tom, spot;
    if (tomHidden) {
      tom = null;
      // Skips straight past the US-holiday slot to the next day open on
      // both sides — the same date Tom would have landed on under the
      // old roll-forward behavior, now claimed by Spot instead.
      spot = cal.addWorkingDays(referenceDate, 1);
    } else {
      tom = candidateTom;
      spot = cal.addWorkingDays(referenceDate, 2);
    }

    const dates = { cash, tom, spot };
    dates['1W'] = cal.addTenorWeeks(spot, 1);
    dates['2W'] = cal.addTenorWeeks(spot, 2);
    dates['3W'] = cal.addTenorWeeks(spot, 3);
    for (let m = 1; m <= 12; m++) {
      dates[`${m}M`] = cal.addTenorMonths(spot, m);
    }

    const days = {};
    const daysFromCash = {};
    TENOR_ORDER.forEach((t) => {
      if ((t === 'cash' && cashHidden) || (t === 'tom' && tomHidden)) {
        // No Cash/Tom value date to measure from/to today.
        days[t] = null;
        daysFromCash[t] = null;
        return;
      }
      days[t] = cal.calendarDaysBetween(spot, dates[t]); // negative for cash/tom — this is what the swap-point solver and Per Day premiums use throughout, since Spot is the real market anchor for forward points
      daysFromCash[t] = cal.calendarDaysBetween(referenceDate, dates[t]); // referenceDate as day 0 — for display (NOD column); equals Cash on a normal day, and the previous fully-open working day when Cash is hidden
    });

    return { cash, tom, spot, dates, days, daysFromCash, cashHidden, tomHidden, referenceDate };
  }

  /**
   * Curated default set of intervals a Colombo money-broking desk
   * actually quotes: near-date pairs (Cash-Tom, Tom-Spot, Cash-Spot),
   * the standard Spot-based ladder, forward-to-forward rolls, and a
   * couple of common Cash-based skips. Dealers can add any other
   * pair with the "custom interval" row in the UI.
   */
  const FORWARD_TENORS = ['1W', '2W', '3W', '1M', '2M', '3M', '4M', '5M', '6M', '7M', '8M', '9M', '10M', '11M', '12M'];
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

  /**
   * Every pair of directly-typed Rate Entries, linked to each other —
   * not just consecutive tenors, and not just pairs where BOTH sides of
   * BOTH rates are known. Unlike computeImpliedPremiums (which requires
   * a full Bid/Offer on both ends), this also works when only one side
   * was typed on either tenor — e.g. two bid-only entries still produce
   * a Payer relation, just no Receiver figure. Each relation includes
   * the real calendar days between the two tenors (via `days`, e.g.
   * ValueDates.days) so the caller can derive Per Day alongside the
   * flat total, exactly once, in one place.
   */
  function computeTenorRelations(anchors, days) {
    const byNode = {};
    anchors.forEach((a) => { byNode[a.node] = a; });
    const ordered = TENOR_ORDER.filter((t) => {
      const a = byNode[t];
      return a && (isNum(a.bid) || isNum(a.offer));
    });
    const results = [];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const from = ordered[i];
        const to = ordered[j];
        const a = byNode[from];
        const b = byNode[to];
        const payerPremium = numOrNull(b.bid, a.bid, (x, y) => x - y);
        const receiverPremium = numOrNull(b.offer, a.offer, (x, y) => x - y);
        if (payerPremium === null && receiverPremium === null) continue;
        const d = days && isNum(days[to]) && isNum(days[from]) ? days[to] - days[from] : null;
        results.push({
          from, to, days: d,
          payerPremium, receiverPremium,
          payerPremiumPerDay: payerPremium !== null && d ? payerPremium / d : null,
          receiverPremiumPerDay: receiverPremium !== null && d ? receiverPremium / d : null,
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
    computeTenorRelations,
  };
})();
