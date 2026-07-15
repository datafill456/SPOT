/* ============================================================
   calendar.js
   Sri Lanka Bank Holiday Engine + Working Day Date Math
   All dates are handled as local midnight Date objects (UTC+5:30
   is assumed to be the user's local time when this runs on a
   Sri Lankan machine / browser, so plain Date math is sufficient).
   ============================================================ */

/**
 * Editable holiday list. Add / remove / update entries here — nothing
 * else in the codebase needs to change. Format: 'YYYY-MM-DD'.
 * Source: CBSL / Gazette Extraordinary 2438/22 (2026 Public & Bank
 * Holidays) plus New Year's Day. Update this list every December for
 * the following year.
 */
const SL_HOLIDAYS_2026 = [
  '2026-01-01', // New Year's Day
  '2026-01-03', // Duruthu Full Moon Poya Day
  '2026-01-15', // Tamil Thai Pongal Day
  '2026-02-01', // Navam Full Moon Poya Day
  '2026-02-04', // National Day
  '2026-02-15', // Mahasivarathri Day
  '2026-03-02', // Madin Full Moon Poya Day
  '2026-03-21', // Id-Ul-Fitr
  '2026-04-01', // Bak Full Moon Poya Day
  '2026-04-03', // Good Friday
  '2026-04-13', // Day prior to Sinhala & Tamil New Year
  '2026-04-14', // Sinhala & Tamil New Year Day
  '2026-05-01', // May Day / Vesak Full Moon Poya Day
  '2026-05-02', // Day following Vesak Full Moon Poya Day
  '2026-05-28', // Id-Ul-Alha
  '2026-05-30', // Adhi Poson Full Moon Poya Day
  '2026-06-29', // Poson Full Moon Poya Day
  '2026-07-29', // Esala Full Moon Poya Day
  '2026-08-26', // Milad-un-Nabi
  '2026-08-27', // Nikini Full Moon Poya Day
  '2026-09-26', // Binara Full Moon Poya Day
  '2026-10-25', // Vap Full Moon Poya Day
  '2026-11-08', // Deepavali
  '2026-11-24', // Ill Full Moon Poya Day
  '2026-12-23', // Unduvap Full Moon Poya Day
  '2026-12-25', // Christmas Day
];

/**
 * Optional friendly names, keyed the same way, purely for tooltips.
 */
const SL_HOLIDAY_NAMES_2026 = {
  '2026-01-01': "New Year's Day",
  '2026-01-03': 'Duruthu Full Moon Poya Day',
  '2026-01-15': 'Tamil Thai Pongal Day',
  '2026-02-01': 'Navam Full Moon Poya Day',
  '2026-02-04': 'National Day',
  '2026-02-15': 'Mahasivarathri Day',
  '2026-03-02': 'Madin Full Moon Poya Day',
  '2026-03-21': 'Id-Ul-Fitr',
  '2026-04-01': 'Bak Full Moon Poya Day',
  '2026-04-03': 'Good Friday',
  '2026-04-13': 'Day prior to Sinhala & Tamil New Year',
  '2026-04-14': 'Sinhala & Tamil New Year Day',
  '2026-05-01': 'May Day / Vesak Full Moon Poya Day',
  '2026-05-02': 'Day following Vesak Poya Day',
  '2026-05-28': 'Id-Ul-Alha',
  '2026-05-30': 'Adhi Poson Full Moon Poya Day',
  '2026-06-29': 'Poson Full Moon Poya Day',
  '2026-07-29': 'Esala Full Moon Poya Day',
  '2026-08-26': 'Milad-un-Nabi',
  '2026-08-27': 'Nikini Full Moon Poya Day',
  '2026-09-26': 'Binara Full Moon Poya Day',
  '2026-10-25': 'Vap Full Moon Poya Day',
  '2026-11-08': 'Deepavali',
  '2026-11-24': 'Ill Full Moon Poya Day',
  '2026-12-23': 'Unduvap Full Moon Poya Day',
  '2026-12-25': 'Christmas Day',
};

const FXCalendar = (function () {
  // Live-editable holiday set, backed by localStorage so users can add
  // ad-hoc bank holidays without touching code.
  const STORAGE_KEY = 'fx_terminal_holidays_v1';

  function loadHolidaySet() {
    try {
      const custom = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (custom && Array.isArray(custom)) {
        return new Set([...SL_HOLIDAYS_2026, ...custom]);
      }
    } catch (e) { /* ignore corrupt storage */ }
    return new Set(SL_HOLIDAYS_2026);
  }

  let holidaySet = loadHolidaySet();

  function fmt(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parse(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6; // Sunday, Saturday
  }

  function isHoliday(date) {
    return holidaySet.has(fmt(date));
  }

  function holidayName(date) {
    return SL_HOLIDAY_NAMES_2026[fmt(date)] || 'Bank Holiday';
  }

  function isWorkingDay(date) {
    return !isWeekend(date) && !isHoliday(date);
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  /** Next working day strictly after `date` (does not check `date` itself). */
  function nextWorkingDay(date) {
    let d = addDays(date, 1);
    while (!isWorkingDay(d)) d = addDays(d, 1);
    return d;
  }

  /** Previous working day strictly before `date`. */
  function previousWorkingDay(date) {
    let d = addDays(date, -1);
    while (!isWorkingDay(d)) d = addDays(d, -1);
    return d;
  }

  /** Roll a date forward to the nearest working day (following convention). */
  function rollFollowing(date) {
    let d = new Date(date);
    while (!isWorkingDay(d)) d = addDays(d, 1);
    return d;
  }

  /** Roll a date backward to the nearest working day (preceding convention). */
  function rollPreceding(date) {
    let d = new Date(date);
    while (!isWorkingDay(d)) d = addDays(d, -1);
    return d;
  }

  /**
   * Modified following: roll forward, but if that pushes into the next
   * calendar month, roll backward instead. Standard FX/interest-rate
   * market convention for month-end tenors.
   */
  function modifiedFollowing(date) {
    const rolled = rollFollowing(date);
    if (rolled.getMonth() !== date.getMonth()) {
      return rollPreceding(date);
    }
    return rolled;
  }

  /** Add N working days from a start date (start date itself not counted). */
  function addWorkingDays(date, n) {
    let d = new Date(date);
    let count = 0;
    const step = n >= 0 ? 1 : -1;
    while (count !== n) {
      d = addDays(d, step);
      if (isWorkingDay(d)) count += step >= 0 ? 1 : -1;
    }
    return d;
  }

  /** Count *working* days between two dates (exclusive of start, inclusive of end). */
  function workingDaysBetween(start, end) {
    if (end < start) return -workingDaysBetween(end, start);
    let d = new Date(start);
    let count = 0;
    while (d < end) {
      d = addDays(d, 1);
      if (isWorkingDay(d)) count++;
    }
    return count;
  }

  /** Calendar days between two dates (end - start), can be negative. */
  function calendarDaysBetween(start, end) {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    // normalize to midnight to avoid DST/half-day drift
    const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    return Math.round((e - s) / MS_PER_DAY);
  }

  /**
   * Add calendar months to a date, then apply modified-following
   * adjustment. Preserves "end of month in -> end of month out" so a
   * Spot on the last business day of a month produces a Forward on the
   * last business day of the target month (EOM rule).
   */
  function addTenorMonths(spotDate, months) {
    const isEOM = (() => {
      const next = addDays(spotDate, 1);
      return next.getMonth() !== spotDate.getMonth();
    })();

    const d = new Date(spotDate);
    const targetMonth = d.getMonth() + months;
    const targetDate = new Date(d.getFullYear(), targetMonth, 1);
    const daysInTargetMonth = new Date(
      targetDate.getFullYear(),
      targetDate.getMonth() + 1,
      0
    ).getDate();

    let day = isEOM ? daysInTargetMonth : Math.min(d.getDate(), daysInTargetMonth);
    let result = new Date(targetDate.getFullYear(), targetDate.getMonth(), day);
    return modifiedFollowing(result);
  }

  function addTenorWeeks(spotDate, weeks) {
    const raw = addDays(spotDate, weeks * 7);
    return rollFollowing(raw);
  }

  function addCustomHoliday(iso) {
    holidaySet.add(iso);
    const custom = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!custom.includes(iso)) {
      custom.push(iso);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
    }
  }

  function listHolidays() {
    return Array.from(holidaySet).sort();
  }

  return {
    fmt,
    parse,
    isWeekend,
    isHoliday,
    holidayName,
    isWorkingDay,
    addDays,
    nextWorkingDay,
    previousWorkingDay,
    rollFollowing,
    rollPreceding,
    modifiedFollowing,
    addWorkingDays,
    workingDaysBetween,
    calendarDaysBetween,
    addTenorMonths,
    addTenorWeeks,
    addCustomHoliday,
    listHolidays,
  };
})();
