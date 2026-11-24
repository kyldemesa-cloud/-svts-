import http.cookiejar
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from contextlib import redirect_stdout
from pathlib import Path
from io import BytesIO, StringIO

import server


class BackendWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = server.DB_PATH
        server.DB_PATH = Path(self.temp_dir.name) / "test.sqlite3"
        with server.SESSION_LOCK:
            server.SESSIONS.clear()
        with server.FAILURE_LOCK:
            server.LOGIN_FAILURES.clear()
            server.LOGIN_IP_FAILURES.clear()
            server.AUTH_REQUESTS.clear()
        server.initialize()
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.SVTSHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}"
        self.admin_client = self.make_client()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)
        server.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def make_client(self):
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        return {"opener": opener, "csrf": ""}

    def request(
        self, client, path, method="GET", body=None, expected=None,
        include_origin=True, content_type="application/json",
    ):
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = content_type
        if method != "GET" and include_origin:
            headers["Origin"] = self.base
            if client["csrf"]:
                headers["X-CSRF-Token"] = client["csrf"]
        request = urllib.request.Request(
            self.base + path, data=data, headers=headers, method=method
        )
        try:
            with client["opener"].open(request, timeout=5) as response:
                status = response.status
                content_type = response.headers.get("Content-Type", "")
                payload = response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            content_type = error.headers.get("Content-Type", "")
            payload = error.read()
            error.close()
        if expected is not None:
            self.assertEqual(status, expected, payload.decode("utf-8", errors="replace"))
        parsed = json.loads(payload) if "application/json" in content_type else payload
        if isinstance(parsed, dict) and "csrf" in parsed:
            client["csrf"] = parsed["csrf"]
        return status, parsed

    def test_auth_requests_require_origin_json_and_are_rate_limited(self):
        with self.admin_client["opener"].open(self.base + "/api/status") as response:
            self.assertEqual(response.headers.get("X-Frame-Options"), "DENY")
            self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
            self.assertIn("frame-ancestors 'none'", response.headers.get("Content-Security-Policy", ""))
            self.assertNotIn("Python/", response.headers.get("Server", ""))
        try:
            self.admin_client["opener"].open(
                urllib.request.Request(
                    self.base + "/api/status",
                    headers={"Host": "attacker.example"},
                ),
                timeout=5,
            )
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 400)
            error.close()
        else:
            self.fail("A request with an untrusted Host header should be rejected.")
        log_output = StringIO()
        with redirect_stdout(log_output):
            self.request(self.admin_client, "/api/status?q=StudentNameToKeepPrivate")
        self.assertNotIn("StudentNameToKeepPrivate", log_output.getvalue())
        self.request(
            self.admin_client,
            "/api/login",
            "POST",
            {"email": "admin@example.test", "password": "valid-password"},
            403,
            include_origin=False,
        )
        self.request(
            self.admin_client,
            "/api/login",
            "POST",
            {"email": "admin@example.test", "password": "valid-password"},
            415,
            content_type="text/plain",
        )
        self.request(
            self.admin_client,
            "/api/setup",
            "POST",
            {"name": "First Admin", "email": "admin@example.test", "password": "p" * 1025},
            400,
        )
        with server.FAILURE_LOCK:
            server.LOGIN_IP_FAILURES["127.0.0.1"] = [
                server.time.time()
            ] * server.LOGIN_IP_FAILURE_LIMIT
        self.request(
            self.admin_client,
            "/api/login",
            "POST",
            {"email": "admin@example.test", "password": "valid-password"},
            429,
        )
        with server.FAILURE_LOCK:
            server.AUTH_REQUESTS["adviser-request:127.0.0.1"] = [
                server.time.time()
            ] * server.AUTH_REQUEST_LIMIT
        _, response = self.request(
            self.admin_client, "/api/request-adviser", "POST", {}, 429
        )
        self.assertIn("Too many account requests", response["error"])

    def test_setup_admin_teacher_scope_and_service_progress(self):
        _, status = self.request(self.admin_client, "/api/status")
        self.assertTrue(status["setup_required"])

        _, admin = self.request(
            self.admin_client,
            "/api/setup",
            "POST",
            {"name": "First Administrator", "email": "admin@example.test", "password": "secure-password-01"},
            201,
        )
        self.assertEqual(admin["user"]["role"], "Administrator")
        self.request(
            self.admin_client,
            "/api/setup",
            "POST",
            {"name": "Another Admin", "email": "another@example.test", "password": "secure-password-02"},
            409,
        )

        self.request(
            self.admin_client,
            "/api/register-admin",
            "POST",
            {"name": "Pending Admin", "email": "pending@example.test", "password": "secure-password-03"},
            201,
        )
        _, duplicate_admin_request = self.request(
            self.admin_client,
            "/api/register-admin",
            "POST",
            {"name": "Duplicate Admin", "email": "PENDING@example.test", "password": "secure-password-08"},
            409,
        )
        self.assertEqual(duplicate_admin_request["error"], "An account already uses this email.")
        pending_client = self.make_client()
        self.request(
            pending_client,
            "/api/login",
            "POST",
            {"email": "pending@example.test", "password": "secure-password-03"},
            403,
        )
        _, pending = self.request(self.admin_client, "/api/admin-registrations")
        self.assertEqual(len(pending["items"]), 1)
        self.request(
            self.admin_client,
            f"/api/admin-registrations?id={pending['items'][0]['id']}",
            "PATCH",
            {"decision": "approve"},
            200,
        )

        _, year = self.request(self.admin_client, "/api/school-years", "POST", {"name": "2026-2027", "active": True}, 201)
        _, section_a = self.request(
            self.admin_client, "/api/sections", "POST",
            {"school_year_id": year["id"], "grade": "11", "name": "Edison", "strand": "ICT"}, 201
        )
        _, section_b = self.request(
            self.admin_client, "/api/sections", "POST",
            {"school_year_id": year["id"], "grade": "12", "name": "Newton", "strand": "STEM"}, 201
        )
        self.request(
            self.admin_client, "/api/sections", "POST",
            {"school_year_id": year["id"], "grade": "10", "name": "Invalid", "strand": ""}, 400
        )
        _, category = self.request(
            self.admin_client, "/api/categories", "POST",
            {"name": "Late arrival", "severity": "Minor", "description": "Arriving after the scheduled start."}, 201
        )
        self.request(
            self.admin_client, "/api/students", "POST",
            {"student_no": "SJ-000", "first_name": "Invalid", "last_name": "Grade", "grade": "10", "section_id": section_a["id"]}, 400
        )
        _, student_a = self.request(
            self.admin_client, "/api/students", "POST",
            {"student_no": "SJ-001", "first_name": "Ari", "last_name": "Reyes", "grade": "11", "section_id": section_a["id"]}, 201
        )
        _, student_b = self.request(
            self.admin_client, "/api/students", "POST",
            {"student_no": "SJ-002", "first_name": "Kai", "last_name": "Santos", "grade": "12", "section_id": section_b["id"]}, 201
        )
        _, violation = self.request(
            self.admin_client, "/api/violations", "POST",
            {
                "student_id": student_a["id"],
                "category_id": category["id"],
                "incident_date": "2026-11-02",
                "incident_time": "08:40",
                "location": "Main entrance",
                "description": "Observed incident.",
            },
            201,
        )
        _, assignment = self.request(
            self.admin_client, "/api/service", "POST",
            {"student_id": student_a["id"], "violation_id": violation["id"], "required_days": 2, "required_hours": 6, "description": "Library support"}, 201
        )
        _, teacher = self.request(
            self.admin_client, "/api/users", "POST",
            {"email": "teacher@example.test", "name": "Taylor Teacher", "password": "secure-password-04", "section_ids": [section_a["id"]]}, 201
        )
        self.assertTrue(teacher["id"])

        teacher_client = self.make_client()
        self.request(
            teacher_client, "/api/login", "POST",
            {"email": "teacher@example.test", "password": "secure-password-04"}, 200
        )
        _, roster = self.request(teacher_client, "/api/students")
        self.assertEqual([row["student_no"] for row in roster["items"]], ["SJ-001"])
        _, grade_roster = self.request(
            teacher_client,
            f"/api/students?grade=11&school_year_id={year['id']}&section_id={section_a['id']}&status=active",
        )
        self.assertEqual({row["student_no"] for row in grade_roster["items"]}, {"SJ-001"})
        self.request(teacher_client, "/api/students?grade=10", expected=400)
        _, out_of_scope_students = self.request(
            teacher_client, f"/api/students?section_id={section_b['id']}",
        )
        self.assertEqual(out_of_scope_students["total"], 0)
        self.request(
            teacher_client, "/api/students", "POST",
            {
                "student_no": "SJ-003",
                "first_name": "Mina",
                "last_name": "Cruz",
                "grade": "11",
                "section_id": section_a["id"],
            },
            403,
        )
        _, new_student_violation = self.request(
            teacher_client, "/api/violations", "POST",
            {
                "new_student": {
                    "student_no": "SJ-003",
                    "first_name": "Mina",
                    "last_name": "Cruz",
                    "school_year_id": year["id"],
                    "grade": "11",
                    "section_id": section_a["id"],
                },
                "category_id": category["id"],
                "incident_date": "2026-11-03",
                "incident_time": "10:05",
                "location": "Library",
                "description": "Observed leaving the assigned area.",
            },
            201,
        )
        self.assertTrue(new_student_violation["student_created"])
        self.assertEqual(new_student_violation["case_number"], f"SVTS-{new_student_violation['id']:06d}")
        self.assertEqual(new_student_violation["student_id"], 3)
        _, roster = self.request(teacher_client, "/api/students")
        self.assertIn("SJ-003", [row["student_no"] for row in roster["items"]])
        self.request(
            teacher_client, "/api/violations", "POST",
            {
                "new_student": {
                    "student_no": "SJ-004",
                    "first_name": "Lia",
                    "last_name": "Santos",
                    "school_year_id": year["id"],
                    "grade": "12",
                    "section_id": section_b["id"],
                },
                "category_id": category["id"],
                "incident_date": "2026-11-03",
                "incident_time": "10:05",
                "location": "Library",
                "description": "Observed leaving the assigned area.",
            },
            403,
        )
        self.request(
            teacher_client, "/api/violations", "POST",
            {
                "new_student": {
                    "student_no": "SJ-004",
                    "first_name": "Lia",
                    "last_name": "Santos",
                    "school_year_id": year["id"],
                    "grade": "11",
                    "section_id": section_a["id"],
                },
                "category_id": category["id"],
                "incident_date": "2026-11-03",
                "incident_time": "25:00",
                "location": "Library",
                "description": "Invalid time should roll back student creation.",
            },
            400,
        )
        _, roster = self.request(teacher_client, "/api/students?q=SJ-004")
        self.assertEqual(roster["total"], 0)
        self.request(
            teacher_client, "/api/violations", "POST",
            {
                "new_student": {
                    "student_no": "SJ-005",
                    "first_name": "Jo",
                    "last_name": "Santos",
                    "school_year_id": year["id"] + 100,
                    "grade": "11",
                    "section_id": section_a["id"],
                },
                "category_id": category["id"],
                "incident_date": "2026-11-03",
                "incident_time": "10:05",
                "location": "Library",
                "description": "Invalid school-year selection.",
            },
            400,
        )
        _, teacher_violation = self.request(
            teacher_client, "/api/violations", "POST",
            {
                "student_id": student_a["id"],
                "category_id": category["id"],
                "incident_date": "2026-11-03",
                "incident_time": "09:15",
                "location": "Library",
                "description": "Observed leaving the assigned area.",
                "evidence": "Guidance office note 14",
            },
            201,
        )
        self.assertEqual(teacher_violation["case_number"], f"SVTS-{teacher_violation['id']:06d}")
        _, violation_rows = self.request(teacher_client, "/api/violations?q=SVTS-")
        teacher_record = next(
            row for row in violation_rows["items"]
            if row["id"] == teacher_violation["id"]
        )
        self.assertEqual(teacher_record["incident_time"], "09:15")
        self.assertEqual(teacher_record["location"], "Library")
        self.assertEqual(teacher_record["evidence"], "Guidance office note 14")
        self.assertEqual(teacher_record["status"], "Under Review")
        self.assertEqual(teacher_record["reporter"], "Taylor Teacher")
        self.request(
            teacher_client, "/api/violations", "POST",
            {
                "student_id": student_a["id"],
                "category_id": category["id"],
                "incident_date": "2026-11-03",
                "incident_time": "09:15",
                "description": "Missing required location.",
            },
            400,
        )
        self.request(
            teacher_client, "/api/violations",
            "POST",
            {"student_id": student_b["id"], "category_id": category["id"], "incident_date": "2026-11-03"},
            403,
        )
        self.request(
            teacher_client, f"/api/violations?id={teacher_violation['id']}",
            "PATCH",
            {"student_id": student_a["id"], "category_id": category["id"], "incident_date": "2026-11-03"},
            403,
        )
        self.request(
            teacher_client, "/api/violations",
            "POST",
            {
                "student_id": student_a["id"],
                "category_id": category["id"],
                "incident_date": "2026-11-03",
                "incident_time": "09:15",
                "location": "Library",
                "description": "Observed leaving the assigned area.",
                "status": "Resolved",
            },
            403,
        )
        self.request(teacher_client, "/api/admin-registrations", expected=403)
        self.request(teacher_client, "/api/adviser-requests", expected=403)
        self.request(
            teacher_client, "/api/service/attendance", "POST",
            {"assignment_id": assignment["id"], "service_date": "2026-11-05", "hours": 5, "day_completed": True}, 201
        )
        _, progress = self.request(teacher_client, "/api/service")
        self.assertEqual(progress["items"][0]["status"], "In Progress")
        self.assertEqual(progress["items"][0]["remaining_days"], 1)
        _, filtered_service = self.request(
            teacher_client,
            f"/api/service?q=SJ-001&grade=11&school_year_id={year['id']}"
            f"&section_id={section_a['id']}&status=In%20Progress"
            "&from=2026-01-01&to=2027-01-01",
        )
        self.assertEqual(filtered_service["total"], 1)
        _, filtered_violations = self.request(
            teacher_client,
            f"/api/violations?q=Library&school_year_id={year['id']}"
            f"&section_id={section_a['id']}&from=2026-01-01&to=2027-01-01",
        )
        self.assertGreaterEqual(filtered_violations["total"], 1)
        _, out_of_scope_violations = self.request(
            teacher_client, f"/api/violations?section_id={section_b['id']}",
        )
        self.assertEqual(out_of_scope_violations["total"], 0)
        self.request(
            teacher_client, "/api/service?from=2027-01-01&to=2026-01-01",
            expected=400,
        )
        _, out_of_scope_service = self.request(
            teacher_client, f"/api/service?section_id={section_b['id']}",
        )
        self.assertEqual(out_of_scope_service["total"], 0)
        self.request(teacher_client, "/api/reports.xlsx?module=students", expected=403)

        for module in ("students", "violations", "service"):
            _, workbook_bytes = self.request(
                self.admin_client, f"/api/reports.xlsx?module={module}", expected=200,
            )
            with zipfile.ZipFile(BytesIO(workbook_bytes)) as workbook:
                self.assertIsNone(workbook.testzip())
                workbook_xml = ET.fromstring(workbook.read("xl/workbook.xml"))
                sheets = workbook_xml.find(
                    "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheets"
                )
                self.assertIsNotNone(sheets)
                self.assertEqual(sheets[0].attrib["name"], "Overall")
                self.assertGreaterEqual(len(sheets), 2)
                if module == "students":
                    names = [sheet.attrib["name"] for sheet in sheets]
                    self.assertIn("2026-2027 Grade 11 Edison", names)
                    section_xml = ET.fromstring(workbook.read("xl/worksheets/sheet2.xml"))
                    values = " ".join(
                        value.text or ""
                        for value in section_xml.iter(
                            "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"
                        )
                    )
                    self.assertIn("SJ-001", values)
                    self.assertNotIn("SJ-002", values)
                for filename in workbook.namelist():
                    if filename.endswith(".xml") or filename.endswith(".rels"):
                        ET.fromstring(workbook.read(filename))
        self.request(
            teacher_client, "/api/service/attendance", "POST",
            {"assignment_id": assignment["id"], "service_date": "2026-11-06", "hours": 1, "day_completed": True}, 201
        )
        _, progress = self.request(teacher_client, "/api/service")
        self.assertEqual(progress["items"][0]["status"], "Completed")
        self.assertEqual(progress["items"][0]["remaining_hours"], 0)
        _, attendance = self.request(
            teacher_client, f"/api/service/attendance?assignment_id={assignment['id']}"
        )
        self.assertEqual(len(attendance["items"]), 2)

    def test_adviser_request_approval_and_single_section_assignment(self):
        _, admin = self.request(
            self.admin_client, "/api/setup", "POST",
            {"name": "First Administrator", "email": "admin@example.test", "password": "secure-password-01"},
            201,
        )
        _, year = self.request(
            self.admin_client, "/api/school-years", "POST",
            {"name": "2026-2027", "active": True}, 201
        )
        _, section_a = self.request(
            self.admin_client, "/api/sections", "POST",
            {"school_year_id": year["id"], "grade": "11", "name": "Edison", "strand": "ICT"}, 201
        )
        _, section_b = self.request(
            self.admin_client, "/api/sections", "POST",
            {"school_year_id": year["id"], "grade": "12", "name": "Newton", "strand": "STEM"}, 201
        )
        self.request(
            self.admin_client, "/api/students", "POST",
            {"student_no": "SJ-011", "first_name": "Ari", "last_name": "Reyes", "grade": "11", "section_id": section_a["id"]}, 201
        )
        self.request(
            self.admin_client, "/api/students", "POST",
            {"student_no": "SJ-012", "first_name": "Kai", "last_name": "Santos", "grade": "12", "section_id": section_b["id"]}, 201
        )
        request_body = {
            "name": "Taylor Adviser",
            "email": "adviser@example.test",
            "password": "secure-password-05",
        }
        self.request(self.admin_client, "/api/request-adviser", "POST", request_body, 201)
        self.request(self.admin_client, "/api/request-adviser", "POST", request_body, 409)
        self.request(
            self.make_client(), "/api/login", "POST",
            {"email": request_body["email"], "password": request_body["password"]}, 401
        )
        self.request(self.make_client(), "/api/adviser-requests", expected=401)
        _, requests = self.request(self.admin_client, "/api/adviser-requests")
        self.assertEqual(len(requests["items"]), 1)
        self.assertEqual(requests["items"][0]["email"], request_body["email"])
        self.request(
            self.admin_client, f"/api/adviser-requests?id={requests['items'][0]['id']}",
            "PATCH", {"decision": "approve", "section_id": 999}, 400
        )
        self.request(
            self.admin_client, f"/api/adviser-requests?id={requests['items'][0]['id']}",
            "PATCH", {"decision": "approve", "section_id": section_a["id"]}, 200
        )
        _, pending = self.request(self.admin_client, "/api/adviser-requests")
        self.assertEqual(pending["items"], [])
        adviser_client = self.make_client()
        _, adviser = self.request(
            adviser_client, "/api/login", "POST",
            {"email": request_body["email"], "password": request_body["password"]}, 200
        )
        self.assertEqual(adviser["user"]["role"], "Teacher")
        with server.connect() as db:
            assignments = db.execute(
                "SELECT section_id FROM teacher_sections WHERE user_id=?",
                (adviser["user"]["id"],),
            ).fetchall()
        self.assertEqual([row["section_id"] for row in assignments], [section_a["id"]])
        with server.connect() as db:
            db.execute(
                "INSERT INTO teacher_sections(user_id,section_id) VALUES(?,?)",
                (adviser["user"]["id"], section_b["id"]),
            )
        _, roster = self.request(adviser_client, "/api/students")
        self.assertEqual([row["student_no"] for row in roster["items"]], ["SJ-011"])
        _, accounts = self.request(self.admin_client, "/api/users")
        scoped_adviser = next(row for row in accounts["items"] if row["id"] == adviser["user"]["id"])
        self.assertEqual(scoped_adviser["section_count"], 2)
        self.assertEqual(scoped_adviser["access_section"], "11 · Edison (2026-2027)")
        self.request(
            self.admin_client, "/api/users", "POST",
            {
                "email": "multi-section@example.test",
                "name": "Multi Section",
                "password": "secure-password-06",
                "section_ids": [section_a["id"], section_b["id"]],
            },
            400,
        )
        self.request(
            self.admin_client, "/api/request-adviser", "POST",
            {
                "name": "Rejected Applicant",
                "email": "rejected-adviser@example.test",
                "password": "secure-password-07",
            },
            201,
        )
        _, requests = self.request(self.admin_client, "/api/adviser-requests")
        self.request(
            self.admin_client, f"/api/adviser-requests?id={requests['items'][0]['id']}",
            "PATCH", {"decision": "reject"}, 200
        )
        with server.connect() as db:
            rejected = db.execute(
                "SELECT status,reviewed_by,reviewed_at FROM adviser_requests WHERE email=?",
                ("rejected-adviser@example.test",),
            ).fetchone()
        self.assertEqual(rejected["status"], "Rejected")
        self.assertEqual(rejected["reviewed_by"], admin["user"]["id"])
        self.assertTrue(rejected["reviewed_at"])

    def test_non_loopback_bind_requires_secure_cookie_and_host_allowlist(self):
        original_host = server.HOST
        original_cookie_secure = server.COOKIE_SECURE
        original_hosts_configured = server.ALLOWED_HOSTS_CONFIGURED
        original_setup_key = server.SETUP_KEY
        try:
            server.HOST = "0.0.0.0"
            server.COOKIE_SECURE = False
            server.ALLOWED_HOSTS_CONFIGURED = False
            server.SETUP_KEY = ""
            with self.assertRaisesRegex(RuntimeError, "SVTS_SECURE_COOKIES"):
                server._validate_runtime_config()

            server.COOKIE_SECURE = True
            with self.assertRaisesRegex(RuntimeError, "SVTS_ALLOWED_HOSTS"):
                server._validate_runtime_config()

            server.ALLOWED_HOSTS_CONFIGURED = True
            with self.assertRaisesRegex(RuntimeError, "SVTS_SETUP_KEY"):
                server._validate_runtime_config()

            server.SETUP_KEY = "one-time-setup-secret"
            server._validate_runtime_config()
            server.SETUP_KEY = ""
            with server.connect() as db:
                db.execute(
                    "INSERT INTO users(email,name,password_hash,role,status,verified,created_at) "
                    "VALUES('admin@example.test','Admin','unused','Administrator','Active',1,?)",
                    (server.now_iso(),),
                )
            server._validate_runtime_config()
        finally:
            server.HOST = original_host
            server.COOKIE_SECURE = original_cookie_secure
            server.ALLOWED_HOSTS_CONFIGURED = original_hosts_configured
            server.SETUP_KEY = original_setup_key

    def test_wsgi_adapter_serves_status_with_security_headers(self):
        response = {}

        def start_response(status, headers):
            response["status"] = status
            response["headers"] = dict(headers)

        body = b"".join(server.wsgi_app({
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/api/status",
            "QUERY_STRING": "",
            "SERVER_PROTOCOL": "HTTP/1.1",
            "REMOTE_ADDR": "127.0.0.1",
            "HTTP_HOST": "127.0.0.1:8080",
            "wsgi.input": BytesIO(),
        }, start_response))

        self.assertEqual(response["status"], "200 OK")
        self.assertEqual(
            json.loads(body),
            {"setup_required": True, "setup_key_required": False},
        )
        self.assertEqual(response["headers"]["X-Frame-Options"], "DENY")
        self.assertNotIn("Python/", response["headers"]["Server"])

    def test_wsgi_trusted_proxy_uses_validated_forwarded_client_ip(self):
        original_trust_proxy = server.TRUST_PROXY
        try:
            server.TRUST_PROXY = True
            self.assertEqual(
                server._wsgi_client_ip({
                    "REMOTE_ADDR": "10.0.0.4",
                    "HTTP_X_FORWARDED_FOR": "198.51.100.5, 203.0.113.8",
                }),
                "203.0.113.8",
            )
            self.assertEqual(
                server._wsgi_client_ip({
                    "REMOTE_ADDR": "10.0.0.4",
                    "HTTP_X_FORWARDED_FOR": "forged, invalid",
                }),
                "10.0.0.4",
            )
        finally:
            server.TRUST_PROXY = original_trust_proxy

    def test_mutations_require_csrf_and_setup_cannot_be_repeated(self):
        self.request(
            self.admin_client,
            "/api/setup",
            "POST",
            {"name": "First Administrator", "email": "admin@example.test", "password": "secure-password-01"},
            201,
        )
        csrf = self.admin_client["csrf"]
        self.admin_client["csrf"] = ""
        self.request(
            self.admin_client, "/api/school-years", "POST",
            {"name": "2026-2027", "active": True}, 403
        )
        self.admin_client["csrf"] = csrf
        self.request(
            self.admin_client, "/api/setup", "POST",
            {"name": "Second Administrator", "email": "second@example.test", "password": "secure-password-02"}, 409
        )
        _, status = self.request(self.admin_client, "/api/status")
        self.assertFalse(status["setup_required"])

    def test_initial_administrator_requires_configured_setup_key(self):
        original_setup_key = server.SETUP_KEY
        server.SETUP_KEY = "one-time-setup-secret"
        try:
            self.request(
                self.admin_client,
                "/api/setup",
                "POST",
                {
                    "name": "First Administrator",
                    "email": "admin@example.test",
                    "password": "secure-password-01",
                },
                403,
            )
            self.request(
                self.admin_client,
                "/api/setup",
                "POST",
                {
                    "name": "First Administrator",
                    "email": "admin@example.test",
                    "password": "secure-password-01",
                    "setup_key": "wrong-key",
                },
                403,
            )
            self.request(
                self.admin_client,
                "/api/setup",
                "POST",
                {
                    "name": "First Administrator",
                    "email": "admin@example.test",
                    "password": "secure-password-01",
                    "setup_key": "one-time-setup-secret",
                },
                201,
            )
        finally:
            server.SETUP_KEY = original_setup_key

    def test_initialize_migrates_violation_details_for_existing_databases(self):
        original_db_path = server.DB_PATH
        server.DB_PATH = Path(self.temp_dir.name) / "legacy.sqlite3"
        try:
            db = sqlite3.connect(server.DB_PATH)
            try:
                db.execute(
                    "CREATE TABLE violations ("
                    "id INTEGER PRIMARY KEY,student_id INTEGER NOT NULL,category_id INTEGER NOT NULL,"
                    "severity TEXT NOT NULL,incident_date TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',"
                    "status TEXT NOT NULL DEFAULT 'Open',created_by INTEGER NOT NULL,"
                    "created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
                )
            finally:
                db.close()
            server.initialize()
            with server.connect() as db:
                columns = {
                    row["name"] for row in db.execute("PRAGMA table_info(violations)")
                }
            self.assertTrue({"incident_time", "location", "evidence"}.issubset(columns))
        finally:
            server.DB_PATH = original_db_path


if __name__ == "__main__":
    unittest.main()
