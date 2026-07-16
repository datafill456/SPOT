# MVS FX Terminal — USD/LKR Money Broker Dealing Screen

A zero-backend, GitHub-Pages-ready dealing terminal for Sri Lankan interbank
money brokers. Enter whatever quotes you have; the solver fills in the rest.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup, tabs, tables, loads Chart.js + SheetJS from CDN |
| `style.css` | Bloomberg-inspired dark/light dealing-room theme |
| `calendar.js` | Sri Lanka bank-holiday engine + working-day date math |
| `calculator.js` | Value-date ladder generation + the bid/offer curve solver |
| `storage.js` | LocalStorage: draft autosave, daily history archive, settings |
| `excel.js` | Excel/CSV import & export, clipboard copy, paste-quotes, PDF report |
| `chart.js` | Chart.js wrappers for the four chart views |
| `script.js` | Renders every tab and wires up all inputs/keyboard nav |

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
change. Dealers can also add one-off holidays from the Settings tab;
those are merged in from LocalStorage automatically.

## How the solver works — swap points between any two dates

Real desks don't quote a premium "for a date" — they quote **points
for an interval**: Cash–Tom, Tom–Spot, Cash–Spot, Spot–1M, 1M–2M,
Cash–3M, and so on. Points are additive along the date axis
(Cash–Spot + Spot–1M = Cash–1M, exactly), so the whole set of
intervals the dealer types in forms a graph: nodes are value dates
(Cash, Tom, Spot, 1W…12M), edges are quoted intervals.

Each side is solved independently and is labeled **Payer / Receiver**
— the side paying the premium (buying the forward) vs. the side
receiving it (selling the forward) — rather than bid/offer.

1. Every typed interval becomes a graph edge. A breadth-first search
   over the graph gives every reachable node's value **relative to
   Spot** — this alone produces "premium from Spot" (or between any
   two tenors in the same connected set of intervals) even with zero
   absolute rates entered anywhere.
2. If the dealer also types one real **outright anchor rate** for any
   single value date, that whole connected component of the graph
   shifts from relative to absolute: `outright(node) = anchor +
   (relative value of node − relative value of anchor)`.
3. Nodes with no path back to an anchor stay blank for outright, but
   still show a premium/points figure if they're chained to Spot.
4. **Premium per day** = premium ÷ calendar days from Spot.
   **Annualized premium %** = `(premium / spot) × (365 / days) × 100`
   (needs an anchor to be resolvable).

Example: type `Cash–Spot` points and `Spot–1M` points (no outright
anywhere) → you immediately see the derived `Cash–1M` premium and
every other connected tenor's premium-from-Spot, with outrights
appearing the moment you add one real anchor rate (e.g. today's
actual Spot rate).

**Broken dates** (the Broken Date tab) are handled separately and more
conventionally: once the standard tenor curve above is solved, an
arbitrary custom date is interpolated **piecewise-linearly between the
two nearest solved standard tenors** — the market-standard approach.

## Data & persistence

Everything lives in the browser's LocalStorage — there is no backend
and no database:

- The current, unsaved quote grid autosaves as a **draft** every time
  you type (debounced), so a refresh doesn't lose today's work. Drafts
  only restore if the trade date matches — a new calendar day starts
  with a clean sheet.
- **"Save Today's Quotes to History"** archives the day's solved curve
  permanently, keyed by date, for the History tab, day-vs-day compare,
  and the Premium History chart.
- Custom holidays and the dark/light preference are also stored here.

## Keyboard

- **Tab** — native browser field order.
- **Enter** — save and move to the next field.
- **Arrow Up / Down** — jump to the same column, one tenor row up/down.
- **Arrow Left / Right** — jump to the previous/next field once the
  caret is at the start/end of the current one, so normal text editing
  inside a field still works.

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
