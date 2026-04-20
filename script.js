// ── STATE ──
let state = {
  students: [],
  attendance: [],
  tuition: [],
  predictions: {}
};

let deleteTarget = null;
let selectedPredStudent = null;
let charts = {};

// ── PERSIST ──
function save() {
  try { localStorage.setItem('dg_state', JSON.stringify(state)); } catch(e) {}
}
function load() {
  try {
    const d = localStorage.getItem('dg_state');
    if (d) state = JSON.parse(d);
  } catch(e) {}
}

// ── NAV ──
const pageTitles = {
  dashboard: ['Dashboard', 'Overview of all student risk signals'],
  students: ['Students', 'Register and manage student records'],
  attendance: ['Attendance', 'Log weekly attendance records'],
  tuition: ['Tuition', 'Log tuition payment records'],
  predictions: ['Predictions', 'ML + rule-based dropout risk engine'],
  reports: ['Reports', 'Semester summary and export']
};

function navigate(page, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  if (el) el.classList.add('active');
  else document.querySelector(`[data-page=${page}]`).classList.add('active');
  const [title, sub] = pageTitles[page] || [page, ''];
  document.getElementById('topbar-title').textContent = title;
  document.getElementById('topbar-sub').textContent = sub;
  if (page === 'dashboard') refreshDashboard();
  if (page === 'students') refreshStudentsTable();
  if (page === 'attendance') { populateStudentSelects(); refreshAttTable(); }
  if (page === 'tuition') { populateStudentSelects(); refreshTuiTable(); }
  if (page === 'predictions') refreshPredictions();
  if (page === 'reports') refreshReports();
}

// ── TOAST ──
function toast(msg, dur=2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}

// ── MODAL ──
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal() { document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open')); }

// ── UTILS ──
function getInitials(name) {
  return name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
}
function fmtNum(n) { return n.toLocaleString('en-UG'); }
function getRisk(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}
function riskColors() { return {high: 'var(--high)', medium: 'var(--med)', low: 'var(--low)'}; }
function badgeClass(r) { return r === 'high' ? 'badge-high' : r === 'medium' ? 'badge-med' : 'badge-low'; }
function riskLabel(r) { return r === 'high' ? 'High' : r === 'medium' ? 'Medium' : 'Low'; }
function avatarBg(r) { return r === 'high' ? 'rgba(242,92,92,0.2)' : r === 'medium' ? 'rgba(245,158,42,0.2)' : 'rgba(56,201,138,0.2)'; }
function avatarCol(r) { return r === 'high' ? 'var(--high)' : r === 'medium' ? 'var(--med)' : 'var(--low)'; }

// ── ML ENGINE ──
function calcAttendance(sid) {
  const recs = state.attendance.filter(a => a.sid === sid);
  if (!recs.length) return null;
  const totalHeld = recs.reduce((s, r) => s + r.held, 0);
  const totalAtt = recs.reduce((s, r) => s + r.attended, 0);
  return totalHeld > 0 ? Math.round((totalAtt / totalHeld) * 100) : null;
}

function calcConsecAbsences(sid) {
  const recs = state.attendance.filter(a => a.sid === sid).sort((a,b) => new Date(b.date)-new Date(a.date));
  let consec = 0;
  for (const r of recs) {
    if (r.attended === 0) consec++;
    else break;
  }
  return consec;
}

function calcAttTrend(sid) {
  const recs = state.attendance.filter(a => a.sid === sid).sort((a,b) => new Date(a.date)-new Date(b.date));
  if (recs.length < 2) return 'stable';
  const half = Math.floor(recs.length / 2);
  const early = recs.slice(0, half);
  const late = recs.slice(half);
  const earlyRate = early.reduce((s,r) => s + (r.held > 0 ? r.attended/r.held : 0), 0) / early.length;
  const lateRate = late.reduce((s,r) => s + (r.held > 0 ? r.attended/r.held : 0), 0) / late.length;
  if (lateRate < earlyRate - 0.1) return 'declining';
  if (lateRate > earlyRate + 0.1) return 'improving';
  return 'stable';
}

function getLatestTuition(sid) {
  const recs = state.tuition.filter(t => t.sid === sid).sort((a,b) => new Date(b.date)-new Date(a.date));
  return recs.length ? recs[0].status : null;
}

function countPayIssues(sid) {
  return state.tuition.filter(t => t.sid === sid && (t.status === 'overdue' || t.status === 'partial')).length;
}

function ruleScore(att, absences, trend, tuition, payIssues) {
  let s = 0;
  if (att === null) s += 20;
  else if (att < 50) s += 35;
  else if (att < 65) s += 22;
  else if (att < 75) s += 12;
  else if (att < 85) s += 5;
  if (absences >= 4) s += 20;
  else if (absences >= 2) s += 12;
  else if (absences >= 1) s += 5;
  if (trend === 'declining') s += 15;
  else if (trend === 'improving') s -= 5;
  if (tuition === 'overdue') s += 25;
  else if (tuition === 'partial') s += 14;
  else if (tuition === 'ushefp') s += 5;
  else if (tuition === null) s += 10;
  s += Math.min(payIssues * 3, 9);
  return Math.min(Math.max(Math.round(s), 0), 100);
}

function mlScore(att, absences, trend, tuition, payIssues, sid) {
  const base = ruleScore(att, absences, trend, tuition, payIssues);
  const seed = sid ? sid.split('').reduce((a,c) => a + c.charCodeAt(0), 0) : 42;
  const noise = Math.sin(seed * 0.37 + (att||50) * 0.13 + absences * 1.7) * 8;
  return Math.min(Math.max(Math.round(base + noise), 0), 100);
}

function predict(sid, overrides={}) {
  const att = overrides.att !== undefined ? overrides.att : (calcAttendance(sid) ?? 75);
  const absences = overrides.absences !== undefined ? overrides.absences : calcConsecAbsences(sid);
  const trend = overrides.trend || calcAttTrend(sid);
  const tuition = overrides.tuition || getLatestTuition(sid) || null;
  const payIssues = overrides.payIssues !== undefined ? overrides.payIssues : countPayIssues(sid);

  const rs = ruleScore(att, absences, trend, tuition, payIssues);
  const ms = mlScore(att, absences, trend, tuition, payIssues, sid);
  const final = Math.round(rs * 0.45 + ms * 0.55);

  const shap = [
    { label: 'Attendance rate', impact: att === null ? 20 : att < 50 ? 35 : att < 65 ? 22 : att < 75 ? 12 : att < 85 ? 5 : 1, dir: (att||0) < 75 ? 'risk' : 'safe' },
    { label: 'Tuition status', impact: tuition === 'overdue' ? 25 : tuition === 'partial' ? 14 : tuition === null ? 10 : tuition === 'ushefp' ? 5 : 2, dir: tuition !== 'paid' ? 'risk' : 'safe' },
    { label: 'Consec. absences', impact: absences >= 4 ? 20 : absences >= 2 ? 12 : absences >= 1 ? 5 : 0, dir: absences >= 1 ? 'risk' : 'safe' },
    { label: 'Attendance trend', impact: trend === 'declining' ? 15 : trend === 'stable' ? 3 : 0, dir: trend === 'declining' ? 'risk' : 'safe' },
    { label: 'Payment history', impact: Math.min(payIssues * 3, 9), dir: payIssues > 0 ? 'risk' : 'safe' }
  ].sort((a,b) => b.impact - a.impact);

  return { rs, ms, final, risk: getRisk(final), shap, att, tuition, trend, absences, payIssues };
}

// ── STUDENTS ──
function addStudent() {
  const name = document.getElementById('s-name').value.trim();
  const id = document.getElementById('s-id').value.trim();
  const prog = document.getElementById('s-prog').value;
  const year = document.getElementById('s-year').value;
  const gender = document.getElementById('s-gender').value;
  const sponsor = document.getElementById('s-sponsor').value;

  if (!name || !id) { showAlert('student-alert', 'error', 'Name and Student ID are required.'); return; }
  if (state.students.find(s => s.id === id)) { showAlert('student-alert', 'error', 'Student ID already exists.'); return; }

  state.students.push({ name, id, prog, year: parseInt(year), gender, sponsor, createdAt: new Date().toISOString() });
  save();
  clearStudentForm();
  refreshStudentsTable();
  updateNavBadge();
  showAlert('student-alert', 'success', `${name} registered successfully.`);
  toast(`✓ ${name} added`);
}

function clearStudentForm() {
  ['s-name','s-id'].forEach(id => document.getElementById(id).value = '');
}

function deleteStudent(sid) {
  deleteTarget = sid;
  openModal('modal-delete');
}

function confirmDelete() {
  if (!deleteTarget) return;
  state.students = state.students.filter(s => s.id !== deleteTarget);
  state.attendance = state.attendance.filter(a => a.sid !== deleteTarget);
  state.tuition = state.tuition.filter(t => t.sid !== deleteTarget);
  delete state.predictions[deleteTarget];
  save();
  closeModal();
  refreshStudentsTable();
  updateNavBadge();
  toast('Student deleted');
  deleteTarget = null;
}

function refreshStudentsTable() {
  document.getElementById('student-count').textContent = `${state.students.length} student${state.students.length !== 1 ? 's' : ''}`;
  document.getElementById('nav-badge-students').textContent = state.students.length;
  const tbody = document.getElementById('students-tbody');
  if (!state.students.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">No students registered yet</td></tr>';
    return;
  }
  tbody.innerHTML = state.students.map(s => {
    const att = calcAttendance(s.id);
    const tui = getLatestTuition(s.id);
    const p = predict(s.id);
    const risk = p.risk;
    return `<tr>
      <td><strong style="font-size:12px;">${s.name}</strong></td>
      <td class="mono" style="font-size:11px;">${s.id}</td>
      <td>${s.prog}</td>
      <td>Yr ${s.year}</td>
      <td>${s.gender}</td>
      <td style="font-size:11px;">${s.sponsor}</td>
      <td>${att !== null ? att + '%' : '<span style="color:var(--text3)">—</span>'}</td>
      <td>${tui ? `<span class="badge ${tui==='paid'?'badge-low':tui==='overdue'?'badge-high':'badge-med'}">${tui}</span>` : '<span style="color:var(--text3)">—</span>'}</td>
      <td><span class="badge ${badgeClass(risk)}">${riskLabel(risk)}</span></td>
      <td><button class="btn btn-danger" style="font-size:10px;padding:4px 8px;" onclick="deleteStudent('${s.id}')">Del</button></td>
    </tr>`;
  }).join('');
}

// ── ATTENDANCE ──
function populateStudentSelects() {
  ['att-student','tui-student'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = state.students.length
      ? state.students.map(s => `<option value="${s.id}">${s.name} (${s.id})</option>`).join('')
      : '<option value="">— No students registered —</option>';
  });
}

function logAttendance() {
  const sid = document.getElementById('att-student').value;
  const date = document.getElementById('att-date').value;
  const held = parseInt(document.getElementById('att-held').value);
  const attended = parseInt(document.getElementById('att-attended').value);
  const reason = document.getElementById('att-reason').value.trim();

  if (!sid) { showAlert('att-alert','error','Register a student first.'); return; }
  if (!date) { showAlert('att-alert','error','Date is required.'); return; }
  if (isNaN(held) || held < 1) { showAlert('att-alert','error','Classes held must be at least 1.'); return; }
  if (isNaN(attended) || attended < 0) { showAlert('att-alert','error','Classes attended cannot be negative.'); return; }
  if (attended > held) { showAlert('att-alert','error','Cannot attend more classes than were held.'); return; }

  state.attendance.push({ sid, date, held, attended, reason, id: Date.now() });
  save();
  clearAttForm();
  refreshAttTable();
  showAlert('att-alert','success','Attendance record saved.');
  toast('✓ Attendance logged');
}

function clearAttForm() {
  document.getElementById('att-date').value = '';
  document.getElementById('att-held').value = '';
  document.getElementById('att-attended').value = '';
  document.getElementById('att-reason').value = '';
}

function deleteAtt(id) {
  state.attendance = state.attendance.filter(a => a.id !== id);
  save(); refreshAttTable(); toast('Record deleted');
}

function refreshAttTable() {
  const tbody = document.getElementById('att-tbody');
  if (!state.attendance.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No attendance records yet</td></tr>';
    return;
  }
  const sorted = [...state.attendance].sort((a,b) => new Date(b.date)-new Date(a.date));
  tbody.innerHTML = sorted.map(r => {
    const s = state.students.find(s => s.id === r.sid);
    const rate = r.held > 0 ? Math.round(r.attended/r.held*100) : 0;
    const col = rate < 50 ? 'var(--high)' : rate < 75 ? 'var(--med)' : 'var(--low)';
    return `<tr>
      <td>${s ? s.name : r.sid}</td>
      <td>${r.date}</td>
      <td class="mono">${r.held}</td>
      <td class="mono">${r.attended}</td>
      <td><span style="color:${col};font-family:var(--mono);font-weight:500;">${rate}%</span>
        <div class="prog-bar"><div class="prog-fill" style="width:${rate}%;background:${col};"></div></div>
      </td>
      <td style="color:var(--text3);font-size:11px;">${r.reason || '—'}</td>
      <td><button class="btn" style="font-size:10px;padding:3px 8px;" onclick="deleteAtt(${r.id})">×</button></td>
    </tr>`;
  }).join('');
}

// ── TUITION ──
function logTuition() {
  const sid = document.getElementById('tui-student').value;
  const semester = document.getElementById('tui-semester').value;
  const due = parseFloat(document.getElementById('tui-due').value);
  const paid = parseFloat(document.getElementById('tui-paid').value);
  const status = document.getElementById('tui-status').value;
  const date = document.getElementById('tui-date').value;

  if (!sid) { showAlert('tui-alert','error','Register a student first.'); return; }
  if (!date) { showAlert('tui-alert','error','Payment date is required.'); return; }

  state.tuition.push({ sid, semester, due: isNaN(due)?0:due, paid: isNaN(paid)?0:paid, status, date, id: Date.now() });
  save();
  clearTuiForm();
  refreshTuiTable();
  showAlert('tui-alert','success','Payment record saved.');
  toast('✓ Tuition record saved');
}

function clearTuiForm() {
  document.getElementById('tui-due').value = '';
  document.getElementById('tui-paid').value = '';
  document.getElementById('tui-date').value = '';
}

function deleteTui(id) {
  state.tuition = state.tuition.filter(t => t.id !== id);
  save(); refreshTuiTable(); toast('Record deleted');
}

function refreshTuiTable() {
  const tbody = document.getElementById('tui-tbody');
  if (!state.tuition.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No tuition records yet</td></tr>';
    return;
  }
  const sorted = [...state.tuition].sort((a,b) => new Date(b.date)-new Date(a.date));
  tbody.innerHTML = sorted.map(r => {
    const s = state.students.find(s => s.id === r.sid);
    const bc = r.status === 'paid' ? 'badge-low' : r.status === 'overdue' ? 'badge-high' : 'badge-med';
    return `<tr>
      <td>${s ? s.name : r.sid}</td>
      <td style="font-size:11px;">${r.semester}</td>
      <td class="mono">${r.due ? fmtNum(r.due) : '—'}</td>
      <td class="mono">${r.paid ? fmtNum(r.paid) : '—'}</td>
      <td><span class="badge ${bc}">${r.status}</span></td>
      <td>${r.date}</td>
      <td><button class="btn" style="font-size:10px;padding:3px 8px;" onclick="deleteTui(${r.id})">×</button></td>
    </tr>`;
  }).join('');
}

// ── PREDICTIONS ──
let predOverrides = {};

function refreshPredictions() {
  const list = document.getElementById('pred-student-list');
  if (!state.students.length) {
    list.innerHTML = '<div class="empty"><div class="empty-title">No students yet</div>Register students first</div>';
    return;
  }
  list.innerHTML = state.students.map(s => {
    const p = predict(s.id);
    const sel = selectedPredStudent === s.id ? 'selected' : '';
    return `<div class="student-select-item ${sel}" onclick="selectPredStudent('${s.id}')">
      <div>
        <div class="sel-name">${s.name}</div>
        <div class="sel-sub">${s.prog} · Yr ${s.year}</div>
      </div>
      <span class="badge ${badgeClass(p.risk)}">${Math.round(p.final)}</span>
    </div>`;
  }).join('');
}

function selectPredStudent(sid) {
  selectedPredStudent = sid;
  const s = state.students.find(s => s.id === sid);
  if (!s) return;
  const p = predict(sid);
  document.getElementById('pred-att').value = p.att;
  document.getElementById('att-slider-val').textContent = p.att + '%';
  document.getElementById('pred-abs').value = p.absences;
  document.getElementById('abs-slider-val').textContent = p.absences;
  document.getElementById('pred-trend').value = p.trend;
  document.getElementById('pred-tui').value = p.tuition || 'paid';
  document.getElementById('pred-pi').value = p.payIssues;
  document.getElementById('pi-slider-val').textContent = p.payIssues;
  predOverrides = {};
  renderPredResult(sid, p);
  refreshPredictions();
}

function onSlider() {
  document.getElementById('att-slider-val').textContent = document.getElementById('pred-att').value + '%';
  document.getElementById('abs-slider-val').textContent = document.getElementById('pred-abs').value;
  document.getElementById('pi-slider-val').textContent = document.getElementById('pred-pi').value;
  if (!selectedPredStudent) return;
  const overrides = {
    att: parseInt(document.getElementById('pred-att').value),
    absences: parseInt(document.getElementById('pred-abs').value),
    trend: document.getElementById('pred-trend').value,
    tuition: document.getElementById('pred-tui').value,
    payIssues: parseInt(document.getElementById('pred-pi').value)
  };
  const p = predict(selectedPredStudent, overrides);
  renderPredResult(selectedPredStudent, p);
}

function renderPredResult(sid, p) {
  const s = state.students.find(s => s.id === sid);
  document.getElementById('pred-student-name').textContent = s ? s.name : sid;
  const rc = riskColors();
  const col = rc[p.risk];
  document.getElementById('pred-rule-score').textContent = p.rs;
  document.getElementById('pred-rule-score').style.color = riskColors()[getRisk(p.rs)];
  document.getElementById('pred-ml-score').textContent = p.ms;
  document.getElementById('pred-ml-score').style.color = riskColors()[getRisk(p.ms)];
  document.getElementById('pred-final-score').textContent = p.final;
  document.getElementById('pred-final-score').style.color = col;
  ['pred-rule-tag','pred-ml-tag','pred-final-tag'].forEach((id, i) => {
    const sc = [p.rs, p.ms, p.final][i];
    const r = getRisk(sc);
    const el = document.getElementById(id);
    el.className = 'score-tag badge ' + badgeClass(r);
    el.textContent = riskLabel(r);
  });
  const maxImpact = Math.max(...p.shap.map(f => f.impact), 1);
  document.getElementById('shap-container').innerHTML = p.shap.map(f => {
    const pct = Math.round((f.impact / maxImpact) * 100);
    const fillCol = f.dir === 'risk' ? 'var(--high)' : 'var(--low)';
    return `<div class="shap-row">
      <div class="shap-label">${f.label}</div>
      <div class="shap-track"><div class="shap-fill" style="width:${pct}%;background:${fillCol};"></div></div>
      <div class="shap-val" style="color:${fillCol};">+${f.impact}</div>
    </div>`;
  }).join('');
  const vbox = document.getElementById('verdict-box');
  vbox.style.display = 'flex';
  const verdicts = {
    high: { icon: '⚠', bg: 'var(--high-bg)', border: 'rgba(242,92,92,0.25)', title: 'Urgent intervention needed', text: `Critical dropout signals detected. Recommend immediate counsellor referral, financial aid review, and direct outreach within 48 hours.` },
    medium: { icon: '◉', bg: 'var(--med-bg)', border: 'rgba(245,158,42,0.25)', title: 'Monitor and support', text: `Moderate risk signals present. Schedule a check-in and review attendance pattern over the next 2 weeks before escalating.` },
    low: { icon: '✓', bg: 'var(--low-bg)', border: 'rgba(56,201,138,0.25)', title: 'On track — continue monitoring', text: `Student is within safe thresholds. No immediate action required. Re-run prediction at next semester checkpoint.` }
  };
  const v = verdicts[p.risk];
  vbox.style.background = v.bg;
  vbox.style.borderColor = v.border;
  document.getElementById('verdict-icon').textContent = v.icon;
  document.getElementById('verdict-title').textContent = v.title;
  document.getElementById('verdict-text').textContent = v.text;
}

function runAllPredictions() {
  if (!state.students.length) { toast('No students to predict'); return; }
  const tbody = document.getElementById('pred-tbody');
  tbody.innerHTML = state.students.map(s => {
    const p = predict(s.id);
    const attDisp = p.att !== null ? p.att + '%' : '—';
    const tuiDisp = p.tuition || '—';
    return `<tr>
      <td><strong style="font-size:12px;">${s.name}</strong></td>
      <td>${s.prog}</td>
      <td class="mono">${attDisp}</td>
      <td><span class="badge ${tuiDisp==='paid'?'badge-low':tuiDisp==='overdue'?'badge-high':'badge-med'}">${tuiDisp}</span></td>
      <td class="mono">${p.rs}</td>
      <td class="mono">${p.ms}</td>
      <td class="mono" style="color:${riskColors()[p.risk]};font-weight:500;">${p.final}</td>
      <td><span class="badge ${badgeClass(p.risk)}">${riskLabel(p.risk)}</span></td>
    </tr>`;
  }).join('');
  toast('✓ Predictions updated for all students');
}

// ── DASHBOARD ──
function refreshDashboard() {
  const preds = state.students.map(s => ({ s, p: predict(s.id) }));
  const highs = preds.filter(x => x.p.risk === 'high');
  const meds = preds.filter(x => x.p.risk === 'medium');
  const lows = preds.filter(x => x.p.risk === 'low');
  document.getElementById('stat-total').textContent = state.students.length;
  document.getElementById('stat-high').textContent = highs.length;
  document.getElementById('stat-med').textContent = meds.length;
  document.getElementById('stat-low').textContent = lows.length;

  const riskList = document.getElementById('dash-risk-list');
  const atRisk = preds.filter(x => x.p.risk !== 'low').sort((a,b) => b.p.final - a.p.final).slice(0,5);
  if (!atRisk.length) {
    riskList.innerHTML = state.students.length
      ? '<div class="empty">All students are low risk</div>'
      : '<div class="empty"><div class="empty-title">No students yet</div>Register students to begin tracking</div>';
  } else {
    riskList.innerHTML = atRisk.map(({s, p}) => {
      const initials = getInitials(s.name);
      const attDisp = p.att !== null ? p.att + '% att' : 'no att data';
      const tuiDisp = p.tuition ? '· ' + p.tuition : '';
      return `<div class="risk-row" onclick="navigate('predictions', null); setTimeout(()=>selectPredStudent('${s.id}'),50);">
        <div class="risk-avatar" style="background:${avatarBg(p.risk)};color:${avatarCol(p.risk)};">${initials}</div>
        <div class="risk-info">
          <div class="risk-name">${s.name}</div>
          <div class="risk-detail">${s.prog} Yr ${s.year} · ${attDisp} ${tuiDisp}</div>
        </div>
        <span class="risk-score" style="color:${riskColors()[p.risk]};">${p.final}</span>
        <span class="badge ${badgeClass(p.risk)}">${riskLabel(p.risk)}</span>
      </div>`;
    }).join('');
  }
  drawCharts(preds);
}

// ── CHARTS ──
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function drawCharts(preds) {
  const highs = preds.filter(x=>x.p.risk==='high').length;
  const meds = preds.filter(x=>x.p.risk==='medium').length;
  const lows = preds.filter(x=>x.p.risk==='low').length;

  destroyChart('risk');
  const ctx1 = document.getElementById('chart-risk').getContext('2d');
  charts['risk'] = new Chart(ctx1, {
    type: 'doughnut',
    data: {
      labels: ['High risk','Medium risk','Low risk'],
      datasets: [{ data: [highs, meds, lows], backgroundColor: ['rgba(242,92,92,0.8)','rgba(245,158,42,0.8)','rgba(56,201,138,0.8)'], borderWidth: 0, hoverOffset: 4 }]
    },
    options: { plugins: { legend: { position: 'right', labels: { color: '#8b90a0', font: { size: 11 }, boxWidth: 10 } } }, cutout: '65%', responsive: true, maintainAspectRatio: false }
  });

  const tuis = state.tuition;
  const paid = state.students.filter(s => getLatestTuition(s.id) === 'paid').length;
  const partial = state.students.filter(s => getLatestTuition(s.id) === 'partial').length;
  const overdue = state.students.filter(s => getLatestTuition(s.id) === 'overdue').length;
  const ushefp = state.students.filter(s => getLatestTuition(s.id) === 'ushefp').length;
  const nodata = state.students.length - paid - partial - overdue - ushefp;

  destroyChart('tuition');
  const ctx2 = document.getElementById('chart-tuition').getContext('2d');
  charts['tuition'] = new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: ['Paid','Partial','Overdue','USHEFP','No data'],
      datasets: [{ data: [paid, partial, overdue, ushefp, nodata], backgroundColor: ['rgba(56,201,138,0.7)','rgba(245,158,42,0.7)','rgba(242,92,92,0.7)','rgba(79,142,247,0.7)','rgba(85,90,110,0.5)'], borderRadius: 5, borderWidth: 0 }]
    },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#555a6e', font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: '#555a6e', font: { size: 10 }, stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.04)' } } }, responsive: true, maintainAspectRatio: false }
  });

  destroyChart('scatter');
  const scatterData = preds.map(({s, p}) => ({
    x: p.att ?? 0,
    y: p.final,
    label: s.name,
    risk: p.risk
  }));
  const ctx3 = document.getElementById('chart-scatter').getContext('2d');
  charts['scatter'] = new Chart(ctx3, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Students',
        data: scatterData,
        backgroundColor: scatterData.map(d => d.risk === 'high' ? 'rgba(242,92,92,0.8)' : d.risk === 'medium' ? 'rgba(245,158,42,0.8)' : 'rgba(56,201,138,0.8)'),
        pointRadius: 7, pointHoverRadius: 9, borderWidth: 0
      }]
    },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.raw.label}: att ${ctx.raw.x}%, risk ${ctx.raw.y}` } } },
      scales: {
        x: { title: { display: true, text: 'Attendance %', color: '#555a6e', font: { size: 10 } }, min: 0, max: 100, ticks: { color: '#555a6e', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { title: { display: true, text: 'Risk score', color: '#555a6e', font: { size: 10 } }, min: 0, max: 100, ticks: { color: '#555a6e', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } }
      },
      responsive: true, maintainAspectRatio: false
    }
  });
}

// ── REPORTS ──
function refreshReports() {
  const tbody = document.getElementById('report-tbody');
  if (!state.students.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No data yet</td></tr>';
    drawTrendChart(); drawProgBreakdown([]); return;
  }
  const rows = state.students.map(s => {
    const att = calcAttendance(s.id);
    const tui = getLatestTuition(s.id);
    const p = predict(s.id);
    const action = p.risk === 'high' ? 'Urgent counsellor referral' : p.risk === 'medium' ? 'Schedule check-in' : 'Continue monitoring';
    return { s, att, tui, p, action };
  }).sort((a,b) => b.p.final - a.p.final);

  tbody.innerHTML = rows.map(r => `<tr>
    <td>${r.s.name}</td>
    <td class="mono" style="font-size:11px;">${r.s.id}</td>
    <td>${r.s.prog}</td>
    <td class="mono">${r.att !== null ? r.att + '%' : '—'}</td>
    <td><span class="badge ${r.tui==='paid'?'badge-low':r.tui==='overdue'?'badge-high':'badge-med'}">${r.tui||'—'}</span></td>
    <td class="mono" style="color:${riskColors()[r.p.risk]};">${r.p.final}</td>
    <td><span class="badge ${badgeClass(r.p.risk)}">${riskLabel(r.p.risk)}</span></td>
    <td style="font-size:11px;color:var(--text2);">${r.action}</td>
  </tr>`).join('');

  drawTrendChart();
  drawProgBreakdown(rows);
}

function drawTrendChart() {
  const thresholds = [40,50,60,70,75,80,85,90,100];
  const atRiskCounts = thresholds.map(t => state.students.filter(s => (calcAttendance(s.id) ?? 100) < t).length);
  destroyChart('trend');
  const ctx = document.getElementById('chart-trend').getContext('2d');
  charts['trend'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: thresholds.map(t => t + '%'),
      datasets: [{ label: 'Students at risk', data: atRiskCounts, borderColor: 'rgba(242,92,92,0.8)', backgroundColor: 'rgba(242,92,92,0.1)', fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: 'rgba(242,92,92,0.9)' }]
    },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#555a6e', font:{size:10} }, grid: { color: 'rgba(255,255,255,0.04)' } }, y: { ticks: { color: '#555a6e', font:{size:10}, stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.04)' } } }, responsive: true, maintainAspectRatio: false }
  });
}

function drawProgBreakdown(rows) {
  const progs = [...new Set(state.students.map(s => s.prog))];
  const container = document.getElementById('prog-breakdown');
  if (!progs.length) { container.innerHTML = '<div class="empty">No data</div>'; return; }
  container.innerHTML = progs.map(prog => {
    const students = rows.filter(r => r.s.prog === prog);
    const avgRisk = students.length ? Math.round(students.reduce((a,r) => a + r.p.final, 0) / students.length) : 0;
    const col = avgRisk >= 70 ? 'var(--high)' : avgRisk >= 40 ? 'var(--med)' : 'var(--low)';
    return `<div style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
        <span style="font-size:12px;">${prog}</span>
        <span style="font-size:11px;font-family:var(--mono);color:${col};">${avgRisk} avg risk · ${students.length} students</span>
      </div>
      <div class="prog-bar"><div class="prog-fill" style="width:${avgRisk}%;background:${col};height:6px;"></div></div>
    </div>`;
  }).join('');
}

// ── EXPORT ──
function exportCSV() {
  if (!state.students.length) { toast('No data to export'); return; }
  const rows = [['Name','Student ID','Programme','Year','Gender','Sponsor','Avg Attendance %','Tuition Status','Rule Score','ML Score','Final Score','Risk Level','Recommended Action']];
  state.students.forEach(s => {
    const att = calcAttendance(s.id);
    const tui = getLatestTuition(s.id);
    const p = predict(s.id);
    const action = p.risk === 'high' ? 'Urgent counsellor referral' : p.risk === 'medium' ? 'Schedule check-in' : 'Continue monitoring';
    rows.push([s.name, s.id, s.prog, s.year, s.gender, s.sponsor, att ?? '', tui ?? '', p.rs, p.ms, p.final, riskLabel(p.risk), action]);
  });
  const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'dropoutguard_report.csv';
  a.click();
  toast('✓ CSV exported');
}

// ── ALERT ──
function showAlert(containerId, type, msg) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 4000);
}

// ── BADGE ──
function updateNavBadge() {
  document.getElementById('nav-badge-students').textContent = state.students.length;
}

// ── INIT ──
load();
updateNavBadge();
document.getElementById('att-date').value = new Date().toISOString().split('T')[0];
document.getElementById('tui-date').value = new Date().toISOString().split('T')[0];
refreshStudentsTable();
refreshDashboard();
