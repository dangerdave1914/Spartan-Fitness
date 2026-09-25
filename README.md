partan Coach
Coach-facing day view for Spartan Fitness (Homewood, AL). Same build as the Gauntlet coach app: an Apps Script bridge in front of Google Sheets, a Node app on DigitalOcean, installed to the phone home screen. No app store.

Five tabs:

Today — the day's classes from the schedule. Each class opens to what's being taught: the S&C workout, or the running lesson for that program. No-gi classes warn about any technique in the lesson that needs the gi.
Curriculum — browse every program and lesson. Curriculum admins set which lesson is "now running" per program.
Pay — hours (classes, privates, competition coaching) and sales commissions (merch, memberships, paid-in-full) side by side for the pay period. Approvers see everyone and approve or reject.
Members — each coach's sign-ups with their next anniversary. Flagged 30 days out (a banner on Today too). Coaches log contact; managers record Renewed or Lapsed. Retention report per coach per year.
Stock — retail inventory, one row per size/color. Count, restock, sold, lost/damaged. Low items float to the top, and crossing the reorder point emails NOTIFY_TO.
The three sheets
Upload each .xlsx to the Spartan Google account's Drive and open it as a Google Sheet.

File	Who edits it	What's in it
Spartan Curriculum	Head coach	Programs, Lessons, Blocks. Parsed from the lesson docs. Edit text freely; keep the Program and Key columns intact.
Spartan Conditioning Programming	S&C coaches	Month tabs, week blocks Mon–Sat. Only days marked Confirmed show in the app.
Spartan Staff Ops	Management	Schedule, Staff, Hours, Settings. The app writes Staff, Hours and Settings.
Keep hours in the Ops sheet and out of the curriculum sheet: coaches who write lessons shouldn't need access to pay data.

1. Deploy the bridge
Setup steps are in the header comment of Code.gs. Short version: script.google.com → new project → paste Code.gs → Script Properties: SHARED_SECRET, CURRICULUM_ID, PROGRAMMING_ID, OPS_ID (and optionally NOTIFY_TO) → Deploy as Web app, Execute as: Me, Who has access: Anyone → copy the /exec URL.

Sanity check: open that URL in a browser. It should say spartan bridge ok.

After any edit to Code.gs, redeploy as a new version. Deploy → Manage deployments → pencil → Version: New version → Deploy.

2. Deploy the app
Push this folder to a new GitHub repo, then DigitalOcean → Apps → Create App → pick the repo. It detects Node and runs npm start. Basic plan, no database.

Key	Value
APPS_SCRIPT_URL	the /exec URL from step 1
APPS_SCRIPT_SECRET	must match SHARED_SECRET — mark Encrypt
OPEN_SIGNUP	leave unset. 1 lets any email register
CURRICULUM_ADMINS, APPROVERS	optional extra emails; roles normally live in the Staff tab
PAY_PERIOD	semimonthly (default: 1st–15th, 16th–end) or biweekly
PAY_ANCHOR	biweekly only: any pay-period start date, YYYY-MM-DD
TZ_NAME	defaults to America/Chicago
Staff and roles
Only emails listed on the Staff tab can register. Managers add a row with the email and a Role; the Name fills in when that person first opens the app.

Role	Can
Coach	See everything, claim classes, log and delete their own pending hours
Approver	Also see every coach's hours and approve them
Admin	Also set which lesson each program is running
Admin, Approver	Both
Inventory	Coach, plus can count and restock inventory
Managers (Admin or Approver) can also change inventory, add members and record renewals. Everyone can view stock.

Pre-loaded: sbgalabama@gmail.com (Admin, Approver), kacey@spartanfitnessmma.com (Approver), and four coaches. Add your own email before you test.

Claiming classes: every class on Today has an I coach this class button that adds the coach's name to that class's Coach cell in the Schedule tab (tap again to remove). Several coaches can share a class. Claims are weekly: claiming Tuesday 6 PM BJJ puts you on it every Tuesday until you remove yourself. Managers can also edit the Coach column directly.

Members and retention
The Members tab holds one row per member: name, join date, term in months, plan, and the coach who signed them up. The app works out each member's next anniversary (a second-year member's anniversary is two terms after joining) and flags them renewal_flag_days ahead (Settings, default 30). They stay in that cycle for renewal_grace_days after the date (default 30) so a late renewal still counts.

Only managers record Renewed or Lapsed. The retention bonus pays on renewals, so the coach who earns it doesn't record it. Each renewal is one row in Renewals, keyed to that year's anniversary, so a member renewing three years running counts three times for their coach.

bonus_per_renewal (Settings) is blank on purpose: the amount, and rules like split credit when two coaches share a member or what happens when a coach leaves, are the owner's call. Until it's set the report shows counts only.

Sales commissions
Staff log a sale on the Pay tab: type, what sold (or which member), amount. The commission is worked out from the Commission Rules tab (amount x Rate % + Flat $) and frozen onto the row, so changing a rate later doesn't rewrite past pay. Sales start Pending; an approver checks each one against Zen Planner and approves or rejects it. Rejected sales don't count toward totals.

The three rules shipped are placeholders from a verbal description (10% merch, $65 per membership, 10% paid-in-full). Casey should confirm or correct them before anyone is paid from this. Add a row to create a new sale type.

The Source column says App for hand-logged sales. Once Zen Planner's sales-by-staff report can be exported, it can be imported with Zen Planner as the source, and hand-logging becomes the exception.

Inventory and Zen Planner
Manual for now. Every item has a Zen Planner Name column; fill it with the product's exact name in Zen Planner. When sales data becomes available (partner API through Daxko, or a daily report export), a sync can match sales to rows by that name and record them as Sold entries, the same as the app does by hand. Nothing else changes. Inventory Log keeps every change with who made it.

How the pieces connect
Schedule tab (Ops): one row per class slot. Program says which curriculum the class teaches; several are separated by ; (Spartan Youth shows Kids BJJ and Youth Striking). Conditioning pulls the S&C workout. Gi marks gi or no-gi per class, not per day — Thursday 6 AM BJJ is no-gi while Thursday noon is gi.
Now running (Settings tab, pointer:<Program>): the lesson each program is on. Set from the app by a curriculum admin; it does not advance on its own. For week-based programs the app also shows that week's other lessons (Day 1 / Day 2, or each Youth group's lessons).
Gi tag (Blocks tab, Gi column): filled automatically where a technique mentions collar, lapel, sleeve, belt or pants. It's a keyword guess — correct it in the sheet.
S&C workouts: the app finds the month tab by name, the week block by its Monday date, and the column by weekday. The same workout shows under every S&C class that day.
What managers change where
To change	Where
Who can log in, and their role	Staff tab
Class times, which curriculum a class uses, gi / no-gi, coach	Schedule tab
Commission rates	Commission Rules tab
Renewal flag window, grace window, bonus per renewal	Settings tab
Inventory items and reorder points	Stock tab in the app, or Inventory tab
Lesson text	Curriculum sheet
S&C workouts	Conditioning sheet
Which lesson is running	Curriculum tab in the app (Admins)
Approve hours, sales, renewals	Pay and Members tabs in the app (Approvers)
Sheet edits show in the app within about a minute (curriculum within five). Code changes are the only thing that needs a redeploy.

Troubleshooting
Symptom	Cause
Bridge returned non-JSON	Deployment isn't "Anyone", or Code.gs was edited without redeploying
Bridge: unauthorized	APPS_SCRIPT_SECRET doesn't match SHARED_SECRET
unknown_sheet …	A *_ID script property is missing or wrong
Bridge: no tab named X	A tab was renamed
Workout says "Not confirmed yet"	That day's Status isn't Confirmed
Workout says no week found	The week's Monday date in the sheet doesn't match, or the block is missing
A class shows no curriculum	Its Program cell in Schedule is blank or misspelled
Known gaps
Identity is a typed email, same as Gauntlet. The staff list keeps strangers out, but nothing stops one coach typing another coach's address, and this app logs pay hours. Put Cloudflare Access with Google login in front before real payroll depends on it.
Hours only, no pay rates. Totals are hours by type. Rates per coach and per type aren't modeled yet.
The running lesson doesn't auto-advance. An admin moves it. Auto-advance needs a rule for which weekdays are Day 1 and Day 2.
Boxing/MMA and Muay Thai Day 2 is the second 12-week copy in each source doc. That's an assumption; if the second copy is a revision instead, it should replace Day 1.
Adult BJJ 21–24 (takedown defense, front headlocks, guillotine) have no source docs. Lessons 1–3, 6, 9–14 and 17–20 show Kids BJJ content as stand-ins until adult versions exist.
Foundations Muay Thai isn't attached to any class on the printed schedule.
No Zen Planner sync yet. Inventory and members are entered by hand until API access or a report export is sorted out with Casey.
Reorder points are set by hand. With sales history they could be computed from sell rate × lead time; the Lead Time column is there for that.
