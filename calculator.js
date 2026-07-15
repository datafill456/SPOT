/* ============================================================
   calculator.js
   Value-date generation + the "intelligent solver" that fills in
   every rate, premium and derived figure it can from whatever
   subset of fields the dealer has typed in.

   MODEL
   -----
   For a given side (bid or offer) we treat the outright rate as a
   function of calendar days-from-spot:      outright(d) = spot + m*d
   where m = "points per day" (can be negative = discount).

   Spot itself is the intercept at d = 0. Cash/Tom sit at negative d
   (they settle before spot), the forward tenors sit at positive d.

   Bootstrapping spot & m ("intelligent solver"):
     1. Any row where the dealer typed BOTH outright and premium
        gives an exact point -> spot = outright - premium.
     2. Otherwise every row with a known outright is an anchor
        {days, outright}. 0 anchors -> unsolvable. 1 anchor at
        d=0 -> spot known, curve unknown. >=2 anchors -> least
        squares fit of spot (intercept) and m (slope) through them
        (exact if there are exactly two).
     3. If spot is known but m isn't, any row with a directly typed
        premium (no outright) contributes m = premium/days; those
        are averaged.
     4. Every remaining row is filled from spot + m*days. Rows the
        dealer typed directly are never overwritten.

   Broken dates (arbitrary custom value date) are interpolated
   piecewise-linearly between the two nearest SOLVED standard tenors,
   which is standard market practice and independent of the spot
   bootstrap above.
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

  /** Least-squares fit of outright = spot + m*days through 2+ points. */
  function fitLine(points) {
    const n = points.length;
    if (n === 0) return null;
    if (n === 1) return points[0].days === 0 ? { spot: points[0].outright, m: null } : null;

    const sumD = points.reduce((s, p) => s + p.days, 0);
    const sumR = points.reduce((s, p) => s + p.outright, 0);
    const sumDD = points.reduce((s, p) => s + p.days * p.days, 0);
    const sumDR = points.reduce((s, p) => s + p.days * p.outright, 0);
    const denom = n * sumDD - sumD * sumD;
    if (Math.abs(denom) < 1e-9) {
      // all same day (shouldn't happen) - fall back to average
      return { spot: sumR / n, m: null };
    }
    const m = (n * sumDR - sumD * sumR) / denom;
    const spot = (sumR - m * sumD) / n;
    return { spot, m };
  }

  /**
   * Solve one side (bid or offer) of the curve.
   * input[t] = { outright: number|null, premium: number|null } for each tenor t.
   * days[t] = calendar days from spot for each tenor.
   * Returns { spot, m, rows: { [t]: {outright, premium, source} } }
   */
  function solveSide(input, days) {
    // Step 1: exact spot points from rows with both fields typed.
    const exactSpots = [];
    TENOR_ORDER.forEach((t) => {
      const row = input[t] || {};
      if (isNum(row.outright) && isNum(row.premium)) {
        exactSpots.push(row.outright - row.premium);
      }
    });

    let spot = null;
    let m = null;

    if (exactSpots.length) {
      spot = avg(exactSpots);
    } else {
      const anchors = [];
      TENOR_ORDER.forEach((t) => {
        const row = input[t] || {};
        if (isNum(row.outright)) anchors.push({ days: days[t], outright: row.outright });
      });
      const fit = fitLine(anchors);
      if (fit) { spot = fit.spot; m = fit.m; }
    }

    if (spot !== null && m === null) {
      // Try to derive slope from directly-typed premiums.
      const slopes = [];
      TENOR_ORDER.forEach((t) => {
        const row = input[t] || {};
        if (isNum(row.premium) && !isNum(row.outright) && days[t] !== 0) {
          slopes.push(row.premium / days[t]);
        }
      });
      if (slopes.length) m = avg(slopes);
    }

    const rows = {};
    TENOR_ORDER.forEach((t) => {
      const row = input[t] || {};
      let outright = isNum(row.outright) ? row.outright : null;
      let premium = isNum(row.premium) ? row.premium : null;
      let source = 'blank';

      if (outright !== null && premium !== null) {
        source = 'typed';
      } else if (outright !== null && spot !== null) {
        premium = outright - spot;
        source = 'derived-from-outright';
      } else if (premium !== null && spot !== null) {
        outright = spot + premium;
        source = 'derived-from-premium';
      } else if (spot !== null && m !== null) {
        premium = m * days[t];
        outright = spot + premium;
        source = 'curve-fit';
      } else if (t === 'spot' && spot !== null) {
        outright = spot;
        premium = 0;
        source = 'spot-anchor';
      }

      rows[t] = { outright, premium, source };
    });

    return { spot, m, rows };
  }

  /**
   * Full market solve. rawInput shape:
   * { cash: {bid:{outright,premium}, offer:{...}}, tom: {...}, spot: {...}, '1W': {...}, ... }
   */
  function solveMarket(rawInput, valueDates) {
    const days = valueDates.days;
    const bidInput = {}, offerInput = {};
    TENOR_ORDER.forEach((t) => {
      bidInput[t] = (rawInput[t] && rawInput[t].bid) || {};
      offerInput[t] = (rawInput[t] && rawInput[t].offer) || {};
    });

    const bidSolve = solveSide(bidInput, days);
    const offerSolve = solveSide(offerInput, days);

    const curve = {};
    TENOR_ORDER.forEach((t) => {
      const b = bidSolve.rows[t];
      const o = offerSolve.rows[t];
      const d = days[t];

      curve[t] = {
        label: TENOR_LABELS[t],
        date: valueDates.dates[t],
        days,
        daysFromSpot: d,
        bidOutright: b.outright,
        offerOutright: o.outright,
        bidPremium: b.premium,
        offerPremium: o.premium,
        spreadOutright: numOrNull(o.outright, b.outright, (a, c) => a - c),
        spreadPremium: numOrNull(o.premium, b.premium, (a, c) => a - c),
        bidPremiumPerDay: d !== 0 && isNum(b.premium) ? b.premium / d : (d === 0 ? 0 : null),
        offerPremiumPerDay: d !== 0 && isNum(o.premium) ? o.premium / d : (d === 0 ? 0 : null),
        bidAnnualized: annualize(b.premium, bidSolve.spot, d),
        offerAnnualized: annualize(o.premium, offerSolve.spot, d),
        source: b.source,
      };
    });

    return {
      bidSpot: bidSolve.spot,
      offerSpot: offerSolve.spot,
      bidSlope: bidSolve.m,
      offerSlope: offerSolve.m,
      curve,
    };
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
      .filter((row) => isNum(row.bidPremium) && isNum(row.offerPremium))
      .map((row) => ({ days: row.daysFromSpot, bid: row.bidPremium, offer: row.offerPremium }))
      .sort((a, b) => a.days - b.days);

    if (points.length < 2) return null;

    let lower = null, upper = null;
    for (let i = 0; i < points.length - 1; i++) {
      if (targetDays >= points[i].days && targetDays <= points[i + 1].days) {
        lower = points[i]; upper = points[i + 1]; break;
      }
    }
    if (!lower) {
      // extrapolate using the two nearest points
      if (targetDays < points[0].days) { lower = points[0]; upper = points[1]; }
      else { lower = points[points.length - 2]; upper = points[points.length - 1]; }
    }

    const span = upper.days - lower.days || 1;
    const frac = (targetDays - lower.days) / span;
    const bidPremium = lower.bid + frac * (upper.bid - lower.bid);
    const offerPremium = lower.offer + frac * (upper.offer - lower.offer);
    return { days: targetDays, bidPremium, offerPremium };
  }

  function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }
  function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  function numOrNull(a, b, fn) { return isNum(a) && isNum(b) ? fn(a, b) : null; }

  return {
    TENOR_ORDER,
    TENOR_LABELS,
    buildValueDates,
    solveMarket,
    interpolateBrokenDate,
  };
})();
