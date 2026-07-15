/* ============================================================
   chart.js
   Thin wrapper around Chart.js (loaded from CDN in index.html) for
   the four chart views: Forward Curve, Premium Per Day, Annualized
   Premium, and Premium History across saved days.
   ============================================================ */

const FXCharts = (function () {
  const instances = {};

  function destroy(id) {
    if (instances[id]) {
      instances[id].destroy();
      delete instances[id];
    }
  }

  function baseOptions(yLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#c7d0da' } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { ticks: { color: '#8a94a3' }, grid: { color: '#232a35' } },
        y: {
          ticks: { color: '#8a94a3' },
          grid: { color: '#232a35' },
          title: { display: !!yLabel, text: yLabel, color: '#8a94a3' },
        },
      },
    };
  }

  function renderForwardCurve(canvasId, curve) {
    destroy(canvasId);
    const tenors = FXCalculator.TENOR_ORDER;
    const labels = tenors.map((t) => curve[t].label);
    const bid = tenors.map((t) => curve[t].bidOutright);
    const offer = tenors.map((t) => curve[t].offerOutright);

    instances[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Bid Outright', data: bid, borderColor: '#2ecc71', backgroundColor: 'transparent', tension: 0.25 },
          { label: 'Offer Outright', data: offer, borderColor: '#ff5252', backgroundColor: 'transparent', tension: 0.25 },
        ],
      },
      options: baseOptions('Rate'),
    });
  }

  function renderPremiumPerDay(canvasId, curve) {
    destroy(canvasId);
    const tenors = FXCalculator.TENOR_ORDER.filter((t) => t !== 'spot');
    const labels = tenors.map((t) => curve[t].label);
    const bid = tenors.map((t) => curve[t].bidPremiumPerDay);
    const offer = tenors.map((t) => curve[t].offerPremiumPerDay);

    instances[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Bid Premium / Day', data: bid, backgroundColor: '#2ecc71' },
          { label: 'Offer Premium / Day', data: offer, backgroundColor: '#ff5252' },
        ],
      },
      options: baseOptions('Points per day'),
    });
  }

  function renderAnnualized(canvasId, curve) {
    destroy(canvasId);
    const tenors = FXCalculator.TENOR_ORDER.filter((t) => t !== 'spot');
    const labels = tenors.map((t) => curve[t].label);
    const bid = tenors.map((t) => curve[t].bidAnnualized);
    const offer = tenors.map((t) => curve[t].offerAnnualized);

    instances[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Bid Annualized %', data: bid, borderColor: '#4da3ff', backgroundColor: 'transparent', tension: 0.25 },
          { label: 'Offer Annualized %', data: offer, borderColor: '#f5a623', backgroundColor: 'transparent', tension: 0.25 },
        ],
      },
      options: baseOptions('% p.a.'),
    });
  }

  function renderHistory(canvasId, historySnapshots, tenorKey) {
    destroy(canvasId);
    const dates = Object.keys(historySnapshots).sort();
    const bid = dates.map((d) => historySnapshots[d]?.curve?.[tenorKey]?.bidPremium ?? null);
    const offer = dates.map((d) => historySnapshots[d]?.curve?.[tenorKey]?.offerPremium ?? null);

    instances[canvasId] = new Chart(document.getElementById(canvasId), {
      type: 'line',
      data: {
        labels: dates,
        datasets: [
          { label: `${tenorKey} Bid Premium`, data: bid, borderColor: '#2ecc71', backgroundColor: 'transparent', tension: 0.2 },
          { label: `${tenorKey} Offer Premium`, data: offer, borderColor: '#ff5252', backgroundColor: 'transparent', tension: 0.2 },
        ],
      },
      options: baseOptions('Premium'),
    });
  }

  return { renderForwardCurve, renderPremiumPerDay, renderAnnualized, renderHistory, destroy };
})();
