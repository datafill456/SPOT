/* ============================================================
   excel.js
   Import/Export to Excel (via SheetJS, loaded from CDN in index.html),
   copy the dealer table to the clipboard, paste dealer quotes back in,
   and generate a printable PDF report (uses the browser's native
   print-to-PDF, so no heavy PDF library / backend is required).
   ============================================================ */

const FXExcel = (function () {
  const TENOR_ORDER = FXCalculator.TENOR_ORDER;

  function curveToRows(curve) {
    return TENOR_ORDER.map((t) => {
      const c = curve[t];
      return {
        Tenor: c.label,
        'Value Date': FXCalendar.fmt(c.date),
        'Days from Spot': c.daysFromSpot,
        'Payer Rate Bid': roundOrBlank(c.payerBid),
        'Payer Rate Offer': roundOrBlank(c.payerOffer),
        'Receiver Rate Bid': roundOrBlank(c.receiverBid),
        'Receiver Rate Offer': roundOrBlank(c.receiverOffer),
        'Payer Premium (Sell/Buy)': roundOrBlank(c.payerPremium),
        'Receiver Premium (Buy/Sell)': roundOrBlank(c.receiverPremium),
        'Payer Premium/Day': roundOrBlank(c.payerPremiumPerDay, 4),
        'Receiver Premium/Day': roundOrBlank(c.receiverPremiumPerDay, 4),
      };
    });
  }

  function roundOrBlank(v, dp = 4) {
    return typeof v === 'number' && !Number.isNaN(v) ? Number(v.toFixed(dp)) : '';
  }

  function exportToExcel(curve, tradeDateLabel) {
    if (typeof XLSX === 'undefined') {
      alert('Excel library did not load. Check your internet connection.');
      return;
    }
    const rows = curveToRows(curve);
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Premium Curve');
    XLSX.writeFile(wb, `FX_Premium_Curve_${tradeDateLabel}.xlsx`);
  }

  function exportToCSV(curve, tradeDateLabel) {
    const rows = curveToRows(curve);
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(',')];
    rows.forEach((r) => {
      lines.push(headers.map((h) => r[h]).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `FX_Premium_Curve_${tradeDateLabel}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Import an Excel workbook of quotes: expects columns Tenor,Bid,Offer (outright or premium). */
  function importFromExcel(file, callback) {
    if (typeof XLSX === 'undefined') {
      alert('Excel library did not load. Check your internet connection.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
      callback(rows);
    };
    reader.readAsArrayBuffer(file);
  }

  function copyTableToClipboard(curve) {
    const rows = curveToRows(curve);
    const headers = Object.keys(rows[0]);
    const lines = [headers.join('\t')];
    rows.forEach((r) => lines.push(headers.map((h) => r[h]).join('\t')));
    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(
      () => true,
      () => false
    );
    return text;
  }

  /**
   * Parse pasted dealer-quote text (tab or comma separated) of the
   * form: Tenor <tab> Bid <tab> Offer, one per line. Returns an array
   * of {tenorKey, bid, offer} guesses matched against known tenor labels.
   */
  function parsePastedQuotes(text) {
    const labelToKey = {};
    FXCalculator.TENOR_ORDER.forEach((k) => {
      labelToKey[FXCalculator.TENOR_LABELS[k].toLowerCase()] = k;
      labelToKey[k.toLowerCase()] = k;
    });

    const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
    const results = [];
    lines.forEach((line) => {
      const parts = line.split(/\t|,/).map((p) => p.trim());
      if (parts.length < 2) return;
      const tenorRaw = parts[0].toLowerCase();
      const key = labelToKey[tenorRaw];
      if (!key) return;
      const bid = parseFloat(parts[1]);
      const offer = parts.length > 2 ? parseFloat(parts[2]) : null;
      results.push({ tenorKey: key, bid: isFinite(bid) ? bid : null, offer: isFinite(offer) ? offer : null });
    });
    return results;
  }

  /** Build a printable report window and trigger the browser's Save-as-PDF print dialog. */
  function generatePDFReport(curve, meta) {
    const rows = curveToRows(curve);
    const win = window.open('', '_blank');
    const style = `
      body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#111;}
      h1{font-size:18px;margin-bottom:0;}
      .sub{color:#555;margin-top:4px;margin-bottom:20px;font-size:12px;}
      table{border-collapse:collapse;width:100%;font-size:11px;}
      th,td{border:1px solid #ccc;padding:6px 8px;text-align:right;}
      th{background:#eee;text-align:center;}
      td:first-child, th:first-child{text-align:left;}
    `;
    const headers = Object.keys(rows[0]);
    const tableRows = rows
      .map((r) => `<tr>${headers.map((h) => `<td>${r[h]}</td>`).join('')}</tr>`)
      .join('');
    win.document.write(`
      <html><head><title>FX Premium Report</title><style>${style}</style></head>
      <body>
        <h1>MVS Money Brokers — FX Premium Curve Report</h1>
        <div class="sub">Currency Pair: ${meta.pair || 'USD/LKR'} &nbsp;|&nbsp; Trade Date: ${meta.tradeDateLabel}</div>
        <div class="sub">Spot — Payer ${meta.payerSpotBid ?? '-'} / ${meta.payerSpotOffer ?? '-'} &nbsp;|&nbsp; Receiver ${meta.receiverSpotBid ?? '-'} / ${meta.receiverSpotOffer ?? '-'}</div>
        <div class="sub">Rates shown as Bid/Offer &nbsp;·&nbsp; Premiums shown as Payer (Sell/Buy, pays premium) / Receiver (Buy/Sell, receives premium)</div>
        <table>
          <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </body></html>
    `);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  }

  return {
    exportToExcel,
    exportToCSV,
    importFromExcel,
    copyTableToClipboard,
    parsePastedQuotes,
    generatePDFReport,
    curveToRows,
  };
})();
