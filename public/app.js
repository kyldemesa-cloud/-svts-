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

const esc = s => String(s ? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

async function api(url, opts = {}) {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  let d = {};
  try {
    d = await r.json();
  } catch {}
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
}

const post = (url, data) => api(url, { method: 'POST', body: JSON.stringify(data) });
const put = (url, data) => api(url, { method: 'PUT', body: JSON.stringify(data) });
const patch = (url, data) => api(url, { method: 'PATCH', body: JSON.stringify(data) });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}

function msg(el, m) {
  el.textContent = m;
}

function initials(n) {
  return n.split(' ').map(x => x[0] || '').join('').slice(0, 2).toUpperCase();
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString();
}

function badge(s) {
  const cls = /complete|resolved|verified/i.test(s)
    ? 'complete'
    : /pending|assigned|reported/i.test(s)
      ? 'pending'
      : /reject|suspend|serious/i.test(s)
        ? 'danger'
        : 'review';
  return `<span class="badge ${cls}">${esc(s || '—')}</span>`;
}

function navItems() {
  return me.role === 'admin'
    ? [
        ['dashboard', '◫', 'Dashboard'],
        ['violations', '▤', 'Violation Records'],
        ['students', '♙', 'Students'],
        ['community', '◷', 'Community Service'],
        ['sections', '▦', 'Sections & School Years'],
        ['accounts', '♧', 'Accounts'],
        ['offenses', '⚑', 'Offense Catalog'],
        ['reports', '▥', 'Reports']
      ]
    : [
        ['dashboard', '◫', 'Dashboard'],
        ['violations', '▤', 'Violation Records'],
        ['community', '◷', 'Community Service']
      ];
}

function showApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#userName').textContent = me.full_name;
  $('#userRole').textContent = me.role === 'admin' ? 'Verified administrator' : 'Teacher';
  $('#userAvatar').textContent = initials(me.full_name);
  $('#nav').innerHTML = navItems().map(([v, ico, t]) =>
    `<button class="nav-btn ${view === v ? 'active' : ''}" data-view="${v}"><span>${ico}</span>${t}</button>`
  ).join('');
}

let violationFilters = { added_from: '', added_to: '', grade_level: '', section_id: '', track_id: '', strand_id: '', violation_type: '', service_status: '', search: '' };

async function loadRecentViolations() {
  const qs = new URLSearchParams();
  Object.entries(violationFilters).forEach(([k, v]) => { if (v !== '' && v != null) qs.set(k, v); });
  qs.set('limit', '200');
  const res = await api('/api/dashboard/recent-violations?' + qs.toString());
  cases = res.items || res || [];
}

async function loadData() {
  [years] = await Promise.all([api('/api/years')]);
  activeYear = activeYear || years.find(y => y.is_active) || years[0] || null;
  sections = await api('/api/sections' + (activeYear ? '?year=' + activeYear.id : ''));
  students = await api('/api/students' + (activeYear ? '?year=' + activeYear.id : ''));
  offenses = await api('/api/offenses');
  try {
    await loadRecentViolations();
  } catch {
    cases = await api('/api/violations');
  }
  service = await api('/api/community-service');
  if (me.role === 'admin') {
    users = await api('/api/users');
    pending = await api('/api/admin/pending');
  }
}

async function go(v) {
  view = v;
  $('#pageTitle').textContent = navItems().find(x => x[0] === v)?.[2] || v;
  $('#nav').innerHTML = navItems().map(([key, ico, t]) =>
    `<button class="nav-btn ${view === key ? 'active' : ''}" data-view="${key}"><span>${ico}</span>${t}</button>`
  ).join('');
  if (!years.length && v !== 'dashboard') await loadData();
  $('#yearLabel').textContent = activeYear ? `SY ${activeYear.label}` : 'School year not set';
  render();
}

function pageHead(title, button = '') {
  return `<div class="page-head"><h2>${title}</h2>${button}</div>`;
}

function cardKpi(label, val, desc = '') {
  return `<div class="card kpi"><span class="kpi-label">${label}</span><strong>${val}</strong><small>${desc}</small></div>`;
}

function table(headers, rows) {
  return `<div class="card table-card"><div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty">No records found.</td></tr>`}</tbody></table></div></div>`;
}

function render() {
  switch (view) {
    case 'dashboard':
      renderDashboard();
      break;
    case 'violations':
      renderCases();
      break;
    case 'students':
      renderStudents();
      break;
    case 'community':
      renderService();
      break;
    case 'sections':
      renderSections();
      break;
    case 'accounts':
      renderAccounts();
      break;
    case 'offenses':
      renderOffenses();
      break;
    case 'reports':
      renderReports();
      break;
    default:
      renderDashboard();
  }
}

function renderDashboard() {
  const activeCases = cases.filter(c => !['Resolved', 'Closed', 'Rejected'].includes(c.status)).length;
  const complete = service.filter(s => s.status === 'Completed').length;
  const assigned = service.length;
  let html = `<div class="grid">${cardKpi('Active students', students.length, 'Within selected school year')}${cardKpi('Violation cases', cases.length, 'Recorded incidents')}${cardKpi('Open / in progress', activeCases, 'Cases needing follow-up')}${cardKpi('Service assignments', assigned, `${complete} completed`)}</div><h2 class="section-title">Recent violation records</h2>`;
  html += table(
    ['Case no.', 'Student', 'Grade / Section', 'Offense', 'Severity', 'Date', 'Status'],
    cases.slice(0, 8).map(c =>
      `<tr><td>${esc(c.case_number)}</td><td>${esc(c.first_name + ' ' + c.last_name)}</td><td>G${esc(c.grade_level)} · ${esc(c.section_name)}</td><td>${esc(c.offense)}</td><td>${badge(c.severity)}</td><td>${fmtDate(c.incident_date)}</td><td>${badge(c.status)}</td></tr>`
    ).join('')
  );
  if (me.role === 'admin') {
    html += `<h2 class="section-title">Administrator approvals</h2><div class="card"><p>${pending.length} pending administrator registration(s).</p><button class="primary smallbtn" data-view="accounts">Review accounts</button></div>`;
  }
  $('#content').innerHTML = html;
}

function renderCases() {
  const rows = cases.map(c =>
    `<tr>
      <td>${esc(c.case_number)}</td>
      <td>${esc((c.first_name || '') + ' ' + (c.last_name || ''))}${c.student_number ? `<div class="tiny muted">${esc(c.student_number)}</div>` : ''}</td>
      <td>G${esc(c.grade_level || '')} ? ${esc(c.section_name || '')}</td>
      <td>${esc(c.offense || '')}</td>
      <td>${badge(c.severity || '')}</td>
      <td>${fmtDate(c.incident_date)}</td>
      <td>${badge(c.status || '')}<div class="tiny muted">service: ${esc(c.service_status || 'none')}</div></td>
      <td>${me.role === 'admin'
        ? `<select data-case-status="${c.id}">${['Reported', 'Under Review', 'Verified', 'Accepted', 'In Progress', 'Resolved', 'Closed', 'Rejected', 'Escalated'].map(x => `<option ${x === c.status ? 'selected' : ''}>${x}</option>`).join('')}</select><div style="height:6px"></div><button class="ghost smallbtn" data-case-details="${c.id}">Details</button>`
        : `<button class="ghost smallbtn" data-case-details="${c.id}">View</button>`
      }</td>
    </tr>`
  ).join('');

  const f = violationFilters;
  $('#content').innerHTML =
    pageHead(
      'Violation records',
      `<div class="actions"><button class="ghost" id="exportViolationsXlsx">Export Violations XLSX</button><button class="ghost" id="exportServiceXlsx">Export Service XLSX</button>${me.role === 'admin' ? '<button class="primary" data-modal="recordCase">+ Record violation</button>' : ''}</div>`
    ) +
    `<div class="card"><div class="inline-form">
      <label>Added from<input id="vfFrom" type="date" value="${esc(f.added_from || '')}"></label>
      <label>Added to<input id="vfTo" type="date" value="${esc(f.added_to || '')}"></label>
      <label>Grade<input id="vfGrade" value="${esc(f.grade_level || '')}" placeholder="e.g. 11"></label>
      <label>Section<select id="vfSection"><option value="">All sections</option>${sections.map(s => `<option value="${s.id}" ${String(f.section_id) === String(s.id) ? 'selected' : ''}>G${esc(s.grade_level)} ? ${esc(s.section_name)}</option>`).join('')}</select></label>
      <label>Service status<select id="vfService"><option value="">All</option>${['none', 'pending', 'in_progress', 'completed'].map(s => `<option value="${s}" ${f.service_status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>Search<input id="vfSearch" value="${esc(f.search || '')}" placeholder="case, student, offense"></label>
      <button class="primary" id="vfApply">Apply filters</button>
      <button class="ghost" id="vfClear">Clear</button>
    </div><div class="tiny muted" style="margin-top:8px">Date filters are inclusive; "Added To" includes records through the end of that day.</div></div><div style="height:12px"></div>` +
    `<div class="note">${me.role === 'admin' ? 'Only administrators can create or modify violation records. Violation records store guardian/service snapshots and service status.' : 'Teacher access is read-only for violation records. You may view assigned-section cases and their statuses.'}</div><div style="height:12px"></div>` +
    table(
      ['Case no.', 'Student', 'Grade / Section', 'Offense', 'Severity', 'Date', 'Status / Service', me.role === 'admin' ? 'Actions' : 'Details'],
      rows
    );

  const applyFilters = async () => {
    violationFilters = {
      added_from: $('#vfFrom').value,
      added_to: $('#vfTo').value,
      grade_level: $('#vfGrade').value.trim(),
      section_id: $('#vfSection').value,
      track_id: '',
      strand_id: '',
      violation_type: '',
      service_status: $('#vfService').value,
      search: $('#vfSearch').value.trim()
    };
    try { await loadRecentViolations(); renderCases(); } catch (e) { toast(e.message); }
  };

  $('#vfApply').onclick = applyFilters;
  $('#vfClear').onclick = async () => {
    violationFilters = { added_from: '', added_to: '', grade_level: '', section_id: '', track_id: '', strand_id: '', violation_type: '', service_status: '', search: '' };
    try { await loadRecentViolations(); renderCases(); } catch (e) { toast(e.message); }
  };
  $('#exportViolationsXlsx').onclick = () => {
    const qs = new URLSearchParams();
    Object.entries(violationFilters).forEach(([k, v]) => { if (v) qs.set(k, v); });
    window.location.href = '/api/exports/violations.xlsx?' + qs.toString();
  };
  $('#exportServiceXlsx').onclick = () => {
    const qs = new URLSearchParams();
    Object.entries(violationFilters).forEach(([k, v]) => { if (v) qs.set(k, v); });
    window.location.href = '/api/exports/community-service.xlsx?' + qs.toString();
  };
}

function renderStudents() {
  const rows = students.map(s =>
    `<tr>
      <td>${esc(s.student_number || '—')}</td>
      <td>${esc((s.last_name||'') + ', ' + (s.first_name||''))}</td>
      <td>G${esc(s.grade_level || '')}</td>
      <td>${esc(s.section_name || '')}</td>
      <td>${esc(s.strand_name || s.section_strand_text || s.strand || '—')}</td>
      <td>${me.role === 'admin' ? `<button class="ghost smallbtn" data-student-edit="${s.id}">Edit</button>` : '—'}</td>
    </tr>`
  ).join('');

  $('#content').innerHTML =
    pageHead('Student records', `<button class="primary" data-modal="student">+ Add student</button>`) +
    `<div class="note">Student records include guardian and track/strand fields (when applicable) and keep section reassignment history.</div><div style="height:12px"></div>` +
    table(['Student no.', 'Name', 'Grade', 'Section', 'Strand', 'Actions'], rows);
}

function renderService() {
  const rows = service.map(c => {
    const pct = c.hours_required
      ? Math.min(100, Math.round(c.hours_completed / c.hours_required * 100))
      : c.service_days_required
        ? Math.min(100, Math.round(c.days_completed / c.service_days_required * 100))
        : 0;

    return `<tr><td>${esc(c.first_name + ' ' + c.last_name)}</td><td>G${esc(c.grade_level)} · ${esc(c.section_name)}</td><td>${esc(c.case_number || 'Standalone')}</td><td>${c.days_completed}/${c.service_days_required} days</td><td>${Number(c.hours_completed).toFixed(1)}/${c.hours_required} hours</td><td><div class="progress"><span style="width:${pct}%"></span></div>${pct}%</td><td>${badge(c.status)}</td><td><button class="primary smallbtn" data-attendance="${c.id}">Log attendance</button><button class="ghost smallbtn" data-history="${c.id}">History</button></td></tr>`;
  }).join('');

  $('#content').innerHTML =
    pageHead(
      'Community service tracker',
      me.role === 'admin' ? '<button class="primary" data-modal="service">+ Assign service</button>' : ''
    ) +
    `<div class="note">Log each service date, hours completed, and whether a required service day was completed. Teachers may log attendance only for students in their assigned sections.</div><div style="height:12px"></div>` +
    table(['Student', 'Section', 'Case', 'Days', 'Hours', 'Progress', 'Status', 'Actions'], rows);
}

function renderSections() {
  const yearRows = years.map(y =>
    `<tr><td>${esc(y.label)}</td><td>${y.is_active ? badge('Active') : badge('Archived / Inactive')}</td><td>${y.archived_at ? fmtDate(y.archived_at.slice(0, 10)) : '—'}</td><td class="actions">${!y.is_active ? `<button class="primary smallbtn" data-activate-year="${y.id}">Set active</button>` : ''}</td></tr>`
  ).join('');

  const secRows = sections.map(s =>
    `<tr><td>G${esc(s.grade_level)}</td><td>${esc(s.section_name)}</td><td>${esc(s.strand || '—')}</td><td>${esc(s.school_year)}</td><td><button class="ghost smallbtn" data-edit-section="${s.id}">Edit</button><button class="ghost smallbtn" data-delete-section="${s.id}">Delete</button></td></tr>`
  ).join('');

  $('#content').innerHTML =
    `<div class="card"><div class="inline-form"><label style="margin:0">View sections for school year<select id="yearFilter">${years.map(y => `<option value="${y.id}" ${y.id === activeYear?.id ? 'selected' : ''}>${esc(y.label)}</option>`).join('')}</select></label><button class="primary" data-modal="year">+ Add school year</button></div></div>` +
    `<div class="two-col"><div>${pageHead('School years', '')}${table(['School year', 'Status', 'Archived', 'Action'], yearRows)}</div><div>${pageHead('Flexible sections', '<button class="primary" data-modal="section">+ Add section</button>')}${table(['Grade', 'Section name', 'Strand', 'School year', 'Actions'], secRows)}</div></div>` +
    `<p class="note">Sections are defined per school year. Create a new school year and its section list without changing records from previous years.</p>`;
}

function renderAccounts() {
  const pendingRows = pending.map(p =>
    `<tr><td>${esc(p.full_name)}</td><td>${esc(p.email)}</td><td>${fmtDate((p.created_at || '').slice(0, 10))}</td><td class="actions"><button class="primary smallbtn" data-approve="${p.id}">Verify</button><button class="ghost smallbtn" data-reject="${p.id}">Reject</button></td></tr>`
  ).join('');

  const userRows = users.map(u =>
    `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${badge(u.role)}</td><td>${badge(u.status)}</td><td>${u.role === 'teacher' ? `<button class="primary smallbtn" data-assign="${u.id}">Sections</button> ` : ''}${u.id === me.id ? 'Current account' : `<button class="ghost smallbtn" data-toggle-user="${u.id}" data-status="${u.status === 'suspended' ? 'verified' : 'suspended'}">${u.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button>`}</td></tr>`
  ).join('');

  $('#content').innerHTML =
    pageHead('Account management', '<button class="primary" data-modal="teacher">+ Create teacher</button>') +
    `<h2 class="section-title">Pending administrator verification</h2>` +
    table(['Name', 'Email', 'Registered', 'Review'], pendingRows) +
    `<h2 class="section-title">System accounts</h2>` +
    table(['Name', 'Email', 'Role', 'Status', 'Action'], userRows) +
    `<p class="note">Teacher accounts are created by verified administrators and may be assigned to one or more sections. New administrators must be approved by a different verified administrator.</p>`;
}

function renderOffenses() {
  const rows = offenses.map(o =>
    `<tr><td>${esc(o.name)}</td><td>${badge(o.severity)}</td><td>${esc(o.description || '')}</td></tr>`
  ).join('');

  $('#content').innerHTML =
    pageHead('Offense catalog', '<button class="primary" data-modal="offense">+ Add offense</button>') +
    table(['Offense', 'Severity', 'Description'], rows);
}

function renderReports() {
  const grouped = {};
  cases.forEach(c => {
    const key = `${c.offense} — ${c.section_name} — Grade ${c.grade_level}`;
    grouped[key] = (grouped[key] || 0) + 1;
  });

  const rows = Object.entries(grouped)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td></tr>`)
    .join('');

  $('#content').innerHTML =
    pageHead('Reports & summaries', '<button class="primary" id="export">Export CSV</button>') +
    table(['Offense / Section', 'Total cases'], rows) +
    `<p class="note">Summary counts are generated from stored violation records and respect teacher section access.</p>`;

  $('#export').onclick = () => {
    const csv = [
      'Case,Student,Grade,Section,Offense,Severity,Date,Status',
      ...cases.map(c => [
        c.case_number,
        `${c.first_name} ${c.last_name}`,
        c.grade_level,
        c.section_name,
        c.offense,
        c.severity,
        c.incident_date,
        c.status
      ].map(v => `"${String(v ? '').replaceAll('"', '""')}"`).join(','))
    ].join('\n');

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'svts-violations.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

function modal(title, body) {
  const old = $('.modal-bg');
  if (old) old.remove();

  const b = document.createElement('div');
  b.className = 'modal-bg';
  b.innerHTML = `<div class="modal"><h2>${title}</h2>${body}<div class="modal-footer"><button class="ghost" data-close>Cancel</button><button class="primary" id="modalSubmit">Save</button></div></div>`;
  document.body.appendChild(b);

  b.addEventListener('click', e => {
    if (e.target === b || e.target.closest('[data-close]')) b.remove();
  });

  return b;
}

function opt(list, value, label) {
  return list.map(x => `<option value="${x[value]}">${esc(x[label])}</option>`).join('');
}

function openModal(kind, id) {
  let m, form, submit;

  switch (kind) {
    case 'year':
      m = modal(
        'Add school year',
        `<form id="modalForm"><label>School year label<input name="label" placeholder="2026-2027" required></label></form>`
      );
      submit = async d => {
        await post('/api/years', { label: d.label });
        await loadData();
        go('sections');
      };
      break;

    case 'section':
      m = modal(
        'Create section',
        `<form id="modalForm">
          <label>School year<select name="yearId" required>${opt(years, 'id', 'label')}</select></label>
          <label>Grade level<input name="grade" placeholder="7-12" required></label>
          <label>Section name<input name="name" required></label>
          <label>Track ID (optional, Grades 11-12)<input name="track_id" placeholder="Leave blank if not configured"></label>
          <label>Strand ID (optional, Grades 11-12)<input name="strand_id" placeholder="Leave blank if not configured"></label>
          <label>Strand label (optional)<input name="strand"></label>
          <label>School year label (optional override)<input name="school_year" placeholder="Defaults to selected school year"></label>
        </form>
        <p class="tiny muted">When tracks/strands are configured, Grades 11-12 may use them. Grades 7-10 should not require them.</p>`
      );
      submit = async d => {
        await post('/api/sections', d);
        await loadData();
        go('sections');
      };
      break;

    case 'teacher':
      m = modal(
        'Create teacher account',
        `<form id="modalForm"><label>Full name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Temporary password (10+ characters)<input name="password" minlength="10" required></label><label>Assigned sections<select name="sections" multiple size="6">${opt(sections, 'id', 'section_name')}</select></label><p class="tiny muted">Select one or multiple sections. Teachers have read-only violation access.</p></form>`
      );
      submit = async d => {
        const formData = $('#modalForm');
        d.sections = [...formData.sections.selectedOptions].map(x => Number(x.value));
        await post('/api/teachers', d);
        await loadData();
        go('accounts');
      };
      break;

    case 'offense':
      m = modal(
        'Add offense category',
        `<form id="modalForm"><label>Offense name<input name="name" required></label><label>Severity<select name="severity"><option>Minor</option><option>Major</option><option>Serious</option></select></label><label>Description<textarea name="description"></textarea></label></form>`
      );
      submit = async d => {
        await post('/api/offenses', d);
        await loadData();
        go('offenses');
      };
      break;

    case 'student':
      m = modal(
        'Add student record',
        `<form id="modalForm">
          <label>Student number<input name="number" required></label>
          <label>First name<input name="first" required></label>
          <label>Last name<input name="last" required></label>
          <label>Grade<input name="grade" required></label>
          <label>Section<select name="sectionId" required>${sections.map(s => `<option value="${s.id}">G${esc(s.grade_level)} · ${esc(s.section_name)}</option>`).join('')}</select></label>
          <label>Guardian name<input name="guardian_name"></label>
          <label>Guardian contact<input name="guardian_contact"></label>
        </form>`
      );
      submit = async d => {
        await post('/api/students', d);
        await loadData();
        go('students');
      };
      break;

    case 'recordCase':
      m = modal(
        'Record violation',
        `<form id="modalForm">
          <label>Case number<input name="caseNumber" placeholder="SV-2026-0001" required></label>
          <label>Student<select name="studentId" required>${students.map(x => `<option value="${x.id}">${esc(x.last_name + ', ' + x.first_name + ' · G' + (x.grade_level||'') + ' ' + (x.section_name||''))}</option>`).join('')}</select></label>
          <label>Offense<select name="offenseId" required>${opt(offenses, 'id', 'name')}</select></label>
          <label>Incident date<input name="date" type="date" required></label>
          <label>Time<input name="time" type="time"></label>
          <label>Location<input name="location"></label>
          <label>Description<textarea name="description"></textarea></label>
          <label>Evidence notes<textarea name="evidence"></textarea></label>
          <hr>
          <label>Guardian name (snapshot)<input name="guardian_name" placeholder="Defaults to student profile if blank"></label>
          <label>Guardian contact (snapshot)<input name="guardian_contact" placeholder="Defaults to student profile if blank"></label>
          <label>Community service type<input name="community_service_type" placeholder="e.g. Campus cleanup"></label>
          <label>Required service hours<input name="required_service_hours" type="number" min="0" step="0.25" value="0"></label>
          <label>Completed service hours<input name="completed_service_hours" type="number" min="0" step="0.25" value="0"></label>
        </form>
        <p class="tiny muted">Teacher accounts cannot record violations. If required hours is 0, service status is set to none; otherwise pending (or completed/in progress based on completed hours).</p>`
      );
      submit = async d => {
        await post('/api/violations', d);
        await loadData();
        go('violations');
      };
      break;

    case 'service':
      m = modal(
        'Assign community service',
        `<form id="modalForm"><label>Student<select name="studentId" required>${students.map(x => `<option value="${x.id}">${esc(x.last_name + ', ' + x.first_name + ' · G' + x.grade_level + ' ' + x.section_name)}</option>`).join('')}</select></label><label>School year<select name="yearId" required>${opt(years, 'id', 'label')}</select></label><label>Required service days<input name="days" type="number" min="0" value="1"></label><label>Required hours<input name="hours" type="number" min="0" step="0.5" value="2"></label><label>Start date<input name="startDate" type="date"></label><label>Due date<input name="dueDate" type="date"></label><label>Notes<textarea name="notes"></textarea></label></form>`
      );
      submit = async d => {
        await post('/api/community-service', d);
        await loadData();
        go('community');
      };
      break;
  }

  if (!m) return;

  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm');
    if (!f.reportValidity()) return;
    const d = Object.fromEntries(new FormData(f).entries());
    try {
      await submit(d);
      m.remove();
      toast('Saved successfully');
    } catch (e) {
      toast(e.message);
    }
  };
}

async function logAttendance(id) {
  const date = prompt('Service date (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
  if (!date) return;
  const hours = prompt('Hours completed today:', '1');
  if (hours === null) return;
  const day = confirm('Did the student complete one required service day today? OK = yes, Cancel = no');
  const notes = prompt('Notes (optional):', '') || '';

  try {
    await post(`/api/community-service/${id}/attendance`, {
      date,
      hours: Number(hours),
      dayCompleted: day ? 1 : 0,
      notes
    });
    await loadData();
    go('community');
    toast('Attendance recorded');
  } catch (e) {
    toast(e.message);
  }
}

async function history(id) {
  try {
    const data = await api(`/api/community-service/${id}/attendance`);
    const rows = data.map(a =>
      `<tr><td>${fmtDate(a.service_date)}</td><td>${a.hours_served}</td><td>${a.day_completed ? 'Yes' : 'No'}</td><td>${esc(a.notes || '')}</td><td>${esc(a.recorded_by_name)}</td></tr>`
    ).join('');

    modal(
      'Service attendance history',
      table(['Date', 'Hours', 'Day completed', 'Notes', 'Recorded by'], rows)
    );
  } catch (e) {
    toast(e.message);
  }
}

async function details(id) {
  const c = cases.find(x => x.id == id);
  if (!c) return;

  modal(
    'Violation details',
    `<p><b>Case:</b> ${esc(c.case_number)}</p>
     <p><b>Student:</b> ${esc((c.first_name||'') + ' ' + (c.last_name||''))} ${c.student_number ? '('+esc(c.student_number)+')' : ''}</p>
     <p><b>Grade / Section:</b> G${esc(c.grade_level || '')} · ${esc(c.section_name || '')}</p>
     <p><b>Track / Strand:</b> ${esc(c.track_name || '—')} / ${esc(c.strand_name || '—')}</p>
     <p><b>Offense:</b> ${esc(c.offense || '')} (${esc(c.severity || '')})</p>
     <p><b>Incident date:</b> ${fmtDate(c.incident_date)}</p>
     <p><b>Location:</b> ${esc(c.location || '—')}</p>
     <p><b>Description:</b> ${esc(c.description || '—')}</p>
     <p><b>Evidence notes:</b> ${esc(c.evidence_notes || '—')}</p>
     <p><b>Status:</b> ${esc(c.status || '')}</p>
     <hr>
     <p><b>Guardian:</b> ${esc(c.guardian_name || '—')} ${c.guardian_contact ? '('+esc(c.guardian_contact)+')' : ''}</p>
     <p><b>Community service type:</b> ${esc(c.community_service_type || '—')}</p>
     <p><b>Service hours:</b> ${Number(c.completed_service_hours || 0).toFixed(2)} / ${Number(c.required_service_hours || 0).toFixed(2)}</p>
     <p><b>Service status:</b> ${esc(c.service_status || 'none')}</p>
     <p><b>Created:</b> ${esc(c.created_at || '—')}</p>`
  );

  $('#modalSubmit').remove();
}

async function editSection(id) {
  const s = sections.find(x => x.id == id);
  if (!s) return;

  const m = modal(
    'Edit section',
    `<form id="modalForm"><label>Grade<input name="grade" value="${esc(s.grade_level)}" required></label><label>Section name<input name="name" value="${esc(s.section_name)}" required></label><label>Strand<input name="strand" value="${esc(s.strand || '')}"></label></form>`
  );

  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm');
    if (!f.reportValidity()) return;
    try {
      await put(`/api/sections/${id}`, Object.fromEntries(new FormData(f).entries()));
      m.remove();
      await loadData();
      go('sections');
      toast('Section updated');
    } catch (e) {
      toast(e.message);
    }
  };
}

async function editStudent(id) {
  const s = students.find(x => x.id == id);
  if (!s) return;

  const m = modal(
    'Edit student',
    `<form id="modalForm">
      <label>Student number<input name="number" value="${esc(s.student_number || '')}" required></label>
      <label>First name<input name="first" value="${esc(s.first_name || '')}" required></label>
      <label>Last name<input name="last" value="${esc(s.last_name || '')}" required></label>
      <label>Grade<input name="grade" value="${esc(s.grade_level || '')}" required></label>
      <label>Section<select name="sectionId">${sections.map(x => `<option value="${x.id}" ${x.id == s.section_id ? 'selected' : ''}>G${esc(x.grade_level)} · ${esc(x.section_name)}</option>`).join('')}</select></label>
      <label>Guardian name<input name="guardian_name" value="${esc(s.guardian_name || '')}"></label>
      <label>Guardian contact<input name="guardian_contact" value="${esc(s.guardian_contact || '')}"></label>
      <label>Track ID (optional)<input name="track_id" value="${esc(s.track_id || '')}"></label>
      <label>Strand ID (optional)<input name="strand_id" value="${esc(s.strand_id || '')}"></label>
    </form>
    <p class="tiny muted">Changing section here will log a section assignment history entry.</p>`
  );

  $('#modalSubmit').onclick = async () => {
    const f = $('#modalForm');
    if (!f.reportValidity()) return;
    try {
      await put(`/api/students/${id}`, Object.fromEntries(new FormData(f).entries()));
      m.remove();
      await loadData();
      go('students');
      toast('Student updated');
    } catch (e) {
      toast(e.message);
    }
  };
}

$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target).entries());
  try {
    const r = await post('/api/auth/login', d);
    me = r.user;
    await loadData();
    showApp();
    await go('dashboard');
  } catch (err) {
    msg($('#authMsg'), err.message);
  }
};

$('#registerForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const r = await post('/api/auth/register-admin', Object.fromEntries(new FormData(e.target).entries()));
    msg($('#authMsg'), r.message);
    e.target.reset();
  } catch (err) {
    msg($('#authMsg'), err.message);
  }
};

$$('[data-auth]').forEach(b => {
  b.onclick = () => {
    $$('[data-auth]').forEach(x => x.classList.toggle('active', x === b));
    $('#loginForm').classList.toggle('hidden', b.dataset.auth !== 'login');
    $('#registerForm').classList.toggle('hidden', b.dataset.auth !== 'register');
    $('#authMsg').textContent = '';
  };
});

$('#nav').onclick = e => {
  const b = e.target.closest('[data-view]');
  if (b) go(b.dataset.view);
};

$('#content').onclick = async e => {
  const b = e.target.closest('[data-view],[data-modal],[data-attendance],[data-history],[data-case-details],[data-approve],[data-reject],[data-toggle-user],[data-activate-year],[data-edit-section],[data-delete-section],[data-student-edit]');
  if (!b) return;

  try {
    if (b.dataset.view) {
      go(b.dataset.view);
    } else if (b.dataset.modal) {
      openModal(b.dataset.modal);
    } else if (b.dataset.attendance) {
      logAttendance(b.dataset.attendance);
    } else if (b.dataset.history) {
      history(b.dataset.history);
    } else if (b.dataset.caseDetails) {
      details(b.dataset.caseDetails);
    } else if (b.dataset.approve) {
      await post(`/api/admin/verify/${b.dataset.approve}`, {});
      await loadData();
      go('accounts');
      toast('Administrator verified');
    } else if (b.dataset.reject) {
      await post(`/api/admin/reject/${b.dataset.reject}`, {});
      await loadData();
      go('accounts');
      toast('Registration rejected');
    } else if (b.dataset.toggleUser) {
      await put(`/api/users/${b.dataset.toggleUser}/status`, { status: b.dataset.status });
      await loadData();
      go('accounts');
    } else if (b.dataset.activateYear) {
      await post(`/api/years/${b.dataset.activateYear}/activate`, {});
      activeYear = null;
      await loadData();
      go('sections');
    } else if (b.dataset.editSection) {
      editSection(b.dataset.editSection);
    } else if (b.dataset.deleteSection && confirm('Delete this section? Linked records may prevent deletion.')) {
      await api(`/api/sections/${b.dataset.deleteSection}`, { method: 'DELETE' });
      await loadData();
      go('sections');
    } else if (b.dataset.studentEdit) {
      editStudent(b.dataset.studentEdit);
    }
  } catch (err) {
    toast(err.message);
  }
};

$('#content').onchange = e => {
  if (e.target.id === 'yearFilter') {
    activeYear = years.find(y => String(y.id) === e.target.value) || null;
    loadData().then(() => go('sections'));
    return;
  }

  const s = e.target.closest('[data-case-status]');
  if (s) {
    patch(`/api/violations/${s.dataset.caseStatus}`, { status: s.value })
      .then(async () => {
        await loadData();
        go('violations');
        toast('Case status updated');
      })
      .catch(err => toast(err.message));
  }
};

$('#logout').onclick = async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {}
  me = null;
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#loginForm').reset();
};

(async () => {
  try {
    const r = await api('/api/me');
    me = r.user;
    await loadData();
    showApp();
    await go('dashboard');
  } catch {}
})();

$('#content').addEventListener('click', async e => {
  const b = e.target.closest('[data-assign]');
  if (!b) return;

  try {
    const cur = await api('/api/teachers/' + b.dataset.assign + '/sections');
    const m = modal(
      'Assign sections',
      `<form id="modalForm"><label>Sections (school year ${esc(activeYear?.label || '')})<select name="sections" multiple size="8">${sections.map(s => `<option value="${s.id}" ${cur.includes(s.id) ? 'selected' : ''}>G${esc(s.grade_level)} · ${esc(s.section_name)}</option>`).join('')}</select></label></form>`
    );

    $('#modalSubmit').onclick = async () => {
      try {
        await put('/api/teachers/' + b.dataset.assign + '/sections', {
          sections: [...$('#modalForm').sections.selectedOptions].map(x => Number(x.value))
        });
        m.remove();
        toast('Sections updated');
      } catch (err) {
        toast(err.message);
      }
    };
  } catch (err) {
    toast(err.message);
  }
});

(async () => {
  try {
    const r = await api('/api/setup/status');
    if (!r.needsSetup) return;
    $('.tabs').classList.add('hidden');
    $('#loginForm').classList.add('hidden');
    $('#setupForm').classList.remove('hidden');
    $('#setupForm').onsubmit = async ev => {
      ev.preventDefault();
      try {
        await post('/api/setup', Object.fromEntries(new FormData(ev.target).entries()));
        location.reload();
      } catch (err) {
        msg($('#authMsg'), err.message);
      }
    };
  } catch {}
})();