# San Jose-Litex SHS Violation Tracking System (SVTS)

Prototype web application with Express + SQLite. No seeded/demo accounts or records, no student portal, and no teacher violation-recording permissions.

## Requirements
- Node.js 18+ (Node 20/22 recommended)
- npm

## Install and run
1. Open this folder in a terminal.
2. Run `npm install`.
3. Set a session secret. PowerShell: `$env:SESSION_SECRET='use-a-long-random-secret'`; macOS/Linux: `export SESSION_SECRET='use-a-long-random-secret'`.
4. Run `npm run setup-admin` and follow the prompts to create the first verified administrator. A default school year (2026-2027) is initialized.
5. Run `npm start`.
6. Visit `http://localhost:3000`.


## Roles and permissions
- **Administrator:** full school configuration, account management, section/year configuration, students, offense catalog, records violations, updates case statuses, assigns community service, reports.
- **Teacher:** only sees assigned sections; violation records are read-only; can record community service attendance for students in assigned sections and view attendance history.
- **Student:** no login or student portal.
- **New administrator:** self-registration only creates a pending account. A different verified administrator must approve it. Self-approval is blocked.
- **Teacher account:** created by an administrator and verified upon creation; section access is assigned by administrator.

## School years and sections
Create school years and create sections under each year. Sections may be added, renamed, edited, or removed (unless linked records prevent deletion). Activate a year to make it the current year. Student records reference their section and are tied to the selected school year through that section.

## Community service
Administrator creates an assignment with required days and/or hours. Administrator and teachers can log each date's hours and mark whether a required service day was completed. Attendance is unique per assignment/date. Completion is automatically reflected when recorded hours and days reach the assignment requirements. Attendance history shows who logged each entry.

## Prototype/security limitations
This is a school research prototype. Use HTTPS, a strong `SESSION_SECRET`, secure hosting, database backups, and review security settings before deployment. The built-in session store is not production-ready. There is no CSRF token protection, password reset, email verification, audit-log UI, or automatic session-idle enforcement yet. Administrators should only create real accounts and records. The application does not automatically decide guilt or discipline.

## Deploying online (accessible anytime, any device)
1. Push this folder to a private GitHub repository.
2. On https://render.com choose **New > Blueprint** and select the repo (uses `render.yaml`: Docker, HTTPS, persistent 1 GB disk for the SQLite database).
3. Open the service's **Environment** tab, copy `SETUP_TOKEN`, then visit your `https://...onrender.com` URL. The first-time setup screen creates the initial administrator (works once, only while no users exist).
4. Additional administrators register on the sign-in page and must be approved by another verified administrator.
Any host that runs Docker/Node with a persistent volume works the same way (Railway, Fly.io, a VPS). Set `SESSION_SECRET`, `SETUP_TOKEN`, `NODE_ENV=production`, `DB_PATH`. Back up the database file regularly.
