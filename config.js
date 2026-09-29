// Where the site talks to its backend.
// Localhost uses the mock server (dev/mock-server.js); everything else uses the Apps Script web app.
var LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
var CONFIG = {
  API_URL: LOCAL ? '/api' : 'https://script.google.com/macros/s/AKfycbzPTwbKWQstw-R9rxot9GI0RvYyuFPGwKm7CcKREoEFZwalVVF_2a0zthfYEMCl9fk/exec',
  SITE_URL: 'https://jarrardcole.github.io/survivor51/',
  SEASON: 51,
  // Wednesday nights, 8pm ET. Used for "next episode" countdowns.
  AIR_DATES: {
    1: '2026-09-23T20:00:00-04:00',
    2: '2026-09-30T20:00:00-04:00',
    3: '2026-10-07T20:00:00-04:00',
    4: '2026-10-14T20:00:00-04:00',
    5: '2026-10-21T20:00:00-04:00',
    6: '2026-10-28T20:00:00-04:00',
    7: '2026-11-04T20:00:00-05:00',
    8: '2026-11-11T20:00:00-05:00',
    9: '2026-11-18T20:00:00-05:00',
    10: '2026-11-25T20:00:00-05:00',
    11: '2026-12-02T20:00:00-05:00',
    12: '2026-12-09T20:00:00-05:00',
    13: '2026-12-16T20:00:00-05:00'
  }
};
