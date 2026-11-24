const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let me = null;
let activeYear = null;
let sections = [];
let students = [];
let offenses = [];
let cases = [];
let service = [];
let years = [];
let users = [];
let pending = [];
let view = 'dashboard';
let academicConfig = { tracks: [], strands: [], enabled: false };
let academicConfigAll = { tracks: [], strands: [], enabled: false };
let violationFilters = { added_from: '', added_to: '', grade_level: '', section_id: '', track_id: '', strand_id: '', violation_type: '', service_status: '', search: '' };
let dashboardRecent = { items: [], total: 0 };
let calendarState = { month: new Date().toISOString().slice(0, 7), days: [], selectedDate: '', selectedItems: [] };

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

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}
function msg(el, m) { if (el) el.textContent = m; }
function initials(n) { return String(n || '').split(' ').map(x => x[0] || '').join('').slice(0, 2).toUpperCase() || '--'; }
function fmtDate(d) { if (!d) return '�'; const s = String(d).slice(0,10); const dt = new Date(s + 'T00:00:00'); return Number.isNaN(dt.getTime()) ? s : dt.toLocaleDateString(); }
function badge(s) {
  const cls = /complete|resolved|verified/i.test(s || '') ? 'complete'
    : /pending|assigned|reported|in_progress/i.test(s || '') ? 'pending'
    : /reject|suspend|serious/i.test(s || '') ? 'danger'
    : 'review';
  return `<span class="badge ${cls}">${esc(s || '�')}</span>`;
}
function hoursNum(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }
function isSHSGrade(g) { return ['11', '12', 11, 12].includes(String(g ?? '').trim()); }
function trackStrandEnabledForGrade(g) { return isSHSGrade(g) && !!academicConfig.enabled; }

function navItems() {
  return me.role === 'admin'
    ? [
        ['dashboard', '?', 'Dashboard'],
        ['violations', '?', 'Violation Records'],
        ['students', '?', 'Students'],
        ['community', '?', 'Community Service'],
        ['sections', '?', 'Sections & School Years'],
        ['accounts', '?', 'Accounts'],
        ['offenses', '?', 'Offense Catalog'],
        ['reports', '?', 'Reports']
      ]
    : [
        ['dashboard', '?', 'Dashboard'],
        ['violations', '?', 'Violation Records'],
        ['community', '?', 'Community Service']
      ];
}

function showApp() {
  $('#landing')?.classList.add('hidden');
  $('#authModal')?.classList.add('hidden');
  $('#app')?.classList.remove('hidden');
  if ($('#userName')) $('#userName').textContent = me?.full_name || 'User';
  if ($('#userRole')) {
    const labels = { admin: 'Administrator', teacher: 'Teacher', guidance_counselor: 'Guidance Counselor', class_adviser: 'Class Adviser', student: 'Student' };
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
function showGate() {
  $('#landing')?.classList.remove('hidden');
  $('#app')?.classList.add('hidden');
}

function filterParams(includePage = false) {
  const qs = new URLSearchParams();
  Object.entries(violationFilters).forEach(([k, v]) => { if (v !== '' && v != null) qs.set(k, v); });
  if (includePage) qs.set('limit', '200');
  return qs;
}
function activeFilterEntries() {
  const labels = {
    added_from: 'Added from', added_to: 'Added to', grade_level: 'Grade', section_id: 'Section',
    track_id: 'Track', strand_id: 'Strand', violation_type: 'Violation type', service_status: 'Service status', search: 'Search'
  };
  return Object.entries(violationFilters).filter(([, v]) => v !== '' && v != null).map(([k, v]) => {
    let display = v;
    if (k === 'section_id') display = sectionLabelById(v) || v;
    if (k === 'track_id') display = trackNameById(v) || v;
    if (k === 'strand_id') display = strandNameById(v) || v;
    if (k === 'violation_type') display = offenseNameById(v) || v;
    return { key: k, label: labels[k] || k, value: String(display) };
  });
}
function sectionLabelById(id) { const s = sections.find(x => String(x.id) === String(id)); return s ? `G${s.grade_level} � ${s.section_name}` : ''; }
function trackNameById(id) { const t = academicConfig.tracks.find(x => String(x.id) === String(id)); return t ? t.name : ''; }
function strandNameById(id) { const s = academicConfig.strands.find(x => String(x.id) === String(id)); return s ? s.name : ''; }
function offenseNameById(id) { const o = offenses.find(x => String(x.id) === String(id)); return o ? o.name : ''; }

async function loadAcademicConfig(all = false) {
  try {
    const cfg = await api('/api/academic/track-strand-config' + (all ? '?all=1' : ''));
    if (all) academicConfigAll = cfg || academicConfigAll; else academicConfig = cfg || academicConfig;
    // keep active config fresh even when loading all for admin management
    if (all) {
      try { academicConfig = await api('/api/academic/track-strand-config'); } catch {}
    }
  } catch {
    if (!all) academicConfig = { tracks: [], strands: [], enabled: false };
  }
}

async function loadRecentViolations() {
  const res = await api('/api/dashboard/recent-violations?' + filterParams(true).toString());
  cases = res.items || [];
  dashboardRecent = { items: res.items || [], total: res.total || 0, page: res.page || 1, limit: res.limit || 0 };
}

async function loadCalendar() {
  try {
    const qs = new URLSearchParams({ month: calendarState.month });
    ['grade_level','section_id','track_id','strand_id','service_status'].forEach(k => { if (violationFilters[k]) qs.set(k, violationFilters[k]); });
    const r = await api('/api/community-service/calendar?' + qs.toString());
    calendarState.days = r.days || [];
  } catch { calendarState.days = []; }
  if (calendarState.selectedDate) await loadCalendarDay(calendarState.selectedDate); else calendarState.selectedItems = [];
}
async function loadCalendarDay(date) {
  calendarState.selectedDate = date;
  try {
    const qs = new URLSearchParams();
    ['grade_level','section_id'].forEach(k => { if (violationFilters[k]) qs.set(k, violationFilters[k]); });
    const r = await api('/api/community-service/calendar/' + encodeURIComponent(date) + (qs.toString() ? ('?' + qs.toString()) : ''));
    calendarState.selectedItems = r.items || [];
  } catch { calendarState.selectedItems = []; }
}

async function loadData() {
  await loadAcademicConfig(me?.role === 'admin');
  [years] = await Promise.all([api('/api/years')]);
  activeYear = activeYear || years.find(y => y.is_active) || years[0] || null;
  sections = await api('/api/sections' + (activeYear ? '?year=' + activeYear.id : ''));
  students = await api('/api/students' + (activeYear ? '?year=' + activeYear.id : ''));
  offenses = await api('/api/offenses');
  try { await loadRecentViolations(); } catch { cases = await api('/api/violations'); dashboardRecent = { items: cases, total: cases.length }; }
  service = await api('/api/community-service');
  if (me.role === 'admin') {
    [users, pending] = await Promise.all([api('/api/users'), api('/api/admin/pending')]);
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
function filterChipsHtml() {
  const chips = activeFilterEntries();
  if (!chips.length) return '<div class="tiny muted">No active filters.</div>';
  return `<div class="filter-chips">${chips.map(c => `<span class="filter-chip">${esc(c.label)}: ${esc(c.value)}</span>`).join('')}</div>`;
}

function trackOptions(selected = '', includeBlank = true) {
  return `${includeBlank ? '<option value="">Not set</option>' : ''}${academicConfig.tracks.map(t => `<option value="${t.id}" ${String(selected)===String(t.id)?'selected':''}>${esc(t.name)} (${esc(t.code)})</option>`).join('')}`;
}
function strandOptions(selected = '', trackId = '', includeBlank = true) {
  const list = academicConfig.strands.filter(s => !trackId || String(s.track_id || '') === String(trackId));
  return `${includeBlank ? '<option value="">Not set</option>' : ''}${list.map(s => `<option value="${s.id}" ${String(selected)===String(s.id)?'selected':''}>${esc(s.name)} (${esc(s.code)})${s.track_name ? ' � ' + esc(s.track_name) : ''}</option>`).join('')}`;
}
function violationTypeOptions(selected = '') {
  return `<option value="">All violation types</option>${offenses.map(o => `<option value="${o.id}" ${String(selected)===String(o.id)?'selected':''}>${esc(o.name)} (${esc(o.severity)})</option>`).join('')}`;
}

function renderFilterForm(prefix = 'vf', options = {}) {
  const f = violationFilters;
  const showTrackStrand = !!academicConfig.enabled;
  const grade = String(f.grade_level || '');
  const tsRelevant = !grade || isSHSGrade(grade);
  return `
    <div class="filter-panel card">
      <div class="filter-grid">
        <label>Added from<input id="${prefix}From" type="date" value="${esc(f.added_from || '')}"></label>
        <label>Added to<input id="${prefix}To" type="date" value="${esc(f.added_to || '')}"></label>
        <label>Grade level<input id="${prefix}Grade" value="${esc(f.grade_level || '')}" placeholder="e.g. 11"></label>
        <label>Section<select id="${prefix}Section"><option value="">All sections</option>${sections.map(s => `<option value="${s.id}" ${String(f.section_id)===String(s.id)?'selected':''}>G${esc(s.grade_level)} � ${esc(s.section_name)}</option>`).join('')}</select></label>
        ${showTrackStrand ? `<label>Track<select id="${prefix}Track" ${tsRelevant ? '' : 'disabled'}><option value="">All tracks</option>${academicConfig.tracks.map(t => `<option value="${t.id}" ${String(f.track_id)===String(t.id)?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}
        ${showTrackStrand ? `<label>Strand<select id="${prefix}Strand" ${tsRelevant ? '' : 'disabled'}><option value="">All strands</option>${academicConfig.strands.map(s => `<option value="${s.id}" ${String(f.strand_id)===String(s.id)?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
        <label>Violation type<select id="${prefix}ViolationType">${violationTypeOptions(f.violation_type)}</select></label>
        <label>Service status<select id="${prefix}Service"><option value="">All statuses</option>${['none','pending','in_progress','completed'].map(s => `<option value="${s}" ${f.service_status===s?'selected':''}>${s.replace('_',' ')}</option>`).join('')}</select></label>
        <label>Search student/case<input id="${prefix}Search" value="${esc(f.search || '')}" placeholder="Student name, student ID, or case"></label>
      </div>
      <div class="filter-actions">
        <button class="primary" id="${prefix}Apply">Apply filters</button>
        <button class="ghost" id="${prefix}Reset">Reset filters</button>
        ${options.extraButtons || ''}
      </div>
      <div><div class="tiny muted" style="margin-bottom:6px">Active filters</div>${filterChipsHtml()}</div>
      <div class="tiny muted">Date filters are inclusive; "Added to" includes records through the end of that day. ${academicConfig.enabled ? 'Track/strand filters apply when configured (typically Grades 11�12).' : 'Track/strand filters are hidden because no active tracks/strands are configured.'}</div>
    </div>`;
}

function readFilterForm(prefix = 'vf') {
  violationFilters = {
    ...violationFilters,
    added_from: $(`#${prefix}From`)?.value || '',
    added_to: $(`#${prefix}To`)?.value || '',
    grade_level: ($(`#${prefix}Grade`)?.value || '').trim(),
    section_id: $(`#${prefix}Section`)?.value || '',
    track_id: $(`#${prefix}Track`)?.value || '',
    strand_id: $(`#${prefix}Strand`)?.value || '',
    violation_type: $(`#${prefix}ViolationType`)?.value || '',
    service_status: $(`#${prefix}Service`)?.value || '',
    search: ($(`#${prefix}Search`)?.value || '').trim()
  };
  if (violationFilters.grade_level && !isSHSGrade(violationFilters.grade_level)) {
    violationFilters.track_id = '';
    violationFilters.strand_id = '';
  }
}

function wireFilterForm(prefix = 'vf', rerender) {
  const apply = async () => { readFilterForm(prefix); try { await loadRecentViolations(); if (view === 'community') await loadCalendar(); rerender(); } catch (e) { toast(e.message); } };
  $(`#${prefix}Apply`) && ($(`#${prefix}Apply`).onclick = apply);
  $(`#${prefix}Reset`) && ($(`#${prefix}Reset`).onclick = async () => {
    violationFilters = { added_from: '', added_to: '', grade_level: '', section_id: '', track_id: '', strand_id: '', violation_type: '', service_status: '', search: '' };
    try { await loadRecentViolations(); if (view === 'community') await loadCalendar(); rerender(); } catch (e) { toast(e.message); }
  });
  $(`#${prefix}Grade`) && ($(`#${prefix}Grade`).oninput = () => {
    const g = $(`#${prefix}Grade`).value;
    const show = !g || isSHSGrade(g);
    if ($(`#${prefix}Track`)) $(`#${prefix}Track`).disabled = !show || !academicConfig.enabled;
    if ($(`#${prefix}Strand`)) $(`#${prefix}Strand`).disabled = !show || !academicConfig.enabled;
    if (!show) { if ($(`#${prefix}Track`)) $(`#${prefix}Track`).value = ''; if ($(`#${prefix}Strand`)) $(`#${prefix}Strand`).value = ''; }
  });
}

function render() {
  switch (view) {
    case 'dashboard': renderDashboard(); break;
    case 'violations': renderCases(); break;
    case 'students': renderStudents(); break;
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
  const assigned = service.length;
  let html = `<div class="grid">${cardKpi('Active students', students.length, 'Within selected school year')}${cardKpi('Violation cases', cases.length, 'Loaded records')}${cardKpi('Open / in progress', activeCases, 'Cases needing follow-up')}${cardKpi('Service assignments', assigned, `${complete} completed`)}</div>`;
  html += `<h2 class="section-title">Recent violations (advanced filter)</h2>`;
  html += renderFilterForm('dbf');
  const rows = (dashboardRecent.items || cases).slice(0, 10).map(c => `<tr><td>${esc(c.case_number)}</td><td>${esc((c.first_name||'')+' '+(c.last_name||''))}<div class="tiny muted">${esc(c.student_number||'')}</div></td><td>G${esc(c.grade_level||'')} � ${esc(c.section_name||'')}</td><td>${esc(c.offense||'')}</td><td>${badge(c.severity||'')}</td><td>${fmtDate(c.incident_date)}</td><td>${badge(c.status||'')}<div class="tiny muted">service: ${esc(c.service_status||'none')}</div></td></tr>`).join('');
  html += `<div style="height:12px"></div>${table(['Case no.','Student','Grade / Section','Offense','Severity','Date','Status'], rows)}`;
  if (me.role === 'admin') {
    html += `<h2 class="section-title">Administrator approvals</h2><div class="card"><p>${pending.length} pending administrator registration(s).</p><button class="primary smallbtn" data-view="accounts">Review accounts</button></div>`;
  }
  $('#content').innerHTML = html;
  wireFilterForm('dbf', renderDashboard);
}

function renderCases() {
  const rows = cases.map(c => {
    const remaining = Math.max(0, hoursNum(c.required_service_hours) - hoursNum(c.completed_service_hours));
    return `<tr>
      <td>${esc(c.case_number)}</td>
      <td>${esc((c.first_name || '') + ' ' + (c.last_name || ''))}${c.student_number ? `<div class="tiny muted">${esc(c.student_number)}</div>` : ''}</td>
      <td>G${esc(c.grade_level || '')} � ${esc(c.section_name || '')}</td>
      <td>${esc(c.offense || '')}${c.community_service_type ? `<div class="tiny muted">Service: ${esc(c.community_service_type)}</div>` : ''}</td>
      <td>${badge(c.severity || '')}</td>
      <td>${fmtDate(c.incident_date)}</td>
      <td>${badge(c.status || '')}<div class="tiny muted">service: ${esc(c.service_status || 'none')} � ${hoursNum(c.completed_service_hours).toFixed(2)}/${hoursNum(c.required_service_hours).toFixed(2)}h (rem ${remaining.toFixed(2)}h)</div></td>
      <td>${me.role === 'admin'
        ? `<select data-case-status="${c.id}">${['Reported','Under Review','Verified','Accepted','In Progress','Resolved','Closed','Rejected','Escalated'].map(x => `<option ${x===c.status?'selected':''}>${x}</option>`).join('')}</select><div style="height:6px"></div><button class="ghost smallbtn" data-details="${c.id}">Details</button>`
        : `<button class="ghost smallbtn" data-details="${c.id}">View</button>`}</td>
    </tr>`;
  }).join('');
  $('#content').innerHTML =
    pageHead('Violation records', `<div class="actions"><button class="ghost" id="exportViolationsXlsx">Export Violations XLSX</button><button class="ghost" id="exportServiceXlsx">Export Service XLSX</button>${me.role === 'admin' ? '<button class="primary" data-modal="recordCase">+ Record violation</button>' : ''}</div>`) +
    renderFilterForm('vf') +
    `<div style="height:12px"></div><div class="note">${me.role === 'admin' ? 'Only administrators can create or modify violation records. Violation records can include guardian snapshots and assigned community service (type/hours) with tracked completion.' : 'Teacher access is read-only for violation records. You may view assigned-section cases and their statuses.'}</div><div style="height:12px"></div>` +
    table(['Case no.','Student','Grade / Section','Offense / Service type','Severity','Date','Status / Service hours', me.role === 'admin' ? 'Actions' : 'Details'], rows);
  wireFilterForm('vf', renderCases);
  $('#exportViolationsXlsx') && ($('#exportViolationsXlsx').onclick = () => { window.location.href = '/api/exports/violations.xlsx?' + filterParams().toString(); });
  $('#exportServiceXlsx') && ($('#exportServiceXlsx').onclick = () => { window.location.href = '/api/exports/community-service.xlsx?' + filterParams().toString(); });
}

function renderStudents() {
  const rows = students.map(s => {
    const remainingViolations = cases.filter(c => String(c.student_id || '') === String(s.id) && hoursNum(c.required_service_hours) > hoursNum(c.completed_service_hours));
    return `<tr>
      <td>${esc(s.student_number || '�')}</td>
      <td>${esc((s.last_name||'') + ', ' + (s.first_name||''))}</td>
      <td>G${esc(s.grade_level || '')}</td>
      <td>${esc(s.section_name || '')}</td>
      <td>${esc(s.strand_name || s.section_strand_text || s.strand || '�')}</td>
      <td>${esc(s.guardian_name || '�')}${s.guardian_contact ? `<div class="tiny muted">${esc(s.guardian_contact)}</div>` : ''}</td>
      <td>${remainingViolations.length ? `<span class="badge pending">${remainingViolations.length} with remaining service</span>` : badge('OK')}</td>
      <td>${me.role === 'admin' ? `<div class="actions"><button class="ghost smallbtn" data-student-edit="${s.id}">Edit</button><button class="primary smallbtn" data-student-reassign="${s.id}">Reassign</button></div>` : '�'}</td>
    </tr>`;
  }).join('');

  const bulkPanel = me.role === 'admin' ? `
    <div class="card">
      <h3 style="margin-top:0">Bulk section reassignment</h3>
      <div class="filter-grid">
        <label>Students<select id="bulkStudentIds" multiple size="8">${students.map(s => `<option value="${s.id}">${esc((s.last_name||'')+', '+(s.first_name||''))} � G${esc(s.grade_level||'')} ${esc(s.section_name||'')}</option>`).join('')}</select></label>
        <label>Target section<select id="bulkTargetSection"><option value="">Select section</option>${sections.map(sec => `<option value="${sec.id}" data-grade="${esc(sec.grade_level||'')}" data-track-id="${esc(sec.track_id||'')}" data-strand-id="${esc(sec.strand_id||'')}">G${esc(sec.grade_level)} � ${esc(sec.section_name)}${sec.school_year ? ' � ' + esc(sec.school_year) : ''}</option>`).join('')}</select></label>
        <label>Grade override (optional)<input id="bulkGrade" placeholder="Defaults from section/student"></label>
        <label>Track (optional)<select id="bulkTrack"><option value="">Use section/default</option>${trackOptions('', false)}</select></label>
        <label>Strand (optional)<select id="bulkStrand"><option value="">Use section/default</option>${strandOptions('', '', false)}</select></label>
        <label class="span-2">Reason<textarea id="bulkReason" rows="2" placeholder="Optional reassignment reason"></textarea></label>
      </div>
      <div class="filter-actions" style="margin-top:10px"><button class="primary" id="bulkReassignBtn">Reassign selected students</button></div>
      <p class="tiny muted">Flexible reassignment preserves violation and community service records, logs section assignment history, and can apply target section grade/track/strand defaults (including Grade 11�12 strand changes when configured).</p>
    </div><div style="height:12px"></div>` : '';

  $('#content').innerHTML =
    pageHead('Student records', me.role === 'admin' ? `<button class="primary" data-modal="student">+ Add student</button>` : '') +
    `<div class="note">Student records include guardian and track/strand fields (when applicable). Admins can reassign students individually or in bulk at any time; section assignment history is retained and existing violation/service records are preserved.</div><div style="height:12px"></div>` +
    bulkPanel +
    table(['Student no.','Name','Grade','Section','Strand','Guardian','Service','Actions'], rows);

  if (me.role === 'admin') {
    $('#bulkReassignBtn') && ($('#bulkReassignBtn').onclick = async () => {
      const sel = $('#bulkStudentIds');
      const ids = sel ? [...sel.selectedOptions].map(o => Number(o.value)).filter(Boolean) : [];
      const sectionId = Number($('#bulkTargetSection')?.value || 0);
      if (!ids.length || !sectionId) return toast('Select at least one student and a target section.');
      const body = { student_ids: ids, section_id: sectionId, reason: $('#bulkReason')?.value || '' };
      if ($('#bulkGrade')?.value) body.grade_level = $('#bulkGrade').value.trim();
      if ($('#bulkTrack')?.value) body.track_id = Number($('#bulkTrack').value);
      if ($('#bulkStrand')?.value) body.strand_id = Number($('#bulkStrand').value);
      try {
        const r = await post('/api/students/bulk-reassign', body);
        const ok = (r.results || []).filter(x => x.ok).length;
        const fail = (r.results || []).length - ok;
        await loadData();
        renderStudents();
        toast(`Bulk reassignment complete: ${ok} moved${fail ? `, ${fail} failed` : ''}.`);
        if (fail) console.warn('Bulk reassignment failures', r.results);
      } catch (e) { toast(e.message); }
    });
  }
}

function renderSections() {
  const yearRows = years.map(y => `<tr><td>${esc(y.label)}</td><td>${y.is_active ? badge('Active') : badge('Inactive')}</td><td>${y.archived_at ? fmtDate(String(y.archived_at).slice(0,10)) : '�'}</td><td class="actions">${!y.is_active ? `<button class="primary smallbtn" data-activate-year="${y.id}">Set active</button>` : ''}</td></tr>`).join('');
  const secRows = sections.map(s => `<tr><td>G${esc(s.grade_level)}</td><td>${esc(s.section_name)}</td><td>${esc(s.track_name || '�')} / ${esc(s.strand_name || s.strand || '�')}</td><td>${esc(s.school_year || s.school_year_label || '')}</td><td class="actions"><button class="ghost smallbtn" data-edit-section="${s.id}">Edit</button><button class="ghost smallbtn" data-delete-section="${s.id}">Delete</button></td></tr>`).join('');

  const cfg = academicConfigAll.tracks?.length || academicConfigAll.strands?.length || me.role === 'admin' ? academicConfigAll : academicConfig;
  const trackRows = (cfg.tracks || []).map(t => `<tr><td>${esc(t.code)}</td><td>${esc(t.name)}</td><td>${t.is_active ? badge('Active') : badge('Inactive')}</td><td>${me.role==='admin'?`<button class="ghost smallbtn" data-edit-track="${t.id}">Edit</button>`:'�'}</td></tr>`).join('');
  const strandRows = (cfg.strands || []).map(s => `<tr><td>${esc(s.code)}</td><td>${esc(s.name)}</td><td>${esc(s.track_name || '�')}</td><td>${s.is_active ? badge('Active') : badge('Inactive')}</td><td>${me.role==='admin'?`<button class="ghost smallbtn" data-edit-strand="${s.id}">Edit</button>`:'�'}</td></tr>`).join('');

  const academicPanel = me.role === 'admin' ? `
    <div class="card" style="margin-top:15px">
      <div class="page-head"><h3 style="margin:0">Dynamic Tracks & Strands (Grades 11�12, optional)</h3><div class="actions"><button class="primary smallbtn" data-modal="track">+ Add track</button><button class="primary smallbtn" data-modal="strand">+ Add strand</button></div></div>
      <p class="tiny muted">Configuration is optional. When no active tracks/strands are configured, Grade 11�12 forms/filters allow saving without track/strand and selectors can be hidden. Grades 7�10 do not use track/strand. Changes reflect across enrollment, profiles, filters, and reports after refresh in-app (no redeploy).</p>
      <div class="two-col" style="margin-top:12px">
        <div>${table(['Code','Track','Status','Actions'], trackRows || `<tr><td colspan="4" class="empty">No tracks configured.</td></tr>` )}</div>
        <div>${table(['Code','Strand','Track','Status','Actions'], strandRows || `<tr><td colspan="5" class="empty">No strands configured.</td></tr>` )}</div>
      </div>
    </div>` : '';

  $('#content').innerHTML =
    `<div class="card"><div class="inline-form"><label style="margin:0;min-width:220px;flex:1">View sections for school year<select id="yearFilter">${years.map(y => `<option value="${y.id}" ${y.id === activeYear?.id ? 'selected' : ''}>${esc(y.label)}</option>`).join('')}</select></label><div class="filter-actions">${me.role==='admin'?'<button class="primary" data-modal="year">+ Add school year</button><button class="primary" data-modal="section">+ Add section</button>':''}</div></div></div>` +
    `<div style="height:15px"></div><div class="two-col"><div>${pageHead('School years', '')}${table(['School year','Status','Archived','Action'], yearRows)}</div><div>${pageHead('Flexible sections', '')}${table(['Grade','Section','Track / Strand','School year','Actions'], secRows)}</div></div>` +
    academicPanel +
    `<p class="note">Sections are defined per school year and may include track/strand for Grades 11�12 when configured. Current section assignments are reflected in student records, violation views, and exports.</p>`;
  $('#yearFilter') && ($('#yearFilter').onchange = async () => {
    const id = Number($('#yearFilter').value);
    activeYear = years.find(y => y.id === id) || activeYear;
    try { await loadData(); } catch (e) { toast(e.message); }
    renderSections();
  });
}

function renderAccounts() {
  const roleName = r => ({admin:'Administrator',teacher:'Teacher',student:'Student',guidance_counselor:'Guidance Counselor',class_adviser:'Class Adviser'}[r] || r || '');
  const pendingRows = pending.map(p => {
    const reqSec = p.role === 'class_adviser' && (p.requested_section_name || p.requested_school_year)
      ? `<div class="tiny muted">${esc(p.requested_school_year || '')} · Grade ${esc(p.requested_section_grade || '')} ${esc(p.requested_section_name || '')}</div>`
      : '';
    return `<tr><td>${esc(p.full_name)}</td><td>${esc(p.email || '—')}</td><td>${esc(roleName(p.role))}${reqSec}</td><td>${fmtDate((p.created_at||'').slice(0,10))}</td><td class="actions"><button class="primary smallbtn" data-approve="${p.id}">Approve</button><button class="ghost smallbtn" data-reject="${p.id}">Reject</button></td></tr>`;
  }).join('');
  const userRows = users.map(u => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email || '—')}</td><td>${esc(roleName(u.role))}</td><td>${badge(u.status)}</td><td>${(u.role === 'teacher' || u.role === 'guidance_counselor' || u.role === 'class_adviser') ? `<button class="primary smallbtn" data-assign="${u.id}">Sections</button> ` : ''}${u.id === me.id ? 'Current account' : `<button class="ghost smallbtn" data-toggle-user="${u.id}" data-status="${u.status === 'suspended' ? 'verified' : 'suspended'}">${u.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button>`}</td></tr>`).join('');
  $('#content').innerHTML =
    pageHead('Account management', '<div class="actions"><button class="primary" data-modal="teacher">+ Create teacher</button><button class="primary" data-modal="staffUser">+ Create staff account</button></div>') +
    `<h2 class="section-title">Pending staff account requests (approved by another admin)</h2>${table(['Name','Email','Requested role','Requested','Review'], pendingRows)}` +
    `<h2 class="section-title">System accounts</h2>${table(['Name','Email','Role','Status','Action'], userRows)}` +
    `<p class="note">Student sign-up does not require email. Administrator, Guidance Counselor, and Class Adviser accounts can request access and must be approved by an existing administrator. Class Adviser requests/accounts are limited to one section per school year (one adviser account per section; creating a new section/school year allows a new adviser for that section). Teacher accounts are created by verified administrators and may be assigned to one section only.</p>`;
}

function renderOffenses() {
  const rows = offenses.map(o => `<tr><td>${esc(o.name)}</td><td>${badge(o.severity)}</td><td>${esc(o.description || '')}</td></tr>`).join('');
  $('#content').innerHTML = pageHead('Offense catalog', me.role==='admin'?'<button class="primary" data-modal="offense">+ Add offense</button>':'') + table(['Offense','Severity','Description'], rows);
}

function renderReports() {
  const rows = cases.map(c => `<tr><td>${esc(c.case_number)}</td><td>${esc((c.first_name||'')+' '+(c.last_name||''))}</td><td>${esc(c.student_number||'')}</td><td>G${esc(c.grade_level||'')}</td><td>${esc(c.section_name||'')}</td><td>${esc(c.offense||'')}</td><td>${badge(c.status||'')}</td><td>${esc(c.service_status||'none')}</td></tr>`).join('');
  $('#content').innerHTML =
    pageHead('Reports & summaries', '<div class="actions"><button class="primary" id="exportFilteredViolations">Export filtered violations XLSX</button><button class="ghost" id="exportFilteredService">Export filtered service XLSX</button></div>') +
    renderFilterForm('rf') +
    `<div style="height:12px"></div>${table(['Case','Student','Student no.','Grade','Section','Offense','Status','Service status'], rows)}` +
    `<p class="note">Reports and exports reflect current section assignments and active filters/selections.</p>`;
  wireFilterForm('rf', renderReports);
  $('#exportFilteredViolations') && ($('#exportFilteredViolations').onclick = () => { window.location.href = '/api/exports/violations.xlsx?' + filterParams().toString(); });
  $('#exportFilteredService') && ($('#exportFilteredService').onclick = () => { window.location.href = '/api/exports/community-service.xlsx?' + filterParams().toString(); });
}

function monthLabel(ym) {
  const d = new Date(ym + '-01T00:00:00');
  return Number.isNaN(d.getTime()) ? ym : d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}
function shiftMonth(ym, delta) {
  const d = new Date(ym + '-01T00:00:00');
  if (Number.isNaN(d.getTime())) return ym;
  d.setMonth(d.getMonth() + delta);
  return d.toISOString().slice(0, 7);
}

function renderService() {
  const daysMap = new Map(calendarState.days.map(d => [String(d.service_date).slice(0,10), d]));
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
    cells.push(`<button type="button" class="calendar-day ${info ? 'has-logs' : ''}${selected}" data-calendar-day="${date}"><div class="day-num">${day}</div><div class="meta">${info ? `${hoursNum(info.total_hours).toFixed(2)}h � ${info.student_count||0} student(s)<br>${info.log_count||0} log(s)` : 'No attendance logged'}</div></button>`);
  }

  const detailRows = (calendarState.selectedItems || []).map(l => {
    const remaining = Math.max(0, hoursNum(l.required_service_hours) - hoursNum(l.completed_service_hours));
    return `<tr><td>${esc((l.last_name||'')+', '+(l.first_name||''))}<div class="tiny muted">${esc(l.student_number||'')} � G${esc(l.grade_level||'')} ${esc(l.section_name||'')}</div></td><td>${esc(l.case_number || '�')}</td><td>${hoursNum(l.hours_rendered).toFixed(2)}</td><td>${hoursNum(l.completed_service_hours).toFixed(2)} / ${hoursNum(l.required_service_hours).toFixed(2)}<div class="tiny muted">Remaining: ${remaining.toFixed(2)}h � ${esc(l.service_status||'none')}</div></td><td>${esc(l.remarks || '�')}</td><td>${esc(l.verified_by_name || '�')}</td><td><button class="ghost smallbtn" data-edit-service-log="${l.id}">Edit</button></td></tr>`;
  }).join('');

  const assignmentRows = service.map(c => {
    const pct = c.hours_required ? Math.min(100, Math.round((Number(c.hours_completed||0) / Number(c.hours_required||1)) * 100)) : (c.service_days_required ? Math.min(100, Math.round((Number(c.days_completed||0) / Number(c.service_days_required||1)) * 100)) : 0);
    return `<tr><td>${esc(c.first_name + ' ' + c.last_name)}</td><td>G${esc(c.grade_level)} � ${esc(c.section_name)}</td><td>${esc(c.case_number || 'Standalone')}</td><td>${c.days_completed}/${c.service_days_required} days</td><td>${Number(c.hours_completed||0).toFixed(1)}/${c.hours_required} hours</td><td><div class="progress"><span style="width:${pct}%"></span></div>${pct}%</td><td>${badge(c.status)}</td><td><div class="actions"><button class="primary smallbtn" data-attendance="${c.id}">Log day</button><button class="ghost smallbtn" data-history="${c.id}">History</button></div></td></tr>`;
  }).join('');

  $('#content').innerHTML =
    pageHead('Community service attendance (calendar preview)', `<div class="actions"><button class="ghost" id="exportServiceXlsxCal">Export service XLSX</button>${me.role==='admin'?'<button class="primary" data-modal="service">+ Assign service (tracker)</button>':''}</div>`) +
    `<div class="note">Interactive calendar view shows logged community service by date (from violation-linked service logs). Inspect who rendered service on a day, log/update rendered hours, and track cumulative hours toward each violation's required service. Teachers/admins can log for students in allowed sections.</div><div style="height:12px"></div>` +
    renderFilterForm('csf', { extraButtons: `<button class="ghost" id="csLogToday">Log hours for selected date</button>` }) +
    `<div style="height:12px"></div><div class="split-panels">
      <div class="card calendar-wrap">
        <div class="calendar-header">
          <div class="actions"><button class="ghost" id="calPrev">?</button><button class="ghost" id="calToday">Today</button><button class="ghost" id="calNext">?</button></div>
          <strong>${esc(monthLabel(ym))}</strong>
          <div class="tiny muted">Click a day to inspect attendance and remaining hours.</div>
        </div>
        <div class="calendar-weekdays"><div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div></div>
        <div class="calendar-grid">${cells.join('')}</div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Attendance on ${esc(calendarState.selectedDate || 'selected date')}</h3>
        ${calendarState.selectedDate ? `<div class="tiny muted" style="margin-bottom:10px">Students who rendered service on this date, with cumulative progress toward required hours.</div>${table(['Student','Case','Rendered (day)','Completed / Required','Remarks','Verified by','Actions'], detailRows)}` : '<p class="muted">Select a date on the calendar to view attendance logs and remaining hours.</p>'}
        <div style="height:10px"></div><button class="primary" id="logServiceHoursBtn" ${calendarState.selectedDate ? '' : 'disabled'}>Log/update hours for this date</button>
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

function serviceLogCandidates() {
  // Prefer violations with service required/pending/in_progress/completed for logging; include all students as fallback.
  const byStudent = new Map(students.map(s => [String(s.id), s]));
  const items = [];
  cases.forEach(c => {
    const sid = c.student_id || students.find(s => `${s.first_name} ${s.last_name}` === `${c.first_name} ${c.last_name}` && String(s.student_number||'') === String(c.student_number||''))?.id;
    items.push({
      violation_id: c.id,
      student_id: sid || '',
      label: `${c.case_number} � ${(c.first_name||'')+' '+(c.last_name||'')} � req ${hoursNum(c.required_service_hours).toFixed(2)}h / done ${hoursNum(c.completed_service_hours).toFixed(2)}h (${c.service_status||'none'})`
    });
  });
  return { items, byStudent };
}

function openLogServiceModal(date, existing = null) {
  const selectedDate = date || calendarState.selectedDate || new Date().toISOString().slice(0,10);
  const candidateOptions = cases.map(c => {
    const student = students.find(s => String(s.student_number||'') === String(c.student_number||'') && String(s.last_name||'') === String(c.last_name||'') && String(s.first_name||'') === String(c.first_name||'')) || students.find(s => String(s.id) === String(c.student_id || ''));
    const studentId = student ? student.id : '';
    const label = `${c.case_number} � ${(c.first_name||'')+' '+(c.last_name||'')} � ${c.student_number||'no#'} � req ${hoursNum(c.required_service_hours).toFixed(2)}h / done ${hoursNum(c.completed_service_hours).toFixed(2)}h (${c.service_status||'none'})`;
    const selected = existing ? String(existing.violation_id||'') === String(c.id) : false;
    return `<option value="${c.id}" data-student-id="${studentId}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const studentOptions = students.map(s => `<option value="${s.id}" ${String(existing?.student_id||'')===String(s.id)?'selected':''}>${esc((s.last_name||'')+', '+(s.first_name||''))} � ${esc(s.student_number||'no #')} � G${esc(s.grade_level||'')} ${esc(s.section_name||'')}</option>`).join('');
  const title = existing ? 'Update community service log' : 'Log community service hours';
  const m = modal(title, `
    <form id="modalForm">
      <label>Service date<input name="service_date" type="date" value="${esc(String(existing?.service_date || selectedDate).slice(0,10))}" required></label>
      <label>Violation/case (recommended)<select name="violation_id" id="logViolationId"><option value="">No violation link</option>${candidateOptions}</select></label>
      <label>Student<select name="student_id" id="logStudentId" required>${studentOptions}</select></label>
      <label>Hours rendered<input name="hours_rendered" type="number" min="0" step="0.25" value="${esc(existing ? existing.hours_rendered : '1')}" required></label>
      <label>Remarks<textarea name="remarks">${esc(existing?.remarks || '')}</textarea></label>
    </form>
    <p class="tiny muted">Rendered hours cannot be negative. If linked to a violation, the system recalculates completed hours and service status (completed when completed hours meet or exceed required hours; over-cap hours are allowed).</p>
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

function modal(title, body) {
  const old = $('.modal-bg');
  if (old) old.remove();
  const b = document.createElement('div');
  b.className = 'modal-bg';
  b.innerHTML = `<div class="modal"><h2>${title}</h2>${body}<div class="modal-footer"><button class="ghost" data-close>Cancel</button><button class="primary" id="modalSubmit">Save</button></div></div>`;
  document.body.appendChild(b);
  b.addEventListener('click', e => { if (e.target === b || e.target.closest('[data-close]')) b.remove(); });
  return b;
}
function opt(list, value, label) { return list.map(x => `<option value="${x[value]}">${esc(x[label])}</option>`).join(''); }

function gradeTrackStrandFields(prefix, gradeVal = '', trackVal = '', strandVal = '') {
  const show = isSHSGrade(gradeVal) && academicConfig.enabled;
  if (!show) return `<div class="tiny muted" id="${prefix}TsNote">Track/strand applies to Grades 11�12 only when configured by admin.</div>`;
  return `
    <label>Track<select name="track_id" id="${prefix}Track"><option value="">Not set</option>${trackOptions(trackVal, false)}</select></label>
    <label>Strand<select name="strand_id" id="${prefix}Strand"><option value="">Not set</option>${strandOptions(strandVal, trackVal, false)}</select></label>`;
}
function wireGradeTrackStrand(form, prefix, initial = {}) {
  const gradeEl = form.querySelector('[name="grade"], [name="grade_level"]');
  const containerId = `${prefix}TsContainer`;
  const renderTs = (preserve = false) => {
    const g = gradeEl ? gradeEl.value : (initial.grade || '');
    const cont = form.querySelector('#' + containerId);
    if (!cont) return;
    const currentTrack = preserve ? (form.querySelector(`#${prefix}Track`)?.value || '') : (initial.track_id || '');
    const currentStrand = preserve ? (form.querySelector(`#${prefix}Strand`)?.value || '') : (initial.strand_id || '');
    cont.innerHTML = gradeTrackStrandFields(prefix, g, currentTrack, currentStrand);
    const trackSel = form.querySelector(`#${prefix}Track`);
    const strandSel = form.querySelector(`#${prefix}Strand`);
    if (trackSel && strandSel) {
      trackSel.onchange = () => {
        const t = trackSel.value;
        strandSel.innerHTML = `<option value="">Not set</option>${strandOptions('', t, false)}`;
      };
    }
  };
  if (gradeEl) gradeEl.addEventListener('input', () => renderTs(true));
  renderTs(false);
}

function openModal(kind, id) {
  let m, submit;
  switch (kind) {
    case 'year':
      m = modal('Add school year', `<form id="modalForm"><label>School year label<input name="label" placeholder="2026-2027" required></label></form>`);
      submit = async d => { await post('/api/years', { label: d.label }); await loadData(); go('sections'); };
      break;

    case 'section':
      m = modal('Create section', `<form id="modalForm">
        <label>School year<select name="yearId" required>${opt(years, 'id', 'label')}</select></label>
        <label>Grade level<input name="grade" placeholder="7-12" required></label>
        <label>Section name<input name="name" required></label>
        <div id="secTsContainer"></div>
        <label>Strand label (optional text)<input name="strand" placeholder="Legacy/display label"></label>
        <label>School year label (optional override)<input name="school_year" placeholder="Defaults to selected school year"></label>
      </form><p class="tiny muted">Track/strand selectors appear only for Grades 11�12 when active tracks/strands are configured. Grades 7�10 do not require them.</p>`);
      wireGradeTrackStrand($('#modalForm'), 'sec');
      submit = async d => { await post('/api/sections', d); await loadData(); go('sections'); };
      break;

    case 'teacher':
      m = modal('Create teacher account', `<form id="modalForm">
        <label>Full name<input name="name" required></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Temporary password (10+ characters)<div class="password-wrap"><input name="password" type="password" minlength="10" required><button type="button" class="toggle-pass" data-toggle-password>Show</button></div></label>
        <label>Assigned section (teachers can be assigned to one section only)<select name="section_id" required><option value="">Select section</option>${opt(sections, 'id', 'section_name')}</select></label>
        <p class="tiny muted">Teachers have section-scoped access and can be assigned to only one section. Email is required.</p>
      </form>`);
      submit = async d => { await post('/api/teachers', d); await loadData(); go('accounts'); };
      break;

    case 'staffUser':
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
        <label id="staffSectionLabel">Assigned section<select name="section_id" id="staffSectionSelect"><option value="">Select section (optional for Administrator/Guidance Counselor)</option>${sections.map(s => `<option value="${s.id}">${esc((s.school_year||'') + (s.school_year?' · ':'') + 'Grade ' + (s.grade_level||'') + ' ' + (s.section_name||''))}</option>`).join('')}</select></label>
        <p class="tiny muted">Teacher and Class Adviser accounts require exactly one section. Each section can have only one Class Adviser account per school year; creating a new section/school year allows creating a new Class Adviser for it.</p>
      </form><p class="tiny muted">Email is required for staff accounts. Teachers can be assigned to one section only.</p>`);
      const staffRoleSel = $('#staffRoleSelect');
      const staffSecSel = $('#staffSectionSelect');
      const syncStaffSectionReq = () => {
        const isTeacher = staffRoleSel?.value === 'teacher';
        if (staffSecSel) {
          staffSecSel.required = isTeacher;
          staffSecSel.innerHTML = `<option value="">${isTeacher ? 'Select section (required for teachers)' : 'Select section (optional)'}</option>${opt(sections, 'id', 'section_name')}`;
        }
      };
      staffRoleSel?.addEventListener('change', syncStaffSectionReq);
      syncStaffSectionReq();
      submit = async d => { await post('/api/staff/users', d); await loadData(); go('accounts'); };
      break;

    case 'offense':
      m = modal('Add offense category', `<form id="modalForm"><label>Offense name<input name="name" required></label><label>Severity<select name="severity"><option>Minor</option><option>Major</option><option>Serious</option></select></label><label>Description<textarea name="description"></textarea></label></form>`);
      submit = async d => { await post('/api/offenses', d); await loadData(); go('offenses'); };
      break;

    case 'student':
      m = modal('Add student record', `<form id="modalForm">
        <label>Student number<input name="number" required></label>
        <label>First name<input name="first" required></label>
        <label>Last name<input name="last" required></label>
        <label>Grade<input name="grade" required></label>
        <label>Section<select name="sectionId" id="studentSectionSelect" required>${sections.map(s => `<option value="${s.id}" data-grade="${esc(s.grade_level||'')}" data-track-id="${esc(s.track_id||'')}" data-strand-id="${esc(s.strand_id||'')}">G${esc(s.grade_level)} � ${esc(s.section_name)}</option>`).join('')}</select></label>
        <div id="stuTsContainer"></div>
        <label>Guardian name<input name="guardian_name"></label>
        <label>Guardian contact<input name="guardian_contact"></label>
      </form><p class="tiny muted">Track/strand fields are shown for Grades 11�12 only when configured and enabled by admin.</p>`);
      wireGradeTrackStrand($('#modalForm'), 'stu');
      submit = async d => { await post('/api/students', d); await loadData(); go('students'); };
      break;

    case 'recordCase': {
      const studentOptions = students.map(x => `<option value="${x.id}" data-guardian-name="${esc(x.guardian_name||'')}" data-guardian-contact="${esc(x.guardian_contact||'')}">${esc((x.last_name||'') + ', ' + (x.first_name||'') + ' � G' + (x.grade_level||'') + ' ' + (x.section_name||'') + (x.student_number ? ' � ' + x.student_number : ''))}</option>`).join('');
      m = modal('Record violation', `<form id="modalForm">
        <label>Case number<input name="caseNumber" placeholder="SV-2026-0001" required></label>
        <label>Student<select name="studentId" id="caseStudentId" required><option value="">Select student</option>${studentOptions}</select></label>
        <label>Offense<select name="offenseId" required>${opt(offenses,'id','name')}</select></label>
        <label>Incident date<input name="date" type="date" required></label>
        <label>Time<input name="time" type="time"></label>
        <label>Location<input name="location"></label>
        <label>Description<textarea name="description"></textarea></label>
        <label>Evidence notes<textarea name="evidence"></textarea></label>
        <hr>
        <label>Guardian name (snapshot)<input name="guardian_name" id="caseGuardianName" placeholder="Defaults to student profile if blank"></label>
        <label>Guardian contact (snapshot)<input name="guardian_contact" id="caseGuardianContact" placeholder="Defaults to student profile if blank"></label>
        <label>Community service task/type<input name="community_service_type" placeholder="e.g. Campus cleanup"></label>
        <label>Required service hours<input name="required_service_hours" id="caseReqHours" type="number" min="0" step="0.25" value="0"></label>
        <label>Completed service hours<input name="completed_service_hours" id="caseDoneHours" type="number" min="0" step="0.25" value="0"></label>
        <div class="tiny muted" id="caseHoursInfo">Remaining: 0.00h � Status: none (0 required hours)</div>
      </form><p class="tiny muted">Guardian fields auto-populate from the selected student profile when available but can be overridden. Negative hours are rejected. Over-cap completed hours are allowed and status becomes completed when completed = required (and required &gt; 0).</p>`);
      const updateHoursInfo = () => {
        const req = Math.max(0, Number($('#caseReqHours')?.value || 0));
        const done = Math.max(0, Number($('#caseDoneHours')?.value || 0));
        const remaining = Math.max(0, req - done);
        const status = req <= 0 ? 'none' : (done >= req ? 'completed' : (done > 0 ? 'in_progress' : 'pending'));
        const el = $('#caseHoursInfo'); if (el) el.textContent = `Remaining: ${remaining.toFixed(2)}h � Status: ${status}`;
      };
      $('#caseStudentId') && ($('#caseStudentId').onchange = () => {
        const optSel = $('#caseStudentId').selectedOptions[0];
        if (!optSel) return;
        if ($('#caseGuardianName') && !$('#caseGuardianName').dataset.touched) $('#caseGuardianName').value = optSel.dataset.guardianName || '';
        if ($('#caseGuardianContact') && !$('#caseGuardianContact').dataset.touched) $('#caseGuardianContact').value = optSel.dataset.guardianContact || '';
      });
      ['caseGuardianName','caseGuardianContact'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', () => el.dataset.touched = '1'); });
      ['caseReqHours','caseDoneHours'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', updateHoursInfo); });
      updateHoursInfo();
      submit = async d => { await post('/api/violations', d); await loadData(); go('violations'); };
      break;
    }

    case 'service':
      m = modal('Assign community service (tracker)', `<form id="modalForm"><label>Student<select name="studentId" required>${students.map(x => `<option value="${x.id}">${esc((x.last_name||'')+', '+(x.first_name||'')+' � G'+(x.grade_level||'')+' '+(x.section_name||''))}</option>`).join('')}</select></label><label>School year<select name="yearId" required>${opt(years,'id','label')}</select></label><label>Required service days<input name="days" type="number" min="0" value="1"></label><label>Required hours<input name="hours" type="number" min="0" step="0.5" value="2"></label><label>Start date<input name="startDate" type="date"></label><label>Due date<input name="dueDate" type="date"></label><label>Notes<textarea name="notes"></textarea></label></form>`);
      submit = async d => { await post('/api/community-service', d); await loadData(); go('community'); };
      break;

    case 'track':
      m = modal('Add track', `<form id="modalForm"><label>Code<input name="code" required></label><label>Name<input name="name" required></label><label>Status<select name="is_active"><option value="1">Active</option><option value="0">Inactive</option></select></label></form>`);
      submit = async d => { await post('/api/academic/tracks', { ...d, is_active: d.is_active === '1' }); await loadAcademicConfig(true); await loadData(); go('sections'); };
      break;

    case 'strand':
      m = modal('Add strand', `<form id="modalForm"><label>Code<input name="code" required></label><label>Name<input name="name" required></label><label>Track<select name="track_id"><option value="">No track</option>${trackOptions('', false)}</select></label><label>Status<select name="is_active"><option value="1">Active</option><option value="0">Inactive</option></select></label></form>`);
      submit = async d => { await post('/api/academic/strands', { ...d, track_id: d.track_id || null, is_active: d.is_active === '1' }); await loadAcademicConfig(true); await loadData(); go('sections'); };
      break;
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
  const item = service.find(s => String(s.id) === String(id));
  if (!item) return toast('Service assignment not found.');
  const m = modal('Log attendance day', `<form id="modalForm"><label>Date<input name="date" type="date" required></label><label>Days earned<input name="dayCompleted" type="number" min="0" step="0.5" value="1"></label><label>Hours earned<input name="hours" type="number" min="0" step="0.5" value="1"></label><label>Notes<textarea name="notes"></textarea></label></form>`);
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f.reportValidity()) return;
    try { await post(`/api/community-service/${id}/attendance`, Object.fromEntries(new FormData(f).entries())); m.remove(); await loadData(); go('community'); toast('Attendance logged'); } catch (e) { toast(e.message); }
  };
}

async function history(id) {
  try {
    const h = await get(`/api/community-service/${id}/attendance`);
    modal('Attendance history', h.length ? table(['Date','Days','Hours','Status','Notes'], h.map(x => `<tr><td>${fmtDate(x.attendance_date)}</td><td>${x.days_earned}</td><td>${x.hours_earned}</td><td>${badge(x.status)}</td><td>${esc(x.notes || '')}</td></tr>`)) : '<p class="muted">No attendance records yet.</p>');
    const sb = m.querySelector('#modalSubmit'); if (sb) sb.style.display = 'none';
  } catch (e) { toast(e.message); }
}

function openCaseDetails(id) {
  const item = cases.find(c => String(c.id) === String(id));
  if (!item) return toast('Case not found.');
  const remaining = Math.max(0, hoursNum(item.required_service_hours) - hoursNum(item.completed_service_hours));
  const body = `
    <p><strong>Student:</strong> ${esc(item.first_name||'')} ${esc(item.last_name||'')} (${esc(item.student_number||'�')})</p>
    <p><strong>Section:</strong> G${esc(item.grade_level||'')} � ${esc(item.section_name||'')} ${item.strand_name || item.section_strand_text || item.student_strand_name ? `� ${esc(item.strand_name || item.section_strand_text || item.student_strand_name)}` : ''}</p>
    <p><strong>Offense:</strong> ${esc(item.offense||'')} <span class="tiny muted">(${esc(item.severity||'')})</span></p>
    <p><strong>Incident:</strong> ${fmtDate(item.incident_date)} ${esc(item.incident_time||'')} ${item.location ? `� ${esc(item.location)}` : ''}</p>
    <p><strong>Status:</strong> ${badge(item.status||'')}</p>
    <p><strong>Description:</strong><br>${esc(item.description||'�')}</p>
    <p><strong>Evidence:</strong><br>${esc(item.evidence_notes||'�')}</p>
    <hr>
    <p><strong>Guardian:</strong> ${esc(item.guardian_name||'�')} ${item.guardian_contact ? `� ${esc(item.guardian_contact)}` : ''}</p>
    <p><strong>Community service:</strong> ${esc(item.community_service_type||'�')} � Required ${hoursNum(item.required_service_hours).toFixed(2)}h � Completed ${hoursNum(item.completed_service_hours).toFixed(2)}h � Remaining ${remaining.toFixed(2)}h � Status ${badge(item.service_status||'none')}</p>`;
  const m = modal(`Case ${item.case_number}`, body);
  if (me && me.role === 'admin') {
    const footer = m.querySelector('.modal-footer');
    const resolveBtn = document.createElement('button');
    resolveBtn.className = 'primary';
    resolveBtn.textContent = 'Mark resolved';
    resolveBtn.onclick = async () => { try { await patch(`/api/violations/${item.id}/status`, { status: 'Resolved' }); m.remove(); await loadData(); go('violations'); } catch (e) { toast(e.message); } };
    const submitBtn = m.querySelector('#modalSubmit'); if (footer && submitBtn) footer.insertBefore(resolveBtn, submitBtn); else if (footer) footer.appendChild(resolveBtn);
  }
  const sb = m.querySelector('#modalSubmit'); if (sb) sb.style.display = 'none';
}

function openEditStudent(id) {
  const s = students.find(x => String(x.id) === String(id));
  if (!s) return toast('Student not found.');
  const m = modal('Edit student', `<form id="modalForm">
    <label>Student number<input name="student_number" value="${esc(s.student_number||'')}"></label>
    <label>First name<input name="first_name" value="${esc(s.first_name||'')}" required></label>
    <label>Last name<input name="last_name" value="${esc(s.last_name||'')}" required></label>
    <label>Grade<input name="grade_level" value="${esc(s.grade_level||'')}" required></label>
    <label>Section<select name="section_id" required>${sections.map(sec => `<option value="${sec.id}" ${String(sec.id)===String(s.section_id)?'selected':''}>G${esc(sec.grade_level)} � ${esc(sec.section_name)}</option>`).join('')}</select></label>
    <div id="editStuTsContainer"></div>
    <label>Guardian name<input name="guardian_name" value="${esc(s.guardian_name||'')}"></label>
    <label>Guardian contact<input name="guardian_contact" value="${esc(s.guardian_contact||'')}"></label>
  </form>`);
  wireGradeTrackStrand($('#modalForm'), 'editStu', { grade: s.grade_level, track_id: s.track_id || '', strand_id: s.strand_id || '' });
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f.reportValidity()) return;
    try { await patch(`/api/students/${s.id}`, Object.fromEntries(new FormData(f).entries())); m.remove(); await loadData(); go('students'); toast('Student updated'); } catch (e) { toast(e.message); }
  };
}

function openReassignStudent(id) {
  const s = students.find(x => String(x.id) === String(id));
  if (!s) return toast('Student not found.');
  const m = modal('Reassign student section', `<form id="modalForm">
    <p><strong>${esc((s.last_name||'')+', '+(s.first_name||''))}</strong> � current G${esc(s.grade_level||'')} ${esc(s.section_name||'')}</p>
    <label>Target section<select name="section_id" id="reassignSection" required><option value="">Select section</option>${sections.map(sec => `<option value="${sec.id}" data-grade="${esc(sec.grade_level||'')}" data-track-id="${esc(sec.track_id||'')}" data-strand-id="${esc(sec.strand_id||'')}">G${esc(sec.grade_level)} � ${esc(sec.section_name)}${sec.school_year ? ' � '+esc(sec.school_year) : ''}</option>`).join('')}</select></label>
    <label>Grade (optional override)<input name="grade_level" placeholder="Defaults from target section"></label>
    <label>Track (optional)<select name="track_id" id="reassignTrack"><option value="">Use section/default</option>${trackOptions('', false)}</select></label>
    <label>Strand (optional)<select name="strand_id" id="reassignStrand"><option value="">Use section/default</option>${strandOptions('', '', false)}</select></label>
    <label>Reason<textarea name="reason" rows="2"></textarea></label>
  </form><p class="tiny muted">Existing violation and community service records are preserved. Assignment history is logged.</p>`);
  const secSel = $('#reassignSection');
  const trackSel = $('#reassignTrack');
  const strandSel = $('#reassignStrand');
  if (secSel) secSel.onchange = () => {
    const optSel = secSel.selectedOptions[0]; if (!optSel) return;
    const g = optSel.dataset.grade || '';
    const t = optSel.dataset.trackId || '';
    const st = optSel.dataset.strandId || '';
    const gradeInput = $('#modalForm [name="grade_level"]'); if (gradeInput && !gradeInput.value) gradeInput.placeholder = g ? `Defaults to ${g}` : 'Defaults from target section';
    if (trackSel) trackSel.value = t || '';
    if (strandSel) { strandSel.innerHTML = `<option value="">Use section/default</option>${strandOptions(st, t, false)}`; strandSel.value = st || ''; }
  };
  if (trackSel && strandSel) trackSel.onchange = () => { strandSel.innerHTML = `<option value="">Use section/default</option>${strandOptions('', trackSel.value, false)}`; };
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f.reportValidity()) return;
    try { await patch(`/api/students/${s.id}/section`, Object.fromEntries(new FormData(f).entries())); m.remove(); await loadData(); go('students'); toast('Student reassigned'); } catch (e) { toast(e.message); }
  };
}

function openEditSection(id) {
  const s = sections.find(x => String(x.id) === String(id));
  if (!s) return toast('Section not found.');
  const m = modal('Edit section', `<form id="modalForm">
    <label>Section name<input name="name" value="${esc(s.section_name||'')}" required></label>
    <label>Grade<input name="grade" value="${esc(s.grade_level||'')}" required></label>
    <label>Track<select name="track_id" id="editSecTrack"><option value="">Not set</option>${trackOptions(s.track_id||'', false)}</select></label>
    <label>Strand<select name="strand_id" id="editSecStrand"><option value="">Not set</option>${strandOptions(s.strand_id||'', s.track_id||'', false)}</select></label>
    <label>Strand label (text)<input name="strand" value="${esc(s.strand||'')}"></label>
    <label>School year<input name="school_year" value="${esc(s.school_year||s.school_year_label||'')}"></label>
  </form>`);
  const t = $('#editSecTrack'), st = $('#editSecStrand');
  if (t && st) t.onchange = () => { st.innerHTML = `<option value="">Not set</option>${strandOptions('', t.value, false)}`; };
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f.reportValidity()) return;
    try { await patch(`/api/sections/${s.id}`, Object.fromEntries(new FormData(f).entries())); m.remove(); await loadData(); go('sections'); toast('Section updated'); } catch (e) { toast(e.message); }
  };
}

function openEditTrack(id) {
  const cfg = academicConfigAll.tracks || academicConfig.tracks || [];
  const t = cfg.find(x => String(x.id) === String(id));
  if (!t) return toast('Track not found.');
  const m = modal('Edit track', `<form id="modalForm"><label>Code<input name="code" value="${esc(t.code||'')}" required></label><label>Name<input name="name" value="${esc(t.name||'')}" required></label><label>Status<select name="is_active"><option value="1" ${t.is_active?'selected':''}>Active</option><option value="0" ${!t.is_active?'selected':''}>Inactive</option></select></label></form>`);
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f).entries());
    try { await patch(`/api/academic/tracks/${t.id}`, { ...d, is_active: d.is_active === '1' }); m.remove(); await loadAcademicConfig(true); await loadData(); go('sections'); toast('Track updated'); } catch (e) { toast(e.message); }
  };
}

function openEditStrand(id) {
  const cfg = academicConfigAll.strands || academicConfig.strands || [];
  const s = cfg.find(x => String(x.id) === String(id));
  if (!s) return toast('Strand not found.');
  const m = modal('Edit strand', `<form id="modalForm"><label>Code<input name="code" value="${esc(s.code||'')}" required></label><label>Name<input name="name" value="${esc(s.name||'')}" required></label><label>Track<select name="track_id"><option value="">No track</option>${trackOptions(s.track_id||'', false)}</select></label><label>Status<select name="is_active"><option value="1" ${s.is_active?'selected':''}>Active</option><option value="0" ${!s.is_active?'selected':''}>Inactive</option></select></label></form>`);
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f).entries());
    try { await patch(`/api/academic/strands/${s.id}`, { ...d, track_id: d.track_id || null, is_active: d.is_active === '1' }); m.remove(); await loadAcademicConfig(true); await loadData(); go('sections'); toast('Strand updated'); } catch (e) { toast(e.message); }
  };
}

async function openAssignTeacher(id) {
  const staff = users.find(u => String(u.id) === String(id));
  if (!staff) return toast('User not found.');
  let assigned = [];
  try { assigned = await get(`/api/teachers/${id}/sections`); } catch (e) { return toast(e.message); }
  const assignedIds = new Set(assigned.map(x => String(x.section_id || x.id)));
  const isSingleSection = staff.role === 'teacher' || staff.role === 'class_adviser';
  const opts = sections.map(s => `<option value="${s.id}" ${assignedIds.has(String(s.id)) ? 'selected' : ''}>${esc((s.school_year || '') + (s.school_year ? ' · ' : ''))}G${esc(s.grade_level)} · ${esc(s.section_name)}</option>`).join('');
  const note = staff.role === 'class_adviser'
    ? '<p class="tiny muted">Class Adviser accounts are limited to one section per school year, and each section can have only one Class Adviser account. Creating a new section/school year allows a new adviser account for that section.</p>'
    : (staff.role === 'teacher' ? '<p class="tiny muted">Teacher accounts can be assigned to only one section.</p>' : '');
  const m = modal(`Assign section${isSingleSection ? '' : 's'} · ${esc(staff.full_name)}`, `<form id="modalForm"><label>${isSingleSection ? 'Assigned section (one only)' : 'Assigned sections'}<select name="sectionIds" ${isSingleSection ? '' : 'multiple'} size="8">${isSingleSection ? '<option value="">Select section</option>' : ''}${opts}</select></label>${note}</form>`);
  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm'); if (!f) return;
    const selected = isSingleSection ? [Number(f.sectionIds.value)].filter(Boolean) : [...f.sectionIds.selectedOptions].map(o => Number(o.value));
    try { await put(`/api/teachers/${id}/sections`, { sections: selected }); m.remove(); await loadData(); go('accounts'); toast('Section assignment updated'); } catch (e) { toast(e.message); }
  };
}
function openEditServiceLog(id) {
  const log = (calendarState.selectedItems || []).find(x => String(x.id) === String(id));
  if (!log) return toast('Service log not found in selected day. Select the date again.');
  openLogServiceModal(log.service_date, log);
}

function attachClickHandlers() {
  document.addEventListener('change', async e => {
    const statusSel = e.target.closest('[data-case-status]');
    if (statusSel) {
      try {
        await patch(`/api/violations/${statusSel.dataset.caseStatus}`, { status: statusSel.value });
        await loadRecentViolations();
        toast('Case status updated');
        render();
      } catch (err) { toast(err.message); }
      return;
    }
  });
  document.addEventListener('click', async e => {
    // Password visibility toggles
    const toggle = e.target.closest('[data-toggle-password]');
    if (toggle) {
      e.preventDefault();
      const wrap = toggle.closest('.password-wrap');
      const input = wrap ? wrap.querySelector('input') : null;
      if (input) {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.textContent = show ? 'Hide' : 'Show';
      }
      return;
    }

    const nav = e.target.closest('.nav-btn, .nav-link, [data-view]');
    if (nav && nav.dataset.view) { e.preventDefault(); go(nav.dataset.view); return; }

    const logoutBtn = e.target.closest('#logoutBtn, #logout');
    if (logoutBtn) { e.preventDefault(); try { await post('/api/auth/logout', {}); } catch(_){} me = null; showGate(); return; }

    const modalBtn = e.target.closest('[data-modal]');
    if (modalBtn) { openModal(modalBtn.dataset.modal); return; }

    const calDay = e.target.closest('[data-calendar-day]');
    if (calDay) { calendarState.selectedDate = calDay.dataset.calendarDay; await loadCalendar(); renderService(); return; }

    const detailsBtn = e.target.closest('[data-details]');
    if (detailsBtn) { openCaseDetails(detailsBtn.dataset.details); return; }
    const editLogBtn = e.target.closest('[data-edit-service-log]');
    if (editLogBtn) { openEditServiceLog(editLogBtn.dataset.editServiceLog); return; }
    const studentEditBtn = e.target.closest('[data-student-edit]');
    if (studentEditBtn) { openEditStudent(studentEditBtn.dataset.studentEdit); return; }
    const studentReassignBtn = e.target.closest('[data-student-reassign]');
    if (studentReassignBtn) { openReassignStudent(studentReassignBtn.dataset.studentReassign); return; }
    const editSecBtn = e.target.closest('[data-edit-section]');
    if (editSecBtn) { openEditSection(editSecBtn.dataset.editSection); return; }
    const editTrackBtn = e.target.closest('[data-edit-track]');
    if (editTrackBtn) { openEditTrack(editTrackBtn.dataset.editTrack); return; }
    const editStrandBtn = e.target.closest('[data-edit-strand]');
    if (editStrandBtn) { openEditStrand(editStrandBtn.dataset.editStrand); return; }
    const assignBtn = e.target.closest('[data-assign]');
    if (assignBtn) { openAssignTeacher(assignBtn.dataset.assign); return; }
    const approveBtn = e.target.closest('[data-approve]');
    if (approveBtn) { try { await post(`/api/admin/approve/${approveBtn.dataset.approve}`, {}); await loadData(); go('accounts'); toast('Staff account request approved'); } catch (err) { toast(err.message); } return; }
    const rejectBtn = e.target.closest('[data-reject]');
    if (rejectBtn) { try { await post(`/api/admin/reject/${rejectBtn.dataset.reject}`, {}); await loadData(); go('accounts'); toast('Staff account request rejected'); } catch (err) { toast(err.message); } return; }
    const toggleUserBtn = e.target.closest('[data-toggle-user]');
    if (toggleUserBtn) { try { await patch(`/api/users/${toggleUserBtn.dataset.toggleUser}/status`, { status: toggleUserBtn.dataset.status }); await loadData(); go('accounts'); toast('Account updated'); } catch (err) { toast(err.message); } return; }
    const attendanceBtn = e.target.closest('[data-attendance]');
    if (attendanceBtn) { logAttendance(attendanceBtn.dataset.attendance); return; }
    const historyBtn = e.target.closest('[data-history]');
    if (historyBtn) { history(historyBtn.dataset.history); return; }
    const activateYearBtn = e.target.closest('[data-activate-year]');
    if (activateYearBtn) { try { await patch(`/api/years/${activateYearBtn.dataset.activateYear}/activate`, {}); await loadData(); go('sections'); toast('School year activated'); } catch (err) { toast(err.message); } return; }
    const deleteSectionBtn = e.target.closest('[data-delete-section]');
    if (deleteSectionBtn) {
      if (!confirm('Delete this section? This is blocked if students are still assigned.')) return;
      try { await del(`/api/sections/${deleteSectionBtn.dataset.deleteSection}`); await loadData(); go('sections'); toast('Section deleted'); } catch (err) { toast(err.message); }
      return;
    }
  });
}

let signupOptionsCache = null;

async function loadSignupOptions(force = false) {
  if (signupOptionsCache && !force) return signupOptionsCache;
  try {
    signupOptionsCache = await get('/api/public/signup-options');
  } catch (e) {
    signupOptionsCache = { years: [], sections: [], tracks: [], strands: [], trackStrandEnabled: false };
  }
  return signupOptionsCache;
}

function populateSignupOptionsUI() {
  const opts = signupOptionsCache || { years: [], sections: [], tracks: [], strands: [], trackStrandEnabled: false };
  const yearSel = $('#signupSchoolYear');
  const gradeSel = $('#signupGradeLevel');
  const sectionSel = $('#signupSection');
  const trackSel = $('#signupTrack');
  const strandSel = $('#signupStrand');
  const tsWrap = $('#signupTrackStrandWrap');
  if (!yearSel || !gradeSel || !sectionSel) return;

  const years = Array.isArray(opts.years) ? opts.years : [];
  const sections = Array.isArray(opts.sections) ? opts.sections : [];
  const tracks = Array.isArray(opts.tracks) ? opts.tracks : [];
  const strands = Array.isArray(opts.strands) ? opts.strands : [];

  const prevYear = yearSel.value;
  const prevGrade = gradeSel.value;
  const prevSection = sectionSel.value;
  const prevTrack = trackSel?.value || '';
  const prevStrand = strandSel?.value || '';

  yearSel.innerHTML = `<option value="">Select school year</option>` + years.map(y => `<option value="${esc(y.id)}">${esc(y.label || '')}</option>`).join('');
  if (prevYear && years.some(y => String(y.id) === String(prevYear))) yearSel.value = prevYear;
  else if (years.length === 1) yearSel.value = String(years[0].id);

  const yearId = String(yearSel.value || '');
  const grade = String(gradeSel.value || prevGrade || '');
  const filteredSections = sections.filter(s => (!yearId || String(s.school_year_id) === yearId) && (!grade || String(s.grade_level) === grade));
  sectionSel.innerHTML = `<option value="">${yearId && grade ? 'Select section' : 'Select grade and school year first'}</option>` + filteredSections.map(s => `<option value="${esc(s.id)}">${esc(s.section_name || '')} (${esc(s.grade_level || '')})</option>`).join('');
  if (prevSection && filteredSections.some(s => String(s.id) === String(prevSection))) sectionSel.value = prevSection;

  const isSenior = grade === '11' || grade === '12';
  const showTS = isSenior && !!opts.trackStrandEnabled;
  if (tsWrap) tsWrap.classList.toggle('hidden', !showTS);
  if (trackSel) {
    trackSel.innerHTML = `<option value="">Select track${showTS ? '' : ' (if applicable)'}</option>` + tracks.map(t => `<option value="${esc(t.id)}">${esc(t.name || t.code || '')}</option>`).join('');
    trackSel.required = showTS;
    if (prevTrack && tracks.some(t => String(t.id) === String(prevTrack))) trackSel.value = prevTrack;
  }
  const selectedTrackId = String(trackSel?.value || '');
  const filteredStrands = strands.filter(st => !selectedTrackId || String(st.track_id || '') === selectedTrackId);
  if (strandSel) {
    strandSel.innerHTML = `<option value="">Select strand${showTS ? '' : ' (if applicable)'}</option>` + filteredStrands.map(st => `<option value="${esc(st.id)}">${esc(st.name || st.code || '')}${st.track_name ? ` (${esc(st.track_name)})` : ''}</option>`).join('');
    strandSel.required = showTS;
    if (prevStrand && filteredStrands.some(st => String(st.id) === String(prevStrand))) strandSel.value = prevStrand;
  }

  const staffRoleSel = $('#staffRequestRole');
  const staffSecWrap = $('#staffRequestSectionWrap');
  const staffSecSel = $('#staffRequestSection');
  if (staffRoleSel && staffSecWrap && staffSecSel) {
    const needsSection = staffRoleSel.value === 'class_adviser';
    staffSecWrap.classList.toggle('hidden', !needsSection);
    staffSecSel.required = needsSection;
    const allSections = (sections || []).slice().sort((a, b) =>
      String(a.school_year || a.school_year_label || '').localeCompare(String(b.school_year || b.school_year_label || '')) ||
      String(a.grade_level || '').localeCompare(String(b.grade_level || ''), undefined, { numeric: true }) ||
      String(a.section_name || a.name || '').localeCompare(String(b.section_name || b.name || ''))
    );
    const yearLabelById = new Map((years || []).map(y => [String(y.id), y.label || '']));
    staffSecSel.innerHTML = `<option value="">Select section</option>` + allSections.map(s => {
      const sy = s.school_year || s.school_year_label || yearLabelById.get(String(s.school_year_id || '')) || '';
      return `<option value="${esc(s.id)}">${esc(sy ? sy + ' · ' : '')}Grade ${esc(s.grade_level || '')} ${esc(s.section_name || s.name || '')}</option>`;
    }).join('');
  }
}

function switchAuthTab(tab) {
  const normalized = tab === 'student-register' ? 'studentRegister' : tab;
  $$('.auth-card .tab, .tabs .tab').forEach(t => {
    const ttab = t.dataset.authTab || t.dataset.auth || '';
    const tnorm = ttab === 'student-register' ? 'studentRegister' : ttab;
    t.classList.toggle('active', tnorm === normalized);
  });
  $('#loginForm')?.classList.toggle('hidden', normalized !== 'login');
  $('#studentRegisterForm')?.classList.toggle('hidden', normalized !== 'studentRegister');
  $('#registerForm')?.classList.toggle('hidden', normalized !== 'register');
  if (normalized === 'studentRegister' || normalized === 'register') {
    loadSignupOptions().then(populateSignupOptionsUI).catch(() => {});
  }
}

function openAuthModal(tab = 'login') {
  $('#authModal')?.classList.remove('hidden');
  $('#authModal')?.setAttribute('aria-hidden', 'false');
  if (tab === 'setup') {
    $('#setupForm')?.classList.remove('hidden');
    $('#loginForm')?.classList.add('hidden');
    $('#studentRegisterForm')?.classList.add('hidden');
    $('#registerForm')?.classList.add('hidden');
    $('.auth-modal-card .tabs')?.classList.add('hidden');
  } else {
    if ($('#setupForm')) $('#setupForm').classList.add('hidden');
    $('.auth-modal-card .tabs')?.classList.remove('hidden');
    switchAuthTab(tab);
  }
}

function closeAuthModal() {
  $('#authModal')?.classList.add('hidden');
  $('#authModal')?.setAttribute('aria-hidden', 'true');
}

function showGate() {
  $('#landing')?.classList.remove('hidden');
  $('#app')?.classList.add('hidden');
}
function showApp() {
  $('#landing')?.classList.add('hidden');
  closeAuthModal();
  $('#app')?.classList.remove('hidden');
  if ($('#userName')) $('#userName').textContent = me?.full_name || 'User';
  if ($('#userRole')) {
    const labels = { admin: 'Administrator', teacher: 'Teacher', guidance_counselor: 'Guidance Counselor', class_adviser: 'Class Adviser', student: 'Student' };
    $('#userRole').textContent = labels[me?.role] || me?.role || 'User';
  }
  if ($('#userAvatar')) $('#userAvatar').textContent = initials(me?.full_name || '');
  renderNav();
}


function attachAuthHandlers() {
  $$('.auth-card .tab, .tabs .tab').forEach(t => t.addEventListener('click', () => switchAuthTab(t.dataset.authTab || t.dataset.auth)));

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

  $('#signupGradeLevel')?.addEventListener('change', populateSignupOptionsUI);
  $('#signupSchoolYear')?.addEventListener('change', populateSignupOptionsUI);
  $('#signupTrack')?.addEventListener('change', populateSignupOptionsUI);

  $('#studentRegisterForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await post('/api/auth/register', d);
      e.target.reset();
      populateSignupOptionsUI();
      switchAuthTab('login');
      toast(r.message || 'Student account created. You can sign in now.');
    } catch (err) { toast(err.message); }
  });

  $('#registerForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await post('/api/auth/register-admin', d);
      e.target.reset();
      toast(r.message || 'Staff account request submitted for administrator approval.');
    } catch (err) { toast(err.message); }
  });
}

async function init() {
  attachClickHandlers();
  attachAuthHandlers();

  $$('[data-open-auth]').forEach(btn => btn.addEventListener('click', () => openAuthModal(btn.dataset.openAuth || 'login')));
  $$('[data-close-auth]').forEach(btn => btn.addEventListener('click', closeAuthModal));

  try {
    const status = await get('/api/auth/setup-status');
    if (!status.configured) {
      showGate();
      openAuthModal('setup');
      const msgEl = $('#authMsg'); if (msgEl) msgEl.textContent = 'Create the first administrator account to initialize the system.';
      return;
    }
    $('#setupForm')?.classList.add('hidden');
    switchAuthTab('login');
    try {
      const session = await get('/api/me');
      if (session?.user) { me = session.user; await loadData(); showApp(); await go('dashboard'); return; }
    } catch (_) {}
  } catch (e) {
    console.error(e);
    const msgEl = $('#authMsg'); if (msgEl) msgEl.textContent = 'Unable to reach the server. Check that the backend is running.';
  }
  showGate();
}

init();
