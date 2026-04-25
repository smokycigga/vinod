/**
 * Utility functions for invoice numbering
 */

/**
 * Get financial year string from a date
 * Financial year: April to March (FY2627 = Apr 2026 - Mar 2027)
 * @param {Date} date - The date to calculate FY for
 * @returns {String} Financial year in format "YYYY" (e.g., "2627")
 */
function getFinancialYear(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = d.getMonth(); // 0-indexed (0 = Jan, 3 = Apr, 11 = Dec)

    // If date is before April, FY starts previous year; otherwise current year.
    const startYear = month < 3 ? year - 1 : year;
    const endYear = startYear + 1;

    return `${String(startYear).slice(-2)}${String(endYear).slice(-2)}`;
}

/**
 * Check if a given date is in financial year
 * @param {Date} date - The date to check
 * @param {String} financialYear - FY in format "2627"
 * @returns {Boolean}
 */
function isInFinancialYear(date, financialYear) {
    return getFinancialYear(date) === financialYear;
}

/**
 * Get the start date of a financial year (April 1st)
 * @param {String} financialYear - FY in format "2627"
 * @returns {Date} Start date of FY (April 1st)
 */
function getFinancialYearStart(financialYear) {
    const startTwoDigit = parseInt(String(financialYear).slice(0, 2), 10);
    const startYear = 2000 + startTwoDigit;
    return new Date(`April 1, ${startYear}`);
}

/**
 * Get the end date of a financial year (March 31st)
 * @param {String} financialYear - FY in format "2627"
 * @returns {Date} End date of FY (March 31st)
 */
function getFinancialYearEnd(financialYear) {
    const endTwoDigit = parseInt(String(financialYear).slice(2, 4), 10);
    const endYear = 2000 + endTwoDigit;
    return new Date(`March 31, ${endYear}`);
}

module.exports = {
    getFinancialYear,
    isInFinancialYear,
    getFinancialYearStart,
    getFinancialYearEnd
};
