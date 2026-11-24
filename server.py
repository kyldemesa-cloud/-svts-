"""SVTS local web server and SQLite-backed API.

Run with: python server.py
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import ipaddress
import io
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timezone
from email.message import Message
from http.cookies import SimpleCookie
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SVTS_DB_PATH", ROOT / "data" / "svts.sqlite3"))
HOST = os.environ.get("SVTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("SVTS_PORT", os.environ.get("PORT", "8080")))
COOKIE_SECURE = os.environ.get("SVTS_SECURE_COOKIES", "0") == "1"
TRUST_PROXY = os.environ.get("SVTS_TRUST_PROXY", "0") == "1"
SETUP_KEY = os.environ.get("SVTS_SETUP_KEY", "")
_allowed_hosts_setting = os.environ.get("SVTS_ALLOWED_HOSTS", "")
ALLOWED_HOSTS = frozenset(
    host.strip().rstrip(".").lower()
    for host in _allowed_hosts_setting.split(",")
    if host.strip()
) or frozenset({"127.0.0.1", "localhost", "::1"})
ALLOWED_HOSTS_CONFIGURED = bool(_allowed_hosts_setting.strip())
SESSION_SECONDS = 30 * 60
PASSWORD_ITERATIONS = 310_000
COOKIE_NAME = "svts_session"
MAX_BODY = 1_000_000
MAX_PASSWORD_LENGTH = 1024
GRADE_LEVELS = ("11", "12")
XLSX_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
XLSX_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
AUTH_REQUEST_WINDOW = 15 * 60
AUTH_REQUEST_LIMIT = 20
LOGIN_FAILURE_LIMIT = 5
LOGIN_IP_FAILURE_LIMIT = 30

SESSIONS: dict[str, dict[str, object]] = {}
SESSION_LOCK = threading.Lock()
LOGIN_FAILURES: dict[str, list[float]] = {}
LOGIN_IP_FAILURES: dict[str, list[float]] = {}
AUTH_REQUESTS: dict[str, list[float]] = {}
FAILURE_LOCK = threading.Lock()

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS school_years (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_school_year
  ON school_years(active) WHERE active = 1;
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  school_year_id INTEGER NOT NULL REFERENCES school_years(id) ON DELETE RESTRICT,
  grade TEXT NOT NULL CHECK(length(grade) BETWEEN 1 AND 12),
  name TEXT NOT NULL,
  strand TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(school_year_id, grade, name)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('Administrator','Teacher')),
  status TEXT NOT NULL CHECK(status IN ('Pending Verification','Active','Suspended','Rejected')),
  verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
CREATE TABLE IF NOT EXISTS teacher_sections (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
  PRIMARY KEY(user_id, section_id)
);
CREATE TABLE IF NOT EXISTS adviser_requests (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Rejected')),
  created_at TEXT NOT NULL,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_adviser_requests_pending_email
  ON adviser_requests(email) WHERE status = 'Pending';
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  student_no TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  grade TEXT NOT NULL,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_students_section_name
  ON students(section_id, last_name, first_name);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  severity TEXT NOT NULL CHECK(severity IN ('Minor','Major')),
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS violations (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  severity TEXT NOT NULL CHECK(severity IN ('Minor','Major')),
  incident_date TEXT NOT NULL,
  incident_time TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Open'
    CHECK(status IN ('Open','Under Review','Resolved','Closed','Referred')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_violations_date ON violations(incident_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_violations_status ON violations(status);
CREATE INDEX IF NOT EXISTS idx_violations_student ON violations(student_id, incident_date DESC);
CREATE TABLE IF NOT EXISTS service_assignments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  violation_id INTEGER REFERENCES violations(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  required_days INTEGER NOT NULL CHECK(required_days > 0),
  required_hours REAL NOT NULL CHECK(required_hours > 0),
  status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','In Progress','Completed')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_student ON service_assignments(student_id);
CREATE TABLE IF NOT EXISTS service_attendance (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES service_assignments(id) ON DELETE CASCADE,
  service_date TEXT NOT NULL,
  hours REAL NOT NULL CHECK(hours > 0 AND hours <= 24),
  day_completed INTEGER NOT NULL DEFAULT 1 CHECK(day_completed IN (0,1)),
  notes TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(assignment_id, service_date)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10, factory=ClosingConnection)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 10000")
    return db


def initialize() -> None:
    with connect() as db:
        db.executescript(SCHEMA)
        violation_columns = {
            row["name"] for row in db.execute("PRAGMA table_info(violations)")
        }
        for column, definition in (
            ("incident_time", "TEXT NOT NULL DEFAULT ''"),
            ("location", "TEXT NOT NULL DEFAULT ''"),
            ("evidence", "TEXT NOT NULL DEFAULT ''"),
        ):
            if column not in violation_columns:
                db.execute(f"ALTER TABLE violations ADD COLUMN {column} {definition}")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, rounds, salt_hex, digest_hex = stored.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        calculated = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds)
        )
        return hmac.compare_digest(calculated.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def clean_text(value: object, label: str, maximum: int, required: bool = True) -> str:
    if not isinstance(value, str):
        raise ApiError(400, f"{label} is required." if required else f"{label} must be text.")
    value = value.strip()
    if required and not value:
        raise ApiError(400, f"{label} is required.")
    if len(value) > maximum:
        raise ApiError(400, f"{label} must be {maximum} characters or fewer.")
    return value


def positive_int(value: object, label: str, maximum: int = 10000) -> int:
    try:
        number = int(value)
    except (ValueError, TypeError):
        raise ApiError(400, f"{label} must be a positive whole number.") from None
    if number < 1 or number > maximum:
        raise ApiError(400, f"{label} must be between 1 and {maximum}.")
    return number


def parse_date(value: object, label: str) -> str:
    try:
        parsed = date.fromisoformat(str(value))
    except (ValueError, TypeError):
        raise ApiError(400, f"{label} must be a valid ISO date.") from None
    return parsed.isoformat()


def clean_time(value: object, label: str, required: bool = True) -> str:
    text = clean_text(value, label, 5, required)
    if not text:
        return ""
    try:
        datetime.strptime(text, "%H:%M")
    except ValueError:
        raise ApiError(400, f"{label} must be a valid 24-hour time.") from None
    return text


def new_password(value: object, label: str = "Password") -> str:
    if not isinstance(value, str) or len(value) < 12:
        raise ApiError(400, f"{label} must be at least 12 characters.")
    if len(value) > MAX_PASSWORD_LENGTH:
        raise ApiError(400, f"{label} must be {MAX_PASSWORD_LENGTH} characters or fewer.")
    return value


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _column_name(index: int) -> str:
    name = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def _xlsx_sheet_name(value: str, used: set[str]) -> str:
    name = re.sub(r"[\[\]:*?/\\]", " ", value).strip("'")[:31].strip()
    name = name or "Section"
    candidate = name
    suffix = 2
    while candidate.casefold() in used:
        ending = f" ({suffix})"
        candidate = name[:31 - len(ending)] + ending
        suffix += 1
    used.add(candidate.casefold())
    return candidate


def _xlsx_bytes(sheets: list[tuple[str, list[str], list[list[object]]]]) -> bytes:
    ET.register_namespace("", XLSX_MAIN_NS)
    ET.register_namespace("r", XLSX_REL_NS)
    qname = lambda name: f"{{{XLSX_MAIN_NS}}}{name}"
    package_qname = lambda name: f"{{{PACKAGE_REL_NS}}}{name}"
    content_qname = lambda name: f"{{{CONTENT_TYPES_NS}}}{name}"

    content_types = ET.Element(content_qname("Types"))
    ET.SubElement(content_types, content_qname("Default"), {
        "Extension": "rels",
        "ContentType": "application/vnd.openxmlformats-package.relationships+xml",
    })
    ET.SubElement(content_types, content_qname("Default"), {
        "Extension": "xml", "ContentType": "application/xml",
    })
    ET.SubElement(content_types, content_qname("Override"), {
        "PartName": "/xl/workbook.xml",
        "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    })
    ET.SubElement(content_types, content_qname("Override"), {
        "PartName": "/xl/styles.xml",
        "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    })
    for index in range(len(sheets)):
        ET.SubElement(content_types, content_qname("Override"), {
            "PartName": f"/xl/worksheets/sheet{index + 1}.xml",
            "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        })

    workbook = ET.Element(qname("workbook"))
    workbook_views = ET.SubElement(workbook, qname("bookViews"))
    ET.SubElement(workbook_views, qname("workbookView"), {"activeTab": "0"})
    sheet_list = ET.SubElement(workbook, qname("sheets"))
    for index, (name, _, _) in enumerate(sheets, 1):
        ET.SubElement(sheet_list, qname("sheet"), {
            "name": name, "sheetId": str(index),
            f"{{{XLSX_REL_NS}}}id": f"rId{index + 1}",
        })

    package_rels = ET.Element(package_qname("Relationships"))
    ET.SubElement(package_rels, package_qname("Relationship"), {
        "Id": "rId1", "Type": f"{XLSX_REL_NS}/officeDocument", "Target": "xl/workbook.xml",
    })
    workbook_rels = ET.Element(package_qname("Relationships"))
    for index in range(len(sheets)):
        ET.SubElement(workbook_rels, package_qname("Relationship"), {
            "Id": f"rId{index + 1}",
            "Type": f"{XLSX_REL_NS}/worksheet",
            "Target": f"worksheets/sheet{index + 1}.xml",
        })
    ET.SubElement(workbook_rels, package_qname("Relationship"), {
        "Id": f"rId{len(sheets) + 1}",
        "Type": f"{XLSX_REL_NS}/styles", "Target": "styles.xml",
    })

    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="' + XLSX_MAIN_NS + '">'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF12315C"/>'
        '<bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
        '<border><left/><right/><top/><bottom style="thin"><color rgb="FFD7DFEA"/>'
        '</bottom><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
        '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/>'
        '</cellStyles></styleSheet>'
    ).encode("utf-8")

    files: dict[str, bytes] = {
        "[Content_Types].xml": ET.tostring(content_types, encoding="utf-8", xml_declaration=True),
        "_rels/.rels": ET.tostring(package_rels, encoding="utf-8", xml_declaration=True),
        "xl/workbook.xml": ET.tostring(workbook, encoding="utf-8", xml_declaration=True),
        "xl/_rels/workbook.xml.rels": ET.tostring(workbook_rels, encoding="utf-8", xml_declaration=True),
        "xl/styles.xml": styles,
    }

    for index, (_, headers, rows) in enumerate(sheets, 1):
        if len(rows) > 1_048_575:
            raise ApiError(413, "This report exceeds Excel's worksheet row limit.")
        worksheet = ET.Element(qname("worksheet"))
        views = ET.SubElement(worksheet, qname("sheetViews"))
        view = ET.SubElement(views, qname("sheetView"), {"workbookViewId": "0"})
        ET.SubElement(view, qname("pane"), {
            "ySplit": "1", "topLeftCell": "A2",
            "activePane": "bottomLeft", "state": "frozen",
        })
        cols = ET.SubElement(worksheet, qname("cols"))
        for column, header in enumerate(headers, 1):
            width = max(12, min(42, len(header) + 3))
            ET.SubElement(cols, qname("col"), {
                "min": str(column), "max": str(column), "width": str(width),
                "customWidth": "1",
            })
        data = ET.SubElement(worksheet, qname("sheetData"))
        for row_number, values in enumerate([headers] + rows, 1):
            row = ET.SubElement(data, qname("row"), {"r": str(row_number)})
            for column, value in enumerate(values, 1):
                if value is None:
                    continue
                cell = ET.SubElement(row, qname("c"), {
                    "r": f"{_column_name(column)}{row_number}",
                    "s": "1" if row_number == 1 else "0",
                })
                if isinstance(value, bool):
                    cell.set("t", "b")
                    ET.SubElement(cell, qname("v")).text = "1" if value else "0"
                elif isinstance(value, (int, float)):
                    ET.SubElement(cell, qname("v")).text = str(value)
                else:
                    cell.set("t", "inlineStr")
                    inline = ET.SubElement(cell, qname("is"))
                    text = ET.SubElement(inline, qname("t"))
                    text.text = "".join(
                        char for char in str(value)
                        if char in "\t\n\r" or ord(char) >= 32
                    )
                    if text.text != text.text.strip():
                        text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        if headers:
            last_cell = f"{_column_name(len(headers))}{len(rows) + 1}"
            ET.SubElement(worksheet, qname("autoFilter"), {"ref": f"A1:{last_cell}"})
        files[f"xl/worksheets/sheet{index}.xml"] = ET.tostring(
            worksheet, encoding="utf-8", xml_declaration=True,
        )

    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return stream.getvalue()


class SVTSHandler(BaseHTTPRequestHandler):
    server_version = "SVTS/1.0"
    sys_version = ""

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        path = urlparse(self.path).path or "/"
        print(
            f"[{self.log_date_time_string()}] {self.address_string()} "
            f"{self.command} {path} {code} {size}"
        )

    def _headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; "
            "form-action 'self'; frame-ancestors 'none'",
        )
        if COOKIE_SECURE:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header("Cache-Control", "no-store")

    def _send_json(self, status: int, payload: object, extra: dict[str, str] | None = None) -> None:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        if extra:
            for name, value in extra.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(raw)

    def _send_csv(self, filename: str, rows: list[list[object]]) -> None:
        stream = io.StringIO(newline="")
        writer = csv.writer(stream)
        for row in rows:
            writer.writerow([self._csv_cell(cell) for cell in row])
        raw = stream.getvalue().encode("utf-8-sig")
        self.send_response(200)
        self._headers()
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _send_xlsx(self, filename: str, sheets: list[tuple[str, list[str], list[list[object]]]]) -> None:
        raw = _xlsx_bytes(sheets)
        self.send_response(200)
        self._headers()
        self.send_header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    @staticmethod
    def _csv_cell(value: object) -> object:
        if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
            return "'" + value
        return value

    def _body(self) -> dict[str, object]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "Invalid request length.") from None
        if length < 0 or length > MAX_BODY:
            raise ApiError(413, "Request body is too large.")
        if length and self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ApiError(415, "Content-Type must be application/json.")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "Request must contain valid JSON.") from None
        if not isinstance(data, dict):
            raise ApiError(400, "Request body must be an object.")
        return data

    def _origin_ok(self) -> bool:
        if not self._host_allowed():
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return False
        parsed = urlparse(origin)
        host = self.headers.get("Host", "")
        try:
            parsed.port
        except ValueError:
            return False
        return (
            parsed.username is None
            and parsed.password is None
            and parsed.path == ""
            and parsed.query == ""
            and parsed.fragment == ""
            and parsed.netloc.lower() == host.lower()
            and parsed.scheme.lower() in ("http", "https")
        )

    def _host_allowed(self) -> bool:
        host = self.headers.get("Host", "")
        try:
            parsed = urlparse(f"//{host}")
            hostname = parsed.hostname
            parsed.port
        except ValueError:
            return False
        return bool(
            hostname
            and parsed.username is None
            and parsed.password is None
            and parsed.path == ""
            and parsed.query == ""
            and parsed.fragment == ""
            and hostname.rstrip(".").lower() in ALLOWED_HOSTS
        )

    def _limit_auth_requests(self, action: str) -> None:
        key = f"{action}:{self.client_address[0]}"
        current = time.time()
        with FAILURE_LOCK:
            for old_key, stamps in list(AUTH_REQUESTS.items()):
                recent = [stamp for stamp in stamps if current - stamp < AUTH_REQUEST_WINDOW]
                if recent:
                    AUTH_REQUESTS[old_key] = recent
                else:
                    AUTH_REQUESTS.pop(old_key, None)
            attempts = AUTH_REQUESTS.get(key, [])
            if len(attempts) >= AUTH_REQUEST_LIMIT:
                raise ApiError(429, "Too many account requests. Try again in 15 minutes.")
            AUTH_REQUESTS[key] = attempts + [current]

    def _session(self) -> tuple[dict[str, object], dict[str, object]] | None:
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get(COOKIE_NAME)
        if not morsel:
            return None
        token = morsel.value
        with SESSION_LOCK:
            state = SESSIONS.get(token)
            if not state or float(state["expires"]) < time.time():
                SESSIONS.pop(token, None)
                return None
            state["expires"] = time.time() + SESSION_SECONDS
        with connect() as db:
            user = db.execute(
                "SELECT id,email,name,role,status,verified FROM users WHERE id=?",
                (state["user_id"],),
            ).fetchone()
        if not user or user["status"] != "Active" or not user["verified"]:
            with SESSION_LOCK:
                SESSIONS.pop(token, None)
            return None
        return dict(user), state

    def _require_user(self) -> tuple[dict[str, object], dict[str, object]]:
        result = self._session()
        if not result:
            raise ApiError(401, "Please sign in again.")
        return result

    def _require_admin(self) -> tuple[dict[str, object], dict[str, object]]:
        user, state = self._require_user()
        if user["role"] != "Administrator":
            raise ApiError(403, "Administrator access is required.")
        return user, state

    def _csrf(self, state: dict[str, object]) -> None:
        if not self._origin_ok():
            raise ApiError(403, "Request origin is not allowed.")
        supplied = self.headers.get("X-CSRF-Token", "")
        if not supplied or not hmac.compare_digest(supplied, str(state["csrf"])):
            raise ApiError(403, "Security token is missing or expired. Refresh and try again.")

    @staticmethod
    def _audit(db: sqlite3.Connection, actor_id: int | None, action: str,
               entity: str, entity_id: object = "", details: str = "") -> None:
        db.execute(
            "INSERT INTO audit_log(actor_id,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?)",
            (actor_id, action, entity, str(entity_id), details[:500], now_iso()),
        )

    @staticmethod
    def _is_admin(user: dict[str, object]) -> bool:
        return user["role"] == "Administrator"

    def _section_ids(self, db: sqlite3.Connection, user: dict[str, object]) -> list[int]:
        if self._is_admin(user):
            return [int(row[0]) for row in db.execute("SELECT id FROM sections")]
        row = db.execute(
            "SELECT ts.section_id FROM teacher_sections ts "
            "JOIN sections sec ON sec.id=ts.section_id "
            "JOIN school_years sy ON sy.id=sec.school_year_id "
            "WHERE ts.user_id=? ORDER BY sy.active DESC,sec.active DESC,sec.id LIMIT 1",
            (user["id"],),
        ).fetchone()
        return [int(row[0])] if row else []

    def _scope_sql(self, db: sqlite3.Connection, user: dict[str, object], section_column: str) -> tuple[str, list[int]]:
        if self._is_admin(user):
            return "", []
        section_ids = self._section_ids(db, user)
        if not section_ids:
            return " AND 0", []
        return f" AND {section_column} IN ({','.join('?' for _ in section_ids)})", section_ids

    @staticmethod
    def _page(params: dict[str, list[str]]) -> tuple[int, int]:
        try:
            page = max(1, int(params.get("page", ["1"])[0]))
            size = int(params.get("page_size", ["25"])[0])
        except ValueError:
            raise ApiError(400, "Invalid pagination values.") from None
        if size not in (10, 25, 50, 100):
            raise ApiError(400, "Page size must be 10, 25, 50, or 100.")
        return page, size

    def do_GET(self) -> None:
        try:
            if not self._host_allowed():
                raise ApiError(400, "Host is not allowed.")
            parsed = urlparse(self.path)
            if parsed.path.startswith("/api/"):
                self._get_api(parsed.path, parse_qs(parsed.query))
            else:
                self._static(parsed.path)
        except ApiError as error:
            self._send_json(error.status, {"error": error.message})
        except sqlite3.IntegrityError:
            self._send_json(409, {"error": "A data constraint prevented the operation."})
        except Exception:
            self.log_error("Unhandled request error",)
            self._send_json(500, {"error": "The server could not complete the request."})

    def do_POST(self) -> None:
        self._write_api()

    def do_PATCH(self) -> None:
        self._write_api()

    def do_DELETE(self) -> None:
        self._write_api()

    def _write_api(self) -> None:
        try:
            if not self.path.startswith("/api/"):
                raise ApiError(404, "Route not found.")
            if not self._origin_ok():
                raise ApiError(403, "Request origin is not allowed.")
            parsed = urlparse(self.path)
            body = self._body() if self.command != "DELETE" else {}
            self._write_route(parsed.path, parse_qs(parsed.query), body)
        except ApiError as error:
            self._send_json(error.status, {"error": error.message})
        except sqlite3.IntegrityError as error:
            message = str(error)
            self._send_json(409, {"error": "A unique value conflicts with an existing record." if "UNIQUE" in message else "Related records prevent this change."})
        except Exception:
            self.log_error("Unhandled write error")
            self._send_json(500, {"error": "The server could not complete the request."})

    def _static(self, path: str) -> None:
        files = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/index.html": ("index.html", "text/html; charset=utf-8"),
            "/styles.css": ("styles.css", "text/css; charset=utf-8"),
            "/app.js": ("app.js", "text/javascript; charset=utf-8"),
            "/assets/svts-logo.jpg": ("assets/svts-logo.jpg", "image/jpeg"),
        }
        selected = files.get(path)
        if not selected:
            self.send_error(404)
            return
        filename, content_type = selected
        raw = (ROOT / filename).read_bytes()
        self.send_response(200)
        self._headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _get_api(self, path: str, params: dict[str, list[str]]) -> None:
        if path == "/api/status":
            with connect() as db:
                admins = db.execute(
                "SELECT COUNT(*) FROM users WHERE role='Administrator'"
                ).fetchone()[0]
            self._send_json(200, {
                "setup_required": admins == 0,
                "setup_key_required": bool(SETUP_KEY),
            })
            return
        user, state = self._require_user()
        if path == "/api/me":
            self._send_json(200, {"user": user, "csrf": state["csrf"]})
            return
        with connect() as db:
            if path == "/api/dashboard":
                self._dashboard(db, user)
            elif path == "/api/students":
                self._students(db, user, params)
            elif path == "/api/sections":
                self._sections(db, user)
            elif path == "/api/school-years":
                self._school_years(db, user)
            elif path == "/api/categories":
                self._categories(db)
            elif path == "/api/violations":
                self._violations(db, user, params)
            elif path == "/api/service":
                self._service(db, user, params)
            elif path == "/api/service/attendance":
                self._attendance_history(db, user, params)
            elif path == "/api/users":
                self._users(db)
            elif path == "/api/admin-registrations":
                self._pending_admins(db)
            elif path == "/api/adviser-requests":
                self._pending_advisers(db)
            elif path == "/api/audit":
                self._audit_rows(db)
            elif path == "/api/settings":
                self._settings(db)
            elif path == "/api/reports.csv":
                self._report(db, params)
            elif path == "/api/reports.xlsx":
                self._xlsx_report(db, params)
            else:
                raise ApiError(404, "Route not found.")

    def _dashboard(self, db: sqlite3.Connection, user: dict[str, object]) -> None:
        scope, values = self._scope_sql(db, user, "s.section_id")
        students = db.execute(
            f"SELECT COUNT(*) FROM students s WHERE s.active=1{scope}", values
        ).fetchone()[0]
        vio_scope, vio_values = self._scope_sql(db, user, "s.section_id")
        counts = db.execute(
            "SELECT COUNT(*) total, "
            "SUM(CASE WHEN v.severity='Minor' THEN 1 ELSE 0 END) minor, "
            "SUM(CASE WHEN v.severity='Major' THEN 1 ELSE 0 END) major, "
            "SUM(CASE WHEN v.status NOT IN ('Resolved','Closed') THEN 1 ELSE 0 END) open "
            "FROM violations v JOIN students s ON s.id=v.student_id WHERE 1=1" + vio_scope,
            vio_values,
        ).fetchone()
        cs_scope, cs_values = self._scope_sql(db, user, "s.section_id")
        service = db.execute(
            "SELECT COUNT(*) total, SUM(CASE WHEN a.status='Completed' THEN 1 ELSE 0 END) completed "
            "FROM service_assignments a JOIN students s ON s.id=a.student_id WHERE 1=1" + cs_scope,
            cs_values,
        ).fetchone()
        recent = db.execute(
            "SELECT v.id,printf('SVTS-%06d',v.id) case_number,v.incident_date,v.incident_time,"
            "v.severity,v.status,s.first_name,s.last_name,c.name category "
            "FROM violations v JOIN students s ON s.id=v.student_id JOIN categories c ON c.id=v.category_id "
            "WHERE 1=1" + vio_scope + " ORDER BY v.incident_date DESC,v.id DESC LIMIT 6",
            vio_values,
        ).fetchall()
        pending = 0
        if self._is_admin(user):
            pending = db.execute(
                "SELECT COUNT(*) FROM users WHERE role='Administrator' AND status='Pending Verification'"
            ).fetchone()[0]
        self._send_json(200, {
            "students": students,
            "violations": dict(counts),
            "service": dict(service),
            "pending_admins": pending,
            "recent": [dict(row) for row in recent],
        })

    def _query_students(
        self, db: sqlite3.Connection, user: dict[str, object],
        params: dict[str, list[str]], paginate: bool = True,
    ) -> tuple[list[dict[str, object]], int, int, int]:
        page, size = self._page(params) if paginate else (1, 0)
        query = params.get("q", [""])[0].strip()[:100]
        grade = params.get("grade", [""])[0].strip()
        status = params.get("status", [""])[0].strip()
        record_id = params.get("id", [""])[0].strip()
        scope, values = self._scope_sql(db, user, "s.section_id")
        where = " WHERE 1=1" + scope
        if query:
            where += " AND (s.student_no LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ?)"
            values.extend([f"%{query}%"] * 3)
        school_year_id = params.get("school_year_id", [""])[0]
        if school_year_id:
            where += " AND sy.id=?"
            values.append(positive_int(school_year_id, "School year"))
        if grade:
            if grade not in GRADE_LEVELS:
                raise ApiError(400, "Grade level must be 11 or 12.")
            where += " AND s.grade=?"
            values.append(grade)
        section_id = params.get("section_id", [""])[0]
        if section_id:
            where += " AND s.section_id=?"
            values.append(positive_int(section_id, "Section"))
        if status:
            if status not in ("active", "archived"):
                raise ApiError(400, "Student status must be active or archived.")
            where += " AND s.active=?"
            values.append(1 if status == "active" else 0)
        for key, op in (("from", ">="), ("to", "<=")):
            value = params.get(key, [""])[0]
            if value:
                where += f" AND substr(s.created_at,1,10){op}?"
                values.append(parse_date(value, "Date filter"))
        start = params.get("from", [""])[0]
        end = params.get("to", [""])[0]
        if start and end and parse_date(start, "Date filter") > parse_date(end, "Date filter"):
            raise ApiError(400, "Start date must be on or before end date.")
        if record_id:
            where += " AND s.id=?"
            values.append(positive_int(record_id, "Student ID"))
        tables = (
            " FROM students s JOIN sections sec ON sec.id=s.section_id "
            "JOIN school_years sy ON sy.id=sec.school_year_id"
        )
        total = int(db.execute("SELECT COUNT(*)" + tables + where, values).fetchone()[0])
        paging = " LIMIT ? OFFSET ?" if paginate else ""
        query_values = values + ([size, (page - 1) * size] if paginate else [])
        rows = db.execute(
            "SELECT s.id,s.student_no,s.first_name,s.last_name,s.grade,s.active,"
            "s.section_id,sec.name section,sec.strand,sy.id school_year_id,sy.name school_year,"
            "s.created_at,s.updated_at"
            + tables + where
            + " ORDER BY sy.name DESC,sec.grade,sec.name,s.last_name,s.first_name" + paging,
            query_values,
        ).fetchall()
        return [dict(row) for row in rows], total, page, size or total

    def _students(self, db: sqlite3.Connection, user: dict[str, object], params: dict[str, list[str]]) -> None:
        items, total, page, size = self._query_students(db, user, params)
        self._send_json(200, {"items": items, "page": page, "page_size": size, "total": total})

    def _sections(self, db: sqlite3.Connection, user: dict[str, object]) -> None:
        scope, values = self._scope_sql(db, user, "sec.id")
        rows = db.execute(
            "SELECT sec.id,sec.grade,sec.name,sec.strand,sec.active,sec.school_year_id,"
            "sy.name school_year,sy.active school_year_active "
            "FROM sections sec JOIN school_years sy ON sy.id=sec.school_year_id "
            "WHERE sec.active=1" + scope + " ORDER BY sy.name DESC,sec.grade,sec.name",
            values,
        ).fetchall()
        self._send_json(200, {"items": [dict(row) for row in rows]})

    def _school_years(self, db: sqlite3.Connection, user: dict[str, object]) -> None:
        if not self._is_admin(user):
            raise ApiError(403, "Administrator access is required.")
        rows = db.execute("SELECT id,name,active,created_at FROM school_years ORDER BY name DESC").fetchall()
        self._send_json(200, {"items": [dict(row) for row in rows]})

    def _categories(self, db: sqlite3.Connection) -> None:
        rows = db.execute(
            "SELECT id,name,severity,description,active FROM categories WHERE active=1 ORDER BY name"
        ).fetchall()
        self._send_json(200, {"items": [dict(row) for row in rows]})

    def _query_violations(
        self, db: sqlite3.Connection, user: dict[str, object],
        params: dict[str, list[str]], paginate: bool = True,
    ) -> tuple[list[dict[str, object]], int, int, int]:
        page, size = self._page(params) if paginate else (1, 0)
        query = params.get("q", [""])[0].strip()[:100]
        filters = {
            "severity": params.get("severity", [""])[0],
            "status": params.get("status", [""])[0],
            "grade": params.get("grade", [""])[0],
            "section_id": params.get("section_id", [""])[0],
            "school_year_id": params.get("school_year_id", [""])[0],
            "category_id": params.get("category_id", [""])[0],
        }
        record_id = params.get("id", [""])[0].strip()
        scope, values = self._scope_sql(db, user, "s.section_id")
        where = " WHERE 1=1" + scope
        args: list[object] = list(values)
        if query:
            where += (
                " AND (printf('SVTS-%06d',v.id) LIKE ? OR CAST(v.id AS TEXT) LIKE ? "
                "OR s.student_no LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ? "
                "OR c.name LIKE ? OR v.location LIKE ? OR v.description LIKE ? OR u.name LIKE ?)"
            )
            args.extend([f"%{query}%"] * 9)
        if record_id:
            where += " AND v.id=?"
            args.append(positive_int(record_id, "Case ID"))
        for key in ("severity", "status"):
            if filters[key]:
                where += f" AND v.{key}=?"
                args.append(filters[key])
        if filters["grade"]:
            if filters["grade"] not in GRADE_LEVELS:
                raise ApiError(400, "Grade level must be 11 or 12.")
            where += " AND s.grade=?"; args.append(filters["grade"])
        if filters["section_id"]:
            where += " AND s.section_id=?"; args.append(positive_int(filters["section_id"], "Section"))
        if filters["school_year_id"]:
            where += " AND sy.id=?"; args.append(positive_int(filters["school_year_id"], "School year"))
        if filters["category_id"]:
            where += " AND v.category_id=?"; args.append(positive_int(filters["category_id"], "Category"))
        start = params.get("from", [""])[0]
        end = params.get("to", [""])[0]
        if start and end and parse_date(start, "Date filter") > parse_date(end, "Date filter"):
            raise ApiError(400, "Start date must be on or before end date.")
        for key, op in (("from", ">="), ("to", "<=")):
            value = params.get(key, [""])[0]
            if value:
                parsed = parse_date(value, "Date filter")
                where += f" AND v.incident_date {op} ?"; args.append(parsed)
        tables = (
            " FROM violations v JOIN students s ON s.id=v.student_id "
            "JOIN sections sec ON sec.id=s.section_id JOIN school_years sy ON sy.id=sec.school_year_id "
            "JOIN categories c ON c.id=v.category_id LEFT JOIN users u ON u.id=v.created_by"
        )
        total = int(db.execute("SELECT COUNT(*)" + tables + where, args).fetchone()[0])
        paging = " LIMIT ? OFFSET ?" if paginate else ""
        query_args = args + ([size, (page - 1) * size] if paginate else [])
        rows = db.execute(
            "SELECT v.id,printf('SVTS-%06d',v.id) case_number,v.student_id,v.category_id,v.severity,"
            "v.incident_date,v.incident_time,v.location,v.description,v.evidence,v.status,"
            "v.created_at,v.updated_at,s.student_no,s.first_name,s.last_name,"
            "s.first_name || ' ' || s.last_name student,s.grade,s.section_id,"
            "sec.name section,sec.grade section_grade,sy.id school_year_id,sy.name school_year,"
            "c.name category,v.created_by,u.name reporter"
            + tables + where
            + " ORDER BY sy.name DESC,sec.grade,sec.name,v.incident_date DESC,v.id DESC" + paging,
            query_args,
        ).fetchall()
        return [dict(row) for row in rows], total, page, size or total

    def _violations(self, db: sqlite3.Connection, user: dict[str, object], params: dict[str, list[str]]) -> None:
        items, total, page, size = self._query_violations(db, user, params)
        self._send_json(200, {"items": items, "page": page, "page_size": size, "total": total})

    def _query_service(
        self, db: sqlite3.Connection, user: dict[str, object],
        params: dict[str, list[str]], paginate: bool = True,
    ) -> tuple[list[dict[str, object]], int, int, int]:
        page, size = self._page(params) if paginate else (1, 0)
        query = params.get("q", [""])[0].strip()[:100]
        scope, values = self._scope_sql(db, user, "s.section_id")
        where = " WHERE 1=1" + scope
        if query:
            where += (
                " AND (s.student_no LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ? "
                "OR a.description LIKE ? OR printf('SVTS-%06d',a.violation_id) LIKE ?)"
            )
            values.extend([f"%{query}%"] * 5)
        for key, column in (
            ("school_year_id", "sy.id"),
            ("grade", "s.grade"),
            ("section_id", "s.section_id"),
            ("status", "a.status"),
        ):
            value = params.get(key, [""])[0].strip()
            if value:
                if key == "grade" and value not in GRADE_LEVELS:
                    raise ApiError(400, "Grade level must be 11 or 12.")
                where += f" AND {column}=?"
                values.append(positive_int(value, "School year" if key == "school_year_id" else "Section")
                              if key in ("school_year_id", "section_id") else value)
        allowed_statuses = ("Pending", "In Progress", "Completed")
        status = params.get("status", [""])[0].strip()
        if status and status not in allowed_statuses:
            raise ApiError(400, "Invalid community service status.")
        start = params.get("from", [""])[0]
        end = params.get("to", [""])[0]
        if start and end and parse_date(start, "Date filter") > parse_date(end, "Date filter"):
            raise ApiError(400, "Start date must be on or before end date.")
        for key, op in (("from", ">="), ("to", "<=")):
            value = params.get(key, [""])[0]
            if value:
                where += f" AND substr(a.created_at,1,10){op}?"
                values.append(parse_date(value, "Date filter"))
        record_id = params.get("id", [""])[0].strip()
        if record_id:
            where += " AND a.id=?"
            values.append(positive_int(record_id, "Assignment ID"))
        tables = (
            " FROM service_assignments a JOIN students s ON s.id=a.student_id "
            "JOIN sections sec ON sec.id=s.section_id JOIN school_years sy ON sy.id=sec.school_year_id "
            "LEFT JOIN service_attendance att ON att.assignment_id=a.id"
        )
        total = int(db.execute("SELECT COUNT(DISTINCT a.id)" + tables + where, values).fetchone()[0])
        paging = " LIMIT ? OFFSET ?" if paginate else ""
        query_values = values + ([size, (page - 1) * size] if paginate else [])
        rows = db.execute(
            "SELECT a.id,a.student_id,a.violation_id,"
            "CASE WHEN a.violation_id IS NULL THEN '' ELSE printf('SVTS-%06d',a.violation_id) END case_number,"
            "a.description,a.required_days,a.required_hours,a.status,"
            "a.created_at,s.student_no,s.first_name,s.last_name,"
            "s.first_name || ' ' || s.last_name student,s.grade,s.section_id,"
            "sec.name section,sec.grade section_grade,sy.id school_year_id,sy.name school_year,"
            "COALESCE(SUM(att.hours),0) completed_hours,"
            "COALESCE(SUM(att.day_completed),0) completed_days "
            + tables + where
            + " GROUP BY a.id ORDER BY sy.name DESC,sec.grade,sec.name,a.created_at DESC" + paging,
            query_values,
        ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["remaining_hours"] = max(0, round(float(item["required_hours"]) - float(item["completed_hours"]), 2))
            item["remaining_days"] = max(0, int(item["required_days"]) - int(item["completed_days"]))
            result.append(item)
        return result, total, page, size or total

    def _service(self, db: sqlite3.Connection, user: dict[str, object],
                 params: dict[str, list[str]]) -> None:
        items, total, page, size = self._query_service(db, user, params)
        self._send_json(200, {"items": items, "page": page, "page_size": size, "total": total})

    def _attendance_history(self, db: sqlite3.Connection, user: dict[str, object],
                            params: dict[str, list[str]]) -> None:
        assignment_id = positive_int(params.get("assignment_id", [""])[0], "Assignment")
        scope, values = self._scope_sql(db, user, "s.section_id")
        rows = db.execute(
            "SELECT att.id,att.assignment_id,att.service_date,att.hours,att.day_completed,att.notes,"
            "u.name recorded_by,att.created_at FROM service_attendance att "
            "JOIN service_assignments a ON a.id=att.assignment_id "
            "JOIN students s ON s.id=a.student_id JOIN users u ON u.id=att.recorded_by "
            "WHERE att.assignment_id=?" + scope + " ORDER BY att.service_date DESC",
            [assignment_id] + values,
        ).fetchall()
        self._send_json(200, {"items": [dict(row) for row in rows]})

    def _users(self, db: sqlite3.Connection) -> None:
        self._require_admin()
        rows = db.execute(
            "SELECT u.id,u.email,u.name,u.role,u.status,u.verified,u.approved_at,u.created_at,"
            "COUNT(DISTINCT ts.section_id) section_count,"
            "(SELECT sec.grade || ' · ' || sec.name || ' (' || sy.name || ')' "
            "FROM teacher_sections assigned JOIN sections sec ON sec.id=assigned.section_id "
            "JOIN school_years sy ON sy.id=sec.school_year_id WHERE assigned.user_id=u.id "
            "ORDER BY sy.active DESC,sec.active DESC,sec.id LIMIT 1) access_section "
            "FROM users u LEFT JOIN teacher_sections ts ON ts.user_id=u.id "
            "GROUP BY u.id ORDER BY u.role,u.name"
        ).fetchall()
        self._send_json(200, {"items": [dict(row) for row in rows]})

    def _pending_admins(self, db: sqlite3.Connection) -> None:
        self._require_admin()
        rows = db.execute(
            "SELECT id,email,name,created_at FROM users WHERE role='Administrator' "
            "AND status='Pending Verification' ORDER BY created_at"
        ).fetchall()
        self._send_json(200, {"items": [dict(row) for row in rows]})

    def _pending_advisers(self, db: sqlite3.Connection) -> None:
        self._require_admin()
        rows = db.execute(
            "SELECT id,email,name,created_at FROM adviser_requests "
            "WHERE status='Pending' ORDER BY created_at,id"
        ).fetchall()
        self._send_json(200, {"items": [dict(row) for row in rows]})

    def _audit_rows(self, db: sqlite3.Connection) -> None:
        self._require_admin()
        rows = db.execute(
            "SELECT a.id,a.action,a.entity,a.entity_id,a.details,a.created_at,"
            "CASE WHEN u.id IS NULL AND a.entity='adviser_request' THEN 'Adviser applicant' "
            "ELSE COALESCE(u.name,'Account removed') END actor "
            "FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100"
        ).fetchall()
        self._send_json(200, {"items": [dict(row) for row in rows]})

    def _settings(self, db: sqlite3.Connection) -> None:
        self._require_admin()
        rows = db.execute("SELECT key,value FROM settings ORDER BY key").fetchall()
        self._send_json(200, {"settings": {row["key"]: row["value"] for row in rows}})

    def _report(self, db: sqlite3.Connection, params: dict[str, list[str]]) -> None:
        self._require_admin()
        user, _ = self._require_user()
        rows, _, _, _ = self._query_violations(db, user, params, paginate=False)
        headers = ["Case ID", "Date", "Time", "Location", "School year", "Student no.", "Student", "Grade", "Section", "Offense", "Classification", "Status", "Reporting staff", "Description", "Evidence"]
        fields = ["case_number", "incident_date", "incident_time", "location", "school_year", "student_no", "student", "grade", "section", "category", "severity", "status", "reporter", "description", "evidence"]
        self._send_csv(
            f"svts-report-{date.today().isoformat()}.csv",
            [headers] + [[row[field] for field in fields] for row in rows],
        )

    def _xlsx_report(self, db: sqlite3.Connection, params: dict[str, list[str]]) -> None:
        user, _ = self._require_admin()
        module = params.get("module", [""])[0]
        if module not in ("students", "violations", "service"):
            raise ApiError(400, "Choose students, violations, or community service for export.")

        if module == "students":
            rows, _, _, _ = self._query_students(db, user, params, paginate=False)
            headers = [
                "Student no.", "First name", "Last name", "Grade", "Section",
                "School year", "Status", "Created at", "Updated at",
            ]
            fields = [
                "student_no", "first_name", "last_name", "grade", "section",
                "school_year", "active", "created_at", "updated_at",
            ]
            row_values = lambda row: [
                ("Active" if row["active"] else "Archived")
                if field == "active" else row[field]
                for field in fields
            ]
        elif module == "violations":
            rows, _, _, _ = self._query_violations(db, user, params, paginate=False)
            headers = [
                "Case ID", "Student no.", "Student", "Grade", "Section", "School year",
                "Offense", "Classification", "Incident date", "Incident time", "Location",
                "Status", "Reporting staff", "Description", "Evidence",
            ]
            fields = [
                "case_number", "student_no", "student", "grade", "section", "school_year",
                "category", "severity", "incident_date", "incident_time", "location",
                "status", "reporter", "description", "evidence",
            ]
            row_values = lambda row: [row[field] for field in fields]
        else:
            rows, _, _, _ = self._query_service(db, user, params, paginate=False)
            headers = [
                "Assignment ID", "Case ID", "Student no.", "Student", "Grade",
                "Section", "School year", "Assignment", "Required days", "Completed days",
                "Remaining days", "Required hours", "Completed hours", "Remaining hours",
                "Status", "Assigned at",
            ]
            fields = [
                "id", "case_number", "student_no", "student", "grade", "section",
                "school_year", "description", "required_days", "completed_days",
                "remaining_days", "required_hours", "completed_hours", "remaining_hours",
                "status", "created_at",
            ]
            row_values = lambda row: [row[field] for field in fields]

        grouped: dict[tuple[object, ...], list[list[object]]] = {}
        section_info: dict[tuple[object, ...], tuple[str, str, str]] = {}
        overall = []
        for row in rows:
            values = row_values(row)
            overall.append(values)
            section_key = (
                row["school_year_id"], row["grade"], row["section_id"],
            )
            grouped.setdefault(section_key, []).append(values)
            section_info[section_key] = (
                str(row["school_year"]), str(row["grade"]), str(row["section"]),
            )
        used_names = {"overall"}
        sheets = [("Overall", headers, overall)]
        for key in sorted(grouped, key=lambda item: tuple(str(value) for value in item)):
            year, grade, section = section_info[key]
            name = _xlsx_sheet_name(f"{year} Grade {grade} {section}", used_names)
            sheets.append((name, headers, grouped[key]))
        self._send_xlsx(
            f"svts-{module}-{date.today().isoformat()}.xlsx",
            sheets,
        )

    def _write_route(self, path: str, params: dict[str, list[str]], body: dict[str, object]) -> None:
        if path == "/api/setup" and self.command == "POST":
            self._setup(body); return
        if path == "/api/login" and self.command == "POST":
            self._login(body); return
        if path == "/api/register-admin" and self.command == "POST":
            self._register_admin(body); return
        if path == "/api/request-adviser" and self.command == "POST":
            self._request_adviser(body); return

        user, state = self._require_user()
        self._csrf(state)
        if path == "/api/logout" and self.command == "POST":
            with SESSION_LOCK:
                SESSIONS.pop(self._cookie_token(), None)
            self._send_json(200, {"ok": True}, {"Set-Cookie": self._clear_cookie()}); return

        with connect() as db:
            if path == "/api/students":
                self._write_student(db, user, body, params)
            elif path == "/api/violations":
                self._write_violation(db, user, body, params)
            elif path == "/api/service":
                self._write_service(db, user, body, params)
            elif path == "/api/service/attendance":
                self._write_attendance(db, user, body)
            elif path == "/api/sections":
                self._write_section(db, user, body, params)
            elif path == "/api/school-years":
                self._write_school_year(db, user, body, params)
            elif path == "/api/categories":
                self._write_category(db, user, body, params)
            elif path == "/api/users":
                self._write_user(db, user, body, params)
            elif path == "/api/admin-registrations":
                self._approve_admin(db, user, body, params)
            elif path == "/api/adviser-requests":
                if self.command != "PATCH":
                    raise ApiError(405, "Adviser requests can only be reviewed with PATCH.")
                self._review_adviser(db, user, body, params)
            elif path == "/api/settings":
                self._write_settings(db, user, body)
            else:
                raise ApiError(404, "Route not found.")

    def _cookie_token(self) -> str:
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        morsel = cookie.get(COOKIE_NAME)
        return morsel.value if morsel else ""

    def _set_cookie(self, token: str) -> str:
        attrs = f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}"
        if COOKIE_SECURE:
            attrs += "; Secure"
        return attrs

    def _clear_cookie(self) -> str:
        attrs = f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
        if COOKIE_SECURE:
            attrs += "; Secure"
        return attrs

    def _new_session(self, user_id: int) -> tuple[str, str]:
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        with SESSION_LOCK:
            SESSIONS[token] = {"user_id": user_id, "csrf": csrf, "expires": time.time() + SESSION_SECONDS}
        return token, csrf

    def _setup(self, body: dict[str, object]) -> None:
        if not self._origin_ok():
            raise ApiError(403, "Request origin is not allowed.")
        self._limit_auth_requests("setup")
        if SETUP_KEY:
            supplied_key = body.get("setup_key")
            if not isinstance(supplied_key, str) or not hmac.compare_digest(supplied_key, SETUP_KEY):
                raise ApiError(403, "The administrator setup key is invalid.")
        name = clean_text(body.get("name"), "Name", 120)
        email = clean_text(body.get("email"), "Email", 254).lower()
        password = new_password(body.get("password"))
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ApiError(400, "Enter a valid email address.")
        with connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute("SELECT COUNT(*) FROM users WHERE role='Administrator'").fetchone()[0]
            if count:
                db.rollback()
                raise ApiError(409, "Initial administrator setup has already been completed.")
            cur = db.execute(
                "INSERT INTO users(email,name,password_hash,role,status,verified,created_at) VALUES(?,?,?,'Administrator','Active',1,?)",
                (email, name, hash_password(password), now_iso()),
            )
            user_id = int(cur.lastrowid)
            self._audit(db, user_id, "Initial administrator setup", "user", user_id)
            db.commit()
        token, csrf = self._new_session(user_id)
        with connect() as db:
            user = dict(db.execute("SELECT id,email,name,role,status,verified FROM users WHERE id=?", (user_id,)).fetchone())
        self._send_json(201, {"user": user, "csrf": csrf}, {"Set-Cookie": self._set_cookie(token)})

    def _login(self, body: dict[str, object]) -> None:
        if not self._origin_ok():
            raise ApiError(403, "Request origin is not allowed.")
        email = clean_text(body.get("email"), "Email", 254).lower()
        password = body.get("password")
        if not isinstance(password, str):
            raise ApiError(400, "Password is required.")
        if len(password) > MAX_PASSWORD_LENGTH:
            raise ApiError(400, f"Password must be {MAX_PASSWORD_LENGTH} characters or fewer.")
        address = self.client_address[0]
        key = f"{address}:{email}"
        current = time.time()
        with FAILURE_LOCK:
            for failures in (LOGIN_FAILURES, LOGIN_IP_FAILURES):
                for failure_key, stamps in list(failures.items()):
                    recent = [stamp for stamp in stamps if current - stamp < AUTH_REQUEST_WINDOW]
                    if recent:
                        failures[failure_key] = recent
                    else:
                        failures.pop(failure_key, None)
            failures = [stamp for stamp in LOGIN_FAILURES.get(key, []) if current - stamp < AUTH_REQUEST_WINDOW]
            LOGIN_FAILURES[key] = failures
            ip_failures = LOGIN_IP_FAILURES.get(address, [])
            if len(failures) >= LOGIN_FAILURE_LIMIT or len(ip_failures) >= LOGIN_IP_FAILURE_LIMIT:
                raise ApiError(429, "Too many sign-in attempts. Try again in 15 minutes.")
        with connect() as db:
            user = db.execute("SELECT * FROM users WHERE email=? COLLATE NOCASE", (email,)).fetchone()
        if not user or not verify_password(password, user["password_hash"]):
            with FAILURE_LOCK:
                LOGIN_FAILURES.setdefault(key, []).append(current)
                LOGIN_IP_FAILURES.setdefault(address, []).append(current)
            raise ApiError(401, "Email or password is incorrect.")
        if user["status"] != "Active" or not user["verified"]:
            raise ApiError(403, "This account is pending verification or is not active.")
        with FAILURE_LOCK:
            LOGIN_FAILURES.pop(key, None)
        token, csrf = self._new_session(int(user["id"]))
        self._send_json(
            200,
            {"user": {key: user[key] for key in ("id", "email", "name", "role", "status", "verified")}, "csrf": csrf},
            {"Set-Cookie": self._set_cookie(token)},
        )

    def _register_admin(self, body: dict[str, object]) -> None:
        if not self._origin_ok():
            raise ApiError(403, "Request origin is not allowed.")
        self._limit_auth_requests("admin-registration")
        name = clean_text(body.get("name"), "Name", 120)
        email = clean_text(body.get("email"), "Email", 254).lower()
        password = new_password(body.get("password"))
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ApiError(400, "Enter a valid email address.")
        with connect() as db:
            if db.execute("SELECT 1 FROM users WHERE email=? COLLATE NOCASE", (email,)).fetchone():
                raise ApiError(409, "An account already uses this email.")
            try:
                cur = db.execute(
                    "INSERT INTO users(email,name,password_hash,role,status,verified,created_at) "
                    "VALUES(?,?,?,'Administrator','Pending Verification',0,?)",
                    (email, name, hash_password(password), now_iso()),
                )
            except sqlite3.IntegrityError:
                raise ApiError(409, "An account already uses this email.") from None
            self._audit(db, int(cur.lastrowid), "Requested administrator access", "user", cur.lastrowid)
            db.commit()
        self._send_json(201, {"message": "Registration is awaiting verification."})

    def _request_adviser(self, body: dict[str, object]) -> None:
        if not self._origin_ok():
            raise ApiError(403, "Request origin is not allowed.")
        self._limit_auth_requests("adviser-request")
        name = clean_text(body.get("name"), "Name", 120)
        email = clean_text(body.get("email"), "Email", 254).lower()
        password = new_password(body.get("password"))
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ApiError(400, "Enter a valid email address.")
        with connect() as db:
            if db.execute("SELECT 1 FROM users WHERE email=? COLLATE NOCASE", (email,)).fetchone():
                raise ApiError(409, "An account already uses this email.")
            if db.execute(
                "SELECT 1 FROM adviser_requests WHERE email=? COLLATE NOCASE AND status='Pending'",
                (email,),
            ).fetchone():
                raise ApiError(409, "An adviser access request is already pending for this email.")
            try:
                cur = db.execute(
                    "INSERT INTO adviser_requests(email,name,password_hash,created_at) VALUES(?,?,?,?)",
                    (email, name, hash_password(password), now_iso()),
                )
            except sqlite3.IntegrityError:
                raise ApiError(409, "An adviser access request is already pending for this email.") from None
            self._audit(db, None, "Requested adviser access", "adviser_request", cur.lastrowid)
            db.commit()
        self._send_json(201, {"message": "Your adviser access request is pending administrator approval."})

    def _write_student(self, db: sqlite3.Connection, user: dict[str, object],
                       body: dict[str, object], params: dict[str, list[str]]) -> None:
        self._require_admin()
        record_id = params.get("id", [""])[0]
        if record_id and set(body) == {"active"}:
            student_id = positive_int(record_id, "Student ID")
            active = 1 if body["active"] is True else 0
            db.execute("UPDATE students SET active=?,updated_at=? WHERE id=?", (active, now_iso(), student_id))
            self._audit(db, int(user["id"]), "Archived student" if not active else "Reactivated student", "student", student_id)
            db.commit()
            self._send_json(200, {"ok": True}); return
        student_no = clean_text(body.get("student_no"), "Student number", 40)
        first = clean_text(body.get("first_name"), "First name", 80)
        last = clean_text(body.get("last_name"), "Last name", 80)
        grade = clean_text(body.get("grade"), "Grade level", 12)
        if grade not in GRADE_LEVELS:
            raise ApiError(400, "Grade level must be 11 or 12.")
        section_id = positive_int(body.get("section_id"), "Section")
        section = db.execute("SELECT grade FROM sections WHERE id=? AND active=1", (section_id,)).fetchone()
        if not section:
            raise ApiError(400, "Choose an active section.")
        if str(section["grade"]) != grade:
            raise ApiError(400, "Student grade must match the selected section.")
        stamp = now_iso()
        if record_id:
            db.execute(
                "UPDATE students SET student_no=?,first_name=?,last_name=?,grade=?,section_id=?,updated_at=? WHERE id=?",
                (student_no, first, last, grade, section_id, stamp, positive_int(record_id, "Student ID")),
            )
            self._audit(db, int(user["id"]), "Updated student", "student", record_id)
            status = 200
        else:
            cur = db.execute(
                "INSERT INTO students(student_no,first_name,last_name,grade,section_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (student_no, first, last, grade, section_id, stamp, stamp),
            )
            record_id = cur.lastrowid
            self._audit(db, int(user["id"]), "Created student", "student", record_id)
            status = 201
        db.commit()
        self._send_json(status, {"id": int(record_id)})

    def _create_violation_student(
        self, db: sqlite3.Connection, user: dict[str, object], payload: object
    ) -> int:
        if not isinstance(payload, dict):
            raise ApiError(400, "New student details are required.")
        student_no = clean_text(payload.get("student_no"), "Student number", 40)
        first = clean_text(payload.get("first_name"), "First name", 80)
        last = clean_text(payload.get("last_name"), "Last name", 80)
        school_year_id = positive_int(payload.get("school_year_id"), "School year")
        grade = clean_text(payload.get("grade"), "Grade level", 12)
        if grade not in GRADE_LEVELS:
            raise ApiError(400, "Grade level must be 11 or 12.")
        section_id = positive_int(payload.get("section_id"), "Section")
        section = db.execute(
            "SELECT id,grade,school_year_id FROM sections WHERE id=? AND active=1", (section_id,)
        ).fetchone()
        if not section:
            raise ApiError(400, "Choose an active section.")
        if int(section["school_year_id"]) != school_year_id:
            raise ApiError(400, "The selected section does not belong to the chosen school year.")
        if str(section["grade"]) != grade:
            raise ApiError(400, "Student grade must match the selected section.")
        if not self._is_admin(user) and section_id not in self._section_ids(db, user):
            raise ApiError(403, "You can only add students to your assigned sections.")
        stamp = now_iso()
        cur = db.execute(
            "INSERT INTO students(student_no,first_name,last_name,grade,section_id,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (student_no, first, last, grade, section_id, stamp, stamp),
        )
        student_id = int(cur.lastrowid)
        self._audit(db, int(user["id"]), "Created student while recording violation", "student", student_id)
        return student_id

    def _write_violation(self, db: sqlite3.Connection, user: dict[str, object],
                         body: dict[str, object], params: dict[str, list[str]]) -> None:
        record_id = params.get("id", [""])[0]
        is_admin = self._is_admin(user)
        if record_id and not is_admin:
            raise ApiError(403, "Only administrators can update violation records.")
        if record_id and body.get("new_student") is not None:
            raise ApiError(400, "A new student cannot be added while updating a violation.")
        category_id = positive_int(body.get("category_id"), "Offense category")
        category = db.execute("SELECT severity FROM categories WHERE id=? AND active=1", (category_id,)).fetchone()
        if not category:
            raise ApiError(400, "Choose an active offense category.")
        new_student = body.get("new_student")
        if new_student is not None:
            student_id = self._create_violation_student(db, user, new_student)
            student_created = True
        else:
            student_id = positive_int(body.get("student_id"), "Student")
            student = db.execute(
                "SELECT id,section_id FROM students WHERE id=? AND active=1", (student_id,)
            ).fetchone()
            if not student:
                raise ApiError(400, "Choose an active student.")
            if not is_admin and int(student["section_id"]) not in self._section_ids(db, user):
                raise ApiError(403, "You can only record violations for students in your assigned sections.")
            student_created = False
        incident_date = parse_date(body.get("incident_date"), "Incident date")
        incident_time = clean_time(body.get("incident_time", ""), "Violation time")
        location = clean_text(body.get("location", ""), "Location", 200)
        description = clean_text(body.get("description", ""), "Description", 2000)
        evidence = clean_text(body.get("evidence", ""), "Evidence reference", 1000, required=False)
        status_value = str(body.get("status", "Open" if is_admin else "Under Review"))
        statuses = ("Open", "Under Review", "Resolved", "Closed", "Referred")
        if status_value not in statuses:
            raise ApiError(400, "Invalid case status.")
        if not is_admin and status_value != "Under Review":
            raise ApiError(403, "New adviser-reported violations must enter review.")
        stamp = now_iso()
        if record_id:
            db.execute(
                "UPDATE violations SET student_id=?,category_id=?,severity=?,incident_date=?,incident_time=?,"
                "location=?,description=?,evidence=?,status=?,updated_at=? WHERE id=?",
                (student_id, category_id, category["severity"], incident_date, incident_time,
                 location, description, evidence, status_value, stamp,
                 positive_int(record_id, "Case ID")),
            )
            self._audit(db, int(user["id"]), "Updated violation record", "violation", record_id)
            code = 200
        else:
            cur = db.execute(
                "INSERT INTO violations(student_id,category_id,severity,incident_date,incident_time,location,"
                "description,evidence,status,created_by,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (student_id, category_id, category["severity"], incident_date, incident_time, location,
                 description, evidence, status_value, user["id"], stamp, stamp),
            )
            record_id = cur.lastrowid
            self._audit(db, int(user["id"]), "Created violation record", "violation", record_id)
            code = 201
        db.commit()
        self._send_json(code, {
            "id": int(record_id),
            "case_number": f"SVTS-{int(record_id):06d}",
            "student_id": student_id,
            "student_created": student_created,
        })

    def _write_service(self, db: sqlite3.Connection, user: dict[str, object],
                       body: dict[str, object], params: dict[str, list[str]]) -> None:
        self._require_admin()
        record_id = params.get("id", [""])[0]
        student_id = positive_int(body.get("student_id"), "Student")
        required_days = positive_int(body.get("required_days"), "Required days", 366)
        try:
            required_hours = float(body.get("required_hours"))
        except (ValueError, TypeError):
            raise ApiError(400, "Required hours must be a positive number.") from None
        if required_hours <= 0 or required_hours > 10000:
            raise ApiError(400, "Required hours must be greater than zero.")
        violation_id_value = body.get("violation_id")
        violation_id = positive_int(violation_id_value, "Violation") if violation_id_value else None
        description = clean_text(body.get("description", ""), "Description", 500, required=False)
        student = db.execute("SELECT id FROM students WHERE id=? AND active=1", (student_id,)).fetchone()
        if not student:
            raise ApiError(400, "Choose an active student.")
        if violation_id:
            linked = db.execute("SELECT student_id FROM violations WHERE id=?", (violation_id,)).fetchone()
            if not linked or int(linked["student_id"]) != student_id:
                raise ApiError(400, "The linked incident must belong to the selected student.")
        stamp = now_iso()
        if record_id:
            db.execute(
                "UPDATE service_assignments SET student_id=?,violation_id=?,description=?,required_days=?,required_hours=?,updated_at=? WHERE id=?",
                (student_id, violation_id, description, required_days, required_hours, stamp, positive_int(record_id, "Assignment ID")),
            )
            assignment_id = int(record_id)
            self._audit(db, int(user["id"]), "Updated service assignment", "service", assignment_id)
            code = 200
        else:
            cur = db.execute(
                "INSERT INTO service_assignments(student_id,violation_id,description,required_days,required_hours,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (student_id, violation_id, description, required_days, required_hours, user["id"], stamp, stamp),
            )
            assignment_id = int(cur.lastrowid)
            self._audit(db, int(user["id"]), "Created service assignment", "service", assignment_id)
            code = 201
        self._sync_service_status(db, assignment_id)
        db.commit()
        self._send_json(code, {"id": assignment_id})

    @staticmethod
    def _sync_service_status(db: sqlite3.Connection, assignment_id: int) -> None:
        assignment = db.execute(
            "SELECT required_days,required_hours FROM service_assignments WHERE id=?", (assignment_id,)
        ).fetchone()
        if not assignment:
            return
        progress = db.execute(
            "SELECT COALESCE(SUM(hours),0) hours,COALESCE(SUM(day_completed),0) days "
            "FROM service_attendance WHERE assignment_id=?", (assignment_id,)
        ).fetchone()
        if progress["hours"] >= assignment["required_hours"] and progress["days"] >= assignment["required_days"]:
            status = "Completed"
        elif progress["hours"] > 0 or progress["days"] > 0:
            status = "In Progress"
        else:
            status = "Pending"
        db.execute("UPDATE service_assignments SET status=?,updated_at=? WHERE id=?", (status, now_iso(), assignment_id))

    def _write_attendance(self, db: sqlite3.Connection, user: dict[str, object],
                          body: dict[str, object]) -> None:
        assignment_id = positive_int(body.get("assignment_id"), "Assignment")
        assignment = db.execute(
            "SELECT a.id,a.student_id,s.section_id FROM service_assignments a "
            "JOIN students s ON s.id=a.student_id WHERE a.id=?", (assignment_id,)
        ).fetchone()
        if not assignment:
            raise ApiError(404, "Service assignment was not found.")
        if not self._is_admin(user):
            allowed = self._section_ids(db, user)
            if int(assignment["section_id"]) not in allowed:
                raise ApiError(403, "You cannot record service attendance for this section.")
        service_date = parse_date(body.get("service_date"), "Service date")
        try:
            hours = float(body.get("hours"))
        except (ValueError, TypeError):
            raise ApiError(400, "Hours must be a number greater than zero and at most 24.") from None
        if hours <= 0 or hours > 24:
            raise ApiError(400, "Hours must be a number greater than zero and at most 24.")
        day_completed = 1 if body.get("day_completed", True) is True else 0
        notes = clean_text(body.get("notes", ""), "Notes", 500, required=False)
        try:
            cur = db.execute(
                "INSERT INTO service_attendance(assignment_id,service_date,hours,day_completed,notes,recorded_by,created_at) VALUES(?,?,?,?,?,?,?)",
                (assignment_id, service_date, hours, day_completed, notes, user["id"], now_iso()),
            )
        except sqlite3.IntegrityError as error:
            if "UNIQUE" in str(error):
                raise ApiError(409, "Attendance has already been recorded for this assignment and date.") from None
            raise
        self._sync_service_status(db, assignment_id)
        self._audit(db, int(user["id"]), "Recorded service attendance", "service_attendance", cur.lastrowid)
        db.commit()
        self._send_json(201, {"id": int(cur.lastrowid)})

    def _write_section(self, db: sqlite3.Connection, user: dict[str, object],
                       body: dict[str, object], params: dict[str, list[str]]) -> None:
        self._require_admin()
        if self.command == "DELETE":
            record_id = positive_int(params.get("id", [""])[0], "Section ID")
            usage = db.execute("SELECT 1 FROM students WHERE section_id=? LIMIT 1", (record_id,)).fetchone()
            if usage:
                raise ApiError(409, "Section is referenced by student records and cannot be deleted.")
            db.execute("DELETE FROM sections WHERE id=?", (record_id,))
            self._audit(db, int(user["id"]), "Deleted section", "section", record_id)
            db.commit()
            self._send_json(200, {"ok": True}); return
        record_id = params.get("id", [""])[0]
        year_id = positive_int(body.get("school_year_id"), "School year")
        grade = clean_text(body.get("grade"), "Grade level", 12)
        if grade not in GRADE_LEVELS:
            raise ApiError(400, "Grade level must be 11 or 12.")
        name = clean_text(body.get("name"), "Section name", 80)
        strand = clean_text(body.get("strand", ""), "Strand", 80, required=False)
        if not db.execute("SELECT id FROM school_years WHERE id=?", (year_id,)).fetchone():
            raise ApiError(400, "Choose a valid school year.")
        if record_id:
            db.execute("UPDATE sections SET school_year_id=?,grade=?,name=?,strand=? WHERE id=?",
                       (year_id, grade, name, strand, positive_int(record_id, "Section ID")))
            self._audit(db, int(user["id"]), "Updated section", "section", record_id)
            code = 200
        else:
            cur = db.execute(
                "INSERT INTO sections(school_year_id,grade,name,strand,created_at) VALUES(?,?,?,?,?)",
                (year_id, grade, name, strand, now_iso()),
            )
            record_id = cur.lastrowid
            self._audit(db, int(user["id"]), "Created section", "section", record_id)
            code = 201
        db.commit()
        self._send_json(code, {"id": int(record_id)})

    def _write_school_year(self, db: sqlite3.Connection, user: dict[str, object],
                           body: dict[str, object], params: dict[str, list[str]]) -> None:
        self._require_admin()
        record_id = params.get("id", [""])[0]
        if record_id:
            year_id = positive_int(record_id, "School year ID")
            if body.get("active") is True:
                db.execute("UPDATE school_years SET active=0")
            db.execute("UPDATE school_years SET name=?,active=? WHERE id=?",
                       (clean_text(body.get("name"), "School year", 20), int(body.get("active") is True), year_id))
            self._audit(db, int(user["id"]), "Updated school year", "school_year", year_id)
            code = 200
        else:
            name = clean_text(body.get("name"), "School year", 20)
            active = int(body.get("active") is True)
            if active:
                db.execute("UPDATE school_years SET active=0")
            cur = db.execute("INSERT INTO school_years(name,active,created_at) VALUES(?,?,?)",
                             (name, active, now_iso()))
            record_id = cur.lastrowid
            self._audit(db, int(user["id"]), "Created school year", "school_year", record_id)
            code = 201
        db.commit()
        self._send_json(code, {"id": int(record_id)})

    def _write_category(self, db: sqlite3.Connection, user: dict[str, object],
                        body: dict[str, object], params: dict[str, list[str]]) -> None:
        self._require_admin()
        category_id = params.get("id", [""])[0]
        name = clean_text(body.get("name"), "Offense name", 100)
        severity = body.get("severity")
        if severity not in ("Minor", "Major"):
            raise ApiError(400, "Classification must be Minor or Major.")
        description = clean_text(body.get("description", ""), "Description", 500, required=False)
        if category_id:
            cid = positive_int(category_id, "Category ID")
            db.execute("UPDATE categories SET name=?,severity=?,description=? WHERE id=?",
                       (name, severity, description, cid))
            self._audit(db, int(user["id"]), "Updated offense category", "category", cid)
            code = 200
        else:
            cur = db.execute(
                "INSERT INTO categories(name,severity,description,created_at) VALUES(?,?,?,?)",
                (name, severity, description, now_iso()),
            )
            category_id = cur.lastrowid
            self._audit(db, int(user["id"]), "Created offense category", "category", category_id)
            code = 201
        db.commit()
        self._send_json(code, {"id": int(category_id)})

    def _write_user(self, db: sqlite3.Connection, user: dict[str, object],
                    body: dict[str, object], params: dict[str, list[str]]) -> None:
        self._require_admin()
        if self.command == "PATCH":
            user_id = positive_int(params.get("id", [""])[0], "User ID")
            target = db.execute("SELECT id,role,status FROM users WHERE id=?", (user_id,)).fetchone()
            if not target:
                raise ApiError(404, "Account was not found.")
            status = body.get("status")
            if status not in ("Active", "Suspended"):
                raise ApiError(400, "Account status must be Active or Suspended.")
            if user_id == int(user["id"]) and status != "Active":
                raise ApiError(400, "You cannot suspend your own account.")
            db.execute("UPDATE users SET status=? WHERE id=?", (status, user_id))
            self._audit(db, int(user["id"]), f"{status} account", "user", user_id)
            db.commit()
            self._send_json(200, {"ok": True}); return
        email = clean_text(body.get("email"), "Email", 254).lower()
        name = clean_text(body.get("name"), "Name", 120)
        password = new_password(body.get("password"), "Adviser password")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ApiError(400, "Enter a valid email address.")
        sections = body.get("section_ids")
        if not isinstance(sections, list) or len(sections) != 1:
            raise ApiError(400, "Assign exactly one section to the adviser.")
        section_ids = list(dict.fromkeys(positive_int(item, "Section") for item in sections))
        if len(section_ids) != 1:
            raise ApiError(400, "Assign exactly one section to the adviser.")
        if db.execute(
            "SELECT 1 FROM adviser_requests WHERE email=? COLLATE NOCASE AND status='Pending'",
            (email,),
        ).fetchone():
            raise ApiError(409, "An adviser access request is already pending for this email.")
        found = db.execute(
            f"SELECT COUNT(*) FROM sections WHERE id IN ({','.join('?' for _ in section_ids)}) AND active=1",
            section_ids,
        ).fetchone()[0]
        if found != len(section_ids):
            raise ApiError(400, "The assigned section must be active.")
        try:
            cur = db.execute(
                "INSERT INTO users(email,name,password_hash,role,status,verified,approved_by,approved_at,created_at) "
                "VALUES(?,?,?,'Teacher','Active',1,?,?,?)",
                (email, name, hash_password(password), user["id"], now_iso(), now_iso()),
            )
        except sqlite3.IntegrityError:
            raise ApiError(409, "An account already uses this email.") from None
        user_id = int(cur.lastrowid)
        db.executemany("INSERT INTO teacher_sections(user_id,section_id) VALUES(?,?)",
                       [(user_id, section_id) for section_id in section_ids])
        self._audit(db, int(user["id"]), "Created adviser account", "user", user_id)
        db.commit()
        self._send_json(201, {"id": user_id})

    def _review_adviser(self, db: sqlite3.Connection, user: dict[str, object],
                        body: dict[str, object], params: dict[str, list[str]]) -> None:
        self._require_admin()
        request_id = positive_int(params.get("id", [""])[0], "Request ID")
        request = db.execute(
            "SELECT id,email,name,password_hash FROM adviser_requests "
            "WHERE id=? AND status='Pending'", (request_id,)
        ).fetchone()
        if not request:
            raise ApiError(404, "Pending adviser request was not found.")
        decision = body.get("decision")
        if decision == "approve":
            section_id = positive_int(body.get("section_id"), "Section")
            section = db.execute(
                "SELECT id FROM sections WHERE id=? AND active=1", (section_id,)
            ).fetchone()
            if not section:
                raise ApiError(400, "Choose one active section for the adviser.")
            if db.execute(
                "SELECT 1 FROM users WHERE email=? COLLATE NOCASE", (request["email"],)
            ).fetchone():
                raise ApiError(409, "An account already uses this email.")
            stamp = now_iso()
            cursor = db.execute(
                "INSERT INTO users(email,name,password_hash,role,status,verified,approved_by,approved_at,created_at) "
                "VALUES(?,?,?,'Teacher','Active',1,?,?,?)",
                (request["email"], request["name"], request["password_hash"],
                 user["id"], stamp, stamp),
            )
            account_id = int(cursor.lastrowid)
            db.execute(
                "INSERT INTO teacher_sections(user_id,section_id) VALUES(?,?)",
                (account_id, section_id),
            )
            db.execute(
                "UPDATE adviser_requests SET status='Approved',password_hash='',reviewed_by=?,reviewed_at=? WHERE id=?",
                (user["id"], stamp, request_id),
            )
            self._audit(db, int(user["id"]), "Approved adviser access request", "user", account_id,
                        f"Assigned section {section_id}")
        elif decision == "reject":
            db.execute(
                "UPDATE adviser_requests SET status='Rejected',password_hash='',reviewed_by=?,reviewed_at=? WHERE id=?",
                (user["id"], now_iso(), request_id),
            )
            self._audit(db, int(user["id"]), "Rejected adviser access request",
                        "adviser_request", request_id)
        else:
            raise ApiError(400, "Decision must be approve or reject.")
        db.commit()
        self._send_json(200, {"ok": True})

    def _write_settings(self, db: sqlite3.Connection, user: dict[str, object],
                        body: dict[str, object]) -> None:
        self._require_admin()
        allowed = ("school_name", "address", "principal", "guidance")
        for key in allowed:
            if key in body:
                value = clean_text(body[key], key.replace("_", " ").title(), 200, required=False)
                db.execute(
                    "INSERT INTO settings(key,value) VALUES(?,?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (key, value),
                )
        self._audit(db, int(user["id"]), "Updated school settings", "settings")
        db.commit()
        self._send_json(200, {"ok": True})

    def _approve_admin(self, db: sqlite3.Connection, user: dict[str, object],
                       body: dict[str, object], params: dict[str, list[str]]) -> None:
        self._require_admin()
        user_id = positive_int(params.get("id", [""])[0], "User ID")
        target = db.execute(
            "SELECT id,role,status FROM users WHERE id=?", (user_id,)
        ).fetchone()
        if not target or target["role"] != "Administrator" or target["status"] != "Pending Verification":
            raise ApiError(404, "Pending administrator registration was not found.")
        if int(user["id"]) == user_id:
            raise ApiError(400, "You cannot approve your own registration.")
        decision = body.get("decision")
        if decision == "approve":
            db.execute(
                "UPDATE users SET status='Active',verified=1,approved_by=?,approved_at=? WHERE id=?",
                (user["id"], now_iso(), user_id),
            )
            self._audit(db, int(user["id"]), "Approved administrator registration", "user", user_id)
        elif decision == "reject":
            db.execute("UPDATE users SET status='Rejected' WHERE id=?", (user_id,))
            self._audit(db, int(user["id"]), "Rejected administrator registration", "user", user_id)
        else:
            raise ApiError(400, "Decision must be approve or reject.")
        db.commit()
        self._send_json(200, {"ok": True})


class WSGIHandler(SVTSHandler):
    def version_string(self) -> str:
        return self.server_version

    def send_response(self, code: int, message: str | None = None) -> None:
        self._wsgi_status = code
        self._wsgi_reason = message or HTTPStatus(code).phrase
        self._wsgi_headers = [
            ("Server", self.version_string()),
            ("Date", self.date_time_string()),
        ]
        self.log_request(code)

    def send_header(self, keyword: str, value: str) -> None:
        self._wsgi_headers.append((keyword, value))

    def end_headers(self) -> None:
        return


_wsgi_initialized = False
_wsgi_init_lock = threading.Lock()


def _wsgi_client_ip(environ: dict[str, object]) -> str:
    remote_addr = str(environ.get("REMOTE_ADDR", ""))
    if not TRUST_PROXY:
        return remote_addr
    forwarded_for = str(environ.get("HTTP_X_FORWARDED_FOR", ""))
    if not forwarded_for:
        return remote_addr
    candidate = forwarded_for.rsplit(",", 1)[-1].strip()
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return remote_addr


def wsgi_app(environ: dict[str, object], start_response):
    global _wsgi_initialized
    if not _wsgi_initialized:
        with _wsgi_init_lock:
            if not _wsgi_initialized:
                initialize()
                _validate_runtime_config()
                _wsgi_initialized = True

    headers = Message()
    for key, value in environ.items():
        if key.startswith("HTTP_"):
            headers[key[5:].replace("_", "-")] = str(value)
    if environ.get("CONTENT_TYPE"):
        headers["Content-Type"] = str(environ["CONTENT_TYPE"])
    if environ.get("CONTENT_LENGTH"):
        headers["Content-Length"] = str(environ["CONTENT_LENGTH"])

    handler = object.__new__(WSGIHandler)
    handler.headers = headers
    handler.rfile = environ["wsgi.input"]
    handler.wfile = io.BytesIO()
    handler.command = str(environ.get("REQUEST_METHOD", "GET")).upper()
    handler.path = str(environ.get("PATH_INFO", "/"))
    query = str(environ.get("QUERY_STRING", ""))
    if query:
        handler.path += f"?{query}"
    handler.client_address = (_wsgi_client_ip(environ), 0)
    handler.request_version = str(environ.get("SERVER_PROTOCOL", "HTTP/1.1"))
    handler._wsgi_status = 500
    handler._wsgi_headers = []

    if handler.command in ("GET", "POST", "PATCH", "DELETE"):
        getattr(handler, f"do_{handler.command}")()
    else:
        handler._send_json(
            405,
            {"error": "Method not allowed."},
            {"Allow": "GET, POST, PATCH, DELETE"},
        )

    status = int(handler._wsgi_status)
    reason = handler._wsgi_reason
    start_response(f"{status} {reason}", handler._wsgi_headers)
    return [handler.wfile.getvalue()]


def _is_loopback_bind(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _validate_runtime_config() -> None:
    if not _is_loopback_bind(HOST):
        if not COOKIE_SECURE:
            raise RuntimeError("Non-loopback binding requires SVTS_SECURE_COOKIES=1.")
        if not ALLOWED_HOSTS_CONFIGURED:
            raise RuntimeError("Non-loopback binding requires an explicit SVTS_ALLOWED_HOSTS allowlist.")
        if not SETUP_KEY:
            with connect() as db:
                has_admin = db.execute(
                    "SELECT 1 FROM users WHERE role='Administrator' LIMIT 1"
                ).fetchone()
            if not has_admin:
                raise RuntimeError("Non-loopback initial setup requires an SVTS_SETUP_KEY.")


def run() -> None:
    initialize()
    _validate_runtime_config()
    server = ThreadingHTTPServer((HOST, PORT), SVTSHandler)
    print(f"SVTS server listening on {HOST}:{PORT}")
    print(f"SQLite database: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping SVTS server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
