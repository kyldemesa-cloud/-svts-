# SVTS

A local, API-backed Student Violation Tracking System for San Jose Litex Senior High School. The application uses Python's standard library, SQLite, and a responsive vanilla-JavaScript interface; no package installation is required.

The public home page explains the staff workflow and privacy boundaries. Student records are never available through public lookup: only verified staff can sign in, and adviser access is limited to one administrator-assigned section.

## Run locally

1. Install Python 3.10 or later.
2. From this folder, run:

   ```powershell
   python server.py
   ```

3. Open `http://127.0.0.1:8080`.
4. On first run, create the initial administrator with a password between 12 and 1,024 characters.
5. In **School setup**, add a school year, set it active, create Grade 11 or Grade 12 sections and violation categories. Advisers may request access; an administrator reviews each request and assigns exactly one section. Student records are created from the violation-reporting form, where school year, grade, and section selections follow the configured school structure.

The server creates `data\svts.sqlite3` automatically. Set `SVTS_DB_PATH` to choose another database path. `SVTS_HOST` and `SVTS_PORT` can be set for a different local binding. The server binds to loopback by default. `SVTS_SECURE_COOKIES=1` enables the Secure cookie attribute when deployed behind HTTPS. `SVTS_ALLOWED_HOSTS` accepts a comma-separated list of exact hostnames; requests using other Host headers are rejected. Non-loopback bindings also require `SVTS_SETUP_KEY`, a one-time secret for the first administrator account. `SVTS_TRUST_PROXY=1` enables client-IP extraction from the rightmost valid `X-Forwarded-For` value and must only be used behind a trusted proxy.

## Included functionality

- Public overview, adviser sign-in/access requests, and verified administrator access requests
- First-admin setup, password hashing, pending admin requests and verified approval
- Server-owned, HttpOnly/SameSite sessions, CSRF and same-origin checks, JSON-only writes, security headers, authentication throttling, and role enforcement
- Administrator and single-section adviser access; advisers may report violations and register students only for their assigned section, and new adviser reports enter Under Review
- Administrator approval queue for adviser access requests, with an auditable section assignment
- School-year and Grade 11/12 section management, student directory browsing/search, and configurable violation categories
- Inline student registration during violation reporting; a student and their violation are saved atomically
- Violation records with generated case numbers, date, time, location, factual description, reporting staff, and an optional evidence reference/notes field (not file upload)
- Advanced, server-side filters and pagination for students, violations, and community-service assignments
- Administrator Excel exports for each record module, with an overall worksheet and separate worksheets by section; print views include every record matching the filters
- Community-service assignments, attendance history, and automatic day/hour completion calculation
- Administrative audit history

## Tests

Run the backend integration tests with:

```powershell
python -m unittest -v test_server
```

The tests use temporary SQLite databases and exercise setup-key enforcement, host validation, the WSGI adapter, role boundaries, filtered and section-scoped records, atomic student-and-violation reporting, violation migrations, CSRF rejection, service progress, and the structure of exported Excel workbooks.

## Deployment and data notes

### Render deployment

The included [render.yaml](./render.yaml) is configured for a Render web service in Singapore, using Waitress, a `/var/data` persistent disk for SQLite, and `/api/status` for health checks. Render requires a paid service plan for persistent disks; a disk-backed service is limited to one instance and has short downtime during deploys. The blueprint disables automatic deploys until CI checks are configured.

When creating the Blueprint, provide:

- `SVTS_ALLOWED_HOSTS`: the exact assigned `svts-litex-portal.onrender.com` hostname and any approved custom domains, comma-separated. Update it if Render assigns a different service hostname.
- `SVTS_SETUP_KEY`: a randomly generated, one-time secret (for example, generate one locally with `python -c "import secrets; print(secrets.token_urlsafe(32))"`). Use it to create the first administrator, then remove it from Render after setup.

Connect a Git repository containing the source to Render; this workspace currently has no Git repository. The `data/`, `.venv/`, `.env`, and SQLite database files are excluded from source control. The Render deployment starts with an empty database and does not migrate or upload the local database. Review and approve any student-data migration separately before moving records to a hosted provider.

Render's disk snapshots are not a substitute for a tested database backup and restore plan. Establish and test independent backups before entering real student data, monitor disk usage, and confirm the school's privacy/data-residency approval for the selected region.

### Remaining production limits

The dependency-free local server is a research prototype, not a public production deployment. It binds to loopback by default and serves plain HTTP; do not expose the built-in server directly to the internet. The Render Blueprint uses the WSGI app behind Waitress, but sessions and authentication rate limits remain in-process and are cleared on restart. The exact host allowlist, secure cookies, one-time setup key, and trusted-proxy setting reduce deployment risk but do not replace a security review or school approval. The previous MySQL dump is deprecated; the active schema is defined in `server.py`.

The app intentionally starts without users, students, violations, categories, or sections. Existing legacy browser-localStorage records are not automatically imported; back them up and plan a reviewed migration before discarding them.
