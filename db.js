const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'svts.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8'));

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function ensureColumn(table, column, definition) {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableSql(table) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  return row ? String(row.sql || '') : '';
}

function migrateUsersTableIfNeeded() {
  const sql = tableSql('users');
  if (!sql) return;
  const needsEmailNullable = /email\s+TEXT\s+NOT\s+NULL/i.test(sql);
  const needsEmailUniqueInline = /email\s+TEXT[\s\S]*?\bUNIQUE\b/i.test(sql);
  const needsStaffRoles = !/guidance_counselor/i.test(sql) || !/class_adviser/i.test(sql);
  const needsRequestedSection = !/requested_section_id/i.test(sql);
  if (!needsEmailNullable && !needsEmailUniqueInline && !needsStaffRoles && !needsRequestedSection) return;

  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    const hasRequestedSection = /requested_section_id/i.test(sql);
    db.exec(`
      CREATE TABLE IF NOT EXISTS users_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','teacher','student','guidance_counselor','class_adviser')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected','suspended')),
        requested_section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
        verified_by INTEGER REFERENCES users(id), verified_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users_migrated(id,full_name,email,password_hash,role,status,requested_section_id,verified_by,verified_at,created_at)
      SELECT id,full_name,NULLIF(email,''),password_hash,role,status,${hasRequestedSection ? 'requested_section_id' : 'NULL'},verified_by,verified_at,created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_migrated RENAME TO users;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL;
    `);
  });
  try {
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function ensureMigrations() {
  migrateUsersTableIfNeeded();
  ensureColumn('users', 'requested_section_id', 'INTEGER REFERENCES sections(id) ON DELETE SET NULL');

  // sections: dynamic tracks/strands and explicit school year label
  ensureColumn('sections', 'track_id', 'INTEGER REFERENCES tracks(id) ON DELETE SET NULL');
  ensureColumn('sections', 'strand_id', 'INTEGER REFERENCES strands(id) ON DELETE SET NULL');
  ensureColumn('sections', 'school_year', "TEXT DEFAULT ''");

  // students / profiles
  ensureColumn('students', 'track_id', 'INTEGER REFERENCES tracks(id) ON DELETE SET NULL');
  ensureColumn('students', 'strand_id', 'INTEGER REFERENCES strands(id) ON DELETE SET NULL');
  ensureColumn('students', 'guardian_name', "TEXT DEFAULT ''");
  ensureColumn('students', 'guardian_contact', "TEXT DEFAULT ''");
  ensureColumn('students', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');

  // violations: service and guardian snapshot fields
  ensureColumn('violations', 'community_service_type', 'TEXT DEFAULT NULL');
  ensureColumn('violations', 'required_service_hours', 'REAL NOT NULL DEFAULT 0.00');
  ensureColumn('violations', 'completed_service_hours', 'REAL NOT NULL DEFAULT 0.00');
  ensureColumn('violations', 'service_status', "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn('violations', 'guardian_name', "TEXT DEFAULT ''");
  ensureColumn('violations', 'guardian_contact', "TEXT DEFAULT ''");

  // backfill school_year label on sections for existing rows
  try {
    db.exec(`
      UPDATE sections
      SET school_year = (
        SELECT y.label FROM school_years y WHERE y.id = sections.school_year_id
      )
      WHERE (school_year IS NULL OR school_year = '')
        AND school_year_id IS NOT NULL
    `);
  } catch {}

  // backfill student_profiles from existing students where missing
  try {
    const rows = db.prepare('SELECT id, student_number, grade_level, section_id, track_id, strand_id, guardian_name, guardian_contact, user_id FROM students').all();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO student_profiles(user_id, student_no, grade_level, section_id, track_id, strand_id, guardian_name, guardian_contact)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const s of items) {
        insert.run(s.user_id || null, s.student_number || null, s.grade_level || null, s.section_id || null, s.track_id || null, s.strand_id || null, s.guardian_name || '', s.guardian_contact || '');
      }
    });
    tx(rows);
  } catch {}

  // normalize violations service_status based on required/completed hours
  try {
    db.exec(`
      UPDATE violations
      SET service_status = CASE
        WHEN COALESCE(required_service_hours, 0) <= 0 THEN 'none'
        WHEN COALESCE(completed_service_hours, 0) >= COALESCE(required_service_hours, 0) AND COALESCE(required_service_hours, 0) > 0 THEN 'completed'
        WHEN COALESCE(completed_service_hours, 0) > 0 THEN 'in_progress'
        ELSE 'pending'
      END
      WHERE service_status IS NULL OR service_status = '' OR service_status NOT IN ('none','pending','in_progress','completed')
    `);
  } catch {}
}

ensureMigrations();


function ensureDefaultAdminAccount() {
  const email = 'admin@svts.local';
  const existing = db.prepare('SELECT id, role, status FROM users WHERE lower(email)=lower(?)').get(email);
  if (existing) return;
  const passwordHash = bcrypt.hashSync('Admin@12345', 12);
  db.prepare(`
    INSERT INTO users (full_name, email, password_hash, role, status, verified_at)
    VALUES (?, ?, ?, 'admin', 'verified', CURRENT_TIMESTAMP)
  `).run('System Administrator', email, passwordHash);
}

ensureDefaultAdminAccount();
module.exports = db;
