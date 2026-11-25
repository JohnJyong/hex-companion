'use strict';

// After a panel closes, keep looking at the last verified title position.
// A wider search still runs periodically so a moved panel can be found again.
function createDiscoveryScan() {
  let titleBand = null;
  let lastWideScan = null;

  function endSearch() {
    lastWideScan = null;
  }

  function reset() {
    titleBand = null;
    endSearch();
  }

  function learn(roi) {
    titleBand = { x: roi.x, y: roi.y, width: roi.width, height: roi.height };
    endSearch();
  }

  function search(now) {
    if (!titleBand) return null;
    if (lastWideScan === null || now < lastWideScan || now - lastWideScan >= 2000) {
      lastWideScan = now;
      return null;
    }
    return titleBand;
  }

  return { reset, learn, search, endSearch };
}

module.exports = { createDiscoveryScan };
