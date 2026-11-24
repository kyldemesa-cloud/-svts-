# SVTS Duplicate (PostgreSQL) — Deliverables and Implementation Notes

This folder is an exact-copy-derived duplicate of the SVTS system with:
- **PostgreSQL backend foundation** (schema, async `pg` data layer, Render/Docker config updates)
- **Admin and adviser request-for-approval workflow** (backend + initial UI wiring)
- The **7 requested enhancements** already present in the source app and carried into the duplicate (requires runtime revalidation under PostgreSQL)

> **Status:** code-level migration and feature wiring are partially complete. The duplicate requires full route-by-route PostgreSQL/async verification, dependency install (`npm install`), and end-to-end testing against a PostgreSQL database. Node/npm were not available in the current environment for runtime validation.

---

## 1. Database / Schema Changes

**File:** `database/schema.sql` (rewritten for PostgreSQL)

### New/updated types and conventions
- `BIGSERIAL` primary keys (replacing SQLite autoincrement IDs)
- `TIMESTAMPTZ` for created/updated/verified timestamps and log/audit events
- `DATE` for school-year bounds, violation dates, and service log dates
- `BOOLEAN` for active/archive flags and reassignment flags
- `NUMERIC(6,2)` for `community_service_hours`, `required_hours`, and `rendered_hours`

### Roles / approval workflow
- `users.role` check updated to include **`adviser`**: `admin | teacher | adviser | student`
- `users.status` retained: `pending | verified | suspended | rejected`
- `users.email` remains nullable for student accounts; **case-insensitive uniqueness** enforced for non-null emails:
  - `CREATE UNIQUE INDEX uq_users_email_lower ON users (LOWER(email)) WHERE email IS NOT NULL;`
- Approval metadata retained: `verified_by`, `verified_at`

### Tables (core, preserved and Postgres-adapted)
- **`users`**: staff/student accounts, roles, approval/suspension status, optional email/password hash
- **`school_years`**: label, start/end dates, active/archive flags
- **`tracks`** *(dynamic, optional, G11–12)*: code, name, active flag
- **`strands`** *(dynamic, optional, G11–12)*: code, name, `track_id` FK, active flag
- **`sections`**: school year, grade, section, optional `track_id`/`strand_id`, timestamps
- **`students`**: student number, names, grade/section/strand/school-year snapshots, status, timestamps
- **`student_profiles`**: guardian/contact/address/notes and audit timestamps (auto-population source for violation guardian fields)
- **`teacher_sections`**: staff (teacher/adviser) ↔ section assignments, unique pair, timestamps
- **`student_section_assignments`**: assignment/reassignment history (from/to section/year, grade/track/strand snapshots, effective dates, reason, actor)
- **`offenses`**: offense catalog (name, severity, description)
- **`violations`**: case number, student/teacher FKs, incident details, status, `remarks`, **guardian snapshot** (`guardian_name`, `guardian_contact`), **community service assignment** (`community_service`, `community_service_type`, `community_service_hours`, `required_hours`), completion timestamp, timestamps
- **`community_service_logs`**: per-date rendered-hour entries per violation (`log_date`, `rendered_hours`, notes, recorded_by, unique violation+date)
- **`audit_logs`**: user action/entity audit trail

### Indexes / relationships
- Unique student number, unique case number, unique teacher-section and assignment-history support indexes
- Indexes for sections/students lookups, violations by student/date/status, service logs by violation/date, audit lookups
- Foreign keys across school years, tracks/strands, sections, students/profiles, assignments, violations/offenses/users, and service logs
- `ON CONFLICT` targets used in Postgres-style upserts for section assignments/history and service log updates (must match unique constraints during runtime validation)

---

## 2. Backend / API & Business Logic

**Files:** `db.js`, `server.js`, `package.json`, `render.yaml`, `Dockerfile` (partial migration in `server.js`)

### PostgreSQL data layer (`db.js`)
- Replaced `better-sqlite3` with `pg` `Pool` using `DATABASE_URL` (SSL enabled heuristically for non-local URLs)
- Async API: `init()`, `query()`, `get()`, `all()`, `run()`, `tx()`
- Schema bootstrap from `database/schema.sql` on init
- Best-effort `?` → `$1..$n` placeholder conversion helper for incremental migration compatibility
- `run()` returns `{ rowCount, rows, lastInsertRowid }` (expects `RETURNING id` for inserts that need IDs)
- `tx()` wraps `BEGIN/COMMIT/ROLLBACK` with a scoped client

### Configuration / deployment
- **`package.json`**: dependency switched to `pg`; start script unchanged (`node server.js`)
- **`render.yaml`**: Blueprint updated for Postgres database binding (`DATABASE_URL`) and web service env vars (including `SESSION_SECRET`), Docker runtime
- **`Dockerfile`**: simplified Node runtime (no native SQLite build dependencies)
- Runtime requires `DATABASE_URL` and `SESSION_SECRET` in production

### Authentication and role/approval rules
- **Student sign-up (`POST /api/auth/register`)**: no email required/accepted in normal student flow; password rules enforced as implemented in server validation
- **Staff email requirement**: admin/teacher/adviser account creation and approval-request flows require valid email and case-insensitive uniqueness
- **Admin/adviser request-for-approval (added/updated):**
  - `POST /api/auth/register-admin` → creates pending `admin` request
  - `POST /api/auth/register-adviser` → creates pending `adviser` request
  - `POST /api/auth/register-teacher-request` → alias to adviser request
  - `GET /api/admin/pending` (admin) → lists pending `admin` and `adviser` requests
  - `POST /api/admin/approve/:id`, `POST /api/admin/verify/:id` (admin) → verify pending admin/adviser request
  - `POST /api/admin/reject/:id` (admin) → reject pending admin/adviser request
  - Self-approval/rejection blocked; audits recorded
- **Login/setup**: existing admin bootstrap and verified-status login flow retained; async DB access adapted partially
- **Staff roles**: `teacher` and `adviser` treated as staff roles for section-scoped access patterns in migrated checks (adviser intended to function similarly to teacher for assigned-section access; admin retains global/admin actions)

### Feature/business logic coverage (carried over; validate under Postgres)
- **Violation recording & community service**: guardian snapshot fields and service assignment/type/required-hours fields; assigned-vs-completed/remaining tracking derived from service logs; completion updates on log changes
- **Dynamic Grade 11–12 tracks/strands**: admin-managed optional tracks/strands; shown/applied only when configured/enabled and relevant to G11–12; intended to reflect across enrollment, profiles, filters, and reports without redeploy
- **Advanced dashboard/recent-violations filters**: grade/section/track/strand (as applicable), violation/severity/type, community-service status, inclusive date range (“Added From/To”), student name/ID search, reset and active filter indicators
- **Community service attendance calendar**: calendar/date-based log view, per-day inspection, log/update rendered hours, cumulative progress toward required hours
- **Flexible Excel export & section reassignment**: XLSX export endpoints for violations/service reflecting current data/filters; single/bulk reassignment with section/grade/track/strand handling and assignment-history logging; exports intended to reflect current assignments and selections
- **Date filtering**: inclusive “Added From/To” handling in query building (verify DATE/TIMESTAMPTZ boundary behavior in Postgres)

### Known backend migration gaps (must be completed)
- `server.js` was partially auto-transformed and manually patched; some routes/queries/transactions may still have sync-era assumptions, incorrect `await`/argument shapes, SQL dialect issues, or broken query fragments
- `scopedStudentWhere`/section-scope SQL and many teacher/adviser permission checks were updated, but full coverage needs verification
- `setup-admin.js` and `server.py` were copied but not migrated to PostgreSQL
- Express sessions still use default memory store (not Postgres-backed)

---

## 3. Frontend / UI Implementation

**Files (duplicate):** `public/index.html`, `public/app.js`, `public/styles.css`

### Approval and auth UI updates (added)
- Auth tabs/forms now include **Student sign-up**, **Admin request**, and **Adviser request** (`/api/auth/register-adviser`)
- Login supports username/student number/email as implemented; password show/hide toggles retained
- Account management view updated for **pending admin/adviser approval requests** (shows role), with approve/reject actions calling admin approval endpoints
- Staff account creation modals updated to include **adviser** role and post through admin user-creation flow
- Role labels/display updated to recognize `adviser`; section-assignment actions available for teacher/adviser accounts

### Existing enhancement UI carried into duplicate
- Violation form/records include guardian fields and community-service assignment/type/required-hours inputs and status/hours display
- Date pickers and filter controls aligned for desktop/mobile (“Added From/To” inclusive semantics surfaced in UI copy)
- Dynamic G11–12 track/strand configuration and conditional selectors/filters
- Dashboard recent-violations advanced filters with reset/active indicators
- Community service attendance calendar preview with day selection, attendee/log inspection, and hour logging UI
- Student reassignment (single/bulk) controls and export actions/buttons

### UI work still recommended
- Add a dedicated pending-requests section/filter for all staff request types if admins need separate visibility
- Confirm adviser navigation/permissions match intended product behavior (teacher-equivalent vs custom)
- Re-test responsive alignment and modal/form states after PostgreSQL-driven data changes

---

## 4. Edge Cases & Testing Checklist

### Auth / roles / approval
- [ ] First-run setup creates initial verified admin (bootstrap rules)
- [ ] Student sign-up succeeds without email; duplicate student number/constraints handled
- [ ] Admin request requires valid email, min password, unique email (case-insensitive), and remains `pending`
- [ ] Adviser request requires valid email, min password, unique email (case-insensitive), and remains `pending`
- [ ] Pending admin cannot sign in before approval; rejected request cannot sign in
- [ ] Admin can approve/reject adviser requests and admin requests; cannot approve/reject own account
- [ ] Approving/rejecting non-pending or missing request returns proper error
- [ ] Teacher/adviser created directly by admin is verified and can be assigned sections
- [ ] Adviser permissions match intended scope (assigned sections, read-only vs admin actions)

### Database / PostgreSQL behavior
- [ ] `DATABASE_URL` connection, SSL mode, and schema init succeed on fresh database
- [ ] `RETURNING id` used for all inserts where app expects created IDs
- [ ] `?` placeholder conversion produces correct `$n` ordering for all queries
- [ ] Transactions commit/rollback correctly (`db.tx` scoped client) under concurrent/error cases
- [ ] Boolean/date/numeric comparisons behave correctly (`DATE` vs `TIMESTAMPTZ`, inclusive end-of-day filters)
- [ ] `ON CONFLICT` clauses match actual unique constraints/indexes
- [ ] Email uniqueness is case-insensitive across request/create/login paths

### Violation recording & community service
- [ ] Violation save with service enabled requires valid type and required hours per business rule
- [ ] Zero/negative/invalid hours rejected; decimal precision handled (`NUMERIC(6,2)`)
- [ ] Guardian name/contact auto-populate from student profile when available; manual entry/override persists as snapshot
- [ ] Missing guardian contact allowed only if business rules permit (validate UX/API)
- [ ] Assigned vs completed vs remaining hours compute correctly after add/update/delete of logs
- [ ] Service completion timestamp/status updates when required hours reached or logs removed
- [ ] Student with no violations/service shows safe defaults in UI/exports

### Dynamic G11–12 tracks/strands
- [ ] No configured tracks/strands: G11–12 flows allow save without track/strand; selectors/filters hidden appropriately
- [ ] Grades 7–10 do not require or expose track/strand incorrectly
- [ ] Admin create/edit/activate/deactivate tracks and strands; changes appear in enrollment, profiles, filters, reports without redeploy (in-app refresh/reload behavior)
- [ ] Deactivating/removing options does not corrupt existing records; historical snapshots remain consistent

### Dashboard filters / date alignment
- [ ] “Added From/To” inclusive bounds return expected records across timezone/date boundaries
- [ ] Filter combinations: grade, section, track/strand, violation type/severity, service status, date range, name/ID search
- [ ] Reset clears all filters and state; active filter indicators/chips match applied filters
- [ ] Empty results render cleanly; pagination/limits (if any) remain correct

### Community service calendar
- [ ] Calendar shows service logs for selected month/date and allowed students/sections
- [ ] Logging/updating hours for a date creates/updates log correctly (unique per violation/date)
- [ ] Cumulative rendered hours never miscount across multiple dates; remaining hours clamped/displayed safely
- [ ] Teachers/advisers limited to assigned sections; admins can access as intended

### Reassignment & exports
- [ ] Single reassignment preserves violations/service logs and writes assignment history
- [ ] Bulk reassignment handles grade/strand/track changes and partial failures safely (transactional behavior)
- [ ] Reassigning a student with existing logged service hours preserves all logs/totals/case links
- [ ] Excel exports (violations/service) match active filters/selections, include correct columns/encoding, and reflect current section assignments
- [ ] Export with empty/filtered dataset produces valid workbook and clear empty-state content
- [ ] Large exports complete without timeout/memory issues (validate with representative data)

### Deployment / runtime
- [ ] `npm install` succeeds with `pg` dependency
- [ ] `node --check server.js` and server startup succeed
- [ ] Render/Docker deploy with `DATABASE_URL` and `SESSION_SECRET` configured; health/startup verified
- [ ] Session persistence/scale behavior acceptable or migrated to a shared session store if needed
