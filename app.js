const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const RECORD_VIEWS = ['students', 'violations', 'service'];
const state = {
  user: null, csrf: '', setupRequired: false, setupKeyRequired: false, view: 'dashboard', page: 1, pageSize: 25,
  searches: { students: '', violations: '', service: '' },
  filters: { students: {}, violations: {}, service: {} },
  managementTab: 'school'
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const roleLabel = (role) => role === 'Teacher' ? 'Adviser' : role;
const recordSearch = (view = state.view) => state.searches[view] || '';
const recordFilters = (view = state.view) => state.filters[view] || {};
function resetRecordState() {
  state.searches = { students: '', violations: '', service: '' };
  state.filters = { students: {}, violations: {}, service: {} };
  state.page = 1;
}
function placementState(sections, current = {}) {
  const years = [...new Map(sections.map(section => [
    String(section.school_year_id),
    { id: String(section.school_year_id), name: section.school_year, active: section.school_year_active }
  ])).values()];
  const preferredYear = years.find(year => year.active) || years[0];
  const yearId = years.some(year => year.id === String(current.school_year_id))
    ? String(current.school_year_id) : (preferredYear?.id || '');
  const grades = [...new Set(sections.filter(section =>
    String(section.school_year_id) === yearId).map(section => String(section.grade)))];
  const grade = grades.includes(String(current.grade)) ? String(current.grade) : (grades[0] || '');
  const availableSections = sections.filter(section =>
    String(section.school_year_id) === yearId && String(section.grade) === grade);
  const sectionId = availableSections.some(section => String(section.id) === String(current.section_id))
    ? String(current.section_id) : (String(availableSections[0]?.id || ''));
  return { years, yearId, grades, grade, availableSections, sectionId };
}
function placementFields(sections, current = {}) {
  const selection = placementState(sections, current);
  if (!selection.years.length) return '<p class="form-hint field--wide">No active sections are available. Configure the school year and sections first.</p>';
  return `<div class="form-grid field--wide" data-placement data-sections="${escapeHtml(JSON.stringify(sections))}">
    <label class="field"><span>School year</span><select name="school_year_id" data-placement-year required>${selection.years.map(year => `<option value="${year.id}" ${year.id === selection.yearId ? 'selected' : ''}>${escapeHtml(year.name)}${year.active ? ' · Active' : ''}</option>`).join('')}</select></label>
    <label class="field"><span>Grade level</span><select name="grade" data-placement-grade required>${selection.grades.map(grade => `<option ${grade === selection.grade ? 'selected' : ''}>${escapeHtml(grade)}</option>`).join('')}</select></label>
    <label class="field field--wide"><span>Section</span><select name="section_id" data-placement-section required>${selection.availableSections.map(section => `<option value="${section.id}" ${String(section.id) === selection.sectionId ? 'selected' : ''}>${escapeHtml(section.name)}${section.strand ? ` · ${escapeHtml(section.strand)}` : ''}</option>`).join('')}</select></label>
  </div>`;
}
function refreshPlacement(container, reset) {
  const current = {
    school_year_id: $('[data-placement-year]', container).value,
    grade: $('[data-placement-grade]', container).value,
    section_id: $('[data-placement-section]', container).value
  };
  if (reset === 'year') { current.grade = ''; current.section_id = ''; }
  if (reset === 'grade') current.section_id = '';
  const template = document.createElement('template');
  template.innerHTML = placementFields(JSON.parse(container.dataset.sections), current);
  const replacement = template.content.firstElementChild;
  container.innerHTML = replacement.innerHTML;
}
const today = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
};
const dateLabel = (value) => value ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
const caseNumber = (id) => `SVTS-${String(id).padStart(6, '0')}`;
const queryString = (obj) => new URLSearchParams(Object.entries(obj).filter(([, value]) => value !== '' && value != null)).toString();

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  const init = { method, headers, credentials: 'same-origin' };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Cannot reach the SVTS server. Start server.py and try again.');
    }
    throw error;
  }
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    if (contentType.includes('application/json')) {
      const result = await response.json();
      message = result.error || message;
    }
    if (response.status === 401 && state.user) {
      state.user = null;
      state.csrf = '';
      resetRecordState();
      renderAuth('login');
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (contentType.includes('text/csv') || contentType.includes('spreadsheetml')) return response.blob();
  return response.status === 204 ? null : response.json();
}

function showLanding(errorMessage = '') {
  $('#appView').hidden = true;
  $('#authView').hidden = true;
  $('#landingView').hidden = false;
  window.scrollTo(0, 0);
  const alert = $('#landingError');
  if (alert) {
    alert.textContent = errorMessage ? `The secure workspace could not be checked: ${errorMessage}` : '';
    alert.hidden = !errorMessage;
  }
}

function toast(message, type = '') {
  const host = $('#toastHost');
  const node = document.createElement('div');
  node.className = `toast ${type ? `toast--${type}` : ''}`;
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), 4000);
}

function showDialog(title, body, footer = '') {
  $('#dialogHost').innerHTML = `<div class="dialog-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialogTitle"><header class="dialog__header"><div><span class="eyebrow">SVTS WORKSPACE</span><h2 id="dialogTitle">${escapeHtml(title)}</h2></div><button class="dialog__close" type="button" data-action="close-dialog" aria-label="Close dialog">×</button></header><div class="dialog__body">${body}</div>${footer ? `<footer class="dialog__footer">${footer}</footer>` : ''}</section></div>`;
  $('input,select,textarea', $('#dialogHost'))?.focus();
}
function closeDialog() { $('#dialogHost').innerHTML = ''; }

function renderAuth(mode, message = '') {
  $('#landingView').hidden = true;
  $('#appView').hidden = true;
  window.scrollTo(0, 0);
  const views = {
    setup: {
      title: 'Welcome to SVTS',
      subtitle: 'Set up the school’s first secure administrator account.',
      form: `<label class="field"><span>Administrator name</span><input name="name" autocomplete="name" required maxlength="120"></label>
        <label class="field"><span>School email</span><input name="email" type="email" autocomplete="email" required maxlength="254"></label>
        ${state.setupKeyRequired ? '<label class="field"><span>One-time setup key</span><input name="setup_key" type="password" autocomplete="off" required maxlength="256"></label>' : ''}
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></label>
        <p class="form-hint">Use 12 to 1,024 characters. Passwords are stored as salted PBKDF2 hashes.</p>`,
      button: 'Create administrator',
      id: 'setupForm'
    },
    login: {
      title: 'Welcome back',
      subtitle: 'Advisers and administrators sign in with their verified school accounts.',
      form: `<label class="field"><span>School email</span><input name="email" type="email" autocomplete="username" required maxlength="254"></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label>`,
      button: 'Sign in securely',
      id: 'loginForm'
    },
    register: {
      title: 'Request administrator access',
      subtitle: 'New requests stay pending until a verified administrator reviews them.',
      form: `<label class="field"><span>Full name</span><input name="name" autocomplete="name" required maxlength="120"></label>
        <label class="field"><span>School email</span><input name="email" type="email" autocomplete="email" required maxlength="254"></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></label>`,
      button: 'Submit for verification',
      id: 'registerForm'
    },
    adviserRegister: {
      title: 'Request adviser access',
      subtitle: 'Your request stays pending until an administrator assigns your section and approves access.',
      form: `<label class="field"><span>Full name</span><input name="name" autocomplete="name" required maxlength="120"></label>
        <label class="field"><span>School email</span><input name="email" type="email" autocomplete="email" required maxlength="254"></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required></label>
        <p class="form-hint">Use 12 to 1,024 characters. Your adviser account cannot sign in until approved.</p>`,
      button: 'Request adviser access',
      id: 'adviserRegisterForm'
    }
  };
  const view = views[mode];
  $('#authView').hidden = false;
  $('#authView').innerHTML = `<div class="auth-layout">
    <section class="auth-story">
      <a class="brand brand--auth" href="#"><img class="brand__logo" src="/assets/svts-logo.jpg" alt=""><span class="brand__name"><strong>SVTS</strong><small>San Jose Litex SHS</small></span></a>
      <div class="auth-story__content"><span class="auth-kicker"><i></i> SCHOOL SERVICES · SECURE RECORDS</span>
        <h1>Care, clarity,<br><em>accountability.</em></h1>
        <p>A considered workspace for authorized school personnel to maintain student support and violation records.</p>
        <div class="auth-values"><span>01 <b>Confidential records</b></span><span>02 <b>Human-led decisions</b></span><span>03 <b>Clear service tracking</b></span></div>
      </div>
      <div class="auth-story__foot">SAN JOSE LITEX SENIOR HIGH SCHOOL <span>•</span> RODRIGUEZ, RIZAL</div>
      <span class="auth-orbit auth-orbit--one"></span><span class="auth-orbit auth-orbit--two"></span>
    </section>
    <section class="auth-panel"><div class="auth-panel__inner">
      <span class="eyebrow">${mode === 'setup' ? 'FIRST-RUN SETUP' : mode === 'register' ? 'ACCOUNT VERIFICATION' : mode === 'adviserRegister' ? 'ADVISER ACCESS REQUEST' : 'AUTHORIZED PERSONNEL'}</span>
      <h2>${view.title}</h2><p class="auth-subtitle">${view.subtitle}</p>
      ${message ? `<div class="notice notice--info">${escapeHtml(message)}</div>` : ''}
      <div id="authError" class="notice notice--error" hidden></div>
      <form id="${view.id}" class="auth-form">${view.form}<button class="button button--primary button--wide" type="submit"><span>${view.button}</span><b>→</b></button></form>
      ${mode === 'login' ? '<button class="auth-link" data-action="adviser-register" type="button">Request adviser access <span>→</span></button><button class="auth-link" data-action="register" type="button">Request an administrator account <span>→</span></button>' : mode === 'register' || mode === 'adviserRegister' ? '<button class="auth-link" data-action="login" type="button">Back to sign in <span>→</span></button>' : ''}
      <button class="auth-link" data-return-home type="button">← Return to public overview</button>
      <p class="auth-privacy"><span>▣</span> Access and changes are restricted to verified school personnel.</p>
    </div><span class="auth-panel__mark">SVTS / ACCESS PORTAL</span></section>
  </div>`;
}

async function authSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const button = $('button[type=submit]', form);
  button.disabled = true;
  try {
    if (form.id === 'setupForm') {
      if (data.password.length < 12) throw new Error('Password must be at least 12 characters.');
      const result = await api('/api/setup', { method: 'POST', body: data });
      state.user = result.user; state.csrf = result.csrf;
      state.setupRequired = false;
      state.setupKeyRequired = false;
    } else if (form.id === 'loginForm') {
      const result = await api('/api/login', { method: 'POST', body: data });
      state.user = result.user; state.csrf = result.csrf;
      state.setupRequired = false;
    } else if (form.id === 'adviserRegisterForm') {
      const result = await api('/api/request-adviser', { method: 'POST', body: data });
      renderAuth('login', result.message);
      return;
    } else {
      const result = await api('/api/register-admin', { method: 'POST', body: data });
      renderAuth('login', result.message);
      return;
    }
    enterApp();
  } catch (error) {
    const node = $('#authError');
    node.textContent = error.message;
    node.hidden = false;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

const navigation = [
  { id: 'dashboard', label: 'Dashboard', symbol: '◫', group: 'MODULES' },
  { id: 'students', label: 'Students', symbol: '♙' },
  { id: 'violations', label: 'Violations', symbol: '▤' },
  { id: 'service', label: 'Community Service', symbol: '◷' },
  { id: 'management', label: 'School setup', symbol: '⚙', admin: true, group: 'ADMINISTRATION' }
];

function enterApp() {
  $('#landingView').hidden = true;
  $('#authView').hidden = true;
  $('#appView').hidden = false;
  renderNavigation();
  renderProfile();
  loadView('dashboard');
}

function renderNavigation() {
  const visible = navigation.filter(item => !item.admin || state.user.role === 'Administrator');
  let html = '';
  let group = '';
  visible.forEach(item => {
    if (item.group && item.group !== group) {
      group = item.group;
      html += `<span class="nav-group">${escapeHtml(group)}</span>`;
    } else if (item.id === 'students') {
      html += '<span class="nav-group nav-group--spaced">RECORDS</span>';
    }
    html += `<button class="nav-item ${state.view === item.id ? 'is-active' : ''}" data-view="${item.id}" type="button"><span class="nav-item__icon">${item.symbol}</span><span>${item.label}</span>${state.view === item.id ? '<i></i>' : ''}</button>`;
  });
  $('#navigation').innerHTML = html;
}

function renderProfile() {
  const user = state.user;
  const profile = `<span class="profile__avatar">${escapeHtml(initials(user.name))}</span><span class="profile__meta"><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(roleLabel(user.role))}</small></span><span class="profile__status" title="Verified account"></span>`;
  $('#profile').innerHTML = profile;
  $('#topProfile').innerHTML = `<span class="top-profile__avatar">${escapeHtml(initials(user.name))}</span><span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(roleLabel(user.role))}</small></span>`;
}

async function loadView(view, options = {}) {
  const searchWasFocused = document.activeElement?.matches('[data-search]') || false;
  const selectionStart = searchWasFocused ? document.activeElement.selectionStart : null;
  const selectionEnd = searchWasFocused ? document.activeElement.selectionEnd : null;
  state.view = view;
  state.page = options.keepPage ? state.page : 1;
  if (RECORD_VIEWS.includes(view) && !options.keepSearch) state.searches[view] = '';
  renderNavigation();
  $('#sidebar').classList.remove('sidebar--open');
  $('#sidebarScrim').classList.remove('is-visible');
  const content = $('#pageContent');
  content.innerHTML = '<div class="loading-state"><span class="spinner"></span><span>Loading secure records…</span></div>';
  try {
    if (view === 'dashboard') await dashboardPage(content);
    else if (view === 'students') await studentsPage(content);
    else if (view === 'violations') await violationsPage(content);
    else if (view === 'service') await servicePage(content);
    else if (view === 'management') await managementPage(content);
    if (searchWasFocused) {
      const input = $('[data-search]', content);
      input?.focus();
      if (input?.setSelectionRange && selectionStart !== null) input.setSelectionRange(selectionStart, selectionEnd);
    }
  } catch (error) {
    content.innerHTML = `<div class="page-error"><span>!</span><div><h2>Couldn’t load this workspace</h2><p>${escapeHtml(error.message)}</p><button class="button button--outline" data-action="reload-view">Try again</button></div></div>`;
  }
}

function pageHeading(kicker, title, description, actions = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${escapeHtml(kicker)}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div><div class="page-heading__actions">${actions}</div></div>`;
}

function metricCard(label, value, note, color, icon, view = '') {
  const tag = view ? 'button' : 'article';
  return `<${tag} class="metric-card metric-card--${color}" ${view ? `type="button" data-view="${view}"` : ''}><div class="metric-card__top"><span>${escapeHtml(label)}</span><i>${icon}</i></div><strong>${Number(value || 0).toLocaleString()}</strong><small>${escapeHtml(note)}</small><span class="metric-card__wash"></span></${tag}>`;
}

async function dashboardPage(host) {
  const data = await api('/api/dashboard');
  const v = data.violations || {};
  const cs = data.service || {};
  const admin = state.user.role === 'Administrator';
  const cards = [
    metricCard('Active students', data.students, 'In your authorized school sections', 'blue', '♙', 'students'),
    metricCard('Recorded cases', v.total || 0, 'All preserved violation records', 'coral', '▤', 'violations'),
    metricCard('Minor cases', v.minor || 0, 'Recorded classification', 'gold', '◌', 'violations'),
    metricCard('Major cases', v.major || 0, 'Recorded classification', 'violet', '◆', 'violations')
  ];
  cards.push(metricCard('Open cases', v.open || 0, 'Awaiting case status update', 'mint', '◷', 'violations'));
  cards.push(metricCard('Service assignments', cs.total || 0, `${cs.completed || 0} completed`, 'aqua', '✳', 'service'));
  if (admin) cards.push(metricCard('Admin requests', data.pending_admins || 0, 'Awaiting verification', 'rose', '✉'));
  const recent = data.recent?.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>CASE ID</th><th>STUDENT</th><th>OFFENSE</th><th>CLASSIFICATION</th><th>DATE / TIME</th><th>STATUS</th></tr></thead><tbody>${data.recent.map(row => `<tr><td class="mono">${escapeHtml(row.case_number || caseNumber(row.id))}</td><td><strong>${escapeHtml(row.first_name)} ${escapeHtml(row.last_name)}</strong></td><td>${escapeHtml(row.category)}</td><td>${badge(row.severity)}</td><td>${dateLabel(row.incident_date)}<small class="table-sub">${escapeHtml(row.incident_time || 'Time not recorded')}</small></td><td>${badge(row.status, 'status')}</td></tr>`).join('')}</tbody></table></div>` : emptyState('A clear start', 'Violation records will appear here when authorized personnel add them.');
  host.innerHTML = `${pageHeading('SCHOOL SNAPSHOT', 'Good day, ' + state.user.name.split(' ')[0], 'A clear overview of student support activity and record status.', '<button class="button button--primary" data-action="new-violation">＋ Record violation</button>')}
    <div class="metric-grid">${cards.join('')}</div>
    <div class="section-heading"><div><span class="eyebrow">LATEST ACTIVITY</span><h2>Recent violations</h2><p>Visible only for sections you are authorized to access.</p></div><button class="text-button" data-view="violations">View all violations <span>→</span></button></div>
    <section class="surface-card">${recent}</section>
    <div class="human-note"><span class="human-note__icon">✦</span><p><strong>Records support people, not replace them.</strong><br>Case outcomes and disciplinary decisions remain with designated school personnel.</p></div>`;
  setYearChip();
}

function badge(value, type = '') {
  const cls = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `<span class="badge ${type ? `badge--${type}` : ''} badge--${cls}">${escapeHtml(value || '—')}</span>`;
}
function emptyState(title, message) {
  return `<div class="empty-state"><span class="empty-state__symbol">✦</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`;
}

function reportActions(module, primary = '') {
  const exportButton = state.user.role === 'Administrator'
    ? `<button class="button button--outline" data-action="export-records" data-module="${module}">Export Excel</button>`
    : '';
  return `<div class="record-actions">${primary}${exportButton}<button class="button button--outline" data-action="print-records" data-module="${module}">Print</button></div>`;
}

function sectionFilters(sections, filters) {
  const years = [...new Map(sections.map(section => [
    String(section.school_year_id),
    { id: String(section.school_year_id), name: section.school_year }
  ])).values()];
  const sectionOptionLabel = state.user.role === 'Administrator' ? 'All sections' : 'All assigned sections';
  return `<select data-filter="school_year_id" aria-label="School year"><option value="">All school years</option>${years.map(year => `<option value="${escapeHtml(year.id)}" ${String(filters.school_year_id || '') === year.id ? 'selected' : ''}>${escapeHtml(year.name)}</option>`).join('')}</select>
    <select data-filter="grade" aria-label="Grade level"><option value="">All grade levels</option>${['11','12'].map(grade => `<option value="${grade}" ${filters.grade === grade ? 'selected' : ''}>Grade ${grade}</option>`).join('')}</select>
    <select data-filter="section_id" aria-label="Section"><option value="">${sectionOptionLabel}</option>${sections.map(section => `<option value="${section.id}" ${String(filters.section_id || '') === String(section.id) ? 'selected' : ''}>${escapeHtml(section.school_year)} · Grade ${escapeHtml(section.grade)} · ${escapeHtml(section.name)}</option>`).join('')}</select>`;
}

function dateFilters(filters, label = 'Date') {
  return `<label class="filter-field"><span>${label} from</span><input data-filter="from" type="date" aria-label="${label} from" value="${escapeHtml(filters.from || '')}"></label>
    <label class="filter-field"><span>${label} to</span><input data-filter="to" type="date" aria-label="${label} to" value="${escapeHtml(filters.to || '')}"></label>`;
}

function recordToolbar(module, result, placeholder, filters) {
  const activeFilters = Object.entries(filters).filter(([key, value]) => key !== 'content' && value).length;
  return `<div class="table-toolbar table-toolbar--wrap">
    <label class="search-box"><span>⌕</span><input data-search placeholder="${placeholder}" value="${escapeHtml(recordSearch(module))}"></label>
    <span class="result-count">${result.total} matching records</span>
    <details class="record-filters" open><summary>Advanced filters${activeFilters ? ` <span>${activeFilters} active</span>` : ''}</summary>
      <div class="filter-row">${filters.content}</div>
      <button class="text-button record-filters__clear" data-action="clear-record-filters" data-module="${module}">Clear filters</button>
    </details>
  </div>`;
}

async function studentsPage(host) {
  const filters = recordFilters('students');
  const params = queryString({ page: state.page, page_size: state.pageSize, q: recordSearch('students'), ...filters });
  const [result, { items: sections }] = await Promise.all([
    api(`/api/students?${params}`), api('/api/sections')
  ]);
  const filterContent = `${sectionFilters(sections, filters)}
    <select data-filter="status" aria-label="Student status"><option value="">All statuses</option><option value="active" ${filters.status === 'active' ? 'selected' : ''}>Active</option><option value="archived" ${filters.status === 'archived' ? 'selected' : ''}>Archived</option></select>
    ${dateFilters(filters, 'Added')}`;
  const rows = result.items.map(item => `<tr><td class="mono">${escapeHtml(item.student_no)}</td><td><strong>${escapeHtml(item.first_name)} ${escapeHtml(item.last_name)}</strong></td><td>${escapeHtml(item.grade)}</td><td>${escapeHtml(item.section)}</td><td>${escapeHtml(item.school_year)}</td><td>${item.active ? badge('Active', 'status') : badge('Archived', 'status')}</td></tr>`).join('');
  host.innerHTML = `${pageHeading('STUDENT RECORDS', 'Student directory', 'Browse school-managed student records. New student records are added while recording a violation.', reportActions('students'))}
    <section class="surface-card table-card">${recordToolbar('students', result, 'Search name or student number', { ...filters, content: filterContent })}
    ${result.items.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>STUDENT NO.</th><th>STUDENT</th><th>GRADE</th><th>SECTION</th><th>SCHOOL YEAR</th><th>STATUS</th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('No student records yet', 'Create the first student record from the Record violation form after setting up a school section and violation category.')}
    ${pagination(result)}</section>`;
}

async function violationsPage(host) {
  const filters = recordFilters('violations');
  const query = queryString({ page: state.page, page_size: state.pageSize, q: recordSearch('violations'), ...filters });
  const [result, [sections, categories]] = await Promise.all([
    api(`/api/violations?${query}`),
    Promise.all([api('/api/sections'), api('/api/categories')])
  ]);
  const rows = result.items.map(row => `<tr><td class="mono">${escapeHtml(row.case_number || caseNumber(row.id))}</td><td><strong>${escapeHtml(row.first_name)} ${escapeHtml(row.last_name)}</strong><small class="table-sub">${escapeHtml(row.student_no)} · Grade ${escapeHtml(row.grade)} ${escapeHtml(row.section)}</small></td><td><strong>${escapeHtml(row.category)}</strong><small class="table-sub">${escapeHtml(row.location || 'Location not recorded')}</small></td><td>${badge(row.severity)}</td><td>${dateLabel(row.incident_date)}<small class="table-sub">${escapeHtml(row.incident_time || 'Time not recorded')}</small></td><td>${badge(row.status, 'status')}</td>${state.user.role === 'Administrator' ? `<td><button class="icon-button" data-action="edit-violation" data-id="${row.id}" title="Update violation">✎</button></td>` : ''}</tr>`).join('');
  const filterContent = `${sectionFilters(sections.items, filters)}
    <select data-filter="severity" aria-label="Classification"><option value="">All classifications</option>${['Minor','Major'].map(value => `<option value="${value}" ${filters.severity === value ? 'selected' : ''}>${value}</option>`).join('')}</select>
    <select data-filter="status" aria-label="Case status"><option value="">All statuses</option>${['Open','Under Review','Resolved','Closed','Referred'].map(value => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select>
    <select data-filter="category_id" aria-label="Offense category"><option value="">All offenses</option>${categories.items.map(category => `<option value="${category.id}" ${String(filters.category_id || '') === String(category.id) ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}</select>
    ${dateFilters(filters, 'Incident date')}`;
  const primary = '<button class="button button--primary" data-action="new-violation">＋ Record violation</button>';
  host.innerHTML = `${pageHeading('VIOLATION REGISTER', 'Violations', 'Search, review, and follow up on recorded student violations.', reportActions('violations', primary))}
    <section class="surface-card table-card">${recordToolbar('violations', result, 'Search case, student, offense, or location', { ...filters, content: filterContent })}
    ${result.items.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>CASE ID</th><th>STUDENT</th><th>VIOLATION</th><th>CLASSIFICATION</th><th>DATE / TIME</th><th>STATUS</th>${state.user.role === 'Administrator' ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('No violations found', 'Adjust the filters or record a violation when appropriate.')}
    ${pagination(result)}</section>`;
}

async function servicePage(host) {
  const filters = recordFilters('service');
  const params = queryString({ page: state.page, page_size: state.pageSize, q: recordSearch('service'), ...filters });
  const [result, { items: sections }] = await Promise.all([
    api(`/api/service?${params}`), api('/api/sections')
  ]);
  const filterContent = `${sectionFilters(sections, filters)}
    <select data-filter="status" aria-label="Service status"><option value="">All statuses</option>${['Pending','In Progress','Completed'].map(value => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select>
    ${dateFilters(filters, 'Assigned')}`;
  const rows = result.items.map(item => `<tr><td><strong>${escapeHtml(item.first_name)} ${escapeHtml(item.last_name)}</strong><small class="table-sub">${escapeHtml(item.student_no)} · Grade ${escapeHtml(item.grade)} ${escapeHtml(item.section)}</small></td><td>${escapeHtml(item.description || 'Community service')}</td><td><strong>${item.completed_days}/${item.required_days}</strong><small class="table-sub">${item.remaining_days} days remaining</small></td><td><strong>${Number(item.completed_hours).toFixed(1)}/${Number(item.required_hours).toFixed(1)} h</strong><small class="table-sub">${Number(item.remaining_hours).toFixed(1)} hours remaining</small></td><td>${badge(item.status, 'status')}</td><td><button class="button button--outline button--small" data-action="attendance" data-id="${item.id}">＋ Attendance</button>${state.user.role === 'Administrator' ? `<button class="icon-button" title="Edit assignment" data-action="edit-service" data-id="${item.id}">✎</button>` : ''}<button class="icon-button" title="Attendance history" data-action="history" data-id="${item.id}">◷</button></td></tr>`).join('');
  const primary = state.user.role === 'Administrator' ? '<button class="button button--primary" data-action="new-service">＋ Assign service</button>' : '';
  host.innerHTML = `${pageHeading('COMMUNITY SERVICE', 'Community Service', 'Monitor required days and hours, with attendance recorded to the database.', reportActions('service', primary))}
    <div class="human-note human-note--mint"><span class="human-note__icon">◷</span><p><strong>Completion requires both targets.</strong><br>An assignment is only completed when required days and hours are both met.</p></div>
    <section class="surface-card table-card">${recordToolbar('service', result, 'Search student, student no., case, or assignment', { ...filters, content: filterContent })}
    ${result.items.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>STUDENT</th><th>ASSIGNMENT</th><th>DAYS</th><th>HOURS</th><th>STATUS</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : emptyState('No service assignments', 'Adjust the filters or create a service assignment when appropriate.')}
    ${pagination(result)}</section>`;
}

async function managementPage(host) {
  const tabs = [
    ['school', 'School setup'], ['sections', 'Sections'], ['categories', 'Offense catalog'],
    ['accounts', 'Staff accounts'], ['adviser-requests', 'Adviser requests'],
    ['requests', 'Admin requests'], ['audit', 'Audit history']
  ];
  const toolbar = `${pageHeading('ADMINISTRATION', 'School setup', 'Manage the structures, accounts and policies used across records.', '<span class="admin-only-note">Administrator access</span>')}
    <div class="tabs">${tabs.map(([id, label]) => `<button class="tab ${state.managementTab === id ? 'is-active' : ''}" data-tab="${id}">${label}</button>`).join('')}</div>`;
  host.innerHTML = `${toolbar}<div id="managementPanel"><div class="loading-state"><span class="spinner"></span></div></div>`;
  const panel = $('#managementPanel');
  const tab = state.managementTab;
  if (tab === 'school') {
    const [years, settings] = await Promise.all([api('/api/school-years'), api('/api/settings')]);
    panel.innerHTML = `<div class="management-grid"><section class="surface-card management-card"><div class="card-heading"><div><span class="eyebrow">ACADEMIC CALENDAR</span><h2>School years</h2><p>Keep yearly sections and their records distinct.</p></div><button class="button button--primary button--small" data-action="new-year">＋ Add year</button></div>${years.items.length ? years.items.map(year => `<div class="list-row"><span><strong>${escapeHtml(year.name)}</strong><small>${year.active ? 'Current school year' : 'Historical year'}</small></span><span>${year.active ? badge('Active', 'status') : `<button class="text-button" data-action="activate-year" data-id="${year.id}" data-name="${escapeHtml(year.name)}">Set active →</button>`}</span><button class="icon-button" title="Edit school year" data-action="edit-year" data-id="${year.id}" data-name="${escapeHtml(year.name)}" data-active="${year.active ? 'true' : 'false'}">✎</button></div>`).join('') : emptyState('No school years', 'Create a school year before adding sections.')}</section>
      <section class="surface-card management-card"><div class="card-heading"><div><span class="eyebrow">SCHOOL PROFILE</span><h2>Institution details</h2><p>Shown in school reports and exports.</p></div></div><form data-form="settings" class="form-grid"><label class="field field--wide"><span>School name</span><input name="school_name" value="${escapeHtml(settings.settings.school_name || 'San Jose Litex Senior High School')}" required maxlength="200"></label><label class="field field--wide"><span>Address</span><input name="address" value="${escapeHtml(settings.settings.address || '')}" maxlength="200"></label><label class="field"><span>Principal</span><input name="principal" value="${escapeHtml(settings.settings.principal || '')}" maxlength="200"></label><label class="field"><span>Guidance contact</span><input name="guidance" value="${escapeHtml(settings.settings.guidance || '')}" maxlength="200"></label><button class="button button--primary field--wide" type="submit">Save school profile</button></form></section></div>`;
  } else if (tab === 'sections') {
    const [years, sections] = await Promise.all([api('/api/school-years'), api('/api/sections')]);
    panel.innerHTML = `<section class="surface-card table-card"><div class="card-heading"><div><span class="eyebrow">ACADEMIC STRUCTURE</span><h2>Sections</h2><p>Section names belong to a school year; historical references are protected.</p></div><button class="button button--primary button--small" data-action="new-section" ${years.items.length ? '' : 'disabled'}>＋ Add section</button></div>${sections.items.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>SCHOOL YEAR</th><th>GRADE</th><th>SECTION</th><th>STRAND</th><th></th></tr></thead><tbody>${sections.items.map(s => `<tr><td>${escapeHtml(s.school_year)}</td><td>${escapeHtml(s.grade)}</td><td><strong>${escapeHtml(s.name)}</strong></td><td>${escapeHtml(s.strand)}</td><td><button class="icon-button" title="Edit section" data-action="edit-section" data-id="${s.id}">✎</button><button class="icon-button icon-button--warn" data-action="delete-section" data-id="${s.id}">×</button></td></tr>`).join('')}</tbody></table></div>` : emptyState('No sections configured', 'Add a school year, then create its sections.')}</section>`;
  } else if (tab === 'categories') {
    const result = await api('/api/categories');
    panel.innerHTML = `<section class="surface-card management-card"><div class="card-heading"><div><span class="eyebrow">DISCIPLINARY POLICY</span><h2>Offense catalog</h2><p>Classification is entered by staff based on school policy; SVTS does not determine guilt.</p></div><button class="button button--primary button--small" data-action="new-category">＋ Add offense</button></div>${result.items.length ? result.items.map(item => `<div class="list-row"><span class="category-mark category-mark--${item.severity.toLowerCase()}"></span><span class="list-row__expand"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description || 'No description')}</small></span>${badge(item.severity)}<button class="icon-button" data-action="edit-category" data-id="${item.id}">✎</button></div>`).join('') : emptyState('Catalog is ready for setup', 'Add the school-approved offense categories and classifications.')}</section>`;
  } else if (tab === 'accounts') {
    const result = await api('/api/users');
    panel.innerHTML = `<section class="surface-card management-card"><div class="card-heading"><div><span class="eyebrow">AUTHORIZED PERSONNEL</span><h2>Staff accounts</h2><p>Adviser accounts appear here after an access request is approved and a section is assigned.</p></div></div>${result.items.length ? result.items.map(u => `<div class="list-row"><span class="profile__avatar">${escapeHtml(initials(u.name))}</span><span class="list-row__expand"><strong>${escapeHtml(u.name)}</strong><small>${escapeHtml(u.email)} · ${escapeHtml(roleLabel(u.role))}</small>${u.role === 'Teacher' ? `<small>Access section: ${escapeHtml(u.access_section || 'None assigned')}${Number(u.section_count) > 1 ? ' · Additional legacy assignments are not in use' : ''}</small>` : ''}</span>${badge(u.status, 'status')}${u.role === 'Teacher' ? `<button class="button button--outline button--small" data-action="toggle-user" data-id="${u.id}" data-status="${u.status === 'Active' ? 'Suspended' : 'Active'}">${u.status === 'Active' ? 'Suspend' : 'Reactivate'}</button>` : ''}</div>`).join('') : emptyState('No staff accounts', 'Approved staff accounts will appear here.')}</section>`;
  } else if (tab === 'adviser-requests') {
    const [result, sections] = await Promise.all([api('/api/adviser-requests'), api('/api/sections')]);
    panel.innerHTML = `<section class="surface-card management-card"><div class="card-heading"><div><span class="eyebrow">IDENTITY REVIEW</span><h2>Adviser access requests</h2><p>Assign one active section before approval. Approved advisers can access only that section.</p></div><span class="count-pill">${result.items.length} pending</span></div>${result.items.length ? result.items.map(request => `<article class="adviser-request-card" data-adviser-request data-id="${request.id}"><div><strong>${escapeHtml(request.name)}</strong><small>${escapeHtml(request.email)} · Requested ${new Date(request.created_at).toLocaleDateString()}</small></div>${placementFields(sections.items)}<div class="adviser-request-card__actions"><button class="button button--outline button--small" data-action="decide-adviser" data-decision="reject">Reject</button><button class="button button--primary button--small" data-action="decide-adviser" data-decision="approve" ${sections.items.length ? '' : 'disabled'}>Assign section &amp; approve</button></div></article>`).join('') : emptyState('No pending requests', 'New adviser access requests will appear here.')}</section>`;
  } else if (tab === 'requests') {
    const result = await api('/api/admin-registrations');
    panel.innerHTML = `<section class="surface-card management-card"><div class="card-heading"><div><span class="eyebrow">IDENTITY REVIEW</span><h2>Administrator requests</h2><p>Approval is recorded with the reviewer and timestamp.</p></div><span class="count-pill">${result.items.length} pending</span></div>${result.items.length ? result.items.map(u => `<div class="list-row"><span class="list-row__expand"><strong>${escapeHtml(u.name)}</strong><small>${escapeHtml(u.email)} · Requested ${new Date(u.created_at).toLocaleDateString()}</small></span><button class="button button--outline button--small" data-action="decide-admin" data-decision="reject" data-id="${u.id}">Reject</button><button class="button button--primary button--small" data-action="decide-admin" data-decision="approve" data-id="${u.id}">Approve</button></div>`).join('') : emptyState('No pending requests', 'Administrator registrations appear here for verification.')}</section>`;
  } else {
    const result = await api('/api/audit');
    panel.innerHTML = `<section class="surface-card table-card"><div class="card-heading"><div><span class="eyebrow">ACCOUNTABILITY</span><h2>Audit history</h2><p>Recent important account and record changes.</p></div></div>${result.items.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>WHEN</th><th>PERSON</th><th>ACTION</th><th>RECORD</th><th>DETAILS</th></tr></thead><tbody>${result.items.map(a => `<tr><td>${new Date(a.created_at).toLocaleString()}</td><td>${escapeHtml(a.actor || 'Account removed')}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.entity)} ${escapeHtml(a.entity_id)}</td><td>${escapeHtml(a.details)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('No activity logged yet', 'Important actions are recorded as the system is used.')}</section>`;
  }
}

function pagination(result) {
  const pages = Math.max(1, Math.ceil(result.total / result.page_size));
  return `<div class="pagination"><span>Showing ${result.total ? (result.page - 1) * result.page_size + 1 : 0}–${Math.min(result.page * result.page_size, result.total)} of ${result.total}</span><div><label>Rows <select data-page-size>${[10,25,50,100].map(size => `<option ${result.page_size === size ? 'selected' : ''}>${size}</option>`).join('')}</select></label><button data-action="page" data-page="${Math.max(1, result.page - 1)}" ${result.page <= 1 ? 'disabled' : ''}>←</button><span>Page ${result.page} of ${pages}</span><button data-action="page" data-page="${Math.min(pages, result.page + 1)}" ${result.page >= pages ? 'disabled' : ''}>→</button></div></div>`;
}

async function setYearChip() {
  if (state.user.role !== 'Administrator') return;
  try {
    const result = await api('/api/school-years');
    const active = result.items.find(year => year.active);
    $('#activeYear').textContent = active ? `School year ${active.name}` : 'School year not selected';
  } catch { $('#activeYear').textContent = 'Secure staff workspace'; }
}

async function openViolationForm(item = null) {
  const [students, categories, sections] = await Promise.all([
    api('/api/students?page=1&page_size=100'), api('/api/categories'), api('/api/sections')
  ]);
  if (!categories.items.length) {
    toast('Add an approved violation category before recording violations.', 'error'); return;
  }
  if (!item && !sections.items.length) {
    toast('Create a school section before registering a student and recording a violation.', 'error'); return;
  }
  const startsWithNewStudent = !item && students.items.length === 0;
  const studentField = item
    ? `<label class="field field--wide"><span>Student</span><select name="student_id" required>${students.items.map(s => `<option value="${s.id}" ${String(item.student_id) === String(s.id) ? 'selected' : ''}>${escapeHtml(s.last_name)}, ${escapeHtml(s.first_name)} · ${escapeHtml(s.student_no)} · ${escapeHtml(s.section)}</option>`).join('')}</select></label>`
    : `<label class="field field--wide"><span>Student record</span><select name="student_mode" data-student-mode>${students.items.length ? '<option value="existing">Choose an existing student</option>' : ''}<option value="new" ${startsWithNewStudent ? 'selected' : ''}>Register a new student</option></select></label>
      <label class="field field--wide" data-existing-student ${startsWithNewStudent ? 'hidden' : ''}><span>Student</span><select name="student_id" ${students.items.length && !startsWithNewStudent ? 'required' : 'disabled'}>${students.items.map(s => `<option value="${s.id}">${escapeHtml(s.last_name)}, ${escapeHtml(s.first_name)} · ${escapeHtml(s.student_no)} · ${escapeHtml(s.section)}</option>`).join('')}</select></label>
      <fieldset class="form-grid field--wide new-student-fields" data-new-student-fields ${startsWithNewStudent ? '' : 'hidden disabled'}><legend class="form-section">New student details</legend>
        <label class="field"><span>Student number</span><input name="student_no" required maxlength="40"></label>
        <label class="field"><span>First name</span><input name="first_name" required maxlength="80"></label>
        <label class="field"><span>Last name</span><input name="last_name" required maxlength="80"></label>
        ${placementFields(sections.items)}
        <p class="form-hint field--wide">Choose the school year, then grade and section. Adviser-created student records are limited to the adviser’s assigned section.</p>
      </fieldset>`;
  showDialog(item ? 'Update violation record' : 'Record violation',
    `<div class="notice notice--info">Record observed facts for staff review. Classification follows the selected school offense category; SVTS does not determine guilt or choose sanctions.</div>
    <form data-form="violation"><div class="form-grid">
      ${studentField}
      <label class="field field--wide"><span>Violation category</span><select name="category_id" required>${categories.items.map(c => `<option value="${c.id}" ${String(item?.category_id) === String(c.id) ? 'selected' : ''}>${escapeHtml(c.name)} · ${escapeHtml(c.severity)}</option>`).join('')}</select></label>
      <label class="field"><span>Date of violation</span><input name="incident_date" type="date" required value="${escapeHtml(item?.incident_date || today())}"></label>
      <label class="field"><span>Time of violation</span><input name="incident_time" type="time" required value="${escapeHtml(item?.incident_time || '')}"></label>
      <label class="field field--wide"><span>Location</span><input name="location" required maxlength="200" placeholder="Where did it occur?" value="${escapeHtml(item?.location || '')}"></label>
      <label class="field field--wide"><span>Factual description</span><textarea name="description" rows="4" required maxlength="2000" placeholder="Describe what was observed, using objective language…">${escapeHtml(item?.description || '')}</textarea></label>
      <label class="field field--wide"><span>Evidence reference or notes <small>(optional)</small></span><textarea name="evidence" rows="2" maxlength="1000" placeholder="Describe supporting materials or enter their secure school-storage reference…">${escapeHtml(item?.evidence || '')}</textarea></label>
      <label class="field"><span>Reporting staff member</span><input value="${escapeHtml(state.user.name)}" readonly></label>
      ${state.user.role === 'Administrator'
        ? `<label class="field"><span>Case status</span><select name="status">${['Open','Under Review','Referred','Resolved','Closed'].map(status => `<option ${status === (item?.status || 'Open') ? 'selected' : ''}>${status}</option>`).join('')}</select></label>`
        : '<p class="form-hint field--wide">Your report will be submitted as Under Review for guidance staff.</p>'}
    </div></form>`,
    `<button class="button button--outline" data-action="close-dialog">Cancel</button><button class="button button--primary" data-submit-form="violation">${item ? 'Save changes' : 'Save violation'}</button>`);
  $('[data-form="violation"]', $('#dialogHost')).dataset.id = item?.id || '';
}

async function openServiceForm(item = null) {
  const [students, violations] = await Promise.all([
    api('/api/students?page=1&page_size=100'), api('/api/violations?page=1&page_size=100')
  ]);
  if (!students.items.length) { toast('Add student records before assigning service.', 'error'); return; }
  showDialog('Assign community service',
    `<form data-form="service"><div class="form-grid">
      <label class="field field--wide"><span>Student</span><select name="student_id" required>${students.items.map(s => `<option value="${s.id}" ${String(item?.student_id || '') === String(s.id) ? 'selected' : ''}>${escapeHtml(s.last_name)}, ${escapeHtml(s.first_name)} · ${escapeHtml(s.section)}</option>`).join('')}</select></label>
      <label class="field field--wide"><span>Related violation (optional)</span><select name="violation_id"><option value="">No linked violation</option>${violations.items.map(v => `<option value="${v.id}" ${String(item?.violation_id || '') === String(v.id) ? 'selected' : ''}>${escapeHtml(v.case_number || caseNumber(v.id))} · ${escapeHtml(v.first_name)} ${escapeHtml(v.last_name)} · ${escapeHtml(v.category)}</option>`).join('')}</select></label>
      <label class="field"><span>Required days</span><input name="required_days" type="number" min="1" max="366" value="${item?.required_days || 1}" required></label>
      <label class="field"><span>Required hours</span><input name="required_hours" type="number" min="0.5" max="10000" step="0.5" value="${item?.required_hours || 2}" required></label>
      <label class="field field--wide"><span>Assignment details</span><input name="description" maxlength="500" placeholder="Service task / location" value="${escapeHtml(item?.description || '')}"></label>
    </div></form>`,
    `<button class="button button--outline" data-action="close-dialog">Cancel</button><button class="button button--primary" data-submit-form="service">${item ? 'Save assignment' : 'Create assignment'}</button>`);
  $('[data-form="service"]', $('#dialogHost')).dataset.id = item?.id || '';
}

function openAttendanceForm(id) {
  showDialog('Record service attendance',
    `<form data-form="attendance"><input type="hidden" name="assignment_id" value="${id}"><div class="form-grid">
      <label class="field"><span>Service date</span><input name="service_date" type="date" value="${today()}" required></label>
      <label class="field"><span>Hours completed</span><input name="hours" type="number" min="0.25" max="24" step="0.25" required></label>
      <label class="check-field field--wide"><input name="day_completed" type="checkbox" checked><span>Count this attendance as a completed service day</span></label>
      <label class="field field--wide"><span>Notes</span><textarea name="notes" rows="3" maxlength="500"></textarea></label>
    </div></form>`,
    `<button class="button button--outline" data-action="close-dialog">Cancel</button><button class="button button--primary" data-submit-form="attendance">Save attendance</button>`);
}

async function openAttendanceHistory(id) {
  const result = await api(`/api/service/attendance?assignment_id=${id}`);
  showDialog('Attendance history', result.items.length
    ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>DATE</th><th>HOURS</th><th>DAY</th><th>RECORDED BY</th><th>NOTES</th></tr></thead><tbody>${result.items.map(row => `<tr><td>${dateLabel(row.service_date)}</td><td>${Number(row.hours).toFixed(2)}h</td><td>${row.day_completed ? 'Complete' : 'Partial'}</td><td>${escapeHtml(row.recorded_by)}</td><td>${escapeHtml(row.notes)}</td></tr>`).join('')}</tbody></table></div>`
    : emptyState('No attendance recorded', 'Attendance history will be retained here once entered.'),
  '<button class="button button--outline" data-action="close-dialog">Close</button>');
}

async function openSectionForm(item = null) {
  const years = await api('/api/school-years');
  if (!years.items.length) { toast('Create a school year first.', 'error'); return; }
  showDialog('Create a section', `<form data-form="section"><div class="form-grid">
    <label class="field field--wide"><span>School year</span><select name="school_year_id" required>${years.items.map(y => `<option value="${y.id}" ${String(item?.school_year_id || '') === String(y.id) || (!item && y.active) ? 'selected' : ''}>${escapeHtml(y.name)}${y.active ? ' · Active' : ''}</option>`).join('')}</select></label>
    <label class="field"><span>Grade level</span><select name="grade" required><option value="11" ${String(item?.grade || '11') === '11' ? 'selected' : ''}>Grade 11</option><option value="12" ${String(item?.grade || '') === '12' ? 'selected' : ''}>Grade 12</option></select></label>
    <label class="field"><span>Section name</span><input name="name" required maxlength="80" value="${escapeHtml(item?.name || '')}"></label>
    <label class="field field--wide"><span>Strand (optional)</span><input name="strand" maxlength="80" value="${escapeHtml(item?.strand || '')}"></label>
  </div></form>`, '<button class="button button--outline" data-action="close-dialog">Cancel</button><button class="button button--primary" data-submit-form="section">Save section</button>');
  $('[data-form="section"]', $('#dialogHost')).dataset.id = item?.id || '';
}

function openYearForm(item = null) {
  showDialog(item ? 'Update school year' : 'Add a school year', `<form data-form="year"><label class="field"><span>School year label</span><input name="name" required maxlength="20" placeholder="2026–2027" value="${escapeHtml(item?.name || '')}"></label><label class="check-field"><input name="active" type="checkbox" ${item?.active ? 'checked' : ''}><span>Set as the active school year</span></label></form>`,
    `<button class="button button--outline" data-action="close-dialog">Cancel</button><button class="button button--primary" data-submit-form="year">${item ? 'Save school year' : 'Add school year'}</button>`);
  $('[data-form="year"]', $('#dialogHost')).dataset.id = item?.id || '';
}

function openCategoryForm(item = null) {
  showDialog(item ? 'Update offense category' : 'Add offense category', `<form data-form="category"><div class="form-grid">
    <label class="field field--wide"><span>Offense name</span><input name="name" value="${escapeHtml(item?.name || '')}" required maxlength="100"></label>
    <label class="field"><span>Classification</span><select name="severity"><option ${item?.severity === 'Minor' || !item ? 'selected' : ''}>Minor</option><option ${item?.severity === 'Major' ? 'selected' : ''}>Major</option></select></label>
    <label class="field field--wide"><span>Policy description</span><textarea name="description" rows="3" maxlength="500">${escapeHtml(item?.description || '')}</textarea></label>
  </div></form>`, '<button class="button button--outline" data-action="close-dialog">Cancel</button><button class="button button--primary" data-submit-form="category">Save category</button>');
  $('[data-form="category"]', $('#dialogHost')).dataset.id = item?.id || '';
}

async function submitDialogForm(kind, button) {
  const form = $(`[data-form="${kind}"]`, $('#dialogHost'));
  if (!form || !form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  button.disabled = true;
  let successMessage = 'Changes saved successfully.';
  try {
    if (kind === 'violation') {
      const id = form.dataset.id;
      if (data.student_mode === 'new') {
        data.new_student = {
          student_no: data.student_no,
          first_name: data.first_name,
          last_name: data.last_name,
          school_year_id: Number(data.school_year_id),
          grade: data.grade,
          section_id: Number(data.section_id)
        };
        delete data.student_id;
        delete data.student_no;
        delete data.first_name;
        delete data.last_name;
        delete data.school_year_id;
        delete data.grade;
        delete data.section_id;
      }
      delete data.student_mode;
      const result = await api(`/api/violations${id ? `?id=${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: data });
      if (!id) successMessage = `Violation ${result.case_number || caseNumber(result.id)} recorded.${result.student_created ? ' Student record created.' : ''}`;
    } else if (kind === 'service') {
      const id = form.dataset.id;
      data.required_days = Number(data.required_days);
      data.required_hours = Number(data.required_hours);
      await api(`/api/service${id ? `?id=${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: data });
    } else if (kind === 'attendance') {
      const body = { ...data, assignment_id: Number(data.assignment_id), hours: Number(data.hours), day_completed: form.elements.day_completed.checked };
      await api('/api/service/attendance', { method: 'POST', body });
    } else if (kind === 'section') {
      data.school_year_id = Number(data.school_year_id);
      const id = form.dataset.id;
      await api(`/api/sections${id ? `?id=${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: data });
    } else if (kind === 'year') {
      data.active = form.elements.active.checked;
      const id = form.dataset.id;
      await api(`/api/school-years${id ? `?id=${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: data });
    } else if (kind === 'category') {
      const id = form.dataset.id;
      await api(`/api/categories${id ? `?id=${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: data });
    } else if (kind === 'settings') {
      await api('/api/settings', { method: 'PATCH', body: data });
      toast('School profile saved.', 'success');
      return;
    }
    closeDialog();
    toast(successMessage, 'success');
    await loadView(state.view, { keepPage: true, keepSearch: true });
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function allRecordRows(module) {
  if (!RECORD_VIEWS.includes(module)) throw new Error('Choose a valid record module.');
  const endpoint = module === 'service' ? '/api/service' : `/api/${module}`;
  const query = { page: 1, page_size: 100, q: recordSearch(module), ...recordFilters(module) };
  const first = await api(`${endpoint}?${queryString(query)}`);
  const rows = [...first.items];
  const pages = Math.ceil(first.total / first.page_size);
  for (let page = 2; page <= pages; page += 1) {
    const result = await api(`${endpoint}?${queryString({ ...query, page })}`);
    rows.push(...result.items);
  }
  return rows;
}

function printColumns(module) {
  if (module === 'students') return [
    ['Student no.', row => row.student_no],
    ['Student', row => `${row.first_name} ${row.last_name}`],
    ['Grade', row => row.grade],
    ['Section', row => row.section],
    ['School year', row => row.school_year],
    ['Status', row => row.active ? 'Active' : 'Archived']
  ];
  if (module === 'violations') return [
    ['Case ID', row => row.case_number],
    ['Student no.', row => row.student_no],
    ['Student', row => `${row.first_name} ${row.last_name}`],
    ['Grade', row => row.grade],
    ['Section', row => row.section],
    ['School year', row => row.school_year],
    ['Offense', row => row.category],
    ['Classification', row => row.severity],
    ['Incident date', row => `${row.incident_date}${row.incident_time ? ` ${row.incident_time}` : ''}`],
    ['Status', row => row.status],
    ['Location', row => row.location],
    ['Reporting staff', row => row.reporter],
    ['Description', row => row.description],
    ['Evidence reference', row => row.evidence]
  ];
  return [
    ['Student no.', row => row.student_no],
    ['Student', row => `${row.first_name} ${row.last_name}`],
    ['Grade', row => row.grade],
    ['Section', row => row.section],
    ['School year', row => row.school_year],
    ['Case ID', row => row.case_number],
    ['Assignment', row => row.description || 'Community service'],
    ['Days', row => `${row.completed_days}/${row.required_days}`],
    ['Hours', row => `${Number(row.completed_hours).toFixed(1)}/${Number(row.required_hours).toFixed(1)}`],
    ['Status', row => row.status],
    ['Assigned at', row => row.created_at]
  ];
}

async function printRecords(module) {
  const titles = { students: 'Student directory', violations: 'Violation register', service: 'Community service' };
  const filters = recordFilters(module);
  const needsSections = Boolean(filters.school_year_id || filters.section_id);
  const needsCategories = module === 'violations' && Boolean(filters.category_id);
  const [rows, sectionsResult, categoriesResult] = await Promise.all([
    allRecordRows(module),
    needsSections ? api('/api/sections') : Promise.resolve({ items: [] }),
    needsCategories ? api('/api/categories') : Promise.resolve({ items: [] })
  ]);
  const sections = sectionsResult.items;
  const years = [...new Map(sections.map(section => [
    String(section.school_year_id), section.school_year
  ])).entries()];
  const filterLabels = {
    school_year_id: 'School year ID', grade: 'Grade', section_id: 'Section ID', status: 'Status',
    severity: 'Classification', category_id: 'Offense ID', from: 'From', to: 'To'
  };
  const appliedFilters = Object.entries(filters)
    .filter(([, value]) => value)
    .map(([key, value]) => {
      if (key === 'school_year_id') {
        value = years.find(([id]) => id === String(value))?.[1] || value;
      } else if (key === 'section_id') {
        const section = sections.find(item => String(item.id) === String(value));
        if (section) value = `${section.school_year} · Grade ${section.grade} · ${section.name}`;
      } else if (key === 'category_id') {
        value = categoriesResult.items.find(item => String(item.id) === String(value))?.name || value;
      }
      const label = key === 'school_year_id' ? 'School year'
        : key === 'section_id' ? 'Section'
          : key === 'category_id' ? 'Offense' : filterLabels[key] || key;
      return `${label}: ${value}`;
    });
  if (recordSearch(module)) appliedFilters.unshift(`Search: ${recordSearch(module)}`);
  const columns = printColumns(module);
  const report = $('#printReport');
  report.innerHTML = `<header class="print-report__header">
      <img src="/assets/svts-logo.jpg" alt="">
      <div><span>STUDENT VIOLATION TRACKING SYSTEM</span><h1>${escapeHtml(titles[module])}</h1>
      <p>Generated ${escapeHtml(new Date().toLocaleString())} · ${rows.length} matching records</p></div>
    </header>
    ${appliedFilters.length ? `<p class="print-report__filters"><strong>Filters:</strong> ${escapeHtml(appliedFilters.join(' · '))}</p>` : ''}
    ${rows.length ? `<table class="data-table print-report__table"><thead><tr>${columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(([, value]) => `<td>${escapeHtml(value(row) ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>` : emptyState('No records match these filters', 'Adjust the record filters and print again.')}`;
  report.hidden = false;
  window.addEventListener('afterprint', () => { report.hidden = true; report.innerHTML = ''; }, { once: true });
  window.print();
}

async function exportRecords(module) {
  if (!RECORD_VIEWS.includes(module)) throw new Error('Choose a valid record module.');
  const query = queryString({ module, q: recordSearch(module), ...recordFilters(module) });
  const blob = await api(`/api/reports.xlsx?${query}`);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `svts-${module}-${today()}.xlsx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleAction(element) {
  const action = element.dataset.action;
  try {
    if (action === 'register') renderAuth('register');
    else if (action === 'adviser-register') renderAuth('adviserRegister');
    else if (action === 'login') renderAuth('login');
    else if (action === 'close-dialog') {
      closeDialog();
    } else if (action === 'reload-view') loadView(state.view, { keepPage: true, keepSearch: true });
    else if (action === 'page') {
      state.page = Number(element.dataset.page);
      loadView(state.view, { keepPage: true, keepSearch: true });
    } else if (action === 'new-violation') openViolationForm();
    else if (action === 'new-service') openServiceForm();
    else if (action === 'attendance') openAttendanceForm(element.dataset.id);
    else if (action === 'history') openAttendanceHistory(element.dataset.id);
    else if (action === 'new-section') openSectionForm();
    else if (action === 'new-year') openYearForm();
    else if (action === 'new-category') openCategoryForm();
    else if (action === 'edit-service') {
      const result = await api(`/api/service?id=${encodeURIComponent(element.dataset.id)}`);
      const item = result.items.find(x => String(x.id) === element.dataset.id);
      if (item) openServiceForm(item);
    } else if (action === 'edit-section') {
      const result = await api('/api/sections');
      const item = result.items.find(x => String(x.id) === element.dataset.id);
      if (item) openSectionForm(item);
    } else if (action === 'edit-year') {
      const result = await api('/api/school-years');
      const item = result.items.find(x => String(x.id) === element.dataset.id);
      if (item) openYearForm(item);
    }
    else if (action === 'edit-violation') {
      const page = await api(`/api/violations?id=${element.dataset.id}&page_size=10`);
      if (page.items[0]) openViolationForm(page.items[0]);
    } else if (action === 'edit-category') {
      const result = await api('/api/categories');
      const item = result.items.find(x => String(x.id) === element.dataset.id);
      if (item) openCategoryForm(item);
    } else if (action === 'activate-year') {
      await api(`/api/school-years?id=${element.dataset.id}`, { method: 'PATCH', body: { name: element.dataset.name, active: true } });
      toast('Active school year updated.', 'success'); loadView('management');
    } else if (action === 'delete-section') {
      if (!confirm('Delete this section? Referenced sections are protected.')) return;
      await api(`/api/sections?id=${element.dataset.id}`, { method: 'DELETE' });
      toast('Section deleted.', 'success'); loadView('management');
    } else if (action === 'toggle-user') {
      await api(`/api/users?id=${element.dataset.id}`, { method: 'PATCH', body: { status: element.dataset.status } });
      toast(`Account ${element.dataset.status.toLowerCase()}.`, 'success'); loadView('management');
    } else if (action === 'decide-admin') {
      const verb = element.dataset.decision === 'approve' ? 'approve' : 'reject';
      if (!confirm(`Are you sure you want to ${verb} this administrator request?`)) return;
      await api(`/api/admin-registrations?id=${element.dataset.id}`, { method: 'PATCH', body: { decision: element.dataset.decision } });
      toast(`Administrator request ${verb}d.`, 'success'); loadView('management');
    } else if (action === 'decide-adviser') {
      const request = element.closest('[data-adviser-request]');
      const decision = element.dataset.decision;
      const section = $('[data-placement-section]', request);
      if (decision === 'approve' && !section?.value) {
        toast('Choose one active section before approving this adviser.', 'error');
        return;
      }
      const verb = decision === 'approve' ? 'assign a section to and approve' : 'reject';
      if (!confirm(`Are you sure you want to ${verb} this adviser request?`)) return;
      await api(`/api/adviser-requests?id=${request.dataset.id}`, {
        method: 'PATCH',
        body: { decision, ...(decision === 'approve' ? { section_id: Number(section.value) } : {}) }
      });
      toast(`Adviser request ${decision === 'approve' ? 'approved' : 'rejected'}.`, 'success');
      await loadView('management');
    } else if (action === 'export-records') {
      await exportRecords(element.dataset.module);
    } else if (action === 'print-records') {
      await printRecords(element.dataset.module);
    } else if (action === 'clear-record-filters') {
      const module = element.dataset.module;
      if (!RECORD_VIEWS.includes(module)) return;
      state.filters[module] = {};
      state.searches[module] = '';
      state.page = 1;
      await loadView(state.view);
    }
  } catch (error) { toast(error.message, 'error'); }
}

async function logout() {
  try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* clear local UI even if session already expired */ }
  state.user = null; state.csrf = '';
  resetRecordState();
  showLanding();
}

document.addEventListener('submit', event => {
  if (event.target.matches('#setupForm,#loginForm,#registerForm,#adviserRegisterForm')) authSubmit(event);
  const kind = event.target.dataset.form;
  if (kind) {
    event.preventDefault();
    submitDialogForm(kind, $('button[type=submit]', event.target) || $(`[data-submit-form="${kind}"]`));
  }
});

document.addEventListener('click', event => {
  const authAction = event.target.closest('[data-auth-mode]');
  if (authAction) {
    const mode = authAction.dataset.authMode;
    renderAuth(state.setupRequired ? 'setup' : mode);
    return;
  }
  if (event.target.closest('[data-return-home]')) {
    showLanding();
    return;
  }
  if (event.target.closest('.site-nav__burger')) {
    const menu = $('#siteLinks');
    const open = menu.classList.toggle('is-open');
    event.target.closest('.site-nav__burger').setAttribute('aria-expanded', String(open));
    return;
  }
  if (event.target.closest('#siteLinks a')) {
    $('#siteLinks').classList.remove('is-open');
    $('.site-nav__burger').setAttribute('aria-expanded', 'false');
  }
  const view = event.target.closest('[data-view]');
  if (view && view.closest('#navigation, #pageContent')) {
    loadView(view.dataset.view); return;
  }
  const tab = event.target.closest('[data-tab]');
  if (tab) { state.managementTab = tab.dataset.tab; managementPage($('#pageContent')).catch(error => toast(error.message, 'error')); return; }
  const submit = event.target.closest('[data-submit-form]');
  if (submit) { event.preventDefault(); submitDialogForm(submit.dataset.submitForm, submit); return; }
  if (event.target.matches('.dialog-backdrop')) { closeDialog(); return; }
  const action = event.target.closest('[data-action]');
  if (action) { handleAction(action); return; }
  if (event.target.id === 'logoutButton') logout();
});

let searchTimer;
document.addEventListener('input', event => {
  if (event.target.matches('[data-search]')) {
    const module = state.view;
    if (!RECORD_VIEWS.includes(module)) return;
    state.searches[module] = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.view === module) { state.page = 1; loadView(module, { keepSearch: true }); }
    }, 250);
  }
});
document.addEventListener('change', event => {
  if (event.target.matches('[data-placement-year]')) {
    const container = event.target.closest('[data-placement]');
    if (container) refreshPlacement(container, 'year');
  } else if (event.target.matches('[data-placement-grade]')) {
    const container = event.target.closest('[data-placement]');
    if (container) refreshPlacement(container, 'grade');
  } else if (event.target.matches('[data-student-mode]')) {
    const form = event.target.closest('[data-form="violation"]');
    const useNewStudent = event.target.value === 'new';
    const existingStudent = form.querySelector('[data-existing-student]');
    const existingStudentSelect = existingStudent.querySelector('select');
    const newStudentFields = form.querySelector('[data-new-student-fields]');
    existingStudent.hidden = useNewStudent;
    existingStudentSelect.disabled = useNewStudent;
    existingStudentSelect.required = !useNewStudent;
    newStudentFields.hidden = !useNewStudent;
    newStudentFields.disabled = !useNewStudent;
  } else if (event.target.matches('[data-filter]')) {
    const module = state.view;
    if (!RECORD_VIEWS.includes(module)) return;
    state.filters[module][event.target.dataset.filter] = event.target.value;
    const { from, to } = state.filters[module];
    if (from && to && from > to) {
      toast('The start date must be on or before the end date.', 'error');
      return;
    }
    state.page = 1;
    loadView(module, { keepSearch: true });
  } else if (event.target.matches('[data-page-size]')) {
    state.pageSize = Number(event.target.value); state.page = 1;
    loadView(state.view, { keepSearch: true });
  }
});

$('#menuToggle').addEventListener('click', () => {
  $('#sidebar').classList.toggle('sidebar--open');
  $('#sidebarScrim').classList.toggle('is-visible');
});
$('#sidebarScrim').addEventListener('click', () => {
  $('#sidebar').classList.remove('sidebar--open');
  $('#sidebarScrim').classList.remove('is-visible');
});
$('#logoutButton').addEventListener('click', logout);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDialog(); });

async function init() {
  let status;
  try {
    status = await api('/api/status');
    state.setupRequired = status.setup_required;
    state.setupKeyRequired = Boolean(status.setup_key_required);
  } catch (error) {
    showLanding(error.message);
    return;
  }
  if (state.setupRequired) { showLanding(); return; }
  try {
    const session = await api('/api/me');
    state.user = session.user; state.csrf = session.csrf;
    enterApp();
  } catch (error) {
    if (error.status === 401) showLanding();
    else showLanding(error.message);
  }
}
init();
