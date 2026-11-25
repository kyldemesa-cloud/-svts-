const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const db = require('./db');
const { Readable } = require('node:stream');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('SESSION_SECRET is required in production.');
    process.exit(1);
  }
  console.warn('WARNING: set SESSION_SECRET before deployment.');
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '500kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'replace-this-local-development-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 60 * 1000
  }
}));
app.use(express.static('public'));

const audit = (user, action, type, id, details = '') =>
  db.prepare('INSERT INTO audit_log(user_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?)')
    .run(user?.id, action, type, id, details);

const getUser = id =>
  db.prepare('SELECT id,full_name,email,role,status FROM users WHERE id=?').get(id);

const auth = (req, res, next) => {
  const s = req.session.user;
  if (!s) return res.status(401).json({ error: 'Sign in required' });

  const u = getUser(s.id);
  if (!u || u.status !== 'verified' || u.role === 'student') {
    return req.session.destroy(() => res.status(401).json({ error: 'Account is no longer active' }));
  }

  req.session.user = { ...s, role: u.role, status: u.status };
  next();
};

const admin = (req, res, next) =>
  req.session.user?.role === 'admin' && req.session.user.status === 'verified'
    ? next()
    : res.status(403).json({ error: 'Administrator access required' });

const verified = (req, res, next) =>
  req.session.user?.status === 'verified'
    ? next()
    : res.status(403).json({ error: 'Account pending verification' });

const clean = (s, max = 200) => String(s ?? '').trim().slice(0, max);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const toNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function parseDateInput(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : s;
}

function normalizeDateBounds(from, to) {
  let f = parseDateInput(from);
  let t = parseDateInput(to);
  if (f && t && f > t) [f, t] = [t, f];
  return {
    from: f,
    to: t,
    fromSql: f ? `${f} 00:00:00` : null,
    toSql: t ? `${t} 23:59:59.999` : null
  };
}

function allowedStudent(req, studentId) {
  if (req.session.user.role === 'admin') return true;
  return !!db.prepare(
    `SELECT 1 FROM students s JOIN teacher_sections ts ON ts.section_id=s.section_id WHERE s.id=? AND ts.teacher_id=?`
  ).get(studentId, req.session.user.id);
}

function passwordStrong(pw) {
  return typeof pw === 'string' && pw.length >= 10;
}

const STAFF_REQUEST_ROLES = ['admin', 'guidance_counselor', 'class_adviser'];
const STAFF_ROLES = ['admin', 'teacher', 'guidance_counselor', 'class_adviser'];
const SECTION_STAFF_ROLES = ['teacher', 'guidance_counselor', 'class_adviser'];

function roleLabel(role) {
  return {
    admin: 'Administrator',
    teacher: 'Teacher',
    guidance_counselor: 'Guidance Counselor',
    class_adviser: 'Class Adviser',
    student: 'Student'
  }[role] || role;
}

function isSectionStaffRole(role) {
  return SECTION_STAFF_ROLES.includes(role);
}

function getAssignedClassAdviserForSection(sectionId, excludeUserId = null) {
  if (!sectionId) return null;
  return excludeUserId
    ? db.prepare(`
        SELECT u.id, u.full_name
        FROM teacher_sections ts
        JOIN users u ON u.id = ts.teacher_id
        WHERE ts.section_id = ? AND u.role = 'class_adviser' AND u.id <> ?
        LIMIT 1
      `).get(sectionId, excludeUserId)
    : db.prepare(`
        SELECT u.id, u.full_name
        FROM teacher_sections ts
        JOIN users u ON u.id = ts.teacher_id
        WHERE ts.section_id = ? AND u.role = 'class_adviser'
        LIMIT 1
      `).get(sectionId);
}

function validateClassAdviserSectionAssignment(sectionId, excludeUserId = null) {
  const sid = Number(sectionId);
  if (!sid) return { error: 'Class Adviser accounts must be assigned to exactly one section.' };
  const section = db.prepare(`
    SELECT s.id, s.grade_level, s.section_name, s.school_year_id, y.label AS school_year
    FROM sections s JOIN school_years y ON y.id = s.school_year_id
    WHERE s.id = ?
  `).get(sid);
  if (!section) return { error: 'Selected section is invalid.' };
  const existing = getAssignedClassAdviserForSection(sid, excludeUserId);
  if (existing) {
    return { error: `This section already has a Class Adviser account for ${section.school_year} (${section.grade_level}-${section.section_name}: ${existing.full_name}).` };
  }
  return { section };
}

function requireStaffEmailRole(email, role) {
  if (!STAFF_ROLES.includes(role)) return 'Invalid staff role.';
  if (!email || !isEmail(email)) return 'A valid email is required for staff accounts.';
  return null;
}

function emailUnique(email, excludeUserId = null) {
  if (!email) return true;
  const row = excludeUserId
    ? db.prepare('SELECT id FROM users WHERE lower(email)=lower(?) AND id<>?').get(email, excludeUserId)
    : db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(email);
  return !row;
}

function tracksStrandsEnabledForGrade(gradeLevel) {
  return ['11', '12', 11, 12].includes(gradeLevel);
}

function getTrackStrandConfig() {
  const tracks = db.prepare('SELECT id,code,name,is_active,created_at FROM tracks WHERE is_active=1 ORDER BY name,code').all();
  const strands = db.prepare('SELECT s.id,s.track_id,s.code,s.name,s.is_active,s.created_at,t.name track_name,t.code track_code FROM strands s LEFT JOIN tracks t ON t.id=s.track_id WHERE s.is_active=1 ORDER BY s.name,s.code').all();
  return { tracks, strands, enabled: tracks.length > 0 || strands.length > 0 };
}

function validateTrackStrandForGrade(gradeLevel, trackId, strandId, { requiredIfEnabled = false } = {}) {
  const g = String(gradeLevel ?? '').trim();
  if (!tracksStrandsEnabledForGrade(g)) {
    return { track_id: null, strand_id: null };
  }
  const cfg = getTrackStrandConfig();
  const enabled = cfg.enabled;
  if (!enabled) {
    return { track_id: null, strand_id: null };
  }
  const tId = trackId ? Number(trackId) : null;
  const sId = strandId ? Number(strandId) : null;
  if (requiredIfEnabled && !sId && !tId) {
    return { error: 'Track/strand is required for Grades 11 and 12 when configured.' };
  }
  if (tId && !db.prepare('SELECT 1 FROM tracks WHERE id=? AND is_active=1').get(tId)) {
    return { error: 'Selected track is invalid or inactive.' };
  }
  if (sId) {
    const strand = db.prepare('SELECT id,track_id FROM strands WHERE id=? AND is_active=1').get(sId);
    if (!strand) return { error: 'Selected strand is invalid or inactive.' };
    if (tId && strand.track_id && Number(strand.track_id) !== tId) {
      return { error: 'Selected strand does not belong to the selected track.' };
    }
    return { track_id: tId || (strand.track_id ? Number(strand.track_id) : null), strand_id: sId };
  }
  return { track_id: tId, strand_id: null };
}

function upsertStudentProfileFromStudent(studentId) {
  const s = db.prepare('SELECT id, user_id, student_number, grade_level, section_id, track_id, strand_id, guardian_name, guardian_contact FROM students WHERE id=?').get(studentId);
  if (!s) return;
  db.prepare(`
    INSERT INTO student_profiles(user_id, student_no, grade_level, section_id, track_id, strand_id, guardian_name, guardian_contact)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(student_no) DO UPDATE SET
      user_id=COALESCE(excluded.user_id, student_profiles.user_id),
      grade_level=excluded.grade_level,
      section_id=excluded.section_id,
      track_id=excluded.track_id,
      strand_id=excluded.strand_id,
      guardian_name=excluded.guardian_name,
      guardian_contact=excluded.guardian_contact
  `).run(s.user_id || null, s.student_number || null, s.grade_level || null, s.section_id || null, s.track_id || null, s.strand_id || null, s.guardian_name || '', s.guardian_contact || '');
}

function recalcViolationService(violationId) {
  const v = db.prepare('SELECT id, required_service_hours, completed_service_hours FROM violations WHERE id=?').get(violationId);
  if (!v) return null;
  const sum = db.prepare('SELECT COALESCE(SUM(hours_rendered),0) total FROM community_service_logs WHERE violation_id=?').get(violationId).total || 0;
  const required = Math.max(0, Number(v.required_service_hours || 0));
  const completed = Math.max(0, Number(sum || 0));
  let service_status = 'none';
  if (required <= 0) service_status = 'none';
  else if (completed >= required) service_status = 'completed';
  else if (completed > 0) service_status = 'in_progress';
  else service_status = 'pending';
  db.prepare('UPDATE violations SET completed_service_hours=?, service_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(completed, service_status, violationId);
  return db.prepare('SELECT id, required_service_hours, completed_service_hours, service_status FROM violations WHERE id=?').get(violationId);
}

function studentAccessClause(req, alias = 'st') {
  if (req.session.user.role === 'admin') return { sql: '', params: [] };
  return {
    sql: ` AND ${alias}.section_id IN (SELECT section_id FROM teacher_sections WHERE teacher_id=?)`,
    params: [req.session.user.id]
  };
}

function buildViolationsFilterQuery(req, { forExport = false } = {}) {
  const q = req.query || {};
  const { fromSql, toSql } = normalizeDateBounds(q.added_from, q.added_to);
  const filters = [];
  const params = [];
  if (fromSql) { filters.push('v.created_at >= ?'); params.push(fromSql); }
  if (toSql) { filters.push('v.created_at <= ?'); params.push(toSql); }
  if (q.grade_level) { filters.push('s.grade_level = ?'); params.push(clean(q.grade_level, 20)); }
  if (q.section_id) { filters.push('st.section_id = ?'); params.push(Number(q.section_id)); }
  if (q.track_id) { filters.push('COALESCE(st.track_id, s.track_id) = ?'); params.push(Number(q.track_id)); }
  if (q.strand_id) { filters.push('COALESCE(st.strand_id, s.strand_id) = ?'); params.push(Number(q.strand_id)); }
  if (q.violation_type) { filters.push('(o.id = ? OR lower(o.name) = lower(?))'); params.push(Number(q.violation_type) || 0, clean(q.violation_type, 120)); }
  if (q.service_status) { filters.push('v.service_status = ?'); params.push(clean(q.service_status, 30)); }
  if (q.search) {
    const like = `%${clean(q.search, 120)}%`;
    filters.push('(v.case_number LIKE ? OR st.student_number LIKE ? OR st.first_name LIKE ? OR st.last_name LIKE ? OR o.name LIKE ? OR v.description LIKE ?)');
    params.push(like, like, like, like, like, like);
  }
  const access = studentAccessClause(req, 'st');
  let where = ' WHERE 1=1';
  if (filters.length) where += ' AND ' + filters.join(' AND ');
  if (access.sql) { where += access.sql; params.push(...access.params); }
  const base = `FROM violations v
    JOIN students st ON st.id=v.student_id
    JOIN sections s ON s.id=st.section_id
    LEFT JOIN school_years y ON y.id=s.school_year_id
    JOIN offense_catalog o ON o.id=v.offense_id
    JOIN users rec ON rec.id=v.recorded_by
    LEFT JOIN users ver ON ver.id=v.verified_by
    LEFT JOIN tracks tr ON tr.id=COALESCE(st.track_id, s.track_id)
    LEFT JOIN strands sd ON sd.id=COALESCE(st.strand_id, s.strand_id)
    ${where}`;
  return { base, params, forExport };
}

function queryRecentViolations(req) {
  const q = req.query || {};
  const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit || '25', 10) || 25));
  const offset = (page - 1) * limit;
  const { base, params } = buildViolationsFilterQuery(req);
  const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...params).n;
  const items = db.prepare(`
    SELECT v.*, st.student_number, st.first_name, st.last_name, st.grade_level,
           s.id section_id, s.section_name, s.school_year, y.label school_year_label,
           COALESCE(st.track_id, s.track_id) track_id, COALESCE(st.strand_id, s.strand_id) strand_id,
           tr.name track_name, sd.name strand_name,
           o.name offense, o.severity, rec.full_name recorded_by_name, ver.full_name verified_by_name
    ${base}
    ORDER BY v.created_at DESC, v.incident_date DESC, v.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { items, page, limit, total };
}

function buildCommunityServiceExportQuery(req) {
  const q = req.query || {};
  const { fromSql, toSql } = normalizeDateBounds(q.added_from, q.added_to);
  const filters = [];
  const params = [];
  if (fromSql) { filters.push('v.created_at >= ?'); params.push(fromSql); }
  if (toSql) { filters.push('v.created_at <= ?'); params.push(toSql); }
  if (q.grade_level) { filters.push('s.grade_level = ?'); params.push(clean(q.grade_level, 20)); }
  if (q.section_id) { filters.push('st.section_id = ?'); params.push(Number(q.section_id)); }
  if (q.track_id) { filters.push('COALESCE(st.track_id, s.track_id) = ?'); params.push(Number(q.track_id)); }
  if (q.strand_id) { filters.push('COALESCE(st.strand_id, s.strand_id) = ?'); params.push(Number(q.strand_id)); }
  if (q.service_status) { filters.push('v.service_status = ?'); params.push(clean(q.service_status, 30)); }
  if (q.search) {
    const like = `%${clean(q.search, 120)}%`;
    filters.push('(v.case_number LIKE ? OR st.student_number LIKE ? OR st.first_name LIKE ? OR st.last_name LIKE ?)');
    params.push(like, like, like, like);
  }
  const access = studentAccessClause(req, 'st');
  let where = ' WHERE 1=1';
  if (filters.length) where += ' AND ' + filters.join(' AND ');
  if (access.sql) { where += access.sql; params.push(...access.params); }
  return {
    sql: `SELECT v.id violation_id, v.case_number, st.student_number, st.first_name, st.last_name,
            st.grade_level, s.section_name, s.school_year, tr.name track_name, sd.name strand_name,
            v.community_service_type, v.required_service_hours, v.completed_service_hours, v.service_status,
            v.guardian_name, v.guardian_contact, v.created_at
          FROM violations v
          JOIN students st ON st.id=v.student_id
          JOIN sections s ON s.id=st.section_id
          LEFT JOIN tracks tr ON tr.id=COALESCE(st.track_id, s.track_id)
          LEFT JOIN strands sd ON sd.id=COALESCE(st.strand_id, s.strand_id)
          ${where}
          ORDER BY v.created_at DESC, v.id DESC`,
    params
  };
}

// Minimal XLSX generator (no external deps)
function xmlEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colName(n) { let s=''; while(n){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26);} return s; }
function sheetXml(headers, rows) {
  const all = [headers, ...rows];
  let xml = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  all.forEach((row, rIdx) => {
    xml += `<row r="${rIdx + 1}">`;
    row.forEach((val, cIdx) => {
      const ref = `${colName(cIdx + 1)}${rIdx + 1}`;
      const v = val == null ? '' : String(val);
      // store as inline string to preserve leading zeros and special chars
      xml += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    });
    xml += '</row>';
  });
  xml += '</sheetData></worksheet>';
  return xml;
}
function crcTable() { const t = new Uint32Array(256); for (let i=0;i<256;i++){let c=i; for(let k=0;k<8;k++) c = c&1 ? (0xEDB88320 ^ (c>>>1)) : (c>>>1); t[i]=c>>>0;} return t; }
const _crc = crcTable();
function crc32(buf){ let c=0xFFFFFFFF; for(let i=0;i<buf.length;i++) c=_crc[(c^buf[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
function zipStore(files) {
  // files: [{name, data(Buffer)}]
  const chunks=[]; const central=[]; let offset=0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0,6); local.writeUInt16LE(0,8);
    local.writeUInt16LE(0,10); local.writeUInt16LE(0,12); local.writeUInt32LE(crc,14);
    local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22);
    local.writeUInt16LE(nameBuf.length,26); local.writeUInt16LE(0,28); nameBuf.copy(local,30);
    chunks.push(local,data);
    const cent = Buffer.alloc(46 + nameBuf.length);
    cent.writeUInt32LE(0x02014b50,0); cent.writeUInt16LE(20,4); cent.writeUInt16LE(20,6); cent.writeUInt16LE(0,8);
    cent.writeUInt16LE(0,10); cent.writeUInt16LE(0,12); cent.writeUInt16LE(0,14); cent.writeUInt32LE(crc,16);
    cent.writeUInt32LE(data.length,20); cent.writeUInt32LE(data.length,24); cent.writeUInt16LE(nameBuf.length,28);
    cent.writeUInt16LE(0,30); cent.writeUInt16LE(0,32); cent.writeUInt16LE(0,34); cent.writeUInt16LE(0,36);
    cent.writeUInt32LE(0,38); cent.writeUInt32LE(offset,42); nameBuf.copy(cent,46);
    central.push(cent);
    offset += local.length + data.length;
  }
  const centralStart = offset;
  let centralSize = 0; for (const c of central){ chunks.push(c); centralSize += c.length; }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(0,4); end.writeUInt16LE(0,6);
  end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(centralSize,12); end.writeUInt32LE(centralStart,16); end.writeUInt16LE(0,20);
  chunks.push(end);
  return Buffer.concat(chunks);
}
function buildXlsx(headers, rows) {
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(headers, rows) }
  ];
  return zipStore(files);
}
function sendXlsx(res, filename, headers, rows) {
  const buf = buildXlsx(headers, rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buf.length));
  Readable.from(buf).pipe(res);
}

// --- Auth ---

app.get('/api/auth/setup-status', (req, res) => {
  try {
    const configured = !!db.prepare("SELECT 1 FROM users WHERE role='admin' AND status='verified' LIMIT 1").get();
    res.json({ configured });
  } catch (e) {
    res.status(500).json({ error: 'Unable to check setup status.' });
  }
});

app.get('/api/public/signup-options', (req, res) => {
  try {
    const years = db.prepare('SELECT id,label,starts_on,ends_on,is_active FROM school_years WHERE is_active=1 ORDER BY starts_on DESC, id DESC').all();
    const sections = db.prepare(`
      SELECT s.id, s.school_year_id, COALESCE(NULLIF(s.school_year,''), y.label) AS school_year, s.grade_level, s.section_name AS name
      FROM sections s
      JOIN school_years y ON y.id = s.school_year_id
      WHERE y.is_active = 1
      ORDER BY y.starts_on DESC, CAST(s.grade_level AS INTEGER), s.section_name
    `).all();
    res.json({ years, sections, tracks: [], strands: [], trackStrandEnabled: false });
  } catch (e) {
    res.status(500).json({ error: 'Unable to load account request options.' });
  }
});
app.post('/api/auth/register-admin', async (req, res) => {
  try {
    const name = clean(req.body.name, 100);
    const email = clean(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || '');
    const requestedRole = clean(req.body.role || 'admin', 40);
    const role = requestedRole === 'administrator' ? 'admin' : requestedRole;
    if (!name || !isEmail(email) || !passwordStrong(password)) {
      return res.status(400).json({ error: 'Name, valid email, and password of at least 10 characters are required.' });
    }
    if (!STAFF_REQUEST_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Please select a valid account type to request (Administrator, Guidance Counselor, or Class Adviser).' });
    }
    if (!emailUnique(email)) return res.status(409).json({ error: 'Email already registered.' });

    let requestedSectionId = null;
    if (role === 'class_adviser') {
      const check = validateClassAdviserSectionAssignment(req.body.section_id || req.body.sectionId);
      if (check.error) return res.status(400).json({ error: check.error });
      requestedSectionId = Number(check.section.id);
    }
    const hash = await bcrypt.hash(password, 12);
    const r = db.prepare("INSERT INTO users(full_name,email,password_hash,role,status,requested_section_id) VALUES(?,?,?,?, 'pending', ?)")
      .run(name, email, hash, role, requestedSectionId);
    audit({ id: r.lastInsertRowid }, `${roleLabel(role)} account request pending`, 'user', r.lastInsertRowid, requestedSectionId ? `${role};section:${requestedSectionId}` : role);
    const suffix = requestedSectionId ? ' for the selected section' : '';
    res.json({ message: `${roleLabel(role)} account request${suffix} submitted. A verified administrator must approve your account before sign-in.` });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Email already registered.' : 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip;
  const f0 = fails.get(ip);
  if (f0 && f0.n >= 5 && Date.now() - f0.t < 15 * 60 * 1000) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const email = clean(req.body.email, 160).toLowerCase();
  const user = email ? db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email) : null;

  if (!user || !await bcrypt.compare(String(req.body.password || ''), user.password_hash)) {
    const f = fails.get(ip) || { n: 0 };
    fails.set(ip, { n: f.n + 1, t: Date.now() });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.status !== 'verified') {
    return res.status(403).json({
      error: user.status === 'pending'
        ? 'Account awaiting administrator verification.'
        : 'Account not active.'
    });
  }

  if (user.role === 'student') {
    return res.status(403).json({ error: 'Student access is not available in this system.' });
  }

  fails.delete(ip);
  req.session.user = {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
    status: user.status
  };
  audit(user, 'Sign in', 'session', user.id);
  res.json({ user: req.session.user });
});

app.post('/api/auth/logout', auth, (req, res) => {
  audit(req.session.user, 'Sign out', 'session', req.session.user.id);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: req.session.user });
});

app.get('/api/dashboard', auth, verified, (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const isStaffScoped = isSectionStaffRole(req.session.user.role);
  const sectionIds = isAdmin
    ? null
    : (isStaffScoped
      ? db.prepare('SELECT section_id FROM teacher_sections WHERE teacher_id=?').all(req.session.user.id).map(x => x.section_id)
      : []);
  const sectionFilter = isAdmin ? '' : (sectionIds.length ? `WHERE s.section_id IN (${sectionIds.map(() => '?').join(',')})` : 'WHERE 1=0');
  const params = isAdmin ? [] : sectionIds;

  const students = isAdmin
    ? db.prepare('SELECT COUNT(*) n FROM students WHERE active=1').get().n
    : db.prepare(`SELECT COUNT(*) n FROM students s ${sectionFilter}`).get(...params).n;

  const cases = isAdmin
    ? db.prepare('SELECT COUNT(*) n FROM violations').get().n
    : db.prepare(`SELECT COUNT(*) n FROM violations v JOIN students s ON s.id=v.student_id ${sectionFilter}`).get(...params).n;

  const service = isAdmin
    ? db.prepare("SELECT COUNT(*) n FROM community_service WHERE status!='Completed'").get().n
    : db.prepare(`SELECT COUNT(*) n FROM community_service cs JOIN students s ON s.id=cs.student_id ${sectionFilter} AND cs.status!='Completed'`).get(...params).n;

  res.json({
    students,
    cases,
    activeService: service,
    sections: isAdmin ? db.prepare('SELECT COUNT(*) n FROM sections').get().n : sectionIds.length
  });
});

app.get('/api/admin/pending', auth, admin, (req, res) => {
  res.json(
    db.prepare(`
      SELECT u.id,u.full_name,u.email,u.role,u.created_at,u.requested_section_id,
             s.grade_level AS requested_section_grade, s.section_name AS requested_section_name,
             y.label AS requested_school_year
      FROM users u
      LEFT JOIN sections s ON s.id = u.requested_section_id
      LEFT JOIN school_years y ON y.id = s.school_year_id
      WHERE u.role IN ('admin','guidance_counselor','class_adviser') AND u.status='pending'
      ORDER BY u.created_at ASC, u.role ASC, u.full_name ASC
    `).all()
  );
});

function handlePendingStaffApproval(req, res, approve) {
  const id = Number(req.params.id);
  if (id === req.session.user.id) {
    return res.status(400).json({ error: 'You cannot approve or reject your own account request.' });
  }
  const target = db.prepare("SELECT id, role, requested_section_id FROM users WHERE id=? AND role IN ('admin','guidance_counselor','class_adviser') AND status='pending'").get(id);
  if (!target) {
    return res.status(404).json({ error: 'Pending account request not found.' });
  }

  if (approve && target.role === 'class_adviser') {
    if (!target.requested_section_id) {
      return res.status(400).json({ error: 'This Class Adviser request has no assigned section. Reject it and ask the requester to submit a new request with a section selected.' });
    }
    const check = validateClassAdviserSectionAssignment(target.requested_section_id, id);
    if (check.error) return res.status(409).json({ error: check.error });
  }

  const status = approve ? 'verified' : 'rejected';
  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET status=?,verified_by=?,verified_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(status, req.session.user.id, id);
    if (approve && target.role === 'class_adviser' && target.requested_section_id) {
      db.prepare('INSERT OR IGNORE INTO teacher_sections(teacher_id,section_id) VALUES(?,?)').run(id, Number(target.requested_section_id));
    }
  });
  tx();
  audit(req.session.user, `${approve ? 'Approve' : 'Reject'} ${roleLabel(target.role)} request`, 'user', id, `${target.role}:${status}${target.requested_section_id ? `;section:${target.requested_section_id}` : ''}`);
  res.json({ ok: true, status, role: target.role });
}

app.post('/api/admin/verify/:id', auth, admin, (req, res) => handlePendingStaffApproval(req, res, true));
app.post('/api/admin/approve/:id', auth, admin, (req, res) => handlePendingStaffApproval(req, res, true));
app.post('/api/admin/reject/:id', auth, admin, (req, res) => handlePendingStaffApproval(req, res, false));

app.get('/api/users', auth, admin, (req, res) => {
  res.json(db.prepare('SELECT id,full_name,email,role,status,created_at FROM users ORDER BY role,full_name').all());
});

app.post('/api/teachers', auth, admin, async (req, res) => {
  try {
    const name = clean(req.body.name, 100);
    const email = clean(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || '');
    const rawSections = Array.isArray(req.body.sections) ? req.body.sections : (req.body.section_id ? [req.body.section_id] : (req.body.sectionId ? [req.body.sectionId] : []));
    const sectionIds = rawSections.map(x => Number(x)).filter(Number.isFinite);
    const errRole = requireStaffEmailRole(email, 'teacher');
    if (!name || errRole) return res.status(400).json({ error: errRole || 'Name is required.' });
    if (!passwordStrong(password)) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    if (sectionIds.length !== 1) return res.status(400).json({ error: 'Teacher accounts must be assigned to exactly one section.' });
    if (!emailUnique(email)) return res.status(409).json({ error: 'Email already registered.' });
    if (!db.prepare('SELECT 1 FROM sections WHERE id=?').get(sectionIds[0])) return res.status(400).json({ error: 'Selected section is invalid.' });

    const hash = await bcrypt.hash(password, 12);
    const r = db.prepare("INSERT INTO users(full_name,email,password_hash,role,status) VALUES(?,?,?,'teacher','verified')")
      .run(name, email, hash);
    const id = Number(r.lastInsertRowid);

    db.prepare('INSERT OR IGNORE INTO teacher_sections(teacher_id,section_id) VALUES(?,?)').run(id, sectionIds[0]);

    audit(req.session.user, 'Create teacher', 'user', id, `section:${sectionIds[0]}`);
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Email already registered.' : 'Unable to create teacher. Check email and section assignment.' });
  }
});

app.put('/api/users/:id/status', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;
  const ok = ['verified', 'suspended'];
  const t = db.prepare('SELECT status FROM users WHERE id=?').get(id);

  if (!t || id === req.session.user.id || !ok.includes(status) || !ok.includes(t.status)) {
    return res.status(400).json({
      error: 'Status change not allowed (pending administrators must be verified through approval; you cannot change your own status).'
    });
  }

  db.prepare('UPDATE users SET status=? WHERE id=?').run(status, id);
  audit(req.session.user, 'Update user status', 'user', id, status);
  res.json({ ok: true });
});

app.get('/api/teachers/:id/sections', auth, admin, (req, res) => {
  res.json(
    db.prepare('SELECT section_id FROM teacher_sections WHERE teacher_id=?')
      .all(Number(req.params.id))
      .map(x => x.section_id)
  );
});

app.put('/api/teachers/:id/sections', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT id, role FROM users WHERE id=?").get(id);
  if (!user || !isSectionStaffRole(user.role)) {
    return res.status(404).json({ error: 'Staff user not found.' });
  }

  try {
    const rawSections = Array.isArray(req.body.sections) ? req.body.sections : (req.body.section_id ? [req.body.section_id] : (req.body.sectionId ? [req.body.sectionId] : []));
    const sectionIds = rawSections.map(x => Number(x)).filter(Number.isFinite);
    if ((user.role === 'teacher' || user.role === 'class_adviser') && sectionIds.length !== 1) {
      return res.status(400).json({ error: `${roleLabel(user.role)} accounts must be assigned to exactly one section.` });
    }
    if (user.role !== 'teacher' && user.role !== 'class_adviser' && sectionIds.length < 1) {
      return res.status(400).json({ error: 'Please select at least one section.' });
    }
    if (sectionIds.some(sid => !db.prepare('SELECT 1 FROM sections WHERE id=?').get(sid))) {
      return res.status(400).json({ error: 'One or more selected sections are invalid.' });
    }
    if (user.role === 'class_adviser') {
      const check = validateClassAdviserSectionAssignment(sectionIds[0], id);
      if (check.error) return res.status(409).json({ error: check.error });
    }

    const ins = db.prepare('INSERT OR IGNORE INTO teacher_sections(teacher_id,section_id) VALUES(?,?)');
    db.transaction(() => {
      db.prepare('DELETE FROM teacher_sections WHERE teacher_id=?').run(id);
      sectionIds.forEach(x => ins.run(id, x));
    })();
    audit(req.session.user, 'Assign staff sections', 'user', id, sectionIds.join(','));
    res.json({ ok: true, section_ids: sectionIds });
  } catch (e) {
    res.status(400).json({ error: 'Invalid section assignment.' });
  }
});

app.put('/api/years/:id', auth, admin, (req, res) => {
  try {
    db.prepare('UPDATE school_years SET label=?,starts_on=?,ends_on=? WHERE id=?')
      .run(clean(req.body.label, 20), req.body.startsOn || null, req.body.endsOn || null, Number(req.params.id));
    audit(req.session.user, 'Edit school year', 'school_year', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'School year invalid or duplicate.' });
  }
});

app.delete('/api/students/:id', auth, admin, (req, res) => {
  db.prepare('UPDATE students SET active=0 WHERE id=?').run(Number(req.params.id));
  audit(req.session.user, 'Deactivate student record', 'student', Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/years', auth, verified, (req, res) => {
  res.json(db.prepare('SELECT * FROM school_years ORDER BY label DESC').all());
});

app.post('/api/years', auth, admin, (req, res) => {
  try {
    const label = clean(req.body.label, 20);
    if (!label) return res.status(400).json({ error: 'School year required' });

    const r = db.prepare('INSERT INTO school_years(label,starts_on,ends_on) VALUES(?,?,?)')
      .run(label, req.body.startsOn || null, req.body.endsOn || null);
    audit(req.session.user, 'Create school year', 'school_year', r.lastInsertRowid, label);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'School year already exists or invalid.' });
  }
});

app.post('/api/years/:id/activate', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  db.transaction(() => {
    db.prepare('UPDATE school_years SET is_active=0').run();
    db.prepare('UPDATE school_years SET is_active=1 WHERE id=?').run(id);
  })();
  audit(req.session.user, 'Activate school year', 'school_year', id);
  res.json({ ok: true });
});

app.get('/api/sections', auth, verified, (req, res) => {
  const year = req.query.year;
  let q = `
    SELECT s.*, y.label school_year_label,
           COALESCE(NULLIF(s.school_year,''), y.label) school_year,
           t.code track_code, t.name track_name,
           st.code strand_code, st.name strand_name
    FROM sections s
    JOIN school_years y ON y.id=s.school_year_id
    LEFT JOIN tracks t ON t.id=s.track_id
    LEFT JOIN strands st ON st.id=s.strand_id`;
  if (year) q += ' WHERE s.school_year_id=?';
  q += ' ORDER BY s.grade_level,s.section_name';
  res.json(year ? db.prepare(q).all(Number(year)) : db.prepare(q).all());
});

app.post('/api/sections', auth, admin, (req, res) => {
  try {
    const yearId = Number(req.body.yearId || req.body.school_year_id);
    const year = db.prepare('SELECT label FROM school_years WHERE id=?').get(yearId);
    if (!year) return res.status(400).json({ error: 'Invalid school year.' });
    const grade = clean(req.body.grade || req.body.grade_level, 20);
    const name = clean(req.body.name || req.body.section_name, 80);
    if (!grade || !name) return res.status(400).json({ error: 'Grade level and section name are required.' });
    const ts = validateTrackStrandForGrade(grade, req.body.track_id, req.body.strand_id);
    if (ts.error) return res.status(400).json({ error: ts.error });
    const strandText = clean(req.body.strand, 80);
    const schoolYearLabel = clean(req.body.school_year, 40) || year.label;
    const r = db.prepare(`
      INSERT INTO sections(school_year_id,grade_level,section_name,strand,track_id,strand_id,school_year)
      VALUES (?,?,?,?,?,?,?)
    `).run(yearId, grade, name, strandText, ts.track_id, ts.strand_id, schoolYearLabel);
    audit(req.session.user, 'Create section', 'section', r.lastInsertRowid);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Section already exists for this school year.' : 'Section invalid or already exists for this school year.' });
  }
});

app.put('/api/sections/:id', auth, admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT s.*, y.label year_label FROM sections s JOIN school_years y ON y.id=s.school_year_id WHERE s.id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'Section not found.' });
    const grade = clean(req.body.grade || req.body.grade_level || existing.grade_level, 20);
    const name = clean(req.body.name || req.body.section_name || existing.section_name, 80);
    const ts = validateTrackStrandForGrade(grade, req.body.track_id !== undefined ? req.body.track_id : existing.track_id, req.body.strand_id !== undefined ? req.body.strand_id : existing.strand_id);
    if (ts.error) return res.status(400).json({ error: ts.error });
    const strandText = req.body.strand !== undefined ? clean(req.body.strand, 80) : (existing.strand || '');
    const schoolYearLabel = req.body.school_year !== undefined ? clean(req.body.school_year, 40) : (existing.school_year || existing.year_label || '');
    db.prepare('UPDATE sections SET grade_level=?,section_name=?,strand=?,track_id=?,strand_id=?,school_year=? WHERE id=?')
      .run(grade, name, strandText, ts.track_id, ts.strand_id, schoolYearLabel, id);
    audit(req.session.user, 'Edit section', 'section', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Section update failed.' });
  }
});

app.delete('/api/sections/:id', auth, admin, (req, res) => {
  try {
    db.prepare('DELETE FROM sections WHERE id=?').run(Number(req.params.id));
    audit(req.session.user, 'Delete section', 'section', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Section has linked records; cannot delete.' });
  }
});

app.get('/api/students', auth, verified, (req, res) => {
  const year = req.query.year;
  let q = `
    SELECT st.*, s.grade_level section_grade_level, s.section_name, s.strand section_strand_text, s.school_year_id,
           COALESCE(NULLIF(s.school_year,''), y.label) school_year,
           COALESCE(st.track_id, s.track_id) track_id, COALESCE(st.strand_id, s.strand_id) strand_id,
           t.name track_name, sd.name strand_name
    FROM students st
    JOIN sections s ON s.id=st.section_id
    LEFT JOIN school_years y ON y.id=s.school_year_id
    LEFT JOIN tracks t ON t.id=COALESCE(st.track_id, s.track_id)
    LEFT JOIN strands sd ON sd.id=COALESCE(st.strand_id, s.strand_id)
    WHERE st.active=1`;
  const p = [];

  if (year) {
    q += ' AND s.school_year_id=?';
    p.push(Number(year));
  }

  if (isSectionStaffRole(req.session.user.role)) {
    q += ` AND st.section_id IN (SELECT section_id FROM teacher_sections WHERE teacher_id=?)`;
    p.push(req.session.user.id);
  }

  q += ' ORDER BY s.grade_level,s.section_name,st.last_name,st.first_name';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/students', auth, admin, (req, res) => {
  try {
    const number = clean(req.body.number || req.body.student_number, 40);
    const first = clean(req.body.first || req.body.first_name, 80);
    const last = clean(req.body.last || req.body.last_name, 80);
    const sectionId = Number(req.body.sectionId || req.body.section_id);
    const section = db.prepare('SELECT * FROM sections WHERE id=?').get(sectionId);
    if (!number || !first || !last || !section) {
      return res.status(400).json({ error: 'Student number, name, and valid section are required.' });
    }
    const grade = clean(req.body.grade || req.body.grade_level || section.grade_level, 20);
    const ts = validateTrackStrandForGrade(grade, req.body.track_id ?? section.track_id, req.body.strand_id ?? section.strand_id);
    if (ts.error) return res.status(400).json({ error: ts.error });
    const guardianName = clean(req.body.guardian_name || req.body.guardianName, 150);
    const guardianContact = clean(req.body.guardian_contact || req.body.guardianContact, 50);

    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO students(student_number,first_name,last_name,grade_level,section_id,track_id,strand_id,guardian_name,guardian_contact)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(number, first, last, grade, sectionId, ts.track_id, ts.strand_id, guardianName, guardianContact);
      upsertStudentProfileFromStudent(Number(r.lastInsertRowid));
      audit(req.session.user, 'Create student record', 'student', r.lastInsertRowid);
      return r.lastInsertRowid;
    });
    res.json({ id: tx() });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Student number already exists.' : 'Student details invalid or student number already exists.' });
  }
});

app.put('/api/students/:id', auth, admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM students WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'Student not found.' });
    const sectionId = Number(req.body.sectionId || req.body.section_id || existing.section_id);
    const section = db.prepare('SELECT * FROM sections WHERE id=?').get(sectionId);
    if (!section) return res.status(400).json({ error: 'Invalid section.' });
    const grade = clean(req.body.grade || req.body.grade_level || section.grade_level || existing.grade_level, 20);
    const ts = validateTrackStrandForGrade(grade, req.body.track_id !== undefined ? req.body.track_id : (existing.track_id ?? section.track_id), req.body.strand_id !== undefined ? req.body.strand_id : (existing.strand_id ?? section.strand_id));
    if (ts.error) return res.status(400).json({ error: ts.error });
    const number = clean(req.body.number || req.body.student_number || existing.student_number, 40);
    const first = clean(req.body.first || req.body.first_name || existing.first_name, 80);
    const last = clean(req.body.last || req.body.last_name || existing.last_name, 80);
    const guardianName = req.body.guardian_name !== undefined || req.body.guardianName !== undefined ? clean(req.body.guardian_name || req.body.guardianName, 150) : (existing.guardian_name || '');
    const guardianContact = req.body.guardian_contact !== undefined || req.body.guardianContact !== undefined ? clean(req.body.guardian_contact || req.body.guardianContact, 50) : (existing.guardian_contact || '');

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE students
        SET student_number=?,first_name=?,last_name=?,grade_level=?,section_id=?,track_id=?,strand_id=?,guardian_name=?,guardian_contact=?
        WHERE id=?
      `).run(number, first, last, grade, sectionId, ts.track_id, ts.strand_id, guardianName, guardianContact, id);
      if (Number(existing.section_id) !== Number(sectionId)) {
        db.prepare('INSERT INTO section_assignments(student_id, old_section_id, new_section_id, changed_by, reason) VALUES (?,?,?,?,?)')
          .run(id, existing.section_id, sectionId, req.session.user.id, 'Updated via student edit');
      }
      upsertStudentProfileFromStudent(id);
    });
    tx();
    audit(req.session.user, 'Update student record', 'student', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Student number already exists.' : 'Unable to update student.' });
  }
});

app.get('/api/offenses', auth, verified, (req, res) => {
  res.json(db.prepare('SELECT * FROM offense_catalog WHERE active=1 ORDER BY severity,name').all());
});

app.post('/api/offenses', auth, admin, (req, res) => {
  try {
    const r = db.prepare('INSERT INTO offense_catalog(name,severity,description) VALUES(?,?,?)')
      .run(clean(req.body.name, 120), req.body.severity, clean(req.body.description, 500));
    audit(req.session.user, 'Create offense', 'offense', r.lastInsertRowid);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Offense name must be unique and severity valid.' });
  }
});

app.post('/api/violations', auth, admin, (req, res) => {
  try {
    const caseNumber = clean(req.body.caseNumber || req.body.case_number, 40);
    const studentId = Number(req.body.studentId || req.body.student_id);
    const offenseId = Number(req.body.offenseId || req.body.offense_id);
    const incidentDate = parseDateInput(req.body.date || req.body.incident_date);
    if (!caseNumber || !studentId || !offenseId || !incidentDate) {
      return res.status(400).json({ error: 'caseNumber, studentId, offenseId, and incident date are required.' });
    }

    const student = db.prepare('SELECT id, guardian_name, guardian_contact FROM students WHERE id=?').get(studentId);
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    const requiredHoursRaw = req.body.required_service_hours ?? req.body.requiredServiceHours ?? 0;
    const completedHoursRaw = req.body.completed_service_hours ?? req.body.completedServiceHours ?? 0;
    const requiredHours = Number(requiredHoursRaw);
    const completedHours = Number(completedHoursRaw);
    if (!Number.isFinite(requiredHours) || !Number.isFinite(completedHours)) {
      return res.status(400).json({ error: 'Service hours must be valid numbers.' });
    }
    if (requiredHours < 0 || completedHours < 0) {
      return res.status(400).json({ error: 'Service hours cannot be negative.' });
    }
    // Allow over-cap rendered/completed hours while marking completed when requirement is met.
    const serviceStatus = requiredHours <= 0 ? 'none' : (completedHours >= requiredHours ? 'completed' : (completedHours > 0 ? 'in_progress' : 'pending'));

    const guardianName = clean(req.body.guardian_name ?? req.body.guardianName ?? student.guardian_name ?? '', 150);
    const guardianContact = clean(req.body.guardian_contact ?? req.body.guardianContact ?? student.guardian_contact ?? '', 50);
    const communityServiceType = clean(req.body.community_service_type ?? req.body.communityServiceType ?? '', 120) || null;

    const r = db.prepare(`
      INSERT INTO violations(
        case_number, student_id, offense_id, incident_date, incident_time, location, description, evidence_notes,
        community_service_type, required_service_hours, completed_service_hours, service_status,
        guardian_name, guardian_contact, recorded_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      caseNumber,
      studentId,
      offenseId,
      incidentDate,
      clean(req.body.time || req.body.incident_time, 10) || null,
      clean(req.body.location, 120),
      clean(req.body.description, 1000),
      clean(req.body.evidence || req.body.evidence_notes, 1000),
      communityServiceType,
      requiredHours,
      completedHours,
      serviceStatus,
      guardianName,
      guardianContact,
      req.session.user.id
    );
    audit(req.session.user, 'Record violation', 'violation', r.lastInsertRowid);
    res.json({ id: r.lastInsertRowid, service_status: serviceStatus });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Case number must be unique.' : 'Violation record invalid.' });
  }
});

app.get('/api/violations', auth, verified, (req, res) => {
  try {
    const { base, params } = buildViolationsFilterQuery(req);
    const rows = db.prepare(`
      SELECT v.*, st.student_number, st.first_name, st.last_name, st.grade_level,
             s.section_name, s.school_year, o.name offense, o.severity,
             rec.full_name recorded_by_name, ver.full_name verified_by_name,
             tr.name track_name, sd.name strand_name
      ${base}
      ORDER BY v.incident_date DESC, v.id DESC
      LIMIT 500
    `).all(...params);
    res.json(rows);
  } catch (e) {
    res.status(400).json({ error: 'Unable to load violations.' });
  }
});

app.patch('/api/violations/:id', auth, admin, (req, res) => {
  const status = ['Reported', 'Under Review', 'Verified', 'Accepted', 'In Progress', 'Resolved', 'Closed', 'Rejected', 'Escalated'].includes(req.body.status)
    ? req.body.status
    : null;

  if (!status) return res.status(400).json({ error: 'Invalid status' });

  db.prepare('UPDATE violations SET status=?,verified_by=COALESCE(?,verified_by),verified_at=CASE WHEN ?="Verified" THEN CURRENT_TIMESTAMP ELSE verified_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(status, status === 'Verified' ? req.session.user.id : null, status, Number(req.params.id));

  audit(req.session.user, 'Update violation status', 'violation', Number(req.params.id), status);
  res.json({ ok: true });
});

app.get('/api/community-service', auth, verified, (req, res) => {
  let q = 'SELECT cs.*,st.first_name,st.last_name,st.grade_level,s.section_name, y.label school_year, v.case_number, COALESCE((SELECT SUM(hours_served) FROM service_attendance a WHERE a.service_id=cs.id),0) hours_completed, COALESCE((SELECT SUM(day_completed) FROM service_attendance a WHERE a.service_id=cs.id),0) days_completed FROM community_service cs JOIN students st ON st.id=cs.student_id JOIN sections s ON s.id=st.section_id JOIN school_years y ON y.id=cs.school_year_id LEFT JOIN violations v ON v.id=cs.violation_id';
  const p = [];

  if (isSectionStaffRole(req.session.user.role)) {
    q += ' WHERE st.section_id IN (SELECT section_id FROM teacher_sections WHERE teacher_id=?)';
    p.push(req.session.user.id);
  }

  q += ' ORDER BY cs.created_at DESC';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/community-service', auth, admin, (req, res) => {
  try {
    const r = db.prepare('INSERT INTO community_service(student_id,violation_id,school_year_id,service_days_required,hours_required,start_date,due_date,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        Number(req.body.studentId),
        req.body.violationId || null,
        Number(req.body.yearId),
        Number(req.body.days || 0),
        Number(req.body.hours || 0),
        req.body.startDate || null,
        req.body.dueDate || null,
        clean(req.body.notes, 1000),
        req.session.user.id
      );
    audit(req.session.user, 'Assign community service', 'community_service', r.lastInsertRowid);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Invalid community service assignment.' });
  }
});

app.post('/api/community-service/:id/attendance', auth, verified, (req, res) => {
  const service = db.prepare('SELECT cs.*,st.section_id FROM community_service cs JOIN students st ON st.id=cs.student_id WHERE cs.id=?')
    .get(Number(req.params.id));

  if (!service || !allowedStudent(req, service.student_id)) {
    return res.status(404).json({ error: 'Service record not found for your access.' });
  }

  const date = req.body.date;
  const hours = Number(req.body.hours || 0);
  const day = Number(req.body.dayCompleted || 0);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !(hours >= 0 && hours <= 24) || !(day === 0 || day === 1)) {
    return res.status(400).json({ error: 'Attendance details invalid.' });
  }

  try {
    db.prepare('INSERT INTO service_attendance(service_id,service_date,hours_served,day_completed,notes,recorded_by) VALUES(?,?,?,?,?,?)')
      .run(service.id, date, hours, day, clean(req.body.notes, 500), req.session.user.id);

    const totals = db.prepare('SELECT SUM(hours_served) h,SUM(day_completed) d FROM service_attendance WHERE service_id=?')
      .get(service.id);
    const complete = (totals.h || 0) >= service.hours_required && (totals.d || 0) >= service.service_days_required;

    db.prepare("UPDATE community_service SET status=? WHERE id=?")
      .run(complete ? 'Completed' : 'In Progress', service.id);

    audit(req.session.user, 'Log service attendance', 'community_service', service.id, `${hours} hours; ${day} day`);
    res.json({ ok: true, totals, complete });
  } catch (e) {
    res.status(400).json({ error: 'Attendance already logged for this date, or invalid entry.' });
  }
});

app.get('/api/community-service/:id/attendance', auth, verified, (req, res) => {
  const service = db.prepare('SELECT student_id FROM community_service WHERE id=?').get(Number(req.params.id));
  if (!service || !allowedStudent(req, service.student_id)) {
    return res.status(404).json({ error: 'Not found' });
  }

  res.json(
    db.prepare('SELECT a.*,u.full_name recorded_by_name FROM service_attendance a JOIN users u ON u.id=a.recorded_by WHERE service_id=? ORDER BY service_date DESC')
      .all(Number(req.params.id))
  );
});

// --- Staff accounts (admin/teacher/guidance counselor/class adviser) ---
app.post('/api/staff/users', auth, admin, async (req, res) => {
  try {
    const name = clean(req.body.name || req.body.full_name, 100);
    const requestedRole = clean(req.body.role, 40);
    const role = requestedRole === 'adviser' ? 'class_adviser' : requestedRole;
    const email = clean(req.body.email, 160).toLowerCase();
    const password = String(req.body.password || '');
    const errRole = requireStaffEmailRole(email, role);
    if (!name || errRole) return res.status(400).json({ error: errRole || 'Name is required.' });
    if (!passwordStrong(password)) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    if (!emailUnique(email)) return res.status(409).json({ error: 'Email already registered.' });

    const rawSections = Array.isArray(req.body.sections) ? req.body.sections : (req.body.section_id ? [req.body.section_id] : (req.body.sectionId ? [req.body.sectionId] : []));
    const sectionIds = rawSections.map(x => Number(x)).filter(Number.isFinite);
    if ((role === 'teacher' || role === 'class_adviser') && sectionIds.length !== 1) {
      return res.status(400).json({ error: `${roleLabel(role)} accounts must be assigned to exactly one section.` });
    }
    if (isSectionStaffRole(role) && role !== 'teacher' && role !== 'class_adviser' && sectionIds.length < 1) {
      return res.status(400).json({ error: 'Please select at least one section for section-based staff accounts.' });
    }
    if (isSectionStaffRole(role) && sectionIds.some(sid => !db.prepare('SELECT 1 FROM sections WHERE id=?').get(sid))) {
      return res.status(400).json({ error: 'One or more selected sections are invalid.' });
    }
    if (role === 'class_adviser') {
      const check = validateClassAdviserSectionAssignment(sectionIds[0]);
      if (check.error) return res.status(409).json({ error: check.error });
    }

    const hash = await bcrypt.hash(password, 12);
    const r = db.prepare("INSERT INTO users(full_name,email,password_hash,role,status) VALUES(?,?,?,?, 'verified')")
      .run(name, email, hash, role);
    const id = Number(r.lastInsertRowid);

    if (isSectionStaffRole(role) && sectionIds.length) {
      const assign = db.prepare('INSERT OR IGNORE INTO teacher_sections(teacher_id,section_id) VALUES(?,?)');
      db.transaction(() => { sectionIds.forEach(s => assign.run(id, s)); })();
    }

    audit(req.session.user, 'Create staff user', 'user', id, sectionIds.length ? `${role};sections:${sectionIds.join(',')}` : role);
    res.json({ id, role, email });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Email already registered.' : 'Unable to create staff user.' });
  }
});

// --- Academic track/strand config ---
app.get('/api/academic/track-strand-config', auth, verified, (req, res) => {
  const all = req.query.all === '1' && req.session.user?.role === 'admin';
  const tracks = db.prepare(`SELECT id,code,name,is_active,created_at FROM tracks ${all ? '' : 'WHERE is_active=1'} ORDER BY name,code`).all();
  const strands = db.prepare(`SELECT s.id,s.track_id,s.code,s.name,s.is_active,s.created_at,t.name track_name,t.code track_code FROM strands s LEFT JOIN tracks t ON t.id=s.track_id ${all ? '' : 'WHERE s.is_active=1'} ORDER BY s.name,s.code`).all();
  const enabled = tracks.some(t => t.is_active) || strands.some(s => s.is_active);
  res.json({
    tracks,
    strands,
    grades: {
      '11': { enabled },
      '12': { enabled }
    },
    enabled
  });
});

app.post('/api/academic/tracks', auth, admin, (req, res) => {
  try {
    const code = clean(req.body.code, 40);
    const name = clean(req.body.name, 120);
    if (!code || !name) return res.status(400).json({ error: 'Track code and name are required.' });
    const r = db.prepare('INSERT INTO tracks(code,name,is_active) VALUES(?,?,?)')
      .run(code, name, req.body.is_active === 0 || req.body.is_active === false ? 0 : 1);
    audit(req.session.user, 'Create track', 'track', r.lastInsertRowid, code);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Track code already exists.' : 'Unable to create track.' });
  }
});

app.patch('/api/academic/tracks/:id', auth, admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM tracks WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'Track not found.' });
    const code = req.body.code !== undefined ? clean(req.body.code, 40) : existing.code;
    const name = req.body.name !== undefined ? clean(req.body.name, 120) : existing.name;
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : existing.is_active;
    db.prepare('UPDATE tracks SET code=?, name=?, is_active=? WHERE id=?').run(code, name, isActive, id);
    audit(req.session.user, 'Update track', 'track', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Track code already exists.' : 'Unable to update track.' });
  }
});

app.post('/api/academic/strands', auth, admin, (req, res) => {
  try {
    const code = clean(req.body.code, 40);
    const name = clean(req.body.name, 120);
    const trackId = req.body.track_id ? Number(req.body.track_id) : null;
    if (!code || !name) return res.status(400).json({ error: 'Strand code and name are required.' });
    if (trackId && !db.prepare('SELECT 1 FROM tracks WHERE id=?').get(trackId)) {
      return res.status(400).json({ error: 'Invalid track_id.' });
    }
    const r = db.prepare('INSERT INTO strands(track_id,code,name,is_active) VALUES(?,?,?,?)')
      .run(trackId, code, name, req.body.is_active === 0 || req.body.is_active === false ? 0 : 1);
    audit(req.session.user, 'Create strand', 'strand', r.lastInsertRowid, code);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Strand code already exists.' : 'Unable to create strand.' });
  }
});

app.patch('/api/academic/strands/:id', auth, admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM strands WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'Strand not found.' });
    const trackId = req.body.track_id === null ? null : (req.body.track_id !== undefined ? Number(req.body.track_id) : existing.track_id);
    if (trackId && !db.prepare('SELECT 1 FROM tracks WHERE id=?').get(trackId)) {
      return res.status(400).json({ error: 'Invalid track_id.' });
    }
    const code = req.body.code !== undefined ? clean(req.body.code, 40) : existing.code;
    const name = req.body.name !== undefined ? clean(req.body.name, 120) : existing.name;
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : existing.is_active;
    db.prepare('UPDATE strands SET track_id=?, code=?, name=?, is_active=? WHERE id=?')
      .run(trackId, code, name, isActive, id);
    audit(req.session.user, 'Update strand', 'strand', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Strand code already exists.' : 'Unable to update strand.' });
  }
});

// --- Dashboard recent violations with filters ---
app.get('/api/dashboard/recent-violations', auth, verified, (req, res) => {
  try {
    const result = queryRecentViolations(req);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: 'Unable to load recent violations.' });
  }
});

// --- Community service logs and calendar ---
app.get('/api/community-service/calendar', auth, verified, (req, res) => {
  try {
    const month = String(req.query.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM is required.' });
    const start = `${month}-01 00:00:00`;
    const end = `${month}-31 23:59:59.999`;
    const filters = [];
    const params = [start, end];
    if (req.query.grade_level) { filters.push('s.grade_level = ?'); params.push(clean(req.query.grade_level, 20)); }
    if (req.query.section_id) { filters.push('st.section_id = ?'); params.push(Number(req.query.section_id)); }
    if (req.query.track_id) { filters.push('COALESCE(st.track_id, s.track_id) = ?'); params.push(Number(req.query.track_id)); }
    if (req.query.strand_id) { filters.push('COALESCE(st.strand_id, s.strand_id) = ?'); params.push(Number(req.query.strand_id)); }
    if (req.query.service_status) { filters.push('v.service_status = ?'); params.push(clean(req.query.service_status, 30)); }
    const access = studentAccessClause(req, 'st');
    let where = ' WHERE l.service_date >= ? AND l.service_date <= ?';
    if (filters.length) where += ' AND ' + filters.join(' AND ');
    if (access.sql) { where += access.sql; params.push(...access.params); }
    const rows = db.prepare(`
      SELECT substr(l.service_date,1,10) service_date,
             COALESCE(SUM(l.hours_rendered),0) total_hours,
             COUNT(DISTINCT l.student_id) student_count,
             COUNT(*) log_count
      FROM community_service_logs l
      JOIN students st ON st.id=l.student_id
      JOIN sections s ON s.id=st.section_id
      LEFT JOIN violations v ON v.id=l.violation_id
      ${where}
      GROUP BY substr(l.service_date,1,10)
      ORDER BY service_date
    `).all(...params);
    res.json({ month, days: rows });
  } catch (e) {
    res.status(400).json({ error: 'Unable to load calendar.' });
  }
});

app.get('/api/community-service/calendar/:date', auth, verified, (req, res) => {
  try {
    const date = parseDateInput(req.params.date);
    if (!date) return res.status(400).json({ error: 'Invalid date.' });
    const filters = [];
    const params = [date];
    if (req.query.grade_level) { filters.push('s.grade_level = ?'); params.push(clean(req.query.grade_level, 20)); }
    if (req.query.section_id) { filters.push('st.section_id = ?'); params.push(Number(req.query.section_id)); }
    const access = studentAccessClause(req, 'st');
    let where = ' WHERE substr(l.service_date,1,10)=?';
    if (filters.length) where += ' AND ' + filters.join(' AND ');
    if (access.sql) { where += access.sql; params.push(...access.params); }
    const rows = db.prepare(`
      SELECT l.*, st.student_number, st.first_name, st.last_name, st.grade_level, s.section_name,
             v.case_number, v.required_service_hours, v.completed_service_hours, v.service_status,
             (CASE WHEN v.required_service_hours IS NULL THEN NULL ELSE MAX(v.required_service_hours - v.completed_service_hours, 0) END) remaining_hours,
             u.full_name verified_by_name
      FROM community_service_logs l
      JOIN students st ON st.id=l.student_id
      JOIN sections s ON s.id=st.section_id
      LEFT JOIN violations v ON v.id=l.violation_id
      LEFT JOIN users u ON u.id=l.verified_by
      ${where}
      ORDER BY st.last_name, st.first_name, l.id
    `).all(...params);
    res.json({ date, items: rows });
  } catch (e) {
    res.status(400).json({ error: 'Unable to load calendar day.' });
  }
});

app.post('/api/community-service/logs', auth, verified, (req, res) => {
  try {
    const violationId = req.body.violation_id ? Number(req.body.violation_id) : null;
    const studentId = Number(req.body.student_id);
    const serviceDate = parseDateInput(req.body.service_date);
    const hours = Number(req.body.hours_rendered);
    const remarks = clean(req.body.remarks, 500);
    if (!studentId || !serviceDate || !Number.isFinite(hours)) {
      return res.status(400).json({ error: 'student_id, service_date, and hours_rendered are required.' });
    }
    if (hours < 0) return res.status(400).json({ error: 'Rendered hours cannot be negative.' });
    if (!allowedStudent(req, studentId)) return res.status(403).json({ error: 'Not allowed for this student.' });

    const tx = db.transaction(() => {
      let v = null;
      if (violationId) {
        v = db.prepare('SELECT id, student_id, required_service_hours, completed_service_hours FROM violations WHERE id=?').get(violationId);
        if (!v) throw new Error('Violation not found.');
        if (Number(v.student_id) !== studentId) throw new Error('Violation does not belong to the specified student.');
      }
      const r = db.prepare(`
        INSERT INTO community_service_logs(violation_id, student_id, service_date, hours_rendered, remarks, verified_by)
        VALUES (?,?,?,?,?,?)
      `).run(violationId, studentId, serviceDate, hours, remarks, req.session.user.id);
      let violation = null;
      if (violationId) {
        const sum = db.prepare('SELECT COALESCE(SUM(hours_rendered),0) total FROM community_service_logs WHERE violation_id=?').get(violationId).total || 0;
        const required = Math.max(0, Number(v.required_service_hours || 0));
        let service_status = required <= 0 ? 'none' : (sum >= required ? 'completed' : (sum > 0 ? 'in_progress' : 'pending'));
        db.prepare('UPDATE violations SET completed_service_hours=?, service_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(sum, service_status, violationId);
        violation = db.prepare('SELECT id, required_service_hours, completed_service_hours, service_status FROM violations WHERE id=?').get(violationId);
      }
      audit(req.session.user, 'Log community service', 'community_service_log', r.lastInsertRowid, `${hours} hours on ${serviceDate}`);
      return { id: r.lastInsertRowid, violation };
    });
    const result = tx();
    res.json(result);
  } catch (e) {
    const msg = e.message || 'Unable to save service log.';
    const code = /not found/i.test(msg) ? 404 : (/not belong|not allowed/i.test(msg) ? 403 : 400);
    res.status(code).json({ error: msg });
  }
});

app.patch('/api/community-service/logs/:id', auth, verified, (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM community_service_logs WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'Log not found.' });
    if (!allowedStudent(req, existing.student_id)) return res.status(403).json({ error: 'Not allowed.' });
    const serviceDate = req.body.service_date !== undefined ? parseDateInput(req.body.service_date) : existing.service_date;
    const hours = req.body.hours_rendered !== undefined ? Number(req.body.hours_rendered) : Number(existing.hours_rendered);
    const remarks = req.body.remarks !== undefined ? clean(req.body.remarks, 500) : existing.remarks;
    if (!serviceDate || !Number.isFinite(hours)) return res.status(400).json({ error: 'Invalid service_date or hours_rendered.' });
    if (hours < 0) return res.status(400).json({ error: 'Rendered hours cannot be negative.' });

    const tx = db.transaction(() => {
      db.prepare('UPDATE community_service_logs SET service_date=?, hours_rendered=?, remarks=?, verified_by=? WHERE id=?')
        .run(serviceDate, hours, remarks, req.session.user.id, id);
      let violation = null;
      if (existing.violation_id) violation = recalcViolationService(existing.violation_id);
      audit(req.session.user, 'Update community service log', 'community_service_log', id);
      return { ok: true, violation };
    });
    res.json(tx());
  } catch (e) {
    res.status(400).json({ error: 'Unable to update service log.' });
  }
});

// --- Student section reassignment ---
function validateSectionCompatibility(section, studentGrade, trackId, strandId) {
  if (!section) return 'Target section not found.';
  if (studentGrade && String(section.grade_level) !== String(studentGrade)) {
    return 'Target section grade level does not match the student grade level.';
  }
  // If the target section is explicitly assigned to a track/strand, the student's effective track/strand must match.
  if (section.track_id && trackId && Number(section.track_id) !== Number(trackId)) {
    return 'Target section track does not match student track.';
  }
  if (section.strand_id && strandId && Number(section.strand_id) !== Number(strandId)) {
    return 'Target section strand does not match student strand.';
  }
  return null;
}

app.patch('/api/students/:id/section', auth, admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const student = db.prepare('SELECT * FROM students WHERE id=?').get(id);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const newSectionId = Number(req.body.section_id || req.body.new_section_id);
    const section = db.prepare('SELECT * FROM sections WHERE id=?').get(newSectionId);
    if (!section) return res.status(404).json({ error: 'Target section not found.' });

    const grade = req.body.grade_level ? clean(req.body.grade_level, 20) : (section.grade_level || student.grade_level);
    const effectiveTrackId = req.body.track_id !== undefined ? req.body.track_id : (section.track_id ?? null);
    const effectiveStrandId = req.body.strand_id !== undefined ? req.body.strand_id : (section.strand_id ?? null);
    const ts = validateTrackStrandForGrade(grade, effectiveTrackId, effectiveStrandId);
    if (ts.error) return res.status(400).json({ error: ts.error });
    const compat = validateSectionCompatibility(section, grade, ts.track_id, ts.strand_id);
    if (compat) return res.status(400).json({ error: compat });
    const reason = clean(req.body.reason, 300);

    const tx = db.transaction(() => {
      db.prepare('UPDATE students SET section_id=?, grade_level=?, track_id=?, strand_id=? WHERE id=?')
        .run(newSectionId, grade, ts.track_id, ts.strand_id, id);
      db.prepare('INSERT INTO section_assignments(student_id, old_section_id, new_section_id, changed_by, reason) VALUES (?,?,?,?,?)')
        .run(id, student.section_id, newSectionId, req.session.user.id, reason);
      db.prepare(`
        INSERT INTO student_profiles(user_id, student_no, grade_level, section_id, track_id, strand_id, guardian_name, guardian_contact)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(student_no) DO UPDATE SET
          grade_level=excluded.grade_level, section_id=excluded.section_id, track_id=excluded.track_id, strand_id=excluded.strand_id
      `).run(student.user_id || null, student.student_number || null, grade, newSectionId, ts.track_id, ts.strand_id, student.guardian_name || '', student.guardian_contact || '');
      audit(req.session.user, 'Reassign student section', 'student', id, `from ${student.section_id} to ${newSectionId}`);
      return db.prepare('SELECT * FROM students WHERE id=?').get(id);
    });
    res.json({ ok: true, student: tx() });
  } catch (e) {
    res.status(400).json({ error: 'Unable to reassign student section.' });
  }
});

app.post('/api/students/bulk-reassign', auth, admin, (req, res) => {
  try {
    const studentIds = Array.isArray(req.body.student_ids) ? req.body.student_ids.map(Number).filter(Boolean) : [];
    const newSectionId = Number(req.body.section_id || req.body.new_section_id);
    if (!studentIds.length || !newSectionId) return res.status(400).json({ error: 'student_ids and section_id are required.' });
    const section = db.prepare('SELECT * FROM sections WHERE id=?').get(newSectionId);
    if (!section) return res.status(404).json({ error: 'Target section not found.' });
    const grade = req.body.grade_level ? clean(req.body.grade_level, 20) : (section.grade_level || null);
    const reason = clean(req.body.reason, 300);
    const results = [];
    const tx = db.transaction(() => {
      for (const sid of studentIds) {
        const student = db.prepare('SELECT * FROM students WHERE id=?').get(sid);
        if (!student) { results.push({ id: sid, ok: false, error: 'Student not found.' }); continue; }
        const effectiveGrade = grade || section.grade_level || student.grade_level;
        const effectiveTrackId = req.body.track_id !== undefined ? req.body.track_id : (section.track_id ?? null);
        const effectiveStrandId = req.body.strand_id !== undefined ? req.body.strand_id : (section.strand_id ?? null);
        const ts = validateTrackStrandForGrade(effectiveGrade, effectiveTrackId, effectiveStrandId);
        if (ts.error) { results.push({ id: sid, ok: false, error: ts.error }); continue; }
        const compat = validateSectionCompatibility(section, effectiveGrade, ts.track_id, ts.strand_id);
        if (compat) { results.push({ id: sid, ok: false, error: compat }); continue; }
        db.prepare('UPDATE students SET section_id=?, grade_level=?, track_id=?, strand_id=? WHERE id=?')
          .run(newSectionId, effectiveGrade, ts.track_id, ts.strand_id, sid);
        db.prepare('INSERT INTO section_assignments(student_id, old_section_id, new_section_id, changed_by, reason) VALUES (?,?,?,?,?)')
          .run(sid, student.section_id, newSectionId, req.session.user.id, reason);
        db.prepare(`
          INSERT INTO student_profiles(user_id, student_no, grade_level, section_id, track_id, strand_id, guardian_name, guardian_contact)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(student_no) DO UPDATE SET grade_level=excluded.grade_level, section_id=excluded.section_id, track_id=excluded.track_id, strand_id=excluded.strand_id
        `).run(student.user_id || null, student.student_number || null, grade, newSectionId, ts.track_id, ts.strand_id, student.guardian_name || '', student.guardian_contact || '');
        results.push({ id: sid, ok: true });
      }
    });
    tx();
    audit(req.session.user, 'Bulk reassign students', 'student', null, `${results.filter(r => r.ok).length}/${results.length} moved to section ${newSectionId}`);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(400).json({ error: 'Unable to bulk reassign students.' });
  }
});

// --- Exports (xlsx) ---
app.get('/api/exports/violations.xlsx', auth, verified, (req, res) => {
  try {
    const { base, params } = buildViolationsFilterQuery(req);
    const rows = db.prepare(`
      SELECT v.case_number, st.student_number, st.first_name, st.last_name, st.grade_level,
             s.section_name, s.school_year, tr.name track_name, sd.name strand_name,
             o.name offense, o.severity, v.incident_date, v.status, v.service_status,
             v.community_service_type, v.required_service_hours, v.completed_service_hours,
             (CASE WHEN COALESCE(v.required_service_hours,0) > COALESCE(v.completed_service_hours,0)
                   THEN ROUND(COALESCE(v.required_service_hours,0) - COALESCE(v.completed_service_hours,0), 2)
                   ELSE 0 END) remaining_service_hours,
             v.guardian_name, v.guardian_contact, v.created_at
      ${base}
      ORDER BY v.created_at DESC, v.id DESC
    `).all(...params);
    const headers = ['Case Number','Student Number','First Name','Last Name','Grade Level','Section','School Year','Track','Strand','Offense','Severity','Incident Date','Status','Service Status','Community Service Type','Required Service Hours','Completed Service Hours','Remaining Service Hours','Guardian Name','Guardian Contact','Created At'];
    const data = rows.map(r => [r.case_number,r.student_number,r.first_name,r.last_name,r.grade_level,r.section_name,r.school_year||'',r.track_name||'',r.strand_name||'',r.offense,r.severity,r.incident_date,r.status,r.service_status,r.community_service_type||'',r.required_service_hours,r.completed_service_hours,r.remaining_service_hours,r.guardian_name||'',r.guardian_contact||'',r.created_at]);
    sendXlsx(res, 'violations.xlsx', headers, data);
  } catch (e) {
    res.status(500).json({ error: 'Unable to export violations.' });
  }
});

app.get('/api/exports/community-service.xlsx', auth, verified, (req, res) => {
  try {
    const { sql, params } = buildCommunityServiceExportQuery(req);
    const rows = db.prepare(sql).all(...params);
    const headers = ['Violation ID','Case Number','Student Number','First Name','Last Name','Grade Level','Section','School Year','Track','Strand','Service Type','Required Hours','Completed Hours','Remaining Hours','Service Status','Guardian Name','Guardian Contact','Created At'];
    const data = rows.map(r => {
      const required = Number(r.required_service_hours || 0);
      const completed = Number(r.completed_service_hours || 0);
      const remaining = required > completed ? Math.round((required - completed) * 100) / 100 : 0;
      return [r.violation_id,r.case_number,r.student_number,r.first_name,r.last_name,r.grade_level,r.section_name,r.school_year||'',r.track_name||'',r.strand_name||'',r.community_service_type||'',r.required_service_hours,r.completed_service_hours,remaining,r.service_status,r.guardian_name||'',r.guardian_contact||'',r.created_at];
    });
    sendXlsx(res, 'community-service.xlsx', headers, data);
  } catch (e) {
    res.status(500).json({ error: 'Unable to export community service.' });
  }
});

app.get('/api/reports', auth, admin, (req, res) => {
  let q = 'SELECT o.name offense,o.severity,s.grade_level,s.section_name,COUNT(*) total FROM violations v JOIN students st ON st.id=v.student_id JOIN sections s ON s.id=st.section_id JOIN offense_catalog o ON o.id=v.offense_id';
  const p = [];

  if (isSectionStaffRole(req.session.user.role)) {
    q += ' WHERE st.section_id IN (SELECT section_id FROM teacher_sections WHERE teacher_id=?)';
    p.push(req.session.user.id);
  }

  q += ' GROUP BY o.id,s.id ORDER BY total DESC';
  res.json(db.prepare(q).all(...p));
});

app.get('/api/audit', auth, admin, (req, res) => {
  res.json(
    db.prepare('SELECT a.*,u.full_name actor FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 300').all()
  );
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`SVTS running at http://localhost:${PORT}`);
});