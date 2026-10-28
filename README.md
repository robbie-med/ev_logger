# ev_logger — Duty Hours

Installable PWA (phone + desktop) for e-value.net duty-hours logging. Plan the
month once, then send the worked shifts in one tap each week.

**App:** https://robbie-med.github.io/ev_logger/ (GitHub Pages, repo root)
**Proxy:** https://dh-api.robbiemed.org (Hetzner VPS, `proxy/app.py`)

## Using it

1. **Settings:** enter your e-value login and your name as Amion spells it, then tap *Log in*.
2. **Pre-fill from Amion** builds the month from three Amion views:
   - **Block** schedule → your rotation each day (OPHTH, CARDIO…), shown as a colored tag on the calendar.
   - **Clinic** schedule → AM/PM sessions (CL, CLP, AA, WI1…) placed in the half-day windows.
   - **Call/shift** export (Rpt=619) → exact hours for calls, phones, group clinics.
   Weekdays on a rotation get a base day (the *Rotation day* type). Clinic and call blocks replace
   that window. Days you set by hand are never overwritten.
3. **Amion → e-value** maps each Amion name/code to an e-value activity and task once
   (CARDIO → CARDI, CL → Family Practice Longitudinal, AA → Academic Afternoon 12–5,
   NC / SAT. CALL / SUN. CALL → NC, PHONES → Non Duty Hours…). Any name can be set to Ignore. Changes re-apply to the month.
4. **Every week:** recurring blocks. Thursday 12–5 Academic Afternoon is preset, and it replaces that
   window on any day you're working.
5. **Every hour is logged.** Time not worked is sent as *Non Duty Hours* and split at midnight,
   including the tail of an overnight shift. Tap a day (✎) to see exactly what it will send, or change its blocks.
6. Each week tap **Send N finished days**. Only finished days are sent (vacation/sick/leave can go
   early, as e-value allows). Days that already have entries in e-value are skipped, never doubled.
7. **Days already in e-value** show ✓. Tap one to edit or delete its entries, or add a missing block.
   If e-value flags a duty-hour violation, that day has to be finished on e-value, because e-value
   wants your answers/reason there.

Install: phone → Share / ⋮ → *Add to Home Screen*; desktop Chrome/Edge → install icon in the address bar.

## Architecture

```
PWA (GitHub Pages) ──► VPS nginx ──► proxy/app.py :8103 ──SOCKS5 over Nebula──► home PC ──► www.e-value.net
                                              └──► www.amion.com (Block + Clinic pages, Rpt=619 CSV)
```

e-value's Cloudflare bans datacenter IPs, so e-value traffic exits through the same
home-PC SOCKS proxy that ev-quicklog uses (`EV_SOCKS_PROXY`).

- `index.html`, `app.js`, `style.css`, `sw.js`: the PWA (vanilla JS, no build).
- `proxy/app.py`: e-value login and session, Duty Hours endpoints, Amion reader, plan sync.
  Needs `requests` (+ `pysocks` when `EV_SOCKS_PROXY` is set).
- Plan sync: the planner is stored per e-value user ID in `proxy/data/plan_<id>.json`,
  so phone and desktop see the same month.

## e-value Duty Hours API (from HAR, Oct 2026)

- Page `index.cfm?fuseaction=users_dutyhours_logging&menu=42&accessid=843` has the csToken
  (`name="csToken" value=...`), the IDs (`User_ID: ' + N + ', Subunit_ID: ' + N`), and the task `<select>`.
- Tasks: Planned Work Hours 21295, Non Duty Hours 21296, Vacation 21297, Sick Day 21298,
  Leave of Absence 21299, Called In From Home 21300. `vacayFlag=1` for 21297–21299.
  The "can't log the future" rule is enforced only in the page's JS, and only for non-vacation tasks.
- Add = POST `xhr/xhr_checkShiftViolations.cfm?caller=add&userID=&dhid=0&d=M/D/YYYY`, then
  POST `xhr/xhr_saveDutyHours.cfm?saveday=M/D/YYYY&inactiveId=1`, both with form
  `csToken,userID,taskSelect,vacayFlag,supervisorSelect=0,activitySelect,startTimeIn,endTimeIn,dhNote`
  (times are `{ts 'YYYY-MM-DD HH:MM:00'}`). The check returns `date|add|<flag>|<dhid>|<html>` (flag 0 = clean).
  The save returns `{ts '...'} ...` on success.
- Edit = POST `xhr/xhr_editDutyHours.cfm?dhid=&editday=M/D/YYYY&currentDate=MM/DD/YYYY&edit=true&mode=User`
  (response starts with `1|` when a supervisor has verified the entry, which locks it), then the same check + save
  with `caller=edit` and form `DHTrack_ID,UpdateDay,currentDate,csToken,userID,taskSelectEdit,activitySelectEdit,
  supervisorSelectEdit,dhNoteEdit,startTimeInEdit,endTimeInEdit,removeUpdate=0`.
- Delete = POST `xhr/xhr_deleteDutyHours.cfm?dhid=&deleteday=M/D/YYYY&mode=User` with the add form; the reply is
  `bogus|c|l|u|m|ltt|cannotDelete` (1 = verified, locked).
- Non Duty Hours / Vacation / Sick / Leave don't need an activity (`activitySelect=-1`).
- Read back = POST `xhr/xhr_reloadCalendar.cfm?lastdate=MM/01/YYYY&CurrentDate=...&userID=&mode=user`;
  entries are `editEntry(<dhid>,'M/D/YYYY',...)` blocks. The activity div is missing when there is none.
  An entry past midnight shows `7:00pm-...` on its day and `...-7:00am` in the next day's cell (same dhid).
  With no tail it ended at exactly midnight. Tested Oct 28 2026: add, edit to overnight, delete.
- Activities = GET `xhr/xhr_getActivities.cfm` (JSON `rows[{tmplstid,tmplstname}]`); `schedActs=true`
  limits it to your scheduled rotations.

## Amion (read-only, no login)

- Block: `ocs?Lo=<code>&Page=Block&Skill=-1&Syr=<academic year>&Blks=<from>-<to>&Fsiz=0`. Blks are day
  numbers counted from July 1 = 1. One cell per day, with the rotation name.
- Clinic: `ocs?Lo=<code>&Page=Clinic&Skill=-1&Mo=<M>-<YY>&Fsiz=0`. Each cell is `AM<br>PM` codes; note icons/footnotes are dropped.
- Roster (name dropdown): block page rows "NAME&nbsp;INITIALS" with Skill=-1, minus Skill=1 (faculty).
- Call/shift CSV: `ocs?Lo=<code>&Rpt=619&Month=<M>&Year=<YYYY>` → `NAME,id,bk,ASSIGNMENT,id,bk,M-D-YY,HHMM,HHMM`.
- A person's row is matched on the leading name in the first cell (`SMITH SM` → SMITH).

## Deploy

```bash
# VPS, once
sudo mkdir -p /opt/dh-proxy && sudo chown robbie:robbie /opt/dh-proxy
python3 -m venv /opt/dh-proxy/venv && /opt/dh-proxy/venv/bin/pip install requests pysocks
scp -i ~/.ssh/tododuk_hetzner proxy/app.py robbie@157.180.87.209:/opt/dh-proxy/app.py
# install proxy/dh-proxy.service (set EV_SOCKS_PROXY and AMION_LO) and proxy/dh-api.nginx.conf,
# add DNS A record dh-api → 157.180.87.209 (grey cloud), then:
sudo certbot --nginx -d dh-api.robbiemed.org
sudo systemctl enable --now dh-proxy
```

PWA deploy = push to `main` with Pages serving the repo root.

## Local development

```bash
python proxy/app.py                          # 127.0.0.1:8103 (this PC's home egress works)
python -m http.server 8000 --bind 127.0.0.1  # http://localhost:8000
```

In Settings, set Proxy URL to `http://localhost:8103`.

## Security

- Credentials live only in the browser's localStorage and are sent to the proxy at login.
- `proxy/data/` holds live e-value session cookies (8 h TTL) and is gitignored.
  HTTP request logging is disabled in the proxy.
- `*.har` captures contain credentials and cookies; never commit them.
