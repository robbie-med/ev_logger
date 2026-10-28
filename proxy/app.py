#!/usr/bin/env python3
"""
duty-hours proxy — tiny CORS proxy in front of www.e-value.net's Duty Hours
logging for the duty-hours PWA. Holds e-value session cookies server-side
(JSON files on disk), keyed by a random session token issued at /login.
Contains no secrets.

Endpoints (JSON; everything except /login and /ping needs X-Session):
  POST /login   {username, password}   -> {ok, session, userID}
  GET  /lookups                        -> {ok, tasks:[{id,name,vacay}], activities:[{id,name,scheduled}]}
  GET  /month?m=YYYY-MM                -> {ok, entries:[{dhid,date,task,activity,time,s,e}]}
  POST /shift   {date:'YYYY-MM-DD', start:'HH:MM', end:'HH:MM', taskID, activityID, vacay?, note?}
                                       -> {ok:true} | {ok:false, reason, violation?}   (add)
  POST /edit    {dhid, date, start, end, taskID, activityID, note?}   -> same          (change an entry)
  POST /delete  {dhid, date}           -> {ok:true} | {ok:false, reason}
  GET  /plan                           -> {ok, plan|null}   (planner blob, per e-value user)
  POST /plan    {...}                  -> {ok:true}
  GET  /amion?m=YYYY-MM[&lo=<code>]   -> {ok, rows:[{name,assignment,date,s,e}]}  (call/shift CSV, everyone)
  GET  /amion/names?m=YYYY-MM[&lo=]   -> {ok, names}   (residents on the block schedule, faculty excluded)
  GET  /amion/me?m=YYYY-MM&name=[&lo=]-> {ok, rotations:[{date,name}], clinic:[{date,am,pm}], shifts:[...]}
                                          (block schedule + clinic sessions + call/shifts for one person)
  GET  /ping                           -> {ok:true}

Egress: e-value's Cloudflare bans datacenter ASNs, so set
EV_SOCKS_PROXY=socks5h://<home-pc-nebula-ip>:1080 to exit through a residential line.
"""

import csv
import json
import os
import random
import re
import secrets
import threading
import time
from calendar import monthrange
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlencode, urlparse

import requests

EV = 'https://www.e-value.net'
PORT = int(os.environ.get('DH_PORT', '8103'))
DATA_DIR = os.environ.get('DH_DATA_DIR', os.path.join(os.path.dirname(__file__), 'data'))
SESSION_TTL = 8 * 60 * 60  # seconds
ALLOWED_ORIGINS = tuple(o.strip() for o in os.environ.get(
    'DH_ORIGINS', 'https://robbie-med.github.io,http://localhost,http://127.0.0.1').split(',') if o.strip())

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) '
      'Gecko/20100101 Firefox/147.0')

# Login only "takes" after the browser's post-login navigation chain.
NAV_CHAIN = [
    '/index.cfm?fuseaction=main_loginscreen&aiInstitutionCode=',
    '/dsp_variables.cfm',
    '/index.cfm?fuseaction=users_login&institutioncode=',
    '/index.cfm?fuseaction=users_sethomepage',
    '/includes/top_menu.cfm',
    '/userAuthRedirect.cfm',
]

# The program's Amion login code lives on the server (env), so it isn't published with the app.
AMION_LO = os.environ.get('AMION_LO', '')
AMION_OCS = 'https://www.amion.com/cgi-bin/ocs?Lo={lo}&'
AMION = AMION_OCS + 'Rpt=619&Month={m}&Year={y}'  # read-only call/shift CSV export

DH_PAGE = EV + '/index.cfm?fuseaction=users_dutyhours_logging&menu=42&accessid=843'
DH_REFERER = EV + '/index.cfm?fuseaction=users_dutyhours'
XHR = EV + '/users/dutyhours/xhr/'

# One piece of a logged entry in the xhr_reloadCalendar HTML (whitespace collapsed):
#   editEntry(<dhid>,'M/D/YYYY',...) ...> <task> </a></span> [<div ...><activity></div>] </div> <div ...> <time>
# <time> is "7:30am-5:00pm", or for entries past midnight "7:00pm-..." on the start day and
# "...-7:00am" in the next day's cell (same dhid and date). No activity = no activity div.
ENTRY_RE = re.compile(
    r"editEntry\((\d+),'(\d{1,2})/(\d{1,2})/(\d{4})'[^>]*>\s*([^<]+?)\s*</a>\s*</span>\s*"
    r"(?:<div[^>]*>\s*([^<]*?)\s*</div>\s*)?</div>\s*<div[^>]*>\s*([^<]+?)\s*(?:</font>|<br)")

os.makedirs(DATA_DIR, exist_ok=True)
_file_lock = threading.Lock()


def nocache():
    # Must stay a small int like the real client sends — ColdFusion 520s on
    # values that overflow a 32-bit int (e.g. epoch milliseconds).
    return random.randint(100_000_000, 999_999_999)


def cf_ts(dt):
    return "{ts '" + dt.strftime('%Y-%m-%d %H:%M:00') + "'}"


def to_24h(t):
    """'7:30am' -> '07:30'"""
    m = re.fullmatch(r'(\d{1,2}):(\d{2})\s*([ap])m', t.strip().lower())
    if not m:
        return None
    h = int(m.group(1)) % 12 + (12 if m.group(3) == 'p' else 0)
    return f'{h:02d}:{m.group(2)}'


def strip_tags(html):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', html or '')).strip()


def looks_logged_out(html):
    # The genuine login screen has the credential form; the post-login
    # frameset references "main_loginscreen" too, so don't key on that.
    return 'AIpassword' in html or 'name="AIusername"' in html


def parse_entries(html):
    """dhid -> entry, merging the pieces of entries that run past midnight. Unknown ends stay None."""
    out = {}
    for dhid, mo, d, y, task, act, span in ENTRY_RE.findall(re.sub(r'\s+', ' ', html)):
        a, _, b = span.partition('-')
        e = out.setdefault(dhid, {'dhid': dhid, 'date': f'{y}-{int(mo):02d}-{int(d):02d}',
                                  'task': task, 'activity': act or '', 's': None, 'e': None})
        if a.strip() != '...':
            e['s'] = to_24h(a)
        if b.strip() != '...':
            e['e'] = to_24h(b)
    return out


def amion_get(url):
    proxy = os.environ.get('EV_SOCKS_PROXY')
    resp = requests.get(url, timeout=30, headers={'User-Agent': UA},
                        proxies={'http': proxy, 'https': proxy} if proxy else None)
    return resp.content.decode('latin-1')


def amion_month(lo, year, month):
    """Amion Rpt=619 rows: "NAME",id,bk,"ASSIGNMENT",id,bk,M-D-YY,HHMM,HHMM (local time)."""
    rows = []
    for r in csv.reader(amion_get(AMION.format(lo=lo, m=month, y=year)).splitlines()):
        if (len(r) < 9 or not re.fullmatch(r'\d{1,2}-\d{1,2}-\d{2}', r[6])
                or not re.fullmatch(r'\d{4}', r[7]) or not re.fullmatch(r'\d{4}', r[8])):
            continue
        mo, d, yy = map(int, r[6].split('-'))
        rows.append({'name': r[0].strip(), 'assignment': r[3].strip(),
                     'date': f'{2000 + yy}-{mo:02d}-{d:02d}', 's': f'{r[7][:2]}:{r[7][2:]}', 'e': f'{r[8][:2]}:{r[8][2:]}'})
    return rows


class AmionGrid(HTMLParser):
    """Amion's HTML schedule grids as rows of cells; each cell is its <br>-separated lines.
    Note markers (<a> icons, tiny <font> footnote numbers) are dropped."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.rows, self.skip = [], [], 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'tr':
            self.stack.append([])
        elif tag in ('td', 'th') and self.stack:
            self.stack[-1].append([''])
        elif tag == 'br' and self.stack and self.stack[-1]:
            self.stack[-1][-1].append('')
        elif tag == 'a' or (tag == 'font' and '8px' in (a.get('style') or '')):
            self.skip += 1

    def handle_endtag(self, tag):
        if tag == 'tr' and self.stack:
            self.rows.append([[ln.strip() for ln in cell] for cell in self.stack.pop()])
        elif tag in ('a', 'font') and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if self.stack and self.stack[-1] and not self.skip:
            self.stack[-1][-1][-1] += data


def amion_person(html, name, year, month):
    """[(YYYY-MM-DD, [lines])] for one person's row in a day-per-column Amion grid, this month only."""
    p = AmionGrid()
    p.feed(html)
    day_re = re.compile(r'(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(\d{1,2})-(\d{1,2})')
    header = next((r for r in p.rows if sum(bool(day_re.fullmatch(''.join(c))) for c in r) > 5), None)
    me = re.compile(re.escape(name.upper()) + r'(?![A-Z])')
    row = next((r for r in p.rows if r and r[0] and me.match(' '.join(r[0]).replace(' ', ' ').upper())), None)
    if not header or not row:
        return []
    out = []
    for head, cell in zip(header[1:], row[1:]):
        m = day_re.fullmatch(''.join(head))
        if m and int(m.group(1)) == month:
            out.append((f'{year}-{month:02d}-{int(m.group(2)):02d}', cell))
    return out


def amion_block(lo, year, month, skill=-1):
    """Block-schedule HTML for one month. Skill -1 = all staff, 1 = faculty."""
    syr = year if month >= 7 else year - 1  # academic year starts July 1 (Blks day 1)
    first = (date(year, month, 1) - date(syr, 7, 1)).days + 1
    blks = f'{first}-{first + monthrange(year, month)[1] - 1}'
    return amion_get(AMION_OCS.format(lo=lo) + f'Page=Block&Skill={skill}&Syr={syr}&Blks={blks}&Fsiz=0')


def amion_roster(lo, year, month):
    """Everyone with a block-schedule row ("NAME INITIALS"), minus faculty."""
    def names(html):
        p = AmionGrid()
        p.feed(html)
        return {' '.join(r[0]).rsplit(' ', 1)[0].replace(' ', ' ').strip() for r in p.rows
                if len(r) > 20 and r[0] and ' ' in ' '.join(r[0])}
    return sorted(names(amion_block(lo, year, month)) - names(amion_block(lo, year, month, 1)))


def same_name(a, b):
    """'JOHNSON, K' == 'Johnson,K' — Amion spells names slightly differently between views."""
    return re.sub(r'[^A-Z0-9]', '', a.upper()) == re.sub(r'[^A-Z0-9]', '', b.upper())


def amion_me(lo, name, year, month):
    """One person's month from Amion: block rotation per day, AM/PM clinic sessions, call/shifts."""
    block = amion_person(amion_block(lo, year, month), name, year, month)
    clinic = amion_person(amion_get(AMION_OCS.format(lo=lo) + f'Page=Clinic&Skill=-1&Mo={month}-{year % 100:02d}&Fsiz=0'),
                          name, year, month)
    return {
        'rotations': [{'date': d, 'name': lines[0]} for d, lines in block if lines and lines[0]],
        'clinic': [{'date': d, 'am': lines[0], 'pm': lines[1] if len(lines) > 1 else ''}
                   for d, lines in clinic if any(lines)],
        'shifts': [r for r in amion_month(lo, year, month) if same_name(r['name'], name)],
    }


# ---------------------------------------------------------------- JSON file store

def _safe_path(prefix, key, pattern):
    if not re.fullmatch(pattern, key or ''):
        return None
    return os.path.join(DATA_DIR, f'{prefix}_{key}.json')


def read_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def write_json(path, data):
    with _file_lock:
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, path)


def load_session(token):
    path = _safe_path('sess', token, r'[a-f0-9]{64}')
    sess = read_json(path) if path else None
    if sess and time.time() - sess.get('createdAt', 0) > SESSION_TTL:
        os.remove(path)
        return None
    return sess


# ---------------------------------------------------------------- e-value client

class SessionExpired(Exception):
    pass


class EgressBlocked(Exception):
    pass


class EvClient:
    """One e-value session: cookie jar + the duty-hours request flow."""

    def __init__(self):
        self.http = requests.Session()
        self.http.headers.update({'User-Agent': UA})
        proxy = os.environ.get('EV_SOCKS_PROXY')
        if proxy:
            self.http.proxies = {'http': proxy, 'https': proxy}
        self.cs_token = None
        self.user_id = None
        self.subunit_id = None

    def _request(self, method, url, data=None, xhr=False, retries=3):
        headers = {'X-Requested-With': 'XMLHttpRequest', 'Referer': DH_REFERER} if xhr else {}
        last = None
        for attempt in range(retries):
            try:
                resp = self.http.request(method, url, data=data, headers=headers,
                                         timeout=60, allow_redirects=True)
                if resp.status_code == 403 and 'error code: 1005' in resp.text:
                    raise EgressBlocked('e-value.net has ASN-banned this egress IP '
                                        '(Cloudflare error 1005) — check the home-exit proxy')
                # The origin intermittently 520s; retrying is the fix.
                if resp.status_code != 520:
                    if xhr and looks_logged_out(resp.text):
                        raise SessionExpired()
                    return resp
                last = resp
            except requests.RequestException as exc:
                last = exc
            time.sleep(1.5 * (attempt + 1))
        if isinstance(last, Exception):
            raise last
        return last

    def get(self, url, xhr=False):
        return self._request('GET', url, xhr=xhr)

    def post(self, url, data, xhr=False):
        return self._request('POST', url, data=data, xhr=xhr)

    def set_js_cookies(self):
        """The browser sets these via JS after login; the server reads some of them."""
        jar = {c.name: c.value for c in self.http.cookies}
        for name, value in [
            ('EVALUECFID', jar.get('CFID', '')), ('EVALUECFTOKEN', jar.get('CFTOKEN', '')),
            ('EVALUEUSERID', self.user_id or ''), ('EVUSERID', self.user_id or ''),
            ('EVSUBUNITID', self.subunit_id or ''), ('EVSUPERUSER', '0'),
            ('CFSUID', f'{self.subunit_id}|na'), ('laccess', '0'), ('lmenu', '0'),
            ('ENVIRONMENT', 'EVALUEPRODUCTION'), ('TIMEOUT', '20'), ('MODALTIMEOUT', '180000'),
        ]:
            self.http.cookies.set(name, value, domain='www.e-value.net', path='/')

    def login(self, username, password):
        self.get(EV + '/index.cfm')
        resp = self.post(EV + '/index.cfm', {
            'isLoggingIn': 'yes', 'ppc': '0', 'AIusername': username,
            'AIpassword': password, 'AIInstitutionCode': '',
        })
        if looks_logged_out(resp.text):
            return False
        for path in NAV_CHAIN:
            self.get(EV + path)
        self.refresh_page()
        return bool(self.cs_token and self.user_id)

    def refresh_page(self):
        """Load the Duty Hours page: fresh csToken + user/subunit IDs. Returns its HTML."""
        html = self.get(DH_PAGE).text
        if looks_logged_out(html):
            raise SessionExpired()
        tok = re.search(r'name="csToken" value="([^"]+)"', html)
        ids = re.search(r"User_ID: ' \+ (\d+) \+ ', Subunit_ID: ' \+ (\d+)", html)
        if tok:
            self.cs_token = tok.group(1)
        if ids:
            self.user_id, self.subunit_id = ids.groups()
        self.set_js_cookies()
        return html

    def add_form(self, task_id='21295', vacay=False, activity_id='-1',
                 start=None, end=None, note=''):
        """The Duty Hours add form, field for field as the page posts it."""
        start = start or datetime.now().replace(hour=7, minute=0, second=0, microsecond=0)
        end = end or start + timedelta(hours=10)
        return {
            'csToken': self.cs_token, 'userID': self.user_id,
            'taskSelect': str(task_id), 'vacayFlag': '1' if vacay else '0',
            'supervisorSelect': '0', 'activitySelect': str(activity_id),
            'startTimeIn': cf_ts(start), 'endTimeIn': cf_ts(end), 'dhNote': note,
        }

    def lookups(self):
        html = self.refresh_page()
        sel = re.search(r'<select[^>]*id="taskSelect"[\s\S]*?</select>', html)
        vac = re.search(r"vacayList = '([\d,]*)'", html)
        vacay = set((vac.group(1) if vac else '').split(','))
        tasks = [{'id': tid, 'name': name.strip(), 'vacay': tid in vacay}
                 for tid, name in re.findall(r'<option[^>]*value="?(\d+)"?[^>]*>([^<]+)', sel.group(0) if sel else '')]

        def activities(scheduled):
            q = {'nocache': nocache(), 'subunitid': self.subunit_id, 'activityid': 0,
                 'asfilter': 'sitefilter', 'siteid': 0, 'schedActs': 'true' if scheduled else 'false',
                 **self.add_form()}
            if scheduled:
                q['schedActsOnly'] = 'on'
            resp = self.get(XHR + 'xhr_getActivities.cfm?' + urlencode(q, quote_via=quote), xhr=True)
            try:
                rows = json.loads(resp.text.strip())['rows']
            except (ValueError, KeyError):
                return []
            return [(str(r['tmplstid']), r['tmplstname']) for r in rows if r['tmplstid'] != -1]

        mine = {aid for aid, _ in activities(True)}
        acts = [{'id': aid, 'name': name, 'scheduled': aid in mine} for aid, name in activities(False)]
        return tasks, acts

    def _calendar(self, year, month):
        d = f'{month:02d}/01/{year}'
        url = (f'{XHR}xhr_reloadCalendar.cfm?&inactiveid=1&lastdate={d}&CurrentDate={d}'
               f'&userID={self.user_id}&mode=user&legendTaskType=&nocache={nocache()}')
        return parse_entries(self.post(url, self.add_form(), xhr=True).text)

    def month(self, year, month):
        """Entries that start in this month, with end times resolved across midnight."""
        prefix = f'{year}-{month:02d}'
        mine = [e for e in self._calendar(year, month).values() if e['date'].startswith(prefix) and e['s']]
        if any(e['e'] is None for e in mine):  # tail may sit in next month's first cell
            nxt = self._calendar(year + month // 12, month % 12 + 1)
            for e in mine:
                if e['e'] is None and e['dhid'] in nxt:
                    e['e'] = nxt[e['dhid']]['e']
        for e in mine:
            e['e'] = e['e'] or '00:00'  # "7:00pm-..." with no tail = ran to midnight exactly
            e['time'] = f"{e['s']}-{e['e']}"
        return sorted(mine, key=lambda e: (e['date'], e['s']))

    def _commit(self, caller, day, form):
        """Violation check, then save — the page's two-step for both add and edit.
        Returns (ok, reason, violation)."""
        chk = self.post(f'{XHR}xhr_checkShiftViolations.cfm?caller={caller}&userID={self.user_id}'
                        f'&dhid=0&d={day}&nocache={nocache()}', form, xhr=True)
        # "10/1/2026|add|0|0|<br><br>" — third field is the violation flag. A violation needs
        # answers/a reason in e-value's own dialog, so it's handed back, never auto-saved.
        parts = chk.text.split('|')
        if len(parts) < 4 or parts[2].strip() != '0':
            msg = strip_tags(parts[4] if len(parts) > 4 else chk.text)[:500]
            return False, msg or 'e-value flagged a duty-hour violation', True
        resp = self.post(f'{XHR}xhr_saveDutyHours.cfm?saveday={day}&nocache={nocache()}&inactiveId=1',
                         form, xhr=True)
        # Success: "{ts '2026-10-01 07:30:01'} 0-1|10/01/2026|..."
        if resp.status_code != 200 or not resp.text.lstrip().startswith("{ts '"):
            return False, strip_tags(resp.text)[:300] or f'HTTP {resp.status_code}', False
        return True, None, False

    @staticmethod
    def _span(s):
        y, mo, d = map(int, s['date'].split('-'))
        sh, sm = map(int, s['start'].split(':'))
        eh, em = map(int, s['end'].split(':'))
        start, end = datetime(y, mo, d, sh, sm), datetime(y, mo, d, eh, em)
        if end <= start:
            end += timedelta(days=1)  # overnight, or 00:00-00:00 = 24 h
        return y, mo, d, start, end

    def add(self, s):
        self.refresh_page()  # fresh csToken per write
        y, mo, d, start, end = self._span(s)
        form = self.add_form(s['taskID'], s.get('vacay'), s['activityID'], start, end, s.get('note', ''))
        return self._commit('add', f'{mo}/{d}/{y}', form)

    def edit(self, s):
        y, mo, d, start, end = self._span(s)
        day = f'{mo:02d}/{d:02d}/{y}'
        # Open the entry like the page does; a leading "1" means a supervisor verified it (locked).
        opened = self.post(f'{XHR}xhr_editDutyHours.cfm?dhid={s["dhid"]}&editday={mo}/{d}/{y}'
                           f'&currentDate={day}&edit=true&mode=User&nocache={nocache()}', {}, xhr=True)
        if opened.text.lstrip().startswith('1'):
            return False, 'verified by a supervisor — e-value no longer allows edits', False
        tok = re.search(r'name="csToken" value="([^"]+)"', opened.text)
        if tok:
            self.cs_token = tok.group(1)
        form = {
            'DHTrack_ID': s['dhid'], 'UpdateDay': day, 'currentDate': day,
            'csToken': self.cs_token, 'userID': self.user_id,
            'taskSelectEdit': str(s['taskID']), 'activitySelectEdit': str(s['activityID']),
            'supervisorSelectEdit': '0', 'dhNoteEdit': s.get('note', ''),
            'startTimeInEdit': cf_ts(start), 'endTimeInEdit': cf_ts(end), 'removeUpdate': '0',
        }
        return self._commit('edit', day, form)

    def delete(self, dhid, date):
        self.refresh_page()
        y, mo, d = map(int, date.split('-'))
        resp = self.post(f'{XHR}xhr_deleteDutyHours.cfm?dhid={dhid}&deleteday={mo}/{d}/{y}'
                         f'&mode=User&nocache={nocache()}', self.add_form(), xhr=True)
        # "bogus|c|l|u|m|ltt|cannotDelete"
        parts = resp.text.split('|')
        if len(parts) > 6 and parts[6].strip() == '1':
            return False, 'verified by a supervisor — e-value no longer allows deleting it'
        if resp.status_code != 200:
            return False, f'HTTP {resp.status_code}'
        return True, None

    def dump_cookies(self):
        return [{'name': c.name, 'value': c.value, 'domain': c.domain, 'path': c.path}
                for c in self.http.cookies]

    def load_cookies(self, cookies):
        for c in cookies:
            self.http.cookies.set(c['name'], c['value'], domain=c['domain'], path=c['path'])


# ---------------------------------------------------------------- HTTP API

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'duty-hours-proxy'

    def log_message(self, fmt, *args):  # keep logs free of URLs that may carry tokens
        pass

    def _cors_origin(self):
        origin = self.headers.get('Origin', '')
        for allowed in ALLOWED_ORIGINS:
            if origin == allowed or origin.startswith(allowed + ':'):
                return origin
        return None

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        origin = self._cors_origin()
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            data = json.loads(self.rfile.read(length) or b'{}')
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def _token(self):
        return self.headers.get('X-Session', '')

    def _client(self):
        """Rebuild an EvClient from the session token; raises SessionExpired."""
        sess = load_session(self._token())
        if not sess:
            raise SessionExpired()
        client = EvClient()
        client.load_cookies(sess['cookies'])
        client.cs_token = sess.get('csToken')
        client.user_id = sess.get('userID')
        client.subunit_id = sess.get('subunitID')
        client.set_js_cookies()
        return client, sess

    def _persist(self, client, sess, token=None):
        sess.update({'cookies': client.dump_cookies(), 'csToken': client.cs_token,
                     'userID': client.user_id, 'subunitID': client.subunit_id})
        write_json(_safe_path('sess', token or self._token(), r'[a-f0-9]{64}'), sess)

    def _plan_path(self):
        sess = load_session(self._token())
        path = _safe_path('plan', str((sess or {}).get('userID') or ''), r'\d+')
        if not path:
            raise SessionExpired()
        return path

    # -- routing --

    def do_OPTIONS(self):
        origin = self._cors_origin()
        self.send_response(204)
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Session')
            self.send_header('Access-Control-Max-Age', '86400')
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _route(self, routes):
        path = urlparse(self.path).path
        try:
            handler = routes.get(path)
            if handler:
                handler()
            else:
                self._send_json({'ok': False, 'reason': 'not found'}, 404)
        except SessionExpired:
            self._send_json({'ok': False, 'reason': 'SESSION_EXPIRED'}, 401)
        except EgressBlocked as exc:
            self._send_json({'ok': False, 'reason': f'EGRESS_BLOCKED: {exc}'}, 502)
        except requests.RequestException as exc:
            self._send_json({'ok': False, 'reason': f'e-value unreachable: {exc}'}, 502)
        except Exception as exc:
            self._send_json({'ok': False, 'reason': f'proxy error: {exc}'}, 500)

    def do_GET(self):
        self._route({'/ping': lambda: self._send_json({'ok': True, 'service': 'duty-hours-proxy'}),
                     '/lookups': self._lookups, '/month': self._month, '/plan': self._plan_get,
                     '/amion': self._amion, '/amion/me': self._amion_me, '/amion/names': self._amion_names})

    def do_POST(self):
        self._route({'/login': self._login, '/shift': lambda: self._write('add'),
                     '/edit': lambda: self._write('edit'), '/delete': self._delete, '/plan': self._plan_put})

    # -- handlers --

    def _login(self):
        body = self._body()
        if not body.get('username') or not body.get('password'):
            self._send_json({'ok': False, 'reason': 'missing credentials'}, 400)
            return
        client = EvClient()
        if not client.login(body['username'], body['password']):
            self._send_json({'ok': False, 'reason': 'INVALID_CREDENTIALS'}, 401)
            return
        token = secrets.token_hex(32)
        self._persist(client, {'createdAt': time.time()}, token)
        self._send_json({'ok': True, 'session': token, 'userID': client.user_id})

    def _lookups(self):
        client, sess = self._client()
        tasks, acts = client.lookups()
        self._persist(client, sess)
        self._send_json({'ok': True, 'tasks': tasks, 'activities': acts})

    def _month(self):
        m = parse_qs(urlparse(self.path).query).get('m', [''])[0]
        if not re.fullmatch(r'\d{4}-\d{2}', m):
            self._send_json({'ok': False, 'reason': 'm must be YYYY-MM'}, 400)
            return
        client, sess = self._client()
        entries = client.month(int(m[:4]), int(m[5:]))
        self._persist(client, sess)
        self._send_json({'ok': True, 'entries': entries})

    def _amion(self):
        q = parse_qs(urlparse(self.path).query)
        m, lo = q.get('m', [''])[0], q.get('lo', [''])[0] or AMION_LO
        if not re.fullmatch(r'\d{4}-\d{2}', m) or not re.fullmatch(r'\w{1,40}', lo):
            self._send_json({'ok': False, 'reason': 'need m=YYYY-MM and an Amion code (AMION_LO on the server)'}, 400)
            return
        self._send_json({'ok': True, 'rows': amion_month(lo, int(m[:4]), int(m[5:]))})

    def _amion_names(self):
        q = parse_qs(urlparse(self.path).query)
        m, lo = q.get('m', [''])[0], q.get('lo', [''])[0] or AMION_LO
        if not re.fullmatch(r'\d{4}-\d{2}', m) or not re.fullmatch(r'\w{1,40}', lo):
            self._send_json({'ok': False, 'reason': 'need m=YYYY-MM and an Amion code (AMION_LO on the server)'}, 400)
            return
        self._send_json({'ok': True, 'names': amion_roster(lo, int(m[:4]), int(m[5:]))})

    def _amion_me(self):
        q = parse_qs(urlparse(self.path).query)
        m, lo, name = (q.get(k, [''])[0] for k in ('m', 'lo', 'name'))
        lo = lo or AMION_LO
        if not re.fullmatch(r'\d{4}-\d{2}', m) or not re.fullmatch(r'\w{1,40}', lo) or not name.strip():
            self._send_json({'ok': False, 'reason': 'need m=YYYY-MM, name, and an Amion code (AMION_LO on the server)'}, 400)
            return
        self._send_json({'ok': True, **amion_me(lo, name.strip(), int(m[:4]), int(m[5:]))})

    def _bad(self, s, fields):
        bad = [k for k, rx in fields if not re.fullmatch(rx, str(s.get(k, '')))]
        if bad:
            self._send_json({'ok': False, 'reason': f"bad fields: {', '.join(bad)}"}, 400)
        return bad

    def _write(self, kind):
        s = self._body()
        fields = [('date', r'\d{4}-\d{2}-\d{2}'), ('start', r'\d{2}:\d{2}'), ('end', r'\d{2}:\d{2}'),
                  ('taskID', r'\d+'), ('activityID', r'-?\d+')] + ([('dhid', r'\d+')] if kind == 'edit' else [])
        if self._bad(s, fields):
            return
        client, sess = self._client()
        ok, reason, violation = client.add(s) if kind == 'add' else client.edit(s)
        self._persist(client, sess)
        self._send_json({'ok': ok, **({'reason': reason, 'violation': violation} if not ok else {})},
                        200 if ok else 409 if violation else 502)

    def _delete(self):
        s = self._body()
        if self._bad(s, [('dhid', r'\d+'), ('date', r'\d{4}-\d{2}-\d{2}')]):
            return
        client, sess = self._client()
        ok, reason = client.delete(s['dhid'], s['date'])
        self._persist(client, sess)
        self._send_json({'ok': ok, **({'reason': reason} if not ok else {})}, 200 if ok else 409)

    def _plan_get(self):
        self._send_json({'ok': True, 'plan': read_json(self._plan_path())})

    def _plan_put(self):
        path = self._plan_path()
        if int(self.headers.get('Content-Length') or 0) > 512_000:
            self._send_json({'ok': False, 'reason': 'plan too large'}, 413)
            return
        plan = self._body()
        if not isinstance(plan.get('plan'), dict) or not isinstance(plan.get('presets'), list):
            self._send_json({'ok': False, 'reason': 'bad plan'}, 400)
            return
        write_json(path, plan)
        self._send_json({'ok': True})


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'duty-hours-proxy listening on 127.0.0.1:{PORT}')
    server.serve_forever()
