const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const db = require('./db');
const { Readable } = require('node:stream');

const app = express();
const PORT = process.env.PORT || 3000;
const fails = new Map();

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
const ALLOWED_GRADE_LEVELS = ['11', '12'];

function normalizeGradeLevel(v) {
  const g = String(v ?? '').trim();
  return ALLOWED_GRADE_LEVELS.includes(g) ? g : '';
}

function normalizeTrackStrand(v, max = 80) {
  return clean(v, max);
}

function normalizeTrack(v) {
  return normalizeTrackStrand(v, 80);
}

function normalizeStrand(v) {
  return normalizeTrackStrand(v, 80);
}

function roleLabel(role) {
  return {
    admin: 'Administrator',
    teacher: 'Teacher',
    guidance_counselor: 'Guidance Counselor',
    class_adviser: 'Class Adviser'
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

function validateGradeAndStrand(gradeLevel, strandValue, trackValue = '') {
  const grade = normalizeGradeLevel(gradeLevel);
  if (!grade) return { error: 'Only Grade 11 and Grade 12 are allowed.' };
  const strand = normalizeStrand(strandValue);
  const track = normalizeTrack(trackValue);
  return { grade_level: grade, strand, track, track_id: null, strand_id: null };
}

function upsertStudentProfileFromStudent(studentId) {
  const s = db.prepare(`
    SELECT st.id, st.user_id, st.student_number, st.grade_level, st.section_id, st.track_id, st.strand_id, st.track, st.guardian_name, st.guardian_contact,
           sec.strand AS section_strand, sec.track AS section_track
    FROM students st
    LEFT JOIN sections sec ON sec.id = st.section_id
    WHERE st.id = ?
  `).get(studentId);
  if (!s) return;
  const track = clean(s.track || s.section_track || '', 80);
  db.prepare(`
    INSERT INTO student_profiles(user_id, student_no, student_lrn, grade_level, section_id, track_id, strand_id, track, guardian_name, guardian_contact)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(student_no) DO UPDATE SET
      user_id=COALESCE(excluded.user_id, student_profiles.user_id),
      student_lrn=COALESCE(excluded.student_lrn, student_profiles.student_lrn),
      grade_level=excluded.grade_level,
      section_id=excluded.section_id,
      track_id=excluded.track_id,
      strand_id=excluded.strand_id,
      track=excluded.track,
      guardian_name=excluded.guardian_name,
      guardian_contact=excluded.guardian_contact
  `).run(s.user_id || null, s.student_number || null, s.student_number || null, s.grade_level || null, s.section_id || null, s.track_id || null, s.strand_id || null, track, s.guardian_name || '', s.guardian_contact || '');
}

function upsertStudentForViolation(payload, user) {
  const lrn = clean(payload.lrn || payload.LRN || payload.student_number || payload.studentNumber || payload.number, 40);
  const firstName = clean(payload.first_name || payload.firstName || payload.first, 80);
  const lastName = clean(payload.last_name || payload.lastName || payload.last, 80);
  const sectionId = Number(payload.section_id || payload.sectionId);
  const guardianName = clean(payload.guardian_name || payload.guardianName, 150);
  const guardianContact = clean(payload.guardian_contact || payload.guardianContact, 50);

  if (!lrn || !firstName || !lastName || !sectionId) {
    return { error: 'LRN, first name, last name, and section are required.' };
  }

  const section = db.prepare(`
    SELECT s.*, y.label AS school_year_label
    FROM sections s
    JOIN school_years y ON y.id = s.school_year_id
    WHERE s.id = ?
  `).get(sectionId);
  if (!section) return { error: 'Selected section is invalid.' };

  const grade = normalizeGradeLevel(payload.grade_level || payload.grade || section.grade_level);
  if (!grade) return { error: 'Only Grade 11 and Grade 12 are allowed.' };
  if (String(section.grade_level) !== grade) {
    return { error: 'Selected section does not match the student grade level.' };
  }

  const strand = normalizeStrand(payload.strand ?? payload.strand_group ?? section.strand ?? '');
  const track = normalizeTrack(payload.track ?? payload.track_name ?? section.track ?? '');
  const existing = db.prepare('SELECT * FROM students WHERE student_number = ?').get(lrn);

  if (existing) {
    if (existing.active !== 1) {
      return { error: 'This LRN belongs to an inactive student record and cannot be used.' };
    }
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE students
        SET first_name = ?, last_name = ?, grade_level = ?, section_id = ?, track_id = NULL, strand_id = NULL, track = ?,
            guardian_name = ?, guardian_contact = ?
        WHERE id = ?
      `).run(firstName, lastName, grade, sectionId, track, guardianName, guardianContact, existing.id);

      if (Number(existing.section_id) !== Number(sectionId)) {
        db.prepare('INSERT INTO section_assignments(student_id, old_section_id, new_section_id, changed_by, reason) VALUES (?,?,?,?,?)')
          .run(existing.id, existing.section_id, sectionId, user?.id || null, 'Updated via violation recording');
      }
      upsertStudentProfileFromStudent(existing.id);
      return db.prepare('SELECT * FROM students WHERE id = ?').get(existing.id);
    });
    return { student: tx(), created: false };
  }

  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO students(student_number,first_name,last_name,grade_level,section_id,track_id,strand_id,track,guardian_name,guardian_contact,active)
      VALUES (?,?,?,?,?,NULL,NULL,?,?,?,1)
    `).run(lrn, firstName, lastName, grade, sectionId, track, guardianName, guardianContact);
    upsertStudentProfileFromStudent(Number(r.lastInsertRowid));
    audit(user, 'Create student record (violation)', 'student', r.lastInsertRowid, lrn);
    return db.prepare('SELECT * FROM students WHERE id = ?').get(Number(r.lastInsertRowid));
  });
  return { student: tx(), created: true };
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
  const grade = normalizeGradeLevel(q.grade_level || q.grade);
  if (grade) { filters.push('s.grade_level = ?'); params.push(grade); }
  if (q.section_id) { filters.push('st.section_id = ?'); params.push(Number(q.section_id)); }
  const schoolYearId = Number(q.school_year_id || q.year || q.yearId || 0);
  if (schoolYearId) { filters.push('s.school_year_id = ?'); params.push(schoolYearId); }
  const strand = normalizeStrand(q.strand);
  if (strand) { filters.push('(s.strand = ? OR st.track = ? OR s.track = ?)'); params.push(strand, strand, strand); }
  const track = normalizeTrack(q.track);
  if (track) { filters.push('(s.track = ? OR st.track = ?)'); params.push(track, track); }
  if (q.violation_type) { filters.push('(o.id = ? OR lower(o.name) = lower(?))'); params.push(Number(q.violation_type) || 0, clean(q.violation_type, 120)); }
  if (q.service_status) { filters.push('v.service_status = ?'); params.push(clean(q.service_status, 30)); }
  const search = clean(q.search || q.lrn, 120);
  if (search) {
    const like = `%${search}%`;
    filters.push('(v.case_number LIKE ? OR st.student_number LIKE ? OR st.first_name LIKE ? OR st.last_name LIKE ? OR o.name LIKE ? OR v.description LIKE ? OR s.section_name LIKE ? OR s.strand LIKE ? OR s.track LIKE ?)');
    params.push(like, like, like, like, like, like, like, like, like);
  }
  const access = studentAccessClause(req, 'st');
  let where = ' WHERE st.grade_level IN (\'11\',\'12\')';
  if (filters.length) where += ' AND ' + filters.join(' AND ');
  if (access.sql) { where += access.sql; params.push(...access.params); }
  const base = `FROM violations v
    JOIN students st ON st.id=v.student_id
    JOIN sections s ON s.id=st.section_id
    LEFT JOIN school_years y ON y.id=s.school_year_id
    JOIN offense_catalog o ON o.id=v.offense_id
    JOIN users rec ON rec.id=v.recorded_by
    LEFT JOIN users ver ON ver.id=v.verified_by
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
    SELECT v.*, st.student_number, st.student_number AS lrn, st.first_name, st.last_name, st.grade_level,
           COALESCE(NULLIF(st.track,''), NULLIF(s.track,''), '') AS track_name,
           s.id section_id, s.section_name, s.school_year, y.label school_year_label,
           COALESCE(NULLIF(s.strand,''), '') AS strand_name,
           o.name offense, o.severity, rec.full_name recorded_by_name, ver.full_name verified_by_name
    ${base}
    ORDER BY v.created_at DESC, v.incident_date DESC, v.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset).map(r => ({ ...r, track_id: null, strand_id: null }));
  return { items, page, limit, total };
}

function buildCommunityServiceExportQuery(req) {
  const q = req.query || {};
  const { fromSql, toSql } = normalizeDateBounds(q.added_from, q.added_to);
  const filters = [];
  const params = [];
  if (fromSql) { filters.push('v.created_at >= ?'); params.push(fromSql); }
  if (toSql) { filters.push('v.created_at <= ?'); params.push(toSql); }
  const grade = normalizeGradeLevel(q.grade_level || q.grade);
  if (grade) { filters.push('s.grade_level = ?'); params.push(grade); }
  if (q.section_id) { filters.push('st.section_id = ?'); params.push(Number(q.section_id)); }
  const schoolYearId = Number(q.school_year_id || q.year || q.yearId || 0);
  if (schoolYearId) { filters.push('s.school_year_id = ?'); params.push(schoolYearId); }
  const strand = normalizeStrand(q.strand);
  if (strand) { filters.push('(s.strand = ? OR st.track = ? OR s.track = ?)'); params.push(strand, strand, strand); }
  const track = normalizeTrack(q.track);
  if (track) { filters.push('(s.track = ? OR st.track = ?)'); params.push(track, track); }
  if (q.service_status) { filters.push('v.service_status = ?'); params.push(clean(q.service_status, 30)); }
  const search = clean(q.search || q.lrn, 120);
  if (search) {
    const like = `%${search}%`;
    filters.push('(v.case_number LIKE ? OR st.student_number LIKE ? OR st.first_name LIKE ? OR st.last_name LIKE ?)');
    params.push(like, like, like, like);
  }
  const access = studentAccessClause(req, 'st');
  let where = ' WHERE st.grade_level IN (\'11\',\'12\')';
  if (filters.length) where += ' AND ' + filters.join(' AND ');
  if (access.sql) { where += access.sql; params.push(...access.params); }
  return {
    sql: `SELECT v.id violation_id, v.case_number, st.student_number, st.student_number AS lrn, st.first_name, st.last_name,
            st.grade_level, s.section_name, s.school_year, s.strand strand_name, COALESCE(NULLIF(s.track,''), NULLIF(st.track,''), '') track_name,
            v.community_service_type, v.required_service_hours, v.completed_service_hours, v.service_status,
            v.guardian_name, v.guardian_contact, v.created_at
          FROM violations v
          JOIN students st ON st.id=v.student_id
          JOIN sections s ON s.id=st.section_id
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

function generateCaseNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const prefix = `SV-${y}${m}${d}-`;
  for (let i = 0; i < 20; i++) {
    const suffix = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const candidate = `${prefix}${suffix}`;
    const exists = db.prepare('SELECT 1 FROM violations WHERE case_number = ?').get(candidate);
    if (!exists) return candidate;
  }
  return `SV-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
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
      SELECT s.id, s.school_year_id, COALESCE(NULLIF(s.school_year,''), y.label) AS school_year, s.grade_level, s.section_name AS name,
             COALESCE(NULLIF(s.track,''), '') AS track, COALESCE(NULLIF(s.strand,''), '') AS strand
      FROM sections s
      JOIN school_years y ON y.id = s.school_year_id
      WHERE y.is_active = 1 AND s.grade_level IN ('11','12')
      ORDER BY y.starts_on DESC, CAST(s.grade_level AS INTEGER), s.section_name
    `).all();
    const tracks = db.prepare("SELECT DISTINCT track AS name FROM sections WHERE TRIM(COALESCE(track,'')) <> '' ORDER BY track").all().map(r => r.name);
    const strands = db.prepare("SELECT DISTINCT strand AS name FROM sections WHERE TRIM(COALESCE(strand,'')) <> '' ORDER BY strand").all().map(r => r.name);
    res.json({ years, sections, tracks, strands, trackStrandEnabled: true });
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

app.delete('/api/users/:id', auth, admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const confirmText = String(req.body?.confirm || req.body?.confirmation || '').trim().toUpperCase();
    if (req.body?.confirmPermanent !== true && confirmText !== 'DELETE' && confirmText !== 'YES') {
      return res.status(400).json({ error: 'Permanent deletion requires explicit confirmation.' });
    }
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid account.' });
    if (id === req.session.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });

    const user = db.prepare('SELECT id, full_name, email, role, status FROM users WHERE id=?').get(id);
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const tx = db.transaction(() => {
      // clean up nullable/dependent references where safe
      try { db.prepare('DELETE FROM teacher_sections WHERE teacher_id=?').run(id); } catch {}
      try { db.prepare('DELETE FROM sessions WHERE sess LIKE ?').run(`%"id":${id}%`); } catch {}
      try { db.prepare('UPDATE users SET verified_by=NULL WHERE verified_by=?').run(id); } catch {}
      try { db.prepare('UPDATE violations SET verified_by=NULL WHERE verified_by=?').run(id); } catch {}
      try { db.prepare('UPDATE student_profiles SET user_id=NULL WHERE user_id=?').run(id); } catch {}
      try { db.prepare('UPDATE section_assignments SET changed_by=NULL WHERE changed_by=?').run(id); } catch {}
      try { db.prepare('UPDATE community_service_logs SET verified_by=NULL, recorded_by=NULL WHERE verified_by=? OR recorded_by=?').run(id, id); } catch {}
      try { db.prepare('UPDATE service_attendance SET recorded_by=NULL WHERE recorded_by=?').run(id); } catch {}
      try { db.prepare('UPDATE audit_logs SET user_id=NULL WHERE user_id=?').run(id); } catch {}
      db.prepare('DELETE FROM users WHERE id=?').run(id);
    });

    try {
      tx();
    } catch (e) {
      return res.status(409).json({ error: 'Cannot permanently delete this account because it is linked to existing records (violations, service logs, or other required data). Suspend the account instead.' });
    }

    audit(req.session.user, 'Delete user account', 'user', id, `${user.full_name} (${user.email || 'no email'})`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Unable to delete account.' });
  }
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

app.get('/api/years', auth, verified, (req, res) => {
  res.json(db.prepare('SELECT * FROM school_years ORDER BY label DESC').all());
});

app.post('/api/years', auth, admin, (req, res) => {
  try {
    const label = clean(req.body.label, 40);
    if (!label) return res.status(400).json({ error: 'School year label is required.' });
    const requestedActive = req.body.is_active;
    const setActive = requestedActive === true || requestedActive === 1 || requestedActive === '1' || String(requestedActive).toLowerCase() === 'active';
    const id = db.transaction(() => {
      const r = db.prepare('INSERT INTO school_years(label,starts_on,ends_on,is_active) VALUES(?,?,?,0)')
        .run(label, clean(req.body.startsOn || req.body.starts_on, 20) || null, clean(req.body.endsOn || req.body.ends_on, 20) || null);
      const newId = Number(r.lastInsertRowid);
      if (setActive) {
        db.prepare('UPDATE school_years SET is_active=0').run();
        db.prepare('UPDATE school_years SET is_active=1 WHERE id=?').run(newId);
      }
      return newId;
    })();
    audit(req.session.user, 'Create school year', 'school_year', id, `${label}${setActive ? ' (active)' : ''}`);
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: 'School year already exists or is invalid.' });
  }
});

app.put('/api/years/:id', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM school_years WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'School year not found.' });
  try {
    const label = req.body.label !== undefined ? clean(req.body.label, 40) : existing.label;
    if (!label) return res.status(400).json({ error: 'School year label is required.' });
    const startsOn = req.body.startsOn !== undefined || req.body.starts_on !== undefined ? (clean(req.body.startsOn || req.body.starts_on, 20) || null) : existing.starts_on;
    const endsOn = req.body.endsOn !== undefined || req.body.ends_on !== undefined ? (clean(req.body.endsOn || req.body.ends_on, 20) || null) : existing.ends_on;
    const hasStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'is_active') || Object.prototype.hasOwnProperty.call(req.body || {}, 'status');
    let setActive = !!existing.is_active;
    if (hasStatus) {
      const raw = Object.prototype.hasOwnProperty.call(req.body || {}, 'is_active') ? req.body.is_active : req.body.status;
      setActive = raw === true || raw === 1 || raw === '1' || String(raw).toLowerCase() === 'active';
    }
    db.transaction(() => {
      db.prepare('UPDATE school_years SET label=?,starts_on=?,ends_on=? WHERE id=?').run(label, startsOn, endsOn, id);
      if (hasStatus) {
        if (setActive) {
          db.prepare('UPDATE school_years SET is_active=0').run();
          db.prepare('UPDATE school_years SET is_active=1 WHERE id=?').run(id);
        } else {
          db.prepare('UPDATE school_years SET is_active=0 WHERE id=?').run(id);
        }
      }
    })();
    audit(req.session.user, 'Update school year', 'school_year', id, `${label} (${setActive ? 'active' : 'inactive'})`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Unable to update school year.' });
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

app.post('/api/years/:id/deactivate', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE school_years SET is_active=0 WHERE id=?').run(id);
  audit(req.session.user, 'Deactivate school year', 'school_year', id);
  res.json({ ok: true });
});

app.get('/api/sections', auth, verified, (req, res) => {
  const year = req.query.year || req.query.yearId;
  let q = `
    SELECT s.*, y.label school_year_label,
           COALESCE(NULLIF(s.school_year,''), y.label) school_year,
           COALESCE(NULLIF(s.track,''), '') AS track,
           COALESCE(NULLIF(s.strand,''), '') AS strand,
           COALESCE(NULLIF(s.strand,''), '') AS strand_name,
           COALESCE(NULLIF(s.track,''), '') AS track_name
    FROM sections s
    JOIN school_years y ON y.id=s.school_year_id
    WHERE s.grade_level IN ('11','12')`;
  const params = [];
  if (year) { q += ' AND s.school_year_id=?'; params.push(Number(year)); }
  if (isSectionStaffRole(req.session.user.role)) {
    q += ' AND s.id IN (SELECT section_id FROM teacher_sections WHERE teacher_id=?)';
    params.push(req.session.user.id);
  }
  q += ' ORDER BY y.label DESC, s.grade_level, s.section_name';
  const rows = db.prepare(q).all(...params).map(r => ({
    ...r,
    track_id: null,
    strand_id: null,
    track_code: null,
    strand_code: null
  }));
  res.json(rows);
});

app.post('/api/sections', auth, admin, (req, res) => {
  try {
    const yearId = Number(req.body.yearId || req.body.school_year_id);
    const year = db.prepare('SELECT label FROM school_years WHERE id=?').get(yearId);
    if (!year) return res.status(400).json({ error: 'Invalid school year.' });
    const grade = normalizeGradeLevel(req.body.grade || req.body.grade_level);
    const name = clean(req.body.name || req.body.section_name, 80);
    if (!grade || !name) return res.status(400).json({ error: 'Grade 11/12 and section name are required.' });
    const track = normalizeTrack(req.body.track || req.body.track_name);
    const strand = normalizeStrand(req.body.strand || req.body.strand_group || req.body.strand_name);
    if (!track || !strand) return res.status(400).json({ error: 'Track and strand are required.' });
    const schoolYearLabel = clean(req.body.school_year, 40) || year.label;
    const r = db.prepare(`
      INSERT INTO sections(school_year_id,grade_level,section_name,strand,track,track_id,strand_id,school_year)
      VALUES (?,?,?,?,?,NULL,NULL,?)
    `).run(yearId, grade, name, strand, track, schoolYearLabel);
    audit(req.session.user, 'Create section', 'section', r.lastInsertRowid, `G${grade} ${name} - ${track}/${strand}`);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Section already exists for this school year.' : 'Unable to create section. Use Grade 11 or Grade 12 with track and strand.' });
  }
});

app.put('/api/sections/:id', auth, admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT s.*, y.label year_label FROM sections s JOIN school_years y ON y.id=s.school_year_id WHERE s.id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'Section not found.' });
    const grade = normalizeGradeLevel(req.body.grade !== undefined ? req.body.grade : (req.body.grade_level !== undefined ? req.body.grade_level : existing.grade_level));
    const name = clean(req.body.name || req.body.section_name || existing.section_name, 80);
    if (!grade || !name) return res.status(400).json({ error: 'Grade 11/12 and section name are required.' });
    const track = req.body.track !== undefined || req.body.track_name !== undefined
      ? normalizeTrack(req.body.track ?? req.body.track_name)
      : normalizeTrack(existing.track);
    const strand = req.body.strand !== undefined || req.body.strand_group !== undefined || req.body.strand_name !== undefined
      ? normalizeStrand(req.body.strand ?? req.body.strand_group ?? req.body.strand_name)
      : normalizeStrand(existing.strand);
    if (!track || !strand) return res.status(400).json({ error: 'Track and strand are required.' });
    const schoolYearLabel = req.body.school_year !== undefined ? (clean(req.body.school_year, 40) || existing.school_year || existing.year_label || '') : (existing.school_year || existing.year_label || '');
    db.prepare('UPDATE sections SET grade_level=?,section_name=?,strand=?,track=?,track_id=NULL,strand_id=NULL,school_year=? WHERE id=?')
      .run(grade, name, strand, track, schoolYearLabel, id);
    audit(req.session.user, 'Edit section', 'section', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Section already exists for this school year.' : 'Section update failed.' });
  }
});

app.delete('/api/sections/:id', auth, admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const used = db.prepare('SELECT 1 FROM students WHERE section_id=? AND active=1 LIMIT 1').get(id);
    if (used) return res.status(409).json({ error: 'Cannot delete section with active student records.' });
    db.prepare('DELETE FROM teacher_sections WHERE section_id=?').run(id);
    db.prepare('DELETE FROM sections WHERE id=?').run(id);
    audit(req.session.user, 'Delete section', 'section', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Section has linked records and cannot be deleted.' });
  }
});

app.get('/api/students', auth, verified, (req, res) => {
  const year = req.query.year || req.query.yearId;
  const search = clean(req.query.q || req.query.search || req.query.lrn, 120);
  let q = `
    SELECT st.*, st.student_number AS lrn,
           s.grade_level section_grade_level, s.section_name,
           COALESCE(NULLIF(s.school_year,''), y.label) school_year,
           COALESCE(NULLIF(s.strand,''), '') AS strand_name,
           COALESCE(NULLIF(s.track,''), COALESCE(NULLIF(st.track,''), '')) AS track_name
    FROM students st
    JOIN sections s ON s.id=st.section_id
    LEFT JOIN school_years y ON y.id=s.school_year_id
    WHERE st.active=1 AND st.grade_level IN ('11','12')
  `;
  const p = [];
  if (year) { q += ' AND s.school_year_id=?'; p.push(Number(year)); }
  if (isSectionStaffRole(req.session.user.role)) {
    q += ' AND st.section_id IN (SELECT section_id FROM teacher_sections WHERE teacher_id=?)';
    p.push(req.session.user.id);
  }
  if (search) {
    const like = `%${search}%`;
    q += ' AND (st.student_number LIKE ? OR st.first_name LIKE ? OR st.last_name LIKE ?)';
    p.push(like, like, like);
  }
  q += ' ORDER BY s.grade_level,s.section_name,st.last_name,st.first_name';
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '200', 10) || 200));
  q += ' LIMIT ?';
  p.push(limit);
  const rows = db.prepare(q).all(...p).map(r => ({
    ...r,
    track_id: null,
    strand_id: null,
    strand_id_name: null
  }));
  res.json(rows);
});

app.get('/api/offenses', auth, verified, (req, res) => {
  const isAdmin = req.session.user && req.session.user.role === 'admin';
  const sql = isAdmin
    ? 'SELECT id,name,severity,description,active,active AS is_active FROM offense_catalog ORDER BY severity,name'
    : 'SELECT id,name,severity,description,active,active AS is_active FROM offense_catalog WHERE active=1 ORDER BY severity,name';
  res.json(db.prepare(sql).all());
});

app.post('/api/offenses', auth, admin, (req, res) => {
  try {
    const name = clean(req.body.name, 120);
    const severity = clean(req.body.severity, 20);
    const description = clean(req.body.description, 500);
    const active = (req.body.active === 0 || req.body.active === false || String(req.body.active) === '0' || String(req.body.active).toLowerCase() === 'inactive') ? 0 : 1;
    if (!name) return res.status(400).json({ error: 'Offense name is required.' });
    if (!['Minor','Major','Serious'].includes(severity)) return res.status(400).json({ error: 'Severity must be Minor, Major, or Serious.' });
    const r = db.prepare('INSERT INTO offense_catalog(name,severity,description,active) VALUES(?,?,?,?)')
      .run(name, severity, description, active);
    audit(req.session.user, 'Create offense', 'offense', r.lastInsertRowid);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Offense name must be unique and severity valid.' });
  }
});

app.put('/api/offenses/:id', auth, admin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM offense_catalog WHERE id=?').get(id);
    if (!existing) return res.status(404).json({ error: 'Offense not found.' });
    const name = req.body.name !== undefined ? clean(req.body.name, 120) : existing.name;
    const severity = req.body.severity !== undefined ? clean(req.body.severity, 20) : existing.severity;
    const description = req.body.description !== undefined ? clean(req.body.description, 500) : existing.description;
    let active = existing.active;
    if (req.body.active !== undefined) active = (req.body.active === 0 || req.body.active === false || String(req.body.active) === '0' || String(req.body.active).toLowerCase() === 'inactive') ? 0 : 1;
    if (!name) return res.status(400).json({ error: 'Offense name is required.' });
    if (!['Minor','Major','Serious'].includes(severity)) return res.status(400).json({ error: 'Severity must be Minor, Major, or Serious.' });
    db.prepare('UPDATE offense_catalog SET name=?, severity=?, description=?, active=? WHERE id=?').run(name, severity, description, active, id);
    audit(req.session.user, 'Update offense', 'offense', id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Unable to update offense (name may be duplicate).' });
  }
});

app.post('/api/violations', auth, admin, (req, res) => {
  try {
    let caseNumber = clean(req.body.caseNumber || req.body.case_number, 40);
    if (!caseNumber) caseNumber = generateCaseNumber();
    const offenseId = Number(req.body.offenseId || req.body.offense_id);
    const incidentDate = parseDateInput(req.body.date || req.body.incident_date);
    if (!Number.isInteger(offenseId) || offenseId <= 0 || !incidentDate) {
      return res.status(400).json({ error: 'Offense and incident date are required.' });
    }

    const up = upsertStudentForViolation(req.body || {}, req.session.user);
    if (up.error) return res.status(400).json({ error: up.error });
    const student = up.student;

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
    const serviceStatus = requiredHours <= 0 ? 'none' : (completedHours >= requiredHours ? 'completed' : (completedHours > 0 ? 'in_progress' : 'pending'));

    const guardianName = clean(req.body.guardian_name ?? req.body.guardianName ?? student.guardian_name ?? '', 150);
    const guardianContact = clean(req.body.guardian_contact ?? req.body.guardianContact ?? student.guardian_contact ?? '', 50);
    const communityServiceType = clean(req.body.community_service_type ?? req.body.communityServiceType ?? '', 120) || null;

    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = db.prepare(`
          INSERT INTO violations(
            case_number, student_id, offense_id, incident_date, incident_time, location, description, evidence_notes,
            community_service_type, required_service_hours, completed_service_hours, service_status,
            guardian_name, guardian_contact, recorded_by
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          caseNumber,
          student.id,
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
        break;
      } catch (err) {
        if (attempt < 2 && String(err.message || '').includes('UNIQUE') && !clean(req.body.caseNumber || req.body.case_number, 40)) {
          caseNumber = generateCaseNumber();
          continue;
        }
        throw err;
      }
    }
    audit(req.session.user, 'Record violation', 'violation', r.lastInsertRowid, up.created ? `new student ${student.student_number}` : `student ${student.student_number}`);
    res.json({ id: r.lastInsertRowid, case_number: caseNumber, service_status: serviceStatus, student_id: student.id, student_created: !!up.created });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Case number must be unique.' : 'Violation record invalid. Check student, offense, and date details.' });
  }
});

app.get('/api/violations', auth, verified, (req, res) => {
  try {
    const { base, params } = buildViolationsFilterQuery(req);
    const rows = db.prepare(`
      SELECT v.*, st.student_number, st.student_number AS lrn, st.first_name, st.last_name, st.grade_level,
             s.section_name, s.school_year, COALESCE(NULLIF(s.strand,''), '') AS strand_name,
             COALESCE(NULLIF(s.track,''), NULLIF(st.track,''), '') AS track_name,
             o.name offense, o.severity,
             rec.full_name recorded_by_name, ver.full_name verified_by_name
      ${base}
      ORDER BY v.incident_date DESC, v.id DESC
      LIMIT 500
    `).all(...params).map(r => ({ ...r, track_id: null, strand_id: null }));
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
  let q = 'SELECT cs.*, st.student_number AS lrn, st.first_name, st.last_name, st.grade_level, st.track AS track_name, s.section_name, s.track AS section_track, s.strand AS strand_name, y.label school_year, v.case_number, COALESCE((SELECT SUM(hours_served) FROM service_attendance a WHERE a.service_id=cs.id),0) hours_completed, COALESCE((SELECT SUM(day_completed) FROM service_attendance a WHERE a.service_id=cs.id),0) days_completed FROM community_service cs JOIN students st ON st.id=cs.student_id JOIN sections s ON s.id=st.section_id JOIN school_years y ON y.id=cs.school_year_id LEFT JOIN violations v ON v.id=cs.violation_id';
  const p = [];
  const filters = [];

  if (isSectionStaffRole(req.session.user.role)) {
    filters.push('st.section_id IN (SELECT section_id FROM teacher_sections WHERE teacher_id=?)');
    p.push(req.session.user.id);
  }
  const schoolYearId = Number(req.query.school_year_id || req.query.year || req.query.yearId || 0);
  if (schoolYearId) {
    filters.push('cs.school_year_id = ?');
    p.push(schoolYearId);
  }
  if (filters.length) q += ' WHERE ' + filters.join(' AND ');

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

// --- Academic config (admin-defined track/strand inputs based on existing sections; no coded list) ---
app.get('/api/academic/track-strand-config', auth, verified, (req, res) => {
  const tracks = db.prepare("SELECT DISTINCT track AS name FROM sections WHERE TRIM(COALESCE(track,'')) <> '' ORDER BY track COLLATE NOCASE").all().map((r, i) => ({ id: i + 1, code: r.name, name: r.name, is_active: 1 }));
  const strands = db.prepare("SELECT DISTINCT strand AS name FROM sections WHERE TRIM(COALESCE(strand,'')) <> '' ORDER BY strand COLLATE NOCASE").all().map((r, i) => ({ id: i + 1, code: r.name, name: r.name, is_active: 1, track_id: null, track_name: null, track_code: null }));
  res.json({
    tracks,
    strands,
    grades: { '11': { enabled: true }, '12': { enabled: true } },
    enabled: true,
    fixed: false
  });
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
    const grade = normalizeGradeLevel(req.query.grade_level || req.query.grade);
    if (grade) { filters.push('s.grade_level = ?'); params.push(grade); }
    if (req.query.section_id) { filters.push('st.section_id = ?'); params.push(Number(req.query.section_id)); }
    const schoolYearId = Number(req.query.school_year_id || req.query.year || req.query.yearId || 0);
    if (schoolYearId) { filters.push('s.school_year_id = ?'); params.push(schoolYearId); }
    const strand = normalizeStrand(req.query.strand);
    if (strand) { filters.push('(s.strand = ? OR st.track = ? OR s.track = ?)'); params.push(strand, strand, strand); }
    const track = normalizeTrack(req.query.track);
    if (track) { filters.push('(s.track = ? OR st.track = ?)'); params.push(track, track); }
    if (req.query.service_status) { filters.push('v.service_status = ?'); params.push(clean(req.query.service_status, 30)); }
    const access = studentAccessClause(req, 'st');
    let where = ' WHERE l.service_date >= ? AND l.service_date <= ? AND st.grade_level IN (\'11\',\'12\')';
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
    const schoolYearId = Number(req.query.school_year_id || req.query.year || req.query.yearId || 0);
    if (schoolYearId) { filters.push('s.school_year_id = ?'); params.push(schoolYearId); }
    const access = studentAccessClause(req, 'st');
    let where = ' WHERE substr(l.service_date,1,10)=?';
    if (filters.length) where += ' AND ' + filters.join(' AND ');
    if (access.sql) { where += access.sql; params.push(...access.params); }
    const rows = db.prepare(`
      SELECT l.*, st.student_number, st.student_number AS lrn, st.first_name, st.last_name, st.grade_level,
             st.track AS track_name, s.section_name, s.track AS section_track, s.strand AS strand_name,
             v.case_number, v.required_service_hours, v.completed_service_hours, v.service_status,
             o.name AS offense, v.incident_date,
             (CASE WHEN v.required_service_hours IS NULL THEN NULL ELSE MAX(v.required_service_hours - v.completed_service_hours, 0) END) AS remaining_hours,
             u.full_name AS verified_by_name
      FROM community_service_logs l
      JOIN students st ON st.id=l.student_id
      JOIN sections s ON s.id=st.section_id
      LEFT JOIN violations v ON v.id=l.violation_id
      LEFT JOIN offenses o ON o.id=v.offense_id
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

// Student section reassignment and separate student management removed in simplified system. Student details are captured in violation records.

// --- Exports (xlsx) ---
app.get('/api/exports/violations.xlsx', auth, verified, (req, res) => {
  try {
    const { base, params } = buildViolationsFilterQuery(req);
    const rows = db.prepare(`
      SELECT v.case_number, st.student_number, st.first_name, st.last_name, st.grade_level,
             s.section_name, s.school_year, COALESCE(NULLIF(s.strand,''), '') strand_name,
             COALESCE(NULLIF(s.track,''), NULLIF(st.track,''), '') track_name,
             o.name offense, o.severity, v.incident_date, v.status, v.service_status,
             v.community_service_type, v.required_service_hours, v.completed_service_hours,
             (CASE WHEN COALESCE(v.required_service_hours,0) > COALESCE(v.completed_service_hours,0)
                   THEN ROUND(COALESCE(v.required_service_hours,0) - COALESCE(v.completed_service_hours,0), 2)
                   ELSE 0 END) remaining_service_hours,
             v.guardian_name, v.guardian_contact, v.created_at
      ${base}
      ORDER BY v.created_at DESC, v.id DESC
    `).all(...params);
    const headers = ['Case Number','LRN','First Name','Last Name','Grade Level','Section','School Year','Track','Strand/Group','Offense','Severity','Incident Date','Status','Service Status','Community Service Type','Required Service Hours','Completed Service Hours','Remaining Service Hours','Guardian Name','Guardian Contact','Created At'];
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
    const headers = ['Violation ID','Case Number','LRN','First Name','Last Name','Grade Level','Section','School Year','Track','Strand/Group','Service Type','Required Hours','Completed Hours','Remaining Hours','Service Status','Guardian Name','Guardian Contact','Created At'];
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


