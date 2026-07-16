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
  const DEFAULT_INTERVALS = [
    ['cash', 'tom'], ['tom', 'spot'], ['cash', 'spot'],
    ['spot', '1W'], ['spot', '2W'], ['spot', '1M'], ['spot', '2M'],
    ['spot', '3M'], ['spot', '6M'], ['spot', '12M'],
    ['1M', '2M'], ['2M', '3M'], ['3M', '6M'], ['6M', '12M'],
    ['cash', '1M'], ['cash', '3M'],
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
   * edges:   [{ from, to, payer: number|null, receiver: number|null }]
   * anchors: [{ node, payer: number|null, receiver: number|null }]
   */
  function solveMarket(edges, anchors, valueDates) {
    const days = valueDates.days;

    const payerEdges = edges.map((e) => ({ from: e.from, to: e.to, value: e.payer }));
    const receiverEdges = edges.map((e) => ({ from: e.from, to: e.to, value: e.receiver }));
    const payerAnchors = anchors.map((a) => ({ node: a.node, value: a.payer }));
    const receiverAnchors = anchors.map((a) => ({ node: a.node, value: a.receiver }));

    const payerSolve = solveSideGraph(payerEdges, payerAnchors);
    const receiverSolve = solveSideGraph(receiverEdges, receiverAnchors);

    const curve = {};
    TENOR_ORDER.forEach((t) => {
      const d = days[t];
      const payerPremium = payerSolve.relFromSpot[t];
      const receiverPremium = receiverSolve.relFromSpot[t];
      const payerOutright = payerSolve.absolute[t];
      const receiverOutright = receiverSolve.absolute[t];

      curve[t] = {
        label: TENOR_LABELS[t],
        date: valueDates.dates[t],
        daysFromSpot: d,
        payerOutright,
        receiverOutright,
        payerPremium,
        receiverPremium,
        spreadOutright: numOrNull(payerOutright, receiverOutright, (a, c) => a - c),
        spreadPremium: numOrNull(payerPremium, receiverPremium, (a, c) => a - c),
        payerPremiumPerDay: d !== 0 && isNum(payerPremium) ? payerPremium / d : (d === 0 ? 0 : null),
        receiverPremiumPerDay: d !== 0 && isNum(receiverPremium) ? receiverPremium / d : (d === 0 ? 0 : null),
        payerAnnualized: annualize(payerPremium, payerSolve.absolute.spot, d),
        receiverAnnualized: annualize(receiverPremium, receiverSolve.absolute.spot, d),
      };
    });

    return {
      payerSpot: payerSolve.absolute.spot,
      receiverSpot: receiverSolve.absolute.spot,
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
  };
})();
