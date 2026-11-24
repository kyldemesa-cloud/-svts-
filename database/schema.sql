PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 full_name TEXT NOT NULL,
 email TEXT,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','teacher','student','guidance_counselor','class_adviser')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected','suspended')),
 verified_by INTEGER REFERENCES users(id), verified_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS school_years (
 id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL UNIQUE,
 starts_on TEXT, ends_on TEXT, is_active INTEGER NOT NULL DEFAULT 0,
 archived_at TEXT
);

CREATE TABLE IF NOT EXISTS tracks (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 code TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 is_active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS strands (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
 code TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 is_active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sections (
 id INTEGER PRIMARY KEY AUTOINCREMENT, school_year_id INTEGER NOT NULL REFERENCES school_years(id),
 grade_level TEXT NOT NULL, section_name TEXT NOT NULL, strand TEXT DEFAULT '',
 track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
 strand_id INTEGER REFERENCES strands(id) ON DELETE SET NULL,
 school_year TEXT DEFAULT '',
 UNIQUE(school_year_id, grade_level, section_name)
);
CREATE TABLE IF NOT EXISTS teacher_sections (
 teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
 PRIMARY KEY(teacher_id, section_id)
);
CREATE TABLE IF NOT EXISTS students (
 id INTEGER PRIMARY KEY AUTOINCREMENT, student_number TEXT UNIQUE,
 first_name TEXT NOT NULL, last_name TEXT NOT NULL,
 grade_level TEXT NOT NULL, section_id INTEGER NOT NULL REFERENCES sections(id),
 track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
 strand_id INTEGER REFERENCES strands(id) ON DELETE SET NULL,
 guardian_name TEXT DEFAULT '',
 guardian_contact TEXT DEFAULT '',
 user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS student_profiles (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 student_no TEXT UNIQUE,
 grade_level TEXT,
 section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
 track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
 strand_id INTEGER REFERENCES strands(id) ON DELETE SET NULL,
 guardian_name TEXT DEFAULT '',
 guardian_contact TEXT DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS section_assignments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
 old_section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
 new_section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
 changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 reason TEXT DEFAULT '',
 changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offense_catalog (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
 severity TEXT NOT NULL CHECK(severity IN ('Minor','Major','Serious')),
 description TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS violations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, case_number TEXT NOT NULL UNIQUE,
 student_id INTEGER NOT NULL REFERENCES students(id), offense_id INTEGER NOT NULL REFERENCES offense_catalog(id),
 incident_date TEXT NOT NULL, incident_time TEXT, location TEXT, description TEXT,
 evidence_notes TEXT, status TEXT NOT NULL DEFAULT 'Reported',
 community_service_type TEXT DEFAULT NULL,
 required_service_hours REAL NOT NULL DEFAULT 0.00,
 completed_service_hours REAL NOT NULL DEFAULT 0.00,
 service_status TEXT NOT NULL DEFAULT 'none' CHECK(service_status IN ('none','pending','in_progress','completed')),
 guardian_name TEXT DEFAULT '',
 guardian_contact TEXT DEFAULT '',
 recorded_by INTEGER NOT NULL REFERENCES users(id), verified_by INTEGER REFERENCES users(id), verified_at TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS community_service (
 id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL REFERENCES students(id),
 violation_id INTEGER REFERENCES violations(id), school_year_id INTEGER NOT NULL REFERENCES school_years(id),
 service_days_required INTEGER NOT NULL DEFAULT 0, hours_required REAL NOT NULL DEFAULT 0,
 start_date TEXT, due_date TEXT, notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'Assigned',
 created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS service_attendance (
 id INTEGER PRIMARY KEY AUTOINCREMENT, service_id INTEGER NOT NULL REFERENCES community_service(id) ON DELETE CASCADE,
 service_date TEXT NOT NULL, hours_served REAL NOT NULL DEFAULT 0, day_completed INTEGER NOT NULL DEFAULT 0,
 notes TEXT DEFAULT '', recorded_by INTEGER NOT NULL REFERENCES users(id),
 UNIQUE(service_id, service_date)
);
CREATE TABLE IF NOT EXISTS community_service_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 violation_id INTEGER REFERENCES violations(id) ON DELETE CASCADE,
 student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
 service_date TEXT NOT NULL,
 hours_rendered REAL NOT NULL DEFAULT 0.00,
 remarks TEXT DEFAULT '',
 verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_service_logs_date ON community_service_logs(service_date);
CREATE INDEX IF NOT EXISTS idx_community_service_logs_violation ON community_service_logs(violation_id, service_date);

CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
 entity_type TEXT, entity_id INTEGER, details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_student_section ON students(section_id, active);
CREATE INDEX IF NOT EXISTS idx_violations_student_date ON violations(student_id, incident_date);
CREATE INDEX IF NOT EXISTS idx_violations_created_at ON violations(created_at);
CREATE INDEX IF NOT EXISTS idx_service_student ON community_service(student_id, status);
CREATE INDEX IF NOT EXISTS idx_attendance_service_date ON service_attendance(service_id, service_date);
CREATE INDEX IF NOT EXISTS idx_section_assignments_student ON section_assignments(student_id, changed_at);