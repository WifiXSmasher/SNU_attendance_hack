// popup.js

let threshold = 75;
let currentData = null;

// ── DOM refs ────────────────────────────────────────────────────────────────
const threshVal   = document.getElementById('threshVal');
const threshUp    = document.getElementById('threshUp');
const threshDown  = document.getElementById('threshDown');
const statusDot   = document.querySelector('.status-dot');
const statusText  = document.getElementById('status-text');
const idleView    = document.getElementById('idle-view');
const loadingView = document.getElementById('loading');
const errorView   = document.getElementById('error-view');
const coursesView = document.getElementById('courses-view');
const errorMsg    = document.getElementById('error-msg');
const coursesList = document.getElementById('courses-list');
const btnScan     = document.getElementById('btn-scan');

// ── Threshold controls ───────────────────────────────────────────────────────
threshUp.addEventListener('click', () => { threshold = Math.min(100, threshold + 5); updateThreshold(); });
threshDown.addEventListener('click', () => { threshold = Math.max(50, threshold - 5); updateThreshold(); });

function updateThreshold() {
  threshVal.textContent = threshold + '%';
  if (currentData) renderCourses(currentData);
}

// ── Scan button ──────────────────────────────────────────────────────────────
btnScan.addEventListener('click', scanPage);

function scanPage() {
  show('loading');
  setStatus('scanning', 'Scanning attendance page...');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url?.includes('snu.edu.in')) {
      setStatus('err', 'Not on SNU attendance page');
      errorMsg.textContent = 'Please open the SNU attendance summary page first.';
      show('error');
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'scrapeAttendance' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        // Try injecting content script dynamically
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        }, () => {
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, { action: 'scrapeAttendance' }, handleScrapeResponse);
          }, 300);
        });
        return;
      }
      handleScrapeResponse(response);
    });
  });
}

function handleScrapeResponse(response) {
  if (!response || !response.success || !response.data?.length) {
    setStatus('err', 'No data found');
    errorMsg.textContent = response?.error || 'Could not find attendance data. Make sure you are on the Summary page.';
    show('error');
    return;
  }
  currentData = response.data;
  renderCourses(currentData);
}

// ── Rescan ───────────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('rescan-btn')) scanPage();
});

// ── Core calculation ─────────────────────────────────────────────────────────

/**
 * For a given course, computes the weighted attendance using credit-hour weights.
 *
 * The university multiplies LEC attendance by 1.5 (3 credits → 1.5× each class)
 * and TUT/PRA by their credit weight (1:1 for tut, 1:1 for pra by default).
 *
 * From the page data:
 *   - creditHours.lec = { attended: X, conducted: Y }  (already credit-weighted)
 *   - creditHours.pra = { attended: X, conducted: Y }  (already credit-weighted)
 *   - attendance.tut  = { attended: X, conducted: Y }  (raw; tut credit usually 1)
 *
 * We reconstruct each component's raw class count from the raw attendance field,
 * and derive weight from the creditHours vs raw ratio.
 */
function calcStats(course, thresh) {
  const T = thresh / 100;

  // Gather components with their effective weights
  const components = [];

  // LEC
  if (course.attendance.lec) {
    const raw = course.attendance.lec;
    const ch  = course.creditHours.lec;
    const weight = (ch && raw.conducted > 0) ? (ch.conducted / raw.conducted) : course.credits.lec;
    components.push({
      type: 'LEC',
      attended: raw.attended,
      conducted: raw.conducted,
      weight: weight > 0 ? weight : 1
    });
  }

  // TUT
  if (course.attendance.tut && course.attendance.tut.conducted > 0) {
    const raw = course.attendance.tut;
    const ch  = course.creditHours.tut;
    const weight = (ch && raw.conducted > 0) ? (ch.conducted / raw.conducted) : course.credits.tut || 1;
    components.push({
      type: 'TUT',
      attended: raw.attended,
      conducted: raw.conducted,
      weight: weight > 0 ? weight : 1
    });
  }

  // PRA
  if (course.attendance.pra && course.attendance.pra.conducted > 0) {
    const raw = course.attendance.pra;
    const ch  = course.creditHours.pra;
    const weight = (ch && raw.conducted > 0) ? (ch.conducted / raw.conducted) : course.credits.pra || 1;
    components.push({
      type: 'PRA',
      attended: raw.attended,
      conducted: raw.conducted,
      weight: weight > 0 ? weight : 1
    });
  }

  if (!components.length) return null;

  // Current weighted attendance
  const totalWeightedAttended  = components.reduce((s, c) => s + c.attended * c.weight, 0);
  const totalWeightedConducted = components.reduce((s, c) => s + c.conducted * c.weight, 0);
  const currentPct = totalWeightedConducted > 0 ? (totalWeightedAttended / totalWeightedConducted) * 100 : 0;

  // Check if > threshold
  if (currentPct >= thresh) {
    // How many classes can be missed while staying >= threshold?
    // We try all combos of missing classes across components
    const canMiss = computeMissableCombos(components, T, thresh);
    return { currentPct, status: 'safe', components, canMiss };
  } else {
    // How many more classes needed (assuming all future classes are attended)?
    const needed = computeClassesNeeded(components, T);
    return { currentPct, status: 'unsafe', components, needed };
  }
}

/**
 * Computes how many additional consecutive classes to attend (all types)
 * to reach the threshold.
 * Assumes future classes are conducted in same ratio as current credit weights.
 */
function computeClassesNeeded(components, T) {
  // We need: (wAttended + wFuture*attended) / (wConducted + wFuture*conducted) >= T
  // Where future classes are attended fully; simplify by adding 1 raw class per component.
  // We try adding classes one by one (up to 50) to find minimum.

  let attended  = components.reduce((s, c) => s + c.attended * c.weight, 0);
  let conducted = components.reduce((s, c) => s + c.conducted * c.weight, 0);

  // Each "round" of classes: assume one LEC per round (most common)
  // Better: compute how many total credit-weighted classes needed
  // (attended + x) / (conducted + x * totalWeight/classCount) >= T
  // We'll step through it naively up to 100 tries

  const totalWeight = components.reduce((s, c) => s + c.weight, 0) / components.length;

  const results = [];
  let extraAttended  = 0;
  let extraConducted = 0;

  for (let i = 1; i <= 200; i++) {
    extraAttended  += totalWeight;
    extraConducted += totalWeight;

    const newPct = (attended + extraAttended) / (conducted + extraConducted) * 100;
    if (newPct >= T * 100) {
      results.push({ classes: i, projectedPct: newPct });
      break;
    }
  }

  // Also compute per-component breakdown: minimum needed in each type
  const perComponent = components.map(comp => {
    // How many more of just this type to reach threshold?
    let a = comp.attended * comp.weight;
    let cd = comp.conducted * comp.weight;
    const otherA  = attended - a;
    const otherCd = conducted - cd;

    for (let n = 1; n <= 200; n++) {
      const newA  = a + n * comp.weight;
      const newCd = cd + n * comp.weight;
      const pct   = (otherA + newA) / (otherCd + newCd) * 100;
      if (pct >= T * 100) {
        return { type: comp.type, count: n, projectedPct: pct };
      }
    }
    return { type: comp.type, count: '200+', projectedPct: null };
  });

  return { overall: results[0] || null, perComponent };
}

/**
 * Enumerates combos of classes that can be missed while keeping attendance >= threshold.
 * Returns array of combo objects [{lec:N, tut:N, pra:N, projectedPct}]
 */
function computeMissableCombos(components, T, threshPct) {
  const attended  = components.reduce((s, c) => s + c.attended * c.weight, 0);
  const conducted = components.reduce((s, c) => s + c.conducted * c.weight, 0);

  // Find max missable for each component independently
  const maxMiss = components.map(comp => {
    for (let n = 0; n <= 50; n++) {
      const newA  = attended - n * comp.weight;
      const newCd = conducted; // conducted doesn't change when missing future? 
      // Actually missing = absent from future classes
      // So attended stays same, conducted increases (we attend 0 of them)
      // newAttended = attended, newConducted = conducted + n*weight
      const pct = attended / (conducted + n * comp.weight) * 100;
      if (pct < threshPct) return Math.max(0, n - 1);
    }
    return 50;
  });

  // Now generate all combos from 0..max for each component
  const combos = [];
  const maxTotal = 8; // cap total misses shown to keep it manageable

  function enumerate(idx, current, totalMissed, weightedMiss) {
    if (idx === components.length) {
      if (totalMissed === 0) return;
      // Projected pct: we are missing weightedMiss credit-hours from future conducted
      const projPct = attended / (conducted + weightedMiss) * 100;
      if (projPct >= threshPct) {
        combos.push({
          combo: [...current],
          projectedPct: projPct,
          totalMissed
        });
      }
      return;
    }

    const comp = components[idx];
    const lim  = Math.min(maxMiss[idx], maxTotal - totalMissed);

    for (let n = 0; n <= lim; n++) {
      current.push({ type: comp.type, count: n });
      enumerate(idx + 1, current, totalMissed + n, weightedMiss + n * comp.weight);
      current.pop();
    }
  }

  enumerate(0, [], 0, 0);

  // Sort by total missed (desc), then projected pct (desc)
  combos.sort((a, b) => b.totalMissed - a.totalMissed || b.projectedPct - a.projectedPct);

  // Deduplicate similar combos, keep top 20
  return combos.slice(0, 25).filter(c => c.totalMissed > 0);
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderCourses(data) {
  coursesList.innerHTML = '';

  const safe   = data.filter(c => (c.totPct || 0) >= threshold).length;
  const unsafe = data.filter(c => (c.totPct || 0) < threshold).length;
  const total  = data.length;

  // Summary strip
  const strip = document.createElement('div');
  strip.className = 'summary-strip';
  strip.innerHTML = `
    <div class="strip-chip">
      <div class="val ok">${safe}</div>
      <div class="lbl">SAFE</div>
    </div>
    <div class="strip-chip">
      <div class="val danger">${unsafe}</div>
      <div class="lbl">AT RISK</div>
    </div>
    <div class="strip-chip">
      <div class="val">${total}</div>
      <div class="lbl">COURSES</div>
    </div>
  `;
  coursesList.appendChild(strip);

  data.forEach(course => {
    const stats = calcStats(course, threshold);
    const card  = buildCourseCard(course, stats);
    coursesList.appendChild(card);
  });

  // Rescan
  const rescan = document.createElement('button');
  rescan.className = 'rescan-btn';
  rescan.textContent = '↻ Re-scan page';
  coursesList.appendChild(rescan);

  const pct = data.filter(c => c.totPct >= threshold).length / data.length * 100;
  setStatus('ok', `${data.length} courses loaded · ${safe} safe, ${unsafe} at risk`);
  show('courses');
}

function buildCourseCard(course, stats) {
  const pct = course.totPct || 0;
  const pctClass = pct >= threshold ? 'ok' : pct >= threshold - 10 ? 'warn' : 'danger';

  // Parse code / name
  const nameParts = course.name.match(/^(\w+)\s*-\s*(.+)$/);
  const code = nameParts ? nameParts[1] : '';
  const name = nameParts ? nameParts[2] : course.name;

  const card = document.createElement('div');
  card.className = 'course-card';

  // Header
  const header = document.createElement('div');
  header.className = 'card-header';
  header.innerHTML = `
    <div class="course-name">
      <span class="course-code">${code}</span>
      ${name}
    </div>
    <div class="pct-badge ${pctClass}">${pct.toFixed(1)}%</div>
    <div class="expand-icon">▼</div>
  `;

  // Body
  const body = document.createElement('div');
  body.className = 'card-body';

  if (!stats) {
    body.innerHTML = '<p style="color:var(--muted);font-size:11px;padding-top:10px;">No data available for this course yet.</p>';
  } else {
    // Component grid
    const compTypes = ['LEC', 'TUT', 'PRA'];
    const creditMap = { LEC: course.credits.lec, TUT: course.credits.tut, PRA: course.credits.pra };
    const rawAtt    = { LEC: course.attendance.lec, TUT: course.attendance.tut, PRA: course.attendance.pra };

    let gridHTML = '<div class="comp-grid">';
    compTypes.forEach(type => {
      const att = rawAtt[type];
      const cr  = creditMap[type];
      const active = att && att.conducted > 0;
      const compStat = stats.components.find(c => c.type === type);

      if (active && compStat) {
        const compPct = att.conducted > 0 ? (att.attended / att.conducted * 100).toFixed(0) : '-';
        gridHTML += `
          <div class="comp-cell">
            <div class="comp-label">${type}</div>
            <div class="comp-value">${att.attended}/${att.conducted}</div>
            <div class="comp-credit">${compPct}% · ${cr}cr</div>
          </div>`;
      } else {
        gridHTML += `<div class="comp-cell inactive"><div class="comp-label">${type}</div><div class="comp-value">—</div></div>`;
      }
    });
    gridHTML += '</div>';

    // Verdict
    let verdictHTML = '';
    if (stats.status === 'safe') {
      const totalMissable = stats.canMiss.length > 0
        ? Math.max(...stats.canMiss.map(c => c.totalMissed))
        : 0;

      if (totalMissable === 0) {
        verdictHTML = `
          <div class="verdict borderline">
            <div class="verdict-title">⚠ On the Edge</div>
            <div class="verdict-main">You're at ${pct.toFixed(1)}% — just above ${threshold}%. Don't miss any more classes.</div>
          </div>`;
      } else {
        verdictHTML = `
          <div class="verdict safe">
            <div class="verdict-title">✓ Safe to Miss</div>
            <div class="verdict-main">You can miss up to <strong>${totalMissable}</strong> more class(es) and stay above ${threshold}%.</div>
          </div>`;

        // Combo list
        if (stats.canMiss.length > 0) {
          verdictHTML += `<div class="combo-label">Missable combinations</div><div class="combos-scroll">`;
          stats.canMiss.forEach(c => {
            const tags = c.combo
              .filter(x => x.count > 0)
              .map(x => `<span class="tag">${x.count} ${x.type}</span>`)
              .join('');
            const pctAfter = c.projectedPct.toFixed(1);
            verdictHTML += `<div class="combo-row">${tags}<span class="combo-pct">→ ${pctAfter}%</span></div>`;
          });
          verdictHTML += `</div>`;
        }
      }
    } else {
      // Unsafe
      const needed = stats.needed;
      let mainMsg = `You're at ${pct.toFixed(1)}% — below ${threshold}%.`;
      if (needed.overall) {
        mainMsg += ` Attend the next <strong>${needed.overall.classes}</strong> class(es) consecutively to recover.`;
      }

      verdictHTML = `
        <div class="verdict unsafe">
          <div class="verdict-title">✗ Below Threshold</div>
          <div class="verdict-main">${mainMsg}</div>
        </div>`;

      // Per component breakdown
      if (needed.perComponent.length > 0) {
        verdictHTML += `<div class="combo-label">Classes needed to recover (per type)</div><div class="combos-scroll">`;
        needed.perComponent.forEach(pc => {
          if (pc.count > 0) {
            const projStr = pc.projectedPct ? ` → ${pc.projectedPct.toFixed(1)}%` : '';
            verdictHTML += `
              <div class="combo-row">
                <span class="tag">${pc.count} ${pc.type}</span>
                <span class="combo-pct">${projStr}</span>
              </div>`;
          }
        });
        verdictHTML += `</div>`;
      }
    }

    body.innerHTML = gridHTML + verdictHTML;
  }

  // Toggle expand
  header.addEventListener('click', () => {
    const isOpen = body.classList.toggle('open');
    header.classList.toggle('open', isOpen);
  });

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function show(view) {
  idleView.classList.add('hidden');
  loadingView.classList.add('hidden');
  errorView.classList.add('hidden');
  coursesView.classList.add('hidden');

  if (view === 'idle')    idleView.classList.remove('hidden');
  if (view === 'loading') loadingView.classList.remove('hidden');
  if (view === 'error')   errorView.classList.remove('hidden');
  if (view === 'courses') coursesView.classList.remove('hidden');
}

function setStatus(type, text) {
  statusDot.className = 'status-dot';
  if (type === 'ok')       statusDot.classList.add('ok');
  if (type === 'err')      statusDot.classList.add('err');
  if (type === 'warn')     statusDot.classList.add('warn');
  if (type === 'scanning') statusDot.classList.add('ok');
  statusText.textContent = text;
}

// ── Auto-scan if already on the page ────────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (tab?.url?.includes('markattendance.webapps.snu.edu.in')) {
    setStatus('ok', 'SNU attendance page detected');
    // Auto scan after a brief moment
    setTimeout(scanPage, 300);
  }
});
