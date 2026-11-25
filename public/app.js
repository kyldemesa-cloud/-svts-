const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const SHS_STRANDS = ['STEM','ABM','HUMSS','GAS','TVL - ICT','TVL - HE','TVL - IA','TVL - Agri-Fishery','Sports','Arts and Design'];
const GRADE_OPTIONS = ['11','12'];

let me = null;
let activeYear = null;
let sections = [];
let offenses = [];
let cases = [];
let service = [];
let years = [];
let users = [];
let pending = [];
let view = 'dashboard';
let violationFilters = { added_from: '', added_to: '', grade_level: '', section_id: '', strand: '', violation_type: '', service_status: '', search: '' };
let dashboardRecent = { items: [], total: 0 };
let calendarState = { month: new Date().toISOString().slice(0, 7), days: [], selectedDate: '', selectedItems: [] };
let signupOptionsCache = null;

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
function sectionLabel(s) { return s ? `G${s.grade_level} · ${s.section_name}${s.strand ? ' · ' + s.strand : ''}` : ''; }

function navItems() {
  return me && me.role === 'admin'
    ? [
        ['dashboard', '▦', 'Dashboard'],
        ['violations', '⚑', 'Violation Records'],
        ['community', '🗓', 'Community Service'],
        ['sections', '🏫', 'Sections & School Years'],
        ['accounts', '🔐', 'Accounts'],
        ['offenses', '📘', 'Offense Catalog'],
        ['reports', '📊', 'Reports']
      ]
    : [
        ['dashboard', '▦', 'Dashboard'],
        ['violations', '⚑', 'Violation Records'],
        ['community', '🗓', 'Community Service']
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
  nav.innerHTML = navItems().map(([v, ico, t]) => `<button class="nav-btn ${view === v ? 'active' : ''}" data-view="${v}"><span>${ico}</span>${t}</button>`).join('');
}
function showGate() { $('#landing')?.classList.remove('hidden'); $('#app')?.classList.add('hidden'); }
function closeAuthModal() { $('#authModal')?.classList.add('hidden'); $('#authModal')?.setAttribute('aria-hidden', 'true'); }

function opt(list, value, label) { return (list || []).map(x => `<option value="${x[value]}">${esc(x[label])}</option>`).join(''); }
function strandOptions(selected = '', includeBlank = true, blankLabel = 'No strand/group') {
  const sel = (v) => String(selected || '') === String(v || '') ? 'selected' : '';
  return `${includeBlank ? `<option value="">${esc(blankLabel)}</option>` : ''}${SHS_STRANDS.map(s => `<option value="${esc(s)}" ${sel(s)}>${esc(s)}</option>`).join('')}`;
}
function sectionOptions(selected = '') {
  return sections.map(s => `<option value="${s.id}" data-grade="${esc(s.grade_level)}" data-strand="${esc(s.strand||'')}" ${String(selected)===String(s.id)?'selected':''}>${esc(sectionLabel(s))}${s.school_year ? ' · ' + esc(s.school_year) : ''}</option>`).join('');
}

function filterParams() {
  const qs = new URLSearchParams();
  Object.entries(violationFilters).forEach(([k, v]) => { if (v !== '' && v != null) qs.set(k, v); });
  return qs;
}
function activeFilterEntries() {
  const labels = { added_from: 'Added from', added_to: 'Added to', grade_level: 'Grade', section_id: 'Section', strand: 'Strand/Group', violation_type: 'Violation type', service_status: 'Service status', search: 'Search' };
  return Object.entries(violationFilters).filter(([, v]) => v !== '' && v != null).map(([k, v]) => {
    let display = v;
    if (k === 'section_id') { const s = sections.find(x => String(x.id) === String(v)); display = s ? sectionLabel(s) : v; }
    if (k === 'violation_type') { const o = offenses.find(x => String(x.id) === String(v)); display = o ? o.name : v; }
    return { key: k, label: labels[k] || k, value: String(display) };
  });
}
function filterChipsHtml() {
  const chips = activeFilterEntries();
  if (!chips.length) return '<div class="tiny muted">No active filters.</div>';
  return `<div class="filter-chips">${chips.map(c => `<span class="filter-chip">${esc(c.label)}: ${esc(c.value)}</span>`).join('')}</div>`;
}

function renderFilterForm(prefix = 'vf', options = {}) {
  const f = violationFilters;
  return `
    <div class="filter-panel card">
      <div class="filter-grid">
        <label>Added from<input id="${prefix}From" type="date" value="${esc(f.added_from || '')}"></label>
        <label>Added to<input id="${prefix}To" type="date" value="${esc(f.added_to || '')}"></label>
        <label>Grade level<select id="${prefix}Grade"><option value="">All grades</option>${GRADE_OPTIONS.map(g => `<option value="${g}" ${String(f.grade_level)===g?'selected':''}>Grade ${g}</option>`).join('')}</select></label>
        <label>Section<select id="${prefix}Section"><option value="">All sections</option>${sections.map(s => `<option value="${s.id}" ${String(f.section_id)===String(s.id)?'selected':''}>${esc(sectionLabel(s))}</option>`).join('')}</select></label>
        <label>Strand/Group<select id="${prefix}Strand"><option value="">All strands/groups</option>${SHS_STRANDS.map(s => `<option value="${esc(s)}" ${String(f.strand)===s?'selected':''}>${esc(s)}</option>`).join('')}</select></label>
        <label>Violation type<select id="${prefix}ViolationType"><option value="">All violation types</option>${offenses.map(o => `<option value="${o.id}" ${String(f.violation_type)===String(o.id)?'selected':''}>${esc(o.name)} (${esc(o.severity)})</option>`).join('')}</select></label>
        <label>Service status<select id="${prefix}Service"><option value="">All statuses</option>${['none','pending','in_progress','completed'].map(s => `<option value="${s}" ${f.service_status===s?'selected':''}>${s.replace('_',' ')}</option>`).join('')}</select></label>
        <label>Search student/case<input id="${prefix}Search" value="${esc(f.search || '')}" placeholder="Student name, student no., case, section"></label>
      </div>
      <div class="filter-actions">
        <button class="primary" id="${prefix}Apply" type="button">Apply filters</button>
        <button class="ghost" id="${prefix}Reset" type="button">Reset filters</button>
        ${options.extraButtons || ''}
      </div>
      <div><div class="tiny muted" style="margin-bottom:6px">Active filters</div>${filterChipsHtml()}</div>
      <div class="tiny muted">Date filters are inclusive. The system is simplified for Grade 11 and Grade 12 only with fixed strand/group options.</div>
    </div>`;
}
function readFilterForm(prefix = 'vf') {
  violationFilters = {
    ...violationFilters,
    added_from: $(`#${prefix}From`)?.value || '',
    added_to: $(`#${prefix}To`)?.value || '',
    grade_level: ($(`#${prefix}Grade`)?.value || '').trim(),
    section_id: $(`#${prefix}Section`)?.value || '',
    strand: ($(`#${prefix}Strand`)?.value || '').trim(),
    violation_type: $(`#${prefix}ViolationType`)?.value || '',
    service_status: $(`#${prefix}Service`)?.value || '',
    search: ($(`#${prefix}Search`)?.value || '').trim()
  };
}
function wireFilterForm(prefix = 'vf', rerender) {
  const apply = async () => {
    readFilterForm(prefix);
    try { await loadRecentViolations(); if (view === 'community') await loadCalendar(); rerender(); } catch (e) { toast(e.message); }
  };
  $(`#${prefix}Apply`) && ($(`#${prefix}Apply`).onclick = apply);
  $(`#${prefix}Reset`) && ($(`#${prefix}Reset`).onclick = async () => {
    violationFilters = { added_from: '', added_to: '', grade_level: '', section_id: '', strand: '', violation_type: '', service_status: '', search: '' };
    try { await loadRecentViolations(); if (view === 'community') await loadCalendar(); rerender(); } catch (e) { toast(e.message); }
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
    ['grade_level','section_id','strand','service_status'].forEach(k => { if (violationFilters[k]) qs.set(k, violationFilters[k]); });
    const r = await api('/api/community-service/calendar?' + qs.toString());
    calendarState.days = r.days || [];
  } catch { calendarState.days = []; }
  if (calendarState.selectedDate) await loadCalendarDay(calendarState.selectedDate); else calendarState.selectedItems = [];
}
async function loadCalendarDay(date) {
  calendarState.selectedDate = date;
  try {
    const qs = new URLSearchParams();
    ['grade_level','section_id','strand'].forEach(k => { if (violationFilters[k]) qs.set(k, violationFilters[k]); });
    const r = await api('/api/community-service/calendar/' + encodeURIComponent(date) + (qs.toString() ? ('?' + qs.toString()) : ''));
    calendarState.selectedItems = r.items || [];
  } catch { calendarState.selectedItems = []; }
}

async function loadData() {
  years = await api('/api/years');
  activeYear = years.find(y => y.is_active) || years[0] || null;
  sections = await api('/api/sections' + (activeYear ? '?year=' + activeYear.id : ''));
  offenses = await api('/api/offenses');
  try { await loadRecentViolations(); } catch { cases = await api('/api/violations'); dashboardRecent = { items: cases, total: cases.length }; }
  service = await api('/api/community-service');
  if (me && me.role === 'admin') {
    [users, pending] = await Promise.all([api('/api/users'), api('/api/admin/pending')]);
  } else {
    users = [];
    pending = [];
  }
}

async function go(v) {
  view = v;
  if ($('#pageTitle')) $('#pageTitle').textContent = navItems().find(x => x[0] === v)?.[2] || v;
  renderNav();
  if ($('#yearLabel')) $('#yearLabel').textContent = activeYear ? `SY ${activeYear.label}` : 'School year not set';
  if (v === 'community') await loadCalendar();
  render();
}

function pageHead(title, button = '') { return `<div class="page-head"><h2>${title}</h2>${button || ''}</div>`; }
function cardKpi(label, val, desc = '') { return `<div class="card kpi"><span class="kpi-label">${label}</span><strong>${val}</strong><small>${desc}</small></div>`; }
function table(headers, rows) { return `<div class="card table-card"><div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty">No records found.</td></tr>`}</tbody></table></div></div>`; }

function render() {
  if (!me) return;
  switch (view) {
    case 'dashboard': renderDashboard(); break;
    case 'violations': renderCases(); break;
    case 'community': renderService(); break;
    case 'sections': renderSections(); break;
    case 'accounts': renderAccounts(); break;
    case 'offenses': renderOffenses(); break;
    case 'reports': renderReports(); break;
    default: renderDashboard();
  }
}

function renderDashboard() {
  const activeCases = cases.filter(c => !['Resolved', 'Closed', 'Rejected'].includes(c.status)).length;
  const complete = service.filter(s => s.status === 'Completed').length;
  const pendingCount = (me.role === 'admin' && Array.isArray(pending)) ? pending.length : 0;
  const openService = cases.filter(c => ['pending','in_progress'].includes(String(c.service_status || ''))).length;
  const isAdmin = me.role === 'admin';
  const modules = navItems().map(([v, icon, label]) => `<button class="card" data-view="${v}" style="text-align:left;cursor:pointer"><div class="tiny muted" style="font-size:18px;line-height:1">${icon}</div><h3 style="margin:8px 0 4px">${esc(label)}</h3><p class="muted tiny" style="margin:0">Open ${esc(label.toLowerCase())}</p></button>`).join('');

  let html = `<div class="grid">
    ${cardKpi('Sections (G11-G12)', sections.length, 'Within selected school year')}
    ${cardKpi('Violation cases', cases.length, `${activeCases} open/in progress`)}
    ${cardKpi('Service records', service.length, `${complete} completed assignments`)}
    ${cardKpi(isAdmin ? 'Pending approvals' : 'Cases needing service', isAdmin ? pendingCount : openService, isAdmin ? 'Staff account requests' : 'Pending or in-progress service')}
  </div>`;
  html += `<h2 class="section-title">System modules</h2><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">${modules}</div>`;
  html += `<div class="two-col" style="margin-top:16px">`;
  html += `<div class="card"><h3 style="margin-top:0">At a glance</h3><div class="tiny muted" style="display:grid;gap:8px">
      <div>School year: <strong>${esc(activeYear?.label || 'Not set')}</strong></div>
      <div>Grade levels: <strong>Grade 11 and Grade 12 only</strong></div>
      <div>Sections loaded: <strong>${sections.length}</strong></div>
      <div>Offense categories: <strong>${offenses.length}</strong></div>
      <div>Cases needing service follow-up: <strong>${openService}</strong></div>
      <div>Active filters: <strong>${activeFilterEntries().length}</strong></div>
    </div></div>`;
  html += `<div class="card"><h3 style="margin-top:0">Quick actions</h3><div class="actions" style="gap:8px">`;
  html += `<button class="ghost smallbtn" data-view="violations" type="button">View violations</button>`;
  html += `<button class="ghost smallbtn" data-view="community" type="button">Community service</button>`;
  if (isAdmin) {
    html += `<button class="primary smallbtn" data-modal="recordCase" type="button">+ Record violation</button>`;
    html += `<button class="ghost smallbtn" data-view="sections" type="button">Manage sections</button>`;
    html += `<button class="ghost smallbtn" data-view="accounts" type="button">Manage accounts</button>`;
  }
  html += `</div><p class="tiny muted" style="margin-top:10px">Student details are recorded directly in violation records. No separate student sign-up or student management module is used.</p></div></div>`;

  html += `<h2 class="section-title">Recent violations</h2>`;
  html += renderFilterForm('dbf');
  const rows = (dashboardRecent.items || cases).slice(0, 10).map(c => `<tr><td>${esc(c.case_number)}</td><td>${esc((c.first_name||'')+' '+(c.last_name||''))}<div class="tiny muted">${esc(c.student_number||'')}</div></td><td>G${esc(c.grade_level||'')} · ${esc(c.section_name||'')}${c.strand_name ? `<div class="tiny muted">${esc(c.strand_name)}</div>` : ''}</td><td>${esc(c.offense||'')}</td><td>${badge(c.severity||'')}</td><td>${fmtDate(c.incident_date)}</td><td>${badge(c.status||'')}<div class="tiny muted">service: ${esc(c.service_status||'none')}</div></td></tr>`).join('');
  html += `<div style="height:12px"></div>${table(['Case no.','Student','Grade / Section','Offense','Severity','Date','Status'], rows)}`;
  if (isAdmin) html += `<h2 class="section-title">Administrator approvals</h2><div class="card"><p>${pendingCount} pending staff account request(s).</p><div class="actions" style="margin-top:8px"><button class="primary smallbtn" data-view="accounts" type="button">Review accounts</button></div></div>`;
  $('#content').innerHTML = html;
  wireFilterForm('dbf', renderDashboard);
}

function renderCases() {
  const rows = cases.map(c => {
    const remaining = Math.max(0, hoursNum(c.required_service_hours) - hoursNum(c.completed_service_hours));
    return `<tr>
      <td>${esc(c.case_number)}</td>
      <td>${esc((c.first_name || '') + ' ' + (c.last_name || ''))}${c.student_number ? `<div class="tiny muted">${esc(c.student_number)}</div>` : ''}</td>
      <td>G${esc(c.grade_level || '')} · ${esc(c.section_name || '')}${c.strand_name ? `<div class="tiny muted">${esc(c.strand_name)}</div>` : ''}</td>
      <td>${esc(c.offense || '')}${c.community_service_type ? `<div class="tiny muted">Service: ${esc(c.community_service_type)}</div>` : ''}</td>
      <td>${badge(c.severity || '')}</td>
      <td>${fmtDate(c.incident_date)}</td>
      <td>${badge(c.status || '')}<div class="tiny muted">service: ${esc(c.service_status || 'none')} · ${hoursNum(c.completed_service_hours).toFixed(2)}/${hoursNum(c.required_service_hours).toFixed(2)}h (rem ${remaining.toFixed(2)}h)</div></td>
      <td>${me.role === 'admin'
        ? `<select data-case-status="${c.id}">${['Reported','Under Review','Verified','Accepted','In Progress','Resolved','Closed','Rejected','Escalated'].map(x => `<option ${x===c.status?'selected':''}>${x}</option>`).join('')}</select><div style="height:6px"></div><button class="ghost smallbtn" data-details="${c.id}" type="button">Details</button>`
        : `<button class="ghost smallbtn" data-details="${c.id}" type="button">View</button>`}</td>
    </tr>`;
  }).join('');
  $('#content').innerHTML =
    pageHead('Violation records', `<div class="actions"><button class="ghost" id="exportViolationsXlsx" type="button">Export Violations XLSX</button><button class="ghost" id="exportServiceXlsx" type="button">Export Service XLSX</button>${me.role === 'admin' ? '<button class="primary" data-modal="recordCase" type="button">+ Record violation</button>' : ''}</div>`) +
    renderFilterForm('vf') +
    `<div style="height:12px"></div><div class="note">Record violations with student details in one form (Grade 11-12 only). Student information is saved/linked automatically; no separate student module is required.</div><div style="height:12px"></div>` +
    table(['Case no.','Student','Grade / Section','Offense / Service type','Severity','Date','Status / Service hours', me.role === 'admin' ? 'Actions' : 'Details'], rows);
  wireFilterForm('vf', renderCases);
  $('#exportViolationsXlsx') && ($('#exportViolationsXlsx').onclick = () => { window.location.href = '/api/exports/violations.xlsx?' + filterParams().toString(); });
  $('#exportServiceXlsx') && ($('#exportServiceXlsx').onclick = () => { window.location.href = '/api/exports/community-service.xlsx?' + filterParams().toString(); });
}

function renderSections() {
  const yearRows = years.map(y => {
    const statusSel = me.role === 'admin'
      ? `<select data-year-status="${y.id}"><option value="active" ${y.is_active ? 'selected' : ''}>Active</option><option value="inactive" ${!y.is_active ? 'selected' : ''}>Inactive</option></select>`
      : (y.is_active ? badge('Active') : badge('Inactive'));
    return `<tr><td>${esc(y.label)}</td><td>${statusSel}</td><td>${y.archived_at ? fmtDate(String(y.archived_at).slice(0,10)) : '—'}</td><td class="actions">${me.role === 'admin' ? `<button class="ghost smallbtn" data-edit-year="${y.id}" type="button">Edit</button>` : '—'}</td></tr>`;
  }).join('');
  const secRows = sections.map(s => `<tr><td>G${esc(s.grade_level)}</td><td>${esc(s.section_name)}</td><td>${esc(s.strand_name || s.strand || '—')}</td><td>${esc(s.school_year || s.school_year_label || '')}</td><td class="actions">${me.role === 'admin' ? `<button class="ghost smallbtn" data-edit-section="${s.id}" type="button">Edit</button><button class="ghost smallbtn" data-delete-section="${s.id}" type="button">Delete</button>` : '—'}</td></tr>`).join('');

  $('#content').innerHTML =
    `<div class="card"><div class="inline-form"><label style="margin:0;min-width:220px;flex:1">View sections for school year<select id="yearFilter">${years.map(y => `<option value="${y.id}" ${y.id === activeYear?.id ? 'selected' : ''}>${esc(y.label)}</option>`).join('')}</select></label><div class="filter-actions">${me.role==='admin'?'<button class="primary" data-modal="year" type="button">+ Add school year</button><button class="primary" data-modal="section" type="button">+ Add section</button>':''}</div></div></div>` +
    `<div style="height:15px"></div><div class="two-col"><div>${pageHead('School years', '')}${table(['School year','Status','Archived','Action'], yearRows)}<p class="tiny muted">Admins can set each school year as active or inactive using the status dropdown.</p></div><div>${pageHead('Grade 11-12 sections', '')}${table(['Grade','Section','Strand/Group','School year','Actions'], secRows)}</div></div>` +
    `<div style="height:12px"></div><div class="card"><h3 style="margin-top:0">Simplified setup</h3><p class="tiny muted">Only Grade 11 and Grade 12 are supported. Strand/group selection uses fixed options (no track/strand creation). Student details are captured when recording violations.</p></div>`;
  $('#yearFilter') && ($('#yearFilter').onchange = async () => {
    const id = Number($('#yearFilter').value);
    const selected = years.find(y => y.id === id) || activeYear;
    activeYear = selected;
    try { sections = await api('/api/sections' + (selected ? '?year=' + selected.id : '')); } catch (e) { toast(e.message); }
    renderSections();
  });
}

function renderAccounts() {
  const roleName = r => ({admin:'Administrator',teacher:'Teacher',guidance_counselor:'Guidance Counselor',class_adviser:'Class Adviser'}[r] || r || '');
  const pendingRows = (pending || []).map(p => {
    const reqSec = p.role === 'class_adviser' && (p.requested_section_name || p.requested_school_year)
      ? `<div class="tiny muted">${esc(p.requested_school_year || '')} · Grade ${esc(p.requested_section_grade || '')} ${esc(p.requested_section_name || '')}</div>`
      : '';
    return `<tr><td>${esc(p.full_name)}</td><td>${esc(p.email || '—')}</td><td>${esc(roleName(p.role))}${reqSec}</td><td>${fmtDate((p.created_at||'').slice(0,10))}</td><td class="actions"><button class="primary smallbtn" data-approve="${p.id}" type="button">Approve</button><button class="ghost smallbtn" data-reject="${p.id}" type="button">Reject</button></td></tr>`;
  }).join('');
  const userRows = (users || []).map(u => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email || '—')}</td><td>${esc(roleName(u.role))}</td><td>${badge(u.status)}</td><td>${(u.role === 'teacher' || u.role === 'guidance_counselor' || u.role === 'class_adviser') ? `<button class="primary smallbtn" data-assign="${u.id}" type="button">Sections</button> ` : ''}${u.id === me.id ? 'Current account' : `<button class="ghost smallbtn" data-toggle-user="${u.id}" data-status="${u.status === 'suspended' ? 'verified' : 'suspended'}" type="button">${u.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button>`}</td></tr>`).join('');
  $('#content').innerHTML =
    pageHead('Account management', '<div class="actions"><button class="primary" data-modal="teacher" type="button">+ Create teacher</button><button class="primary" data-modal="staffUser" type="button">+ Create staff account</button></div>') +
    `<h2 class="section-title">Pending staff account requests</h2>${table(['Name','Email','Requested role','Requested','Review'], pendingRows)}` +
    `<h2 class="section-title">System accounts</h2>${table(['Name','Email','Role','Status','Action'], userRows)}` +
    `<p class="note">Student access and self-sign-up are not enabled. Staff/admin accounts require email and admin approval where applicable. Class advisers are limited to one section per school year.</p>`;
}

function renderOffenses() {
  const rows = offenses.map(o => `<tr><td>${esc(o.name)}</td><td>${badge(o.severity)}</td><td>${esc(o.description || '')}</td></tr>`).join('');
  $('#content').innerHTML = pageHead('Offense catalog', me.role==='admin'?'<button class="primary" data-modal="offense" type="button">+ Add offense</button>':'') + table(['Offense','Severity','Description'], rows);
}

function renderReports() {
  const rows = cases.map(c => `<tr><td>${esc(c.case_number)}</td><td>${esc((c.first_name||'')+' '+(c.last_name||''))}</td><td>${esc(c.student_number||'')}</td><td>G${esc(c.grade_level||'')}</td><td>${esc(c.section_name||'')}</td><td>${esc(c.strand_name||'—')}</td><td>${esc(c.offense||'')}</td><td>${badge(c.status||'')}</td><td>${esc(c.service_status||'none')}</td></tr>`).join('');
  $('#content').innerHTML =
    pageHead('Reports & summaries', '<div class="actions"><button class="primary" id="exportFilteredViolations" type="button">Export filtered violations XLSX</button><button class="ghost" id="exportFilteredService" type="button">Export filtered service XLSX</button></div>') +
    renderFilterForm('rf') +
    `<div style="height:12px"></div>${table(['Case','Student','Student no.','Grade','Section','Strand/Group','Offense','Status','Service status'], rows)}` +
    `<p class="note">Reports and exports reflect current section assignments and active filters. The system is limited to Grade 11 and Grade 12.</p>`;
  wireFilterForm('rf', renderReports);
  $('#exportFilteredViolations') && ($('#exportFilteredViolations').onclick = () => { window.location.href = '/api/exports/violations.xlsx?' + filterParams().toString(); });
  $('#exportFilteredService') && ($('#exportFilteredService').onclick = () => { window.location.href = '/api/exports/community-service.xlsx?' + filterParams().toString(); });
}

function monthLabel(ym) { const d = new Date(ym + '-01T00:00:00'); return Number.isNaN(d.getTime()) ? ym : d.toLocaleString(undefined, { month: 'long', year: 'numeric' }); }
function shiftMonth(ym, delta) { const d = new Date(ym + '-01T00:00:00'); if (Number.isNaN(d.getTime())) return ym; d.setMonth(d.getMonth() + delta); return d.toISOString().slice(0, 7); }

function renderService() {
  const daysMap = new Map((calendarState.days || []).map(d => [String(d.service_date).slice(0,10), d]));
  const ym = calendarState.month;
  const first = new Date(ym + '-01T00:00:00');
  const startDow = Number.isNaN(first.getTime()) ? 0 : first.getDay();
  const daysInMonth = Number.isNaN(first.getTime()) ? 30 : new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(`<div class="calendar-day muted-day"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${ym}-${String(day).padStart(2,'0')}`;
    const info = daysMap.get(date);
    const selected = calendarState.selectedDate === date ? ' selected' : '';
    cells.push(`<button type="button" class="calendar-day ${info ? 'has-logs' : ''}${selected}" data-calendar-day="${date}"><div class="day-num">${day}</div><div class="meta">${info ? `${hoursNum(info.total_hours).toFixed(2)}h · ${info.student_count||0} student(s)<br>${info.log_count||0} log(s)` : 'No attendance logged'}</div></button>`);
  }

  const detailRows = (calendarState.selectedItems || []).map(l => {
    const remaining = Math.max(0, hoursNum(l.required_service_hours) - hoursNum(l.completed_service_hours));
    return `<tr><td>${esc((l.last_name||'')+', '+(l.first_name||''))}<div class="tiny muted">${esc(l.student_number||'')} · G${esc(l.grade_level||'')} ${esc(l.section_name||'')}</div></td><td>${esc(l.case_number || '—')}</td><td>${hoursNum(l.hours_rendered).toFixed(2)}</td><td>${hoursNum(l.completed_service_hours).toFixed(2)} / ${hoursNum(l.required_service_hours).toFixed(2)}<div class="tiny muted">Remaining: ${remaining.toFixed(2)}h · ${esc(l.service_status||'none')}</div></td><td>${esc(l.remarks || '—')}</td><td>${esc(l.verified_by_name || '—')}</td><td><button class="ghost smallbtn" data-edit-service-log="${l.id}" type="button">Edit</button></td></tr>`;
  }).join('');

  const assignmentRows = (service || []).map(c => {
    const pct = c.hours_required ? Math.min(100, Math.round((Number(c.hours_completed||0) / Number(c.hours_required||1)) * 100)) : (c.service_days_required ? Math.min(100, Math.round((Number(c.days_completed||0) / Number(c.service_days_required||1)) * 100)) : 0);
    return `<tr><td>${esc((c.first_name||'') + ' ' + (c.last_name||''))}</td><td>G${esc(c.grade_level||'')} · ${esc(c.section_name||'')}</td><td>${esc(c.case_number || 'Standalone')}</td><td>${c.days_completed}/${c.service_days_required} days</td><td>${Number(c.hours_completed||0).toFixed(1)}/${c.hours_required} hours</td><td><div class="progress"><span style="width:${pct}%"></span></div>${pct}%</td><td>${badge(c.status)}</td><td><div class="actions"><button class="primary smallbtn" data-attendance="${c.id}" type="button">Log day</button><button class="ghost smallbtn" data-history="${c.id}" type="button">History</button></div></td></tr>`;
  }).join('');

  $('#content').innerHTML =
    pageHead('Community service attendance', `<div class="actions"><button class="ghost" id="exportServiceXlsxCal" type="button">Export service XLSX</button>${me.role==='admin'?'<button class="primary" data-modal="service" type="button">+ Assign service (tracker)</button>':''}</div>`) +
    renderFilterForm('csf', { extraButtons: `<button class="ghost" id="csLogToday" type="button">Log hours for selected date</button>` }) +
    `<div style="height:12px"></div><div class="split-panels">
      <div class="card calendar-wrap">
        <div class="calendar-header">
          <div class="actions"><button class="ghost" id="calPrev" type="button">◀</button><button class="ghost" id="calToday" type="button">Today</button><button class="ghost" id="calNext" type="button">▶</button></div>
          <strong>${esc(monthLabel(ym))}</strong>
          <div class="tiny muted">Click a day to inspect attendance and remaining hours.</div>
        </div>
        <div class="calendar-weekdays"><div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div></div>
        <div class="calendar-grid">${cells.join('')}</div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Attendance on ${esc(calendarState.selectedDate || 'selected date')}</h3>
        ${calendarState.selectedDate ? `<div class="tiny muted" style="margin-bottom:10px">Students who rendered service on this date, with cumulative progress toward required hours.</div>${table(['Student','Case','Rendered (day)','Completed / Required','Remarks','Verified by','Actions'], detailRows)}` : '<p class="muted">Select a date on the calendar to view attendance logs and remaining hours.</p>'}
        <div style="height:10px"></div><button class="primary" id="logServiceHoursBtn" type="button" ${calendarState.selectedDate ? '' : 'disabled'}>Log/update hours for this date</button>
      </div>
    </div>` +
    `<h2 class="section-title">Community service assignments tracker</h2>` +
    `<div class="note">Assignment/day-based tracker (legacy support). Use the calendar/log view above for violation-linked rendered-hours tracking and cumulative completion.</div><div style="height:12px"></div>` +
    table(['Student','Section','Case','Days','Hours','Progress','Status','Actions'], assignmentRows);

  wireFilterForm('csf', async () => { await loadCalendar(); renderService(); });
  $('#exportServiceXlsxCal') && ($('#exportServiceXlsxCal').onclick = () => { window.location.href = '/api/exports/community-service.xlsx?' + filterParams().toString(); });
  $('#calPrev') && ($('#calPrev').onclick = async () => { calendarState.month = shiftMonth(calendarState.month, -1); calendarState.selectedDate=''; calendarState.selectedItems=[]; await loadCalendar(); renderService(); });
  $('#calNext') && ($('#calNext').onclick = async () => { calendarState.month = shiftMonth(calendarState.month, 1); calendarState.selectedDate=''; calendarState.selectedItems=[]; await loadCalendar(); renderService(); });
  $('#calToday') && ($('#calToday').onclick = async () => { calendarState.month = new Date().toISOString().slice(0,7); calendarState.selectedDate = new Date().toISOString().slice(0,10); await loadCalendar(); renderService(); });
  const openLog = () => openLogServiceModal(calendarState.selectedDate || new Date().toISOString().slice(0,10));
  $('#logServiceHoursBtn') && ($('#logServiceHoursBtn').onclick = openLog);
  $('#csLogToday') && ($('#csLogToday').onclick = openLog);
}

function modal(title, body) {
  const old = $('.modal-bg');
  if (old) old.remove();
  const b = document.createElement('div');
  b.className = 'modal-bg';
  b.innerHTML = `<div class="modal"><h2>${title}</h2>${body}<div class="modal-footer"><button class="ghost" data-close type="button">Cancel</button><button class="primary" id="modalSubmit" type="button">Save</button></div></div>`;
  document.body.appendChild(b);
  b.addEventListener('click', e => { if (e.target === b || e.target.closest('[data-close]')) b.remove(); });
  return b;
}

function openLogServiceModal(date, existing = null) {
  const selectedDate = date || calendarState.selectedDate || new Date().toISOString().slice(0,10);
  const caseOptions = cases.map(c => {
    const label = `${c.case_number} · ${(c.first_name||'')+' '+(c.last_name||'')} · ${c.student_number||'no #'} · req ${hoursNum(c.required_service_hours).toFixed(2)}h / done ${hoursNum(c.completed_service_hours).toFixed(2)}h (${c.service_status||'none'})`;
    const selected = existing ? String(existing.violation_id||'') === String(c.id) : false;
    return `<option value="${c.id}" data-student-id="${esc(c.student_id||'')}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const title = existing ? 'Update community service log' : 'Log community service hours';
  const m = modal(title, `
    <form id="modalForm">
      <label>Service date<input name="service_date" type="date" value="${esc(String(existing?.service_date || selectedDate).slice(0,10))}" required></label>
      <label>Violation/case (recommended)<select name="violation_id" id="logViolationId"><option value="">No violation link</option>${caseOptions}</select></label>
      <label>Student ID (auto-filled from case when available)<input name="student_id" id="logStudentId" value="${esc(existing?.student_id || '')}" required></label>
      <label>Hours rendered<input name="hours_rendered" type="number" min="0" step="0.25" value="${esc(existing ? existing.hours_rendered : '1')}" required></label>
      <label>Remarks<textarea name="remarks">${esc(existing?.remarks || '')}</textarea></label>
    </form>
    <p class="tiny muted">If linked to a violation, the system recalculates completed hours and service status. Over-cap rendered hours are allowed.</p>
  `);
  const syncStudent = () => {
    const vsel = $('#logViolationId');
    const sid = vsel?.selectedOptions?.[0]?.dataset?.studentId;
    if (sid && $('#logStudentId')) $('#logStudentId').value = sid;
  };
  $('#logViolationId') && ($('#logViolationId').onchange = syncStudent);
  if (existing?.violation_id) syncStudent();
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f).entries());
    if (!d.violation_id) delete d.violation_id;
    try {
      if (existing) await patch(`/api/community-service/logs/${existing.id}`, d);
      else await post('/api/community-service/logs', d);
      m.remove();
      await loadData();
      await loadCalendar();
      go('community');
      toast(existing ? 'Service log updated' : 'Service hours logged');
    } catch (e) { toast(e.message); }
  };
}

async function openModal(kind, id) {
  let m, submit;
  switch (kind) {
    case 'year':
      m = modal('Add school year', `<form id="modalForm">
        <label>School year label<input name="label" placeholder="2026-2027" required></label>
        <label>Status<select name="is_active"><option value="inactive">Inactive</option><option value="active">Active</option></select></label>
      </form><p class="tiny muted">Set the school year status as active or inactive. Activating a year deactivates other years.</p>`);
      submit = async d => { await post('/api/years', { label: d.label, is_active: d.is_active }); await loadData(); go('sections'); };
      break;

    case 'section':
      m = modal('Create section (Grade 11-12)', `<form id="modalForm">
        <label>School year<select name="yearId" required>${opt(years, 'id', 'label')}</select></label>
        <label>Grade level<select name="grade_level" required><option value="">Select grade</option>${GRADE_OPTIONS.map(g => `<option value="${g}">Grade ${g}</option>`).join('')}</select></label>
        <label>Section name<input name="section_name" required></label>
        <label>Strand/Group<select name="strand"><option value="">Select strand/group (optional)</option>${strandOptions('', false)}</select></label>
      </form><p class="tiny muted">Only Grade 11 and Grade 12 sections are supported. Strand/group options are fixed (no track/strand creation).</p>`);
      submit = async d => { await post('/api/sections', d); await loadData(); go('sections'); };
      break;

    case 'teacher':
      m = modal('Create teacher account', `<form id="modalForm">
        <label>Full name<input name="name" required></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Temporary password (10+ characters)<div class="password-wrap"><input name="password" type="password" minlength="10" required><button type="button" class="toggle-pass" data-toggle-password>Show</button></div></label>
        <label>Assigned section (one section only)<select name="section_id" required><option value="">Select section</option>${sectionOptions()}</select></label>
        <p class="tiny muted">Teachers have section-scoped access and can be assigned to only one section.</p>
      </form>`);
      submit = async d => { await post('/api/teachers', d); await loadData(); go('accounts'); };
      break;

    case 'staffUser': {
      m = modal('Create staff account', `<form id="modalForm">
        <label>Full name<input name="name" required></label>
        <label>Role<select name="role" id="staffRoleSelect" required>
          <option value="admin">Administrator</option>
          <option value="guidance_counselor">Guidance Counselor</option>
          <option value="class_adviser">Class Adviser</option>
          <option value="teacher">Teacher</option>
        </select></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Password (10+ characters)<div class="password-wrap"><input name="password" type="password" minlength="10" required><button type="button" class="toggle-pass" data-toggle-password>Show</button></div></label>
        <label id="staffSectionLabel">Assigned section<select name="section_id" id="staffSectionSelect"><option value="">Select section (optional for Administrator/Guidance Counselor)</option>${sectionOptions()}</select></label>
        <p class="tiny muted">Teacher and Class Adviser accounts require exactly one section. Class advisers are limited to one section per school year.</p>
      </form>`);
      const staffRoleSel = $('#staffRoleSelect');
      const staffSecSel = $('#staffSectionSelect');
      const syncStaffSectionReq = () => {
        const role = staffRoleSel?.value || '';
        const required = role === 'teacher' || role === 'class_adviser';
        if (staffSecSel) {
          staffSecSel.required = required;
          staffSecSel.innerHTML = `<option value="">${required ? 'Select section (required)' : 'Select section (optional for Administrator/Guidance Counselor)'}</option>${sectionOptions()}`;
        }
      };
      staffRoleSel?.addEventListener('change', syncStaffSectionReq);
      syncStaffSectionReq();
      submit = async d => { await post('/api/staff/users', d); await loadData(); go('accounts'); };
      break;
    }

    case 'offense':
      m = modal('Add offense category', `<form id="modalForm"><label>Offense name<input name="name" required></label><label>Severity<select name="severity"><option>Minor</option><option>Major</option><option>Serious</option></select></label><label>Description<textarea name="description"></textarea></label></form>`);
      submit = async d => { await post('/api/offenses', d); await loadData(); go('offenses'); };
      break;

    case 'recordCase': {
      if (!sections.length) { toast('Create a Grade 11 or Grade 12 section first.'); return; }
      m = modal('Record violation (with student details)', `<form id="modalForm">
        <label>Case number<input name="caseNumber" placeholder="SV-2026-0001" required></label>
        <hr>
        <label>Student number<input name="student_number" required></label>
        <label>First name<input name="first_name" required></label>
        <label>Last name<input name="last_name" required></label>
        <label>Grade level<select name="grade_level" id="caseGrade" required><option value="">Select grade</option>${GRADE_OPTIONS.map(g => `<option value="${g}">Grade ${g}</option>`).join('')}</select></label>
        <label>Section<select name="section_id" id="caseSection" required><option value="">Select section</option>${sectionOptions()}</select></label>
        <label>Strand/Group<select name="strand" id="caseStrand"><option value="">Select strand/group (optional)</option>${strandOptions('', false)}</select></label>
        <label>Guardian name<input name="guardian_name"></label>
        <label>Guardian contact<input name="guardian_contact"></label>
        <hr>
        <label>Offense<select name="offenseId" required>${offenses.map(o => `<option value="${o.id}">${esc(o.name)} (${esc(o.severity)})</option>`).join('')}</select></label>
        <label>Incident date<input name="date" type="date" required></label>
        <label>Time<input name="time" type="time"></label>
        <label>Location<input name="location"></label>
        <label>Description<textarea name="description"></textarea></label>
        <label>Evidence notes<textarea name="evidence"></textarea></label>
        <label>Community service task/type<input name="community_service_type" placeholder="e.g. Campus cleanup"></label>
        <label>Required service hours<input name="required_service_hours" id="caseReqHours" type="number" min="0" step="0.25" value="0"></label>
        <label>Completed service hours<input name="completed_service_hours" id="caseDoneHours" type="number" min="0" step="0.25" value="0"></label>
        <div class="tiny muted" id="caseHoursInfo">Remaining: 0.00h · Status: none (0 required hours)</div>
      </form><p class="tiny muted">Student details are saved/linked during violation recording (no separate Add Student step). Use the same student number to update/link an existing Grade 11-12 student record. Completed hours may exceed required hours; status becomes completed when completed ≥ required and required &gt; 0.</p>`);
      const updateHoursInfo = () => {
        const req = Math.max(0, Number($('#caseReqHours')?.value || 0));
        const done = Math.max(0, Number($('#caseDoneHours')?.value || 0));
        const remaining = Math.max(0, req - done);
        const status = req <= 0 ? 'none' : (done >= req ? 'completed' : (done > 0 ? 'in_progress' : 'pending'));
        const el = $('#caseHoursInfo'); if (el) el.textContent = `Remaining: ${remaining.toFixed(2)}h · Status: ${status}`;
      };
      ['caseReqHours','caseDoneHours'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', updateHoursInfo); });
      updateHoursInfo();
      const gradeSel = $('#caseGrade');
      const secSel = $('#caseSection');
      const strandSel = $('#caseStrand');
      const syncFromGrade = () => {
        const g = gradeSel?.value || '';
        if (secSel) {
          const opts = sections.filter(s => !g || String(s.grade_level) === String(g));
          secSel.innerHTML = `<option value="">Select section</option>${opts.map(s => `<option value="${s.id}" data-grade="${esc(s.grade_level)}" data-strand="${esc(s.strand||'')}">${esc(sectionLabel(s))}${s.school_year ? ' · ' + esc(s.school_year) : ''}</option>`).join('')}`;
        }
      };
      const syncFromSection = () => {
        const optSel = secSel?.selectedOptions?.[0];
        if (!optSel || !optSel.value) return;
        const g = optSel.dataset.grade || '';
        const st = optSel.dataset.strand || '';
        if (gradeSel && g) gradeSel.value = g;
        if (strandSel && !strandSel.dataset.touched) strandSel.value = st;
      };
      gradeSel && gradeSel.addEventListener('change', () => { if (strandSel) strandSel.dataset.touched = ''; syncFromGrade(); });
      secSel && secSel.addEventListener('change', syncFromSection);
      strandSel && strandSel.addEventListener('change', () => { strandSel.dataset.touched = '1'; });
      submit = async d => { await post('/api/violations', d); await loadData(); go('violations'); };
      break;
    }

    case 'service': {
      try {
        const studentOptionsData = await get('/api/students' + (activeYear ? '?year=' + activeYear.id : ''));
        m = modal('Assign community service (tracker)', `<form id="modalForm"><label>Student<select name="studentId" required>${(studentOptionsData||[]).map(x => `<option value="${x.id}">${esc((x.last_name||'')+', '+(x.first_name||'')+' · G'+(x.grade_level||'')+' '+(x.section_name||''))}</option>`).join('')}</select></label><label>School year<select name="yearId" required>${opt(years,'id','label')}</select></label><label>Required service days<input name="days" type="number" min="0" value="1"></label><label>Required hours<input name="hours" type="number" min="0" step="0.5" value="2"></label><label>Start date<input name="startDate" type="date"></label><label>Due date<input name="dueDate" type="date"></label><label>Notes<textarea name="notes"></textarea></label></form>`);
      } catch (e) { toast(e.message); return; }
      submit = async d => { await post('/api/community-service', d); await loadData(); go('community'); };
      break;
    }
  }

  if (!m) return;
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm');
    if (!f || !f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f).entries());
    try { await submit(d); m.remove(); toast('Saved successfully'); } catch (e) { toast(e.message); }
  };
}

async function logAttendance(id) {
  const m = modal('Log attendance day', `<form id="modalForm"><label>Date<input name="date" type="date" required></label><label>Days earned<input name="dayCompleted" type="number" min="0" step="0.5" value="1"></label><label>Hours earned<input name="hours" type="number" min="0" step="0.5" value="1"></label><label>Notes<textarea name="notes"></textarea></label></form>`);
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f.reportValidity()) return;
    try { await post(`/api/community-service/${id}/attendance`, Object.fromEntries(new FormData(f).entries())); m.remove(); await loadData(); go('community'); toast('Attendance logged'); } catch (e) { toast(e.message); }
  };
}

async function history(id) {
  try {
    const h = await get(`/api/community-service/${id}/attendance`);
    const m = modal('Attendance history', h.length ? table(['Date','Days','Hours','Status','Notes'], h.map(x => `<tr><td>${fmtDate(x.attendance_date || x.service_date)}</td><td>${esc(x.days_earned ?? x.day_completed ?? '')}</td><td>${esc(x.hours_earned ?? x.hours_served ?? '')}</td><td>${badge(x.status || '')}</td><td>${esc(x.notes || '')}</td></tr>`).join('')) : '<p class="muted">No attendance records yet.</p>');
    const sb = m.querySelector('#modalSubmit'); if (sb) sb.style.display = 'none';
  } catch (e) { toast(e.message); }
}

function openCaseDetails(id) {
  const item = cases.find(c => String(c.id) === String(id));
  if (!item) return toast('Case not found.');
  const remaining = Math.max(0, hoursNum(item.required_service_hours) - hoursNum(item.completed_service_hours));
  const body = `
    <p><strong>Student:</strong> ${esc(item.first_name||'')} ${esc(item.last_name||'')} (${esc(item.student_number||'—')})</p>
    <p><strong>Section:</strong> G${esc(item.grade_level||'')} · ${esc(item.section_name||'')}${item.strand_name ? ` · ${esc(item.strand_name)}` : ''}</p>
    <p><strong>Offense:</strong> ${esc(item.offense||'')} <span class="tiny muted">(${esc(item.severity||'')})</span></p>
    <p><strong>Incident:</strong> ${fmtDate(item.incident_date)} ${esc(item.incident_time||'')} ${item.location ? `· ${esc(item.location)}` : ''}</p>
    <p><strong>Status:</strong> ${badge(item.status||'')}</p>
    <p><strong>Description:</strong><br>${esc(item.description||'—')}</p>
    <p><strong>Evidence:</strong><br>${esc(item.evidence_notes||'—')}</p>
    <hr>
    <p><strong>Guardian:</strong> ${esc(item.guardian_name||'—')} ${item.guardian_contact ? `— ${esc(item.guardian_contact)}` : ''}</p>
    <p><strong>Community service:</strong> ${esc(item.community_service_type||'—')} · Required ${hoursNum(item.required_service_hours).toFixed(2)}h · Completed ${hoursNum(item.completed_service_hours).toFixed(2)}h · Remaining ${remaining.toFixed(2)}h · Status ${badge(item.service_status||'none')}</p>`;
  const m = modal(`Case ${item.case_number}`, body);
  const sb = m.querySelector('#modalSubmit'); if (sb) sb.style.display = 'none';
}

function openEditYear(id) {
  const y = years.find(x => String(x.id) === String(id));
  if (!y) return toast('School year not found.');
  const m = modal('Edit school year', `<form id="modalForm">
    <label>School year label<input name="label" value="${esc(y.label||'')}" required></label>
    <label>Status<select name="is_active"><option value="active" ${y.is_active ? 'selected' : ''}>Active</option><option value="inactive" ${!y.is_active ? 'selected' : ''}>Inactive</option></select></label>
  </form><p class="tiny muted">Admins can set the school year as active or inactive. Activating a year deactivates other years.</p>`);
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f).entries());
    try { await put(`/api/years/${y.id}`, { label: d.label, is_active: d.is_active }); m.remove(); await loadData(); go('sections'); toast('School year updated'); } catch (e) { toast(e.message); }
  };
}

function openEditSection(id) {
  const s = sections.find(x => String(x.id) === String(id));
  if (!s) return toast('Section not found.');
  const m = modal('Edit section (Grade 11-12)', `<form id="modalForm">
    <label>Grade level<select name="grade_level" required>${GRADE_OPTIONS.map(g => `<option value="${g}" ${String(s.grade_level)===g?'selected':''}>Grade ${g}</option>`).join('')}</select></label>
    <label>Section name<input name="section_name" value="${esc(s.section_name||'')}" required></label>
    <label>Strand/Group<select name="strand"><option value="">Select strand/group (optional)</option>${SHS_STRANDS.map(x => `<option value="${esc(x)}" ${String(s.strand||s.strand_name||'')===x?'selected':''}>${esc(x)}</option>`).join('')}</select></label>
  </form>`);
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f.reportValidity()) return;
    try { await put(`/api/sections/${s.id}`, Object.fromEntries(new FormData(f).entries())); m.remove(); await loadData(); go('sections'); toast('Section updated'); } catch (e) { toast(e.message); }
  };
}

async function openAssignSections(userId) {
  const user = (users || []).find(x => String(x.id) === String(userId));
  if (!user) return toast('User not found.');
  let assigned = [];
  try { assigned = await get(`/api/teachers/${userId}/sections`); } catch {}
  const assignedIds = new Set((assigned || []).map(x => String(x)));
  const multi = !(user.role === 'teacher' || user.role === 'class_adviser');
  const opts = sections.map(s => `<option value="${s.id}" ${assignedIds.has(String(s.id)) ? 'selected' : ''}>${esc((s.school_year || '') + (s.school_year ? ' · ' : ''))}${esc(sectionLabel(s))}</option>`).join('');
  const note = (user.role === 'class_adviser')
    ? '<p class="tiny muted">Class Adviser accounts are limited to one section per school year, and each section can have only one Class Adviser account.</p>'
    : '<p class="tiny muted">Teacher accounts are limited to one section. Guidance counselors may be assigned to multiple sections.</p>';
  const m = modal(`Assign sections - ${user.full_name}`, `<form id="modalForm"><label>Sections<select name="sections" id="assignSectionsSelect" ${multi ? 'multiple size="8"' : ''}>${opts}</select></label></form>${note}`);
  $('#modalSubmit').onclick = async () => {
    const sel = $('#assignSectionsSelect');
    const vals = sel ? [...sel.selectedOptions].map(o => Number(o.value)).filter(Boolean) : [];
    try { await put(`/api/teachers/${userId}/sections`, { sections: vals, section_id: vals[0] || null }); m.remove(); await loadData(); go('accounts'); toast('Section assignment updated'); } catch (e) { toast(e.message); }
  };
}

function switchAuthTab(tab) {
  const normalized = (tab === 'register' || tab === 'staff') ? 'register' : 'login';
  $('#loginForm')?.classList.toggle('hidden', normalized !== 'login');
  $('#registerForm')?.classList.toggle('hidden', normalized !== 'register');
  $$('.tab').forEach(b => b.classList.toggle('active', (b.dataset.auth || '') === (normalized === 'register' ? 'register' : 'login')));
  if (normalized === 'register') loadSignupOptions().then(populateSignupOptionsUI).catch(() => {});
}

function openAuthModal(tab = 'login') {
  $('#authModal')?.classList.remove('hidden');
  $('#authModal')?.setAttribute('aria-hidden', 'false');
  const setupVisible = $('#setupForm') && !$('#setupForm').classList.contains('hidden');
  if (setupVisible) {
    $('#loginForm')?.classList.add('hidden');
    $('#registerForm')?.classList.add('hidden');
  } else {
    $('#setupForm')?.classList.add('hidden');
    switchAuthTab(tab);
  }
}

async function loadSignupOptions(force = false) {
  if (signupOptionsCache && !force) return signupOptionsCache;
  try { signupOptionsCache = await get('/api/public/signup-options'); }
  catch (e) { signupOptionsCache = { years: [], sections: [], strands: SHS_STRANDS }; }
  return signupOptionsCache;
}

function populateSignupOptionsUI() {
  const opts = signupOptionsCache || { years: [], sections: [], strands: SHS_STRANDS };
  const role = ($('#staffRequestRole')?.value || 'admin');
  const wrap = $('#staffRequestSectionWrap');
  const sel = $('#staffRequestSection');
  if (!wrap || !sel) return;
  const needsSection = role === 'class_adviser';
  wrap.classList.toggle('hidden', !needsSection);
  sel.required = needsSection;
  const list = (opts.sections || []).filter(s => String(s.grade_level) === '11' || String(s.grade_level) === '12');
  sel.innerHTML = `<option value="">${needsSection ? 'Select section (required)' : 'Select section'}</option>` + list.map(s => `<option value="${s.id}">${esc((s.school_year||'') + (s.school_year?' · ':'') + 'G' + (s.grade_level||'') + ' · ' + (s.section_name||'') + (s.strand ? ' · ' + s.strand : ''))}</option>`).join('');
}

function attachClickHandlers() {
  document.addEventListener('click', async e => {
    const logoutBtn = e.target.closest('#logoutBtn, #logout');
    if (logoutBtn) { e.preventDefault(); try { await post('/api/auth/logout', {}); } catch(_){} me = null; showGate(); return; }

    const openAuth = e.target.closest('[data-open-auth]');
    if (openAuth) { openAuthModal(openAuth.dataset.openAuth || 'login'); return; }
    const closeAuth = e.target.closest('[data-close-auth]');
    if (closeAuth) { closeAuthModal(); return; }

    const tab = e.target.closest('.tab[data-auth]');
    if (tab) { switchAuthTab(tab.dataset.auth); return; }

    const nav = e.target.closest('[data-view]');
    if (nav) { await go(nav.dataset.view); return; }

    const modalBtn = e.target.closest('[data-modal]');
    if (modalBtn) { await openModal(modalBtn.dataset.modal, modalBtn.dataset.id); return; }

    const calDay = e.target.closest('[data-calendar-day]');
    if (calDay) { try { await loadCalendarDay(calDay.dataset.calendarDay); renderService(); } catch (err) { toast(err.message); } return; }

    const editLog = e.target.closest('[data-edit-service-log]');
    if (editLog) {
      const log = (calendarState.selectedItems || []).find(x => String(x.id) === String(editLog.dataset.editServiceLog));
      if (!log) return toast('Log not found.');
      return openLogServiceModal(log.service_date, log);
    }

    const approve = e.target.closest('[data-approve]');
    if (approve) { try { await post(`/api/admin/verify/${approve.dataset.approve}`, {}); await loadData(); if (view === 'accounts') renderAccounts(); else render(); toast('Request approved'); } catch (err) { toast(err.message); } return; }
    const reject = e.target.closest('[data-reject]');
    if (reject) { try { await post(`/api/admin/reject/${reject.dataset.reject}`, {}); await loadData(); if (view === 'accounts') renderAccounts(); else render(); toast('Request rejected'); } catch (err) { toast(err.message); } return; }

    const attendance = e.target.closest('[data-attendance]');
    if (attendance) return logAttendance(attendance.dataset.attendance);
    const hist = e.target.closest('[data-history]');
    if (hist) return history(hist.dataset.history);
    const details = e.target.closest('[data-details]');
    if (details) return openCaseDetails(details.dataset.details);

    const editYear = e.target.closest('[data-edit-year]');
    if (editYear) return openEditYear(editYear.dataset.editYear);
    const editSection = e.target.closest('[data-edit-section]');
    if (editSection) return openEditSection(editSection.dataset.editSection);
    const delSection = e.target.closest('[data-delete-section]');
    if (delSection) {
      if (!confirm('Delete this section? This cannot be undone.')) return;
      try { await del(`/api/sections/${delSection.dataset.deleteSection}`); await loadData(); go('sections'); toast('Section deleted'); } catch (err) { toast(err.message); }
      return;
    }

    const assign = e.target.closest('[data-assign]');
    if (assign) return openAssignSections(assign.dataset.assign);
    const toggleUser = e.target.closest('[data-toggle-user]');
    if (toggleUser) { try { await put(`/api/users/${toggleUser.dataset.toggleUser}/status`, { status: toggleUser.dataset.status }); await loadData(); renderAccounts(); toast('Account updated'); } catch (err) { toast(err.message); } return; }

    const togglePass = e.target.closest('[data-toggle-password]');
    if (togglePass) {
      e.preventDefault();
      const wrap = togglePass.closest('.password-wrap');
      const input = wrap ? wrap.querySelector('input') : null;
      if (input) { const isPw = input.type === 'password'; input.type = isPw ? 'text' : 'password'; togglePass.textContent = isPw ? 'Hide' : 'Show'; }
      return;
    }
  });

  document.addEventListener('change', async e => {
    const statusSel = e.target.closest('[data-case-status]');
    if (statusSel) { try { await patch(`/api/violations/${statusSel.dataset.caseStatus}`, { status: statusSel.value }); await loadData(); render(); toast('Case status updated'); } catch (err) { toast(err.message); } return; }

    const yearStatus = e.target.closest('[data-year-status]');
    if (yearStatus) {
      try {
        await put(`/api/years/${yearStatus.dataset.yearStatus}`, { is_active: yearStatus.value });
        await loadData();
        go('sections');
        toast('School year status updated');
      } catch (err) { toast(err.message); await loadData(); renderSections(); }
      return;
    }

    if (e.target && e.target.id === 'staffRequestRole') {
      populateSignupOptionsUI();
    }
  });
}

function attachAuthHandlers() {
  $('#setupForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await post('/api/auth/setup', d);
      me = r.user; e.target.reset(); await loadData(); showApp(); go('dashboard'); toast('Administrator account created');
    } catch (err) { toast(err.message); }
  });

  $('#loginForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await post('/api/auth/login', d);
      me = r.user; e.target.reset(); await loadData(); showApp(); go('dashboard');
    } catch (err) { toast(err.message); }
  });

  $('#registerForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await post('/api/auth/register-admin', d);
      e.target.reset();
      populateSignupOptionsUI();
      toast(r.message || 'Staff account request submitted for administrator approval.');
    } catch (err) { toast(err.message); }
  });
}

async function init() {
  attachClickHandlers();
  attachAuthHandlers();

  try {
    const status = await get('/api/auth/setup-status');
    if (!status.configured) {
      showGate();
      $('#setupForm')?.classList.remove('hidden');
      $('#loginForm')?.classList.add('hidden');
      $('#registerForm')?.classList.add('hidden');
      openAuthModal('setup');
      const msgEl = $('#authMsg'); if (msgEl) msgEl.textContent = 'Create the first administrator account to initialize the system.';
      return;
    }
    $('#setupForm')?.classList.add('hidden');
    switchAuthTab('login');
    try {
      const session = await get('/api/me');
      if (session?.user) { me = session.user; await loadData(); showApp(); await go('dashboard'); return; }
      if (session?.id) { me = session; await loadData(); showApp(); await go('dashboard'); return; }
    } catch (_) {}
  } catch (e) {
    console.error(e);
    const msgEl = $('#authMsg'); if (msgEl) msgEl.textContent = 'Unable to reach the server. Check that the backend is running.';
  }
  showGate();
}

init();
