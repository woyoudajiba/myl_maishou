// Use Playwright's standard cache, or the caller's PLAYWRIGHT_BROWSERS_PATH.
const { chromium } = require('playwright');

async function launchPersistentContext(userDataDir, options) {
  return chromium.launchPersistentContext(userDataDir, {
    ...options,
    channel: 'chromium'
  });
}

module.exports = { launchPersistentContext };
