const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const GRADE_OPTIONS = ['11', '12'];

let me = null;
let sections = [];
let offenses = [];
let cases = [];
let service = [];
let years = [];
let users = [];
let pending = [];
let view = 'dashboard';
let violationFilters = { added_from: '', added_to: '', grade_level: '', section_id: '', strand: '', track: '', violation_type: '', service_status: '', search: '' };
let dashboardRecent = { items: [], total: 0 };
let calendarState = { month: new Date().toISOString().slice(0, 7), days: [], selectedDate: '', selectedItems: [] };
let signupOptionsCache = null;
let studentSearchResults = [];
let studentSearchQuery = '';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[c]));

async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
}
const get = (url) => api(url);
const post = (url, data) => api(url, { method: 'POST', body: JSON.stringify(data) });
const put = (url, data) => api(url, { method: 'PUT', body: JSON.stringify(data) });
const patch = (url, data) => api(url, { method: 'PATCH', body: JSON.stringify(data) });
const del = (url) => api(url, { method: 'DELETE' });

function toast(message) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}
function initials(n) { return String(n || '').split(' ').map(x => x[0] || '').join('').slice(0, 2).toUpperCase() || '--'; }
function fmtDate(d) {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  const dt = new Date(s + 'T00:00:00');
  return Number.isNaN(dt.getTime()) ? s : dt.toLocaleDateString();
}
function badge(s) {
  const cls = /complete|resolved|verified/i.test(s || '') ? 'complete'
    : /pending|assigned|reported|in_progress|under review|accepted|escalated/i.test(s || '') ? 'pending'
    : /reject|suspend|serious/i.test(s || '') ? 'danger'
    : 'review';
  return `<span class="badge ${cls}">${esc(s || '—')}</span>`;
}
function hoursNum(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }
function trackStrandText(x) {
  const track = (x?.track || x?.track_name || '').toString().trim();
  const strand = (x?.strand || x?.strand_name || '').toString().trim();
  return [track, strand].filter(Boolean).join(' · ');
}
function sectionLabel(s) {
  if (!s) return '';
  const ts = trackStrandText(s);
  return `G${s.grade_level} · ${s.section_name}${ts ? ' · ' + ts : ''}`;
}
function lrnOf(x) { return x?.lrn || x?.student_number || x?.student_lrn || '—'; }

function navItems() {
  return me && me.role === 'admin'
    ? [
        ['dashboard','Dashboard'],
        ['violations','Violation Records'],
        ['community','Community Service'],
        ['sections','Sections & School Years'],
        ['accounts','Accounts'],
        ['offenses','Offense Catalog'],
        ['reports','Reports']
      ]
    : [
        ['dashboard','Dashboard'],
        ['violations','Violation Records'],
        ['community','Community Service']
      ];
}

function showApp() {
  $('#landing')?.classList.add('hidden');
  $('#authModal')?.classList.add('hidden');
  $('#app')?.classList.remove('hidden');
  if ($('#userName')) $('#userName').textContent = me?.full_name || 'User';
  if ($('#userRole')) {
    const labels = { admin: 'Administrator', teacher: 'Teacher', guidance_counselor: 'Guidance Counselor', class_adviser: 'Class Adviser' };
    $('#userRole').textContent = labels[me?.role] || me?.role || 'User';
  }
  if ($('#userAvatar')) $('#userAvatar').textContent = initials(me?.full_name || '');
  renderNav();
}
function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  nav.innerHTML = navItems().map(item => {
    const v = item[0];
    const label = item[item.length - 1];
    return `<button class="nav-btn ${view === v ? 'active' : ''}" data-view="${v}">${esc(label)}</button>`;
  }).join('');
}
function showGate() { $('#landing')?.classList.remove('hidden'); $('#app')?.classList.add('hidden'); }
function closeAuthModal() { $('#authModal')?.classList.add('hidden'); $('#authModal')?.setAttribute('aria-hidden', 'true'); }

function opt(list, value, label) { return (list || []).map(x => `<option value="${x[value]}">${esc(x[label])}</option>`).join(''); }
function sectionOptions(selected = '') {
  return sections.map(s => `<option value="${s.id}" data-grade="${esc(s.grade_level)}" data-track="${esc(s.track||s.track_name||'')}" data-strand="${esc(s.strand||s.strand_name||'')}" ${String(selected)===String(s.id)?'selected':''}>${esc(sectionLabel(s))}${s.school_year ? ' · ' + esc(s.school_year) : ''}</option>`).join('');
}
function distinctTracks() { return [...new Set(sections.map(s => (s.track || s.track_name || '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b)); }
function distinctStrands() { return [...new Set(sections.map(s => (s.strand || s.strand_name || '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b)); }

function filterParams() {
  const qs = new URLSearchParams();
  Object.entries(violationFilters).forEach(([k, v]) => { if (v !== '' && v != null) qs.set(k, v); });
  return qs;
}
function activeFilterEntries() {
  const labels = { added_from: 'Added from', added_to: 'Added to', grade_level: 'Grade', section_id: 'Section', strand: 'Strand/Group', track: 'Track', violation_type: 'Violation type', service_status: 'Service status', search: 'Search' };
  return Object.entries(violationFilters).filter(([, v]) => v !== '' && v != null).map(([k, v]) => {
    let display = v;
    if (k === 'section_id') { const s = sections.find(x => String(x.id) === String(v)); display = s ? sectionLabel(s) : v; }
    if (k === 'violation_type') { const o = offenses.find(x => String(x.id) === String(v)); display = o ? o.name : v; }
    return { key: k, label: labels[k] || k, value: String(display) };
  });
}
function renderFilterForm(prefix, opts = {}) {
  const f = violationFilters;
  const sectionChoices = sections.map(s => `<option value="${s.id}" ${String(f.section_id)===String(s.id)?'selected':''}>${esc(sectionLabel(s))}</option>`).join('');
  const offenseChoices = offenses.map(o => `<option value="${o.id}" ${String(f.violation_type)===String(o.id)?'selected':''}>${esc(o.name)}</option>`).join('');
  const trackChoices = distinctTracks().map(t => `<option value="${esc(t)}" ${String(f.track||'')===String(t)?'selected':''}>${esc(t)}</option>`).join('');
  const strandChoices = distinctStrands().map(s => `<option value="${esc(s)}" ${String(f.strand||'')===String(s)?'selected':''}>${esc(s)}</option>`).join('');
  const chips = activeFilterEntries().map(x => `<span class="badge review">${esc(x.label)}: ${esc(x.value)}</span>`).join(' ');
  return `
    <form class="filter-panel" id="${prefix}FilterForm">
      <div class="filter-grid">
        <label>Added from<input id="${prefix}From" type="date" value="${esc(f.added_from || '')}"></label>
        <label>Added to<input id="${prefix}To" type="date" value="${esc(f.added_to || '')}"></label>
        <label>Grade level<select id="${prefix}Grade"><option value="">All grades</option>${GRADE_OPTIONS.map(g => `<option value="${g}" ${String(f.grade_level)===g?'selected':''}>Grade ${g}</option>`).join('')}</select></label>
        <label>Section<select id="${prefix}Section"><option value="">All sections</option>${sectionChoices}</select></label>
        <label>Track<select id="${prefix}Track"><option value="">All tracks</option>${trackChoices}</select></label>
        <label>Strand/Group<select id="${prefix}Strand"><option value="">All strands/groups</option>${strandChoices}</select></label>
        <label>Violation type<select id="${prefix}Type"><option value="">All types</option>${offenseChoices}</select></label>
        <label>Service status<select id="${prefix}Service"><option value="">All statuses</option>${['none','pending','in_progress','completed'].map(s => `<option value="${s}" ${String(f.service_status)===s?'selected':''}>${s}</option>`).join('')}</select></label>
        <label>Search (LRN/case/name)<input id="${prefix}Search" value="${esc(f.search || '')}" placeholder="LRN, student name, case, section"></label>
      </div>
      <div class="filter-actions">
        <button class="primary smallbtn" type="submit">Apply filters</button>
        <button class="ghost smallbtn" type="button" id="${prefix}Clear">Clear filters</button>
        ${opts.extraButtons || ''}
      </div>
      <div class="tiny muted">Date filters are inclusive. Grade 11-12 only. Teachers and section staff are limited to their assigned section(s).</div>
      ${chips ? `<div class="filter-chips">${chips}</div>` : ''}
    </form>
  `;
}
function readFilterForm(prefix) {
  violationFilters = {
    added_from: ($(`#${prefix}From`)?.value || '').trim(),
    added_to: ($(`#${prefix}To`)?.value || '').trim(),
    grade_level: ($(`#${prefix}Grade`)?.value || '').trim(),
    section_id: ($(`#${prefix}Section`)?.value || '').trim(),
    track: ($(`#${prefix}Track`)?.value || '').trim(),
    strand: ($(`#${prefix}Strand`)?.value || '').trim(),
    violation_type: ($(`#${prefix}Type`)?.value || '').trim(),
    service_status: ($(`#${prefix}Service`)?.value || '').trim(),
    search: ($(`#${prefix}Search`)?.value || '').trim()
  };
}
function wireFilterForm(prefix, rerenderFn) {
  $(`#${prefix}FilterForm`) && ($(`#${prefix}FilterForm`).onsubmit = async (e) => {
    e.preventDefault();
    readFilterForm(prefix);
    try { await loadRecentViolations(); if (view === 'community') await loadCalendar(); rerenderFn(); } catch (err) { toast(err.message); }
  });
  $(`#${prefix}Clear`) && ($(`#${prefix}Clear`).onclick = async () => {
    violationFilters = { added_from: '', added_to: '', grade_level: '', section_id: '', strand: '', track: '', violation_type: '', service_status: '', search: '' };
    try { await loadRecentViolations(); if (view === 'community') await loadCalendar(); rerenderFn(); } catch (err) { toast(err.message); }
  });
}

async function loadRecentViolations() {
  const res = await api('/api/dashboard/recent-violations?' + filterParams().toString());
  cases = res.items || [];
  dashboardRecent = { items: res.items || [], total: res.total || 0, page: res.page || 1, limit: res.limit || 0 };
}
async function loadCalendar() {
  try {
    const qs = new URLSearchParams({ month: calendarState.month });
    ['grade_level','section_id','strand','track','service_status'].forEach(k => { if (violationFilters[k]) qs.set(k, violationFilters[k]); });
    const r = await api('/api/community-service/calendar?' + qs.toString());
    calendarState.days = r.days || [];
  } catch { calendarState.days = []; }
  if (calendarState.selectedDate) await loadCalendarDay(calendarState.selectedDate); else calendarState.selectedItems = [];
}
async function loadCalendarDay(date) {
  calendarState.selectedDate = date;
  try {
    const qs = new URLSearchParams();
    ['grade_level','section_id','strand','track'].forEach(k => { if (violationFilters[k]) qs.set(k, violationFilters[k]); });
    const r = await api('/api/community-service/calendar/' + encodeURIComponent(date) + (qs.toString() ? ('?' + qs.toString()) : ''));
    calendarState.selectedItems = r.items || [];
  } catch { calendarState.selectedItems = []; }
}

async function loadData() {
  years = await get('/api/years');
  sections = await get('/api/sections');
  offenses = await get('/api/offenses');
  try { await loadRecentViolations(); } catch { cases = await get('/api/violations'); dashboardRecent = { items: cases, total: cases.length }; }
  try { service = await get('/api/community-service'); } catch { service = []; }
  if (me.role === 'admin') {
    try { users = await get('/api/users'); } catch { users = []; }
    try { pending = await get('/api/admin/pending'); } catch { pending = []; }
  } else { users = []; pending = []; }
}

async function loadStudentSearch(query) {
  studentSearchQuery = String(query || '').trim();
  if (!studentSearchQuery) { studentSearchResults = []; return; }
  const qs = new URLSearchParams({ q: studentSearchQuery, limit: '25' });
  studentSearchResults = await get('/api/students?' + qs.toString());
}

async function go(v) {
  view = v;
  renderNav();
  try {
    if (v === 'community') await loadCalendar();
    render();
  } catch (e) {
    toast(e.message);
    view = 'dashboard'; renderNav(); renderDashboard();
  }
}

function render() {
  try {
    switch (view) {
      case 'dashboard': renderDashboard(); break;
      case 'violations': renderCases(); break;
      case 'community': renderCommunity(); break;
      case 'sections': renderSections(); break;
      case 'accounts': renderAccounts(); break;
      case 'offenses': renderOffenses(); break;
      case 'reports': renderReports(); break;
      default: renderDashboard();
    }
  } catch (e) {
    console.error(e);
    $('#content').innerHTML = `<div class="card"><h2>Unable to load view</h2><p class="muted">${esc(e.message || 'Unexpected error')}</p></div>`;
  }
}

function pageHead(title, extra = '') {
  return `<div class="page-head"><h2 class="section-title" style="margin:0">${esc(title)}</h2><div class="actions">${extra}</div></div>`;
}
function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="muted">No data available.</td></tr>`}</tbody></table></div>`;
}

function renderStudentSearchCard() {
  const scopedNote = me.role === 'teacher'
    ? 'Teachers can search LRN records only for students in their assigned section(s).'
    : (me.role === 'admin' ? 'Admin can search student LRN records across Grade 11-12 sections.' : 'Search is limited to your assigned section scope.');
  const rows = (studentSearchResults || []).map(s => `<tr>
    <td><strong>${esc(lrnOf(s))}</strong></td>
    <td>${esc((s.first_name || '') + ' ' + (s.last_name || ''))}</td>
    <td>G${esc(s.grade_level || '')} · ${esc(s.section_name || '')}</td>
    <td>${esc(trackStrandText(s) || '—')}</td>
  </tr>`).join('');
  const body = !studentSearchQuery
    ? '<p class="muted" style="margin:0">Enter an LRN or name to search student records.</p>'
    : (rows ? table(['LRN', 'Student name', 'Grade / Section', 'Track / Strand'], rows) : '<p class="muted" style="margin:0">No matching LRN found in your allowed scope.</p>');
  return `<div class="card search-card accent-card colorful-card">
    <div class="search-card-head"><div>
      <h3 style="margin:0">Student LRN search</h3>
      <p class="tiny muted" style="margin:4px 0 0">${esc(scopedNote)}</p>
    </div></div>
    <form id="dashboardLrnSearchForm" class="lrn-search-form">
      <label style="margin:0;flex:1">Search student LRN<input id="dashboardLrnSearchInput" value="${esc(studentSearchQuery)}" placeholder="Enter LRN or student name"></label>
      <div class="actions" style="align-self:flex-end"><button class="primary" type="submit">Search LRN</button><button class="ghost" type="button" id="dashboardLrnSearchClear">Clear</button></div>
    </form>
    <div style="height:10px"></div>${body}
  </div>`;
}

function renderDashboard() {
  const isAdmin = me.role === 'admin';
  const activeYears = years.filter(y => y.is_active).length;
  const openCases = (dashboardRecent.items || cases).filter(c => !/resolved|closed/i.test(c.status || '')).length;
  const svcOpen = service.filter(x => !/complete/i.test(x.status || '')).length;
  let html = `<div class="page-head"><div>
      <p class="eyebrow">SAN JOSE LITEX SENIOR HIGH SCHOOL</p>
      <h2 class="section-title" style="margin:0;font-size:30px;color:var(--navy)">Welcome, ${esc(me.full_name)}</h2>
      <p class="muted" style="margin-top:4px">${isAdmin ? 'Grade 11-12 dashboard with LRN search, automatic case numbers, and admin-defined track/strand sections.' : 'Grade 11-12 dashboard for your assigned section records and LRN lookup.'}</p>
    </div></div>`;

  html += `<div class="cards">${[
    ['Grade 11-12 sections', sections.length, 'Configured sections'],
    ['School years', years.length, `${activeYears} active / ${Math.max(0, years.length - activeYears)} inactive`],
    ['Recent cases', dashboardRecent.total || cases.length, `${openCases} open in current view`],
    ['Active service items', svcOpen, 'Community service tracking']
  ].map(([label, value, sub], i) => `<div class="card kpi accent-kpi color-kpi-${i % 4}"><div class="label">${label}</div><strong>${value}</strong><div class="sub">${sub}</div></div>`).join('')}</div>`;

  html += `<div style="height:12px"></div>${renderStudentSearchCard()}`;
  html += `<div style="height:12px"></div><div class="card accent-card colorful-card"><div class="page-head" style="margin-bottom:8px"><h3 style="margin:0">Violation filters</h3></div>${renderFilterForm('dbf')}</div>`;

  html += `<h2 class="section-title">Quick actions</h2><div class="actions" style="margin-bottom:18px">`;
  html += `<button class="ghost smallbtn" data-view="violations" type="button">Open violation records</button>`;
  html += `<button class="ghost smallbtn" data-view="community" type="button">Open service calendar</button>`;
  if (isAdmin) {
    html += `<button class="primary smallbtn" data-modal="recordCase" type="button">+ Record violation</button>`;
    html += `<button class="primary smallbtn" data-modal="section" type="button">+ Add track & strand / section</button>`;
    html += `<button class="ghost smallbtn" data-view="accounts" type="button">Manage accounts</button>`;
  }
  html += `</div>`;

  const rows = (dashboardRecent.items || cases).slice(0, 10).map(c => `<tr>
    <td><strong>${esc(c.case_number || '—')}</strong><div class="tiny muted">auto-assigned</div></td>
    <td>${esc((c.first_name||'')+' '+(c.last_name||''))}<div class="tiny muted">LRN: ${esc(lrnOf(c))}</div></td>
    <td>G${esc(c.grade_level||'')} · ${esc(c.section_name||'')}<div class="tiny muted">${esc(trackStrandText(c) || '—')}</div></td>
    <td>${esc(c.offense||'')}</td>
    <td>${badge(c.severity||'')}</td>
    <td>${fmtDate(c.incident_date)}</td>
    <td>${badge(c.status||'')}<div class="tiny muted">service: ${esc(c.service_status||'none')}</div></td>
  </tr>`).join('');
  html += `<h2 class="section-title">Recent violation records</h2>${table(['Case no.','Student','Grade / Section / Track-Strand','Offense','Severity','Date','Status'], rows)}`;
  if (isAdmin) html += `<h2 class="section-title">Administrator approvals</h2><div class="card accent-card"><p>${pending.length} pending staff account request(s).</p><div class="actions" style="margin-top:8px"><button class="primary smallbtn" data-view="accounts" type="button">Review accounts</button></div></div>`;
  $('#content').innerHTML = html;
  wireFilterForm('dbf', renderDashboard);
  $('#dashboardLrnSearchForm') && ($('#dashboardLrnSearchForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await loadStudentSearch($('#dashboardLrnSearchInput')?.value || ''); renderDashboard(); } catch (err) { toast(err.message); }
  });
  $('#dashboardLrnSearchClear') && ($('#dashboardLrnSearchClear').onclick = async () => { studentSearchQuery = ''; studentSearchResults = []; renderDashboard(); });
}

function renderCases() {
  const rows = cases.map(c => {
    const actions = me.role === 'admin'
      ? `<div class="actions"><button class="ghost smallbtn" data-details="${c.id}" type="button">Details</button><select data-status-case="${c.id}" style="max-width:160px">${['Reported','Under Review','Verified','Accepted','In Progress','Resolved','Closed','Rejected','Escalated'].map(s => `<option ${c.status===s?'selected':''}>${s}</option>`).join('')}</select></div>`
      : `<button class="ghost smallbtn" data-details="${c.id}" type="button">Details</button>`;
    return `<tr>
      <td><strong>${esc(c.case_number || '—')}</strong></td>
      <td>${esc((c.first_name || '') + ' ' + (c.last_name || ''))}<div class="tiny muted">LRN: ${esc(lrnOf(c))}</div></td>
      <td>G${esc(c.grade_level || '')} · ${esc(c.section_name || '')}<div class="tiny muted">${esc(trackStrandText(c) || '—')}</div></td>
      <td>${esc(c.offense || '')}${c.community_service_type ? `<div class="tiny muted">Service: ${esc(c.community_service_type)}</div>` : ''}</td>
      <td>${badge(c.severity || '')}</td>
      <td>${fmtDate(c.incident_date)}</td>
      <td>${badge(c.status || '')}<div class="tiny muted">${esc(c.service_status || 'none')} · req ${hoursNum(c.required_service_hours).toFixed(2)}h / done ${hoursNum(c.completed_service_hours).toFixed(2)}h</div></td>
      <td>${actions}</td>
    </tr>`;
  }).join('');

  $('#content').innerHTML =
    pageHead('Violation records', `<div class="actions"><button class="ghost" id="exportViolationsXlsx" type="button">Export Violations XLSX</button><button class="ghost" id="exportServiceXlsx" type="button">Export Service XLSX</button>${me.role === 'admin' ? '<button class="primary" data-modal="recordCase" type="button">+ Record violation</button>' : ''}</div>`) +
    renderFilterForm('vf') +
    `<div style="height:12px"></div><div class="note colorful-note">Record violations with student details in one form (Grade 11-12). Student info is saved/linked automatically by LRN. <strong>Case numbers are assigned automatically.</strong> No separate student module is required.</div><div style="height:12px"></div>` +
    table(['Case no. (auto)','Student','Grade / Section / Track-Strand','Offense / Service type','Severity','Date','Status / Service hours', me.role === 'admin' ? 'Actions' : 'Details'], rows);
  wireFilterForm('vf', renderCases);
  $('#exportViolationsXlsx') && ($('#exportViolationsXlsx').onclick = () => { window.location.href = '/api/exports/violations.xlsx?' + filterParams().toString(); });
  $('#exportServiceXlsx') && ($('#exportServiceXlsx').onclick = () => { window.location.href = '/api/exports/community-service.xlsx?' + filterParams().toString(); });
}

function renderSections() {
  const yearRows = years.map(y => {
    const statusCtl = me.role === 'admin'
      ? `<select class="year-status-select" data-year-status="${y.id}" data-year-label="${esc(y.label)}"><option value="active" ${y.is_active ? 'selected' : ''}>Active</option><option value="inactive" ${!y.is_active ? 'selected' : ''}>Inactive</option></select>`
      : badge(y.is_active ? 'Active' : 'Inactive');
    const action = me.role === 'admin' ? `<div class="actions"><button class="ghost smallbtn" data-edit-year="${y.id}" type="button">Edit</button></div>` : '—';
    return `<tr><td>${esc(y.label)}</td><td>${statusCtl}</td><td>${y.archived_at ? fmtDate(y.archived_at) : 'No'}</td><td>${action}</td></tr>`;
  }).join('');
  const secRows = sections.map(s => `<tr>
    <td>G${esc(s.grade_level)}</td>
    <td>${esc(s.section_name)}</td>
    <td>${esc(s.track || s.track_name || '—')}</td>
    <td>${esc(s.strand || s.strand_name || '—')}</td>
    <td>${esc(s.school_year || s.school_year_label || '')}</td>
    <td class="actions">${me.role === 'admin' ? `<button class="ghost smallbtn" data-edit-section="${s.id}" type="button">Edit</button><button class="ghost smallbtn" data-delete-section="${s.id}" type="button">Delete</button>` : '—'}</td>
  </tr>`).join('');

  $('#content').innerHTML =
    pageHead('Sections & school years', me.role === 'admin' ? '<div class="actions"><button class="primary" data-modal="year" type="button">+ Add school year</button><button class="primary" data-modal="section" type="button">+ Add track & strand / section</button></div>' : '') +
    `<div style="height:15px"></div><div class="two-col"><div>${pageHead('School years', '')}${table(['School year','Status','Archived','Action'], yearRows)}<p class="tiny muted">Admins can set each school year as active or inactive using the status dropdown.</p></div><div>${pageHead('Grade 11-12 sections', '')}${table(['Grade','Section','Track','Strand/Group','School year','Actions'], secRows)}</div></div>` +
    `<div style="height:12px"></div><div class="card colorful-card"><h3 style="margin-top:0">Admin-defined track & strand</h3><p class="tiny muted">Only Grade 11 and Grade 12 are supported. Use one action to add a section by selecting the grade level and entering the track and strand/group together. Student LRN/details are captured when recording violations.</p></div>`;

  $$('[data-year-status]').forEach(sel => {
    sel.onchange = async () => {
      const id = Number(sel.dataset.yearStatus);
      const label = sel.dataset.yearLabel || 'school year';
      const status = sel.value;
      const prev = sel.dataset.prev || (sel.querySelector('option[selected]')?.value || 'inactive');
      try {
        await put('/api/years/' + id, { label, is_active: status });
        sel.dataset.prev = status;
        toast(`School year set to ${status}.`);
        await loadData();
        renderSections();
      } catch (err) { toast(err.message); sel.value = prev; await loadData(); renderSections(); }
    };
    sel.dataset.prev = sel.value;
  });
}


function renderCommunity() {
  const now = new Date(calendarState.month + '-01T00:00:00');
  const monthLabel = Number.isNaN(now.getTime()) ? calendarState.month : now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = (calendarState.days || []).map(d => {
    const cls = ['calendar-day', d.count ? 'has-service' : '', calendarState.selectedDate === d.date ? 'selected' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-cal-date="${esc(d.date)}" aria-label="View services on ${esc(d.date)}"><span class="day">${esc(d.label)}</span><span class="count">${d.count ? (d.count + ' item' + (d.count === 1 ? '' : 's')) : '—'}</span></button>`;
  }).join('');
  const selectedRows = (calendarState.selectedItems || []).map(s => `<tr>
    <td>${esc(s.case_number || '—')}</td>
    <td>${esc((s.first_name || '') + ' ' + (s.last_name || ''))}<div class="tiny muted">LRN: ${esc(lrnOf(s))}</div></td>
    <td>G${esc(s.grade_level || '')} · ${esc(s.section_name || '')}<div class="tiny muted">${esc(trackStrandText(s) || '—')}</div></td>
    <td>${esc(s.offense || '')}<div class="tiny muted">${esc(s.service_type || '')}</div></td>
    <td>${fmtDate(s.due_date)}</td>
    <td>${badge(s.status || '')}</td>
  </tr>`).join('');

  $('#content').innerHTML = `
    ${pageHead('Community service tracker', `<div class="actions"><button class="ghost" id="calPrev" type="button">< Prev</button><strong>${esc(monthLabel)}</strong><button class="ghost" id="calNext" type="button">Next ></button></div>`)}
    ${renderFilterForm('calf')}
    <div style="height:12px"></div>
    <div class="calendar-layout">
      <div class="calendar-wrap calendar-wide card colorful-card">
        <div class="calendar-head"><strong>Service calendar</strong><span class="muted tiny">Click a day to view scheduled/due service items. Wider view for easier monitoring.</span></div>
        <div class="calendar-weekdays">${weekdayLabels.map(d => `<div>${d}</div>`).join('')}</div>
        <div class="calendar-grid">${days}</div>
      </div>
      <div class="card colorful-card calendar-details">
        <h3 style="margin-top:0">Day details</h3>
        <p class="muted tiny">${calendarState.selectedDate ? `Items for ${esc(fmtDate(calendarState.selectedDate))}` : 'Select a calendar day to see items.'}</p>
        ${table(['Case','Student','Grade/Section/Track-Strand','Offense / Service','Due date','Status'], selectedRows || `<tr><td colspan="6" class="muted">${calendarState.selectedDate ? 'No service items for this day.' : 'No day selected.'}</td></tr>`)}
      </div>
    </div>
    <div style="height:12px"></div>
    <div class="card">
      <div class="page-head" style="margin-bottom:8px"><h3 style="margin:0">Service records</h3></div>
      ${table(['Case','Student (LRN)','Service type','Required hrs','Completed hrs','Remaining hrs','Due date','Status','Action'], service.map(s => {
        const rem = Math.max(0, hoursNum(s.required_service_hours) - hoursNum(s.completed_service_hours));
        return `<tr>
          <td>${esc(s.case_number || '—')}</td>
          <td>${esc((s.first_name || '') + ' ' + (s.last_name || ''))}<div class="tiny muted">LRN: ${esc(lrnOf(s))}</div></td>
          <td>${esc(s.service_type || '—')}</td>
          <td>${hoursNum(s.required_service_hours).toFixed(2)}</td>
          <td>${hoursNum(s.completed_service_hours).toFixed(2)}</td>
          <td>${rem.toFixed(2)}</td>
          <td>${fmtDate(s.due_date)}</td>
          <td>${badge(s.status || '')}</td>
          <td>${me.role === 'admin' ? `<div class="actions"><button class="ghost smallbtn" data-svc-status="${s.id}" data-status="in_progress">Mark in progress</button><button class="ghost smallbtn" data-svc-status="${s.id}" data-status="completed">Complete</button></div>` : '—'}</td>
        </tr>`;
      }).join(''))}
    </div>`;

  wireFilterForm('calf', () => { renderCommunity(); });
  $('#calPrev') && ($('#calPrev').onclick = async () => { const d = new Date(calendarState.month + '-01T00:00:00'); d.setMonth(d.getMonth() - 1); calendarState.month = d.toISOString().slice(0,7); calendarState.selectedDate=''; await loadCalendar(); renderCommunity(); });
  $('#calNext') && ($('#calNext').onclick = async () => { const d = new Date(calendarState.month + '-01T00:00:00'); d.setMonth(d.getMonth() + 1); calendarState.month = d.toISOString().slice(0,7); calendarState.selectedDate=''; await loadCalendar(); renderCommunity(); });
  $$('[data-cal-date]').forEach(btn => btn.onclick = async () => { await loadCalendarDay(btn.dataset.calDate); renderCommunity(); });
  $$('[data-svc-status]').forEach(btn => btn.onclick = async () => {
    try { await patch('/api/community-service/' + btn.dataset.svcStatus, { status: btn.dataset.status }); toast('Service updated.'); await loadData(); await loadCalendar(); renderCommunity(); } catch (e) { toast(e.message); }
  });
}

function renderAccounts() {
  if (me.role !== 'admin') { $('#content').innerHTML = `<div class="card">Not authorized.</div>`; return; }
  const pendingRows = pending.map(p => `<tr>
    <td>${esc(p.full_name)}</td><td>${esc(p.email)}</td><td>${esc(p.role)}</td><td>${esc(sectionLabel({grade_level:p.grade_level,section_name:p.section_name,track:p.track,strand:p.strand}))}</td><td>${fmtDate(p.created_at)}</td>
    <td class="actions"><button class="primary smallbtn" data-approve="${p.id}">Approve</button><button class="ghost smallbtn" data-reject="${p.id}">Reject</button></td>
  </tr>`).join('');
  const userRows = users.map(u => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${badge(u.verified ? 'verified' : 'pending')}</td><td>${badge(u.status || 'active')}</td><td>${fmtDate(u.created_at)}</td></tr>`).join('');
  $('#content').innerHTML =
    pageHead('Accounts & approvals', '') +
    `<div class="card colorful-card"><h3 style="margin-top:0">Pending staff requests</h3>${table(['Name','Email','Role','Assigned section','Requested','Actions'], pendingRows || `<tr><td colspan="6" class="muted">No pending requests.</td></tr>`)}</div>` +
    `<div style="height:12px"></div><div class="card"><h3 style="margin-top:0">User accounts</h3>${table(['Name','Email','Role','Verified','Status','Created'], userRows)}</div>`;
  $$('[data-approve]').forEach(b => b.onclick = async () => { try { await post('/api/admin/pending/' + b.dataset.approve + '/approve', {}); toast('Approved.'); await loadData(); renderAccounts(); } catch (e) { toast(e.message); } });
  $$('[data-reject]').forEach(b => b.onclick = async () => { try { await post('/api/admin/pending/' + b.dataset.reject + '/reject', {}); toast('Rejected.'); await loadData(); renderAccounts(); } catch (e) { toast(e.message); } });
}

function renderOffenses() {
  const isAdmin = me.role === 'admin';
  const rows = offenses.map(o => {
    const active = (o.active ?? o.is_active ?? 1) ? true : false;
    const actions = isAdmin
      ? `<div class="actions"><button class="ghost smallbtn" data-edit-offense="${o.id}" type="button">Edit</button><button class="ghost smallbtn" data-toggle-offense="${o.id}" data-active="${active ? 0 : 1}" type="button">${active ? 'Deactivate' : 'Activate'}</button></div>`
      : '-';
    return `<tr>
      <td><strong>${esc(o.name)}</strong><div class="tiny muted">${esc(o.description || 'No description')}</div></td>
      <td>${badge(o.severity || '-')}</td>
      <td>${badge(active ? 'active' : 'inactive')}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
  $('#content').innerHTML =
    pageHead('Offense catalog', isAdmin ? '<button class="primary" data-modal="offense" type="button">+ Add offense</button>' : '') +
    `<div class="card colorful-card"><p class="tiny muted" style="margin-top:0">Manage violation offenses used when recording cases. Admins can add, edit, activate, or deactivate offenses.</p>` +
    `${table(['Offense', 'Severity', 'Status', isAdmin ? 'Actions' : 'Info'], rows || `<tr><td colspan="${isAdmin ? 4 : 3}" class="muted">No offenses found.</td></tr>`)} </div>`;
}

function renderReports() {
  const byGrade = GRADE_OPTIONS.map(g => ({ grade: g, count: cases.filter(c => String(c.grade_level) === g).length }));
  const byStatus = ['Reported','Under Review','Resolved','Closed'].map(s => ({ status: s, count: cases.filter(c => (c.status||'') === s).length }));
  const topOffenses = Object.entries(cases.reduce((m,c)=>{ const k=c.offense||'Unknown'; m[k]=(m[k]||0)+1; return m; }, {})).sort((a,b)=>b[1]-a[1]).slice(0,8);
  $('#content').innerHTML = pageHead('Reports', `<div class="actions"><button class="ghost" id="exportViolationsXlsx2">Export Violations XLSX</button><button class="ghost" id="exportServiceXlsx2">Export Service XLSX</button></div>`) +
    `<div class="cards">${byGrade.map(g => `<div class="card kpi accent-kpi"><div class="label">Grade ${g.grade} cases</div><strong>${g.count}</strong><div class="sub">Current filtered view</div></div>`).join('')}${byStatus.slice(0,2).map(s => `<div class="card kpi accent-kpi"><div class="label">${esc(s.status)}</div><strong>${s.count}</strong><div class="sub">Current filtered view</div></div>`).join('')}</div>` +
    `<div style="height:12px"></div><div class="two-col"><div class="card"><h3 style="margin-top:0">Top offenses</h3>${table(['Offense','Count'], topOffenses.map(([n,c]) => `<tr><td>${esc(n)}</td><td>${c}</td></tr>`).join(''))}</div><div class="card"><h3 style="margin-top:0">Service summary</h3>${table(['Metric','Value'], `<tr><td>Total service records</td><td>${service.length}</td></tr><tr><td>Completed</td><td>${service.filter(s=>/complete/i.test(s.status||'')).length}</td></tr><tr><td>In progress/pending</td><td>${service.filter(s=>!/complete/i.test(s.status||'')).length}</td></tr>`)}</div></div>`;
  $('#exportViolationsXlsx2') && ($('#exportViolationsXlsx2').onclick = () => { window.location.href = '/api/exports/violations.xlsx?' + filterParams().toString(); });
  $('#exportServiceXlsx2') && ($('#exportServiceXlsx2').onclick = () => { window.location.href = '/api/exports/community-service.xlsx?' + filterParams().toString(); });
}

function modal(content) {
  $('#modalWrap').innerHTML = `<div class="modal-backdrop"><div class="modal">${content}</div></div>`;
  $$('.modal-close,.modal-cancel').forEach(b => b.onclick = closeModal);
  $('#modalWrap .modal-backdrop')?.addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });
}
function closeModal() { $('#modalWrap').innerHTML = ''; }

async function loadSignupOptions() {
  if (signupOptionsCache) return signupOptionsCache;
  try { signupOptionsCache = await get('/api/public/signup-options'); } catch { signupOptionsCache = { sections: [], school_years: [], tracks: [], strands: [] }; }
  return signupOptionsCache;
}

function openModal(kind, id) {
  if (kind === 'recordCase') {
    const today = new Date().toISOString().slice(0,10);
    modal(`<div class="modal-head"><h3>Record violation</h3><button class="iconbtn modal-close" type="button">×</button></div>
      <form id="recordCaseForm">
        <div class="note colorful-note" style="margin-bottom:10px"><strong>Case number is assigned automatically</strong> when you save. Enter student details and violation information in one form (Grade 11-12).</div>
        <div class="modal-grid">
          <label>LRN<input name="lrn" required placeholder="Student LRN"></label>
          <label>First name<input name="first_name" required></label>
          <label>Last name<input name="last_name" required></label>
          <label>Grade level<select name="grade_level" id="caseGrade" required>${GRADE_OPTIONS.map(g=>`<option value="${g}">Grade ${g}</option>`).join('')}</select></label>
          <label style="grid-column:1/-1">Section (Grade 11-12, assigned track/strand)<select name="section_id" id="caseSection" required><option value="">Select section</option>${sectionOptions('')}</select></label>
          <label>Track<input name="track" id="caseTrack" placeholder="Auto-filled from section (editable)"></label>
          <label>Strand/Group<input name="strand" id="caseStrand" placeholder="Auto-filled from section (editable)"></label>
          <label style="grid-column:1/-1">Offense<select name="offense_id" required>${opt(offenses.filter(o => (o.active ?? o.is_active ?? 1)), 'id', 'name')}</select></label>
          <label>Incident date<input name="incident_date" type="date" value="${today}" required></label>
          <label>Time of incident<input name="time_of_incident" type="time"></label>
          <label style="grid-column:1/-1">Location<input name="location"></label>
          <label style="grid-column:1/-1">Description<textarea name="description" required></textarea></label>
        </div>
        <div class="actions" style="margin-top:12px;justify-content:flex-end"><button class="ghost modal-cancel" type="button">Cancel</button><button class="primary" type="submit">Save violation (auto case no.)</button></div>
      </form>`);
    const syncSection = () => {
      const sel = $('#caseSection'); const optn = sel?.selectedOptions?.[0];
      if (!optn) return;
      if (optn.dataset.grade) $('#caseGrade').value = optn.dataset.grade;
      if ($('#caseTrack')) $('#caseTrack').value = optn.dataset.track || '';
      if ($('#caseStrand')) $('#caseStrand').value = optn.dataset.strand || '';
    };
    $('#caseSection') && ($('#caseSection').onchange = syncSection); syncSection();
    $('#recordCaseForm').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target); const data = Object.fromEntries(fd.entries());
      data.section_id = Number(data.section_id); data.offense_id = Number(data.offense_id);
      try { const res = await post('/api/violations', data); toast(`Violation saved. Case ${res.case_number || 'assigned'} created.`); closeModal(); await loadData(); render(); } catch (err) { toast(err.message); }
    };
    return;
  }

  if (kind === 'section') {
    const s = id ? sections.find(x => x.id == id) : null;
    const yearOptions = years.map(y => `<option value="${y.id}" ${String(s?.school_year_id||'')===String(y.id)?'selected':''}>${esc(y.label)} (${y.is_active?'active':'inactive'})</option>`).join('');
    modal(`<div class="modal-head"><h3>${s ? 'Edit section / track & strand' : 'Add track & strand / section'}</h3><button class="iconbtn modal-close" type="button">×</button></div>
      <form id="sectionForm">
        <div class="note colorful-note" style="margin-bottom:10px">One action: select Grade 11 or 12 and enter the track and strand/group together with the section and school year.</div>
        <div class="modal-grid">
          <label>Grade level<select name="grade_level" required>${GRADE_OPTIONS.map(g=>`<option value="${g}" ${String(s?.grade_level||'11')===g?'selected':''}>Grade ${g}</option>`).join('')}</select></label>
          <label>Section name<input name="section_name" required value="${esc(s?.section_name || '')}" placeholder="e.g. Rizal"></label>
          <label>Track<input name="track" required value="${esc(s?.track || s?.track_name || '')}" placeholder="e.g. Academic / TVL / Sports"></label>
          <label>Strand / Group<input name="strand" required value="${esc(s?.strand || s?.strand_name || '')}" placeholder="e.g. STEM / ICT / HUMSS"></label>
          <label style="grid-column:1/-1">School year<select name="school_year_id" required><option value="">Select school year</option>${yearOptions}</select></label>
        </div>
        <div class="actions" style="margin-top:12px;justify-content:flex-end"><button class="ghost modal-cancel" type="button">Cancel</button><button class="primary" type="submit">${s ? 'Save changes' : 'Save section (track & strand)'}</button></div>
      </form>`);
    $('#sectionForm').onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.school_year_id = Number(data.school_year_id);
      try {
        if (s) await put('/api/sections/' + s.id, data); else await post('/api/sections', data);
        toast(s ? 'Section updated.' : 'Section with track & strand added.'); closeModal(); await loadData(); render();
      } catch (err) { toast(err.message); }
    };
    return;
  }

  if (kind === 'year') {
    const y = id ? years.find(x => x.id == id) : null;
    modal(`<div class="modal-head"><h3>${y ? 'Edit school year' : 'Add school year'}</h3><button class="iconbtn modal-close" type="button">×</button></div>
      <form id="yearForm">
        <div class="modal-grid">
          <label style="grid-column:1/-1">School year label<input name="label" required value="${esc(y?.label || '')}" placeholder="e.g. 2025-2026"></label>
          <label>Status<select name="is_active"><option value="active" ${y?.is_active ? 'selected' : ''}>Active</option><option value="inactive" ${!y || !y.is_active ? 'selected' : ''}>Inactive</option></select></label>
        </div>
        <div class="actions" style="margin-top:12px;justify-content:flex-end"><button class="ghost modal-cancel" type="button">Cancel</button><button class="primary" type="submit">Save school year</button></div>
      </form>`);
    $('#yearForm').onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.is_active = data.is_active;
      try { if (y) await put('/api/years/' + y.id, data); else await post('/api/years', data); toast('School year saved.'); closeModal(); await loadData(); render(); } catch (err) { toast(err.message); }
    };
    return;
  }

  if (kind === 'offense') {
    const o = id ? offenses.find(x => String(x.id) === String(id)) : null;
    modal(`<div class="modal-head"><h3>${o ? 'Edit offense' : 'Add offense'}</h3><button class="iconbtn modal-close" type="button">×</button></div>
      <form id="offenseForm">
        <div class="modal-grid">
          <label style="grid-column:1/-1">Offense name<input name="name" required value="${esc(o?.name || '')}" placeholder="e.g. Tardiness"></label>
          <label>Severity<select name="severity" required>${['Minor','Major','Serious'].map(v => `<option value="${v}" ${String(o?.severity||'Minor')===v?'selected':''}>${v}</option>`).join('')}</select></label>
          <label>Status<select name="active"><option value="1" ${(o?.active ?? o?.is_active ?? 1) ? 'selected' : ''}>Active</option><option value="0" ${!(o?.active ?? o?.is_active ?? 1) ? 'selected' : ''}>Inactive</option></select></label>
          <label style="grid-column:1/-1">Description<textarea name="description" placeholder="Optional description">${esc(o?.description || '')}</textarea></label>
        </div>
        <div class="actions" style="margin-top:12px;justify-content:flex-end"><button class="ghost modal-cancel" type="button">Cancel</button><button class="primary" type="submit">${o ? 'Save changes' : 'Add offense'}</button></div>
      </form>`);
    $('#offenseForm').onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      data.active = Number(data.active);
      try {
        if (o) await put('/api/offenses/' + o.id, data); else await post('/api/offenses', data);
        toast(o ? 'Offense updated.' : 'Offense added.');
        closeModal();
        offenses = await get('/api/offenses');
        render();
      } catch (err) { toast(err.message); }
    };
    return;
  }

  if (kind === 'caseDetails') {
    const c = cases.find(x => String(x.id) === String(id));
    if (!c) return;
    modal(`<div class="modal-head"><h3>Violation details</h3><button class="iconbtn modal-close" type="button">×</button></div>
      <div class="detail-grid">
        <div><div class="tiny muted">Case number (auto)</div><strong>${esc(c.case_number || '—')}</strong></div>
        <div><div class="tiny muted">Status</div>${badge(c.status || '')}</div>
        <div><div class="tiny muted">Student</div><strong>${esc((c.first_name||'')+' '+(c.last_name||''))}</strong></div>
        <div><div class="tiny muted">LRN</div><strong>${esc(lrnOf(c))}</strong></div>
        <div><div class="tiny muted">Grade / Section</div>${esc(`G${c.grade_level || ''} · ${c.section_name || ''}`)}</div>
        <div><div class="tiny muted">Track / Strand</div>${esc(trackStrandText(c) || '—')}</div>
        <div><div class="tiny muted">Offense</div>${esc(c.offense || '')}</div>
        <div><div class="tiny muted">Severity</div>${badge(c.severity || '')}</div>
        <div><div class="tiny muted">Incident date</div>${fmtDate(c.incident_date)}</div>
        <div><div class="tiny muted">Service</div>${esc(c.service_status || 'none')} (${hoursNum(c.completed_service_hours).toFixed(2)}/${hoursNum(c.required_service_hours).toFixed(2)} hrs)</div>
      </div>
      <div style="margin-top:10px"><div class="tiny muted">Description</div><div class="card" style="margin-top:4px">${esc(c.description || '—')}</div></div>
      <div class="actions" style="margin-top:12px;justify-content:flex-end"><button class="ghost modal-cancel" type="button">Close</button></div>`);
    return;
  }
}

async function doAuthAction() {
  try { await loadData(); showApp(); await go('dashboard'); } catch (e) { toast(e.message); }
}

function wireGlobal() {
  $('#logoutBtn') && ($('#logoutBtn').onclick = async () => { try { await post('/api/auth/logout', {}); } catch {} me = null; showGate(); });
  document.addEventListener('click', async (e) => {
    const nav = e.target.closest('[data-view]'); if (nav) { go(nav.dataset.view); return; }
    const modalBtn = e.target.closest('[data-modal]'); if (modalBtn) { openModal(modalBtn.dataset.modal); return; }
    const editSec = e.target.closest('[data-edit-section]'); if (editSec) { openModal('section', Number(editSec.dataset.editSection)); return; }
    const delSec = e.target.closest('[data-delete-section]'); if (delSec) {
      if (!confirm('Delete this section?')) return;
      try { await del('/api/sections/' + delSec.dataset.deleteSection); toast('Section deleted.'); await loadData(); render(); } catch (err) { toast(err.message); }
      return;
    }
    const editYear = e.target.closest('[data-edit-year]'); if (editYear) { openModal('year', Number(editYear.dataset.editYear)); return; }
    const editOffense = e.target.closest('[data-edit-offense]'); if (editOffense) { openModal('offense', Number(editOffense.dataset.editOffense)); return; }
    const toggleOffense = e.target.closest('[data-toggle-offense]'); if (toggleOffense) {
      try {
        const id = Number(toggleOffense.dataset.toggleOffense);
        const active = Number(toggleOffense.dataset.active);
        const o = offenses.find(x => Number(x.id) === id);
        if (!o) return;
        await put('/api/offenses/' + id, { name: o.name, severity: o.severity, description: o.description || '', active });
        toast(active ? 'Offense activated.' : 'Offense deactivated.');
        offenses = await get('/api/offenses');
        render();
      } catch (err) { toast(err.message); }
      return;
    }
    const details = e.target.closest('[data-details]'); if (details) { openModal('caseDetails', details.dataset.details); return; }
  });
  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-status-case]');
    if (sel) {
      try { await patch('/api/violations/' + sel.dataset.statusCase, { status: sel.value }); toast('Status updated.'); await loadData(); render(); } catch (err) { toast(err.message); await loadData(); render(); }
    }
  });

  $('#loginForm') && ($('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { const r = await post('/api/auth/login', { email: fd.get('email'), password: fd.get('password') }); me = r.user; toast('Signed in.'); await doAuthAction(); }
    catch (err) { toast(err.message); }
  });
  $('#staffRequestForm') && ($('#staffRequestForm').onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try { await post('/api/auth/register', { full_name: data.full_name, email: data.email, password: data.password, role: data.role, grade_level: data.grade_level, section_id: data.section_id ? Number(data.section_id) : null, school_year_id: data.school_year_id ? Number(data.school_year_id) : null }); toast('Staff account request submitted for admin approval.'); e.target.reset(); }
    catch (err) { toast(err.message); }
  });
  $$('.open-auth').forEach(b => b.onclick = () => { $('#authModal')?.classList.remove('hidden'); $('#authModal')?.setAttribute('aria-hidden','false'); });
  $('#authModalClose') && ($('#authModalClose').onclick = closeAuthModal);
  $('#authModal')?.addEventListener('click', (e) => { if (e.target.id === 'authModal') closeAuthModal(); });
}

async function boot() {
  wireGlobal();
  try {
    await loadSignupOptions();
    const setup = await get('/api/auth/setup-status').catch(() => ({ configured: false }));
    if (setup?.admin?.email && $('#loginEmailHint')) $('#loginEmailHint').textContent = `Ready admin account: ${setup.admin.email}`;
  } catch {}
  try {
    const sess = await get('/api/auth/me');
    if (sess?.user) { me = sess.user; await loadData(); showApp(); await go('dashboard'); return; }
  } catch {}
  showGate();
}

boot();


