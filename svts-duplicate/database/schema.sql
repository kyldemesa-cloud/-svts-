-- PostgreSQL schema for SVTS

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'adviser', 'student')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'suspended')),
  verified_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users (LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS school_years (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  starts_on DATE,
  ends_on DATE,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tracks (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strands (
  id BIGSERIAL PRIMARY KEY,
  track_id BIGINT REFERENCES tracks(id) ON DELETE SET NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sections (
  id BIGSERIAL PRIMARY KEY,
  school_year_id BIGINT NOT NULL REFERENCES school_years(id) ON DELETE RESTRICT,
  grade_level TEXT NOT NULL,
  section_name TEXT NOT NULL,
  strand TEXT DEFAULT '',
  track_id BIGINT REFERENCES tracks(id) ON DELETE SET NULL,
  strand_id BIGINT REFERENCES strands(id) ON DELETE SET NULL,
  school_year TEXT DEFAULT '',
  UNIQUE (school_year_id, grade_level, section_name)
);

CREATE TABLE IF NOT EXISTS teacher_sections (
  teacher_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id BIGINT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  PRIMARY KEY (teacher_id, section_id)
);

CREATE TABLE IF NOT EXISTS students (
  id BIGSERIAL PRIMARY KEY,
  student_number TEXT UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  grade_level TEXT NOT NULL,
  section_id BIGINT NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
  track_id BIGINT REFERENCES tracks(id) ON DELETE SET NULL,
  strand_id BIGINT REFERENCES strands(id) ON DELETE SET NULL,
  guardian_name TEXT DEFAULT '',
  guardian_contact TEXT DEFAULT '',
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS student_profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  student_no TEXT UNIQUE,
  grade_level TEXT,
  section_id BIGINT REFERENCES sections(id) ON DELETE SET NULL,
  track_id BIGINT REFERENCES tracks(id) ON DELETE SET NULL,
  strand_id BIGINT REFERENCES strands(id) ON DELETE SET NULL,
  guardian_name TEXT DEFAULT '',
  guardian_contact TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS section_assignments (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  old_section_id BIGINT REFERENCES sections(id) ON DELETE SET NULL,
  new_section_id BIGINT REFERENCES sections(id) ON DELETE SET NULL,
  changed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT DEFAULT '',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offense_catalog (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL CHECK (severity IN ('Minor', 'Major', 'Serious')),
  description TEXT DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS violations (
  id BIGSERIAL PRIMARY KEY,
  case_number TEXT NOT NULL UNIQUE,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  offense_id BIGINT NOT NULL REFERENCES offense_catalog(id) ON DELETE RESTRICT,
  incident_date DATE NOT NULL,
  incident_time TEXT,
  location TEXT,
  description TEXT,
  evidence_notes TEXT,
  status TEXT NOT NULL DEFAULT 'Reported',
  community_service_type TEXT DEFAULT NULL,
  required_service_hours NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  completed_service_hours NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  service_status TEXT NOT NULL DEFAULT 'none' CHECK (service_status IN ('none', 'pending', 'in_progress', 'completed')),
  guardian_name TEXT DEFAULT '',
  guardian_contact TEXT DEFAULT '',
  recorded_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verified_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS community_service (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  violation_id BIGINT REFERENCES violations(id) ON DELETE SET NULL,
  school_year_id BIGINT NOT NULL REFERENCES school_years(id) ON DELETE RESTRICT,
  service_days_required INTEGER NOT NULL DEFAULT 0,
  hours_required NUMERIC(6,2) NOT NULL DEFAULT 0,
  start_date DATE,
  due_date DATE,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Assigned',
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_attendance (
  id BIGSERIAL PRIMARY KEY,
  service_id BIGINT NOT NULL REFERENCES community_service(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  hours_served NUMERIC(5,2) NOT NULL DEFAULT 0,
  day_completed BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT DEFAULT '',
  recorded_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE (service_id, service_date)
);

CREATE TABLE IF NOT EXISTS community_service_logs (
  id BIGSERIAL PRIMARY KEY,
  violation_id BIGINT REFERENCES violations(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  service_date DATE NOT NULL,
  hours_rendered NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  remarks TEXT DEFAULT '',
  verified_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id BIGINT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_student_section ON students(section_id, active);
CREATE INDEX IF NOT EXISTS idx_violations_student_date ON violations(student_id, incident_date);
CREATE INDEX IF NOT EXISTS idx_violations_created_at ON violations(created_at);
CREATE INDEX IF NOT EXISTS idx_service_student ON community_service(student_id, status);
CREATE INDEX IF NOT EXISTS idx_attendance_service_date ON service_attendance(service_id, service_date);
CREATE INDEX IF NOT EXISTS idx_community_service_logs_date ON community_service_logs(service_date);
CREATE INDEX IF NOT EXISTS idx_community_service_logs_violation ON community_service_logs(violation_id, service_date);
CREATE INDEX IF NOT EXISTS idx_section_assignments_student ON section_assignments(student_id, changed_at);
