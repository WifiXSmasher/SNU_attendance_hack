// content.js - Scrapes attendance data from the SNU attendance summary page

function scrapeAttendanceData() {
  const rows = document.querySelectorAll('#rpt tbody tr');
  const courses = [];

  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 15) return;

    const courseName = cells[0]?.innerText?.trim();
    if (!courseName || courseName.toLowerCase().includes('details not found')) return;

    // Credits
    const lecCredit = parseInt(cells[1]?.innerText?.trim()) || 0;
    const tutCredit = parseInt(cells[2]?.innerText?.trim()) || 0;
    const praCredit = parseInt(cells[3]?.innerText?.trim()) || 0;

    // Attendance (raw): "attended / conducted"
    const parseFrac = (txt) => {
      const t = txt?.trim();
      if (!t || t === '-') return null;
      const parts = t.split('/');
      if (parts.length !== 2) return null;
      return { attended: parseFloat(parts[0].trim()), conducted: parseFloat(parts[1].trim()) };
    };

    const lecAtt = parseFrac(cells[7]?.innerText);
    const tutAtt = parseFrac(cells[8]?.innerText);
    const praAtt = parseFrac(cells[9]?.innerText);

    // Condonement
    const condonement = parseFloat(cells[10]?.innerText?.trim()) || 0;

    // Attendance with credit hours
    const lecCH = parseFrac(cells[11]?.innerText);
    const tutCH = parseFrac(cells[12]?.innerText);
    const praCH = parseFrac(cells[13]?.innerText);

    // Total %
    const totPctTxt = cells[14]?.innerText?.trim().replace('%', '');
    const totPct = parseFloat(totPctTxt) || 0;

    courses.push({
      name: courseName,
      credits: { lec: lecCredit, tut: tutCredit, pra: praCredit },
      attendance: {
        lec: lecAtt,
        tut: tutAtt,
        pra: praAtt
      },
      creditHours: {
        lec: lecCH,
        tut: tutCH,
        pra: praCH
      },
      condonement,
      totPct
    });
  });

  return courses;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrapeAttendance') {
    try {
      const data = scrapeAttendanceData();
      sendResponse({ success: true, data });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  }
  return true;
});
